import type { UrlObject } from 'url';

/**
 * ROTAS QUE EXISTEM DE VERDADE
 *
 * A navegação (menu, cards, footer) foi escrita pro desenho FINAL da loja e
 * aponta pra dezenas de rotas que ainda não existem em `src/app` — medição de
 * 10/08/2026: **49 destinos internos mortos** contra 27 páginas reais,
 * concentrados em `/ocasioes` (9), `/looks` (8), `/institucional` (6),
 * `/modelagem` (6) e `/tecidos` (6).
 *
 * Esta lista tem DOIS usos, e o segundo nasceu na auditoria de lançamento:
 *
 *  1. `AppLink` desliga o prefetch de quem ainda não nasceu (cada link órfão
 *     em viewport viraria uma requisição RSC 404 — banda gasta na dobra mais
 *     cara da página e ruído em cima do LCP).
 *
 *  2. `filtrarLinksVivos` ESCONDE esses links do menu e do rodapé. Antes eles
 *     continuavam clicáveis "caindo no not-found", o que era aceitável num
 *     site em construção e deixa de ser no dia em que entra tráfego pago: a
 *     cliente clica em "Formas de pagamento" no rodapé — justo a dúvida que
 *     estava travando a compra dela — e leva um 404 da loja.
 *
 * Some o link em vez de apagar o item: o desenho final segue registrado em
 * `data/navigation.ts` e no `Footer`, e cada página que nascer reaparece
 * sozinha na navegação ao ser acrescentada aqui.
 *
 * MANUTENÇÃO: criou página nova em `src/app`? Acrescente o padrão aqui —
 * senão ela existe e ninguém acha.
 */
const BUILT_ROUTES: readonly (string | RegExp)[] = [
  '/',
  '/busca',
  '/carrinho',
  '/checkout',
  '/lojas',
  '/novidades',
  '/outlet',
  '/mais-top-da-semana',
  '/mais-vendidos-nas-lojas',
  '/categoria',
  '/tamanhos',
  '/tamanhos/guia',
  '/politica-de-trocas',
  '/privacidade',
  '/termos',
  // Tela nativa desde 10/08/2026 (antes era redirect pro FlowOps).
  '/trocas',
  '/conta',
  // Registradas em 19/08: a de avaliações nasceu na sprint do centro de
  // avaliação e não foi anotada aqui — sem isso o prefetch dela fica desligado
  // e ela some de qualquer menu filtrado por `filtrarLinksVivos`.
  '/conta/avaliacoes',
  '/conta/cashback',
  '/conta/dados',
  '/conta/enderecos',
  '/conta/favoritos',
  '/conta/pedidos',
  '/debug/search',
  '/debug/tracking',
  /^\/ate\/[^/]+$/,
  /^\/categoria\/[^/]+$/,
  /^\/produto\/[^/]+$/,
  /^\/pedido\/[^/]+$/,
  /^\/tamanhos\/[^/]+$/,
  /^\/checkout\/confirmacao\/[^/]+$/,
  // Página POR PEDIDO, aberta pelo link que o convite manda no WhatsApp.
  /^\/avaliar\/[^/]+$/,
];

type Href = string | UrlObject;

/**
 * Caminho interno de um href, ou `null` quando não há o que prefetchar
 * (link externo, âncora, mailto/tel). O Next só faz prefetch de rota interna.
 */
function internalPathname(href: Href): string | null {
  if (typeof href !== 'string') return href.pathname ?? null;
  if (!href.startsWith('/')) return null;
  return href.split(/[?#]/, 1)[0];
}

/** `true` quando a rota já tem página em `src/app`. */
export function isBuiltRoute(href: Href): boolean {
  const pathname = internalPathname(href);
  if (pathname === null) return true;
  return BUILT_ROUTES.some((route) =>
    typeof route === 'string' ? route === pathname : route.test(pathname),
  );
}

/**
 * Filtra uma lista de links de navegação, deixando só os que levam a algum
 * lugar. Link externo, âncora e `mailto:`/`tel:` passam sempre (o
 * `isBuiltRoute` já devolve `true` pra eles).
 *
 * Genérico no formato do item porque menu, rodapé e destaque do mega menu têm
 * cada um o seu tipo — todos com `href`.
 */
export function filtrarLinksVivos<T extends { href: Href }>(links: readonly T[] | undefined): T[] {
  if (!links) return [];
  return links.filter((l) => isBuiltRoute(l.href));
}
