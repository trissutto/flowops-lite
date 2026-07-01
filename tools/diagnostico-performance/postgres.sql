-- ============================================================================
-- DIAGNÓSTICO DE PERFORMANCE — POSTGRES (Railway)
-- ============================================================================
-- 100% READ-ONLY. Nenhum comando altera dado, schema ou configuração.
-- Rodar com a LOJA FECHADA pra fotografar o estado após um dia de operação.
--
-- Como rodar (Railway):
--   1. Railway → serviço Postgres → "Connect" → copie a Connection URL.
--   2. psql "postgresql://...."  (ou o console SQL do Railway)
--   3. \i tools/diagnostico-performance/postgres.sql
--      (ou cole bloco a bloco). Copie TODA a saída e mande de volta.
--
-- O que cada bloco responde está no comentário acima dele.
-- ============================================================================

\echo '=== [0] Versão + uptime ==='
SELECT version();
SELECT date_trunc('second', now() - pg_postmaster_start_time()) AS uptime;

-- ----------------------------------------------------------------------------
-- [1] CONEXÕES vs TETO  →  o pool está perto de estourar?
--     Se count(active+idle in transaction) encosta em max_connections, o
--     Prisma sem connection_limit + as transações de 180s do espelho competem.
-- ----------------------------------------------------------------------------
\echo '=== [1] Conexões vs max_connections ==='
SHOW max_connections;
SELECT state, count(*)
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state
ORDER BY count DESC;

-- ----------------------------------------------------------------------------
-- [2] CACHE HIT RATIO  →  o banco está servindo de RAM ou indo a disco?
--     Saudável: heap e index > 0.99. Abaixo de ~0.95 = falta shared_buffers
--     (caixa pequena no Railway) ou working set maior que a RAM.
-- ----------------------------------------------------------------------------
\echo '=== [2] Cache hit ratio (heap e index) ==='
SELECT
  'heap' AS tipo,
  round(sum(heap_blks_hit) * 100.0 / nullif(sum(heap_blks_hit + heap_blks_read), 0), 2) AS hit_pct
FROM pg_statio_user_tables
UNION ALL
SELECT
  'index',
  round(sum(idx_blks_hit) * 100.0 / nullif(sum(idx_blks_hit + idx_blks_read), 0), 2)
FROM pg_statio_user_tables;

-- ----------------------------------------------------------------------------
-- [3] MAIORES TABELAS  →  onde está o peso / o que cresce sem controle.
--     Olhar as append-only (master_audits, dm_messages, comments,
--     stock_movements) e as do espelho (giga_*, wincred_*).
-- ----------------------------------------------------------------------------
\echo '=== [3] 25 maiores tabelas (dados + índices) ==='
SELECT
  relname AS tabela,
  pg_size_pretty(pg_total_relation_size(relid)) AS total,
  pg_size_pretty(pg_relation_size(relid))       AS dados,
  pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS indices,
  n_live_tup AS linhas_vivas
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 25;

-- ----------------------------------------------------------------------------
-- [4] BLOAT / DEAD TUPLES  →  o custo do espelho horário (delete-all + insert).
--     dead_pct alto em giga_*/wincred_* confirma que o rewrite de hora em hora
--     está inchando o banco e mantendo o autovacuum ocupado.
-- ----------------------------------------------------------------------------
\echo '=== [4] Dead tuples / autovacuum (top 20 por dead tuples) ==='
SELECT
  relname AS tabela,
  n_live_tup AS vivas,
  n_dead_tup AS mortas,
  round(n_dead_tup * 100.0 / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
  last_autovacuum,
  autovacuum_count,
  last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;

-- ----------------------------------------------------------------------------
-- [5] SEQ SCANS EM TABELAS GRANDES  →  índices faltando.
--     seq_scan alto + seq_tup_read gigante em tabela com muitas linhas =
--     varredura completa recorrente (candidato a índice).
-- ----------------------------------------------------------------------------
\echo '=== [5] Tabelas com mais seq scan (candidatas a índice) ==='
SELECT
  relname AS tabela,
  seq_scan,
  seq_tup_read,
  idx_scan,
  n_live_tup AS linhas,
  CASE WHEN seq_scan > 0 THEN seq_tup_read / seq_scan ELSE 0 END AS linhas_por_seqscan
FROM pg_stat_user_tables
WHERE n_live_tup > 1000
ORDER BY seq_tup_read DESC
LIMIT 20;

-- ----------------------------------------------------------------------------
-- [6] ÍNDICES NUNCA USADOS  →  peso morto (lentidão de INSERT + disco).
--     idx_scan = 0 em índice não-unique é candidato a remover.
-- ----------------------------------------------------------------------------
\echo '=== [6] Índices nunca usados (idx_scan = 0) ==='
SELECT
  relname AS tabela,
  indexrelname AS indice,
  pg_size_pretty(pg_relation_size(indexrelid)) AS tamanho,
  idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 25;

-- ----------------------------------------------------------------------------
-- [7] QUERIES / TRANSAÇÕES LONGAS AGORA  →  algo preso?
--     Rodar de novo DURANTE o minuto do sync horário do Giga pra flagrar as
--     transações de 120-180s (giga-mirror) segurando conexão.
-- ----------------------------------------------------------------------------
\echo '=== [7] Queries em andamento há mais de 2s ==='
SELECT
  pid,
  state,
  date_trunc('second', now() - xact_start) AS tempo_transacao,
  date_trunc('second', now() - query_start) AS tempo_query,
  left(query, 120) AS query
FROM pg_stat_activity
WHERE datname = current_database()
  AND state <> 'idle'
  AND now() - query_start > interval '2 seconds'
ORDER BY query_start
LIMIT 20;

-- ----------------------------------------------------------------------------
-- [8] TOP QUERIES POR TEMPO TOTAL  →  onde o banco realmente gasta CPU/IO.
--     Precisa da extensão pg_stat_statements. Se der erro "relation does not
--     exist", rode primeiro (uma vez, seguro):  CREATE EXTENSION IF NOT EXISTS
--     pg_stat_statements;  — no Railway costuma já estar disponível.
--     Colunas total_exec_time/mean_exec_time = Postgres 13+.
-- ----------------------------------------------------------------------------
\echo '=== [8] Top 30 queries por tempo total (pg_stat_statements) ==='
SELECT
  calls,
  round(total_exec_time::numeric, 0)      AS total_ms,
  round(mean_exec_time::numeric, 2)       AS media_ms,
  round(max_exec_time::numeric, 0)        AS max_ms,
  rows,
  left(query, 140) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 30;

\echo '=== FIM DO DIAGNÓSTICO POSTGRES ==='
