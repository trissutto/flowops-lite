import {
  diasSegASabado,
  montarRanking,
  montarVendedoras,
  normCodigo,
  pctDe,
} from './metas.service';

/**
 * A RÉGUA DA GAMIFICAÇÃO (dono, 29/08/2026), na ordem em que errar doeria:
 *
 *   1. Meta da vendedora = meta da loja ÷ vendedoras ATIVAS — e a divisão usa
 *      a whitelist, não "quem vendeu" (senão a meta individual muda quando
 *      alguém falta).
 *   2. Venda casa com a vendedora por CÓDIGO ou por NOME (o seller_id da venda
 *      ora é código Wincred, ora Seller.id — lição do commission-engine), e
 *      cada linha só conta UMA vez.
 *   3. Devolução dinheiro/pix abate da vendedora da venda original.
 *   4. Quem vendeu fora da whitelist aparece no FIM, não some — o total da
 *      loja precisa fechar com a soma das meninas.
 *   5. Ranking = PARTICIPAÇÃO nas vendas globais da rede (correção do dono na
 *      entrega, 29/08): fatia de cada loja no bolo dos últimos 30 dias, soma
 *      100 — e o payload NUNCA carrega valor em reais.
 */
describe('metas — helpers puros', () => {
  describe('pctDe', () => {
    it('calcula % com 1 casa', () => {
      expect(pctDe(50, 200)).toBe(25);
      expect(pctDe(333, 1000)).toBe(33.3);
    });
    it('meta zero/negativa → null (sem base), nunca Infinity', () => {
      expect(pctDe(100, 0)).toBeNull();
      expect(pctDe(100, -5)).toBeNull();
    });
  });

  describe('diasSegASabado', () => {
    it('agosto/2026 tem 26 dias seg–sáb (5 domingos)', () => {
      expect(diasSegASabado(2026, 8)).toBe(26);
    });
    it('fevereiro/2026 tem 24 dias seg–sáb', () => {
      expect(diasSegASabado(2026, 2)).toBe(24);
    });
  });

  describe('normCodigo', () => {
    it('só dígitos, sem zeros à esquerda — padrão do espelho', () => {
      expect(normCodigo('007')).toBe('7');
      expect(normCodigo(' LJ-25 ')).toBe('25');
      expect(normCodigo(null)).toBe('');
    });
  });

  describe('montarVendedoras', () => {
    const base = {
      metaMesLoja: 30000,
      // Dias úteis seg–sáb do MÊS VIGENTE (correção do dono, 29/08 — não são
      // mais os dias com venda do ano anterior).
      diasUteisMes: 25,
    };

    it('divide a meta pela whitelist e a meta-dia pelos dias úteis do mês vigente', () => {
      const rows = montarVendedoras({
        ...base,
        ativas: [
          { codigo: '25', nome: 'MARIA SILVA' },
          { codigo: '30', nome: 'ANA SOUZA' },
          { codigo: '31', nome: 'CLARA LIMA' },
        ],
        vendas: [],
        devolucoes: [],
      });
      expect(rows).toHaveLength(3);
      expect(rows[0].metaMes).toBe(10000);
      expect(rows[0].metaDia).toBe(400);
    });

    it('casa venda por código E por nome, sem contar duas vezes', () => {
      const rows = montarVendedoras({
        ...base,
        ativas: [{ codigo: '025', nome: 'Maria Silva', apelido: 'Mari' }],
        vendas: [
          // seller_id = código Wincred (com zero à esquerda diferente)
          { sellerId: '25', sellerName: 'MARIA SILVA', mes: 1000, hoje: 200 },
          // seller_id = Seller.id (uuid) — casa pelo nome
          { sellerId: 'uuid-x', sellerName: 'maria  silva', mes: 500, hoje: 0 },
          // apelido gravado como nome na venda
          { sellerId: null, sellerName: 'Mari', mes: 250, hoje: 50 },
        ],
        devolucoes: [],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].realizadoMes).toBe(1750);
      expect(rows[0].realizadoHoje).toBe(250);
    });

    it('devolução dinheiro/pix abate da vendedora da venda original', () => {
      const rows = montarVendedoras({
        ...base,
        ativas: [{ codigo: '25', nome: 'MARIA' }],
        vendas: [{ sellerId: '25', sellerName: 'MARIA', mes: 1000, hoje: 100 }],
        devolucoes: [{ sellerId: '25', sellerName: 'MARIA', mes: 150, hoje: 150 }],
      });
      expect(rows[0].realizadoMes).toBe(850);
      expect(rows[0].realizadoHoje).toBe(-50);
    });

    it('quem vendeu fora da whitelist aparece no fim, com a mesma meta individual', () => {
      const rows = montarVendedoras({
        ...base,
        ativas: [
          { codigo: '25', nome: 'MARIA' },
          { codigo: '30', nome: 'ANA' },
        ],
        vendas: [
          { sellerId: '25', sellerName: 'MARIA', mes: 100, hoje: 0 },
          { sellerId: '99', sellerName: 'GERENTE REGIONAL', mes: 5000, hoje: 0 },
        ],
        devolucoes: [],
      });
      // Ordenado por realizado: a extra vendeu mais, mas a META individual
      // continua meta/2 (a whitelist é o divisor, não quem apareceu).
      expect(rows).toHaveLength(3);
      const extra = rows.find((r) => !r.naWhitelist)!;
      expect(extra.nome).toBe('GERENTE REGIONAL');
      expect(extra.metaMes).toBe(15000);
      expect(rows.filter((r) => r.naWhitelist)).toHaveLength(2);
    });

    it('sem whitelist, divide por quem vendeu no mês', () => {
      const rows = montarVendedoras({
        ...base,
        ativas: [],
        vendas: [
          { sellerId: '1', sellerName: 'A', mes: 10, hoje: 0 },
          { sellerId: '2', sellerName: 'B', mes: 20, hoje: 0 },
        ],
        devolucoes: [],
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].metaMes).toBe(15000);
    });

    it('sem whitelist e sem vendas → lista vazia (não divide por zero)', () => {
      expect(
        montarVendedoras({ ...base, ativas: [], vendas: [], devolucoes: [] }),
      ).toEqual([]);
    });

    it('venda sem vendedora não vira linha de gente', () => {
      const rows = montarVendedoras({
        ...base,
        ativas: [{ codigo: '25', nome: 'MARIA' }],
        vendas: [{ sellerId: null, sellerName: '  ', mes: 900, hoje: 0 }],
        devolucoes: [],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].realizadoMes).toBe(0);
    });
  });

  describe('montarRanking', () => {
    const lojas = [
      { code: '01', name: 'Santos' },
      { code: '06', name: 'Sorocaba' },
      { code: '15', name: 'Loja Nova' },
    ];

    it('participação no bolo da rede: fatias somam 100, maior primeiro', () => {
      const rows = montarRanking({
        lojas,
        atualPorCode: new Map([
          ['01', 300],
          ['06', 500],
          ['15', 200],
        ]),
        minhaLoja: '06',
      });
      expect(rows.map((r) => r.storeCode)).toEqual(['06', '01', '15']);
      expect(rows[0]).toMatchObject({ pct: 50, posicao: 1, minha: true });
      expect(rows[1]).toMatchObject({ pct: 30, posicao: 2, minha: false });
      expect(rows[2]).toMatchObject({ pct: 20, posicao: 3 });
      expect(rows.reduce((s, r) => s + r.pct, 0)).toBeCloseTo(100, 1);
    });

    it('loja sem venda aparece com 0% (rede zerada não divide por zero)', () => {
      const zerada = montarRanking({ lojas, atualPorCode: new Map() });
      expect(zerada.every((r) => r.pct === 0)).toBe(true);
      const rows = montarRanking({
        lojas,
        atualPorCode: new Map([['01', 100]]),
      });
      expect(rows[0]).toMatchObject({ storeCode: '01', pct: 100 });
      expect(rows[1].pct).toBe(0);
    });

    it('código órfão (fora do cadastro) não entra no bolo — as fatias exibidas fecham 100', () => {
      const rows = montarRanking({
        lojas,
        atualPorCode: new Map([
          ['01', 600],
          ['06', 400],
          ['99', 999999], // loja desativada/código não canonizado
        ]),
      });
      expect(rows.map((r) => r.storeCode)).toEqual(['01', '06', '15']);
      expect(rows[0].pct).toBe(60);
      expect(rows[1].pct).toBe(40);
    });

    it('não vaza valor em reais no payload', () => {
      const rows = montarRanking({
        lojas,
        atualPorCode: new Map([['01', 123456.78]]),
      });
      for (const r of rows) {
        expect(Object.keys(r).sort()).toEqual(
          ['minha', 'pct', 'posicao', 'storeCode', 'storeName'].sort(),
        );
      }
    });
  });
});
