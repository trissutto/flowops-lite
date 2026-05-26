-- =====================================================================
-- MIGRAÇÃO INICIAL: GIGA (MariaDB) → CRM NOVO (PostgreSQL)
-- Carga ÚNICA dos clientes existentes
-- =====================================================================
-- COMO USAR:
-- 1. Exportar a tabela 'clientes' do Giga em CSV (UTF-8)
--    No phpMyAdmin/Adminer do Giga: SELECT * FROM clientes → Export CSV
-- 2. Subir o CSV pro servidor Postgres
-- 3. Rodar o COPY abaixo apontando pro arquivo
-- 4. Rodar os INSERTs de transformação
-- =====================================================================

SET search_path TO crm, public;

-- ---------------------------------------------------------------------
-- PASSO 1: Tabela temporária espelho do Giga
-- ---------------------------------------------------------------------
CREATE TEMP TABLE giga_clientes_raw (
    registro            INT,
    codigo              INT,
    nome                VARCHAR(50),
    rg                  VARCHAR(18),
    rgexp               VARCHAR(3),
    rgemissao           DATE,
    cpf                 VARCHAR(18),
    nascimento          DATE,
    naturalidade        VARCHAR(30),
    estadocivil         VARCHAR(12),
    conjuge             VARCHAR(50),
    conjugerg           VARCHAR(18),
    conjugecpf          VARCHAR(18),
    enderecores         VARCHAR(50),
    numerores           VARCHAR(6),
    compres             VARCHAR(15),
    bairrores           VARCHAR(30),
    cidaderes           VARCHAR(30),
    ufres               VARCHAR(2),
    cepres              VARCHAR(9),
    enderecocarta       VARCHAR(50),
    compcarta           VARCHAR(15),
    bairrocarta         VARCHAR(30),
    cidadecarta         VARCHAR(30),
    ufcarta             VARCHAR(2),
    cepcarta            VARCHAR(9),
    foneres             VARCHAR(15),
    fonecel             VARCHAR(15),
    fonerec             VARCHAR(15),
    nomerec             VARCHAR(31),
    autorizado1         VARCHAR(50),
    autorizado1rg       VARCHAR(18),
    autorizado1cpf      VARCHAR(18),
    autorizado2         VARCHAR(50),
    autorizado2rg       VARCHAR(18),
    autorizado2cpf      VARCHAR(18),
    trabalhorazaosoc    VARCHAR(50),
    trabalhoendereco    VARCHAR(50),
    trabalhocomp        VARCHAR(15),
    trabalhobairro      VARCHAR(30),
    trabalhocidade      VARCHAR(30),
    trabalhouf          VARCHAR(2),
    trabalhocep         VARCHAR(9),
    trabalhofone        VARCHAR(15),
    trabalhocargo       VARCHAR(30),
    trabalhoadm         DATE,
    trabalhosalario     DECIMAL(10,2),
    spcdata             DATE,
    spcconsulta         VARCHAR(15),
    spcsituacao         VARCHAR(30),
    spcobs              TEXT,
    refpessoal          VARCHAR(50),
    avaliacao           VARCHAR(2),
    limitecompras       DECIMAL(10,2),
    pricompra           DATE,
    ultcompra           DATE,
    loja                VARCHAR(2),
    casapropria         VARCHAR(1),
    aluguel             DECIMAL(10,2),
    obs                 VARCHAR(50),
    pai                 VARCHAR(100),
    mae                 VARCHAR(50),
    email               VARCHAR(50),
    refcom1             VARCHAR(50),
    fonerefcom1         VARCHAR(15),
    refcom2             VARCHAR(50),
    fonerefcom2         VARCHAR(15),
    refpessoal1         VARCHAR(50),
    fonerefpessoal1     VARCHAR(15),
    refpessoal2         VARCHAR(50),
    fonerefpessoal2     VARCHAR(15),
    spc                 VARCHAR(3),
    cartorio            VARCHAR(3),
    justica             VARCHAR(3),
    negativado          VARCHAR(3),
    convenio            INT,
    fidelidade          VARCHAR(3),
    datacredito         DATE,
    emitido             VARCHAR(3),
    bloqueado           VARCHAR(3),
    cod_card            INT,
    refcomerciais       TEXT
);

-- ---------------------------------------------------------------------
-- PASSO 2: Importar o CSV exportado do Giga
-- Ajuste o caminho do arquivo
-- ---------------------------------------------------------------------
-- \COPY giga_clientes_raw FROM '/caminho/para/clientes_giga.csv' CSV HEADER ENCODING 'UTF8';

-- ---------------------------------------------------------------------
-- PASSO 3: Funções auxiliares de limpeza/normalização
-- ---------------------------------------------------------------------

-- Normalizar CPF: remove pontos/traços, valida 11 dígitos, formata
CREATE OR REPLACE FUNCTION normaliza_cpf(p_cpf TEXT) RETURNS TEXT AS $$
DECLARE
    v_clean TEXT;
BEGIN
    IF p_cpf IS NULL THEN RETURN NULL; END IF;
    v_clean := REGEXP_REPLACE(p_cpf, '[^0-9]', '', 'g');
    IF LENGTH(v_clean) <> 11 THEN RETURN NULL; END IF;
    RETURN SUBSTRING(v_clean,1,3) || '.' || SUBSTRING(v_clean,4,3) || '.' ||
           SUBSTRING(v_clean,7,3) || '-' || SUBSTRING(v_clean,10,2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Normalizar celular: remove tudo, adiciona +55, valida 10 ou 11 dígitos
CREATE OR REPLACE FUNCTION normaliza_celular(p_fone TEXT) RETURNS TEXT AS $$
DECLARE
    v_clean TEXT;
BEGIN
    IF p_fone IS NULL THEN RETURN NULL; END IF;
    v_clean := REGEXP_REPLACE(p_fone, '[^0-9]', '', 'g');
    -- Remove DDI se já vier
    IF LENGTH(v_clean) > 11 AND LEFT(v_clean,2) = '55' THEN
        v_clean := SUBSTRING(v_clean,3);
    END IF;
    IF LENGTH(v_clean) NOT IN (10,11) THEN RETURN NULL; END IF;
    RETURN '+55' || v_clean;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Normalizar CEP
CREATE OR REPLACE FUNCTION normaliza_cep(p_cep TEXT) RETURNS TEXT AS $$
DECLARE
    v_clean TEXT;
BEGIN
    IF p_cep IS NULL THEN RETURN NULL; END IF;
    v_clean := REGEXP_REPLACE(p_cep, '[^0-9]', '', 'g');
    IF LENGTH(v_clean) <> 8 THEN RETURN NULL; END IF;
    RETURN SUBSTRING(v_clean,1,5) || '-' || SUBSTRING(v_clean,6,3);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------
-- PASSO 4: Migrar para CLIENTES
-- ---------------------------------------------------------------------
INSERT INTO clientes (
    registro_giga, codigo_legado, cpf, nome_completo, rg,
    data_nascimento, estado_civil,
    celular_whatsapp, email, telefone_fixo,
    loja_origem_id,
    data_primeira_compra, data_ultima_compra,
    observacoes, origem_dados, ativo
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
    NULLIF(TRIM(g.obs), ''),
    'GIGA',
    CASE WHEN g.bloqueado = 'S' THEN FALSE ELSE TRUE END
FROM giga_clientes_raw g
LEFT JOIN lojas l ON l.codigo_giga = g.loja
WHERE g.nome IS NOT NULL AND TRIM(g.nome) <> ''
ON CONFLICT (registro_giga) DO NOTHING;

-- ---------------------------------------------------------------------
-- PASSO 5: Migrar endereços RESIDENCIAIS
-- ---------------------------------------------------------------------
INSERT INTO clientes_enderecos (
    cliente_id, tipo, principal,
    cep, logradouro, numero, complemento, bairro, cidade, uf
)
SELECT
    c.id,
    'residencial',
    TRUE,
    normaliza_cep(g.cepres),
    NULLIF(TRIM(g.enderecores), ''),
    NULLIF(TRIM(g.numerores), ''),
    NULLIF(TRIM(g.compres), ''),
    NULLIF(TRIM(g.bairrores), ''),
    NULLIF(TRIM(g.cidaderes), ''),
    NULLIF(TRIM(g.ufres), '')
FROM giga_clientes_raw g
JOIN clientes c ON c.registro_giga = g.registro
WHERE NULLIF(TRIM(g.enderecores), '') IS NOT NULL
   OR NULLIF(TRIM(g.cepres), '') IS NOT NULL;

-- ---------------------------------------------------------------------
-- PASSO 6: Migrar endereços de CORRESPONDÊNCIA (mala direta)
-- Só insere se for diferente do residencial
-- ---------------------------------------------------------------------
INSERT INTO clientes_enderecos (
    cliente_id, tipo, principal,
    cep, logradouro, complemento, bairro, cidade, uf
)
SELECT
    c.id,
    'mala_direta',
    FALSE,
    normaliza_cep(g.cepcarta),
    NULLIF(TRIM(g.enderecocarta), ''),
    NULLIF(TRIM(g.compcarta), ''),
    NULLIF(TRIM(g.bairrocarta), ''),
    NULLIF(TRIM(g.cidadecarta), ''),
    NULLIF(TRIM(g.ufcarta), '')
FROM giga_clientes_raw g
JOIN clientes c ON c.registro_giga = g.registro
WHERE NULLIF(TRIM(g.enderecocarta), '') IS NOT NULL
  AND (TRIM(g.enderecocarta) <> TRIM(COALESCE(g.enderecores,''))
       OR TRIM(g.cepcarta) <> TRIM(COALESCE(g.cepres,'')));

-- ---------------------------------------------------------------------
-- PASSO 7: Criar saldo zero pra todo cliente migrado
-- ---------------------------------------------------------------------
INSERT INTO cashback_saldos (cliente_id)
SELECT id FROM clientes
ON CONFLICT (cliente_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- PASSO 8: Tag automática "Migrado Giga" pra rastrear origem
-- ---------------------------------------------------------------------
INSERT INTO tags (nome, descricao, cor_hex) VALUES ('Migrado Giga','Cliente importado do sistema Giga','#708090')
ON CONFLICT (nome) DO NOTHING;

INSERT INTO clientes_tags (cliente_id, tag_id, aplicada_por)
SELECT c.id, t.id, 'SISTEMA_MIGRACAO'
FROM clientes c
CROSS JOIN tags t
WHERE c.origem_dados = 'GIGA' AND t.nome = 'Migrado Giga'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- PASSO 9: Registrar a execução
-- ---------------------------------------------------------------------
INSERT INTO sync_giga_log (tipo, registros_lidos, registros_inseridos, status)
SELECT
    'full',
    (SELECT COUNT(*) FROM giga_clientes_raw),
    (SELECT COUNT(*) FROM clientes WHERE origem_dados = 'GIGA'),
    'sucesso';

-- ---------------------------------------------------------------------
-- PASSO 10: Relatório pós-migração
-- ---------------------------------------------------------------------
SELECT
    'Total clientes migrados' AS metrica,
    COUNT(*) AS valor
FROM clientes WHERE origem_dados = 'GIGA'
UNION ALL
SELECT 'Com CPF válido', COUNT(*) FROM clientes WHERE cpf IS NOT NULL
UNION ALL
SELECT 'Com celular válido', COUNT(*) FROM clientes WHERE celular_whatsapp IS NOT NULL
UNION ALL
SELECT 'Com email válido', COUNT(*) FROM clientes WHERE email IS NOT NULL AND email LIKE '%@%'
UNION ALL
SELECT 'Com data nascimento', COUNT(*) FROM clientes WHERE data_nascimento IS NOT NULL
UNION ALL
SELECT 'Com endereço residencial', COUNT(DISTINCT cliente_id) FROM clientes_enderecos WHERE tipo='residencial'
UNION ALL
SELECT 'Com endereço mala direta separado', COUNT(DISTINCT cliente_id) FROM clientes_enderecos WHERE tipo='mala_direta';

-- FIM
