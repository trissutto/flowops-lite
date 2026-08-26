import { LojaCatalogService } from './loja-catalog.service';
import { eventLoopStub } from './event-loop.stub';

/**
 * O PREÇO QUE A CLIENTE LÊ na peça em promoção (15/08/2026).
 *
 * O Outlet listava pela marquinha herdada do WooCommerce e mostrava preço
 * cheio: 49 peças na aba, 1 com "de/por" (medido em produção). Agora quem
 * decide é a promoção do caixa, e o desconto tem que chegar em TODO preço da
 * peça — o do card, o da bolinha de cor, o de cada tamanho e o da variação que
 * o carrinho lê. Descontar só no total é como a cliente descobre no carrinho
 * que o número subiu.
 */

// Métodos privados por desenho — o teste exercita a REGRA de preço, que é o
// que não pode mudar sem alguém perceber.
const svc = new LojaCatalogService({} as any, {} as any, eventLoopStub) as any;

const linha = (over: Partial<any> = {}) => ({
  ref: '700979', codigo: '1001', cor: 'PRETO', tamanho: '46', marca: 'KASUAL',
  categoria: 'BLUSAS', descricao: 'BLUSA FEMININA PLUS SIZE MANGA CURTA',
  preco: 199.9, custo: null, ean: null, ncm: null, cst: null,
  // Acima do piso de estoque por cor (10) — senão a cor some da peça.
  estoque: 12, dataAlt: new Date('2022-05-10'),
  ...over,
});

const montar = (
  promo: any,
  linhas = [linha(), linha({ codigo: '1002', tamanho: '48' })],
  site: any = null,
  precoAnterior: Map<string, number> | null = null,
  precoDeRegistrado: Map<string, number> | null = null,
) => svc.montarPeca('700979', linhas, site, null, [], undefined, 0, [], promo, precoAnterior, precoDeRegistrado);

describe('montarPeca — promoção de 50%', () => {
  it('peça elegível sai pela metade, com o "de" riscado no preço cheio', () => {
    const p = montar({ elegivel: true, motivo: 'cadastrada em 2022 (até 2023)', dataCadastro: '2022-05-10' });
    expect(p.preco).toBe(99.95);
    expect(p.precoDe).toBe(199.9);
    expect(p.promocao).toBe(true);
  });

  it('o desconto chega na cor e em cada tamanho, não só no total', () => {
    const p = montar({ elegivel: true, motivo: 'x', dataCadastro: '2022-05-10' });
    expect(p.cores[0].preco).toBe(99.95);
    expect(p.cores[0].tamanhos.map((t: any) => t.preco)).toEqual([99.95, 99.95]);
    expect(p.variacoes.map((v: any) => v.preco)).toEqual([99.95, 99.95]);
  });

  it('o Pix desconta em cima do preço já promocional', () => {
    const p = montar({ elegivel: true, motivo: 'x', dataCadastro: '2022-05-10' });
    expect(p.precoPix).toBe(Number((99.95 * 0.95).toFixed(2)));
  });

  it('peça fora da promoção fica com o preço cheio e sem "de"', () => {
    const p = montar({ elegivel: false, motivo: 'sem promoção — cadastrada em 2026', dataCadastro: '2026-01-02' });
    expect(p.preco).toBe(199.9);
    expect(p.precoDe).toBeNull();
    expect(p.promocao).toBe(false);
  });

  it('sem decisão nenhuma (promo desligada), nada muda', () => {
    const p = montar(null);
    expect(p.preco).toBe(199.9);
    expect(p.promocao).toBe(false);
  });

  /**
   * O SITE SEGUE O PREÇO DA LOJA — SEMPRE (ordem do dono, 26/08). O
   * `precoPromo` digitado só no site morreu: CHIC e SMILE a R$ 59,90 no site
   * com o caixa cobrando R$ 79,90 era exatamente a divergência proibida.
   */
  it('precoPromo digitado é IGNORADO — o site vende pelo preço da loja (26/08)', () => {
    const p = montar(null, [linha(), linha({ codigo: '1002', tamanho: '48' })], { precoPromo: 149.9 });
    expect(p.preco).toBe(199.9);
    expect(p.precoDe).toBeNull();
    expect(p.variacoes.every((v: any) => v.preco === 199.9)).toBe(true);
  });

  it('peça elegível aos 50% com precoPromo digitado: vale a regra do caixa, não o digitado', () => {
    const p = montar(
      { elegivel: true, motivo: 'x', dataCadastro: '2022-05-10' },
      [linha(), linha({ codigo: '1002', tamanho: '48' })],
      { precoPromo: 149.9 },
    );
    expect(p.preco).toBe(99.95);
    expect(p.precoDe).toBe(199.9);
  });

  it('a marquinha do cadastro NÃO faz mais promoção sozinha (o bug do Outlet)', () => {
    const p = montar({ elegivel: false, motivo: 'x', dataCadastro: '2026-01-02' }, undefined, { promocao: true });
    expect(p.promocao).toBe(false);
    expect(p.selecaoComercial).toBe(true);
  });
});

describe('montarPeca — "de/por" automático pelo histórico da loja (26/08)', () => {
  it('a loja baixou o preço: o "de" riscado é o preço anterior dela', () => {
    const p = montar(null, undefined, null, new Map([['1001', 249.9]]));
    expect(p.preco).toBe(199.9);
    expect(p.precoDe).toBe(249.9);
    expect(p.promocao).toBe(true);
  });

  it('aumento de preço NÃO vira "de" — subir preço não é promoção', () => {
    const p = montar(null, undefined, null, new Map([['1001', 149.9]]));
    expect(p.preco).toBe(199.9);
    expect(p.precoDe).toBeNull();
    expect(p.promocao).toBe(false);
  });

  it('o código do histórico casa SEM zeros à esquerda (regra do espelho)', () => {
    // A linha do catálogo vem com codigo '1001'; o audit pode ter '0001001'.
    const p = montar(null, [linha({ codigo: '0001001' })], null, new Map([['1001', 249.9]]));
    expect(p.precoDe).toBe(249.9);
  });

  it('peça dos 50% mantém o preço cheio como âncora, não o histórico', () => {
    const p = montar(
      { elegivel: true, motivo: 'x', dataCadastro: '2022-05-10' },
      undefined,
      null,
      new Map([['1001', 249.9]]),
    );
    expect(p.preco).toBe(99.95);
    expect(p.precoDe).toBe(199.9);
  });

  it('precoDe digitado no site também morreu — sem queda real, sem riscado', () => {
    const p = montar(null, undefined, { precoDe: 299.9 });
    expect(p.precoDe).toBeNull();
    expect(p.promocao).toBe(false);
  });

  /**
   * DE/POR REGISTRADO (dono, 26/08 tarde): a retaguarda declara o "DE" no
   * Preço em bloco (`product.precoDe`) — ele VENCE o histórico automático.
   */
  it('DE registrado pela retaguarda vence o histórico', () => {
    const p = montar(null, undefined, null, new Map([['1001', 249.9]]), new Map([['1001', 299.9]]));
    expect(p.preco).toBe(199.9);
    expect(p.precoDe).toBe(299.9);
    expect(p.promocao).toBe(true);
  });

  it('DE registrado menor que o preço atual é âncora velha — cai no histórico', () => {
    const p = montar(null, undefined, null, new Map([['1001', 249.9]]), new Map([['1001', 149.9]]));
    expect(p.precoDe).toBe(249.9);
  });
});
