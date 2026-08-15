/**
 * TAXA DE ACEITE DO BANNER — quanto do funil o Meta/GA4 realmente enxergam.
 * O nosso banco grava TUDO (com e sem aceite); o repasse pro Meta só
 * acontece com aceite. `sem_aceite=true` = evento que o Meta NÃO viu.
 *
 *   railway run --service Postgres node backend/scripts/diag-aceite-consentimento.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('══════ SESSÕES 7d — com × sem aceite ══════');
  const r = await db.query(
    `SELECT sem_aceite, COUNT(DISTINCT session_id)::int AS sessoes, COUNT(*)::int AS eventos
       FROM site_eventos WHERE criado_em > NOW() - INTERVAL '7 days'
      GROUP BY sem_aceite ORDER BY sem_aceite`,
  );
  for (const x of r.rows) {
    console.log(`  ${x.sem_aceite ? 'SEM aceite (Meta não vê)' : 'COM aceite (Meta vê)   '} ${String(x.sessoes).padStart(6)} sessões | ${String(x.eventos).padStart(7)} eventos`);
  }

  console.log('\n══════ EVENTOS-CHAVE 7d — quanto o Meta perde ══════');
  const chave = await db.query(
    `SELECT evento,
            COUNT(*) FILTER (WHERE NOT sem_aceite)::int AS meta_ve,
            COUNT(*) FILTER (WHERE sem_aceite)::int     AS meta_nao_ve
       FROM site_eventos
      WHERE criado_em > NOW() - INTERVAL '7 days'
        AND evento IN ('view_item','add_to_cart','begin_checkout','purchase')
      GROUP BY evento ORDER BY evento`,
  );
  for (const x of chave.rows) {
    const total = x.meta_ve + x.meta_nao_ve;
    const pct = total ? Math.round((100 * x.meta_nao_ve) / total) : 0;
    console.log(`  ${x.evento.padEnd(16)} Meta vê ${String(x.meta_ve).padStart(5)} | perde ${String(x.meta_nao_ve).padStart(5)} (${pct}% invisível)`);
  }

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
