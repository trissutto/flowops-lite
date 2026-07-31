/**
 * VOCABULÁRIO DA CLIENTE — dicionário pt-BR de sinônimos e atributos.
 *
 * A cliente plus size NÃO digita o nome da categoria do ERP. Ela digita
 * "vestido pra casamento", "roupa que esconde a barriga", "moda evangélica".
 * Este arquivo é a tradução desse vocabulário real pra facetas do catálogo.
 *
 * É DADO, não código: sinônimo novo = uma linha num array. Nenhum `if` aqui.
 * Quem consome é o interpretador de intenção (`intent.ts`) — e, no futuro,
 * este mesmo dicionário vira contexto do prompt da IA (ver docs/ai-search.md).
 *
 * Convenção: variantes já escritas NORMALIZADAS (minúsculo, sem acento),
 * do jeito que saem da `normalize()` de `@/lib/utils`. O interpretador
 * normaliza de novo por segurança, mas escrever certo aqui evita surpresa.
 */

/* ------------------------------------------------------------------ TIPOS */

/** Um valor canônico de faceta + todas as formas como a cliente fala dele. */
export interface SynonymGroup {
  /** Valor canônico — o slug/termo que o catálogo entende. */
  canonical: string;
  /** Rótulo humano usado no label da intenção ("vestidos para casamento"). */
  label: string;
  /** Variantes normalizadas. Frases multi-palavra são permitidas. */
  variants: string[];
}

/**
 * Regra de atributo de caimento — o coração da busca.
 * "Esconder barriga" não é categoria nem tecido: é um DESEJO que se traduz
 * em vários sinais do produto (modelagem, tecido, corte). A regra carrega
 * essa tradução; o motor pontua produto que casa com QUALQUER atributo.
 */
export interface AttributeRule {
  id: string;
  /** Frases (normalizadas) que disparam a regra. */
  triggers: string[];
  /**
   * O que procurar no produto: valores comparados contra modelagem, tecido
   * e o texto agregado do doc. Semântica OU — um match já pontua.
   */
  attributes: string[];
  /** Ocasião implícita ("moda evangélica" → igreja). */
  occasion?: string;
  /** Pedaço do label humano ("que disfarçam a barriga"). */
  label: string;
}

/* ------------------------------------------------------------- CATEGORIAS */

export const CATEGORY_SYNONYMS: SynonymGroup[] = [
  { canonical: 'vestidos', label: 'vestidos', variants: ['vestido', 'vestidos', 'vestidinho', 'vestidao'] },
  {
    canonical: 'blusas',
    label: 'blusas',
    variants: ['blusa', 'blusas', 'blusinha', 'bata', 'batas', 'tunica', 'tunicas', 'camisa', 'camiseta', 't-shirt'],
  },
  {
    canonical: 'calcas',
    label: 'calças',
    variants: ['calca', 'calcas', 'pantalona', 'pantalonas', 'legging', 'leggings', 'flare', 'skinny', 'wide leg'],
  },
  { canonical: 'conjuntos', label: 'conjuntos', variants: ['conjunto', 'conjuntos', 'conjuntinho', 'twin set'] },
  {
    canonical: 'macacoes',
    label: 'macacões',
    variants: ['macacao', 'macacoes', 'macaquinho', 'macaquinhos', 'jardineira'],
  },
  {
    canonical: 'jaquetas',
    label: 'jaquetas e casacos',
    variants: ['jaqueta', 'jaquetas', 'casaco', 'casacos', 'blazer', 'cardigan', 'kimono', 'colete', 'parka'],
  },
  { canonical: 'saias', label: 'saias', variants: ['saia', 'saias'] },
  { canonical: 'shorts', label: 'shorts', variants: ['short', 'shorts', 'bermuda', 'bermudas'] },
  {
    // "praia" sozinha fica com a OCASIÃO praia — aqui só termos que são
    // inequivocamente a peça (senão "look praia" viraria categoria).
    canonical: 'moda-praia',
    label: 'moda praia',
    variants: ['moda praia', 'biquini', 'maio', 'saida de praia', 'canga'],
  },
  { canonical: 'fitness', label: 'fitness', variants: ['fitness', 'academia', 'treino', 'top fitness'] },
];

/* --------------------------------------------------------------- OCASIÕES */

export const OCCASION_SYNONYMS: SynonymGroup[] = [
  {
    canonical: 'casamento',
    label: 'casamento',
    variants: ['casamento', 'casorio', 'madrinha', 'convidada', 'batizado', 'noivado', 'cerimonia', 'civil'],
  },
  {
    // "evangelica" fica na regra de atributo (traz comprimento + manga junto).
    canonical: 'igreja',
    label: 'igreja e culto',
    variants: ['igreja', 'culto', 'missa'],
  },
  {
    canonical: 'trabalho',
    label: 'trabalho',
    variants: ['trabalho', 'trabalhar', 'escritorio', 'entrevista', 'reuniao', 'executiva', 'executivo'],
  },
  {
    canonical: 'festa',
    label: 'festa',
    variants: ['festa', 'festas', 'formatura', 'aniversario', 'jantar', 'balada', 'evento', 'eventos'],
  },
  {
    canonical: 'viagem',
    label: 'viagem',
    variants: ['viagem', 'viajar', 'passeio', 'passear', 'ferias'],
  },
  { canonical: 'praia', label: 'praia', variants: ['praia', 'piscina'] },
  { canonical: 'dia-a-dia', label: 'dia a dia', variants: ['dia a dia', 'casual', 'todo dia'] },
];

/* ---------------------------------------------------------------- TECIDOS */

export const FABRIC_SYNONYMS: SynonymGroup[] = [
  {
    canonical: 'viscolycra',
    label: 'viscolycra',
    variants: ['viscolycra', 'visco', 'viscolicra', 'viscose com elastano'],
  },
  { canonical: 'linho', label: 'linho', variants: ['linho'] },
  { canonical: 'crepe', label: 'crepe', variants: ['crepe'] },
  { canonical: 'malha', label: 'malha', variants: ['malha', 'malha fria', 'meia malha'] },
  { canonical: 'jeans', label: 'jeans', variants: ['jeans', 'denim'] },
  { canonical: 'tricot', label: 'tricot', variants: ['tricot', 'trico'] },
  { canonical: 'alfaiataria', label: 'alfaiataria', variants: ['alfaiataria', 'social'] },
];

/* ------------------------------------------------------------------ CORES */

export const COLOR_SYNONYMS: SynonymGroup[] = [
  { canonical: 'preto', label: 'preto', variants: ['preto', 'preta', 'pretinho', 'pretinho basico'] },
  { canonical: 'branco', label: 'branco', variants: ['branco', 'branca', 'branquinho'] },
  { canonical: 'off white', label: 'off white', variants: ['off white', 'offwhite', 'cru'] },
  { canonical: 'bege', label: 'bege', variants: ['bege', 'areia', 'cor de areia'] },
  { canonical: 'nude', label: 'nude', variants: ['nude'] },
  { canonical: 'vermelho', label: 'vermelho', variants: ['vermelho', 'vermelha'] },
  { canonical: 'vinho', label: 'vinho', variants: ['vinho', 'marsala', 'bordo'] },
  { canonical: 'rosa', label: 'rosa', variants: ['rosa', 'pink', 'rose'] },
  { canonical: 'azul marinho', label: 'azul marinho', variants: ['azul marinho', 'marinho'] },
  { canonical: 'azul', label: 'azul', variants: ['azul'] },
  { canonical: 'verde', label: 'verde', variants: ['verde', 'verde militar', 'esmeralda'] },
  { canonical: 'amarelo', label: 'amarelo', variants: ['amarelo', 'amarela', 'mostarda'] },
  { canonical: 'laranja', label: 'laranja', variants: ['laranja', 'terracota'] },
  { canonical: 'roxo', label: 'roxo', variants: ['roxo', 'roxa', 'uva'] },
  { canonical: 'lilas', label: 'lilás', variants: ['lilas', 'lavanda'] },
  { canonical: 'marrom', label: 'marrom', variants: ['marrom', 'chocolate', 'caramelo'] },
  { canonical: 'cinza', label: 'cinza', variants: ['cinza', 'grafite', 'chumbo'] },
  { canonical: 'dourado', label: 'dourado', variants: ['dourado', 'dourada'] },
  { canonical: 'estampado', label: 'estampado', variants: ['estampado', 'estampada', 'estampa', 'floral', 'poa'] },
];

/* -------------------------------------------------------------- MODELAGEM */

export const FIT_SYNONYMS: SynonymGroup[] = [
  { canonical: 'soltinho', label: 'soltinha', variants: ['soltinho', 'soltinha', 'solto', 'solta', 'amplo', 'ampla', 'oversized'] },
  { canonical: 'evase', label: 'evasê', variants: ['evase', 'gode', 'rodado', 'rodada'] },
  {
    canonical: 'acinturado',
    label: 'acinturada',
    variants: ['acinturado', 'acinturada', 'marca cintura', 'valoriza a cintura', 'com cintura marcada'],
  },
  { canonical: 'reto', label: 'reta', variants: ['reto', 'reta'] },
  { canonical: 'midi', label: 'midi', variants: ['midi'] },
  { canonical: 'longo', label: 'longa', variants: ['longo', 'longa', 'longuete'] },
  { canonical: 'curto', label: 'curta', variants: ['curto', 'curta'] },
];

/* --------------------------------------------- ATRIBUTOS DE CAIMENTO (OURO) */

/**
 * O que faz a busca da Lurds ser diferente de um e-commerce genérico:
 * a cliente descreve o EFEITO que quer no corpo, e a gente traduz.
 * Cada regra foi validada com o vocabulário real do balcão das lojas.
 */
export const ATTRIBUTE_RULES: AttributeRule[] = [
  {
    id: 'esconder-barriga',
    triggers: [
      'esconder barriga',
      'esconder a barriga',
      'esconde barriga',
      'esconde a barriga',
      'disfarca barriga',
      'disfarca a barriga',
      'disfarcar barriga',
      'disfarcar a barriga',
      'barriga',
    ],
    // Soltinho/evasê escondem por amplitude; acinturado com TECIDO PLANO
    // (crepe, alfaiataria) estrutura sem marcar — malha fininha marca.
    attributes: ['soltinho', 'evase', 'acinturado', 'crepe', 'alfaiataria', 'tecido plano', 'disfarca barriga'],
    label: 'que disfarçam a barriga',
  },
  {
    id: 'confortavel',
    triggers: ['confortavel', 'confortaveis', 'conforto', 'nao aperta', 'que nao aperta', 'com elastano', 'elastico'],
    // Conforto = tecido com queda e elasticidade, nunca corte apertado.
    attributes: ['malha', 'viscolycra', 'alfaiataria elastica', 'conforto', 'soltinho'],
    label: 'confortáveis',
  },
  {
    id: 'elegante',
    triggers: ['elegante', 'elegantes', 'chique', 'chic', 'sofisticada', 'sofisticado', 'fina', 'requintada'],
    // Elegância na Lurds = estrutura: alfaiataria e crepe seguram a produção.
    attributes: ['alfaiataria', 'crepe', 'elegante'],
    label: 'elegantes',
  },
  {
    id: 'moderna',
    triggers: ['moderna', 'moderno', 'modernas', 'estilosa', 'estiloso', 'fashion', 'na moda', 'tendencia'],
    attributes: ['moderna', 'tendencia', 'oversized', 'wide leg'],
    label: 'modernas',
  },
  {
    id: 'moda-evangelica',
    triggers: ['moda evangelica', 'evangelica', 'evangelico', 'roupa evangelica'],
    // Comprimento midi/longo + manga — e a ocasião igreja vem junto.
    attributes: ['midi', 'longo', 'manga', 'comprimento midi'],
    occasion: 'igreja',
    label: 'moda evangélica',
  },
  {
    id: 'alongar-silhueta',
    triggers: ['alongar silhueta', 'alonga silhueta', 'alonga a silhueta', 'parecer mais alta', 'alongar'],
    attributes: ['longo', 'pantalona', 'monocromatico', 'alonga silhueta'],
    label: 'que alongam a silhueta',
  },
];

/* ------------------------------------------------------------------ RUÍDO */

/**
 * Palavras que carregam intenção mas não viram faceta nem termo de busca:
 * "quero roupa pra…" — o que importa vem depois. Removidas ANTES de calcular
 * o residual, senão toda frase natural viraria busca por "roupa".
 */
export const NOISE_WORDS: string[] = [
  'roupa', 'roupas', 'look', 'looks', 'moda', 'peca', 'pecas',
  'quero', 'queria', 'procuro', 'procurando', 'preciso', 'buscar', 'busco',
  'algo', 'alguma', 'algum', 'coisa',
  'um', 'uma', 'uns', 'umas', 'o', 'a', 'os', 'as',
  'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
  'para', 'pra', 'pro', 'com', 'sem', 'que', 'e', 'ou', 'me', 'meu', 'minha',
];

/* ------------------------------------------------------------- VOCABULÁRIO */

/**
 * Lista plana de termos "bons" do vocabulário — alimenta as sugestões do
 * zero-results ("você quis dizer…"). Canônicos primeiro, mais buscados no topo.
 */
export const SEARCH_VOCABULARY: string[] = [
  ...CATEGORY_SYNONYMS.map((g) => g.label),
  ...OCCASION_SYNONYMS.map((g) => g.label),
  ...FABRIC_SYNONYMS.map((g) => g.label),
  ...FIT_SYNONYMS.map((g) => g.canonical),
  ...COLOR_SYNONYMS.map((g) => g.canonical),
];

/**
 * Sugestões de último recurso quando nem o fuzzy encontra termo parecido —
 * espelham as buscas mais frequentes (ver `popularSearches` em data/navigation).
 */
export const FALLBACK_SUGGESTIONS: string[] = [
  'vestido preto',
  'vestido casamento',
  'look trabalho',
  'conjunto viscolycra',
];
