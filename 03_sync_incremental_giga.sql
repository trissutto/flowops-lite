-- =====================================================================
-- SINCRONIZAÇÃO INCREMENTAL: GIGA → CRM NOVO
-- Rodar 1x por dia (sugestão: madrugada, via cron/scheduler)
-- =====================================================================
-- Estratégia:
--   • Recarga COMPLETA pra tabela temp (Giga não tem coluna 'atualizado_em')
--   • UPSERT: insere novos / atualiza só campos que vêm do Giga
--   • NUNCA sobrescreve campos próprios do CRM (manequim, tier, tags, cashback...)
-- =====================================================================

SET search_path TO crm, public;

-- Início do log
INSERT INTO sync_giga_log (tipo, status) VALUES ('incremental', 'iniciado')
RETURNING id AS sync_id \gset

-- ---------------------------------------------------------------------
-- 1. Subir CSV/export atual do Giga pra tabela temp (mesma estrutura do migração inicial)
-- ---------------------------------------------------------------------
CREATE TEMP TABLE giga_clientes_raw (LIKE giga_clientes_raw_template INCLUDING ALL);
-- \COPY giga_clientes_raw FROM '/caminho/diario/clientes_giga.csv' CSV HEADER ENCODING 'UTF8';

-- ---------------------------------------------------------------------
-- 2. UPSERT — preserva campos próprios do CRM
-- ---------------------------------------------------------------------
INSERT INTO clientes AS c (
    registro_giga, codigo_legado, cpf, nome_completo, rg,
    data_nascimento, estado_civil,
    celular_whatsapp, email, telefone_fixo,
    loja_origem_id,
    data_primeira_compra, data_ultima_compra,
    origem_dados, ativo
)
SELECT
    g.registro,
    g.codigo,
    normaliza_cpf(g.cpf),
    TRIM(g.nome),
    NULLIF(TRIM(g.rg), ''),
    g.nascimento,
    NULLIF(TRIM(g.estadocivil), ''),
    normaliza_celular(g.fonecel),
    LOWER(NULLIF(TRIM(g.email), '')),
    NULLIF(TRIM(g.foneres), ''),
    l.id,
    g.pricompra,
    g.ultcompra,
    'GIGA',
    CASE WHEN g.bloqueado = 'S' THEN FALSE ELSE TRUE END
FROM giga_clientes_raw g
LEFT JOIN lojas l ON l.codigo_giga = g.loja
WHERE g.nome IS NOT NULL AND TRIM(g.nome) <> ''
ON CONFLICT (registro_giga) DO UPDATE SET
    -- Atualiza APENAS campos vindos do Giga
    cpf                  = EXCLUDED.cpf,
    nome_completo        = EXCLUDED.nome_completo,
    rg                   = EXCLUDED.rg,
    data_nascimento      = EXCLUDED.data_nascimento,
    estado_civil         = EXCLUDED.estado_civil,
    -- Contato: só atualiza se o CRM estiver vazio (não sobrescreve celular que cliente atualizou no PDV novo)
    celular_whatsapp     = COALESCE(c.celular_whatsapp, EXCLUDED.celular_whatsapp),
    email                = COALESCE(c.email, EXCLUDED.email),
    telefone_fixo        = COALESCE(c.telefone_fixo, EXCLUDED.telefone_fixo),
    loja_origem_id       = COALESCE(c.loja_origem_id, EXCLUDED.loja_origem_id),
    data_primeira_compra = COALESCE(c.data_primeira_compra, EXCLUDED.data_primeira_compra),
    data_ultima_compra   = GREATEST(c.data_ultima_compra, EXCLUDED.data_ultima_compra),
    atualizado_em        = NOW();

-- NUNCA atualiza por aqui: manequim_principal, tier_atual, cashback, tags, consentimentos, etc.

-- ---------------------------------------------------------------------
-- 3. Sincronizar endereços residenciais (estratégia: substitui se mudou)
-- ---------------------------------------------------------------------
-- Marca endereços antigos como inativos antes de inserir os novos
UPDATE clientes_enderecos ce
SET ativo = FALSE
FROM clientes c, giga_clientes_raw g
WHERE ce.cliente_id = c.id
  AND c.registro_giga = g.registro
  AND ce.tipo = 'residencial'
  AND (
      normaliza_cep(g.cepres)         IS DISTINCT FROM ce.cep
      OR NULLIF(TRIM(g.enderecores),'') IS DISTINCT FROM ce.logradouro
      OR NULLIF(TRIM(g.numerores),'')   IS DISTINCT FROM ce.numero
  );

INSERT INTO clientes_enderecos (cliente_id, tipo, principal, cep, logradouro, numero, complemento, bairro, cidade, uf)
SELECT c.id, 'residencial', TRUE,
       normaliza_cep(g.cepres),
       NULLIF(TRIM(g.enderecores),''),
       NULLIF(TRIM(g.numerores),''),
       NULLIF(TRIM(g.compres),''),
       NULLIF(TRIM(g.bairrores),''),
       NULLIF(TRIM(g.cidaderes),''),
       NULLIF(TRIM(g.ufres),'')
FROM giga_clientes_raw g
JOIN clientes c ON c.registro_giga = g.registro
WHERE NOT EXISTS (
    SELECT 1 FROM clientes_enderecos ce
    WHERE ce.cliente_id = c.id AND ce.tipo='residencial' AND ce.ativo = TRUE
);

-- ---------------------------------------------------------------------
-- 4. Fechar o log da sincronização
-- ---------------------------------------------------------------------
UPDATE sync_giga_log
SET registros_lidos = (SELECT COUNT(*) FROM giga_clientes_raw),
    registros_inseridos = (SELECT COUNT(*) FROM clientes WHERE origem_dados='GIGA' AND criado_em::date = CURRENT_DATE),
    registros_atualizados = (SELECT COUNT(*) FROM clientes WHERE origem_dados='GIGA' AND atualizado_em::date = CURRENT_DATE AND criado_em::date < CURRENT_DATE),
    status = 'sucesso',
    duracao_segundos = EXTRACT(EPOCH FROM (NOW() - data_execucao))::INT
WHERE id = :sync_id;

DROP TABLE giga_clientes_raw;

-- FIM
