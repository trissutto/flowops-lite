/**
 * CLASSIFICAÇÃO PELO NOME — as regras de 10/08 (decisão do dono) como módulo.
 *
 * São AS MESMAS regras do `backend/scripts/classificar-em-massa.js`, que rodou
 * em lote e classificou 345 peças. O lote resolve o passado; este módulo
 * resolve o FUTURO: peça nova nascida no sistema (caso 407012, 13/08) chegava
 * publicada mas com categoria nula — visível na PDP e invisível em TODO menu.
 *
 * A vitrine usa como FALLBACK DE LEITURA: só quando o cadastro não disse a
 * categoria. Não grava nada — quem grava continua sendo a retaguarda (e a
 * escolha humana sempre vence esta heurística).
 *
 * ⚠️ Mexeu numa regra aqui, mexa no script também (e vice-versa) — são o
 * mesmo contrato em dois tempos: lote e leitura.
 */

export interface ClassificacaoDerivada {
  categoria: string;
  /** Slug em `site_categorias` (ex.: 'manga-longa') — null quando o nome não diz. */
  subcategoria: string | null;
}

const norm = (v: string) =>
  String(v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Peça que não é blusa/vestido/macacão por mais que o nome pareça. */
const NAO_MEXER = [
  'conjunto', 'twin set', 'twinset', 'cinta', 'modelador', 'pijama', 'camisola',
  'sutia', 'calcinha', 'lingerie', 'kit ', 'body ',
];

/**
 * Família → categoria. A ORDEM decide o empate: praia antes de tudo ("Saída
 * de Praia com Manga" é praia, não blusa), macacão antes de blusa.
 */
const FAMILIAS: Array<{ categoria: string; termos: Array<string | RegExp> }> = [
  { categoria: 'moda-praia', termos: ['biquini', 'saida de praia', 'sunquini', /\bmaio\b/] },
  { categoria: 'macacoes', termos: ['macacao', 'macaquinho', 'jardineira'] },
  { categoria: 'vestidos', termos: ['vestido'] },
  { categoria: 'blusas', termos: ['blusa', 't-shirt', 'tshirt', 't shirt', 'camiseta', 'camisa', 'cropped', 'regata', 'bata'] },
];

/** MODA PRAIA divide por TIPO DE PEÇA; ordem do array é precedência de casamento. */
const PRAIA: Array<{ slug: string; termos: Array<string | RegExp> }> = [
  { slug: 'saida-de-praia', termos: ['saida de praia', 'saida praia'] },
  { slug: 'biquini', termos: ['biquini', 'sunquini'] },
  { slug: 'maio', termos: [/\bmaio\b/] },
];

/** Manga. Ordem importa: "sem manga" e "3/4" antes de "manga longa/curta". */
const MANGAS: Array<{ chave: string; termos: Array<string | RegExp> }> = [
  { chave: 'sem-manga', termos: ['sem manga', 'regata', 'alcinha', 'alca larga', 'alcas larga', 'tomara que caia', 'tomara q caia', 'frente unica', 'cavada'] },
  { chave: 'manga-3-4', termos: ['manga 3/4', 'manga 3 4', '3/4'] },
  { chave: 'manga-longa', termos: ['manga longa', 'manga comprida'] },
  { chave: 'manga-curta', termos: ['manga curta'] },
];

/**
 * Slug da subcategoria POR FAMÍLIA — `site_categorias.slug` é único, então
 * "Manga curta" de Vestidos tem slug próprio. Os slugs já existem no banco
 * (criados pelo lote de 10/08).
 */
const SUB: Record<string, Record<string, string>> = {
  blusas: {
    'manga-curta': 'manga-curta',
    'sem-manga': 'regata',
    'manga-longa': 'manga-longa',
    'manga-3-4': 'manga-3-4',
  },
  vestidos: {
    'manga-curta': 'vestido-manga-curta',
    'sem-manga': 'vestido-sem-manga',
    'manga-longa': 'vestido-manga-longa',
    'manga-3-4': 'vestido-manga-3-4',
  },
  macacoes: {
    'manga-curta': 'macacao-manga-curta',
    'sem-manga': 'macacao-sem-manga',
    'manga-longa': 'macacao-manga-longa',
    'manga-3-4': 'macacao-manga-3-4',
  },
};

const casa = (n: string, termos: Array<string | RegExp>) =>
  termos.some((t) => (t instanceof RegExp ? t.test(n) : n.includes(t)));

/**
 * Nome → categoria/subcategoria, ou null quando o nome não diz o que a peça
 * é (calça, saia, jaqueta… ficam pra retaguarda — "não inventa família").
 */
export function classificarPorNome(nome: string): ClassificacaoDerivada | null {
  const n = norm(nome);
  if (!n) return null;
  if (NAO_MEXER.some((t) => n.includes(t))) return null;

  const fam = FAMILIAS.find((f) => casa(n, f.termos));
  if (!fam) return null;

  if (fam.categoria === 'moda-praia') {
    const tipo = PRAIA.find((t) => casa(n, t.termos));
    return { categoria: 'moda-praia', subcategoria: tipo?.slug ?? null };
  }

  const manga = MANGAS.find((m) => casa(n, m.termos));
  return {
    categoria: fam.categoria,
    subcategoria: manga ? SUB[fam.categoria][manga.chave] : null,
  };
}
