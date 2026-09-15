import { BadRequestException } from '@nestjs/common';
import { PromoCampanhaService } from './promo-campanha.service';
import { CAMPANHA_PADRAO } from '../common/promo-por-termo';

/**
 * A 2ª RODADA NA RETAGUARDA (15/09/2026): grupo/subgrupo do cadastro entrando
 * pela régua, palavra que exclui, a BUSCA de produtos dentro e fora da
 * campanha (com os filtros que existem de verdade) e a inclusão/tirada EM
 * MASSA — gravando a mesma exceção por família que a régua, o site e o caixa
 * leem.
 */
describe('PromoCampanhaService — grupos, busca e lote', () => {
  const linha = (over: any) => ({
    codigo: '1', ref: 'X-1', descricao: 'VESTIDO', descricaoPdv: null, grupo: null,
    grupoId: null, subgrupoId: null, grupoNome: null, subgrupoNome: null, marca: null,
    preco: 100, estoque: 1, ...over,
  });

  const catalogo = [
    linha({ codigo: '11', ref: 'CJ-9 P', descricao: 'CONJUNTO BLUSA E CALCA', grupoId: 13, subgrupoId: 53, grupoNome: 'CONJUNTO FEMININO INVERNO', subgrupoNome: 'PLUSH', marca: 'MARRIE', preco: 199.9, estoque: 10 }),
    linha({ codigo: '12', ref: 'CJ-9 MA', descricao: 'CONJUNTO BLUSA E CALCA', grupoId: 13, subgrupoId: 53, grupoNome: 'CONJUNTO FEMININO INVERNO', subgrupoNome: 'PLUSH', marca: 'MARRIE', preco: 199.9, estoque: 4 }),
    linha({ codigo: '21', ref: 'BER-1', descricao: 'BERMUDA MOLETOM MENINO', marca: 'MALWEE', preco: 69.9, estoque: 7 }),
    linha({ codigo: '31', ref: 'MOL-1', descricao: 'BLUSAO MOLETOM', marca: 'MALWEE', preco: 159.9, estoque: 3 }),
    linha({ codigo: '41', ref: 'BLV-1', descricao: 'BLUSA VISCOLYCRA', grupoId: 1, subgrupoId: 1, grupoNome: 'BLUSA FEMININA', subgrupoNome: 'MANGA CURTA', marca: 'JOIN', preco: 119.9, estoque: 20 }),
  ];

  function montar(opts: { config?: any; excecoes?: any[]; linhas?: any[] } = {}) {
    const linhas = opts.linhas ?? catalogo;
    const upserts: any[] = [];
    const logs: any[] = [];
    const consultasEstrutura: any[] = [];
    const prisma: any = {
      $queryRawUnsafe: jest.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('int[]')) {
          consultasEstrutura.push(args);
          const [grupos, subgrupos] = args as [number[], number[]];
          return linhas.filter((l) => grupos.includes(l.grupoId) || subgrupos.includes(l.subgrupoId));
        }
        if (sql.includes('ANY($1)')) return linhas.filter((l) => (args[0] as string[]).includes(l.codigo));
        return linhas;
      }),
      promoCampanhaExcecao: {
        findMany: jest.fn().mockResolvedValue(opts.excecoes || []),
        upsert: jest.fn(async (a: any) => { upserts.push(a); return a.create; }),
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
      integrationLog: { create: jest.fn(async (a: any) => { logs.push(a.data); return {}; }) },
    };
    const promoConfig: any = {
      getConfig: jest.fn(async () => ({ campanha: { ...CAMPANHA_PADRAO, ...(opts.config || {}) } })),
      clearCache: jest.fn(),
    };
    return { svc: new PromoCampanhaService(prisma, promoConfig), prisma, upserts, logs, consultasEstrutura };
  }

  it('a régua carrega o subgrupo escolhido pelo código — peça sem palavra nenhuma entra', async () => {
    const { svc } = montar({ config: { subgrupos: [53] } });
    const regra = await svc.regra();
    expect(regra.decidir({ ref: 'CJ-9 P', codigo: '11', descricao: 'CONJUNTO BLUSA E CALCA' })).toMatchObject({
      entra: true, criterio: 'estrutura', estrutura: 'subgrupo PLUSH (CONJUNTO FEMININO INVERNO)',
    });
    expect(regra.decidir({ ref: 'BLV-1', codigo: '41', descricao: 'BLUSA VISCOLYCRA' }).entra).toBe(false);
  });

  it('sem grupo/subgrupo escolhido a régua nem consulta a estrutura', async () => {
    const { svc, consultasEstrutura } = montar();
    await svc.regra();
    expect(consultasEstrutura).toHaveLength(0);
  });

  it('os códigos do subgrupo ficam em cache entre recargas da régua (não varre o espelho por minuto)', async () => {
    const { svc, consultasEstrutura } = montar({ config: { subgrupos: [53] } });
    await svc.regra();
    (svc as any).cache.at = 0; // venceu o TTL de 60s da régua
    await svc.regra();
    expect(consultasEstrutura).toHaveLength(1);
  });

  it('a prévia do rascunho mostra a família que entrou pelo subgrupo, com a origem', async () => {
    const { svc } = montar();
    const p = await svc.preview({ subgrupos: [53] });
    const cj = p.familias.find((f) => f.chave === 'CJ-9');
    expect(cj).toMatchObject({ situacao: 'entra', estoque: 14, origens: ['subgrupo PLUSH (CONJUNTO FEMININO INVERNO)'] });
  });

  it('a prévia não lista a bermuda de moletom (palavra que exclui), mas lista o blusão', async () => {
    const { svc } = montar();
    const p = await svc.preview();
    expect(p.familias.map((f) => f.chave)).toEqual(['MOL-1']);
  });

  it('busca: "Fora da promoção" traz blusa e bermuda, com a bermuda marcada como excluída', async () => {
    const { svc } = montar();
    const r = await svc.produtos({ participacao: 'fora' });
    expect(r.produtos.map((p) => p.chave).sort()).toEqual(['BER-1', 'BLV-1', 'CJ-9']);
    expect(r.produtos.find((p) => p.chave === 'BER-1')).toMatchObject({ situacao: 'excluida', exclusoes: ['BERMUDA'] });
    expect(r.totais).toEqual({ dentro: 1, fora: 3 });
  });

  it('busca: "Na promoção" com o rascunho de subgrupo traz o conjunto e o blusão', async () => {
    const { svc } = montar();
    const r = await svc.produtos({ participacao: 'dentro' }, { subgrupos: [53] });
    expect(r.produtos.map((p) => p.chave)).toEqual(['CJ-9', 'MOL-1']);
    expect(r.produtos[0]).toMatchObject({ precoPromoMin: 139.93, estoque: 14, grupo: 'CONJUNTO FEMININO INVERNO', subgrupo: 'PLUSH' });
  });

  it('busca: filtros de grupo, subgrupo, marca e texto usam os campos do cadastro', async () => {
    const { svc } = montar();
    expect((await svc.produtos({ grupo: 13 })).produtos.map((p) => p.chave)).toEqual(['CJ-9']);
    expect((await svc.produtos({ subgrupo: 1 })).produtos.map((p) => p.chave)).toEqual(['BLV-1']);
    expect((await svc.produtos({ marca: 'malwee' })).produtos.map((p) => p.chave).sort()).toEqual(['BER-1', 'MOL-1']);
    expect((await svc.produtos({ busca: 'blusao moletom' })).produtos.map((p) => p.chave)).toEqual(['MOL-1']);
    expect((await svc.produtos({ busca: 'CJ-9 MA' })).produtos.map((p) => p.chave)).toEqual(['CJ-9']);
  });

  it('busca: a família aparece inteira mesmo quando só uma cor casa no filtro', async () => {
    const { svc } = montar();
    const r = await svc.produtos({ busca: 'CJ-9 MA' });
    expect(r.produtos[0]).toMatchObject({ refs: ['CJ-9 MA', 'CJ-9 P'], estoque: 14, codigos: 2 });
  });

  it('busca: REF reciclada (bolero + calça sob o mesmo número) avisa os TIPOS de peça da família', async () => {
    const { svc } = montar({
      linhas: [
        linha({ codigo: '91', ref: '9099', descricao: 'BOLERO MANGA LONGA TRICOT', estoque: 2 }),
        linha({ codigo: '92', ref: '9099', descricao: 'CALCA CIGARRETE PLUS SIZE', estoque: 9 }),
        linha({ codigo: '93', ref: 'MOL-1', descricao: 'BLUSAO MOLETOM', estoque: 3 }),
      ],
    });
    const r = await svc.produtos({});
    expect(r.produtos.find((p) => p.chave === '9099')?.tipos).toEqual(['CALCA', 'BOLERO']);
    expect(r.produtos.find((p) => p.chave === 'MOL-1')?.tipos).toEqual(['BLUSAO']);
  });

  it('busca: paginação conta o total antes de cortar a página', async () => {
    const { svc } = montar();
    const r = await svc.produtos({ porPagina: 2, pagina: 2 });
    expect(r.total).toBe(4);
    expect(r.produtos).toHaveLength(2);
  });

  it('lote "tirar": grava a exceção por FAMÍLIA com REF de exemplo, ignora família sem estoque e deixa um rastro só', async () => {
    const { svc, upserts, logs } = montar();
    const r = await svc.excecoesEmLote({ chaves: ['cj-9', 'MOL-1', 'NAO-EXISTE'], decisao: 'fora', motivo: ' meia estação ', usuario: 'Matriz' });
    expect(r).toMatchObject({ ok: true, alteradas: 2, ignoradas: ['NAO-EXISTE'] });
    const cj = upserts.find((u) => u.where.campanha_chave.chave === 'CJ-9');
    expect(cj.where.campanha_chave.campanha).toBe('inverno');
    expect(cj.create).toMatchObject({ decisao: 'fora', origem: 'retaguarda', motivo: 'meia estação', refExemplo: 'CJ-9 P', usuario: 'Matriz' });
    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe('promo-campanha.excecao-lote');
  });

  it('lote "incluir" derruba a régua em memória — a próxima venda já enxerga', async () => {
    const { svc } = montar();
    const antes = await svc.regra();
    await svc.excecoesEmLote({ chaves: ['BLV-1'], decisao: 'dentro' });
    expect((svc as any).cache).toBeNull();
    expect(await svc.regra()).not.toBe(antes);
  });

  it('lote "devolver à regra" apaga as exceções da campanha pelo nome', async () => {
    const { svc, prisma } = montar();
    const r = await svc.excecoesEmLote({ chaves: ['CJ-9', 'MOL-1'], decisao: 'remover' });
    expect(prisma.promoCampanhaExcecao.deleteMany).toHaveBeenCalledWith({
      where: { campanha: 'inverno', chave: { in: ['CJ-9', 'MOL-1'] } },
    });
    expect(r.alteradas).toBe(2);
  });

  it('lote recusa vazio, decisão inválida e mais de 500 de uma vez', async () => {
    const { svc } = montar();
    await expect(svc.excecoesEmLote({ chaves: [], decisao: 'fora' })).rejects.toThrow(BadRequestException);
    await expect(svc.excecoesEmLote({ chaves: ['CJ-9'], decisao: 'talvez' as any })).rejects.toThrow(BadRequestException);
    const muitas = Array.from({ length: 501 }, (_, i) => `R-${i}`);
    await expect(svc.excecoesEmLote({ chaves: muitas, decisao: 'fora' })).rejects.toThrow(/500/);
  });

  it('estrutura: grupos, subgrupos e marcas com peça na rede, e quanto não tem grupo', async () => {
    const { svc } = montar();
    const e = await svc.estrutura();
    expect(e.grupos).toEqual([
      { codigo: 1, nome: 'BLUSA FEMININA', codigos: 1, pecas: 20 },
      { codigo: 13, nome: 'CONJUNTO FEMININO INVERNO', codigos: 2, pecas: 14 },
    ]);
    expect(e.subgrupos.find((s) => s.codigo === 53)).toMatchObject({ nome: 'PLUSH', grupo: 13, pecas: 14 });
    expect(e.marcas[0]).toEqual({ nome: 'JOIN', pecas: 20 });
    expect(e).toMatchObject({ pecasTotal: 44, pecasSemGrupo: 10 });
  });
});
