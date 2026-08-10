import type {
  EditorialArticle,
  InstagramPost,
  Look,
  Product,
  TaxonomyCard,
  Testimonial,
} from '@/types';

/**
 * CONTEÚDO DE VITRINE
 *
 * ⚠️ PLACEHOLDER ESTRUTURAL. Nomes, preços e fotos aqui existem só pra dar
 * forma às seções enquanto o catálogo real não vem da API do FlowOps. Nada
 * disso é conteúdo aprovado de marca.
 *
 * O que é REAL: a taxonomia (categorias, ocasiões, tecidos, modelagens) e a
 * faixa de numeração 44–60, que refletem a operação da Lurds.
 *
 * Quando o catálogo entrar: services/products.ts troca a fonte e este arquivo
 * fica apenas com as taxonomias e os textos editoriais.
 */

/**
 * Sem parâmetro, o Unsplash devolve o ORIGINAL — 4 a 6 MB, 5.000+ px de
 * largura. Isso não chega no navegador (o next/image redimensiona), mas o
 * otimizador da Vercel precisa baixar e decodificar esses megabytes a cada
 * cache miss, e é esse tempo que aparece como atraso no primeiro byte da
 * imagem do hero — ou seja, direto no LCP.
 *
 * `fit=max` limita a largura sem cortar nem ampliar; `q=85` deixa folga pro
 * Next reencodar em AVIF/WebP sem compressão dupla visível.
 */
function unsplash(id: string, width = 1600): string {
  return `https://images.unsplash.com/${id}?w=${width}&q=85&fm=jpg&fit=max`;
}

const IMG = {
  model1: unsplash('photo-1657550853452-f13aa437f6c9'),
  model2: unsplash('photo-1664893876112-64c308bf0d70'),
  model3: unsplash('photo-1582745140877-0480c22d91ee'),
  model4: unsplash('photo-1664893875861-add8eb8fa072'),
  model5: unsplash('photo-1657549091422-3b748b8f72b2'),
  model6: unsplash('photo-1652288832306-73735bbb94b3'),
  model7: unsplash('photo-1664893875908-a1e56db71082'),
  model8: unsplash('photo-1657550853399-19c48e1baed2'),
  model9: unsplash('photo-1562887077-e086f7da6870'),
  model10: unsplash('photo-1657550853413-a646ba6a1877'),
  // Hero da home: é a única que ocupa 100vw em tela grande, então merece
  // mais largura de origem que os cards.
  duo: unsplash('photo-1696483680003-1e2109b05ed3', 2000),
  storeInterior: unsplash('photo-1441986300917-64674bd600d8'),
  rack: unsplash('photo-1603400521630-9f2de124b33b'),
  corner: unsplash('photo-1441984904996-e0b6ba687e04'),
  window: unsplash('photo-1521335629791-ce4aec67dd15'),
  consultant: unsplash('photo-1546213290-e1b492ab3eee'),
} as const;

/* ------------------------------------------------------------------ HERO/VÍDEO */

/**
 * Títulos ficam como texto puro (`lead` + `emphasis`) — a página monta o JSX
 * com a palavra de ênfase em itálico dourado. Assim o arquivo de dados
 * continua sendo dados.
 */
export const homeHero = {
  image: {
    src: IMG.duo,
    alt: 'Duas mulheres plus size em produção editorial da nova coleção Lurds',
  },
  eyebrow: 'Nova coleção',
  lead: 'Elegância não tem',
  emphasis: 'tamanho',
  subtitle:
    'Peças pensadas pro corpo real, do 44 ao 60. Caimento que valoriza, tecido que abraça e um atendimento que acolhe.',
};

export const institutionalVideo = {
  src: 'https://videos.pexels.com/video-files/5384960/5384960-hd_1920_1080_25fps.mp4',
  poster: IMG.storeInterior,
  alt: 'Vídeo institucional: por dentro de uma loja Lurds Plus Size',
};

/* ---------------------------------------------------------------- MANIFESTO */

export const manifesto = {
  eyebrow: 'Nosso propósito',
  title: 'Desde 1979 vestindo autoestima.',
  paragraphs: [
    'A Lurds nasceu de uma inconformidade simples: por que roupa bonita só existia até certo número? Décadas depois, seguimos respondendo isso com curadoria — não com tamanho grande de peça pequena.',
    'Cada peça passa pelo teste que importa: veste bem no corpo real, aguenta o dia inteiro e faz você se olhar no espelho com orgulho.',
  ],
  stats: [
    { value: '1979', label: 'Desde' },
    { value: '14', label: 'Lojas' },
    { value: '500 mil+', label: 'Clientes' },
    { value: '44–60', label: 'Numeração' },
  ],
};

/* --------------------------------------------------------------- TAXONOMIAS */

export const occasions: TaxonomyCard[] = [
  { slug: 'trabalho', title: 'Trabalho', description: 'Alfaiataria que respira', href: '/ocasioes/trabalho', image: { src: IMG.model5, alt: 'Look de trabalho plus size' } },
  { slug: 'casamento', title: 'Casamento', description: 'Convidada e madrinha', href: '/ocasioes/casamento', image: { src: IMG.model3, alt: 'Vestido de casamento plus size' } },
  { slug: 'festa', title: 'Festa', description: 'Brilho na medida', href: '/ocasioes/festa', image: { src: IMG.model1, alt: 'Vestido de festa plus size' } },
  { slug: 'viagem', title: 'Viagem', description: 'Não amassa na mala', href: '/ocasioes/viagem', image: { src: IMG.model9, alt: 'Look de viagem plus size' } },
  { slug: 'dia-a-dia', title: 'Casual', description: 'Conforto sem descuido', href: '/ocasioes/dia-a-dia', image: { src: IMG.model2, alt: 'Look casual plus size' } },
  { slug: 'praia', title: 'Praia', description: 'Litoral com estilo', href: '/ocasioes/praia', image: { src: IMG.model4, alt: 'Moda praia plus size' } },
  { slug: 'jantar', title: 'Jantar', description: 'Sofisticado e discreto', href: '/ocasioes/jantar', image: { src: IMG.model10, alt: 'Look de jantar plus size' } },
  { slug: 'igreja', title: 'Igreja', description: 'Elegância serena', href: '/ocasioes/igreja', image: { src: IMG.model7, alt: 'Look para igreja plus size' } },
];

export const fabrics: TaxonomyCard[] = [
  { slug: 'viscolycra-premium', title: 'Viscolycra premium', description: 'Cai como líquido, veste todo dia', href: '/tecidos/viscolycra-premium' },
  { slug: 'jeans', title: 'Jeans', description: 'Estrutura com elastano de verdade', href: '/tecidos/jeans' },
  { slug: 'linho', title: 'Linho', description: 'Fresco pro calor do Brasil', href: '/tecidos/linho' },
  { slug: 'crepe', title: 'Crepe', description: 'Toque seco, caimento nobre', href: '/tecidos/crepe' },
  { slug: 'tricot', title: 'Tricot', description: 'Aconchego sem volume', href: '/tecidos/tricot' },
  { slug: 'alfaiataria', title: 'Alfaiataria', description: 'A peça que resolve a semana', href: '/tecidos/alfaiataria' },
];

/** Modelagem — seção educativa (sem foto, tipografia grande). */
export const fits: TaxonomyCard[] = [
  { slug: 'valoriza-cintura', title: 'Valoriza a cintura', description: 'Recortes e amarrações que marcam a silhueta no lugar certo — sem apertar.', href: '/modelagem/valoriza-cintura' },
  { slug: 'disfarca-barriga', title: 'Disfarça a barriga', description: 'Caimento solto na altura do abdômen, com tecido que não marca.', href: '/modelagem/disfarca-barriga' },
  { slug: 'alonga-silhueta', title: 'Alonga a silhueta', description: 'Linhas verticais, fendas e comprimentos que esticam visualmente.', href: '/modelagem/alonga-silhueta' },
  { slug: 'modelagem-solta', title: 'Modelagem solta', description: 'Liberdade total de movimento pro dia inteiro, sem parecer larga.', href: '/modelagem/modelagem-solta' },
  { slug: 'alfaiataria', title: 'Alfaiataria', description: 'Estrutura que sustenta a postura e resolve qualquer compromisso.', href: '/modelagem/alfaiataria' },
  { slug: 'conforto-total', title: 'Conforto total', description: 'Cós elástico, malha macia e zero incômodo — do home office ao passeio.', href: '/modelagem/conforto-total' },
];

/* ----------------------------------------------------------------- PRODUTOS */

function product(
  id: string,
  name: string,
  category: string,
  price: number,
  images: string[],
  extra: Partial<Product> = {},
): Product {
  return {
    id,
    slug: `${id}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.replace(/-+$/, ''),
    name,
    category,
    price,
    pixPrice: Number((price * 0.95).toFixed(2)),
    installments: { times: 12, value: Number((price / 12).toFixed(2)) },
    images: images.map((src, i) => ({ src, alt: `${name} — foto ${i + 1}` })),
    sizes: ['46', '48', '50', '52', '54', '56', '58', '60'].map((label, i) => ({
      label,
      available: i < 6,
      inStore: i < 4,
    })),
    ...extra,
  };
}

export const newArrivals: Product[] = [
  product('p01', 'Vestido midi em viscolycra', 'vestidos', 289.9, [IMG.model1, IMG.model10], {
    fabric: 'Viscolycra premium',
    badges: ['novo'],
    colors: [
      { name: 'Vinho', hex: '#7a3b46' },
      { name: 'Preto', hex: '#1a1614' },
      { name: 'Areia', hex: '#d9cdb4' },
    ],
    rating: { average: 4.8, count: 126 },
  }),
  product('p02', 'Conjunto alfaiataria fluida', 'conjuntos', 429.9, [IMG.model2, IMG.model7], {
    fabric: 'Alfaiataria',
    badges: ['novo', 'exclusivo'],
    compareAtPrice: 529.9,
    rating: { average: 4.9, count: 84 },
  }),
  product('p03', 'Blusa gola alta em malha', 'blusas', 179.9, [IMG.model5, IMG.model2], {
    fabric: 'Malha',
    badges: ['novo'],
    rating: { average: 4.7, count: 203 },
  }),
  product('p04', 'Calça pantalona crepe', 'calcas', 259.9, [IMG.model9, IMG.model4], {
    fabric: 'Crepe',
    badges: ['novo'],
    colors: [
      { name: 'Preto', hex: '#1a1614' },
      { name: 'Off white', hex: '#f1eadf' },
    ],
    rating: { average: 4.6, count: 91 },
  }),
];

export const bestSellers: Product[] = [
  product('p05', 'Vestido envelope clássico', 'vestidos', 319.9, [IMG.model3, IMG.model1], {
    fabric: 'Crepe',
    badges: ['best-seller'],
    rating: { average: 4.9, count: 412 },
  }),
  product('p06', 'Macacão pantalona', 'macacoes', 349.9, [IMG.model4, IMG.model8], {
    fabric: 'Viscolycra premium',
    badges: ['best-seller'],
    compareAtPrice: 419.9,
    rating: { average: 4.8, count: 288 },
  }),
  product('p07', 'Calça jeans cintura alta', 'calcas', 279.9, [IMG.model7, IMG.model5], {
    fabric: 'Jeans',
    badges: ['best-seller', 'loja-fisica'],
    rating: { average: 4.7, count: 531 },
  }),
  product('p08', 'Blazer alfaiataria estruturado', 'jaquetas', 389.9, [IMG.model10, IMG.model3], {
    fabric: 'Alfaiataria',
    badges: ['best-seller'],
    rating: { average: 4.9, count: 176 },
  }),
];

/* -------------------------------------------------------------------- LOOKS */

export const looks: Look[] = [
  {
    id: 'l01',
    slug: 'look-trabalho-alfaiataria',
    title: 'Segunda resolvida',
    description: 'Alfaiataria leve que vai da reunião ao happy hour.',
    image: { src: IMG.model2, alt: 'Look de trabalho: blazer, blusa e calça de alfaiataria' },
    items: [
      { product: bestSellers[3], hotspot: { x: 38, y: 30 } },
      { product: newArrivals[2], hotspot: { x: 52, y: 46 } },
      { product: newArrivals[3], hotspot: { x: 46, y: 72 } },
    ],
    totalPrice: 389.9 + 179.9 + 259.9,
  },
  {
    id: 'l02',
    slug: 'look-festa-vinho',
    title: 'Convite aceito',
    description: 'O vestido que resolve casamento, formatura e aniversário.',
    image: { src: IMG.model1, alt: 'Look de festa: vestido midi em viscolycra' },
    items: [
      { product: newArrivals[0], hotspot: { x: 50, y: 44 } },
      { product: bestSellers[0], hotspot: { x: 62, y: 66 } },
    ],
    totalPrice: 289.9 + 319.9,
  },
  {
    id: 'l03',
    slug: 'look-fim-de-semana',
    title: 'Domingo devagar',
    description: 'Jeans e malha: o conforto que continua elegante.',
    image: { src: IMG.model7, alt: 'Look de fim de semana: jeans e blusa de malha' },
    items: [
      { product: bestSellers[2], hotspot: { x: 46, y: 62 } },
      { product: newArrivals[2], hotspot: { x: 50, y: 32 } },
    ],
    totalPrice: 279.9 + 179.9,
  },
];

/* --------------------------------------------------------------- DEPOIMENTOS */

export const testimonials: Testimonial[] = [
  {
    id: 't01',
    name: 'Cliente Lurds',
    city: 'São Paulo · SP',
    quote: 'As roupas vestem super bem, valorizam o corpo de verdade e têm muita qualidade.',
    rating: 5,
    fit: { height: '1,62 m', weight: '92 kg', sizeBought: '50' },
    productName: 'Vestido envelope clássico',
  },
  {
    id: 't02',
    name: 'Cliente Lurds',
    city: 'Campinas · SP',
    quote: 'Atendimento acolhedor do começo ao fim. Saí da loja me sentindo linda.',
    rating: 5,
    fit: { height: '1,70 m', weight: '105 kg', sizeBought: '54' },
    productName: 'Conjunto alfaiataria fluida',
  },
  {
    id: 't03',
    name: 'Cliente Lurds',
    city: 'Santos · SP',
    quote: 'Finalmente uma loja onde eu provo, gosto e levo. O caimento é perfeito.',
    rating: 5,
    fit: { height: '1,58 m', weight: '88 kg', sizeBought: '48' },
    productName: 'Calça jeans cintura alta',
  },
  {
    id: 't04',
    name: 'Cliente Lurds',
    city: 'Jundiaí · SP',
    quote: 'Qualidade impecável e um provador sem pressa. Virou minha loja de sempre.',
    rating: 5,
    fit: { height: '1,66 m', weight: '110 kg', sizeBought: '56' },
    productName: 'Macacão pantalona',
  },
];

/* ---------------------------------------------------------------- INSTAGRAM */

/** Perfil oficial. Num lugar só — aparece no card, no CTA e no rodapé. */
export const PERFIL_INSTAGRAM = 'https://www.instagram.com/lurdsplussize';

/**
 * GRADE DO INSTAGRAM — vitrine visual que leva pro perfil.
 *
 * ⚠️ NÚMERO DE CURTIDA E "PEÇAS MARCADAS" SAÍRAM EM 10/08/2026.
 *
 * Cada card trazia uma contagem de curtidas (1.284, 2.130, 1.755…) que
 * NINGUÉM mediu — número escrito à mão, apresentado como engajamento real. É
 * o mesmo problema que tirou os depoimentos do ar em 06/08: prova social
 * fabricada é publicidade enganosa (CDC), não licença poética. E as "peças
 * marcadas" apontavam pros produtos de maquete, que não existem no catálogo:
 * o card prometia atalho de compra pra peça nenhuma.
 *
 * O que ficou é honesto: uma grade de fotos que leva ao perfil. Sem número
 * inventado, sem promessa de compra que não se cumpre.
 *
 * AS FOTOS AINDA SÃO DE BANCO DE IMAGEM. Trocar pelas do feed real da
 * @lurdsplussize é o passo que falta — aí o `permalink` de cada card pode
 * apontar pro post específico em vez do perfil, e a seção passa a ser prova
 * social de verdade.
 */
export const instagramPosts: InstagramPost[] = [
  { id: 'i01', image: { src: IMG.model1, alt: 'Cliente com vestido midi Lurds' }, permalink: PERFIL_INSTAGRAM },
  { id: 'i02', image: { src: IMG.rack, alt: 'Novidades na arara da loja' }, permalink: PERFIL_INSTAGRAM },
  { id: 'i03', image: { src: IMG.model4, alt: 'Macacão pantalona Lurds' }, permalink: PERFIL_INSTAGRAM, isVideo: true },
  { id: 'i04', image: { src: IMG.model5, alt: 'Look de trabalho Lurds' }, permalink: PERFIL_INSTAGRAM },
  { id: 'i05', image: { src: IMG.corner, alt: 'Corner de looks da loja' }, permalink: PERFIL_INSTAGRAM },
  { id: 'i06', image: { src: IMG.model8, alt: 'Vestido de festa Lurds' }, permalink: PERFIL_INSTAGRAM },
];

/* --------------------------------------------------------------- EDITORIAL */

export const editorials: EditorialArticle[] = [
  {
    slug: 'como-escolher-vestido-casamento',
    eyebrow: 'Guia',
    title: 'O vestido certo pro casamento que você foi convidada',
    excerpt:
      'Cerimônia de dia, à noite, na praia ou no campo: o que muda no tecido, no comprimento e no caimento — e o que nunca muda.',
    image: { src: IMG.model3, alt: 'Editorial: vestidos de casamento plus size' },
    href: '/blog/como-escolher-vestido-casamento',
    readingTime: '6 min',
  },
  {
    slug: 'guia-viscolycra',
    eyebrow: 'Tecidos',
    title: 'Por que a viscolycra virou nossa peça mais pedida',
    excerpt: 'Cai bem, não marca, não amassa e aceita o dia inteiro. Entenda o tecido.',
    image: { src: IMG.model2, alt: 'Editorial: viscolycra premium' },
    href: '/blog/guia-viscolycra',
    readingTime: '4 min',
  },
  {
    slug: 'alfaiataria-plus-size',
    eyebrow: 'Modelagem',
    title: 'Alfaiataria plus size: a peça que resolve a semana',
    excerpt: 'Como escolher o blazer que estrutura sem endurecer a silhueta.',
    image: { src: IMG.model10, alt: 'Editorial: alfaiataria plus size' },
    href: '/blog/alfaiataria-plus-size',
    readingTime: '5 min',
  },
];

/** Grade editorial da seção "Editorial da semana". */
export const editorialGridItems = [
  { image: { src: IMG.model6, alt: 'Editorial da semana — abertura' }, caption: 'Bastidores da coleção', href: '/colecoes/atual' },
  { image: { src: IMG.window, alt: 'Vitrine da semana' }, caption: 'Vitrine da semana' },
  { image: { src: IMG.model9, alt: 'Detalhe de caimento' }, caption: 'O caimento de perto' },
];

export const peopleImage = { src: IMG.consultant, alt: 'Consultora Lurds atendendo uma cliente na loja' };
export const storeInteriorImage = { src: IMG.storeInterior, alt: 'Interior de uma loja Lurds Plus Size' };
