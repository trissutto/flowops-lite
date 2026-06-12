-- Migration: histórico de notificações enviadas pro app cliente
-- Rodar no Postgres do Railway: copia e cola no console SQL
-- Idempotente: roda 2x sem quebrar

CREATE TABLE IF NOT EXISTS customer_app_notifications (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  url           TEXT,
  image         TEXT,
  tag           TEXT,
  category      TEXT,
  read_at       TIMESTAMP,
  push_sent     BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_sent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_app_notifications_account_fk
    FOREIGN KEY (account_id) REFERENCES customer_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS customer_app_notifications_account_created_idx
  ON customer_app_notifications(account_id, created_at);

CREATE INDEX IF NOT EXISTS customer_app_notifications_account_read_idx
  ON customer_app_notifications(account_id, read_at);
