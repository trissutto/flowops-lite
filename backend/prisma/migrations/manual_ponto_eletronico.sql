-- ─────────────────────────────────────────────────────────────────
-- PONTO ELETRÔNICO (REP-A - Face API)
-- Adiciona: campos faciais em sellers + tabela ponto_registros
-- Rodar manualmente após git pull, OU prisma migrate dev/deploy.
-- ─────────────────────────────────────────────────────────────────

-- 1) Campos de cadastro facial na vendedora
ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS face_descriptors TEXT,
  ADD COLUMN IF NOT EXISTS face_enrolled_at TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS face_snapshot_url TEXT;

-- 2) Tabela de registros de ponto
CREATE TABLE IF NOT EXISTS ponto_registros (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id       UUID NOT NULL,
  store_id        UUID NOT NULL,
  tipo            VARCHAR(20) NOT NULL,           -- entrada | saida_almoco | volta_almoco | saida
  timestamp       TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  source          VARCHAR(20) NOT NULL,           -- face_pdv | pwa_selfie | manual_admin
  face_confidence DOUBLE PRECISION,
  face_snapshot   TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  ip              VARCHAR(45),
  observacoes     TEXT,
  justificado     BOOLEAN NOT NULL DEFAULT FALSE,
  justificativa   TEXT,
  justificado_by  TEXT,
  justificado_at  TIMESTAMP(3),
  created_at      TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_ponto_seller
    FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE,
  CONSTRAINT fk_ponto_store
    FOREIGN KEY (store_id) REFERENCES stores(id)
);

CREATE INDEX IF NOT EXISTS idx_ponto_seller_ts ON ponto_registros(seller_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_ponto_store_ts  ON ponto_registros(store_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_ponto_ts        ON ponto_registros(timestamp);
