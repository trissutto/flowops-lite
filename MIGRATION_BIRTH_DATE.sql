-- Migration: adiciona birth_date em customer_accounts (app)
-- Rodar no Postgres do Railway uma vez antes do deploy.
-- Idempotente: roda 2x sem quebrar.

ALTER TABLE customer_accounts
  ADD COLUMN IF NOT EXISTS birth_date DATE;

-- Index pra acelerar consulta de aniversariantes do mês
-- (usado pela campanha "mimo de aniversário" - cron diário)
CREATE INDEX IF NOT EXISTS customer_accounts_birth_date_month_idx
  ON customer_accounts (EXTRACT(MONTH FROM birth_date), EXTRACT(DAY FROM birth_date))
  WHERE birth_date IS NOT NULL;

-- Backfill (opcional): puxa birthDate do Customer mais antigo de cada CustomerAccount
-- via CustomerAccountLink. Só atualiza accounts que ainda não têm.
-- Comentado por padrão — descomente se quiser rodar 1 vez.
/*
UPDATE customer_accounts a
SET birth_date = (
  SELECT c.birth_date
  FROM customer_account_links l
  JOIN customers c ON c.id = l.customer_id
  WHERE l.account_id = a.id
    AND c.birth_date IS NOT NULL
  ORDER BY l.is_primary DESC, l.linked_at ASC
  LIMIT 1
)
WHERE a.birth_date IS NULL;
*/
