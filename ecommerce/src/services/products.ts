import { normalize } from '@/lib/utils';
import { nomeComReferencia, ofertaProduto } from '@/lib/commerce/product-presentation';
import type { FilterGroup, FilterState, Paginated, Product, ProductQuery, SortOption } from '@/types';

/**
 * SERVIÇO DE CATÁLOGO — dados REAIS do ERP (sprint 008).
 *
 * Fim dos mocks: `fetchProducts` fala com `/api/loja/produtos` (BFF), que
 * fala com o backend, que monta a peça a partir do espelho do ERP (preço,
 * grade, estoque), do cadastro do Flow (nome, descrição, SEO) e das fotos
 * do R2. A assinatura não mudou — nenhuma tela precisou ser reescrita.
 *
 * Filtro/ordenação/paginação agora acontecem NO SERVIDOR: com catálogo real
 * (milhares de SKUs) filtrar no navegador seria baixar tudo a cada clique.
 */

/** Cor → hex pro swatch. O ERP guarda o NOME da cor, não o código. */
const HEX_POR_COR: Record<string, string> = {
  preto: '#1a1614', branco: '#f7f5f2', 'off white': '#f1eadf', bege: '#d9cdb4',
  areia: '#d9cdb4', nude: '#e0c9b8', marrom: '#6b4f3a', caramelo: '#a9713f',
  vermelho: '#9b2c2c', vinho: '#7a3b46', rosa: '#d9a1ad', pink: '#c2185b',
  laranja: '#c7622c', amarelo: '#d4a017', verde: '#4f7355', 'verde militar': '#4a5340',
  azul: '#2f5573', 'azul marinho': '#1f3350', jeans: '#3f5c78', roxo: '#5c4a72',
  lilas: '#a898c4', cinza: '#8a8079', prata: '#b9b6b0', dourado: '#b8912b',
  estampado: '#c9bda8', floral: '#c9bda8',
};

export function hexDaCor(nome: string): string {
  const chave = normalize(nome);
  if (HEX_POR_COR[chave]) return HEX_POR_COR[chave];
  const parcial = Object.keys(HEX_POR_COR).find((k) => chave.includes(k));
  return parcial ? HEX_POR_COR[parcial] : '#c9bda8';
}

/**
 * O NOME DA COR QUE A CLIENTE LÊ — com guarda contra cadastro poluído.
 *
 * Na estreia da grade de cores (20/08) a BMM-100 mostrou "Cor escolhida:
 * BLUSA MANGA CURTA CONFORTO BMM-100 MANTEIGA": o `nomeAmigavel` daquela cor
 * veio com o NOME DA PEÇA inteiro colado na frente. Nome amigável com mais de
 * 24 caracteres não é nome de cor — aí vale o cru do ERP ("MANTEIGA"),
 * title-case pra tela. O cru continua sendo a chave de seleção/carrinho.
 */
export function rotuloDaCor(c: { nome: string; nomeAmigavel?: string | null }): string {
  const amigavel = c.nomeAmigavel?.trim();
  if (amigavel && amigavel.length <= 24) return amigavel;
  return c.nome.toLowerCase().replace(/(^|[\s-])\S/g, (m) => m.toUpperCase());
}

/**
 * COR como variação escolhível — o que muda quando a cliente clica na bolinha:
 * fotos, grade e preço daquela cor. Vem da ficha do CRM (`produto_ficha_cor`).
 */
export interface CorApi {
  nome: string;
  estoque: number;
  preco: number;
  swatch: {
    tipo: 'cor' | 'foto';
    hex: string | null;
    focoX: number | null;
    focoY: number | null;
    imagem: string | null;
  };
  fotos: Array<{ src: string; alt?: string }>;
  titulo: string | null;
  youtubeUrl: string | null;
  tamanhos: Array<{ label: string; sku: string; estoque: number; disponivel: boolean; preco: number }>;
  /**
   * O que a cliente lê. O ERP guarda cor de etiqueta ("VD MUSGO ESC"); o
   * backend traduz e o título da ficha, quando existe, ganha da tradução.
   */
  nomeAmigavel?: string;
}

/** Peça do backend → `Product` do site. Um lugar só faz essa tradução. */
export interface PecaApi {
  ref: string; slug: string; nome: string;
  descricaoCurta: string | null; descricaoCompleta: string | null;
  marca: string | null; categoria: string | null;
  /**
   * SEGUNDO NÍVEL da árvore do site ('manga-curta' dentro de 'blusas'). O
   * backend sempre mandou (`montarPeca`), mas ninguém lia: `Product.subcategory`
   * existia no tipo e nascia vazio. Quem precisa disso é quem quer as IRMÃS da
   * peça — pedir "outras blusas" traz a categoria inteira, pedir "outras de
   * manga curta" traz o que se parece com esta.
   */
  subcategoria?: string | null;
  preco: number; precoPix: number | null;
  /**
   * "De" riscado quando há promoção — o `precoPromo` digitado na retaguarda ou
   * os 50% de coleção passada (a mesma regra do caixa). null = sem promo.
   */
  precoDe?: number | null;
  /** Faixas de preço por tamanho — vazio quando a peça tem preço único. */
  faixasPreco?: Array<{ de: number; ate: number; preco: number }>;
  parcelamento: { vezes: number; valor: number } | null;
  cores: CorApi[];
  tamanhos: Array<{ label: string; estoque: number; disponivel: boolean }>;
  estoqueTotal: number; disponivel: boolean;
  imagens: Array<{ src: string; alt?: string }>;
  modelagem: string | null; composicao: string | null;
  destaque: boolean; lancamento: boolean;
  /** `true` = tem desconto de verdade (é o que monta o Outlet). */
  promocao: boolean;
  /**
   * A peça foi ESCOLHIDA pela loja (a marquinha do cadastro), sem
   * necessariamente ter desconto — rende o selo "Preço especial". Opcional
   * porque o backend antigo não mandava o campo.
   */
  selecaoComercial?: boolean;
  /**
   * Atributos da FICHA do CRM (item 44) — os eixos do menu. Opcionais porque
   * peça sem ficha ainda existe enquanto o cadastro não termina.
   */
  tecido?: string | null;
  colecao?: string | null;
  ocasioes?: string[];
  modelagens?: string[];
  elasticidade?: string | null;
  /** Tabela de medidas da PDP (itens 42 e 49) — grade + ajuste da peça. */
  gradeMedidas?: Array<Record<string, unknown>> | null;
  /**
   * FICHA TÉCNICA — o que a cliente plus size pergunta (forro, transparência,
   * decote, manga, comprimento), extraído da descrição pela IA da retaguarda.
   */
  fichaTecnica?: Array<{ rotulo: string; valor: string }>;
  /**
   * PEÇAS JÁ VENDIDAS desta família — loja física + site + histórico do ERP
   * antigo. Prova social REAL; o piso de exibição mora no `SeloVendas`.
   */
  vendas?: number;
  /**
   * LOOK — as peças que saem na mesma foto (curadoria da retaguarda, 13/08).
   * `atual` marca a própria peça da página; a PDP mostra as irmãs no bloco
   * "Complete o look". null/ausente = peça sem look.
   */
  look?: {
    id: string;
    nome: string;
    pecas: Array<{
      ref: string; slug: string; nome: string;
      preco: number; precoPix: number | null;
      imagem: string | null; disponivel: boolean; atual: boolean;
      /**
       * Cores vendáveis da irmã, com a foto de cada uma. É o que deixa o
       * "Levar junto" abrir na MESMA cor que a cliente escolheu — o look é a
       * mesma foto. Ausente em resposta antiga (backend não deployado): o
       * site cai no comportamento de antes.
       */
      cores?: Array<{ nome: string; imagem: string | null }>;
    }>;
  } | null;
}

export function mapPeca(p: PecaApi): Product {
  const badges: Product['badges'] = [];
  const oferta = ofertaProduto(p.preco, p.precoDe, p.selecaoComercial ?? p.promocao);
  if (p.lancamento) badges.push('novo');
  if (oferta.badge) badges.push(oferta.badge);
  if (p.estoqueTotal > 0 && p.estoqueTotal <= 3) badges.push('ultimas-pecas');

  return {
    id: p.ref,
    sku: p.ref,
    slug: p.slug,
    name: nomeComReferencia(p.nome, p.ref),
    category: p.categoria ?? '',
    subcategory: p.subcategoria ?? undefined,
    price: p.preco,
    compareAtPrice: oferta.compareAtPrice,
    pixPrice: p.precoPix ?? undefined,
    ...(p.faixasPreco?.length
      ? { priceRanges: p.faixasPreco.map((f) => ({ from: f.de, to: f.ate, price: f.preco })) }
      : {}),
    installments: p.parcelamento ? { times: p.parcelamento.vezes, value: p.parcelamento.valor } : undefined,
    images: (p.imagens ?? []).map((i) => ({ src: i.src, alt: i.alt ?? p.nome })),
    sizes: (p.tamanhos ?? []).map((t) => ({ label: t.label, available: t.disponivel })),
    // O hex do conta-gotas (tirado da foto real) vence a tabela de nomes —
    // "MUSGO" e "ROSA QUEIMADO" nunca teriam entrada decente numa tabela.
    colors: (p.cores ?? []).map((c) => ({
      // O nome que a cliente lê, não o da etiqueta do ERP (item 46).
      name: c.nomeAmigavel || c.nome,
      hex: c.swatch?.hex || hexDaCor(c.nome),
      ...(c.fotos?.[0] ? { image: { src: c.fotos[0].src, alt: c.fotos[0].alt ?? c.nome } } : {}),
    })),
    badges: badges.length ? badges : undefined,
    // Tecido da ficha ganha da composição inferida: um é digitado por gente,
    // o outro é palpite da camada de IA.
    fabric: p.tecido ?? p.composicao ?? undefined,
    fit: p.modelagem ?? undefined,
    // Prova social REAL — quantas peças desta família já saíram. Quem decide a
    // partir de quanto o número aparece é o `SeloVendas`.
    sold: Number(p.vendas) || undefined,
    availability: { online: p.disponivel, stores: [], pickup: p.disponivel },
  };
}

/**
 * CADA COR VIRA UM CARD NA VITRINE (dono, 20/08: "na vitrine acho melhor
 * colocar cada cor como um produto... na home, nas categorias, etc — NÃO
 * mexer na tela de produto").
 *
 * Regras:
 * - Só cor COM foto própria e COM estoque vira card ([[so-foto-oficial]]:
 *   card com foto de outra cor é armadilha; esgotado não vai à vitrine).
 * - Menos de 2 cores com foto = card único de sempre (nada muda pros 76%
 *   do catálogo que é cor única).
 * - O `id` NÃO muda (tracking e catálogo do Meta casam pela REF); quem
 *   distingue o card é `vitrineCor`, e o link leva `?cor=` — a PDP abre
 *   com a cor escolhida como principal e as miniaturas presentes.
 * - As bolinhas de cor somem do card (colors: undefined): o card JÁ É uma
 *   cor — bolinha em cima disso seria o seletor duplicado de sempre.
 */
export function explodirPorCor(p: PecaApi): Product[] {
  const base = mapPeca(p);
  const vendaveis = (p.cores ?? [])
    .filter((c) => c.estoque > 0 && (c.fotos?.length ?? 0) > 0)
    /* A ORDEM DENTRO DA REF (dono, 20/08: "iniciar com a BMM-100 PRETO e na
       sequência todas as cores da REF com estoque"): a cor com MAIS peça
       abre a família — é a que aguenta a demanda que a vitrine cria — e as
       demais vêm atrás, sempre juntas, antes da próxima REF. */
    .sort((a, b) => b.estoque - a.estoque);

  /**
   * DUAS CORES, UM RÓTULO SÓ — o card duplicado da vitrine (22/08/2026).
   *
   * Visto em produção na seção Blusas da home: a peça 138818 saía DUAS VEZES
   * seguidas, com nome e preço idênticos — "Blusa Manga Curta Estampa Mostarda
   * · Blusa Manga Curta". Pra cliente é a mesma blusa listada duas vezes; pra
   * loja é uma prateleira que parece desorganizada logo na primeira dobra.
   *
   * A causa é cadastro poluído: duas cores CRUAS diferentes ("...MOSTARDA" e
   * "...ESTAMPA", ambas com o nome da PEÇA colado no campo cor) que a guarda
   * do `rotuloDaCor` reduz ao MESMO texto. As chaves de lista continuavam
   * únicas (o React nem avisa, porque `chaveDoCard` usa o nome cru), então o
   * bug era invisível pro código e óbvio pra quem olha a tela.
   *
   * A regra é a da cliente: se dois cards mostram o mesmo rótulo, são o mesmo
   * card. Fica o de MAIOR estoque — a lista já vem ordenada por estoque, então
   * é o primeiro. Isto NÃO conserta o cadastro (esse é trabalho da retaguarda);
   * impede que ele chegue à vitrine.
   */
  const porRotulo = new Map<string, (typeof vendaveis)[number]>();
  for (const c of vendaveis) {
    const chave = rotuloDaCor(c).trim().toUpperCase();
    if (!porRotulo.has(chave)) porRotulo.set(chave, c);
  }
  const distintas = [...porRotulo.values()];

  if (distintas.length < 2) return [base];
  return distintas.map((c) => {
    const badges: Product['badges'] = (base.badges ?? []).filter((b) => b !== 'ultimas-pecas');
    // "Últimas peças" honesto por COR — é o estoque dela que conta aqui.
    if (c.estoque > 0 && c.estoque <= 3) badges.push('ultimas-pecas');
    return {
      ...base,
      name: `${base.name} · ${rotuloDaCor(c)}`,
      price: c.preco > 0 ? c.preco : base.price,
      pixPrice: c.preco > 0 ? Number((c.preco * 0.95).toFixed(2)) : base.pixPrice,
      installments:
        c.preco > 0 ? { times: 12, value: Number((c.preco / 12).toFixed(2)) } : base.installments,
      images: c.fotos.map((f) => ({ src: f.src, alt: f.alt ?? `${p.nome} ${c.nome}` })),
      /**
       * ⚠️ GRADE COM REDE (21/08): alguns endpoints (blocos da HOME) mandam
       * as cores SEM a grade de tamanhos — payload leve. Grade vazia fazia o
       * card explodido parecer esgotado e o botão COMPRAR sumia ("cadê o
       * botão comprar?"). Sem grade por cor, vale a grade da peça.
       */
      sizes: c.tamanhos?.length
        ? c.tamanhos.map((t) => ({ label: t.label, available: t.disponivel }))
        : base.sizes,
      colors: undefined,
      badges: badges.length ? badges : undefined,
      vitrineCor: { nome: c.nome, rotulo: rotuloDaCor(c) },
    };
  });
}

/** A lista da vitrine inteira, já explodida por cor. */
export const mapPecasDaVitrine = (itens: PecaApi[]): Product[] => itens.flatMap(explodirPorCor);

/** Chave de lista estável pro card (o `id` repete entre cores da mesma REF). */
export const chaveDoCard = (p: Product): string =>
  p.vitrineCor ? `${p.id}~${p.vitrineCor.nome}` : String(p.id);

/** Ordenação do site → parâmetro que o backend entende. */
const ORDENACAO: Record<SortOption, string> = {
  relevancia: 'relevancia',
  'mais-vendidos': 'relevancia',
  novidades: 'novidades',
  lancamentos: 'novidades',
  'menor-preco': 'preco-asc',
  'maior-preco': 'preco-desc',
  'maior-desconto': 'preco-desc',
  'mais-avaliados': 'relevancia',
};

/* --------------------------------------------------------------- ORDENAÇÃO */

export const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'relevancia', label: 'Relevância' },
  { value: 'mais-vendidos', label: 'Mais vendidos' },
  { value: 'novidades', label: 'Novidades' },
  { value: 'menor-preco', label: 'Menor preço' },
  { value: 'maior-preco', label: 'Maior preço' },
  { value: 'maior-desconto', label: 'Maior desconto' },
  { value: 'mais-avaliados', label: 'Mais avaliados' },
];

/* ------------------------------------------------------------------ FILTROS */

/**
 * Estado dos filtros → querystring da API. Filtro que o backend ainda não
 * entende é IGNORADO de propósito (não some da UI, mas não mente no
 * resultado) — ver o relatório do sprint 008 pra lista do que falta.
 */
function paramsDosFiltros(filters: FilterState): Record<string, string> {
  const out: Record<string, string> = {};
  const primeiro = (v: unknown) => (Array.isArray(v) && v.length ? String(v[0]) : undefined);
  // TAMANHO É MULTISSELEÇÃO NA TELA (bug real, 07/08): a cliente marca 46 e
  // 50, os dois botões ficam com o visual de selecionado, mas só o 46 ia pro
  // backend — o 50 era descartado em silêncio. `numerosDaGrade` no backend já
  // entende lista separada por vírgula.
  const todos = (v: unknown) => (Array.isArray(v) && v.length ? v.map(String).join(',') : undefined);

  const cor = primeiro(filters.cor);
  if (cor) out.cor = cor;
  const tamanho = todos(filters.tamanho);
  if (tamanho) out.tamanho = tamanho;
  /**
   * CATEGORIA como filtro da barra lateral — só aparece em listagem que ainda
   * não está presa a uma categoria (`/tamanhos/56`, `/novidades`, `/outlet`,
   * busca). Ver `filterGroups`.
   *
   * `todos`, não `primeiro`: marcar Blusas E Vestidos manda as duas. Mandar só
   * a primeira com os dois botões acesos na tela é o bug do tamanho de 07/08
   * — o backend passou a aceitar lista separada por vírgula junto com isto.
   */
  const categoria = todos((filters as Record<string, unknown>).categoria);
  if (categoria) out.categoria = categoria;
  const modelagem = primeiro((filters as Record<string, unknown>).modelagem);
  if (modelagem) out.modelagem = modelagem;

  const preco = (filters as Record<string, unknown>).preco as [number, number] | undefined;
  if (Array.isArray(preco) && preco.length === 2) {
    out.precoMin = String(preco[0]);
    out.precoMax = String(preco[1]);
  }
  if ((filters as Record<string, unknown>).promocao) out.promocao = '1';
  if ((filters as Record<string, unknown>).novidades) out.novidade = '1';

  return out;
}

/* ----------------------------------------------------------------- CONSULTA */

export async function fetchProducts(query: ProductQuery = {}): Promise<Paginated<Product>> {
  const {
    category, subcategoria, search, sort = 'relevancia', filters = {}, page = 1, perPage = 12,
    tetoDePreco, soPromocao, soNovidade,
  } = query;

  const params = new URLSearchParams({
    page: String(page),
    perPage: String(perPage),
    ordenar: ORDENACAO[sort] ?? 'relevancia',
    ...paramsDosFiltros(filters),
  });
  // O teto da vitrine SÓ APERTA: se a cliente já pediu um máximo menor pelo
  // slider, o dela vale. Assim "Até R$ 59,90" nunca mostra peça de R$ 400 —
  // nem depois de ela clicar em "Limpar".
  if (tetoDePreco) {
    const pedido = Number(params.get('precoMax'));
    params.set('precoMax', String(Number.isFinite(pedido) && pedido > 0 ? Math.min(pedido, tetoDePreco) : tetoDePreco));
  }
  if (category) params.set('categoria', category);
  // Segundo nível da árvore do site — vem do `?sub=` da URL da categoria.
  if (subcategoria) params.set('subcategoria', subcategoria);
  // Mesma chave que o controller lê ("promocao") — ver o comentário
  // equivalente em services/vitrine.ts.
  if (soPromocao) params.set('promocao', '1');
  // Mesma chave que o controller lê (soNovidade -> filtra lancamento ≤30d).
  if (soNovidade) params.set('novidade', '1');
  if (search && search.trim().length >= 2) params.set('busca', search.trim());

  const resposta = await fetch(`/api/loja/produtos?${params.toString()}`);
  if (!resposta.ok) {
    // Catálogo fora do ar não pode quebrar a página: lista vazia + log.
    console.error('[catalogo] falha ao listar', resposta.status);
    return { items: [], total: 0, page, perPage, hasMore: false };
  }
  const dados = await resposta.json();
  // Explodida por cor: cada cor com foto vira um card (dono, 20/08). O
  // `total`/paginação seguem contando por REF — o backend pagina por peça.
  const items: Product[] = mapPecasDaVitrine(dados.itens ?? []);

  return {
    items,
    total: dados.total ?? items.length,
    page: dados.page ?? page,
    perPage: dados.perPage ?? perPage,
    hasMore: (dados.page ?? page) < (dados.totalPages ?? 1),
  };
}

/**
 * Faixa de preço PADRÃO da sidebar. A faixa real vem das facetas
 * (`/api/loja/filtros`) — esta serve só como esqueleto antes da resposta.
 */
export function priceRange(): { min: number; max: number } {
  return { min: 0, max: 1000 };
}

/**
 * Grupos de filtro disponíveis. A ordem é a ordem da sidebar — do mais usado
 * (tamanho, preço) pro mais específico (elasticidade).
 */
export interface Facetas {
  categorias: Array<{ valor: string; qtd: number }>;
  marcas: Array<{ valor: string; qtd: number }>;
  cores: Array<{ valor: string; qtd: number }>;
  tamanhos: Array<{ valor: string; qtd: number }>;
  modelagens: Array<{ valor: string; qtd: number }>;
  preco: { min: number; max: number };
}

/** Facetas do catálogo REAL — o que existe publicado e com estoque. */
export async function fetchFacetas(): Promise<Facetas | null> {
  try {
    const r = await fetch('/api/loja/filtros');
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * "calcas" → "Calças". Os slugs vêm sem acento do CRM; mostrar o slug cru na
 * barra de filtro ficaria "calcas" e "macacoes" na cara da cliente. Mesma
 * tabela de `services/categorias-menu.ts` — as duas mostram os mesmos nomes.
 */
const ROTULO_CATEGORIA: Record<string, string> = {
  calcas: 'Calças',
  macacoes: 'Macacões',
  'moda-praia': 'Moda praia',
};

function rotuloCategoria(slug: string): string {
  const s = String(slug || '').trim();
  if (!s) return '';
  if (ROTULO_CATEGORIA[s]) return ROTULO_CATEGORIA[s];
  const limpo = s.replace(/[-_]+/g, ' ');
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

export function filterGroups(category?: string, facetas?: Facetas | null): FilterGroup[] {
  const range = facetas?.preco ?? priceRange();

  // Com facetas, tamanho e cor saem do catálogo real (com contagem) — some
  // o filtro que não levaria a lugar nenhum.
  if (facetas) {
    const grupos: FilterGroup[] = [];
    /**
     * CATEGORIA — só quando a listagem NÃO é de uma categoria (dono, 10/08:
     * "depois colocar ainda filtro de categorias").
     *
     * As facetas sempre trouxeram `categorias` com contagem; ninguém usava.
     * Faz sentido em `/tamanhos/56` ("tudo que veste 56" → "só as blusas"),
     * em `/novidades`, `/outlet` e na busca. Dentro de `/categoria/vestidos`
     * não faz: filtrar vestido por categoria de novo só teria uma resposta
     * possível, ou zero.
     *
     * Primeiro na barra porque em `/tamanhos/56` é o recorte que mais reduz a
     * lista — a cliente já disse o número dela, o que falta é o tipo de peça.
     */
    if (!category && facetas.categorias?.length > 1) {
      grupos.push({
        id: 'categoria', label: 'Categoria', type: 'checkbox', defaultOpen: true,
        options: facetas.categorias.map((c) => ({
          value: c.valor,
          label: rotuloCategoria(c.valor),
          count: c.qtd,
        })),
      });
    }
    if (facetas.tamanhos?.length) {
      grupos.push({
        id: 'tamanho', label: 'Tamanho', type: 'size', defaultOpen: true,
        options: facetas.tamanhos.map((t) => ({ value: t.valor, label: t.valor, count: t.qtd })),
      });
    }
    grupos.push({ id: 'preco', label: 'Preço', type: 'range', defaultOpen: true, range });
    /**
     * SEM FILTRO DE COR (decisão do dono, 06/08).
     *
     * A peça tem uma página só e a cor é escolhida DENTRO dela, na bolinha.
     * Filtrar por cor na barra lateral escondia a peça inteira por causa de
     * uma variação — e a bolinha do filtro competia visualmente com a bolinha
     * que de fato troca a cor, que é a que importa.
     */
    if (facetas.modelagens?.length) {
      grupos.push({
        id: 'modelagem', label: 'Modelagem', type: 'checkbox',
        options: facetas.modelagens.map((m) => ({ value: m.valor, label: m.valor, count: m.qtd })),
      });
    }
    if (facetas.marcas?.length > 1) {
      grupos.push({
        id: 'marca', label: 'Marca', type: 'checkbox',
        options: facetas.marcas.slice(0, 20).map((m) => ({ value: m.valor, label: m.valor, count: m.qtd })),
      });
    }
    return grupos;
  }

  return [
    {
      id: 'tamanho',
      label: 'Tamanho',
      type: 'size',
      defaultOpen: true,
      options: ['46', '48', '50', '52', '54', '56', '58', '60'].map((label) => ({
        value: label,
        label,
      })),
    },
    { id: 'preco', label: 'Preço', type: 'range', defaultOpen: true, range },
    // Cor NÃO entra aqui — ver o comentário no caminho com facetas acima.
    {
      id: 'tecido',
      label: 'Tecido',
      type: 'checkbox',
      options: [
        { value: 'viscolycra premium', label: 'Viscolycra premium' },
        { value: 'jeans', label: 'Jeans' },
        { value: 'linho', label: 'Linho' },
        { value: 'crepe', label: 'Crepe' },
        { value: 'tricot', label: 'Tricot' },
        { value: 'malha', label: 'Malha' },
        { value: 'alfaiataria', label: 'Alfaiataria' },
      ],
    },
    {
      id: 'ocasiao',
      label: 'Ocasião',
      type: 'checkbox',
      options: [
        { value: 'trabalho', label: 'Trabalho' },
        { value: 'casamento', label: 'Casamento' },
        { value: 'festa', label: 'Festa' },
        { value: 'dia a dia', label: 'Dia a dia' },
        { value: 'praia', label: 'Praia' },
        { value: 'viagem', label: 'Viagem' },
      ],
    },
    {
      id: 'modelagem',
      label: 'Modelagem',
      type: 'checkbox',
      options: [
        { value: 'valoriza a cintura', label: 'Valoriza a cintura' },
        { value: 'disfarca barriga', label: 'Caimento leve no abdômen' },
        { value: 'alonga silhueta', label: 'Alonga a silhueta' },
        { value: 'modelagem solta', label: 'Modelagem solta' },
        { value: 'conforto total', label: 'Conforto total' },
      ],
    },
    {
      id: 'colecao',
      label: 'Coleção',
      type: 'checkbox',
      options: [
        { value: 'colecao atual', label: 'Coleção atual' },
        { value: 'alfaiataria lurds', label: 'Alfaiataria Lurds' },
        { value: 'festa e cerimonia', label: 'Festa & Cerimônia' },
        { value: 'essenciais', label: 'Essenciais' },
      ],
    },
    {
      id: 'destaques',
      label: 'Destaques',
      type: 'toggle',
      options: [
        { value: 'novidades', label: 'Novidades' },
        { value: 'promocao', label: 'Em promoção' },
        { value: 'mais-vendidos', label: 'Mais vendidos' },
        { value: 'exclusivos', label: 'Exclusivos' },
      ],
    },
    {
      id: 'disponibilidade',
      label: 'Disponibilidade',
      type: 'toggle',
      options: [
        { value: 'na-minha-loja', label: 'Disponível na minha loja' },
        { value: 'comprar-e-retirar', label: 'Comprar e retirar' },
      ],
    },
  ];
}

/** Metadados por categoria — hero, texto de introdução e conteúdo educativo. */
export interface CategoryMeta {
  slug: string;
  name: string;
  title: string;
  intro: string;
  /**
   * `null` desde 16/08/2026 — eram duas fotos do Unsplash usadas só no card
   * de compartilhamento (a página não tem hero desde 07/08). Sem foto oficial
   * por categoria, o link compartilhado usa a OG padrão do site.
   */
  heroImage: string | null;
  guide: { title: string; paragraphs: string[] };
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  vestidos: {
    slug: 'vestidos',
    name: 'Vestidos',
    title: 'Vestidos plus size',
    intro:
      'Do envelope clássico ao midi de festa: modelagens que valorizam o corpo real, em tecidos que aguentam o dia inteiro. Do 44 ao 60.',
    heroImage: null,
    guide: {
      title: 'Como escolher o vestido ideal',
      paragraphs: [
        'Comece pela ocasião, não pelo tamanho. Um casamento de dia pede tecido leve e cor clara; à noite, crepe e tons fechados sustentam melhor a produção.',
        'Depois pense no que você quer valorizar. Recortes na cintura e amarrações marcam a silhueta; modelagens soltas com caimento fluido disfarçam o abdômen sem parecer largas.',
        'Por último, o tecido. Viscolycra premium é o coringa: cai como líquido, não marca e volta ao lugar depois de sentar. Crepe tem toque seco e caimento mais nobre — ideal pra cerimônia.',
        'Na dúvida entre dois tamanhos, escolha pelo maior ponto do corpo e ajuste o resto. Nossas consultoras fazem isso no provador, sem pressa.',
      ],
    },
  },
};

export function categoryMeta(slug: string): CategoryMeta {
  return (
    CATEGORY_META[slug] ?? {
      slug,
      name: slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
      title: `${slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ')} plus size`,
      intro:
        'Curadoria Lurds do 44 ao 60: peças escolhidas pelo caimento, pelo tecido e pela forma como vestem o corpo real.',
      heroImage: null,
      guide: {
        title: 'Como escolher a peça ideal',
        paragraphs: [
          'Comece pela ocasião e pelo que você quer valorizar — a vitrine inteira está organizada por isso.',
          'Depois olhe o tecido: ele define o caimento mais que o tamanho. Viscolycra cai fluido, jeans estrutura, linho refresca.',
          'Ficou em dúvida no tamanho? Confira as medidas de quem já comprou nas avaliações, ou chame uma consultora no WhatsApp.',
        ],
      },
    }
  );
}

/** Categorias com página própria (usado pelo generateStaticParams). */
export const CATEGORY_SLUGS = [
  'vestidos',
  'blusas',
  'calcas',
  'conjuntos',
  'macacoes',
  'jaquetas',
  'saias',
  'shorts',
  'moda-praia',
  'fitness',
];
