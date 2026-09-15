import { CarrinhoGuardService } from './carrinho-guard.service';
import { CAMPANHA_PADRAO, criarRegra } from '../common/promo-por-termo';

/**
 * A TRAVA DO CARRINHO COBRA A CAMPANHA DO CAIXA (inverno 30%, 15/09/2026).
 *
 * A vitrine desconta linha a linha pelo texto de cada código; a trava tem que
 * chegar no MESMO número, senão o pedido é recusado por "preço subiu" (se a
 * trava cobrar mais) ou a loja perde dinheiro (se cobrar menos).
 */
describe('CarrinhoGuardService — campanha por termo', () => {
  const linha = (over: any = {}) => ({
    ref: 'CAS-100',
    codigo: '8000000000011',
    cor: 'PRETO',
    tamanho: '52',
    preco: 199.9,
    estoque: 5,
    descricao: 'CASACO LONGO PLUS SIZE',
    descricaoPdv: null,
    grupo: 'CASACOS',
    ...over,
  });

  const prismaMock = (linhas: any[]) => ({
    $queryRawUnsafe: jest.fn(async (sql: string) =>
      String(sql).includes('wincred_produtos') ? linhas : [],
    ),
    siteProduto: { findMany: jest.fn().mockResolvedValue([]) },
  });

  const guard = (linhas: any[], regra: any) =>
    new CarrinhoGuardService(prismaMock(linhas) as any, { regra: jest.fn(regra) } as any);

  const sacola = (unitPrice: number, over: any = {}) => [
    { sku: 'CAS-100', productId: 'cas-100', name: 'Casaco Longo', size: '52', color: 'PRETO', quantity: 1, unitPrice, ...over },
  ];

  const inverno = () => Promise.resolve(criarRegra(CAMPANHA_PADRAO));

  it('casaco na campanha: cobra 30% a menos e fecha com a página', async () => {
    const r: any = await guard([linha()], inverno).conferir(sacola(139.93));
    expect(r.ok).toBe(true);
    expect(r.itens[0].precoCatalogo).toBe(139.93);
    expect(r.subtotal).toBe(139.93);
  });

  it('sacola montada ANTES da campanha (preço cheio): cobra o menor, não recusa', async () => {
    const r: any = await guard([linha()], inverno).conferir(sacola(199.9));
    expect(r.ok).toBe(true);
    expect(r.itens[0].precoCatalogo).toBe(139.93);
  });

  /**
   * A vendedora tirou o casaco da campanha e a sacola ainda tem o preço com
   * desconto: a trava recusa com o preço novo (o site corrige a linha sozinho).
   */
  it('família tirada na mão: cobra cheio e devolve o preço novo pra sacola', async () => {
    const regra = () =>
      Promise.resolve(criarRegra(CAMPANHA_PADRAO, [{ chave: 'CAS-100', decisao: 'fora' }]));
    const r: any = await guard([linha()], regra).conferir(sacola(139.93));
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('preco_subiu');
    expect(r.item.precoAtual).toBe(199.9);
  });

  it('peça que não é de inverno segue pelo preço da loja', async () => {
    const vestido = linha({ ref: 'VST-9', descricao: 'VESTIDO MIDI ALCINHA', grupo: 'VESTIDOS' });
    const r: any = await guard([vestido], inverno).conferir(sacola(199.9, { sku: 'VST-9', productId: 'vst-9' }));
    expect(r.ok).toBe(true);
    expect(r.itens[0].precoCatalogo).toBe(199.9);
  });

  /**
   * REF reciclada: sob o mesmo número, a variação do casaco e a do vestido.
   * Sem cor/tamanho na sacola, vale o menor preço entre as duas — cada uma
   * com a SUA decisão (é o `Math.min` que a vitrine faz depois do desconto).
   */
  it('REF reciclada: só a variação que casou leva o desconto', async () => {
    const casaco = linha({ codigo: '1', tamanho: '50', preco: 199.9 });
    const vestido = linha({ codigo: '2', tamanho: '54', preco: 149.9, descricao: 'VESTIDO MIDI', grupo: 'VESTIDOS' });
    const r: any = await guard([casaco, vestido], inverno).conferir(
      sacola(139.93, { size: undefined, color: undefined }),
    );
    expect(r.ok).toBe(true);
    // casaco 199,90 → 139,93 · vestido 149,90 (fora) → o menor é o casaco.
    expect(r.itens[0].precoCatalogo).toBe(139.93);
  });

  it('campanha indisponível: não cobra no escuro (mesma saída do catálogo fora)', async () => {
    const r: any = await guard([linha()], () => Promise.reject(new Error('db caiu'))).conferir(sacola(139.93));
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('catalogo_fora');
  });
});
