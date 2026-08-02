import type { NavItem } from '@/types';

/**
 * ESTRUTURA DE NAVEGAÇÃO — fonte única do menu, do mega menu, do drawer
 * mobile e do sitemap. Adicionar um eixo aqui propaga pra todos.
 *
 * A ordem segue a forma como a cliente pensa (não a árvore do ERP):
 * primeiro desejo (Novidades, Looks, Ocasiões), depois categoria técnica.
 *
 * As imagens dos cards editoriais são TEMPORÁRIAS (royalty-free) — trocar
 * pelas fotos de campanha da marca. Ver docs/navigation.md.
 */

/**
 * Cards do mega menu: nunca passam de ~340px de largura. Pedir o original de
 * 5 MB ao Unsplash só pra devolver 320px é desperdício puro no otimizador —
 * ver a explicação completa em `data/content.ts`.
 */
function unsplash(id: string, width = 800): string {
  return `https://images.unsplash.com/${id}?w=${width}&q=85&fm=jpg&fit=max`;
}

const EDITORIAL = {
  novidades: unsplash('photo-1657550853452-f13aa437f6c9'),
  looks: unsplash('photo-1664893876112-64c308bf0d70'),
  ocasioes: unsplash('photo-1582745140877-0480c22d91ee'),
  categorias: unsplash('photo-1603400521630-9f2de124b33b'),
  tecidos: unsplash('photo-1441984904996-e0b6ba687e04'),
  colecoes: unsplash('photo-1652288832306-73735bbb94b3'),
  tamanhos: unsplash('photo-1657549091422-3b748b8f72b2'),
  outlet: unsplash('photo-1441986300917-64674bd600d8'),
} as const;

export const navigation: NavItem[] = [
  {
    label: 'Novidades',
    href: '/novidades',
    icon: 'Sparkles',
    menu: {
      columns: [
        {
          title: 'Acabou de chegar',
          links: [
            { label: 'Lançamentos da semana', href: '/novidades/lancamentos', highlight: true },
            { label: 'Coleção atual', href: '/novidades/colecao-atual' },
            { label: 'Reposições', href: '/novidades/reposicoes' },
            { label: 'Mais vendidos', href: '/novidades/mais-vendidos' },
            { label: 'Últimas peças', href: '/novidades/ultimas-pecas' },
          ],
        },
      ],
      features: [
        {
          eyebrow: 'Coleção',
          title: 'A nova estação chegou',
          description: 'Peças pensadas pro corpo real, do 46 ao 60.',
          image: { src: EDITORIAL.novidades, alt: 'Nova coleção Lurds Plus Size' },
          href: '/novidades/lancamentos',
          cta: 'Ver a coleção',
        },
      ],
    },
  },
  {
    label: 'Looks',
    href: '/looks',
    icon: 'Shirt',
    menu: {
      columns: [
        {
          title: 'Looks prontos',
          links: [
            { label: 'Look trabalho', href: '/looks/trabalho' },
            { label: 'Look casual', href: '/looks/casual' },
            { label: 'Look festa', href: '/looks/festa' },
            { label: 'Look praia', href: '/looks/praia' },
            { label: 'Look viagem', href: '/looks/viagem' },
            { label: 'Look executivo', href: '/looks/executivo' },
            { label: 'Look fim de semana', href: '/looks/fim-de-semana' },
          ],
        },
      ],
      features: [
        {
          eyebrow: 'Shop the look',
          title: 'Leve o look completo',
          description: 'A composição inteira em um clique — ou peça por peça.',
          image: { src: EDITORIAL.looks, alt: 'Look completo plus size' },
          href: '/looks',
          cta: 'Comprar looks',
        },
      ],
      quickLinks: [{ label: 'Comprar o look completo', href: '/looks?modo=completo' }],
    },
  },
  {
    label: 'Ocasiões',
    href: '/ocasioes',
    icon: 'CalendarHeart',
    menu: {
      columns: [
        {
          title: 'Dia a dia',
          links: [
            { label: 'Trabalho', href: '/ocasioes/trabalho' },
            { label: 'Dia a dia', href: '/ocasioes/dia-a-dia' },
            { label: 'Igreja', href: '/ocasioes/igreja' },
          ],
        },
        {
          title: 'Momentos especiais',
          links: [
            { label: 'Casamento', href: '/ocasioes/casamento' },
            { label: 'Aniversário', href: '/ocasioes/aniversario' },
            { label: 'Jantar', href: '/ocasioes/jantar' },
            { label: 'Eventos', href: '/ocasioes/eventos' },
          ],
        },
        {
          title: 'Descanso',
          links: [
            { label: 'Praia', href: '/ocasioes/praia' },
            { label: 'Viagem', href: '/ocasioes/viagem' },
          ],
        },
      ],
      features: [
        {
          eyebrow: 'Convite na mão?',
          title: 'Do casamento ao domingo',
          description: 'A gente te ajuda a escolher pela ocasião, não pelo tamanho.',
          image: { src: EDITORIAL.ocasioes, alt: 'Vestido de festa plus size' },
          href: '/ocasioes/casamento',
          cta: 'Ver por ocasião',
        },
      ],
    },
  },
  {
    label: 'Categorias',
    href: '/categoria',
    icon: 'LayoutGrid',
    menu: {
      columns: [
        {
          title: 'Peças',
          links: [
            { label: 'Vestidos', href: '/categoria/vestidos', highlight: true },
            { label: 'Blusas', href: '/categoria/blusas' },
            { label: 'Calças', href: '/categoria/calcas' },
            { label: 'Conjuntos', href: '/categoria/conjuntos' },
            { label: 'Macacões', href: '/categoria/macacoes' },
          ],
        },
        {
          title: 'Complementos',
          links: [
            { label: 'Jaquetas', href: '/categoria/jaquetas' },
            { label: 'Saias', href: '/categoria/saias' },
            { label: 'Shorts', href: '/categoria/shorts' },
            { label: 'Moda praia', href: '/categoria/moda-praia' },
            { label: 'Fitness', href: '/categoria/fitness' },
          ],
        },
      ],
      features: [
        {
          eyebrow: 'Campeã de vendas',
          title: 'Vestidos que vestem bem',
          description: 'A categoria mais amada da Lurds, do casual ao festa.',
          image: { src: EDITORIAL.categorias, alt: 'Vestidos plus size' },
          href: '/categoria/vestidos',
          cta: 'Ver vestidos',
        },
      ],
    },
  },
  {
    label: 'Tecidos',
    href: '/tecidos',
    icon: 'Layers',
    menu: {
      columns: [
        {
          title: 'Por tecido',
          links: [
            { label: 'Viscolycra premium', href: '/tecidos/viscolycra-premium', highlight: true },
            { label: 'Jeans', href: '/tecidos/jeans' },
            { label: 'Linho', href: '/tecidos/linho' },
            { label: 'Crepe', href: '/tecidos/crepe' },
            { label: 'Tricot', href: '/tecidos/tricot' },
            { label: 'Malha', href: '/tecidos/malha' },
            { label: 'Alfaiataria', href: '/tecidos/alfaiataria' },
          ],
        },
      ],
      features: [
        {
          eyebrow: 'Guia de tecidos',
          title: 'O caimento começa no tecido',
          description: 'Entenda qual tecido veste melhor o seu corpo.',
          image: { src: EDITORIAL.tecidos, alt: 'Tecidos da coleção Lurds' },
          href: '/tecidos',
          cta: 'Conhecer tecidos',
        },
      ],
    },
  },
  {
    label: 'Coleções',
    href: '/colecoes',
    icon: 'BookOpen',
    menu: {
      columns: [
        {
          title: 'Coleções',
          links: [
            { label: 'Coleção atual', href: '/colecoes/atual' },
            { label: 'Alfaiataria Lurds', href: '/colecoes/alfaiataria' },
            { label: 'Festa & Cerimônia', href: '/colecoes/festa' },
            { label: 'Verão Litoral', href: '/colecoes/verao-litoral' },
            { label: 'Essenciais', href: '/colecoes/essenciais' },
          ],
        },
      ],
      features: [
        {
          eyebrow: 'Editorial',
          title: 'A coleção em imagens',
          description: 'Um editorial completo pra inspirar o seu próximo look.',
          image: { src: EDITORIAL.colecoes, alt: 'Editorial de coleção Lurds' },
          href: '/colecoes/atual',
          cta: 'Ver editorial',
        },
      ],
    },
  },
  {
    label: 'Tamanhos',
    href: '/tamanhos',
    icon: 'Ruler',
    menu: {
      columns: [
        {
          title: 'Do 46 ao 60',
          links: [
            { label: '46', href: '/tamanhos/46' },
            { label: '48', href: '/tamanhos/48' },
            { label: '50', href: '/tamanhos/50' },
            { label: '52', href: '/tamanhos/52' },
          ],
        },
        {
          title: ' ',
          links: [
            { label: '54', href: '/tamanhos/54' },
            { label: '56', href: '/tamanhos/56' },
            { label: '58', href: '/tamanhos/58' },
            { label: '60', href: '/tamanhos/60' },
          ],
        },
      ],
      features: [
        {
          eyebrow: 'Tabela de medidas',
          title: 'Descubra a sua numeração',
          description: 'Três medidas e a gente te diz o tamanho certo.',
          image: { src: EDITORIAL.tamanhos, alt: 'Guia de tamanhos plus size' },
          href: '/tamanhos/guia',
          cta: 'Ver guia de medidas',
        },
      ],
    },
  },
  {
    label: 'Nossas Lojas',
    href: '/lojas',
    icon: 'MapPin',
    menu: {
      columns: [
        {
          title: 'Visite a Lurds',
          links: [
            { label: 'Encontrar loja', href: '/lojas', highlight: true },
            { label: 'Comprar e retirar', href: '/lojas/comprar-e-retirar' },
            { label: 'Falar no WhatsApp', href: '/lojas#whatsapp' },
            { label: 'Eventos nas lojas', href: '/lojas/eventos' },
          ],
        },
      ],
    },
  },
  {
    label: 'Outlet',
    href: '/outlet',
    icon: 'Tag',
  },
];

/** Barra superior — mensagens rotativas. Campanha nova = só editar aqui. */
export const announcements = [
  { label: 'Frete grátis acima de R$ 399', href: '/institucional/frete' },
  { label: 'Até 12x sem juros', href: '/institucional/pagamento' },
  { label: 'Troca fácil em 30 dias', href: '/institucional/trocas' },
  { label: '14 lojas em São Paulo e região', href: '/lojas' },
  { label: 'Fale com uma consultora no WhatsApp', href: '/lojas#whatsapp' },
];

/** Atalhos do drawer mobile (abaixo dos eixos principais). */
export const accountLinks = [
  { label: 'Minha conta', href: '/conta', icon: 'User' },
  { label: 'Meus pedidos', href: '/conta/pedidos', icon: 'Package' },
  { label: 'Favoritos', href: '/conta/favoritos', icon: 'Heart' },
  { label: 'Sacola', href: '/carrinho', icon: 'ShoppingBag' },
];

/** Buscas mais frequentes — alimentam o estado vazio do overlay de busca. */
export const popularSearches = [
  'Vestido preto',
  'Vestido casamento',
  'Roupa para igreja',
  'Look trabalho',
  'Conjunto viscolycra',
  'Calça jeans',
  'Macacão',
  'Blusa manga longa',
];
