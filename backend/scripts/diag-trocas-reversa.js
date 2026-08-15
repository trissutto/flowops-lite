/**
 * DIAGNÓSTICO — trocas paradas esperando o código de postagem.
 *
 * A geração do código reverso é MANUAL (POST /trocas/:id/reversa/gerar, tela
 * da retaguarda). Se ninguém clica, a cliente fica esperando e não existe
 * alarme: o lembrete automático só olha troca que JÁ tem código.
 *
 *   railway run --service Postgres -- node backend/scripts/diag-trocas-reversa.js
 */
const { Client } = require('pg');

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  console.log('════════ TROCAS POR STATUS ════════');
  const st = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM troca_solicitacoes GROUP BY status ORDER BY n DESC`,
  );
  for (const r of st.rows) console.log(`  ${String(r.status).padEnd(26)} ${r.n}`);

  console.log('\n════════ ESPERANDO O CÓDIGO DE POSTAGEM (ninguém gerou) ════════');
  const esp = await db.query(
    `SELECT numero, status, reversa_gratis, created_at,
            EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 AS dias,
            customer_phone IS NOT NULL AS tem_tel,
            customer_email IS NOT NULL AS tem_email
       FROM troca_solicitacoes
      WHERE reversa_codigo IS NULL
        AND status NOT IN ('cancelada', 'finalizada')
      ORDER BY created_at ASC`,
  );
  for (const r of esp.rows) {
    console.log(
      `  #${String(r.numero).padEnd(6)} ${String(r.status).padEnd(24)} ` +
        `gratis=${r.reversa_gratis} ${Number(r.dias).toFixed(1)} dias esperando ` +
        `(tel=${r.tem_tel} email=${r.tem_email})`,
    );
  }
  console.log(`  TOTAL parado: ${esp.rows.length}`);

  console.log('\n════════ COM CÓDIGO: chegou a sair pra cliente? ════════');
  const cod = await db.query(
    `SELECT COUNT(*)::int AS com_codigo,
            COUNT(reversa_enviada_at)::int AS avisada,
            COUNT(reversa_lembrete_at)::int AS lembrada
       FROM troca_solicitacoes WHERE reversa_codigo IS NOT NULL`,
  );
  const c = cod.rows[0];
  console.log(`  com código=${c.com_codigo} · avisada=${c.avisada} · lembrete enviado=${c.lembrada}`);

  await db.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
