/**
 * PAISAGEM 1.91:1 — junta a arte PRONTA do dono com a MONTADA a partir do catálogo.
 *
 * ── POR QUE NÃO DÁ PRA SÓ CORTAR A FOTO DO CATÁLOGO ──
 *
 * Ordem do dono em 13/09/2026, olhando a folha de contato: *"as paisagens
 * ficaram todas cortadas... nao use"*. Ele está certo: 1.91:1 tirado de uma
 * foto de corpo inteiro come 58% da altura. Não existe faixa dessas que mostre
 * a peça — ou sobra o rosto, ou sobra o tronco. Duas tentativas caíram aqui:
 *
 *   1ª  recorte por saliência (`sharp.strategy.attention`) → foi pro tronco em
 *       3 de 10 e cortou o rosto; duas viraram close de busto.
 *   2ª  faixa geométrica a 6% do topo → salvou o rosto, mas a peça (o que se
 *       está anunciando) sumiu do quadro.
 *
 * O formato é que está errado pra fonte: foto de moda é vertical, anúncio
 * 1.91:1 é horizontal. Quem resolve isso é composição, não corte.
 *
 * ── AS DUAS FONTES ──
 *
 * 1. **PRONTA** — arte nativa em 1.91:1, com a modelo de corpo inteiro e o
 *    cenário preenchendo a horizontal. É a melhor opção e entra PRIMEIRO.
 *    Basta largar o arquivo na pasta de entrada.
 *    ⚠️ A proporção é CONFERIDA: fora de 1.91:1 (±1,5%) o arquivo é recusado
 *    com o motivo, em vez de eu recortar por conta e repetir o erro acima.
 *
 * 2. **MONTADA** — a foto 4:5 do catálogo entra INTEIRA (escalada pela altura,
 *    sem perder um pixel) e o resto do quadro vira marca:
 *      duo   duas peças lado a lado + faixa do logo
 *      solo  uma peça à direita + o logo respirando à esquerda
 *    O fundo é a cor MÉDIA da própria foto, clareada — assim cada peça gera um
 *    tom diferente e não saem 6 banners iguais.
 *
 * 🚨 VARIEDADE É O PONTO, e é por isso que a curadoria é por PEÇA, não por cor.
 * As três primeiras artes que chegaram (13/09) eram a MESMA foto com o vestido
 * repintado de marinho, preto e marrom — para o Google isso conta como UMA
 * imagem, e variedade é exatamente o que a nota mede. Entrou só a marinho.
 *
 * ⚠️ Nenhum texto além do logo: imagem de PMax com muita letra é penalizada, e
 * a chamada quem escreve é o Google, com os títulos do grupo.
 *
 *   node backend/scripts/google-ads-paisagem-montada.js
 *
 * Lê o 4:5 de %TEMP%\google-ads-fotos (de `google-ads-fotos-verticais.js`) e as
 * artes prontas de PASTA_PRONTAS; escreve os 191x1-*.jpg no mesmo temp e
 * reescreve a parte de paisagem do manifesto.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const PASTA = process.env.DESTINO || path.join(os.tmpdir(), 'google-ads-fotos');
/** Onde o dono larga a arte pronta. Pasta vazia = só as montadas, sem erro. */
const PASTA_PRONTAS = process.env.PRONTAS || 'C:\\Users\\User\\Downloads\\PAISAGEM LURDS';
/* A arte com ALFA, não o logo-1x1.png: aquele já foi achatado em branco pro
 * Google, e sobre um fundo colorido ele vira um adesivo com moldura branca. */
const LOGO = path.resolve(__dirname, '..', '..', 'ARQUIVOS', 'LOGO EM PRETO PNG.png');
const L = 1200;
const A = 628;
const RAZAO = L / A; // 1.9108
const TOLERANCIA = 0.015;

/** Quantas paisagens o grupo deve ter — mesma régua do script que sobe. */
const ALVO = Number(process.env.ALVO_PAISAGEM || 6);

/** Peças que não entram na paisagem — foto de espelho, ou peça que some no quadro. */
const VETADAS = new Set(['10144', '3153', '1320']);

/**
 * Ordem de preferência das MONTADAS: peças DIFERENTES primeiro. Sem isso um
 * `slice` cego pegaria as primeiras do manifesto, que podem ser duas variações
 * da mesma família — o erro que esta seção inteira existe pra evitar.
 */
const PREFERENCIA = ['701015+800317', '900908', 'CON-200', '900910', '900919', '10145'];

/**
 * Cor de fundo tirada da PRÓPRIA foto: média dos canais, clareada até virar um
 * tom de apoio. Puxa pro claro de propósito — o logo é quase preto e precisa de
 * contraste, e fundo escuro num anúncio de moda de verão mente sobre o produto.
 */
async function fundoDaFoto(arquivo) {
  const { channels } = await sharp(arquivo).stats();
  const clarear = (v) => Math.round(v + (255 - v) * 0.72);
  return { r: clarear(channels[0].mean), g: clarear(channels[1].mean), b: clarear(channels[2].mean), alpha: 1 };
}

async function montar(fotos, fundo) {
  /* Escala pela ALTURA: a foto ocupa os 628 inteiros e nada é cortado. */
  const larguraFoto = Math.round(A * 0.8); // 4:5 deitado em 628 de altura = 502
  const painel = L - larguraFoto * fotos.length;
  const camadas = [];

  for (let i = 0; i < fotos.length; i++) {
    camadas.push({
      input: await sharp(fotos[i]).resize(larguraFoto, A, { fit: 'cover' }).toBuffer(),
      left: painel + i * larguraFoto,
      top: 0,
    });
  }

  const larguraLogo = Math.min(Math.round(painel * 0.78), 340);
  if (larguraLogo >= 90) {
    const logo = await sharp(LOGO).trim().resize({ width: larguraLogo }).png().toBuffer();
    const m = await sharp(logo).metadata();
    camadas.push({
      input: logo,
      left: Math.round((painel - m.width) / 2),
      top: Math.round((A - m.height) / 2),
    });
  }

  return sharp({ create: { width: L, height: A, channels: 4, background: fundo } })
    .composite(camadas)
    .flatten({ background: fundo })
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** Arte já nativa em 1.91:1: só reduz. Recusa o que não está na proporção. */
async function importarPronta(arquivo) {
  const m = await sharp(arquivo).metadata();
  const r = m.width / m.height;
  if (Math.abs(r - RAZAO) / RAZAO > TOLERANCIA) {
    return { erro: `razão ${r.toFixed(3)} — precisa ser ${RAZAO.toFixed(3)} (±${TOLERANCIA * 100}%)` };
  }
  if (m.width < 600) return { erro: `${m.width}px de largura — mínimo 600` };
  return {
    buf: await sharp(arquivo)
      .resize(L, A, { fit: 'fill' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
      .toBuffer(),
  };
}

async function main() {
  const manifestoPath = path.join(PASTA, 'manifesto.json');
  if (!fs.existsSync(manifestoPath)) throw new Error(`sem manifesto em ${PASTA} — rode antes google-ads-fotos-verticais.js`);
  const manifesto = JSON.parse(fs.readFileSync(manifestoPath, 'utf8'));

  /* Recomeça só a parte de paisagem: o 4:5 é a fonte e não se mexe nele. */
  for (const m of manifesto.filter((x) => x.campo === 'MARKETING_IMAGE')) {
    fs.rmSync(path.join(PASTA, m.arquivo), { force: true });
  }
  const novo = manifesto.filter((m) => m.campo !== 'MARKETING_IMAGE');
  const paisagens = [];

  /* ── 1) AS PRONTAS ────────────────────────────────────────────────────── */
  const prontas = fs.existsSync(PASTA_PRONTAS)
    ? fs.readdirSync(PASTA_PRONTAS).filter((f) => /[.](png|jpe?g|webp)$/i.test(f)).sort()
    : [];
  console.log(`${prontas.length} arte(s) pronta(s) em ${PASTA_PRONTAS}`);
  for (const f of prontas) {
    const r = await importarPronta(path.join(PASTA_PRONTAS, f));
    if (r.erro) {
      console.log(`  ✖ ${f} — RECUSADA: ${r.erro}`);
      continue;
    }
    const limpo = f.replace(/[.][^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
    const arquivo = `191x1-pronta-${limpo}.jpg`;
    fs.writeFileSync(path.join(PASTA, arquivo), r.buf);
    paisagens.push({
      arquivo,
      campo: 'MARKETING_IMAGE',
      nome: `Lurds 191x1 arte ${limpo}`,
      ref: '(arte)',
      peca: f,
      categoria: 'arte',
      entrou: '',
      kb: Math.round(r.buf.length / 1024),
      fonte: 'pronta',
    });
    console.log(`  ✔ ${f} → ${arquivo} · ${Math.round(r.buf.length / 1024)} KB`);
  }

  /* ── 2) AS MONTADAS, até completar o alvo ─────────────────────────────── */
  const base = manifesto.filter((m) => m.campo === 'PORTRAIT_MARKETING_IMAGE' && !VETADAS.has(String(m.ref)));
  const porRef = new Map(base.map((b) => [String(b.ref), b]));

  const montarUma = async (chave) => {
    const refs = chave.split('+');
    const pecas = refs.map((x) => porRef.get(x)).filter(Boolean);
    if (pecas.length !== refs.length) return null;
    const arquivos = pecas.map((p) => path.join(PASTA, p.arquivo));
    const buf = await montar(arquivos, await fundoDaFoto(arquivos[0]));
    const tipo = pecas.length > 1 ? 'duo' : 'solo';
    const arquivo = `191x1-${tipo}-${refs.map((x) => x.replace(/[^A-Za-z0-9_-]/g, '')).join('-')}.jpg`;
    fs.writeFileSync(path.join(PASTA, arquivo), buf);
    return {
      arquivo,
      campo: 'MARKETING_IMAGE',
      nome: `Lurds 191x1 ${tipo} ${refs.join(' ')} ${pecas[0].entrou}`,
      ref: chave,
      peca: pecas.map((p) => p.peca).join(' + '),
      categoria: pecas[0].categoria,
      entrou: pecas[0].entrou,
      kb: Math.round(buf.length / 1024),
      fonte: 'montada',
    };
  };

  console.log(`\nmontando até fechar ${ALVO} paisagens (${paisagens.length} vieram prontas)`);
  for (const chave of PREFERENCIA) {
    if (paisagens.length >= ALVO) break;
    const m = await montarUma(chave);
    if (!m) {
      console.log(`  · ${chave} — peça não está no manifesto 4:5, pulando`);
      continue;
    }
    paisagens.push(m);
    console.log(`  ✔ ${m.nome} · ${m.kb} KB`);
  }

  if (paisagens.length < ALVO) {
    console.log(`\n⚠️  só deu ${paisagens.length} de ${ALVO} — acrescente arte em ${PASTA_PRONTAS} ou solte alguma REF de VETADAS`);
  }

  fs.writeFileSync(manifestoPath, JSON.stringify([...novo, ...paisagens], null, 2));
  console.log(
    `\nmanifesto: ${novo.filter((x) => x.campo === 'PORTRAIT_MARKETING_IMAGE').length} retrato · ` +
      `${paisagens.length} paisagem (${paisagens.filter((p) => p.fonte === 'pronta').length} pronta + ${paisagens.filter((p) => p.fonte === 'montada').length} montada)`,
  );
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
