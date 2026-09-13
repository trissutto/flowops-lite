/**
 * MONTA AS FOTOS VERTICAIS 4:5 do Google Ads a partir do catálogo do site.
 * Só LÊ o banco e ESCREVE arquivo local — não fala com o Google.
 * Quem sobe é o irmão `google-ads-lojas-imagens.js`, que lê o manifesto daqui.
 *
 * ── AS REGRAS DE CORTE, E POR QUE NÃO É "redimensionar" ──
 *
 * Medição de 22/08 em 110 fotos do catálogo: 61% quadradas, 24% MAIS ALTAS que
 * 3/4 (vestido), 15% já 4:5, e ZERO em 3/4. Ou seja: quase nada nasce 4:5.
 *
 *   foto mais LARGA que 4:5  → corta a LARGURA, centralizado. A modelo está no
 *                              meio do quadro; tirar 20% dos lados não a toca.
 *   foto mais ALTA que 4:5   → corta a ALTURA **por baixo** (gravity north).
 *                              Cortar em cima decapita a modelo — e o rosto é
 *                              o que segura o olho no anúncio.
 *
 * Saída 1200x1500 (o Google recomenda 960x1200; sobra resolução e o JPEG q88
 * fica em ~200 KB, longe do teto de 5.120 KB).
 *
 * ── A ESCOLHA DAS PEÇAS ──
 * Recentes (`site_produto.publicado_em`), com saldo na rede e largura útil
 * suficiente — ver `diag-fotos-verticais-recentes.js`, que explica cada filtro.
 * Uma REF por peça: 8 fotos da mesma modelo com 8 cores da mesma blusa não é
 * variedade, é repetição — e o Google mede variedade pra dar "Ótimo".
 *
 *   railway run --service Postgres node backend/scripts/google-ads-fotos-verticais.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const sharp = require('sharp');

const QUANTAS = Number(process.env.QUANTAS || 8);
const SALDO_MINIMO = 5;
const LARGURA = 1200;
const ALTURA = 1500; // 4:5
const DESTINO = process.env.DESTINO || path.join(os.tmpdir(), 'google-ads-fotos');

/** Largura que sobra depois do corte — abaixo de 960 o Google recebe foto mole. */
const larguraUtil = (w, h) => (!w || !h ? 0 : w / h > 0.8 ? Math.round(h * 0.8) : w);

async function cortar45(buf) {
  const m = await sharp(buf).metadata();
  const r = m.width / m.height;
  let extrair;
  if (r > 0.8) {
    const w = Math.round(m.height * 0.8);
    extrair = { left: Math.round((m.width - w) / 2), top: 0, width: w, height: m.height };
  } else {
    const h = Math.round(m.width / 0.8);
    extrair = { left: 0, top: 0, width: m.width, height: Math.min(h, m.height) };
  }
  return sharp(buf)
    .extract(extrair)
    .resize(LARGURA, ALTURA, { fit: 'fill' })
    .flatten({ background: '#ffffff' }) // PNG com alfa vira fundo preto no Google
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const { rows } = await db.query(
    `WITH saldo AS (
       SELECT p.ref, SUM(GREATEST(COALESCE(e.estoque, 0), 0)) AS qt
         FROM product p JOIN wincred_estoque e ON e.codigo = p.codigo
        WHERE p.ref IS NOT NULL GROUP BY p.ref
     )
     SELECT DISTINCT ON (sp.ref)
            sp.ref, sp.nome, sp.categoria, sp.publicado_em::date AS entrou,
            pp.cor, pp.url, pp.largura_px AS w, pp.altura_px AS h, COALESCE(s.qt, 0) AS saldo
       FROM site_produto sp
       JOIN product_photos pp ON pp.ref = sp.ref AND pp.ordem = 0
       LEFT JOIN saldo s ON s.ref = sp.ref
      WHERE sp.publicado = true AND sp.publicado_em IS NOT NULL
        AND COALESCE(s.qt, 0) >= $1 AND pp.largura_px IS NOT NULL
      ORDER BY sp.ref, sp.publicado_em DESC`,
    [SALDO_MINIMO],
  );
  await db.end();

  const fila = rows
    .filter((r) => larguraUtil(r.w, r.h) >= 960)
    .sort((a, b) => new Date(b.entrou) - new Date(a.entrou))
    .slice(0, QUANTAS);

  if (!fila.length) throw new Error('nenhuma foto passou nos filtros — afrouxe o saldo ou a resolução');

  fs.rmSync(DESTINO, { recursive: true, force: true });
  fs.mkdirSync(DESTINO, { recursive: true });

  const manifesto = [];
  for (const r of fila) {
    const resp = await fetch(r.url);
    if (!resp.ok) {
      console.log(`  ⚠️  ${r.ref} — foto não baixou (HTTP ${resp.status}), pulando`);
      continue;
    }
    const cortada = await cortar45(Buffer.from(await resp.arrayBuffer()));
    const arquivo = `4x5-${String(r.ref).replace(/[^A-Za-z0-9_-]/g, '')}.jpg`;
    fs.writeFileSync(path.join(DESTINO, arquivo), cortada);
    /* O NOME é a chave de idempotência lá no Google: o irmão não recria um
     * ativo que já exista com este nome. Por isso carrega a REF e a data. */
    manifesto.push({
      arquivo,
      nome: `Lurds 4x5 ${r.ref} ${String(r.entrou).slice(0, 10)}`,
      ref: r.ref,
      peca: r.nome,
      categoria: r.categoria || '?',
      entrou: String(r.entrou).slice(0, 10),
      origem: r.url,
      kb: Math.round(cortada.length / 1024),
    });
    console.log(`  ✔ ${String(r.ref).padEnd(9)} ${String(r.categoria || '?').padEnd(11)} ${r.w}x${r.h} → 1200x1500 · ${Math.round(cortada.length / 1024)} KB · ${String(r.nome).slice(0, 38)}`);
  }

  fs.writeFileSync(path.join(DESTINO, 'manifesto.json'), JSON.stringify(manifesto, null, 2));
  console.log(`\n${manifesto.length} fotos em ${DESTINO}`);
  console.log('manifesto.json escrito — agora rode google-ads-lojas-imagens.js');
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
