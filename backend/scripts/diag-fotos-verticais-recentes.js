/**
 * CANDIDATAS A FOTO VERTICAL (4:5) DO GOOGLE ADS — só leitura.
 *
 * O grupo de recursos da PMax pede PORTRAIT_MARKETING_IMAGE em 4:5 e os 27
 * grupos da conta de lojas estão com ZERO. Este script escolhe de onde tirar.
 *
 * ── O CRITÉRIO, E POR QUE ELE NÃO É "a foto mais bonita" ──
 *
 * 1. PEÇA RECENTE — `site_produto.publicado_em` é a data real de entrada no ar
 *    (é a mesma régua da vitrine "Novidades", ≤30 dias). Anunciar o que a loja
 *    acabou de receber é o único jeito de a cliente achar na arara.
 * 2. COM SALDO NA REDE — peça esgotada em anúncio é clique pago que termina em
 *    "não temos". Piso de 5 peças somando as 14 lojas.
 * 3. PROPORÇÃO — medida em 22/08: 61% do catálogo é QUADRADA, 24% é mais alta
 *    que 3/4 (vestido) e 15% já é 4:5. Nenhuma é 3/4.
 *      · quadrada → vira 4:5 cortando 20% da LARGURA (modelo centralizada: ok)
 *      · mais alta que 4:5 → corta ALTURA; corta por BAIXO, nunca a cabeça
 *      · já 4:5 → não corta nada (preferida)
 * 4. RESOLUÇÃO — o 4:5 do Google é 960x1200 recomendado. Foto com menos de
 *    960 de largura ÚTIL depois do corte sobe borrada.
 *
 *   railway run --service flowops-lite node backend/scripts/diag-fotos-verticais-recentes.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const SALDO_MINIMO = 5;

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const { rows } = await db.query(
    `WITH saldo AS (
       SELECT p.ref, SUM(GREATEST(COALESCE(e.estoque, 0), 0)) AS qt
         FROM product p
         JOIN wincred_estoque e ON e.codigo = p.codigo
        WHERE p.ref IS NOT NULL
        GROUP BY p.ref
     )
     SELECT sp.ref, sp.nome, sp.categoria, sp.publicado_em::date AS entrou,
            pp.cor, pp.url, pp.largura_px AS w, pp.altura_px AS h,
            COALESCE(s.qt, 0) AS saldo
       FROM site_produto sp
       JOIN product_photos pp ON pp.ref = sp.ref AND pp.ordem = 0
       LEFT JOIN saldo s ON s.ref = sp.ref
      WHERE sp.publicado = true
        AND sp.publicado_em IS NOT NULL
        AND COALESCE(s.qt, 0) >= $1
      ORDER BY sp.publicado_em DESC, sp.ref
      LIMIT 120`,
    [SALDO_MINIMO],
  );

  const classe = (w, h) => {
    if (!w || !h) return 'sem medida';
    const r = w / h;
    if (r > 0.95) return 'quadrada';
    if (r > 0.84) return 'entre 4:5 e 1:1';
    if (r > 0.76) return '≈4:5 (ideal)';
    return 'mais alta que 4:5';
  };
  /** Largura que SOBRA depois de virar 4:5 — é ela que decide se fica nítida. */
  const larguraUtil = (w, h) => (!w || !h ? 0 : w / h > 0.8 ? Math.round(h * 0.8) : w);

  console.log(`${rows.length} peças publicadas recentemente com capa e saldo >= ${SALDO_MINIMO}\n`);
  const porClasse = {};
  for (const r of rows) porClasse[classe(r.w, r.h)] = (porClasse[classe(r.w, r.h)] || 0) + 1;
  console.log('proporção das capas:', porClasse, '\n');

  const boas = rows.filter((r) => larguraUtil(r.w, r.h) >= 960);
  console.log(`${boas.length} têm largura útil >= 960px depois do corte 4:5\n`);
  console.log('ENTROU      REF        SALDO  FOTO         CLASSE              CATEGORIA / nome');
  for (const r of boas.slice(0, 40)) {
    console.log(
      `${String(r.entrou).slice(0, 10)}  ${String(r.ref).padEnd(9)} ${String(r.saldo).padStart(5)}  ` +
        `${String(r.w)}x${String(r.h)}`.padEnd(12) +
        ` ${classe(r.w, r.h).padEnd(19)} ${String(r.categoria || '?').padEnd(16)} ${String(r.nome).slice(0, 40)}`,
    );
  }
  await db.end();
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
