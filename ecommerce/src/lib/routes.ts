import type { UrlObject } from 'url';

/**
 * ROTAS QUE EXISTEM DE VERDADE
 *
 * A navegação (menu, cards, footer) já aponta pra ~85 rotas do desenho final
 * da loja, mas só um punhado existe em `src/app`. O `<Link>` do Next faz
 * prefetch de tudo que entra em viewport, então cada link órfão vira uma
 * requisição RSC que volta 404 — barulho no console, banda gasta na dobra
 * mais cara da página e ruído em cima do LCP.
 *
 * Este módulo é a lista branca. O `AppLink` consulta ela e desliga o prefetch
 * de quem ainda não nasceu; o link continua clicável (cai no not-found), e no
 * dia em que a página existir basta acrescentá-la aqui pro prefetch voltar.
 *
 * MANUTENÇÃO: criou página nova em `src/app`? Acrescente o padrão aqui.
 */
const BUILT_ROUTES: readonly (string | RegExp)[] = [
  '/',
  '/busca',
  '/carrinho',
  '/checkout',
  '/debug/search',
  '/debug/tracking',
  /^\/categoria\/[^/]+$/,
  /^\/produto\/[^/]+$/,
  /^\/checkout\/confirmacao\/[^/]+$/,
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
