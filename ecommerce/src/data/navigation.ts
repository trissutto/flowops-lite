import type { NavItem } from '@/types';
import { filtrarLinksVivos, isBuiltRoute } from '@/lib/routes';
import { STORE_POLICIES } from '@/data/store-policies';

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
 * OS CARDS DO MENU NÃO TÊM MAIS FOTO (16/08/2026).
 *
 * Eram oito imagens de banco de imagem (Unsplash) ilustrando os eixos —
 * modelos de outra marca abrindo o menu da Lurds. O dono mandou tirar do site
 * TODA foto que não é oficial da casa, e estas foram junto: o card continua,
 * com a arte tipográfica da marca no lugar da foto (ver `MenuCard`). Quando
 * existir foto de campanha NOSSA, basta devolver o campo `image` do card.
 */

/**
 * Desenho COMPLETO da navegação — inclui eixos e sub-links de páginas que
 * ainda não existem. Não exportado direto: passa por `podarNavegacao` logo
 * abaixo, que remove o que levaria a 404. Editar aqui é editar o mapa; o que
 * aparece na tela é o que já foi construído.
 */
const NAVEGACAO_COMPLETA: NavItem[] = [
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
          description: 'Peças pensadas pro corpo real, do 44 ao 60.',
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
          /**
           * Uma coluna só, em pílulas. Eram DUAS colunas de texto (44-52 e
           * 54-60, a segunda com o título preenchido por um espaço não-
           * quebrável pra fingir continuação): ocupava meia tela, parecia
           * índice de documento, e a numeração — que é a primeira pergunta de
           * quem compra plus size — não se lia de relance.
           * Ver `MenuColumn.layout`.
           */
          title: 'Do 44 ao 60',
          layout: 'pilulas',
          links: [
            { label: '44', href: '/tamanhos/44' },
            { label: '46', href: '/tamanhos/46' },
            { label: '48', href: '/tamanhos/48' },
            { label: '50', href: '/tamanhos/50' },
            { label: '52', href: '/tamanhos/52' },
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
  /**
   * MAIS TOP DA SEMANA — vitrine CURADA (não é o catálogo reordenado).
   *
   * Link simples, como Outlet e Troca Fácil: a lista é uma seleção pronta da
   * retaguarda (~20 peças na ordem escolhida), não uma árvore de sub-eixos.
   * Fica ao lado do Outlet porque os dois são recortes de destaque da mesma
   * vitrine, não categorias.
   */
  {
    label: 'Mais Top da Semana',
    href: '/mais-top-da-semana',
    icon: 'Flame',
  },
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
  /**
   * TROCA FÁCIL no topo (dono, 10/08/2026: "ao lado de lojas").
   *
   * Não é enfeite de rodapé: em plus size a dúvida de tamanho é a objeção que
   * mais segura a primeira compra, e saber que a troca é fácil ANTES de
   * comprar é o que destrava. Por isso vai na barra, onde a cliente vê enquanto
   * decide — e não escondido no rodapé, onde só chega quem já tem problema.
   *
   * A página é o portal de /trocas, entregue em 10/08: cliente logada não
   * digita número de pedido nem CPF.
   */
  {
    label: 'Troca Fácil',
    href: '/trocas',
    icon: 'RefreshCw',
  },
];

/**
 * PODA — o menu só mostra o que leva a algum lugar.
 *
 * A navegação acima descreve a loja pronta; a medição de 10/08/2026 achou 49
 * destinos internos mortos contra 27 páginas reais, 17 deles vindo daqui.
 * Enquanto o site estava em construção, link furado "caindo no not-found" era
 * tolerável. Com tráfego pago não é: a cliente abre "Looks" no menu, escolhe
 * "Look festa" e leva um 404 — e não volta.
 *
 * A poda é em cascata, porque esconder só a folha deixa buraco:
 *   · coluna sem nenhum link vivo não aparece;
 *   · eixo que perdeu TODAS as colunas, cards e atalhos vira link simples
 *     (sem mega menu vazio abrindo no hover);
 *   · eixo cujo próprio destino não existe some do menu.
 *
 * Nada é apagado do desenho — página nova entra em `lib/routes.ts` e o link
 * reaparece sozinho.
 */
function podarNavegacao(itens: NavItem[]): NavItem[] {
  const vivos: NavItem[] = [];
  for (const item of itens) {
    if (!isBuiltRoute(item.href)) continue;
    if (!item.menu) {
      vivos.push(item);
      continue;
    }
    const columns = item.menu.columns
      .map((c) => ({ ...c, links: filtrarLinksVivos(c.links) }))
      .filter((c) => c.links.length > 0);
    const features = filtrarLinksVivos(item.menu.features);
    const quickLinks = filtrarLinksVivos(item.menu.quickLinks);

    const temMenu = columns.length > 0 || features.length > 0 || quickLinks.length > 0;
    vivos.push(
      temMenu ? { ...item, menu: { columns, features, quickLinks } } : { ...item, menu: undefined },
    );
  }
  return vivos;
}

export const navigation: NavItem[] = podarNavegacao(NAVEGACAO_COMPLETA);

/**
 * Barra superior — mensagens rotativas. Campanha nova = só editar aqui.
 *
 * ⚠️ NUNCA escreva o valor do frete grátis aqui. A régua virou config (item
 * 22) e este arquivo não a enxerga: "acima de R$ 399" ficou errado no dia em
 * que o dono mudou pra R$ 499,90 na retaguarda — a barra prometia o que o
 * checkout não daria.
 *
 * O dono pediu o valor de volta na barra em 12/08, e ele voltou como
 * `{FRETE_GRATIS}`: o `AnnouncementBar` troca o marcador pelo número que a
 * config diz naquele momento e esconde a frase inteira se o frete grátis
 * estiver desligado. A barra mostra o valor sem nunca inventá-lo.
 */
export const announcements = [
  { label: 'Frete grátis acima de {FRETE_GRATIS}', href: '/carrinho' },
  { label: 'Até 12x sem juros', href: '/carrinho' },
  { label: `Troca fácil em ${STORE_POLICIES.exchangeWindowDays} dias`, href: '/politica-de-trocas' },
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
