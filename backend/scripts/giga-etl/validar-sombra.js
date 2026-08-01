/**
 * VALIDAÇÃO OFFLINE DA SOMBRA — roda as duas consultas em casos REAIS e
 * compara, sem precisar esperar tráfego de produção.
 *
 * O modo sombra valida com o uso do dia a dia, o que é melhor — mas leva
 * dias. Este script antecipa o grosso: sorteia casos do próprio catálogo
 * (inclusive os difíceis: REF com zero à esquerda, cor composta, produto
 * duplicado em CÓDIGOS diferentes) e confere item a item.
 *
 * Só faz SELECT nos dois bancos.
 *
 * Uso:
 *   railway run --service Postgres -- node scripts/giga-etl/validar-sombra.js
 *   railway run --service Postgres -- node scripts/giga-etl/validar-sombra.js 500
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });
const QUANTOS = Number(process.argv[2]) || 200;

const norm = (s) => String(s ?? '').trim().toUpperCase();
const semZeros = (s) => s.replace(/^0+/, '') || '0';

/* ── consulta do GIGA (espelha erp.service.findCodigoByRefCorTamGiga) ────── */
async function doGiga(my, ref, cor, tam) {
  const q = async (sql, p) => {
    const [r] = await my.query(sql, p);
    return r.length ? String(r[0].CODIGO).trim() : null;
  };
  const base = `SELECT p.CODIGO, COALESCE(SUM(e.ESTOQUE),0) AS T FROM produtos p
                LEFT JOIN estoque e ON e.CODIGO = p.CODIGO WHERE TRIM(UPPER(p.REF))=TRIM(UPPER(?))`;
  const fim = ` GROUP BY p.CODIGO ORDER BY T DESC, p.CODIGO DESC LIMIT 1`;

  let r = await q(
    `${base} AND TRIM(UPPER(COALESCE(p.COR,'')))=TRIM(UPPER(?)) AND TRIM(UPPER(COALESCE(p.TAMANHO,'')))=TRIM(UPPER(?))${fim}`,
    [ref, cor, tam],
  );
  if (r) return r;
  if (cor) {
    r = await q(
      `${base} AND UPPER(p.COR) LIKE UPPER(?) AND TRIM(UPPER(COALESCE(p.TAMANHO,'')))=TRIM(UPPER(?))${fim}`,
      [ref, `%${cor}%`, tam],
    );
    if (r) return r;
    r = await q(
      `${base} AND ? LIKE CONCAT('%',UPPER(p.COR),'%') AND TRIM(UPPER(COALESCE(p.TAMANHO,'')))=TRIM(UPPER(?))${fim}`,
      [ref, cor.toUpperCase(), tam],
    );
    if (r) return r;
  }
  if (tam) {
    r = await q(`${base} AND TRIM(UPPER(COALESCE(p.TAMANHO,'')))=TRIM(UPPER(?))${fim}`, [ref, tam]);
    if (r) return r;
  }
  if (cor && tam) {
    const rx = `^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[- ]?[A-Z]+$`;
    const cs = cor.toUpperCase().replace(/[\s-]/g, '');
    const [rows] = await my.query(
      `SELECT p.CODIGO, COALESCE(SUM(e.ESTOQUE),0) AS T FROM produtos p
       LEFT JOIN estoque e ON e.CODIGO=p.CODIGO
       WHERE p.REF REGEXP ? AND TRIM(UPPER(COALESCE(p.TAMANHO,'')))=TRIM(UPPER(?))
         AND (REPLACE(REPLACE(UPPER(COALESCE(p.COR,'')),' ',''),'-','')=?
              OR REPLACE(REPLACE(UPPER(COALESCE(p.COR,'')),' ',''),'-','') LIKE ?
              OR ? LIKE CONCAT('%',REPLACE(REPLACE(UPPER(COALESCE(p.COR,'')),' ',''),'-',''),'%'))
       GROUP BY p.CODIGO ORDER BY T DESC, p.CODIGO DESC LIMIT 1`,
      [rx, tam, cs, `%${cs}%`, cs],
    );
    if (rows.length) return String(rows[0].CODIGO).trim();
  }
  return null;
}

/* ── consulta do FLOW (espelha sombra.service) ───────────────────────────── */
async function doFlow(pg, ref, cor, tam) {
  const uma = async (cond, p) => {
    const r = await pg.query(
      `SELECT p.codigo FROM wincred_produtos p
       LEFT JOIN wincred_estoque e ON e.codigo=p.codigo
       WHERE UPPER(TRIM(COALESCE(p.ref,'')))=UPPER(TRIM($1)) AND ${cond}
       GROUP BY p.codigo ORDER BY COALESCE(SUM(e.estoque),0) DESC, p.codigo DESC LIMIT 1`,
      p,
    );
    return r.rows.length ? String(r.rows[0].codigo).trim() : null;
  };

  let r = await uma(
    `UPPER(TRIM(COALESCE(p.cor,'')))=UPPER(TRIM($2)) AND UPPER(TRIM(COALESCE(p.tamanho,'')))=UPPER(TRIM($3))`,
    [ref, cor, tam],
  );
  if (r) return r;
  if (cor) {
    r = await uma(
      `UPPER(COALESCE(p.cor,'')) LIKE '%'||UPPER($2)||'%' AND UPPER(TRIM(COALESCE(p.tamanho,'')))=UPPER(TRIM($3))`,
      [ref, cor, tam],
    );
    if (r) return r;
    r = await uma(
      `UPPER($2) LIKE '%'||UPPER(COALESCE(p.cor,''))||'%' AND UPPER(TRIM(COALESCE(p.tamanho,'')))=UPPER(TRIM($3))`,
      [ref, cor, tam],
    );
    if (r) return r;
  }
  if (tam) {
    r = await uma(`UPPER(TRIM(COALESCE(p.tamanho,'')))=UPPER(TRIM($3))`, [ref, cor, tam]);
    if (r) return r;
  }
  if (cor && tam) {
    const rx = `^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[- ]?[A-Z]+$`;
    const cs = cor.toUpperCase().replace(/[\s-]/g, '');
    const q = await pg.query(
      `SELECT p.codigo FROM wincred_produtos p
       LEFT JOIN wincred_estoque e ON e.codigo=p.codigo
       WHERE COALESCE(p.ref,'') ~ $1 AND UPPER(TRIM(COALESCE(p.tamanho,'')))=UPPER(TRIM($2))
         AND (REPLACE(REPLACE(UPPER(COALESCE(p.cor,'')),' ',''),'-','')=$3
              OR REPLACE(REPLACE(UPPER(COALESCE(p.cor,'')),' ',''),'-','') LIKE '%'||$3||'%'
              OR $3 LIKE '%'||REPLACE(REPLACE(UPPER(COALESCE(p.cor,'')),' ',''),'-','')||'%')
       GROUP BY p.codigo ORDER BY COALESCE(SUM(e.estoque),0) DESC, p.codigo DESC LIMIT 1`,
      [rx, tam, cs],
    );
    if (q.rows.length) return String(q.rows[0].codigo).trim();
  }
  return null;
}

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  // Amostra ENVIESADA PRO DIFÍCIL de propósito: metade aleatória e metade de
  // REFs que existem em mais de um CÓDIGO (o caso que o desempate por estoque
  // resolve, e onde uma tradução errada erraria calada).
  const [aleatorios] = await my.query(
    `SELECT REF, COALESCE(COR,'') COR, COALESCE(TAMANHO,'') TAMANHO
       FROM produtos WHERE REF IS NOT NULL AND REF <> '' ORDER BY RAND() LIMIT ?`,
    [Math.ceil(QUANTOS / 2)],
  );
  const [duplicados] = await my.query(
    `SELECT REF, COALESCE(COR,'') COR, COALESCE(TAMANHO,'') TAMANHO
       FROM produtos WHERE REF IS NOT NULL AND REF <> ''
       GROUP BY REF, COR, TAMANHO HAVING COUNT(DISTINCT CODIGO) > 1
       ORDER BY RAND() LIMIT ?`,
    [Math.floor(QUANTOS / 2)],
  );

  const casos = [...aleatorios, ...duplicados];
  console.log(`Validando ${casos.length} casos (${aleatorios.length} aleatorios + ${duplicados.length} com CODIGO duplicado)...`);
  console.log('');

  let iguais = 0;
  const divergentes = [];
  for (const c of casos) {
    const ref = norm(c.REF);
    const cor = norm(c.COR);
    const tam = norm(c.TAMANHO);
    const [g, f] = await Promise.all([doGiga(my, ref, cor, tam), doFlow(pg, ref, cor, tam)]);
    if (String(g) === String(f)) iguais++;
    else divergentes.push({ ref, cor, tam, giga: g, flow: f });
  }

  console.log(`IGUAIS:      ${iguais}/${casos.length}`);
  console.log(`DIVERGENTES: ${divergentes.length}`);
  if (divergentes.length) {
    console.log('');
    console.log('Primeiros 15 divergentes:');
    for (const d of divergentes.slice(0, 15)) {
      console.log(`  REF=${d.ref} COR=${d.cor} TAM=${d.tam}  giga=${d.giga}  flow=${d.flow}`);
    }
  }
  console.log('');
  const taxa = ((iguais / casos.length) * 100).toFixed(2);
  console.log(taxa === '100.00' ? `TAXA 100% — traducao fiel nesta amostra.` : `TAXA ${taxa}% — investigar antes de virar a chave.`);

  await my.end();
  await pg.end();
  process.exit(divergentes.length ? 1 : 0);
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
