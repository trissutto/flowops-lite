-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION: Devolução manual Giga (opção C)
-- Permite pdv_returns sem originalSaleId (devolução de peça antiga sem cupom).
-- Adiciona source ('flowops' | 'giga_manual') + manual_sku.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Tornar original_sale_id opcional (era NOT NULL)
ALTER TABLE pdv_returns
  ALTER COLUMN original_sale_id DROP NOT NULL;

-- 2. Coluna source (origem da devolução)
ALTER TABLE pdv_returns
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'flowops';

-- 3. Coluna manual_sku (SKU bipado em devolução manual)
ALTER TABLE pdv_returns
  ADD COLUMN IF NOT EXISTS manual_sku TEXT;

-- Verificação rápida
SELECT
  source,
  COUNT(*) AS qtd
FROM pdv_returns
GROUP BY source;
