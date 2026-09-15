import { PromoCampanhaService } from './promo-campanha.service';
import { CAMPANHA_PADRAO } from '../common/promo-por-termo';

/**
 * O serviço da campanha por termo — o que a retaguarda vê e o que a régua
 * carrega. A regra de quem entra está coberta em `common/promo-por-termo.spec`;
 * aqui fica o que é do serviço: a lista da tela (família, parcial, exceção sem
 * estoque, sugestões), a chave gravada a partir do código bipado e a régua que
 * sobrevive a um banco que piscou.
 */
describe('PromoCampanhaService', () => {
  const linha = (over: any) => ({
    codigo: '1', ref: 'CAS-10', descricao: 'CASACO LONGO', descricaoPdv: null, grupo: 'CASACOS', preco: 199.9, estoque: 5,
    ...over,
  });

  function montar(opts: { linhas?: any[]; excecoes?: any[]; config?: any; falharConfig?: boolean } = {}) {
    const upserts: any[] = [];
    const prisma: any = {
      $queryRawUnsafe: jest.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('ean = ANY')) {
          return (opts.linhas || []).filter((l) => l.ean && (args[0] as string[]).includes(l.ean)).slice(0, 1);
        }
        if (sql.includes('LIMIT 1')) {
          return (opts.linhas || []).filter((l) => l.ref === args[0]).slice(0, 1);
        }
        if (sql.includes('ANY($1)')) {
          return (opts.linhas || []).filter((l) => (args[0] as string[]).includes(l.codigo));
        }
        return opts.linhas || [];
      }),
      promoCampanhaExcecao: {
        findMany: jest.fn().mockResolvedValue(opts.excecoes || []),
        findUnique: jest.fn(async ({ where }: any) =>
          (opts.excecoes || []).find((e) => e.chave === where.campanha_chave.chave) ?? null,
        ),
        upsert: jest.fn(async (a: any) => { upserts.push(a); return { ...a.create, updatedAt: new Date() }; }),
        delete: jest.fn().mockResolvedValue({}),
      },
      integrationLog: { create: jest.fn().mockResolvedValue({}) },
      productClassification: { findMany: jest.fn().mockResolvedValue([]) },
    };
    let falhar = !!opts.falharConfig;
    const promoConfig: any = {
      getConfig: jest.fn(async () => {
        if (falhar) throw new Error('banco piscou');
        return { campanha: { ...CAMPANHA_PADRAO, ...(opts.config || {}) } };
      }),
      clearCache: jest.fn(),
    };
    const svc = new PromoCampanhaService(prisma, promoConfig);
    return { svc, prisma, upserts, setFalhar: (v: boolean) => { falhar = v; } };
  }

  it('a prévia agrupa por família (todas as cores juntas) e soma o estoque', async () => {
    const { svc } = montar({
      linhas: [
        linha({ codigo: '1', ref: 'VMS-223 MA', descricao: 'JAQUETA SARJA MARINHO', grupo: 'JAQUETAS', estoque: 4 }),
        linha({ codigo: '2', ref: 'VMS-223 P', descricao: 'JAQUETA SARJA PRETA', grupo: 'JAQUETAS', estoque: 6 }),
        linha({ codigo: '3', ref: 'VST-9', descricao: 'VESTIDO MIDI', grupo: 'VESTIDOS', estoque: 9 }),
      ],
    });
    const p = await svc.preview();
    expect(p.familias).toHaveLength(1);
    expect(p.familias[0]).toMatchObject({ chave: 'VMS-223', estoque: 10, situacao: 'entra', termos: ['JAQUETA'] });
    expect(p.familias[0].refs).toEqual(['VMS-223 MA', 'VMS-223 P']);
    expect(p.totais).toMatchObject({ familias: 1, estoque: 10 });
    expect(p.familias[0].precoPromoMin).toBe(139.93);
  });

  it('REF reciclada aparece como PARCIAL, com a conta de códigos', async () => {
    const { svc } = montar({
      linhas: [
        linha({ codigo: '1', ref: '9099', descricao: 'CASACO BOLERO', estoque: 2 }),
        linha({ codigo: '2', ref: '9099', descricao: 'CALCA CIGARRETE', grupo: 'CALÇAS', estoque: 7 }),
      ],
    });
    const p = await svc.preview();
    // A linha da tela descreve o que TEM desconto (o bolero), não a calça.
    expect(p.familias[0]).toMatchObject({
      chave: '9099', situacao: 'parcial', codigos: 2, codigosNaCampanha: 1,
      estoque: 2, estoqueFamilia: 9, descricao: 'CASACO BOLERO', grupo: 'CASACOS',
    });
    expect(p.totais.estoque).toBe(2);
  });

  it('o rascunho da tela muda a prévia sem gravar nada', async () => {
    const { svc, upserts } = montar({ linhas: [linha({ descricao: 'BLUSA TRICOT', grupo: 'BLUSAS' })] });
    expect((await svc.preview()).familias).toHaveLength(0);
    const p = await svc.preview({ termos: ['TRIC*'] });
    expect(p.familias).toHaveLength(1);
    expect(p.campanha.termos).toEqual(['TRIC*']);
    expect(upserts).toHaveLength(0);
  });

  it('tirada na mão aparece como "tirada" e sai da conta de quem entra', async () => {
    const { svc } = montar({
      linhas: [linha({})],
      excecoes: [{ chave: 'CAS-10', decisao: 'fora', origem: 'pdv', storeCode: '05', usuario: 'Ana', updatedAt: new Date() }],
    });
    const p = await svc.preview();
    expect(p.familias[0].situacao).toBe('tirada');
    expect(p.totais.familias).toBe(0);
    expect(p.excecoes[0]).toMatchObject({ chave: 'CAS-10', storeCode: '05', usuario: 'Ana' });
  });

  it('sugere a palavra que existe no catálogo e traria modelo NOVO — nunca a que já entra', async () => {
    const { svc } = montar({
      linhas: [
        linha({ codigo: '1', ref: 'TR-1', descricao: 'CARDIGAN TRICO', grupo: 'BLUSAS', estoque: 3 }),
        linha({ codigo: '2', ref: 'CAS-2', descricao: 'CASACO TRICO', estoque: 8 }),
      ],
    });
    const p = await svc.preview();
    const trico = p.sugestoes.find((s) => s.termo === 'TRICO');
    // O casaco de tricô já entra por CASACO: só o cardigan é "novo".
    expect(trico).toMatchObject({ familias: 1, estoque: 3 });
    expect(p.sugestoes.find((s) => s.termo === 'CASACO')).toBeUndefined();
  });

  it('o "tirar" pelo código bipado grava a FAMÍLIA (REF-BASE) na campanha pelo nome', async () => {
    const { svc, upserts } = montar({ linhas: [linha({ codigo: '8001', ref: 'VMS-223 MA', descricao: 'JAQUETA' })] });
    const r = await svc.gravarExcecao({ codigo: '8001', decisao: 'fora', origem: 'pdv', storeCode: '05', usuario: 'Loja 05', motivo: ' é de verão ' });
    expect(upserts[0].where).toEqual({ campanha_chave: { campanha: 'inverno', chave: 'VMS-223' } });
    expect(upserts[0].create).toMatchObject({ decisao: 'fora', origem: 'pdv', storeCode: '05', refExemplo: 'VMS-223 MA', motivo: 'é de verão' });
    expect(r.excecao.chave).toBe('VMS-223');
  });

  it('EAN de etiqueta antiga acha a peça pelo código dela (igual ao bipe)', async () => {
    const { svc, upserts } = montar({
      linhas: [linha({ codigo: '8002', ref: 'CAS-77', descricao: 'CASACO', ean: '7891234567895' })],
    });
    await svc.gravarExcecao({ codigo: '7891234567895', decisao: 'dentro', origem: 'retaguarda' });
    expect(upserts[0].where.campanha_chave.chave).toBe('CAS-77');
  });

  it('código que não existe no catálogo não grava exceção fantasma', async () => {
    const { svc, upserts } = montar({ linhas: [] });
    await expect(svc.gravarExcecao({ codigo: '999', decisao: 'fora', origem: 'pdv' })).rejects.toThrow(/catálogo/);
    expect(upserts).toHaveLength(0);
  });

  it('banco piscou na recarga: vale a última régua boa (site e caixa seguem concordando)', async () => {
    const { svc, setFalhar } = montar({ linhas: [] });
    const primeira = await svc.regra();
    (svc as any).cache.at = 0; // venceu o TTL
    setFalhar(true);
    const segunda = await svc.regra();
    expect(segunda).toBe(primeira);
  });

  it('sem régua nenhuma pra devolver, o erro SOBE (não inventa campanha)', async () => {
    const { svc } = montar({ falharConfig: true });
    await expect(svc.regra()).rejects.toThrow('banco piscou');
  });
});
