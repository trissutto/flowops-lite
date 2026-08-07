import type { NavItem } from '@/types';

/**
 * ESTRUTURA DE NAVEGAÇÃO — fonte única do menu, do mega menu, do drawer
 * mobile e do sitemap. Adicionar um eixo aqui propaga pra todos.
 *
 * ORDEM DEFINIDA PELO DONO (03/08/2026), sete eixos:
 *   Novidades · Categorias · Looks · Tamanho · Tecidos · Outlet · Nossas Lojas
 *
 * Ocasiões e Coleções SAÍRAM do menu — não por design, por dado: nenhuma peça
 * está classificada nesses eixos ainda, e eixo sem produto vira vitrine vazia.
 * Os blocos voltam quando o cadastro estiver preenchido (o campo já existe na
 * ficha do produto).
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
        /**
         * POR PREÇO (dono, 06/08). Fica dentro de Categorias em vez de virar
         * um oitavo eixo no topo: a ordem dos sete eixos foi decisão dele em
         * 03/08, e preço é um corte da mesma vitrine, não um eixo novo.
         *
         * Estas duas são as ÚNICAS entradas deste menu que hoje apontam pra
         * rota que existe de verdade.
         */
        {
          title: 'Por preço',
          links: [
            { label: 'Até R$ 59,90', href: '/ate/59-90', highlight: true },
            { label: 'Até R$ 99,90', href: '/ate/99-90' },
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
  /**
   * TECIDOS SAIU DO MENU (dono 07/08) — mesma razão de Ocasiões e Coleções:
   * o eixo depende de cadastro que ainda não existe peça a peça, e menu que
   * leva a vitrine vazia gasta a confiança da cliente. O foco agora é
   * CATEGORIAS e TAMANHOS, que têm dado de verdade por trás.
   *
   * As rotas /tecidos continuam de pé (link antigo e Google não quebram);
   * só o item do menu saiu. Voltar é descomentar quando o cadastro andar.
   */
  {
    label: 'Outlet',
    href: '/outlet',
    icon: 'Tag',
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
];

/**
 * Barra superior — mensagens rotativas. Campanha nova = só editar aqui.
 *
 * ⚠️ NÃO repetir valor de frete aqui. A régua virou config (item 22) e este
 * arquivo não a enxerga: "acima de R$ 399" ficou errado no dia em que o dono
 * mudou pra R$ 499,90 na retaguarda, prometendo na barra o que o checkout não
 * daria. Quem sabe o número é a barra de progresso da sacola, que lê a config.
 */
export const announcements = [
  { label: 'Frete grátis nas compras acima do valor da promoção', href: '/institucional/frete' },
  { label: 'Até 12x sem juros', href: '/institucional/pagamento' },
  { label: 'Troca fácil em 30 dias', href: '/politica-de-trocas' },
  { label: '14 lojas em São Paulo e região', href: '/lojas' },
  { label: 'Fale com uma consultora no WhatsApp', href: '/lojas#whatsapp' },
];

/**
 * RODAPÉ LEGAL — as três páginas que precisam estar publicadas e alcançáveis
 * de qualquer tela (itens 81 e 108). Link enterrado em página interna não
 * cumpre a exigência: tem que dar pra achar de onde a cliente estiver.
 */
export const legalLinks = [
  { label: 'Trocas e devoluções', href: '/politica-de-trocas' },
  { label: 'Política de privacidade', href: '/privacidade' },
  { label: 'Termos de uso', href: '/termos' },
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
