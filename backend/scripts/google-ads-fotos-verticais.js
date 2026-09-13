/**
 * MONTA OS CRIATIVOS DE IMAGEM do Google Ads a partir do catálogo do site.
 * Só LÊ o banco e ESCREVE arquivo local — não fala com o Google.
 * Quem sobe é `google-ads-lojas-imagens.js`, que lê o manifesto daqui.
 *
 * (O arquivo nasceu só com o 4:5 e manteve o nome; hoje gera os dois formatos
 * que faltam na conta. O nome fica porque a tarefa agendada o referencia.)
 *
 * ── O QUE ESTE ARQUIVO CONSERTA (medido 13/09/2026) ──
 *
 * Comparando os grupos de recursos EXCELLENT que já existem nesta conta com os
 * 27 ativos, o gargalo NÃO é quantidade de imagem — o teto é 20 nos dois casos.
 * É a MISTURA:
 *
 *              paisagem 1.91:1   quadrada 1:1   retrato 4:5
 *   EXCELLENT       7-9              7-9            2-4
 *   os 27 ativos    1-2             18-19            0
 *
 * As mesmas 20 vagas, gastas de um jeito que o Google pune. Por isso aqui saem
 * os DOIS formatos que faltam, e não só o vertical.
 *
 * ── AS REGRAS DE CORTE, E POR QUE NÃO É "redimensionar" ──
 *
 * Medição de 22/08 em 110 fotos do catálogo: 61% quadradas, 24% MAIS ALTAS que
 * 3/4 (vestido), 15% já 4:5, e ZERO em 3/4. Quase nada nasce no formato certo.
 *
 *   4:5 — foto mais LARGA que 4:5 corta a LARGURA, centralizado (a modelo está
 *         no meio do quadro). Foto mais ALTA corta a ALTURA **por baixo**:
 *         cortar em cima decapita a modelo, e o rosto é o que segura o olho.
 *
 *   1.91:1 — aqui o corte é BRUTAL: de uma foto 4:5 sobra 42% da altura. Não dá
 *         pra escolher a faixa por regra fixa, porque a modelo está em posição
 *         diferente em cada foto. Então o recorte é por SALIÊNCIA
 *         (`sharp.strategy.attention`), que persegue a região de maior contraste
 *         — na prática, o rosto e o tronco. ⚠️ É automático: as saídas TÊM que
 *         ser olhadas numa folha de contato antes de subir.
 *
 * ── A ESCOLHA DAS PEÇAS ──
 * Recentes (`site_produto.publicado_em`), com saldo na rede e resolução
 * suficiente — ver `diag-fotos-verticais-recentes.js`, que explica cada filtro.
 * Uma REF por peça: 8 fotos da mesma modelo com 8 cores da mesma blusa não é
 * variedade, é repetição — e é variedade que o Google mede.
 *
 *   railway run --service Postgres node backend/scripts/google-ads-fotos-verticais.js
 *   $env:QUANTAS="14"; railway run --service Postgres node backend/scripts/google-ads-fotos-verticais.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const sharp = require('sharp');

const QUANTAS = Number(process.env.QUANTAS || 10);
const SALDO_MINIMO = 5;
const DESTINO = process.env.DESTINO || path.join(os.tmpdir(), 'google-ads-fotos');

/**
 * Os dois formatos que faltam. `campo` é o field_type do Google e vai no
 * manifesto — quem sobe não adivinha o formato pelo nome do arquivo.
 */
const FORMATOS = [
  { campo: 'PORTRAIT_MARKETING_IMAGE', apelido: '4x5', largura: 1200, altura: 1500 },
  { campo: 'MARKETING_IMAGE', apelido: '191x1', largura: 1200, altura: 628 },
];

/**
 * REF que NÃO vira 1.91:1, olhada na folha de contato de 13/09. O 4:5 delas
 * continua bom — o problema é só o que sobra quando a faixa aperta:
 *
 *   10144, 3153 — foto de espelho, com o celular na mão. No 4:5 o look inteiro
 *                 aparece e isso passa; na faixa estreita sobra rosto + celular,
 *                 e a peça (que é o que se está anunciando) some.
 *   1320        — a faixa dá um belo retrato, e só. Nenhuma peça à vista:
 *                 vira anúncio de nada.
 *
 * Sem lista automática de propósito: "a peça aparece?" é julgamento, não conta.
 * Quem rodar de novo com fotos novas tem que OLHAR a folha e reeditar isto.
 */
const SEM_191 = new Set(['10144', '3153', '1320']);

/** Largura que sobra depois do corte 4:5 — abaixo de 960 o Google recebe foto mole. */
const larguraUtil = (w, h) => (!w || !h ? 0 : w / h > 0.8 ? Math.round(h * 0.8) : w);

/**
 * Corte 4:5 por REGRA (a modelo está centrada na largura e o rosto no alto).
 * Aqui a regra é confiável porque o corte é pequeno.
 */
async function cortar45(buf, largura, altura) {
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
    .resize(largura, altura, { fit: 'fill' })
    .flatten({ background: '#ffffff' }) // PNG com alfa vira fundo preto no Google
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/**
 * Corte 1.91:1 — FAIXA DO ALTO, a partir do 4:5 já pronto.
 *
 * 🚨 A primeira versão usava `sharp.strategy.attention` (saliência). PAROU DE
 * SER USADA depois de olhar a folha de contato de 13/09: em 3 de 10 fotos a
 * saliência foi para o TRONCO e cortou o rosto fora — duas viraram close de
 * busto, que não sobe em anúncio nenhum. Saliência persegue contraste, e numa
 * foto de moda o maior contraste costuma ser a estampa da roupa, não a cara
 * de quem a veste.
 *
 * A regra que funciona é geométrica e chata: a modelo está SEMPRE em pé ou
 * sentada de frente, com o rosto no alto do quadro. Então a faixa começa a 6%
 * da altura (tira o excesso de céu/teto sem encostar no cabelo) e desce os
 * 42% que o 1.91:1 ocupa — sobra rosto e tronco, que é o enquadramento de
 * anúncio de moda.
 *
 * Entra o 4:5 já cortado, não o original: assim a geometria é a mesma pra toda
 * foto, independente do que o ensaio entregou.
 */
const RECUO_DO_TOPO = 0.06;

async function cortar191(buf45, largura, altura) {
  const m = await sharp(buf45).metadata();
  const faixa = Math.round(m.width / (largura / altura));
  const topo = Math.min(Math.round(m.height * RECUO_DO_TOPO), Math.max(0, m.height - faixa));
  return sharp(buf45)
    .extract({ left: 0, top: topo, width: m.width, height: Math.min(faixa, m.height - topo) })
    .resize(largura, altura, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
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
    const original = Buffer.from(await resp.arrayBuffer());
    const limpo = String(r.ref).replace(/[^A-Za-z0-9_-]/g, '');
    const linha = [];

    /* O 4:5 é a base do 1.91:1 — corta uma vez e reaproveita. */
    const base45 = await cortar45(original, FORMATOS[0].largura, FORMATOS[0].altura);

    for (const f of FORMATOS) {
      if (f.campo === 'MARKETING_IMAGE' && SEM_191.has(String(r.ref))) {
        linha.push('191x1 PULADO (peça não aparece na faixa)');
        continue;
      }
      const buf = f.campo === 'MARKETING_IMAGE'
        ? await cortar191(base45, f.largura, f.altura)
        : base45;
      const arquivo = `${f.apelido}-${limpo}.jpg`;
      fs.writeFileSync(path.join(DESTINO, arquivo), buf);
      /* O NOME é a chave de idempotência lá no Google: quem sobe não recria um
       * ativo que já exista com este nome. Por isso carrega formato, REF e data. */
      manifesto.push({
        arquivo,
        campo: f.campo,
        nome: `Lurds ${f.apelido} ${r.ref} ${String(r.entrou).slice(0, 10)}`,
        ref: r.ref,
        peca: r.nome,
        categoria: r.categoria || '?',
        entrou: String(r.entrou).slice(0, 10),
        origem: r.url,
        kb: Math.round(buf.length / 1024),
      });
      linha.push(`${f.apelido} ${Math.round(buf.length / 1024)}KB`);
    }
    console.log(`  ✔ ${String(r.ref).padEnd(9)} ${String(r.categoria || '?').padEnd(11)} ${r.w}x${r.h} → ${linha.join(' · ')} · ${String(r.nome).slice(0, 34)}`);
  }

  fs.writeFileSync(path.join(DESTINO, 'manifesto.json'), JSON.stringify(manifesto, null, 2));
  const porCampo = {};
  for (const m of manifesto) porCampo[m.campo] = (porCampo[m.campo] || 0) + 1;
  console.log(`\n${manifesto.length} imagens em ${DESTINO}`, porCampo);
  console.log('⚠️  OLHE a folha de contato antes de subir — o corte 1.91:1 é automático.');
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
