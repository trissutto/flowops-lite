import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', () => ({ api: apiMock }));

import sitemap from './sitemap';

describe('sitemap', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue([
      { ref: 'A', slug: 'produto-a', disponivel: true },
      { ref: 'A-duplicado', slug: 'produto-a', disponivel: true },
      { ref: 'B', slug: 'produto-b', disponivel: false },
    ]);
  });

  it('não fabrica lastModified e deduplica URLs do catálogo', async () => {
    const entries = await sitemap();
    const produtos = entries.filter((entry) => entry.url.includes('/produto/'));

    expect(entries.every((entry) => entry.lastModified == null)).toBe(true);
    expect(produtos.map((entry) => new URL(entry.url).pathname)).toEqual([
      '/produto/produto-a',
      '/produto/produto-b',
    ]);
  });

  it('mantém páginas estáticas quando o catálogo falha', async () => {
    apiMock.mockRejectedValue(new Error('backend indisponível'));

    const entries = await sitemap();

    expect(entries.length).toBeGreaterThan(20);
    expect(entries.some((entry) => entry.url.endsWith('/lojas'))).toBe(true);
    expect(entries.some((entry) => entry.url.includes('/produto/'))).toBe(false);
  });
});
