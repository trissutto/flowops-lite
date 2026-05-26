-- =====================================================================
-- CRM LOJAS LURD'S — SCHEMA POSTGRESQL
-- Substituto progressivo do Giga (Order One)
-- Foco: cashback + mala direta + segmentação Plus Size
-- =====================================================================

-- Limpa schema (cuidado em produção!)
-- DROP SCHEMA IF EXISTS crm CASCADE;
CREATE SCHEMA IF NOT EXISTS crm;
SET search_path TO crm, public;

-- =====================================================================
-- 1. LOJAS (referencial)
-- =====================================================================
CREATE TABLE lojas (
    id              SERIAL PRIMARY KEY,
    codigo_giga     VARCHAR(5) UNIQUE NOT NULL,   -- corresponde a clientes.LOJA do Giga
    nome            VARCHAR(80) NOT NULL,
    cidade          VARCHAR(60),
    uf              VARCHAR(2),
    ativa           BOOLEAN DEFAULT TRUE,
    criada_em       TIMESTAMPTZ DEFAULT NOW()
);

-- Pré-carga das lojas atuais
INSERT INTO lojas (codigo_giga, nome, cidade, uf) VALUES
('02','SANTOS','Santos','SP'),
('03','VINHEDO','Vinhedo','SP'),
('04','INDAIATUBA','Indaiatuba','SP'),
('05','PIRACICABA','Piracicaba','SP'),
('06','SOROCABA','Sorocaba','SP'),
('09','SANTOS 2','Santos','SP'),
('10','JUNDIAI','Jundiaí','SP'),
('11','LIMEIRA','Limeira','SP'),
('13','SITE','E-commerce','--'),
('14','PRAIA GRANDE','Praia Grande','SP'),
('18','MOGI','Mogi','SP'),
('19','ITU','Itu','SP'),
('20','PF','Pessoa Física','--'),
('ITA','ITANHAEM','Itanhaém','SP');

-- =====================================================================
-- 2. CLIENTES (tabela mestre)
-- =====================================================================
CREATE TABLE clientes (
    id                      BIGSERIAL PRIMARY KEY,
    registro_giga           INT UNIQUE,                       -- ponte com Giga (NULL pra novas)
    codigo_legado           INT,                              -- CODIGO do Giga

    -- Identificação
    cpf                     VARCHAR(14) UNIQUE,               -- formato 000.000.000-00
    nome_completo           VARCHAR(120) NOT NULL,
    nome_social             VARCHAR(80),
    rg                      VARCHAR(20),
    data_nascimento         DATE,
    genero                  VARCHAR(20),                      -- F / M / Outro / NI
    estado_civil            VARCHAR(20),

    -- Contato principal (denormalizado pra busca rápida)
    celular_whatsapp        VARCHAR(20),                      -- E.164: +5511999999999
    email                   VARCHAR(120),
    telefone_fixo           VARCHAR(20),

    -- Perfil Plus Size
    manequim_principal      VARCHAR(8),                       -- 44, 46, 48, 50, 52, 54, 56, 58+
    manequim_secundario     VARCHAR(8),
    tipo_corpo              VARCHAR(20),                      -- Pera/Maçã/Ampulheta/Retângulo
    estilo_preferido        VARCHAR(50),
    cores_favoritas         VARCHAR(150),
    pecas_evita             VARCHAR(150),

    -- Atribuição
    loja_origem_id          INT REFERENCES lojas(id),
    vendedora_captou        VARCHAR(80),
    origem_captacao         VARCHAR(30),                      -- Loja física / Instagram / Indicação / Site / Tráfego pago
    indicada_por_cliente_id BIGINT REFERENCES clientes(id),

    -- Métricas operacionais (atualizadas por job)
    data_primeira_compra    DATE,
    data_ultima_compra      DATE,
    total_compras_qtd       INT DEFAULT 0,
    total_compras_valor     DECIMAL(12,2) DEFAULT 0,
    ticket_medio            DECIMAL(10,2) DEFAULT 0,

    -- Tier / segmentação
    tier_atual              VARCHAR(15) DEFAULT 'Bronze',     -- Bronze / Prata / Ouro / Diamante
    data_entrada_tier       DATE DEFAULT CURRENT_DATE,
    classificacao_rfv       VARCHAR(20),                      -- Campeã / Fiel / Em risco / Hibernando / Perdida
    score_engajamento       INT DEFAULT 0,                    -- 0-100

    -- Status
    ativo                   BOOLEAN DEFAULT TRUE,
    motivo_inativacao       VARCHAR(100),

    -- Observações
    observacoes             TEXT,

    -- Auditoria
    criado_em               TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em           TIMESTAMPTZ DEFAULT NOW(),
    usuario_atualizacao     VARCHAR(50),
    origem_dados            VARCHAR(20) DEFAULT 'GIGA',       -- GIGA / PDV_NOVO / SITE / MANUAL

    CONSTRAINT chk_tier CHECK (tier_atual IN ('Bronze','Prata','Ouro','Diamante')),
    CONSTRAINT chk_rfv  CHECK (classificacao_rfv IS NULL OR classificacao_rfv IN ('Campeã','Fiel','Promissora','Em risco','Hibernando','Perdida','Nova'))
);

CREATE INDEX idx_clientes_cpf            ON clientes(cpf);
CREATE INDEX idx_clientes_celular        ON clientes(celular_whatsapp);
CREATE INDEX idx_clientes_email          ON clientes(email);
CREATE INDEX idx_clientes_loja           ON clientes(loja_origem_id);
CREATE INDEX idx_clientes_tier           ON clientes(tier_atual);
CREATE INDEX idx_clientes_rfv            ON clientes(classificacao_rfv);
CREATE INDEX idx_clientes_ult_compra     ON clientes(data_ultima_compra);
CREATE INDEX idx_clientes_giga           ON clientes(registro_giga);
CREATE INDEX idx_clientes_ativo          ON clientes(ativo) WHERE ativo = TRUE;

-- =====================================================================
-- 3. ENDEREÇOS (N por cliente)
-- =====================================================================
CREATE TABLE clientes_enderecos (
    id              BIGSERIAL PRIMARY KEY,
    cliente_id      BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    tipo            VARCHAR(20) NOT NULL,                     -- residencial / entrega / mala_direta / trabalho
    principal       BOOLEAN DEFAULT FALSE,

    cep             VARCHAR(9),                               -- 00000-000
    logradouro      VARCHAR(120),
    numero          VARCHAR(10),
    complemento     VARCHAR(60),
    bairro          VARCHAR(60),
    cidade          VARCHAR(60),
    uf              VARCHAR(2),
    ponto_referencia VARCHAR(150),

    ativo           BOOLEAN DEFAULT TRUE,
    criado_em       TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em   TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT chk_tipo_endereco CHECK (tipo IN ('residencial','entrega','mala_direta','trabalho'))
);

CREATE INDEX idx_enderecos_cliente  ON clientes_enderecos(cliente_id);
CREATE INDEX idx_enderecos_cep      ON clientes_enderecos(cep);

-- =====================================================================
-- 4. CONSENTIMENTOS LGPD (histórico, nunca apaga linha)
-- =====================================================================
CREATE TABLE clientes_consentimentos (
    id                  BIGSERIAL PRIMARY KEY,
    cliente_id          BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    canal               VARCHAR(20) NOT NULL,                 -- whatsapp / email / sms / mala_fisica / geral
    consentido          BOOLEAN NOT NULL,                     -- TRUE = aceitou, FALSE = revogou
    data_evento         TIMESTAMPTZ DEFAULT NOW(),
    versao_termo        VARCHAR(10),                          -- v1.0 / v1.1
    origem_consentimento VARCHAR(30),                         -- PDV / site / WhatsApp / cupom_fiscal
    ip_origem           INET,
    usuario_registrou   VARCHAR(50),                          -- quem da equipe registrou

    CONSTRAINT chk_canal_lgpd CHECK (canal IN ('whatsapp','email','sms','mala_fisica','geral'))
);

CREATE INDEX idx_consent_cliente_canal ON clientes_consentimentos(cliente_id, canal, data_evento DESC);

-- View para saber o consentimento ATUAL por canal (último registro)
CREATE OR REPLACE VIEW v_consentimentos_atuais AS
SELECT DISTINCT ON (cliente_id, canal)
    cliente_id,
    canal,
    consentido,
    data_evento,
    versao_termo
FROM clientes_consentimentos
ORDER BY cliente_id, canal, data_evento DESC;

-- =====================================================================
-- 5. CASHBACK — SALDOS (1 por cliente)
-- =====================================================================
CREATE TABLE cashback_saldos (
    cliente_id              BIGINT PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
    saldo_atual             DECIMAL(10,2) DEFAULT 0 CHECK (saldo_atual >= 0),
    acumulado_total         DECIMAL(12,2) DEFAULT 0,
    resgatado_total         DECIMAL(12,2) DEFAULT 0,
    expirado_total          DECIMAL(12,2) DEFAULT 0,
    proxima_expiracao_data  DATE,
    proxima_expiracao_valor DECIMAL(10,2) DEFAULT 0,
    atualizado_em           TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================================
-- 6. CASHBACK — MOVIMENTOS (extrato, auditoria completa)
-- =====================================================================
CREATE TABLE cashback_movimentos (
    id              BIGSERIAL PRIMARY KEY,
    cliente_id      BIGINT NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
    tipo            VARCHAR(20) NOT NULL,                     -- credito / resgate / expiracao / estorno / ajuste_manual
    valor           DECIMAL(10,2) NOT NULL,
    saldo_antes     DECIMAL(10,2),
    saldo_depois    DECIMAL(10,2),

    -- Referências de origem
    pedido_id       VARCHAR(50),                              -- ID da venda no PDV/e-commerce
    loja_id         INT REFERENCES lojas(id),
    valor_compra    DECIMAL(10,2),                            -- só se for crédito
    percentual_aplicado DECIMAL(5,2),                         -- só se for crédito

    -- Validade (só crédito)
    data_credito    DATE,
    data_expiracao  DATE,

    -- Auditoria
    descricao       VARCHAR(255),
    usuario         VARCHAR(50),
    criado_em       TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT chk_tipo_mov CHECK (tipo IN ('credito','resgate','expiracao','estorno','ajuste_manual'))
);

CREATE INDEX idx_cashback_cliente_data ON cashback_movimentos(cliente_id, criado_em DESC);
CREATE INDEX idx_cashback_expiracao    ON cashback_movimentos(data_expiracao) WHERE tipo = 'credito';

-- =====================================================================
-- 7. TAGS (catálogo) + N:N com clientes
-- =====================================================================
CREATE TABLE tags (
    id              SERIAL PRIMARY KEY,
    nome            VARCHAR(50) UNIQUE NOT NULL,
    descricao       VARCHAR(150),
    cor_hex         VARCHAR(7) DEFAULT '#888888',
    criada_em       TIMESTAMPTZ DEFAULT NOW()
);

-- Pré-carga de tags úteis
INSERT INTO tags (nome, descricao, cor_hex) VALUES
('VIP','Clientes top tier com tratamento diferenciado','#FFD700'),
('Influencer','Influenciadora digital ou local','#FF69B4'),
('Indicou Amigas','Trouxe novas clientes via member-get-member','#32CD32'),
('Reclamou','Já abriu reclamação ou devolução','#DC143C'),
('Aniversariante Mês','Aniversário no mês corrente (job atualiza)','#FFA500'),
('Compra Festa','Costuma comprar pra ocasiões especiais','#9370DB'),
('Compra Trabalho','Foco em looks profissionais','#4682B4'),
('Inativa 90d','Sem compra há mais de 90 dias','#A9A9A9');

CREATE TABLE clientes_tags (
    cliente_id      BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    tag_id          INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    aplicada_em     TIMESTAMPTZ DEFAULT NOW(),
    aplicada_por    VARCHAR(50),
    PRIMARY KEY (cliente_id, tag_id)
);

CREATE INDEX idx_clientes_tags_tag ON clientes_tags(tag_id);

-- =====================================================================
-- 8. RFV HISTÓRICO (snapshot mensal pra ver evolução)
-- =====================================================================
CREATE TABLE clientes_rfv_historico (
    id                  BIGSERIAL PRIMARY KEY,
    cliente_id          BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    data_snapshot       DATE NOT NULL,
    recencia_dias       INT,
    frequencia_12m      INT,
    valor_12m           DECIMAL(12,2),
    ticket_medio        DECIMAL(10,2),
    classificacao       VARCHAR(20),
    tier                VARCHAR(15),
    criado_em           TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (cliente_id, data_snapshot)
);

CREATE INDEX idx_rfv_hist_cliente ON clientes_rfv_historico(cliente_id, data_snapshot DESC);

-- =====================================================================
-- 9. LOG DE SINCRONIZAÇÃO COM GIGA (controle de migração)
-- =====================================================================
CREATE TABLE sync_giga_log (
    id              BIGSERIAL PRIMARY KEY,
    data_execucao   TIMESTAMPTZ DEFAULT NOW(),
    tipo            VARCHAR(20),                              -- full / incremental
    registros_lidos    INT,
    registros_inseridos INT,
    registros_atualizados INT,
    registros_com_erro INT,
    duracao_segundos INT,
    status          VARCHAR(20),                              -- sucesso / parcial / falha
    mensagem_erro   TEXT
);

-- =====================================================================
-- TRIGGER: atualizar saldo automaticamente a cada movimento de cashback
-- =====================================================================
CREATE OR REPLACE FUNCTION fn_atualiza_saldo_cashback()
RETURNS TRIGGER AS $$
BEGIN
    -- Garante que o cliente tem linha em saldos
    INSERT INTO cashback_saldos (cliente_id) VALUES (NEW.cliente_id)
    ON CONFLICT (cliente_id) DO NOTHING;

    IF NEW.tipo = 'credito' THEN
        UPDATE cashback_saldos
        SET saldo_atual = saldo_atual + NEW.valor,
            acumulado_total = acumulado_total + NEW.valor,
            atualizado_em = NOW()
        WHERE cliente_id = NEW.cliente_id;
    ELSIF NEW.tipo IN ('resgate','expiracao') THEN
        UPDATE cashback_saldos
        SET saldo_atual = saldo_atual - NEW.valor,
            resgatado_total = CASE WHEN NEW.tipo = 'resgate' THEN resgatado_total + NEW.valor ELSE resgatado_total END,
            expirado_total  = CASE WHEN NEW.tipo = 'expiracao' THEN expirado_total + NEW.valor ELSE expirado_total END,
            atualizado_em = NOW()
        WHERE cliente_id = NEW.cliente_id;
    ELSIF NEW.tipo = 'estorno' THEN
        UPDATE cashback_saldos
        SET saldo_atual = saldo_atual + NEW.valor,
            atualizado_em = NOW()
        WHERE cliente_id = NEW.cliente_id;
    ELSIF NEW.tipo = 'ajuste_manual' THEN
        UPDATE cashback_saldos
        SET saldo_atual = saldo_atual + NEW.valor,  -- valor pode ser negativo
            atualizado_em = NOW()
        WHERE cliente_id = NEW.cliente_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cashback_saldo
AFTER INSERT ON cashback_movimentos
FOR EACH ROW
EXECUTE FUNCTION fn_atualiza_saldo_cashback();

-- =====================================================================
-- TRIGGER: atualizado_em automático
-- =====================================================================
CREATE OR REPLACE FUNCTION fn_atualiza_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.atualizado_em = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clientes_upd BEFORE UPDATE ON clientes
FOR EACH ROW EXECUTE FUNCTION fn_atualiza_timestamp();

CREATE TRIGGER trg_enderecos_upd BEFORE UPDATE ON clientes_enderecos
FOR EACH ROW EXECUTE FUNCTION fn_atualiza_timestamp();

-- =====================================================================
-- VIEWS úteis pro dia a dia
-- =====================================================================

-- Visão consolidada do cliente (usada pelo PDV / app vendedora)
CREATE OR REPLACE VIEW v_cliente_360 AS
SELECT
    c.id,
    c.registro_giga,
    c.nome_completo,
    c.nome_social,
    c.cpf,
    c.celular_whatsapp,
    c.email,
    c.data_nascimento,
    c.manequim_principal,
    c.tier_atual,
    c.classificacao_rfv,
    c.data_ultima_compra,
    c.total_compras_qtd,
    c.total_compras_valor,
    c.ticket_medio,
    l.nome AS loja_origem,
    cs.saldo_atual AS cashback_disponivel,
    cs.proxima_expiracao_data,
    cs.proxima_expiracao_valor,
    COALESCE(
        (SELECT consentido FROM v_consentimentos_atuais
         WHERE cliente_id = c.id AND canal = 'whatsapp'), FALSE
    ) AS aceita_whatsapp,
    COALESCE(
        (SELECT consentido FROM v_consentimentos_atuais
         WHERE cliente_id = c.id AND canal = 'email'), FALSE
    ) AS aceita_email,
    (SELECT STRING_AGG(t.nome, ', ')
     FROM clientes_tags ct JOIN tags t ON t.id = ct.tag_id
     WHERE ct.cliente_id = c.id) AS tags
FROM clientes c
LEFT JOIN lojas l ON l.id = c.loja_origem_id
LEFT JOIN cashback_saldos cs ON cs.cliente_id = c.id
WHERE c.ativo = TRUE;

-- Aniversariantes do mês
CREATE OR REPLACE VIEW v_aniversariantes_mes AS
SELECT id, nome_completo, celular_whatsapp, data_nascimento,
       EXTRACT(DAY FROM data_nascimento) AS dia_aniversario
FROM clientes
WHERE ativo = TRUE
  AND EXTRACT(MONTH FROM data_nascimento) = EXTRACT(MONTH FROM CURRENT_DATE)
ORDER BY dia_aniversario;

-- Cashback expirando em 15 dias
CREATE OR REPLACE VIEW v_cashback_expirando AS
SELECT c.id, c.nome_completo, c.celular_whatsapp,
       cs.saldo_atual, cs.proxima_expiracao_data, cs.proxima_expiracao_valor
FROM clientes c
JOIN cashback_saldos cs ON cs.cliente_id = c.id
WHERE cs.proxima_expiracao_data BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '15 days'
  AND cs.proxima_expiracao_valor > 0
ORDER BY cs.proxima_expiracao_data;

-- FIM DO SCHEMA
