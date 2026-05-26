-- =====================================================================
-- REGRAS DE NEGÓCIO DO CASHBACK — CONFIGURAÇÃO NO BANCO
-- Tabelas paramétricas para que regras sejam alteradas sem mexer no código
-- =====================================================================

SET search_path TO crm, public;

-- =====================================================================
-- 1. TABELA DE TIERS (configuração)
-- =====================================================================
CREATE TABLE cashback_tiers (
    id                          SERIAL PRIMARY KEY,
    nome                        VARCHAR(15) UNIQUE NOT NULL,
    ordem                       INT NOT NULL,
    valor_minimo_12m            DECIMAL(10,2) NOT NULL,     -- gasto mínimo nos últimos 12 meses
    percentual_cashback         DECIMAL(5,2) NOT NULL,      -- ex: 3.00 = 3%
    validade_cashback_dias      INT NOT NULL,               -- prazo até expirar
    frete_gratis_acima_de       DECIMAL(10,2),              -- NULL = não tem benefício
    frete_gratis_sempre         BOOLEAN DEFAULT FALSE,
    brinde_aniversario          BOOLEAN DEFAULT FALSE,
    acesso_antecipado_colecao   BOOLEAN DEFAULT FALSE,
    atendimento_vip             BOOLEAN DEFAULT FALSE,
    cor_hex                     VARCHAR(7),
    descricao                   VARCHAR(255),
    ativo                       BOOLEAN DEFAULT TRUE
);

INSERT INTO cashback_tiers
(nome, ordem, valor_minimo_12m, percentual_cashback, validade_cashback_dias,
 frete_gratis_acima_de, frete_gratis_sempre, brinde_aniversario,
 acesso_antecipado_colecao, atendimento_vip, cor_hex, descricao) VALUES
('Bronze',   1,     0.00, 3.00,  60,  NULL,  FALSE, FALSE, FALSE, FALSE, '#CD7F32', 'Tier inicial. Toda cliente começa aqui.'),
('Prata',    2,  1500.00, 5.00,  90, 199.00, FALSE, TRUE,  FALSE, FALSE, '#C0C0C0', 'Cliente recorrente. Frete grátis acima de R$ 199.'),
('Ouro',     3,  4000.00, 7.00, 120,   NULL, TRUE,  TRUE,  FALSE, FALSE, '#FFD700', 'Cliente VIP. Frete grátis sempre + brinde de aniversário.'),
('Diamante', 4, 10000.00,10.00, 180,   NULL, TRUE,  TRUE,  TRUE,  TRUE,  '#B9F2FF', 'Top da casa. Atendimento exclusivo + acesso antecipado.');

-- =====================================================================
-- 2. PARÂMETROS GLOBAIS DO PROGRAMA
-- =====================================================================
CREATE TABLE cashback_parametros (
    chave           VARCHAR(60) PRIMARY KEY,
    valor           VARCHAR(255) NOT NULL,
    descricao       VARCHAR(255),
    atualizado_em   TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO cashback_parametros (chave, valor, descricao) VALUES
('resgate_minimo',                '20.00',  'Saldo mínimo para começar a resgatar (R$)'),
('percentual_max_uso_por_compra', '30',     'Cliente pode usar até X% do valor da compra em cashback (%)'),
('dias_carencia_credito',         '7',      'Dias entre a venda e o crédito (período de devolução)'),
('aviso_expiracao_dias_1',        '30',     'Primeiro aviso suave antes da expiração'),
('aviso_expiracao_dias_2',        '7',      'Aviso urgente antes da expiração'),
('bonus_boas_vindas',              '20.00',  'Cashback de boas-vindas após cadastro completo'),
('bonus_indicacao_indicadora',    '30.00',  'Cashback pra quem indica (após 1ª compra da indicada)'),
('bonus_indicacao_indicada',      '30.00',  'Cashback pra quem foi indicada (após 1ª compra)'),
('bonus_reativacao',              '25.00',  'Cashback pra cliente inativa 90+ dias (campanha)'),
('dias_inatividade_reativacao',   '90',     'Dias sem comprar pra considerar inativa'),
('multiplicador_aniversario',     '2.0',    'Cashback é multiplicado por X no mês de aniversário'),
('multiplicador_primeira_compra_alta', '2.0', 'Multiplicador se 1ª compra for >= R$ 500'),
('valor_primeira_compra_alta',    '500.00', 'Valor mínimo da 1ª compra pra acionar bônus'),
('dias_promocao_qui',             '4',      'Dia da semana com cashback bônus (1=seg ... 7=dom). 4=qui'),
('dias_promocao_qua',             '3',      'Dia da semana com cashback bônus. 3=qua'),
('multiplicador_dias_fracos',     '1.5',    'Multiplicador nos dias de baixo movimento');

-- =====================================================================
-- 3. CAMPANHAS ESPECIAIS (datas, multiplicadores)
-- =====================================================================
CREATE TABLE cashback_campanhas (
    id              SERIAL PRIMARY KEY,
    nome            VARCHAR(100) NOT NULL,
    tipo            VARCHAR(30) NOT NULL,           -- aniversario_loja / black_friday / outono / etc
    data_inicio     TIMESTAMPTZ NOT NULL,
    data_fim        TIMESTAMPTZ NOT NULL,
    multiplicador   DECIMAL(4,2) NOT NULL,          -- 2.0 = dobra, 3.0 = triplica
    aplica_em_tiers VARCHAR(60),                    -- 'Bronze,Prata,Ouro,Diamante' ou específico
    valor_minimo_compra DECIMAL(10,2),              -- só vale acima de X
    ativa           BOOLEAN DEFAULT TRUE,
    criada_em       TIMESTAMPTZ DEFAULT NOW()
);

-- Exemplo de pré-carga (ajustar datas)
-- INSERT INTO cashback_campanhas (nome, tipo, data_inicio, data_fim, multiplicador, aplica_em_tiers)
-- VALUES ('Black Friday 2026','black_friday','2026-11-27','2026-11-30',3.0,'Bronze,Prata,Ouro,Diamante');

-- =====================================================================
-- 4. FUNÇÃO: calcular cashback de uma venda
-- Recebe: cliente_id, valor da compra, data da venda
-- Retorna: valor do cashback calculado
-- =====================================================================
CREATE OR REPLACE FUNCTION fn_calcular_cashback(
    p_cliente_id    BIGINT,
    p_valor_compra  DECIMAL,
    p_data_venda    DATE DEFAULT CURRENT_DATE,
    p_eh_primeira_compra BOOLEAN DEFAULT FALSE
) RETURNS DECIMAL AS $$
DECLARE
    v_tier_pct          DECIMAL(5,2);
    v_multiplicador     DECIMAL(4,2) := 1.0;
    v_nascimento        DATE;
    v_mes_atual         INT;
    v_mes_nascimento    INT;
    v_dia_semana        INT;
    v_valor_min_primeira DECIMAL;
    v_cashback          DECIMAL(10,2);
    v_campanha_mult     DECIMAL(4,2);
BEGIN
    -- 1. Pega % do tier atual da cliente
    SELECT t.percentual_cashback, c.data_nascimento
      INTO v_tier_pct, v_nascimento
      FROM clientes c
      JOIN cashback_tiers t ON t.nome = c.tier_atual
     WHERE c.id = p_cliente_id;

    IF v_tier_pct IS NULL THEN
        v_tier_pct := 3.00;  -- fallback Bronze
    END IF;

    -- 2. Bônus aniversário (mês)
    v_mes_atual := EXTRACT(MONTH FROM p_data_venda)::INT;
    v_mes_nascimento := EXTRACT(MONTH FROM v_nascimento)::INT;
    IF v_mes_nascimento = v_mes_atual THEN
        v_multiplicador := v_multiplicador *
            (SELECT valor::DECIMAL FROM cashback_parametros WHERE chave='multiplicador_aniversario');
    END IF;

    -- 3. Bônus dias fracos (qua/qui)
    v_dia_semana := EXTRACT(ISODOW FROM p_data_venda)::INT;
    IF v_dia_semana IN (3, 4) THEN
        v_multiplicador := v_multiplicador *
            (SELECT valor::DECIMAL FROM cashback_parametros WHERE chave='multiplicador_dias_fracos');
    END IF;

    -- 4. Bônus 1ª compra alta
    IF p_eh_primeira_compra THEN
        SELECT valor::DECIMAL INTO v_valor_min_primeira
          FROM cashback_parametros WHERE chave='valor_primeira_compra_alta';
        IF p_valor_compra >= v_valor_min_primeira THEN
            v_multiplicador := v_multiplicador *
                (SELECT valor::DECIMAL FROM cashback_parametros WHERE chave='multiplicador_primeira_compra_alta');
        END IF;
    END IF;

    -- 5. Campanhas ativas
    SELECT MAX(multiplicador) INTO v_campanha_mult
      FROM cashback_campanhas
     WHERE p_data_venda BETWEEN data_inicio AND data_fim
       AND ativa = TRUE;
    IF v_campanha_mult IS NOT NULL THEN
        v_multiplicador := v_multiplicador * v_campanha_mult;
    END IF;

    -- 6. Cálculo final
    v_cashback := ROUND(p_valor_compra * (v_tier_pct / 100.0) * v_multiplicador, 2);

    RETURN v_cashback;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- 5. FUNÇÃO: registrar crédito de cashback (uso na venda)
-- =====================================================================
CREATE OR REPLACE FUNCTION fn_creditar_cashback(
    p_cliente_id    BIGINT,
    p_valor_compra  DECIMAL,
    p_pedido_id     VARCHAR,
    p_loja_id       INT,
    p_eh_primeira   BOOLEAN DEFAULT FALSE,
    p_usuario       VARCHAR DEFAULT 'PDV'
) RETURNS DECIMAL AS $$
DECLARE
    v_valor_cashback    DECIMAL(10,2);
    v_pct               DECIMAL(5,2);
    v_dias_validade     INT;
    v_dias_carencia     INT;
    v_data_credito      DATE;
    v_data_exp          DATE;
BEGIN
    v_valor_cashback := fn_calcular_cashback(p_cliente_id, p_valor_compra, CURRENT_DATE, p_eh_primeira);

    -- % e validade do tier atual
    SELECT t.percentual_cashback, t.validade_cashback_dias
      INTO v_pct, v_dias_validade
      FROM clientes c JOIN cashback_tiers t ON t.nome = c.tier_atual
     WHERE c.id = p_cliente_id;

    -- Carência (devolução)
    SELECT valor::INT INTO v_dias_carencia
      FROM cashback_parametros WHERE chave='dias_carencia_credito';

    v_data_credito := CURRENT_DATE + v_dias_carencia;
    v_data_exp     := v_data_credito + v_dias_validade;

    INSERT INTO cashback_movimentos (
        cliente_id, tipo, valor, pedido_id, loja_id,
        valor_compra, percentual_aplicado,
        data_credito, data_expiracao,
        descricao, usuario
    ) VALUES (
        p_cliente_id, 'credito', v_valor_cashback, p_pedido_id, p_loja_id,
        p_valor_compra, v_pct,
        v_data_credito, v_data_exp,
        FORMAT('Crédito de %% sobre compra R$ %s', p_valor_compra),
        p_usuario
    );

    RETURN v_valor_cashback;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- 6. FUNÇÃO: registrar resgate (uso) de cashback
-- Valida saldo, valida 30% máximo da compra, valida resgate mínimo
-- =====================================================================
CREATE OR REPLACE FUNCTION fn_resgatar_cashback(
    p_cliente_id    BIGINT,
    p_valor_resgate DECIMAL,
    p_valor_compra  DECIMAL,
    p_pedido_id     VARCHAR,
    p_loja_id       INT,
    p_usuario       VARCHAR DEFAULT 'PDV'
) RETURNS TABLE(sucesso BOOLEAN, mensagem TEXT, valor_aplicado DECIMAL) AS $$
DECLARE
    v_saldo         DECIMAL(10,2);
    v_pct_max       DECIMAL(5,2);
    v_resgate_min   DECIMAL(10,2);
    v_max_permitido DECIMAL(10,2);
BEGIN
    SELECT saldo_atual INTO v_saldo
      FROM cashback_saldos WHERE cliente_id = p_cliente_id;

    SELECT valor::DECIMAL INTO v_pct_max
      FROM cashback_parametros WHERE chave='percentual_max_uso_por_compra';

    SELECT valor::DECIMAL INTO v_resgate_min
      FROM cashback_parametros WHERE chave='resgate_minimo';

    v_max_permitido := ROUND(p_valor_compra * (v_pct_max / 100.0), 2);

    -- Validações
    IF v_saldo < v_resgate_min THEN
        RETURN QUERY SELECT FALSE,
            FORMAT('Saldo abaixo do mínimo de R$ %s', v_resgate_min)::TEXT,
            0::DECIMAL;
        RETURN;
    END IF;

    IF p_valor_resgate > v_saldo THEN
        RETURN QUERY SELECT FALSE,
            FORMAT('Saldo insuficiente. Disponível: R$ %s', v_saldo)::TEXT,
            0::DECIMAL;
        RETURN;
    END IF;

    IF p_valor_resgate > v_max_permitido THEN
        RETURN QUERY SELECT FALSE,
            FORMAT('Pode usar no máximo R$ %s nesta compra (%s%% do valor)', v_max_permitido, v_pct_max)::TEXT,
            0::DECIMAL;
        RETURN;
    END IF;

    -- Resgata (trigger atualiza saldo automaticamente)
    INSERT INTO cashback_movimentos (
        cliente_id, tipo, valor, pedido_id, loja_id, valor_compra,
        descricao, usuario
    ) VALUES (
        p_cliente_id, 'resgate', p_valor_resgate, p_pedido_id, p_loja_id, p_valor_compra,
        FORMAT('Resgate na venda %s', p_pedido_id), p_usuario
    );

    RETURN QUERY SELECT TRUE,
        FORMAT('Resgate de R$ %s aplicado com sucesso', p_valor_resgate)::TEXT,
        p_valor_resgate;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- 7. FUNÇÃO: avaliar e atualizar tier da cliente
-- Rodar em job diário ou após cada venda grande
-- =====================================================================
CREATE OR REPLACE FUNCTION fn_avaliar_tier(p_cliente_id BIGINT)
RETURNS VARCHAR AS $$
DECLARE
    v_total_12m     DECIMAL(12,2);
    v_novo_tier     VARCHAR(15);
    v_tier_atual    VARCHAR(15);
BEGIN
    -- Soma últimos 12m
    SELECT COALESCE(SUM(valor_compra), 0)
      INTO v_total_12m
      FROM cashback_movimentos
     WHERE cliente_id = p_cliente_id
       AND tipo = 'credito'
       AND criado_em >= NOW() - INTERVAL '12 months';

    -- Encontra tier máximo elegível
    SELECT nome INTO v_novo_tier
      FROM cashback_tiers
     WHERE valor_minimo_12m <= v_total_12m
       AND ativo = TRUE
     ORDER BY ordem DESC
     LIMIT 1;

    -- Atualiza se mudou
    SELECT tier_atual INTO v_tier_atual FROM clientes WHERE id = p_cliente_id;

    IF v_tier_atual IS DISTINCT FROM v_novo_tier THEN
        UPDATE clientes
           SET tier_atual = v_novo_tier,
               data_entrada_tier = CURRENT_DATE
         WHERE id = p_cliente_id;
    END IF;

    RETURN v_novo_tier;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- 8. FUNÇÃO: expirar cashback vencido (rodar diariamente)
-- =====================================================================
CREATE OR REPLACE FUNCTION fn_expirar_cashback_vencidos()
RETURNS INT AS $$
DECLARE
    v_movimentos_expirados INT := 0;
    r RECORD;
BEGIN
    FOR r IN
        SELECT cliente_id, SUM(valor) AS valor_a_expirar
          FROM cashback_movimentos
         WHERE tipo = 'credito'
           AND data_expiracao < CURRENT_DATE
           AND NOT EXISTS (
               SELECT 1 FROM cashback_movimentos m2
                WHERE m2.cliente_id = cashback_movimentos.cliente_id
                  AND m2.tipo = 'expiracao'
                  AND m2.descricao LIKE '%' || cashback_movimentos.id::TEXT || '%'
           )
         GROUP BY cliente_id
    LOOP
        INSERT INTO cashback_movimentos (
            cliente_id, tipo, valor, descricao, usuario
        ) VALUES (
            r.cliente_id, 'expiracao', r.valor_a_expirar,
            'Expiração automática de cashback vencido', 'JOB_EXPIRACAO'
        );
        v_movimentos_expirados := v_movimentos_expirados + 1;
    END LOOP;

    RETURN v_movimentos_expirados;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- EXEMPLO DE USO (testes)
-- =====================================================================
-- 1) Cliente faz compra de R$ 350:
-- SELECT fn_creditar_cashback(123, 350.00, 'PED-001', 1, FALSE, 'thiago');
--
-- 2) Cliente quer usar R$ 30 em compra de R$ 200:
-- SELECT * FROM fn_resgatar_cashback(123, 30.00, 200.00, 'PED-002', 1, 'thiago');
--
-- 3) Recalcular tier da cliente:
-- SELECT fn_avaliar_tier(123);
--
-- 4) Job noturno expirando vencidos:
-- SELECT fn_expirar_cashback_vencidos();

-- FIM
