import { LojaCatalogService } from './loja-catalog.service';
import { eventLoopStub } from './event-loop.stub';
import { CAMPANHA_PADRAO, criarRegra } from '../common/promo-por-termo';

/**
 * O PREÇO QUE A CLIENTE LÊ na peça da campanha do caixa.
 *
 * Nasceu em 15/08/2026 com os 50% do "liquida antigos" (o Outlet listava pela
 * marquinha herdada do WooCommerce e mostrava preço cheio: 49 peças na aba, 1
 * com "de/por"). Desde 15/09 a campanha é por TERMO — hoje "Inverno 30%" — e
 * o que este arquivo tranca continua o mesmo: o desconto chega em TODO preço
 * da peça (card, bolinha de cor, cada tamanho, variação que o carrinho lê),
 * e a decisão é da LINHA, não da família.
 */

// Métodos privados por desenho — o teste exercita a REGRA de preço, que é o
// que não pode mudar sem alguém perceber.
const svc = new LojaCatalogService({} as any, {} as any, eventLoopStub) as any;

const linha = (over: Partial<any> = {}) => ({
  ref: '700979', codigo: '1001', cor: 'PRETO', tamanho: '46', marca: 'KASUAL',
  categoria: 'CASACOS', descricao: 'CASACO LONGO PLUS SIZE',
  descricaoPdv: null,
  preco: 199.9, custo: null, ean: null, ncm: null, cst: null,
  // Acima do piso de estoque por cor (10) — senão a cor some da peça.
  estoque: 12, dataAlt: new Date('2026-05-10'),
  ...over,
});

const casacos = () => [linha(), linha({ codigo: '1002', tamanho: '48' })];
const blusas = () => [
  linha({ categoria: 'BLUSAS', descricao: 'BLUSA FEMININA PLUS SIZE MANGA CURTA' }),
  linha({ codigo: '1002', tamanho: '48', categoria: 'BLUSAS', descricao: 'BLUSA FEMININA PLUS SIZE MANGA CURTA' }),
];

const inverno = (excecoes: any[] = [], over: any = {}) => criarRegra({ ...CAMPANHA_PADRAO, ...over }, excecoes);

const montar = (
  regra: any,
  linhas = casacos(),
  site: any = null,
  precoAnterior: Map<string, number> | null = null,
  precoDeRegistrado: Map<string, number> | null = null,
) => svc.montarPeca('700979', linhas, site, null, [], undefined, 0, [], regra, precoAnterior, precoDeRegistrado);

describe('montarPeca — campanha por termo (inverno 30%)', () => {
  it('casaco sai com 30%, com o "de" riscado no preço cheio', () => {
    const p = montar(inverno());
    expect(p.preco).toBe(139.93);
    expect(p.precoDe).toBe(199.9);
    expect(p.promocao).toBe(true);
    expect(p.promoMotivo).toContain('CASACO');
  });

  it('o desconto chega na cor e em cada tamanho, não só no total', () => {
    const p = montar(inverno());
    expect(p.cores[0].preco).toBe(139.93);
    expect(p.cores[0].tamanhos.map((t: any) => t.preco)).toEqual([139.93, 139.93]);
    expect(p.variacoes.map((v: any) => v.preco)).toEqual([139.93, 139.93]);
  });

  it('o Pix desconta em cima do preço já promocional', () => {
    const p = montar(inverno());
    expect(p.precoPix).toBe(Number((139.93 * 0.95).toFixed(2)));
  });

  it('peça que não é de inverno fica com o preço cheio e sem "de"', () => {
    const p = montar(inverno(), blusas());
    expect(p.preco).toBe(199.9);
    expect(p.precoDe).toBeNull();
    expect(p.promocao).toBe(false);
    expect(p.promoMotivo).toBeNull();
  });

  it('sem régua (null), nada muda', () => {
    const p = montar(null);
    expect(p.preco).toBe(199.9);
    expect(p.promocao).toBe(false);
  });

  it('campanha desligada na retaguarda: o casaco volta ao preço da loja', () => {
    const p = montar(inverno([], { ativa: false }));
    expect(p.preco).toBe(199.9);
    expect(p.promocao).toBe(false);
  });

  it('família tirada da campanha na mão (pelo PDV ou retaguarda) sai pelo preço cheio', () => {
    const p = montar(inverno([{ chave: '700979', decisao: 'fora' }]));
    expect(p.preco).toBe(199.9);
    expect(p.precoDe).toBeNull();
  });

  it('família incluída na mão entra mesmo sem termo', () => {
    const p = montar(inverno([{ chave: '700979', decisao: 'dentro' }]), blusas());
    expect(p.preco).toBe(139.93);
    expect(p.precoDe).toBe(199.9);
  });

  /**
   * Termo de 2 palavras dentro da mesma família de descrição: "CALÇA MOLETOM"
   * pega a de moletom e deixa a alfaiataria da mesma REF no preço dela. O
   * riscado é o da peça COM desconto — nunca o preço de outra peça da REF.
   */
  it('linha a linha: só a variação que casou leva desconto, e o "de" é o dela', () => {
    const regra = inverno([], { termos: ['CALÇA MOLETOM'] });
    const p = montar(regra, [
      linha({ categoria: 'CALÇAS', descricao: 'CALÇA MOLETOM PLUS SIZE', preco: 199.9 }),
      linha({ codigo: '1002', tamanho: '48', categoria: 'CALÇAS', descricao: 'CALÇA ALFAIATARIA PLUS SIZE', preco: 149.9 }),
    ]);
    expect(p.variacoes.map((v: any) => v.preco).sort()).toEqual([139.93, 149.9]);
    expect(p.preco).toBe(139.93);
    expect(p.precoDe).toBe(199.9);
  });

  /**
   * O SITE SEGUE O PREÇO DA LOJA — SEMPRE (ordem do dono, 26/08). O
   * `precoPromo` digitado só no site morreu: CHIC e SMILE a R$ 59,90 no site
   * com o caixa cobrando R$ 79,90 era exatamente a divergência proibida.
   */
  it('precoPromo digitado é IGNORADO — o site vende pelo preço da loja (26/08)', () => {
    const p = montar(null, casacos(), { precoPromo: 149.9 });
    expect(p.preco).toBe(199.9);
    expect(p.precoDe).toBeNull();
    expect(p.variacoes.every((v: any) => v.preco === 199.9)).toBe(true);
  });

  it('peça da campanha com precoPromo digitado: vale a campanha, não o digitado', () => {
    const p = montar(inverno(), casacos(), { precoPromo: 149.9 });
    expect(p.preco).toBe(139.93);
    expect(p.precoDe).toBe(199.9);
  });

  it('a marquinha do cadastro NÃO faz mais promoção sozinha (o bug do Outlet)', () => {
    const p = montar(inverno(), blusas(), { promocao: true });
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

  it('peça da campanha mantém o preço cheio como âncora, não o histórico', () => {
    const p = montar(inverno(), undefined, null, new Map([['1001', 249.9]]));
    expect(p.preco).toBe(139.93);
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
