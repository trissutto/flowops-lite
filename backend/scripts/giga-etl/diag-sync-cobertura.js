/**
 * O sync "full de hora em hora" do estoque é MESMO full?
 *
 * A conta não fechou: 703 pares divergentes, mas só 2 vendas nas últimas 2h e
 * uma fila saudável (16s de média, zero retentativa). Timing de replicação não
 * explica esse volume. A hipótese que sobra é que o sync horário, que se diz
 * "full", na verdade não toca todas as linhas — e as que ele não toca ficam
 * congeladas em silêncio.
 *
 * O teste: `synced_at` é carimbado em cada linha que o sync escreve. Se o sync
 * fosse full de verdade, TODAS as linhas teriam praticamente o mesmo
 * `synced_at`. Se houver linha de dias atrás, o sync está deixando gente pra
 * trás — e é exatamente aí que a divergência deve se concentrar.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-sync-cobertura.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const semZeros = (s) => String(s ?? '').trim().replace(/^0+/, '') || '0';
const chave = (codigo, loja) => `${semZeros(codigo)}|${semZeros(loja)}`;

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  console.log('--- IDADE DAS LINHAS DO ESPELHO ---');
  const d = await pg.query(
    `SELECT CASE
              WHEN synced_at > NOW() - INTERVAL '2 hours'  THEN 'a. ate 2h'
              WHEN synced_at > NOW() - INTERVAL '12 hours' THEN 'b. 2h-12h'
              WHEN synced_at > NOW() - INTERVAL '2 days'   THEN 'c. 12h-2d'
              WHEN synced_at > NOW() - INTERVAL '15 days'  THEN 'd. 2d-15d'
              ELSE                                              'e. mais de 15 dias'
            END AS faixa,
            COUNT(*)::int AS n
       FROM wincred_estoque GROUP BY 1 ORDER BY 1`,
  );
  for (const r of d.rows) console.log(`  ${r.faixa}: ${r.n.toLocaleString('pt-BR')} linhas`);

  // Agora o cruzamento que decide: as linhas divergentes sao as ATRASADAS?
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });
  const [gigaRows] = await my.query(`SELECT CODIGO, LOJA, COALESCE(ESTOQUE,0) AS ESTOQUE FROM estoque`);
  const giga = new Map();
  for (const r of gigaRows) giga.set(chave(r.CODIGO, r.LOJA), Number(r.ESTOQUE) || 0);

  const flowRes = await pg.query(
    `SELECT codigo, loja, COALESCE(estoque,0) AS estoque,
            EXTRACT(EPOCH FROM (NOW() - synced_at))/3600 AS horas
       FROM wincred_estoque`,
  );

  let recenteIgual = 0, recenteDif = 0, velhoIgual = 0, velhoDif = 0;
  for (const r of flowRes.rows) {
    const g = giga.get(chave(r.codigo, r.loja));
    if (g === undefined) continue;
    const dif = g !== (Number(r.estoque) || 0);
    const velho = Number(r.horas) > 2;
    if (velho) { if (dif) velhoDif++; else velhoIgual++; }
    else { if (dif) recenteDif++; else recenteIgual++; }
  }

  const pct = (a, b) => (a + b ? ((a / (a + b)) * 100).toFixed(2) : '0.00');
  console.log('');
  console.log('--- DIVERGENCIA x IDADE DA LINHA ---');
  console.log(`  Linhas sincronizadas ha ATE 2h:  ${(recenteIgual + recenteDif).toLocaleString('pt-BR')} — ${pct(recenteDif, recenteIgual)}% divergentes`);
  console.log(`  Linhas sincronizadas ha MAIS 2h: ${(velhoIgual + velhoDif).toLocaleString('pt-BR')} — ${pct(velhoDif, velhoIgual)}% divergentes`);
  console.log('');
  if (velhoDif + velhoIgual > 1000 && Number(pct(velhoDif, velhoIgual)) > Number(pct(recenteDif, recenteIgual)) * 3) {
    console.log('  >> CONFIRMADO: o sync "full" NAO cobre todas as linhas.');
    console.log('     A divergencia mora nas linhas que ele deixa pra tras.');
  } else {
    console.log('  >> A idade da linha NAO explica a divergencia. Outra causa.');
  }

  await my.end();
  await pg.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
