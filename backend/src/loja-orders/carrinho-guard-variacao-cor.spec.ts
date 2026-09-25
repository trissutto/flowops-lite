import { CarrinhoGuardService } from './carrinho-guard.service';
import { criarRegra } from '../common/promo-por-termo';

/**
 * A PEÇA É COR + TAMANHO, NUNCA SÓ A REF (25/09/2026).
 *
 * O caso: a cliente comprou a Blusa VOGUE MARROM 52 no site e o pedido chegou
 * na loja como VOGUE PRETA 52 — separada, enviada e ENTREGUE errada. Antes
 * disso, uma regata pelo mesmo caminho. A sacola mandava só a REF ("VOGUE")
 * com cor e tamanho em texto, e o guard resolvia o código "pelo que sobrava"
 * dentro da REF: sem a cor, o único 52 da REF mãe (PRETO) virava a peça.
 *
 * O que este arquivo tranca, dos dois lados:
 *  - a resolução NUNCA escolhe cor por conta própria (sem cor + várias cores
 *    = recusa, com `item` pro site oferecer "tirar da sacola");
 *  - o CÓDIGO que o site manda é conferido contra cor e tamanho da linha
 *    dele — divergiu, recusa; nunca "corrige" pra outra linha;
 *  - o pedido nasce com a cor e o tamanho DA LINHA DO CÓDIGO (o que a loja
 *    vai bipar), e com a REF como está no espelho.
 */
describe('CarrinhoGuardService — mesma REF, cores diferentes', () => {
  const PRETO_52 = '5000052';
  const MARROM_52 = '5100052';
  const MARROM_MM_52 = '5200052';

  const linha = (over: any = {}) => ({
    ref: 'VOGUE',
    codigo: PRETO_52,
    cor: 'PRETO',
    tamanho: '52',
    preco: 79.9,
    estoque: 5,
    ...over,
  });

  /** VOGUE com PRETO e MARROM, as duas no 52 — o cenário do incidente. */
  const vogueDuasCores = () => [
    linha(),
    linha({ codigo: '5000050', tamanho: '50' }),
    linha({ codigo: MARROM_52, cor: 'MARROM' }),
    linha({ codigo: '5100054', cor: 'MARROM', tamanho: '54' }),
  ];

  const prismaMock = (linhas: any[]) => ({
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: any[]) => {
      if (!String(sql).includes('wincred_produtos')) return [];
      // Mesmo recorte do SQL real: por REF (sem espaço, maiúscula) OU por código.
      const [refs = [], codigos = []] = args as [string[], string[]];
      const normRef = (v: any) => String(v ?? '').toUpperCase().replace(/\s+/g, '');
      return linhas.filter((l) => refs.includes(normRef(l.ref)) || codigos.includes(String(l.codigo)));
    }),
    siteProduto: { findMany: jest.fn().mockResolvedValue([]) },
  });

  const promoMock = () => ({ regra: jest.fn().mockResolvedValue(criarRegra({ ativa: false })) });

  const guard = (linhas: any[]) => new CarrinhoGuardService(prismaMock(linhas) as any, promoMock() as any);

  const sacola = (over: any = {}) => [
    {
      sku: 'VOGUE',
      productId: 'VOGUE',
      name: 'Blusa Vogue',
      size: '52',
      color: 'MARROM',
      quantity: 1,
      unitPrice: 79.9,
      ...over,
    },
  ];

  describe('sacola antiga (manda a REF)', () => {
    it('MARROM 52 resolve o código da MARROM — nunca o do PRETO 52', async () => {
      const r: any = await guard(vogueDuasCores()).conferir(sacola());

      expect(r.ok).toBe(true);
      expect(r.itens[0].codigo).toBe(MARROM_52);
      expect(r.itens[0].cor).toBe('MARROM');
      expect(r.itens[0].tamanho).toBe('52');
      expect(r.itens[0].ref).toBe('VOGUE');
    });

    it('SEM cor numa REF de duas cores é RECUSA — não "o 52 que sobrou"', async () => {
      // Só o PRETO tem 52 no cadastro: era exatamente aqui que o palpite
      // escolhia PRETO pra quem comprou MARROM.
      const rows = [linha(), linha({ codigo: MARROM_52, cor: 'MARROM', tamanho: '54' })];
      const r: any = await guard(rows).conferir(sacola({ color: undefined }));

      expect(r.ok).toBe(false);
      expect(r.motivo).toBe('sem_cor');
      expect(r.item).toBeDefined();
      expect(r.item.productId).toBe('VOGUE');
      expect(r.item.size).toBe('52');
      expect(r.erro).toMatch(/mais de uma cor/);
    });

    it('cor vazia no cadastro conta como cor: linha sem cor + linha PRETO = duas peças', async () => {
      const rows = [linha(), linha({ codigo: '5300052', cor: null })];
      const r: any = await guard(rows).conferir(sacola({ color: undefined }));

      expect(r.ok).toBe(false);
      expect(r.motivo).toBe('sem_cor');
    });

    it('peça de cor única resolve sem cor — e devolve a cor pro pedido gravar', async () => {
      const rows = [linha(), linha({ codigo: '5000050', tamanho: '50' })];
      const r: any = await guard(rows).conferir(sacola({ color: undefined }));

      expect(r.ok).toBe(true);
      expect(r.itens[0].codigo).toBe(PRETO_52);
      expect(r.itens[0].cor).toBe('PRETO');
      expect(r.itens[0].tamanho).toBe('52');
    });

    it('cor que só existe na REF irmã ("VOGUE MM") não vira a cor da REF mãe', async () => {
      // A família fundida no site mostra a MARROM da irmã; a sacola antiga
      // manda só "VOGUE". Sem o código não dá pra afirmar qual peça é —
      // recusa honesta, nunca o PRETO da mãe.
      const rows = [linha(), linha({ ref: 'VOGUE MM', codigo: MARROM_MM_52, cor: 'MARROM' })];
      const r: any = await guard(rows).conferir(sacola());

      expect(r.ok).toBe(false);
      expect(r.motivo).toBe('sem_cor');
    });
  });

  describe('sacola nova (manda o CÓDIGO)', () => {
    it('código da MARROM 52 com cor e tamanho batendo → confirma o mesmo código', async () => {
      const r: any = await guard(vogueDuasCores()).conferir(sacola({ sku: MARROM_52 }));

      expect(r.ok).toBe(true);
      expect(r.itens[0].codigo).toBe(MARROM_52);
      expect(r.itens[0].cor).toBe('MARROM');
    });

    it('código da REF irmã resolve, e o pedido leva a REF da irmã COMO ESTÁ ("VOGUE MM")', async () => {
      const rows = [linha(), linha({ ref: 'VOGUE MM', codigo: MARROM_MM_52, cor: 'MARROM' })];
      const r: any = await guard(rows).conferir(sacola({ sku: MARROM_MM_52 }));

      expect(r.ok).toBe(true);
      expect(r.itens[0].codigo).toBe(MARROM_MM_52);
      expect(r.itens[0].ref).toBe('VOGUE MM');
      expect(r.itens[0].cor).toBe('MARROM');
    });

    it('código que diz PRETO com sacola dizendo MARROM é divergência → recusa, nunca troca a cor', async () => {
      const r: any = await guard(vogueDuasCores()).conferir(sacola({ sku: PRETO_52, color: 'MARROM' }));

      expect(r.ok).toBe(false);
      expect(r.motivo).toBe('sem_cor');
    });

    it('código de OUTRO tamanho com a sacola dizendo 52 → recusa por tamanho', async () => {
      const r: any = await guard(vogueDuasCores()).conferir(sacola({ sku: '5100054', color: 'MARROM', size: '52' }));

      expect(r.ok).toBe(false);
      expect(r.motivo).toBe('sem_tamanho');
    });

    it('código sem cor na sacola vale por si (a linha do código É a cor)', async () => {
      const r: any = await guard(vogueDuasCores()).conferir(sacola({ sku: MARROM_52, color: undefined }));

      expect(r.ok).toBe(true);
      expect(r.itens[0].codigo).toBe(MARROM_52);
      expect(r.itens[0].cor).toBe('MARROM');
    });

    it('cor e tamanho voltam normalizados do espelho (o site manda "marrom")', async () => {
      const r: any = await guard(vogueDuasCores()).conferir(sacola({ color: 'marrom' }));

      expect(r.ok).toBe(true);
      expect(r.itens[0].codigo).toBe(MARROM_52);
      expect(r.itens[0].cor).toBe('MARROM');
    });
  });

  describe('codigosDasLinhas (cotação de retirada) segue a mesma régua', () => {
    it('sem cor numa REF de duas cores não resolve (nunca promete 3h pra cor errada)', async () => {
      const rows = [linha(), linha({ codigo: MARROM_52, cor: 'MARROM', tamanho: '54' })];
      const r = await guard(rows).codigosDasLinhas([{ sku: 'VOGUE', size: '52' }]);

      expect(r[0].codigo).toBeNull();
    });

    it('com cor resolve a cor pedida; com código confere e confirma', async () => {
      const g = guard(vogueDuasCores());
      const r = await g.codigosDasLinhas([
        { sku: 'VOGUE', size: '52', color: 'MARROM' },
        { sku: PRETO_52, size: '52', color: 'PRETO' },
        { sku: PRETO_52, size: '52', color: 'MARROM' },
      ]);

      expect(r[0].codigo).toBe(MARROM_52);
      expect(r[1].codigo).toBe(PRETO_52);
      expect(r[2].codigo).toBeNull();
    });
  });
});
