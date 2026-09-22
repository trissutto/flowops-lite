import { CrediarioBaixaService } from './crediario-baixa.service';

/**
 * A NEGOCIAÇÃO DE JUROS NO RECEBIMENTO (dono, 17/09/2026).
 *
 * "Preciso reduzir os juros na hora de receber, clicando na própria tela."
 * O que este arquivo tranca é o que não pode escapar pro dinheiro:
 *   - o desconto só toca o JUROS (principal inteiro, sempre);
 *   - `totalPago = totalPrincipal + totalJuros` continua valendo — é o que o
 *     caixa, o recibo e a página do PIX leem;
 *   - cada parcela leva o juros já descontado (o histórico do cliente e o ERP
 *     recebem o mesmo número do recibo);
 *   - o teto da loja é respeitado, e a matriz não tem teto.
 */
describe('previewBaixa — juros negociado', () => {
  // Três parcelas da OZELINA (tela do dono): 322 dias de atraso.
  const parcelas = [
    { registro: '9001', controle: '1', valorParcela: 151, juros: 158.46 },
    { registro: '9002', controle: '1', valorParcela: 144, juros: 151.11 },
    { registro: '9003', controle: '1', valorParcela: 309, juros: 324.26 },
  ];

  function montar(over: { descontoJurosMaxPct?: number } = {}) {
    const prisma: any = {
      crediarioConfig: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'singleton', diasCarencia: 0, taxaMensalPercent: 10, enabled: true,
          multaPercent: 2, jurosMaxPercentParcela: 0,
          limiteEnabled: false, limiteMaxParcelasVencidas: 0, limiteMaxValorEmAberto: 0,
          descontoJurosMaxPct: over.descontoJurosMaxPct ?? 100,
        }),
        create: jest.fn(),
      },
      wincredMovimentoAberto: {
        findFirst: jest.fn(async ({ where }: any) => {
          const p = parcelas.find((x) => x.registro === where.registro);
          if (!p) return null;
          return {
            registro: p.registro, controle: p.controle, numeroCompra: '77', parcela: 1, totalParcelas: 3,
            vencimento: new Date('2025-10-30T00:00:00Z'), valorParcela: p.valorParcela,
            codCliente: '2', nome: 'OZELINA DOS SANTOS', obs: 'CLEIA',
          };
        }),
      },
      crediarioParcela: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const svc = new CrediarioBaixaService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
    // O juros de cada parcela vem da régua de sempre (calcJuros) — aqui ele é
    // fixado pra o teste falar só da NEGOCIAÇÃO.
    jest.spyOn(svc, 'calcJuros').mockImplementation((_venc: any, valor: any) => ({
      diasAtraso: 322,
      juros: parcelas.find((p) => p.valorParcela === valor)?.juros ?? 0,
    }));
    return svc;
  }

  const pedir = (svc: any, extra: any = {}) =>
    svc.previewBaixa({ parcelas: parcelas.map((p) => ({ registro: p.registro, controle: p.controle })), ...extra });

  it('sem desconto, a conta é a de sempre', async () => {
    const r = await pedir(montar());
    expect(r.totalPrincipal).toBe(604);
    expect(r.totalJuros).toBe(633.83);
    expect(r.totalJurosCheio).toBe(633.83);
    expect(r.descontoJuros).toBe(0);
    expect(r.totalPago).toBe(1237.83);
  });

  it('50% no juros: principal inteiro e total fechando centavo a centavo', async () => {
    const r = await pedir(montar(), { descontoJurosPct: 50 });
    expect(r.totalPrincipal).toBe(604); // principal NÃO se toca
    expect(r.totalJuros).toBe(316.92);
    expect(r.totalJurosCheio).toBe(633.83);
    expect(r.descontoJuros).toBe(316.91);
    expect(r.totalPago).toBe(920.92);
    expect(Math.round((r.totalPrincipal + r.totalJuros) * 100) / 100).toBe(r.totalPago);
  });

  it('cada parcela leva o juros já descontado (recibo = histórico = ERP)', async () => {
    const r = await pedir(montar(), { descontoJurosPct: 50 });
    expect(r.parcelas.map((p: any) => p.jurosCalculado)).toEqual([79.23, 75.56, 162.13]);
    expect(r.parcelas.map((p: any) => p.jurosCheio)).toEqual([158.46, 151.11, 324.26]);
    expect(r.parcelas.map((p: any) => p.valorComJuros)).toEqual([230.23, 219.56, 471.13]);
    const soma = Math.round(r.parcelas.reduce((s: number, p: any) => s + p.valorComJuros, 0) * 100) / 100;
    expect(soma).toBe(r.totalPago);
  });

  it('juros perdoado (100%) deixa a cliente pagando só o principal', async () => {
    const r = await pedir(montar(), { descontoJurosPct: 100 });
    expect(r.totalJuros).toBe(0);
    expect(r.totalPago).toBe(604);
  });

  it('a loja não passa do teto que a matriz definiu', async () => {
    await expect(pedir(montar({ descontoJurosMaxPct: 20 }), { descontoJurosPct: 50, tetoDescontoPct: 20 }))
      .rejects.toThrow(/até 20% do juros/);
  });

  it('teto zero = loja não negocia juros, e a frase diz quem libera', async () => {
    await expect(pedir(montar({ descontoJurosMaxPct: 0 }), { descontoJurosPct: 10, tetoDescontoPct: 0 }))
      .rejects.toThrow(/matriz/);
  });

  it('matriz não tem teto (tetoDescontoPct null)', async () => {
    const r = await pedir(montar({ descontoJurosMaxPct: 20 }), { descontoJurosPct: 100, tetoDescontoPct: null });
    expect(r.totalJuros).toBe(0);
  });

  it('dentro do teto passa', async () => {
    const r = await pedir(montar({ descontoJurosMaxPct: 50 }), { descontoJurosPct: 50, tetoDescontoPct: 50 });
    expect(r.descontoJuros).toBe(316.91);
  });
});
