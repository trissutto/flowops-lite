import { normalize } from '@/lib/utils';
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

function hexDaCor(nome: string): string {
  const chave = normalize(nome);
  if (HEX_POR_COR[chave]) return HEX_POR_COR[chave];
  const parcial = Object.keys(HEX_POR_COR).find((k) => chave.includes(k));
  return parcial ? HEX_POR_COR[parcial] : '#c9bda8';
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
  preco: number; precoPix: number | null;
  /** Faixas de preço por tamanho — vazio quando a peça tem preço único. */
  faixasPreco?: Array<{ de: number; ate: number; preco: number }>;
  parcelamento: { vezes: number; valor: number } | null;
  cores: CorApi[];
  tamanhos: Array<{ label: string; estoque: number; disponivel: boolean }>;
  estoqueTotal: number; disponivel: boolean;
  imagens: Array<{ src: string; alt?: string }>;
  modelagem: string | null; composicao: string | null;
  destaque: boolean; lancamento: boolean; promocao: boolean;
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
}

export function mapPeca(p: PecaApi): Product {
  const badges: Product['badges'] = [];
  if (p.lancamento) badges.push('novo');
  if (p.promocao) badges.push('promocao');
  if (p.estoqueTotal > 0 && p.estoqueTotal <= 3) badges.push('ultimas-pecas');

  return {
    id: p.ref,
    sku: p.ref,
    slug: p.slug,
    name: p.nome,
    category: p.categoria ?? '',
    price: p.preco,
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
    availability: { online: p.disponivel, stores: [], pickup: p.disponivel },
  };
}

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

  const cor = primeiro(filters.cor);
  if (cor) out.cor = cor;
  const tamanho = primeiro(filters.tamanho);
  if (tamanho) out.tamanho = tamanho;
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
  const { category, search, sort = 'relevancia', filters = {}, page = 1, perPage = 12, tetoDePreco } = query;

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
  if (search && search.trim().length >= 2) params.set('busca', search.trim());

  const resposta = await fetch(`/api/loja/produtos?${params.toString()}`);
  if (!resposta.ok) {
    // Catálogo fora do ar não pode quebrar a página: lista vazia + log.
    console.error('[catalogo] falha ao listar', resposta.status);
    return { items: [], total: 0, page, perPage, hasMore: false };
  }
  const dados = await resposta.json();
  const items: Product[] = (dados.itens ?? []).map(mapPeca);

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

export function filterGroups(category?: string, facetas?: Facetas | null): FilterGroup[] {
  const range = facetas?.preco ?? priceRange();

  // Com facetas, tamanho e cor saem do catálogo real (com contagem) — some
  // o filtro que não levaria a lugar nenhum.
  if (facetas) {
    const grupos: FilterGroup[] = [];
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
        { value: 'disfarca barriga', label: 'Disfarça a barriga' },
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
  heroImage: string;
  guide: { title: string; paragraphs: string[] };
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  vestidos: {
    slug: 'vestidos',
    name: 'Vestidos',
    title: 'Vestidos plus size',
    intro:
      'Do envelope clássico ao midi de festa: modelagens que valorizam o corpo real, em tecidos que aguentam o dia inteiro. Do 46 ao 60.',
    heroImage: 'https://images.unsplash.com/photo-1657550853452-f13aa437f6c9?w=2000&q=85&fm=jpg&fit=max',
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
        'Curadoria Lurds do 46 ao 60: peças escolhidas pelo caimento, pelo tecido e pela forma como vestem o corpo real.',
      heroImage: 'https://images.unsplash.com/photo-1603400521630-9f2de124b33b?w=2000&q=85&fm=jpg&fit=max',
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
