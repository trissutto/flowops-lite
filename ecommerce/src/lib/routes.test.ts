import { describe, expect, it } from 'vitest';
import { isBuiltRoute } from './routes';

/**
 * Este guard é o que impede o <Link> de prefetchar as ~80 rotas do desenho
 * final que ainda não têm página — cada uma vira um RSC 404 na dobra mais cara
 * da home. Um falso positivo aqui traz o barulho de volta em silêncio, e
 * prefetch não deixa rastro no DOM pra conferir depois.
 */
describe('isBuiltRoute', () => {
  it('reconhece as rotas que existem em src/app', () => {
    for (const rota of [
      '/', '/busca', '/carrinho', '/checkout', '/lojas', '/novidades', '/outlet',
      '/conta/favoritos', '/trocas',
    ]) {
      expect(isBuiltRoute(rota), rota).toBe(true);
    }
  });

  it('reconhece as rotas dinâmicas de um segmento', () => {
    expect(isBuiltRoute('/categoria/vestidos')).toBe(true);
    expect(isBuiltRoute('/produto/p01-vestido-midi')).toBe(true);
    expect(isBuiltRoute('/checkout/confirmacao/abc123')).toBe(true);
  });

  it('nega as rotas ainda não construídas', () => {
    for (const rota of [
      '/looks',
      '/institucional/frete',
      '/tecidos/linho',
      '/ocasioes/casamento',
      '/blog/guia-viscolycra',
    ]) {
      expect(isBuiltRoute(rota), rota).toBe(false);
    }
  });

  it('não confunde subrota com a rota-mãe', () => {
    // /categoria/[slug] existe; /categoria/x/y não.
    expect(isBuiltRoute('/categoria/vestidos/festa')).toBe(false);
    // /novidades/mais-vendidos não vira "construída" só porque tem um segmento.
    expect(isBuiltRoute('/novidades/mais-vendidos')).toBe(false);
  });

  it('ignora query string e âncora ao casar o caminho', () => {
    expect(isBuiltRoute('/busca?q=vestido')).toBe(true);
    expect(isBuiltRoute('/carrinho#resumo')).toBe(true);
    expect(isBuiltRoute('/lojas?cidade=santos')).toBe(true);
  });

  it('deixa passar o que o Next nem prefetcha (externo, âncora, protocolo)', () => {
    for (const href of [
      'https://www.instagram.com/lurdsplussize',
      'https://api.whatsapp.com/send?phone=5513996256238',
      'mailto:contato@lurds.com.br',
      '#conteudo',
    ]) {
      expect(isBuiltRoute(href), href).toBe(true);
    }
  });

  it('aceita href em forma de objeto', () => {
    expect(isBuiltRoute({ pathname: '/busca', query: { q: 'x' } })).toBe(true);
    expect(isBuiltRoute({ pathname: '/lojas' })).toBe(true);
  });
});
