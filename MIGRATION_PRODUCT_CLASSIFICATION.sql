-- Migration: classificação BÁSICO/MODA por referência (tela Cadastros → Classificação de Produtos)
-- Rodar no Postgres do Railway: copia e cola no console SQL
-- Idempotente: roda 2x sem quebrar
--
-- Observação: o deploy normalmente já cria isto via `prisma db push` (start:prod).
-- Este arquivo é a versão documental/manual, na convenção dos outros MIGRATION_*.sql.
--
-- Owned 100% pelo Flow. NÃO altera nada no ERP Giga/Wincred ao vivo.
-- Granularidade = REF (modelo): básico/moda vale pra todas as cores/tamanhos da REF.
-- Sem registro aqui = MODA (0) + não revisado, conforme a regra da tela.

CREATE TABLE IF NOT EXISTS product_classification (
  ref                    VARCHAR(20) PRIMARY KEY,
  tipo_produto           INTEGER     NOT NULL DEFAULT 0,   -- 0 = MODA, 1 = BÁSICO
  classificacao_revisada BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_by             TEXT,
  updated_at             TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS product_classification_tipo_idx
  ON product_classification(tipo_produto);

CREATE INDEX IF NOT EXISTS product_classification_revisada_idx
  ON product_classification(classificacao_revisada);
