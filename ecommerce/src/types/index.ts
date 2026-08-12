/**
 * TIPOS DE DOMÍNIO — Lurds Plus Size ecommerce
 *
 * Contrato único entre UI, services e (futuramente) a API do FlowOps.
 * Toda tela consome estes tipos; nenhum componente inventa shape próprio.
 * Preços SEMPRE em REAIS (number), nunca centavos — ver docs/architecture.md.
 */

/* --------------------------------------------------------------- PRIMITIVOS */

export type Id = string;

export interface Media {
  src: string;
  alt: string;
  /** Proporção usada pelo componente (não altera o arquivo). */
  aspect?: '1/1' | '3/4' | '4/5' | '4/3' | '16/9' | '21/9';
}

export interface VideoMedia {
  src: string;
  poster: string;
  alt: string;
}

export interface LinkRef {
  label: string;
  href: string;
}

/* ---------------------------------------------------------------- CATÁLOGO */

/** Etiqueta exibida sobre a foto do produto. */
export type ProductBadge = 'novo' | 'promocao' | 'best-seller' | 'exclusivo' | 'loja-fisica' | 'ultimas-pecas';

export interface ProductSize {
  label: string; // "46", "48"…
  available: boolean;
  /** Disponível pra retirada em loja física. */
  inStore?: boolean;
}

export interface ProductColor {
  name: string;
  /** Hex pra swatch. */
  hex: string;
  image?: Media;
}

export interface Product {
  id: Id;
  slug: string;
  name: string;
  /** Categoria principal (slug). */
  category: string;
  subcategory?: string;
  price: number;
  /** Preço anterior — presente só quando há desconto. */
  compareAtPrice?: number;
  /** Preço no Pix (à vista com desconto). */
  pixPrice?: number;
  /**
   * QUEBRA DE PREÇO POR TAMANHO. Vazio/ausente = preço único (o normal).
   * Quando a peça custa um valor do 44 ao 54 e outro do 56 ao 60, os DOIS
   * aparecem — mostrar só o menor faz a cliente do 58 descobrir a diferença
   * no carrinho, que é onde ela desiste.
   */
  priceRanges?: Array<{ from: number; to: number; price: number }>;
  installments?: { times: number; value: number };
  images: Media[];
  colors?: ProductColor[];
  sizes: ProductSize[];
  /** REF/SKU da peça — chave da ficha de caimento do Lurds Fit AI. */
  sku?: string;
  badges?: ProductBadge[];
  fabric?: string;
  fit?: string;
  occasions?: string[];
  collection?: string;
  rating?: { average: number; count: number };
  /**
   * PEÇAS JÁ VENDIDAS desta família — loja física + site + histórico do ERP
   * antigo. É a prova social que a loja PODE mostrar: número conferível no
   * caixa, no lugar da avaliação inventada que saiu do ar em 06/08. A partir
   * de quanto ele aparece é decisão do `SeloVendas`, num lugar só.
   */
  sold?: number;
  /** Disponibilidade — preparado pra comprar-e-retirar. */
  availability?: {
    online: boolean;
    stores: string[]; // slugs das lojas com estoque
    pickup: boolean;
  };
}

/* ------------------------------------------------------------------- LOOKS */

export interface Look {
  id: Id;
  slug: string;
  title: string;
  description?: string;
  image: Media;
  /** Produtos que compõem o look, com a posição do pin sobre a foto (%). */
  items: { product: Product; hotspot?: { x: number; y: number } }[];
  totalPrice: number;
}

/* -------------------------------------------------------- EIXOS DE NAVEGAÇÃO */

/** Card de navegação por eixo (categoria, ocasião, tecido, modelagem). */
export interface TaxonomyCard {
  slug: string;
  title: string;
  description?: string;
  image?: Media;
  /** Ícone opcional (nome do ícone Lucide). */
  icon?: string;
  href: string;
  /** Cor de identidade — usada nos cards de tecido. */
  tone?: string;
}

/* ------------------------------------------------------------------- LOJAS */

export interface StoreHours {
  display: string[];
  schema: { days: string[]; opens: string; closes: string }[];
}

export interface Store {
  slug: string;
  unit: string;
  city: string;
  uf: string;
  description: string;
  address: {
    street: string;
    neighborhood: string;
    city: string;
    uf: string;
    zip: string | null;
  };
  phone: string;
  whatsapp: string;
  instagram: string;
  hours: StoreHours;
  mapsQuery: string;
  geo: { lat: number; lng: number };
  image?: Media;
}

/* -------------------------------------------------------------- SOCIAL PROOF */

export interface Testimonial {
  id: Id;
  name: string;
  city: string;
  quote: string;
  rating: number;
  avatar?: Media;
  /** Contexto de caimento — o que a cliente plus size realmente quer saber. */
  fit?: { height?: string; weight?: string; sizeBought?: string };
  productName?: string;
}

export interface InstagramPost {
  id: Id;
  image: Media;
  permalink: string;
  likes?: number;
  isVideo?: boolean;
  /** Produtos marcados no post. */
  taggedProducts?: Pick<Product, 'id' | 'name' | 'slug'>[];
}

/* --------------------------------------------------------------- EDITORIAL */

export interface EditorialArticle {
  slug: string;
  eyebrow?: string;
  title: string;
  excerpt: string;
  image: Media;
  href: string;
  readingTime?: string;
}

/* -------------------------------------------------------- FILTROS / LISTAGEM */

export type SortOption =
  | 'relevancia'
  | 'mais-vendidos'
  | 'novidades'
  | 'menor-preco'
  | 'maior-preco'
  | 'maior-desconto'
  | 'mais-avaliados'
  | 'lancamentos';

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
  /** Swatch pro filtro de cor. */
  hex?: string;
}

export interface FilterGroup {
  id: string;
  label: string;
  type: 'checkbox' | 'swatch' | 'range' | 'toggle' | 'size';
  options?: FilterOption[];
  range?: { min: number; max: number };
  /** Grupo aberto por padrão na sidebar. */
  defaultOpen?: boolean;
}

/** Estado de filtro serializável (vai e volta da URL). */
export type FilterState = Record<string, string[] | [number, number] | boolean | undefined>;

export interface ProductQuery {
  category?: string;
  /** Segundo nível da árvore do site: 'manga-curta' dentro de 'blusas'. */
  subcategoria?: string;
  search?: string;
  sort?: SortOption;
  filters?: FilterState;
  page?: number;
  perPage?: number;
  /**
   * Teto de preço da VITRINE (as faixas "Até R$ 59,90"). Diferente do filtro
   * de preço de propósito: filtro a cliente tira no botão "Limpar", e aí a
   * página "Até R$ 59,90" passaria a mostrar peça de R$ 400. Isto é
   * propriedade da rota — só aperta o teto que já veio dos filtros, nunca
   * afrouxa.
   */
  tetoDePreco?: number;
  /** Só peça com desconto — é o que define a vitrine do Outlet. */
  soPromocao?: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
}

/* ----------------------------------------------------------------- CARRINHO */

export interface CartLine {
  id: Id;
  productId: Id;
  slug: string;
  name: string;
  image: Media;
  size: string;
  color?: string;
  quantity: number;
  unitPrice: number;
}

/* ---------------------------------------------------------------- NAVEGAÇÃO */

export interface MenuLink {
  label: string;
  href: string;
  /** Marca visual de destaque no mega menu. */
  highlight?: boolean;
}

export interface MenuColumn {
  title: string;
  links: MenuLink[];
  /**
   * Como os links se desenham. `lista` (padrão) é a coluna de texto de sempre.
   *
   * `pilulas` é pra rótulo CURTO em conjunto fechado — hoje só a numeração.
   * Os tamanhos eram nove links de texto empilhados em duas colunas, a segunda
   * com o título em branco pra fingir continuação: ocupava meia tela, parecia
   * um índice e não uma régua de tamanhos, e a cliente não batia o olho e via
   * "44 ao 60". Como pílula, o conjunto inteiro cabe em duas linhas e se lê de
   * uma vez.
   */
  layout?: 'lista' | 'pilulas';
}

/** Card editorial dentro do mega menu. */
export interface MenuFeature {
  eyebrow?: string;
  title: string;
  description?: string;
  image: Media;
  href: string;
  cta?: string;
}

export interface NavItem {
  label: string;
  href: string;
  /** Nome do ícone Lucide exibido no drawer mobile. */
  icon?: string;
  /** Sem mega menu = link direto. */
  menu?: {
    columns: MenuColumn[];
    features?: MenuFeature[];
    quickLinks?: MenuLink[];
  };
}

/* -------------------------------------------------------------------- BUSCA */

export type SearchResultKind = 'produto' | 'categoria' | 'look' | 'colecao' | 'ocasiao' | 'loja';

export interface SearchResult {
  kind: SearchResultKind;
  label: string;
  href: string;
  /** Linha de apoio (preço, cidade, etc). */
  meta?: string;
  image?: Media;
}
