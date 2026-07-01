-- ============================================================================
-- DIAGNÓSTICO DE PERFORMANCE — MySQL do GIGA (KingHost)
-- ============================================================================
-- 100% READ-ONLY. Nenhum comando altera dado, schema ou configuração.
-- Objetivo: medir o gargalo #2 (dependência do Giga ao vivo no PDV) — em
-- especial o lock na tabela `caixa` que serializa as finalizações da rede.
--
-- Como rodar:
--   - Use o MESMO usuário MySQL do Flow (env ERP_USER) OU um usuário só-leitura.
--   - mysql -h 162.215.213.154 -u <ERP_USER> -p <ERP_DATABASE> < giga-mysql.sql
--     (ou cole bloco a bloco no cliente). Copie a saída e mande de volta.
--   - IDEAL: rodar uma vez agora (loja fechada) e outra durante um pico real,
--     pra comparar o processlist e os lock waits.
--
-- Observação: alguns blocos (performance_schema) podem exigir privilégio; se
-- der "access denied" ou vazio, pule — os demais bastam pro diagnóstico.
-- ============================================================================

-- [0] Versão + uptime
SELECT VERSION() AS versao;
SHOW GLOBAL STATUS LIKE 'Uptime';

-- ----------------------------------------------------------------------------
-- [1] CONEXÕES ATIVAS AGORA  →  tem query presa / fila?
--     Rodar DURANTE um pico mostra bipes/finalizações esperando. Olhar a
--     coluna Time (segundos) e State (ex: 'updating', 'Sending data',
--     'waiting for handler lock').
-- ----------------------------------------------------------------------------
SHOW FULL PROCESSLIST;

SHOW STATUS LIKE 'Threads_connected';
SHOW STATUS LIKE 'Threads_running';
SHOW VARIABLES LIKE 'max_connections';

-- ----------------------------------------------------------------------------
-- [2] MAIORES TABELAS  →  peso e nº de linhas. Foco em produtos, estoque,
--     clientes e CAIXA (as que o PDV toca ao vivo).
-- ----------------------------------------------------------------------------
SELECT
  table_name,
  table_rows                                         AS linhas_aprox,
  ROUND((data_length) / 1024 / 1024, 1)              AS dados_mb,
  ROUND((index_length) / 1024 / 1024, 1)             AS indices_mb,
  ROUND((data_length + index_length) / 1024 / 1024, 1) AS total_mb
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY (data_length + index_length) DESC
LIMIT 25;

-- ----------------------------------------------------------------------------
-- [3] A TABELA `caixa` EM DETALHE  →  o hotspot do MAX(NUMERO) FOR UPDATE.
--     Quanto maior a caixa (rede toda, histórico), mais caro é o lock de
--     cada finalização. Confirma a serialização entre lojas.
-- ----------------------------------------------------------------------------
SELECT COUNT(*) AS total_linhas_caixa FROM caixa;
SELECT MAX(NUMERO) AS ultimo_numero FROM caixa;
SHOW INDEX FROM caixa;

-- ----------------------------------------------------------------------------
-- [4] LOCK WAITS (InnoDB)  →  quanto as finalizações esperam por lock.
--     Innodb_row_lock_time_avg alto e current_waits > 0 durante pico =
--     prova do gargalo de serialização na caixa.
-- ----------------------------------------------------------------------------
SHOW STATUS LIKE 'Innodb_row_lock%';

-- ----------------------------------------------------------------------------
-- [5] SLOW QUERIES POR DIGEST (performance_schema)  →  quais queries do PDV
--     mais custam no Giga. Foco nas que batem em produtos/caixa/clientes
--     (bipe, lookup de CPF, MAX(NUMERO)). Se vazio/negado, pule.
-- ----------------------------------------------------------------------------
SELECT
  LEFT(DIGEST_TEXT, 120)                       AS query,
  COUNT_STAR                                   AS execucoes,
  ROUND(SUM_TIMER_WAIT / 1e12, 1)              AS tempo_total_s,
  ROUND(AVG_TIMER_WAIT / 1e9, 1)               AS media_ms,
  ROUND(MAX_TIMER_WAIT / 1e9, 1)               AS max_ms,
  SUM_ROWS_EXAMINED                            AS linhas_lidas
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = DATABASE()
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 30;

-- ----------------------------------------------------------------------------
-- [6] FULL TABLE SCANS  →  queries que leem muito mais linhas do que retornam
--     (LIKE '%...%', função na coluna). SUM_ROWS_EXAMINED >> SUM_ROWS_SENT.
-- ----------------------------------------------------------------------------
SELECT
  LEFT(DIGEST_TEXT, 120)                        AS query,
  COUNT_STAR                                    AS execucoes,
  SUM_ROWS_EXAMINED                             AS lidas,
  SUM_ROWS_SENT                                 AS retornadas,
  ROUND(SUM_ROWS_EXAMINED / NULLIF(SUM_ROWS_SENT, 0), 0) AS razao_lidas_por_retornada
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = DATABASE()
  AND SUM_ROWS_SENT > 0
ORDER BY (SUM_ROWS_EXAMINED / NULLIF(SUM_ROWS_SENT, 0)) DESC
LIMIT 20;

-- FIM
