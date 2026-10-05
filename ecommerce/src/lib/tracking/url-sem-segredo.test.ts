/**
 * O ENDEREÇO DO PEDIDO NÃO VAI PRA TERCEIRO.
 *
 * `/checkout/confirmacao/<uuid>`, `/pedido/<uuid>` e `/avaliar/<token>` usam o
 * último segmento como credencial: quem tem o link abre nome, telefone e
 * endereço da cliente. Até 04/10/2026 esse link ia inteiro pra CAPI da Meta e
 * pro GA4, junto de todo evento disparado nessas páginas.
 *
 * O teste prende os dois lados da regra: a credencial some, e página comum
 * (produto, categoria, home) continua exatamente como era — é dela que o
 * relatório de páginas e a atribuição dependem.
 */

import { describe, expect, it } from 'vitest';

import { semSegredoNoCaminho } from './identity';

const SITE = 'https://lurds.com.br';

describe('semSegredoNoCaminho', () => {
  it.each([
    ['/checkout/confirmacao/7b1c2d3e-aaaa-bbbb-cccc-1234567890ab', '/checkout/confirmacao/:id'],
    ['/pedido/7b1c2d3e-aaaa-bbbb-cccc-1234567890ab', '/pedido/:id'],
    ['/avaliar/tok_abc123', '/avaliar/:id'],
  ])('%s vira %s, sem query nem hash', (path, esperado) => {
    const r = semSegredoNoCaminho(path, `${SITE}${path}?utm_source=meta&fbclid=XYZ#topo`);
    expect(r.path).toBe(esperado);
    expect(r.url).toBe(`${SITE}${esperado}`);
  });

  it.each(['/', '/produto/ref-8493', '/categoria/vestidos', '/checkout', '/pedido/', '/novidades'])(
    'não toca em %s',
    (path) => {
      const url = `${SITE}${path}?utm_source=google&gclid=ABC`;
      expect(semSegredoNoCaminho(path, url)).toEqual({ path, url });
    },
  );

  it('url ilegível não derruba o evento', () => {
    expect(semSegredoNoCaminho('/pedido/abc', 'não-é-url')).toEqual({ path: '/pedido/:id', url: '/pedido/:id' });
  });
});
