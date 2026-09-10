/**
 * FAMÍLIA DA REF lida por `IN`, não por prefixo com janela.
 *
 * 10/09/2026, REF 22 (uniforme do colégio, loja 01 Itanhaém): a Consulta
 * dizia "1 cor · 13 tamanhos" com 8 cores no banco. `searchByRefFromMirror`
 * fazia `ref startsWith '22'` + `take: 1000` ordenado por cor — e "22" é
 * prefixo de 7.590 linhas (220, 2201, 22999…). A janela de 1.000 acabava na
 * cor BRANCO e tudo que vinha depois (MESCLA, VERDE…) sumia calado. Medido no
 * dia: 76 REFs curtas COM estoque estouravam a janela.
 *
 * Agora o prefixo só escolhe as REFs DISTINTAS da família (`refsDaFamilia`,
 * mesma régua do `isVariationOf`) e as linhas vêm por `IN`.
 */
import { WincredCatalogService } from './wincred-catalog.service';

const linha = (codigo: string, cor: string, tamanho: string, ref = '22') => ({
  codigo, ref, cor, tamanho,
  descricaoCompleta: `CAMISETA 22 DE ABRIL ${cor} ${tamanho}`,
  marca: null, fornecedor: '04752209000162', vendaUn: 49.9, estoque: 0, idWincred: null,
});

function montar(refsNoBanco: string[], rows: any[]) {
  const prisma = {
    $queryRawUnsafe: jest.fn().mockResolvedValue(refsNoBanco.map((ref) => ({ ref }))),
    product: { findMany: jest.fn().mockResolvedValue(rows) },
    wincredProduto: { findMany: jest.fn().mockResolvedValue([]) },
    wincredEstoque: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new WincredCatalogService(prisma as any, {} as any);
  return { service, prisma };
}

describe('searchByRefFromMirror — família da REF sem janela de prefixo', () => {
  it('lê as linhas por IN nas REFs da família, não por startsWith com take 1000', async () => {
    const { service, prisma } = montar(
      // O que o LIKE '22%' devolve de REFs distintas: família de verdade
      // ("22", "22 A", "22-B", "22C", "22CD") misturada com prefixo que não é
      // família ("220", "2201", "22999", "22CDE").
      ['22', '220', '2201', '22 A', '22-B', '22C', '22CD', '22CDE', '22999'],
      [linha('184861', 'BRANCA', '01'), linha('323642', 'MESCLA', 'G')],
    );

    const rows = await service.searchByRefSemGiga('22');

    // A pergunta das REFs foi por prefixo, parametrizada.
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, param] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(String(sql)).toMatch(/LIKE \$1/);
    expect(param).toBe('22%');

    // A leitura das linhas é por IN, só com a família — e sem a janela de 1.000.
    for (const tabela of [prisma.product.findMany, prisma.wincredProduto.findMany]) {
      expect(tabela).toHaveBeenCalledTimes(1);
      const args = tabela.mock.calls[0][0];
      expect(args.where).toEqual({ ref: { in: ['22', '22 A', '22-B', '22C', '22CD'] } });
      expect(JSON.stringify(args.where)).not.toContain('startsWith');
      expect(args.take).toBeGreaterThanOrEqual(5000);
    }

    // As duas cores chegam — a MESCLA era a que caía fora da janela.
    expect(rows.map((r: any) => r.COR).sort()).toEqual(['BRANCA', 'MESCLA']);
  });

  it('REF sem família no banco: não lê linha nenhuma e devolve vazio', async () => {
    const { service, prisma } = montar([], []);

    const rows = await service.searchByRefSemGiga('999999');

    expect(rows).toEqual([]);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('escapa % e _ da REF no LIKE (REF "A_1" não pode casar "AB1")', async () => {
    const { service, prisma } = montar(['A_1'], [linha('1', 'PRETO', 'P', 'A_1')]);

    await service.searchByRefSemGiga('A_1');

    const [sql, param] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(param).toBe('A\\_1%');
    expect(String(sql)).toContain("ESCAPE '\\'");
  });

  it('devolve a REF como está GRAVADA pro IN (trim só no teste de família)', async () => {
    const { service, prisma } = montar(['22 '], [linha('1', 'BRANCA', 'P', '22 ')]);

    const rows = await service.searchByRefSemGiga('22');

    expect(prisma.product.findMany.mock.calls[0][0].where).toEqual({ ref: { in: ['22 '] } });
    expect(rows).toHaveLength(1);
  });
});
