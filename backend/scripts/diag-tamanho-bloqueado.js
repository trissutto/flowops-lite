/**
 * A trava de tamanho (PR #892, 15/08 10:53) parou de acontecer?
 *
 * Conta `add_to_cart_blocked / size_missing` por hora de Brasília, separando
 * ANTES x DEPOIS do deploy, e mostra o denominador (view_item) — cair porque
 * o site esvaziou não é conserto.
 *
 *   railway run --service Postgres node backend/scripts/diag-tamanho-bloqueado.js
 */
const { Client } = require('pg');

const DEPLOY = '2026-08-15 10:53'; // merge do PR #892 (horário de Brasília)
const SP = "AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo'";

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log(`── bloqueios por dia/hora (deploy do fix: ${DEPLOY}) ──`);
  const porHora = await db.query(
    `SELECT to_char(criado_em ${SP}, 'DD/MM HH24') AS hora,
            COUNT(*)::int AS eventos, COUNT(DISTINCT session_id)::int AS pessoas
       FROM site_eventos
      WHERE evento = 'add_to_cart_blocked' AND dados->>'reason' = 'size_missing'
        AND criado_em > NOW() - INTERVAL '4 days'
      GROUP BY 1 ORDER BY 1`,
  );
  for (const r of porHora.rows) console.log(`  ${r.hora}h  ${String(r.pessoas).padStart(3)} pessoas  ${r.eventos} cliques`);

  console.log('\n── por dia, com denominador ──');
  const porDia = await db.query(
    `SELECT to_char(criado_em ${SP}, 'DD/MM') AS dia,
            COUNT(*) FILTER (WHERE evento='add_to_cart_blocked' AND dados->>'reason'='size_missing')::int AS bloqueios,
            COUNT(DISTINCT session_id) FILTER (WHERE evento='add_to_cart_blocked' AND dados->>'reason'='size_missing')::int AS pessoas_bloq,
            COUNT(DISTINCT session_id) FILTER (WHERE evento='view_item')::int AS pessoas_viram,
            COUNT(DISTINCT session_id) FILTER (WHERE evento='add_to_cart')::int AS pessoas_sacola
       FROM site_eventos
      WHERE criado_em > NOW() - INTERVAL '4 days'
      GROUP BY 1 ORDER BY 1`,
  );
  console.table(porDia.rows);

  console.log('── 15/08 partido no deploy (mesma janela de horas, 11h de cada lado) ──');
  const corte = await db.query(
    `SELECT CASE WHEN criado_em ${SP} < TIMESTAMP '${DEPLOY}' THEN 'antes' ELSE 'depois' END AS lado,
            COUNT(*)::int AS bloqueios, COUNT(DISTINCT session_id)::int AS pessoas
       FROM site_eventos
      WHERE evento='add_to_cart_blocked' AND dados->>'reason'='size_missing'
        AND (criado_em ${SP})::date = DATE '2026-08-15'
      GROUP BY 1`,
  );
  console.table(corte.rows);

  await db.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
