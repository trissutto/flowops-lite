import type { MetadataRoute } from 'next';
import { SITE } from '@/lib/seo';
import { navigation } from '@/data/navigation';

/**
 * Sitemap gerado a partir da navegação real — quando um eixo novo entra no
 * mega menu, ele aparece aqui automaticamente. Produtos e categorias dinâmicos
 * serão anexados quando o catálogo vier da API.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: SITE.url, changeFrequency: 'daily' as const, priority: 1 },
    { url: `${SITE.url}/lojas`, changeFrequency: 'monthly' as const, priority: 0.9 },
  ].map((entry) => ({ ...entry, lastModified: now }));

  const menuRoutes: MetadataRoute.Sitemap = navigation.flatMap((item) => {
    const own = { url: `${SITE.url}${item.href}`, lastModified: now, priority: 0.8 };
    const children = (item.menu?.columns ?? []).flatMap((column) =>
      column.links.map((link) => ({
        url: `${SITE.url}${link.href}`,
        lastModified: now,
        priority: 0.7,
      })),
    );
    return [own, ...children];
  });

  // Dedup por URL — o mesmo destino pode aparecer em mais de uma coluna.
  const seen = new Set<string>();
  return [...staticRoutes, ...menuRoutes].filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
}
