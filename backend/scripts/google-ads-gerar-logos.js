/**
 * GERA OS LOGOS NO FORMATO QUE O GOOGLE ADS EXIGE, a partir do arquivo oficial.
 *
 * Fonte: `ARQUIVOS/LOGO EM PRETO PNG.png` (2065x1127, com transparência) — o
 * logotipo oficial da marca, já versionado no repo. O SVG irmão
 * (`LOGOTIPO EM PRETO.svg`) é a mesma arte numa prancheta de página inteira,
 * com o desenho ocupando ~8% da área; daria o mesmo resultado depois do trim,
 * mas o PNG já vem recortado e com resolução de sobra pro 1200px de saída.
 *
 * ── POR QUE PRECISA GERAR ──
 * O grupo de recursos da PMax pede LOGO em **1:1**. A arte é 1,83:1. Não dá
 * pra "redimensionar": esticar deforma a marca. O certo é DEITAR a arte numa
 * tela quadrada com margem.
 *
 * 🚨 A MARGEM NÃO É ESTÉTICA — é requisito. Em várias posições o Google
 * RECORTA O LOGO EM CÍRCULO (perfil do anunciante, Discover, Gmail). O que
 * passar da circunferência inscrita é cortado. Pra uma arte de razão r caber
 * no círculo de diâmetro D:  w² + (w/r)² ≤ D²  →  w ≤ D / √(1 + 1/r²).
 * Com r = 1,83 isso dá w ≤ 0,877·D. Aqui usamos 0,84 — folga de segurança,
 * porque o "s" do Lurd's e o rabo do traço são finos e encostar na borda do
 * círculo já lê como corte.
 *
 * Gera dois arquivos (o 4:1 é opcional pro Google, mas conta na força do anúncio):
 *   backend/assets/google-ads/logo-1x1.png   1200x1200
 *   backend/assets/google-ads/logo-4x1.png   1200x300
 *
 *   node backend/scripts/google-ads-gerar-logos.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const RAIZ = path.resolve(__dirname, '..', '..');
const FONTE = path.join(RAIZ, 'ARQUIVOS', 'LOGO EM PRETO PNG.png');
const DESTINO = path.join(RAIZ, 'backend', 'assets', 'google-ads');

/** Fundo BRANCO, não transparente: a arte é quase preta e o Google compõe o
 *  logo sobre superfícies claras E escuras. Transparente sumiria no escuro. */
const FUNDO = { r: 255, g: 255, b: 255, alpha: 1 };

/** Fração da largura da tela que a arte ocupa no 1:1 — ver a conta do círculo. */
const OCUPACAO_1X1 = 0.84;
/** No 4:1 o limite é a ALTURA; não há recorte circular, então cabe mais. */
const OCUPACAO_4X1 = 0.78;

async function main() {
  fs.mkdirSync(DESTINO, { recursive: true });

  /* Tira a moldura transparente do PNG oficial: sem isso a "margem" que eu
   * calculo já vem somada à margem que o arquivo carrega, e a marca fica
   * pequena no meio de um quadrado vazio. */
  const arte = await sharp(FONTE).trim().png().toBuffer();
  const m = await sharp(arte).metadata();
  const razao = m.width / m.height;
  console.log(`arte recortada: ${m.width}x${m.height} (razão ${razao.toFixed(2)}:1)`);

  const limiteCirculo = 1 / Math.sqrt(1 + 1 / (razao * razao));
  console.log(`teto do círculo para esta razão: ${(limiteCirculo * 100).toFixed(1)}% da largura · usando ${(OCUPACAO_1X1 * 100).toFixed(0)}%`);
  if (OCUPACAO_1X1 > limiteCirculo) throw new Error('a arte estouraria o recorte circular do Google');

  const gerar = async (arquivo, largura, altura, ocupacao) => {
    /* Escolhe a dimensão que aperta primeiro — no 1:1 é a largura, no 4:1 a altura. */
    let w = Math.round(largura * ocupacao);
    let h = Math.round(w / razao);
    const hMax = Math.round(altura * ocupacao);
    if (h > hMax) { h = hMax; w = Math.round(h * razao); }

    const camada = await sharp(arte).resize({ width: w, height: h, fit: 'inside' }).png().toBuffer();
    const saida = path.join(DESTINO, arquivo);
    await sharp({ create: { width: largura, height: altura, channels: 4, background: FUNDO } })
      .composite([{ input: camada, gravity: 'centre' }])
      .png({ compressionLevel: 9 })
      .toFile(saida);
    const kb = (fs.statSync(saida).size / 1024).toFixed(0);
    console.log(`  ${arquivo}  ${largura}x${altura} · arte ${w}x${h} · ${kb} KB`);
  };

  console.log('\ngerando:');
  await gerar('logo-1x1.png', 1200, 1200, OCUPACAO_1X1);
  await gerar('logo-4x1.png', 1200, 300, OCUPACAO_4X1);
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
