-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION: Sprint 0 — Consolidação de Grade
-- Roda no Postgres Railway. Idempotente (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Score de consolidação (0-200, default 50 neutro)
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS consolidation_score INTEGER NOT NULL DEFAULT 50;

-- 2. Flag de loja outlet (destino preferencial de peças velhas)
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS is_outlet BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Inicializa scores sugeridos (revisar e ajustar pela tela depois)
-- Lojas "âncoras" típicas — ajuste conforme realidade
UPDATE stores SET consolidation_score = 100 WHERE code IN ('02', '07', '15');
-- 02 SANTOS, 07 CAMPINAS, 15 MOEMA — lojas que tendem a vender mais variedade

-- Verificação rápida
SELECT code, name, consolidation_score, is_outlet
  FROM stores
 ORDER BY consolidation_score DESC, code ASC;
