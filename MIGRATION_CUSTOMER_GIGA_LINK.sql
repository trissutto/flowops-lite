-- =============================================================================
-- MIGRATION: CustomerGigaLink — chave composta (loja, codigo) do Giga
-- =============================================================================
-- Resolve bug crítico: Giga usa contador POR LOJA, então codigo=1 existe em
-- 14 lojas diferentes. registroGiga Int único era ambíguo.
--
-- COMO RODAR:
--   1. Abre Railway → Postgres → Console → Query
--   2. Cola TUDO daqui pra baixo
--   3. Run
--   4. Limpa Customers Giga atuais (CUIDADO — comando incluído no final)
--   5. Roda Sincronizar Giga do zero pela UI
-- =============================================================================

-- 1. Criar tabela CustomerGigaLink
CREATE TABLE IF NOT EXISTS customer_giga_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  giga_loja    TEXT NOT NULL,
  giga_codigo  INTEGER NOT NULL,
  ultimo_sync  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT giga_loja_codigo_unique UNIQUE (giga_loja, giga_codigo)
);

CREATE INDEX IF NOT EXISTS customer_giga_links_customer_id_idx
  ON customer_giga_links(customer_id);

-- =============================================================================
-- 2. LIMPEZA DOS REGISTROS GIGA EXISTENTES (CUIDADO!)
-- =============================================================================
-- O ETL antigo gravou Customers errados (registroGiga ambíguo).
-- Como o Giga não tem dado marketing crítico (só nome+cpf+loja), é mais
-- seguro APAGAR todos os Customers só-Giga e reimportar do zero.
--
-- Preservados: WC (originSource='woo'), PDV (originSource='pdv'), manual.
-- =============================================================================

-- Conta antes (pra você ver quantos vão sumir)
SELECT
  COUNT(*) FILTER (WHERE origin_source = 'giga')        AS giga_a_apagar,
  COUNT(*) FILTER (WHERE origin_source = 'woo')         AS woo_preservados,
  COUNT(*) FILTER (WHERE origin_source = 'pdv')         AS pdv_preservados,
  COUNT(*) FILTER (WHERE origin_source = 'giga_sistema') AS giga_sistema_a_apagar,
  COUNT(*) FILTER (WHERE origin_source = 'manual')      AS manual_preservados,
  COUNT(*) FILTER (WHERE origin_source IS NULL)         AS sem_origem,
  COUNT(*)                                              AS total
FROM customers;

-- APAGAR só os Giga (CASCADE limpa addresses, consents, tags, etc deles)
DELETE FROM customers
WHERE origin_source IN ('giga', 'giga_sistema');

-- 3. Limpar coluna registroGiga dos Customers WC remanescentes
--    (alguns WC podem ter recebido registroGiga errado durante merges)
UPDATE customers SET registro_giga = NULL WHERE registro_giga IS NOT NULL;

-- =============================================================================
-- 4. Conta final (deve mostrar 0 Giga, mantendo WC/PDV)
-- =============================================================================
SELECT
  origin_source,
  COUNT(*) AS qtd
FROM customers
GROUP BY origin_source
ORDER BY qtd DESC;

-- PRONTO. Agora roda "Sincronizar Giga" pela UI /clientes-crm/sincronizacao
