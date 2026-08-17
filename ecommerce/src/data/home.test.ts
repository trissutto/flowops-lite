import { describe, expect, it } from 'vitest';
import { HOME_CATEGORY_BASE, HOME_NEWS_PATH, HOME_STORES_PATH } from './home';

describe('jornada inicial da Home', () => {
  it('mantém as cinco categorias aprovadas na ordem visual', () => {
    expect(HOME_CATEGORY_BASE.map((category) => category.name)).toEqual([
      'Vestidos', 'Blusas', 'Conjuntos', 'Calças', 'Outlet',
    ]);
  });

  it('usa apenas destinos internos válidos', () => {
    const paths = HOME_CATEGORY_BASE.map((category) => category.path);
    expect(paths).toEqual([
      '/categoria/vestidos', '/categoria/blusas', '/categoria/conjuntos', '/categoria/calcas', '/outlet',
    ]);
    expect(HOME_NEWS_PATH).toBe('/novidades');
    expect(HOME_STORES_PATH).toBe('/lojas');
  });

  it('possui uma imagem editorial otimizada para cada categoria', () => {
    for (const category of HOME_CATEGORY_BASE) {
      expect(category.image).toMatch(/^\/images\/home-categorias\/[a-z-]+\.webp$/);
      expect(category.alt.length).toBeGreaterThan(20);
    }
  });
});
