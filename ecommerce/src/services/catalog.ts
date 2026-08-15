import 'server-only';
import { api, apiSafe } from '@/lib/api';
import { slugify } from '@/lib/utils';
import { nomeComReferencia } from '@/lib/commerce/product-presentation';
import type { Media, Product, ProductBadge, ProductSize } from '@/types';

/**
 * CATÁLOGO REAL — adaptador entre o backend FlowOps e o tipo `Product`.
 *
 * ⚠️ Fonte de dados HOJE: `/public/vitrine` do backend, que por sua vez lê o
 * **WooCommerce** do site atual (`WC_URL/wp-json/wc/v3`). É uma ponte
 * consciente: os produtos são os mesmos, mas a dependência é do sistema que
 * este projeto vai substituir.
 *
 * Quando o catálogo nativo (tabela `product` do Postgres) ganhar endpoint
 * público, só as funções deste arquivo mudam — nenhuma tela é tocada. Esse é
 * o motivo de todo mapeamento viver aqui e não no componente.
 *
 * ⚠️ O endpoint de detalhe consulta o ERP Giga pra estoque. O Giga PENDURA
 * sem devolver erro quando o firewall derruba o IP (histórico do projeto), por
 * isso toda chamada usa timeout e as listagens usam `apiSafe` — catálogo fora
 * do ar degrada a seção, nunca derruba a página.
 */

/* ------------------------------------------------------- SHAPES DO BACKEND */

interface WcListItem {
  id: number;
  name: string;
  slug: string;
  sku: string | null;
  type: string;
  price: number | null;
  regularPrice: number | null;
  salePrice: number | null;
  stockStatus: 'instock' | 'outofstock' | 'onbackorder';
  totalSales: number;
  image: string | null;
  categories: string[];
  dateModified: string;
}

interface WcVariation {
  id: number;
  sku: string | null;
  price?: number | null;
  stockQuantity?: number | null;
  erpStock?: number | null;
  attributes?: { name: string; option: string }[];
}

interface WcDetail extends WcListItem {
  description: string;
  shortDescription: string;
  tags: string[];
  images: { src: string; alt: string }[];
  erpStock: number | null;
  variations?: WcVariation[];
}

interface WcListResponse {
  data: WcListItem[];
  total: number;
  totalPages: number;
  page: number;
}

/* ------------------------------------------------------------ MAPEADORES */

/** Tecidos que a marca trabalha — extraídos do nome/categorias da peça. */
const FABRICS = [
  'viscolycra',
  'jeans',
  'linho',
  'crepe',
  'tricot',
  'malha',
  'alfaiataria',
  'moletom',
];

function detectFabric(name: string, categories: string[]): string | undefined {
  const haystack = `${name} ${categories.join(' ')}`.toLowerCase();
  const found = FABRICS.find((f) => haystack.includes(f));
  return found ? found.charAt(0).toUpperCase() + found.slice(1) : undefined;
}

/** Categoria canônica do site a partir das categorias do WooCommerce. */
const CATEGORY_MAP: Record<string, string> = {
  vestido: 'vestidos',
  vestidos: 'vestidos',
  blusa: 'blusas',
  blusas: 'blusas',
  camisa: 'blusas',
  calca: 'calcas',
  calcas: 'calcas',
  conjunto: 'conjuntos',
  conjuntos: 'conjuntos',
  macacao: 'macacoes',
  macacoes: 'macacoes',
  jaqueta: 'jaquetas',
  casaco: 'jaquetas',
  saia: 'saias',
  saias: 'saias',
  short: 'shorts',
  shorts: 'shorts',
  praia: 'moda-praia',
  biquini: 'moda-praia',
  fitness: 'fitness',
};

function detectCategory(categories: string[]): string {
  for (const raw of categories) {
    const key = slugify(raw);
    if (CATEGORY_MAP[key]) return CATEGORY_MAP[key];
    // "Vestidos Plus Size" → tenta a primeira palavra
    const first = key.split('-')[0];
    if (CATEGORY_MAP[first]) return CATEGORY_MAP[first];
  }
  return categories[0] ? slugify(categories[0]) : 'geral';
}

/** Numeração da marca. Sem variações no WC, assume a grade inteira indisponível. */
const SIZE_GRID = ['46', '48', '50', '52', '54', '56', '58', '60'];

function mapSizes(item: WcDetail | WcListItem, variations?: WcVariation[]): ProductSize[] {
  if (variations && variations.length > 0) {
    const bySize = new Map<string, boolean>();
    for (const variation of variations) {
      const sizeAttr = variation.attributes?.find((a) =>
        /tamanho|size|numera/i.test(a.name),
      );
      if (!sizeAttr) continue;
      // Estoque do ERP manda; se ausente, usa o do WooCommerce.
      const stock = variation.erpStock ?? variation.stockQuantity ?? 0;
      const available = stock > 0;
      bySize.set(sizeAttr.option, bySize.get(sizeAttr.option) || available);
    }
    if (bySize.size > 0) {
      return Array.from(bySize.entries())
        .map(([label, available]) => ({ label, available, inStore: available }))
        .sort((a, b) => Number(a.label) - Number(b.label));
    }
  }

  // Produto simples: a grade toda segue a disponibilidade do próprio item.
  const available = item.stockStatus === 'instock';
  return SIZE_GRID.map((label) => ({ label, available, inStore: available }));
}

function mapBadges(item: WcListItem): ProductBadge[] {
  const badges: ProductBadge[] = [];
  if (item.salePrice && item.regularPrice && item.salePrice < item.regularPrice) {
    badges.push('promocao');
  }
  if (item.totalSales >= 30) badges.push('best-seller');
  // Publicado nos últimos 30 dias conta como novidade.
  const modified = new Date(item.dateModified).getTime();
  if (Number.isFinite(modified) && Date.now() - modified < 30 * 24 * 60 * 60 * 1000) {
    badges.push('novo');
  }
  if (item.stockStatus === 'outofstock') return badges;
  return badges;
}

function mapImages(item: WcDetail | WcListItem, name: string): Media[] {
  if ('images' in item && item.images?.length) {
    return item.images.map((img, i) => ({
      src: img.src,
      alt: img.alt?.trim() || `${name} — foto ${i + 1}`,
    }));
  }
  return item.image ? [{ src: item.image, alt: name }] : [];
}

function toProduct(item: WcListItem, detail?: WcDetail): Product {
  const price = item.price ?? item.regularPrice ?? 0;
  const hasDiscount =
    item.regularPrice != null && item.price != null && item.price < item.regularPrice;

  return {
    id: String(item.id),
    sku: item.sku ?? undefined,
    slug: item.slug,
    name: nomeComReferencia(item.name, item.sku),
    category: detectCategory(item.categories),
    price,
    compareAtPrice: hasDiscount ? item.regularPrice! : undefined,
    // Convenção da marca: 5% no Pix à vista.
    pixPrice: price > 0 ? Number((price * 0.95).toFixed(2)) : undefined,
    installments: price > 0 ? { times: 12, value: Number((price / 12).toFixed(2)) } : undefined,
    images: mapImages(detail ?? item, item.name),
    sizes: mapSizes(detail ?? item, detail?.variations),
    badges: mapBadges(item),
    fabric: detectFabric(item.name, item.categories),
    availability: {
      online: item.stockStatus === 'instock',
      stores: [],
      pickup: item.stockStatus === 'instock',
    },
  };
}

/* --------------------------------------------------------------- CONSULTAS */

export interface CatalogPage {
  items: Product[];
  total: number;
  totalPages: number;
  page: number;
}

/**
 * Lista da vitrine. `apiSafe`: se o catálogo cair, a seção volta vazia e o
 * resto da página continua de pé.
 */
export async function listProducts(params: {
  page?: number;
  perPage?: number;
  search?: string;
} = {}): Promise<CatalogPage> {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    per_page: String(params.perPage ?? 24),
    stock: 'instock',
    orderby: 'sales',
  });
  if (params.search) query.set('search', params.search);

  const response = await apiSafe<WcListResponse>(
    `/public/vitrine?${query.toString()}`,
    { data: [], total: 0, totalPages: 0, page: 1 },
    { revalidate: 300, tags: ['catalogo'] },
  );

  return {
    items: response.data.map((item) => toProduct(item)),
    total: response.total,
    totalPages: response.totalPages,
    page: response.page,
  };
}

/** Detalhe do produto. Devolve null em 404 — a página chama notFound(). */
export async function getProduct(slug: string): Promise<{
  product: Product;
  description: string;
  shortDescription: string;
} | null> {
  try {
    // Timeout maior: este endpoint consulta o ERP pra estoque das variações.
    const detail = await api<WcDetail>(`/public/vitrine/${encodeURIComponent(slug)}`, {
      revalidate: 120,
      tags: ['catalogo', `produto:${slug}`],
      timeoutMs: 12000,
    });

    return {
      product: toProduct(detail, detail),
      description: detail.description ?? '',
      shortDescription: detail.shortDescription ?? '',
    };
  } catch {
    return null;
  }
}

/** "Você também vai amar" — mesma categoria, por popularidade. */
export async function getRelated(slug: string): Promise<Product[]> {
  const related = await apiSafe<WcListItem[]>(
    `/public/vitrine/${encodeURIComponent(slug)}/related`,
    [],
    { revalidate: 600, tags: ['catalogo'] },
  );
  return related.map((item) => toProduct(item));
}
