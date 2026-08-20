import type { MetadataRoute } from 'next';
import { api } from '@/lib/api';
import { SITE } from '@/lib/seo';
import { navigation } from '@/data/navigation';

/**
 * SITEMAP — o mapa que o Google usa pra achar o que existe aqui.
 *
 * ── POR QUE ISTO DEIXOU DE SER SÓ O MENU ──
 *
 * Até 19/08/2026 este arquivo listava 32 URLs, todas tiradas do mega menu, e o
 * comentário prometia: "produtos e categorias dinâmicos serão anexados quando o
 * catálogo vier da API". O catálogo veio faz tempo.
 *
 * Isso passou a importar de verdade na virada pra `lurds.com.br`: o domínio
 * antigo entrega ~1.800 URLs redirecionadas pra cá, e sem produto no sitemap o
 * Google levaria semanas pra descobrir sozinho onde cada uma foi parar. O
 * intervalo entre "a antiga sumiu" e "achei a nova" é exatamente onde se perde
 * posição.
 *
 * ── A REGRA QUE NÃO PODE SER QUEBRADA ──
 *
 * A URL daqui TEM que ser a mesma do `canonical` da PDP: `/produto/<slug>`,
 * onde `slug` é o do WooCommerce quando a peça veio de lá (`site_produto.slug`)
 * e `ref-<REF>` só quando ela nasceu aqui. É essa a URL que tem 16 meses de
 * histórico no Google. O backend já devolve o slug certo em `/public/loja/feed`
 * — não montar URL por conta própria a partir da REF.
 */

/** O mesmo shape do feed do Meta; aqui só interessa slug e disponibilidade. */
interface PecaFeed {
  ref: string;
  slug: string;
  disponivel: boolean;
}

/**
 * De hora em hora. Peça nova precisa entrar no mapa no mesmo dia, e o custo é
 * um request por hora — o backend já cacheia o catálogo internamente.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const estaticas: MetadataRoute.Sitemap = [
    { url: SITE.url, changeFrequency: 'daily' as const, priority: 1 },
    { url: `${SITE.url}/lojas`, changeFrequency: 'monthly' as const, priority: 0.9 },
    // Rastreio é a 2ª página mais buscada do domínio antigo (2.060 cliques em
    // 90 dias). Entra no mapa desde o primeiro dia.
    { url: `${SITE.url}/rastreio`, changeFrequency: 'monthly' as const, priority: 0.8 },
    { url: `${SITE.url}/trocas`, changeFrequency: 'monthly' as const, priority: 0.5 },
    { url: `${SITE.url}/politica-de-trocas`, changeFrequency: 'yearly' as const, priority: 0.3 },
    { url: `${SITE.url}/privacidade`, changeFrequency: 'yearly' as const, priority: 0.3 },
    { url: `${SITE.url}/termos`, changeFrequency: 'yearly' as const, priority: 0.3 },
  ].map((entry) => ({ ...entry, lastModified: now }));

  const menu: MetadataRoute.Sitemap = navigation.flatMap((item) => {
    const propria = { url: `${SITE.url}${item.href}`, lastModified: now, priority: 0.8 };
    const filhas = (item.menu?.columns ?? []).flatMap((coluna) =>
      coluna.links.map((link) => ({
        url: `${SITE.url}${link.href}`,
        lastModified: now,
        priority: 0.7,
      })),
    );
    return [propria, ...filhas];
  });

  /**
   * O catálogo. Mesma fonte do feed do Meta — uma consulta, um cache, dois
   * consumidores. Se o backend não responder, o sitemap sai só com as páginas
   * fixas em vez de sair vazio: mapa incompleto é ruim, mapa vazio o Google
   * interpreta como "o site esvaziou".
   */
  let pecas: PecaFeed[] = [];
  try {
    pecas = (await api<PecaFeed[]>('/public/loja/feed', {
      revalidate,
      tags: ['catalogo'],
      timeoutMs: 25000,
    })) ?? [];
  } catch {
    /* silêncio proposital — ver acima */
  }

  const produtos: MetadataRoute.Sitemap = pecas
    .filter((p) => p.slug)
    .map((p) => ({
      url: `${SITE.url}/produto/${p.slug}`,
      lastModified: now,
      changeFrequency: 'weekly' as const,
      // Peça esgotada continua no mapa (a página existe e volta a vender
      // quando reabastece), mas com prioridade menor que a disponível.
      priority: p.disponivel ? 0.6 : 0.4,
    }));

  // Dedup por URL — o mesmo destino aparece em mais de uma coluna do menu, e
  // uma peça pode repetir slug se o catálogo vier com linha duplicada.
  const vistas = new Set<string>();
  return [...estaticas, ...menu, ...produtos].filter((entry) => {
    if (vistas.has(entry.url)) return false;
    vistas.add(entry.url);
    return true;
  });
}
