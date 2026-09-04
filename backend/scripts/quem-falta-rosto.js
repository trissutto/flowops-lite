/**
 * Quem ainda NÃO cadastrou o rosto pro ponto facial.
 *
 * Sem biometria a pessoa simplesmente não bate — a câmera abre, mas não há com
 * quem comparar. Foi o que travou a Brenda em Vinhedo.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/quem-falta-rosto.js
 */

const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const r = await c.query(
    `SELECT s.store_code_origin AS loja,
            COALESCE(st.name, '(loja nao identificada)') AS loja_nome,
            s.name, s.cargo, s.lojas_atuacao
       FROM sellers s
       LEFT JOIN stores st ON st.code = s.store_code_origin
      WHERE s.active = true AND s.face_descriptors IS NULL
      ORDER BY s.store_code_origin NULLS LAST, s.name`,
  );

  const total = await c.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE face_descriptors IS NOT NULL)::int AS com
       FROM sellers WHERE active = true`,
  );
  const T = total.rows[0];

  console.log(`Vendedoras ativas: ${T.n} · com rosto cadastrado: ${T.com} · FALTAM: ${T.n - T.com}`);
  console.log('');

  let lojaAtual = null;
  for (const x of r.rows) {
    if (x.loja !== lojaAtual) {
      lojaAtual = x.loja;
      console.log('');
      console.log(`── ${x.loja || '??'} · ${x.loja_nome} ──`);
    }
    // Quem atua em outras lojas precisa do rosto pra bater em qualquer uma
    // delas — vale sinalizar, porque a falta pesa mais.
    let extra = '';
    try {
      const l = JSON.parse(JSON.parse(x.lojas_atuacao || '"[]"'));
      if (Array.isArray(l) && l.length) extra = `   (também atua em ${l.join(', ')})`;
    } catch { /* formato inesperado — ignora */ }
    console.log(`   ${String(x.name || '?').padEnd(38)} ${String(x.cargo || '').padEnd(12)}${extra}`);
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
