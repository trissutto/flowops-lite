/**
 * CLASSIFICAÇÃO EM MASSA — a árvore da vitrine resolvida pelo NOME da peça.
 *
 * Blusas, vestidos e macacões pelo tipo de MANGA (curta, longa, 3/4, sem
 * manga); moda praia pelo TIPO (biquíni, maiô, saída de praia). Pedido do dono
 * em 10/08/2026, depois de 345 peças publicadas ficarem fora de todo menu.
 *
 *   # conferir (não grava nada)
 *   railway run --service Postgres node backend/scripts/classificar-em-massa.js
 *   # gravar
 *   railway run --service Postgres node backend/scripts/classificar-em-massa.js --aplicar
 *
 * Roda em seco por padrão. `--aplicar` grava e SEMPRE salva o estado anterior
 * de cada REF tocada em `backup-antes.json` ANTES de escrever — desfazer vira
 * um UPDATE, não uma arqueologia.
 *
 * ── O QUE ELE NUNCA FAZ ──
 *
 * Não inventa família: peça sem categoria cujo nome não diz o que é fica sem
 * categoria (95 hoje — calça, shorts, jaqueta, blazer). Não rouba peça de
 * outra categoria, com UMA exceção autorizada pelo dono: biquíni/maiô/saída de
 * praia vão pra Moda praia venham de onde vierem. E não mexe em conjunto,
 * pijama, camisola, lingerie nem modelador — "Conjunto Blusa Manga Curta +
 * Calça" tem a palavra blusa sem ser uma.
 *
 * Conecta pelo DATABASE_PUBLIC_URL: o DATABASE_URL do serviço aponta pro host
 * interno da Railway, que não resolve de fora.
 */
const { Client } = require('pg');
const fs = require('fs');

const APLICAR = process.argv.includes('--aplicar');

const norm = (v) =>
  String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\s+/g, ' ').trim();

/** Peça que não é blusa/vestido/macacão por mais que o nome pareça. */
const NAO_MEXER = [
  'conjunto', 'twin set', 'twinset', 'cinta', 'modelador', 'pijama', 'camisola',
  'sutia', 'calcinha', 'lingerie', 'kit ', 'body ',
];

/**
 * Família → categoria. A ORDEM decide o empate.
 *
 * Praia vem primeiro: "Saída de Praia com Manga" é moda praia, não blusa, e
 * "Maiô" não pode cair em nenhuma das outras. Macacão antes de blusa pelo
 * mesmo motivo.
 */
const FAMILIAS = [
  { categoria: 'moda-praia', termos: ['biquini', 'saida de praia', 'sunquini', /\bmaio\b/] },
  { categoria: 'macacoes', termos: ['macacao', 'macaquinho', 'jardineira'] },
  { categoria: 'vestidos', termos: ['vestido'] },
  { categoria: 'blusas', termos: ['blusa', 't-shirt', 'tshirt', 't shirt', 'camiseta', 'camisa', 'cropped', 'regata', 'bata'] },
];

/**
 * MODA PRAIA divide por TIPO DE PEÇA, não por manga — as subcategorias já
 * existiam no banco com estes slugs (o dono criou), só não tinha peça apontando
 * pra elas.
 *
 * `\bmaio\b` com borda de palavra: sem isso "maio" casaria dentro de "maior".
 */
const PRAIA = [
  { slug: 'saida-de-praia', nome: 'Saída de Praia', termos: ['saida de praia', 'saida praia'] },
  { slug: 'biquini', nome: 'Biquini', termos: ['biquini', 'sunquini'] },
  { slug: 'maio', nome: 'Maiô', termos: [/\bmaio\b/] },
];

/**
 * Manga. Ordem importa: "3/4" antes de "manga", e "sem manga" antes de tudo
 * que tenha a palavra manga.
 */
const MANGAS = [
  { chave: 'sem-manga', termos: ['sem manga', 'regata', 'alcinha', 'alca larga', 'alcas larga', 'tomara que caia', 'tomara q caia', 'frente unica', 'cavada'] },
  { chave: 'manga-3-4', termos: ['manga 3/4', 'manga 3 4', '3/4'] },
  { chave: 'manga-longa', termos: ['manga longa', 'manga comprida'] },
  { chave: 'manga-curta', termos: ['manga curta'] },
];

/**
 * Slug da subcategoria POR FAMÍLIA.
 *
 * `site_categorias.slug` é único e `pai_slug` é uma coluna só: o mesmo slug
 * não pode pendurar em dois pais. Então "Manga curta" de Vestidos precisa de
 * slug próprio. O NOME (o que a cliente lê no chip) continua igual.
 */
const SUB = {
  blusas: {
    'manga-curta': { slug: 'manga-curta', nome: 'Manga curta' },
    'manga-longa': { slug: 'manga-longa', nome: 'Manga longa' },
    'manga-3-4': { slug: 'manga-3-4', nome: 'Manga 3/4' },
    'sem-manga': { slug: 'regata', nome: 'Regata' },
  },
  vestidos: {
    'manga-curta': { slug: 'vestido-manga-curta', nome: 'Manga curta' },
    'manga-longa': { slug: 'vestido-manga-longa', nome: 'Manga longa' },
    'manga-3-4': { slug: 'vestido-manga-3-4', nome: 'Manga 3/4' },
    'sem-manga': { slug: 'vestido-sem-manga', nome: 'Sem manga' },
  },
  macacoes: {
    'manga-curta': { slug: 'macacao-manga-curta', nome: 'Manga curta' },
    'manga-longa': { slug: 'macacao-manga-longa', nome: 'Manga longa' },
    'manga-3-4': { slug: 'macacao-manga-3-4', nome: 'Manga 3/4' },
    'sem-manga': { slug: 'macacao-sem-manga', nome: 'Sem manga' },
  },
};

const ALVOS = ['blusas', 'vestidos', 'macacoes', 'moda-praia'];

/** Termo pode ser texto (substring) ou regex (borda de palavra). */
const casa = (n, termos) => termos.some((t) => (t instanceof RegExp ? t.test(n) : n.includes(t)));

function decidir(p) {
  const n = norm(p.nome);
  if (NAO_MEXER.some((t) => n.includes(t))) return { pular: 'nao-mexer' };

  /**
   * Categoria já escolhida por gente fica: quem classificou sabia mais que o
   * nome. Só resolvo pelo nome quem está SEM categoria — e nunca puxo peça de
   * outra categoria (uma "jaqueta" não vira blusa porque o nome tem manga).
   */
  let categoria = p.categoria;
  if (!categoria) {
    const fam = FAMILIAS.find((f) => casa(n, f.termos));
    if (!fam) return { pular: 'familia-desconhecida' };
    categoria = fam.categoria;
  } else if (categoria !== 'moda-praia' && casa(n, FAMILIAS[0].termos)) {
    /**
     * Biquíni/maiô/saída de praia MUDAM de categoria mesmo já tendo uma: é o
     * pedido explícito do dono ("tudo o que for biquíni, maiô, saída de praia
     * deve entrar como Moda praia"). Nas outras famílias eu não puxo peça de
     * categoria alheia — só praia tem essa autorização.
     */
    categoria = 'moda-praia';
  }
  if (!ALVOS.includes(categoria)) return { pular: 'fora-do-escopo' };

  if (categoria === 'moda-praia') {
    const tipo = PRAIA.find((t) => casa(n, t.termos));
    if (!tipo) return { categoria, sub: null, pular: 'praia-indefinida' };
    return { categoria, sub: tipo };
  }

  const manga = MANGAS.find((m) => casa(n, m.termos));
  if (!manga) return { categoria, sub: null, pular: 'manga-indefinida' };

  return { categoria, sub: SUB[categoria][manga.chave] };
}

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const { rows } = await c.query(
    `SELECT ref, nome, categoria, subcategoria FROM site_produto WHERE publicado = true ORDER BY nome`,
  );

  const mudancas = [];
  const pulos = {};
  const semManga = [];
  for (const p of rows) {
    const d = decidir(p);
    if (d.pular && !d.sub) {
      pulos[d.pular] = (pulos[d.pular] || 0) + 1;
      if (d.pular === 'manga-indefinida' || d.pular === 'praia-indefinida') semManga.push(`${p.ref} | ${p.nome} | ${d.categoria}`);
      // Sem manga reconhecida ainda vale gravar a CATEGORIA de quem não tinha.
      if (d.categoria && !p.categoria) mudancas.push({ ...p, categoria: d.categoria, sub: null });
      continue;
    }
    if (p.categoria === d.categoria && p.subcategoria === d.sub.slug) continue;
    mudancas.push({ ...p, categoria: d.categoria, sub: d.sub.slug });
  }

  const porDestino = {};
  for (const m of mudancas) {
    const k = `${m.categoria} > ${m.sub || '(só categoria)'}`;
    porDestino[k] = (porDestino[k] || 0) + 1;
  }

  console.log('publicadas:', rows.length, '| vão mudar:', mudancas.length);
  console.log('\n--- destino ---');
  Object.entries(porDestino).sort().forEach(([k, v]) => console.log(String(v).padStart(4), k));
  console.log('\n--- não classificadas ---');
  Object.entries(pulos).sort().forEach(([k, v]) => console.log(String(v).padStart(4), k));

  console.log('\n--- amostra (20 primeiras mudanças) ---');
  mudancas.slice(0, 20).forEach((m) => console.log(`  ${m.nome}  →  ${m.categoria} / ${m.sub || '-'}`));

  fs.writeFileSync(__dirname + '/mudancas.json', JSON.stringify(mudancas, null, 0));
  fs.writeFileSync(__dirname + '/sem-manga.txt', semManga.join('\n'));
  console.log(`\n(${semManga.length} peças da família certa mas sem manga reconhecível no nome — lista em sem-manga.txt)`);

  if (!APLICAR) {
    console.log('\n*** SECO — nada foi gravado. Rode com --aplicar ***');
    await c.end();
    return;
  }

  // BACKUP antes de tocar em qualquer linha: com ele, desfazer é um UPDATE.
  fs.writeFileSync(
    __dirname + '/backup-antes.json',
    JSON.stringify(rows.filter((r) => mudancas.some((m) => m.ref === r.ref)), null, 0),
  );

  // As subcategorias precisam existir antes das peças apontarem pra elas.
  const aCriar = Object.entries(SUB).map(([cat, mapa]) => [cat, Object.values(mapa)]);
  aCriar.push(['moda-praia', PRAIA]);
  for (const [categoria, lista] of aCriar) {
    for (const { slug, nome } of lista) {
      await c.query(
        /**
         * `id` e `updated_at` são preenchidos pelo PRISMA na aplicação
         * (`@default(uuid())` e `@updatedAt`), não pelo banco — conferido no
         * information_schema: são as únicas colunas NOT NULL sem default, ao
         * lado do slug. SQL cru precisa fornecer os dois, senão o INSERT morre
         * com "null value in column ... violates not-null constraint".
         */
        `INSERT INTO site_categorias (id, slug, nome, pai_slug, ativo, ordem, atualizado_por, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, true, 0, 'classificacao-em-massa', NOW())
         ON CONFLICT (slug) DO UPDATE
            SET nome = EXCLUDED.nome, pai_slug = EXCLUDED.pai_slug, updated_at = NOW()`,
        [slug, nome, categoria],
      );
    }
  }

  let n = 0;
  for (const m of mudancas) {
    await c.query(
      // `updated_at` também é do Prisma (@updatedAt): num UPDATE cru ele não se
      // move sozinho, e a linha ficaria dizendo que não foi tocada hoje.
      `UPDATE site_produto
          SET categoria = $2, subcategoria = COALESCE($3, subcategoria),
              classificado_por = 'classificacao-em-massa', classificado_em = NOW(),
              updated_at = NOW()
        WHERE ref = $1`,
      [m.ref, m.categoria, m.sub],
    );
    n++;
  }
  console.log(`\n*** GRAVADAS ${n} peças. Backup em backup-antes.json ***`);

  await c.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
