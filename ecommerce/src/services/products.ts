import { normalize } from '@/lib/utils';
import { bestSellers, newArrivals } from '@/data/content';
import type { FilterGroup, FilterState, Paginated, Product, ProductQuery, SortOption } from '@/types';

/**
 * SERVIÇO DE CATÁLOGO
 *
 * Camada única de acesso a produto. Hoje resolve em memória sobre o conteúdo
 * placeholder; a assinatura (`fetchProducts` → `Paginated<Product>`) é a mesma
 * que a API do FlowOps vai expor, então nenhuma tela muda na migração.
 *
 * Ordenação, filtro e paginação vivem AQUI, não no componente — é o que
 * permite trocar por query no servidor sem reescrever a página.
 */

/**
 * Catálogo simulado: repete a base variando preço/etiqueta pra dar volume
 * suficiente pra exercitar paginação e infinite scroll (≈24 peças por
 * categoria). Some quando a API real entrar.
 */
const CATALOG: Product[] = (() => {
  const base = [...newArrivals, ...bestSellers];
  const multiplied: Product[] = [];
  for (let round = 0; round < 12; round++) {
    for (const [i, product] of base.entries()) {
      if (round === 0) {
        multiplied.push(product);
        continue;
      }
      const factor = 1 + ((round * 7 + i * 3) % 40) / 100;
      const price = Number((product.price * factor).toFixed(2));
      multiplied.push({
        ...product,
        id: `${product.id}-v${round}`,
        slug: `${product.slug}-v${round}`,
        price,
        pixPrice: Number((price * 0.95).toFixed(2)),
        installments: { times: 12, value: Number((price / 12).toFixed(2)) },
        compareAtPrice: round % 3 === 0 ? Number((price * 1.25).toFixed(2)) : undefined,
        badges: round % 4 === 0 ? ['promocao'] : round % 5 === 0 ? ['ultimas-pecas'] : product.badges,
        images: [product.images[1] ?? product.images[0], product.images[0]],
      });
    }
  }
  return multiplied;
})();

/* --------------------------------------------------------------- ORDENAÇÃO */

const SORTERS: Record<SortOption, (a: Product, b: Product) => number> = {
  relevancia: () => 0,
  'mais-vendidos': (a, b) => (b.rating?.count ?? 0) - (a.rating?.count ?? 0),
  novidades: (a, b) => Number(b.badges?.includes('novo')) - Number(a.badges?.includes('novo')),
  lancamentos: (a, b) => Number(b.badges?.includes('novo')) - Number(a.badges?.includes('novo')),
  'menor-preco': (a, b) => a.price - b.price,
  'maior-preco': (a, b) => b.price - a.price,
  'maior-desconto': (a, b) => {
    const da = a.compareAtPrice ? (a.compareAtPrice - a.price) / a.compareAtPrice : 0;
    const db = b.compareAtPrice ? (b.compareAtPrice - b.price) / b.compareAtPrice : 0;
    return db - da;
  },
  'mais-avaliados': (a, b) => (b.rating?.average ?? 0) - (a.rating?.average ?? 0),
};

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

/** Um predicado por grupo de filtro — adicionar filtro = adicionar entrada. */
const PREDICATES: Record<string, (product: Product, value: unknown) => boolean> = {
  subcategoria: (p, v) => (v as string[]).includes(p.subcategory ?? ''),
  cor: (p, v) => (p.colors ?? []).some((c) => (v as string[]).includes(normalize(c.name))),
  tamanho: (p, v) =>
    p.sizes.some((s) => s.available && (v as string[]).includes(s.label)),
  tecido: (p, v) => (v as string[]).includes(normalize(p.fabric ?? '')),
  ocasiao: (p, v) => (p.occasions ?? []).some((o) => (v as string[]).includes(normalize(o))),
  modelagem: (p, v) => (v as string[]).includes(normalize(p.fit ?? '')),
  colecao: (p, v) => (v as string[]).includes(normalize(p.collection ?? '')),
  preco: (p, v) => {
    const [min, max] = v as [number, number];
    return p.price >= min && p.price <= max;
  },
  promocao: (p, v) => !v || Boolean(p.compareAtPrice),
  novidades: (p, v) => !v || Boolean(p.badges?.includes('novo')),
  'mais-vendidos': (p, v) => !v || Boolean(p.badges?.includes('best-seller')),
  exclusivos: (p, v) => !v || Boolean(p.badges?.includes('exclusivo')),
  'na-minha-loja': (p, v) => !v || Boolean(p.availability?.stores.length),
  'comprar-e-retirar': (p, v) => !v || Boolean(p.availability?.pickup),
};

function matches(product: Product, filters: FilterState): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value === false) continue;
    const predicate = PREDICATES[key];
    if (predicate && !predicate(product, value)) return false;
  }
  return true;
}

/* ----------------------------------------------------------------- CONSULTA */

export async function fetchProducts(query: ProductQuery = {}): Promise<Paginated<Product>> {
  const { category, search, sort = 'relevancia', filters = {}, page = 1, perPage = 12 } = query;

  let items = CATALOG;

  if (category) items = items.filter((p) => p.category === category);

  if (search && search.trim().length >= 2) {
    const term = normalize(search);
    items = items.filter(
      (p) => normalize(p.name).includes(term) || normalize(p.fabric ?? '').includes(term),
    );
  }

  items = items.filter((p) => matches(p, filters));
  items = [...items].sort(SORTERS[sort]);

  const total = items.length;
  const start = (page - 1) * perPage;

  return {
    items: items.slice(start, start + perPage),
    total,
    page,
    perPage,
    hasMore: start + perPage < total,
  };
}

/** Faixa real de preço do recorte — alimenta o filtro de preço. */
export function priceRange(category?: string): { min: number; max: number } {
  const items = category ? CATALOG.filter((p) => p.category === category) : CATALOG;
  const prices = items.map((p) => p.price);
  return {
    min: Math.floor(Math.min(...prices) / 10) * 10,
    max: Math.ceil(Math.max(...prices) / 10) * 10,
  };
}

/**
 * Grupos de filtro disponíveis. A ordem é a ordem da sidebar — do mais usado
 * (tamanho, preço) pro mais específico (elasticidade).
 */
export function filterGroups(category?: string): FilterGroup[] {
  const range = priceRange(category);

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
    {
      id: 'cor',
      label: 'Cor',
      type: 'swatch',
      defaultOpen: true,
      options: [
        { value: 'preto', label: 'Preto', hex: '#1a1614' },
        { value: 'off white', label: 'Off white', hex: '#f1eadf' },
        { value: 'vinho', label: 'Vinho', hex: '#7a3b46' },
        { value: 'areia', label: 'Areia', hex: '#d9cdb4' },
        { value: 'verde', label: 'Verde', hex: '#4f7355' },
        { value: 'azul', label: 'Azul', hex: '#2f5573' },
      ],
    },
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
    heroImage: 'https://images.unsplash.com/photo-1657550853452-f13aa437f6c9',
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
      heroImage: 'https://images.unsplash.com/photo-1603400521630-9f2de124b33b',
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
