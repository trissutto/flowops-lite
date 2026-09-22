import { CashbackService } from './cashback.service';

/**
 * A MATEMÁTICA DO SALDO — as regras que não podem regredir.
 *
 * Este é o ledger que a cliente vê em três telas (PDV, site, app) e que o
 * caixa aceita como pagamento. Cada teste aqui existe porque a regra tem uma
 * decisão do dono atrás, ou porque o jeito óbvio de escrever o código erra:
 *
 *  - carência e validade não são enfeite: saldo fora da janela NÃO pode ser
 *    gasto, e o que está na carência aparece separado (a cliente pergunta
 *    "quando libera" e a vendedora precisa responder);
 *  - saldo negativo (devolução do que já foi gasto) NÃO expira — se expirasse,
 *    a dívida sumiria sozinha e comprar-ganhar-gastar-devolver seria de graça;
 *  - o consumo é FIFO PELO QUE VENCE PRIMEIRO, não pelo mais antigo: gastar o
 *    crédito de validade longa e deixar vencer o curto queima dinheiro da
 *    cliente sem ela saber;
 *  - devolver o uso volta ao MESMO crédito, com a validade original. Crédito
 *    novo daria sobrevida a saldo vencido.
 */
describe('CashbackService — saldo, uso e desfazer', () => {
  const HOJE = new Date('2026-09-22T12:00:00.000Z');
  const dia = (n: number) => {
    const d = new Date(HOJE);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };
  const CPF = '12345678901';

  const CFG = {
    ativo: true,
    pctPrimeiraCompra: 10,
    pctDemais: 3,
    carenciaDias: 5,
    validadeDias: 30,
    usoMaxPctCompra: 30,
    minimoUsoReais: 5,
    crediarioNoPagamento: true,
  };

  /** Crédito com defaults sãos — o teste sobrescreve só o que interessa. */
  const credito = (over: any = {}) => ({
    id: over.id || 'c1',
    cpf: CPF,
    valor: 100,
    usado: 0,
    cancelado: 0,
    base: 1000,
    percentual: 10,
    origem: 'venda',
    saleId: 's1',
    storeCode: '01',
    primeiraCompra: false,
    liberaEm: dia(-10),
    expiraEm: dia(+20),
    createdAt: dia(-10),
    ...over,
  });

  /**
   * Prisma de mentira. `$transaction(fn)` executa o callback com o próprio
   * mock — é o que permite testar `usar`/`estornarUso` sem banco.
   */
  const prismaMock = (over: any = {}) => {
    const base: any = {
      systemSetting: {
        findUnique: jest.fn().mockResolvedValue({ value: JSON.stringify(CFG) }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      cashbackCredito: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
        ...(over.cashbackCredito || {}),
      },
      cashbackUso: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        ...(over.cashbackUso || {}),
      },
      pdvSale: { count: jest.fn().mockResolvedValue(0) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    };
    base.$transaction = jest.fn((fn: any) =>
      typeof fn === 'function' ? fn(base) : Promise.all(fn),
    );
    return { ...base, ...over, $transaction: base.$transaction };
  };

  const svc = (prisma: any) => {
    const s = new CashbackService(prisma) as any;
    // "Hoje" fixo: sem isso o teste muda de resultado conforme o dia em que roda.
    jest.spyOn(s, 'hoje').mockReturnValue(HOJE);
    return s as CashbackService;
  };

  /* ───────────────────────────── saldo ───────────────────────────── */

  it('separa o que dá pra usar AGORA do que ainda está na carência', async () => {
    const prisma = prismaMock({
      cashbackCredito: {
        findMany: jest.fn().mockResolvedValue([
          credito({ id: 'liberado', valor: 40 }),
          credito({ id: 'na-carencia', valor: 25, liberaEm: dia(+3), expiraEm: dia(+33) }),
        ]),
      },
    });
    const s = await svc(prisma).saldo(CPF);

    expect(s.disponivel).toBe(40);
    expect(s.aLiberar).toBe(25);
    // A DATA importa tanto quanto o valor: é o que a vendedora responde.
    expect(s.liberaEm).toBe(dia(+3).toISOString().slice(0, 10));
  });

  it('não conta crédito vencido como disponível', async () => {
    const prisma = prismaMock({
      cashbackCredito: {
        findMany: jest.fn().mockResolvedValue([
          credito({ id: 'vencido', valor: 70, expiraEm: dia(-1) }),
          credito({ id: 'vivo', valor: 30 }),
        ]),
      },
    });
    const s = await svc(prisma).saldo(CPF);

    expect(s.disponivel).toBe(30);
    expect(s.totalExpirado).toBe(70);
  });

  it('desconta o que já foi gasto e o que a devolução cancelou', async () => {
    const prisma = prismaMock({
      cashbackCredito: {
        findMany: jest.fn().mockResolvedValue([
          credito({ valor: 100, usado: 30, cancelado: 20 }),
        ]),
      },
    });
    const s = await svc(prisma).saldo(CPF);

    expect(s.disponivel).toBe(50);
    expect(s.totalUsado).toBe(30);
  });

  it('saldo negativo abate o positivo e a tela nunca mostra menos que zero', async () => {
    const prisma = prismaMock({
      cashbackCredito: {
        findMany: jest.fn().mockResolvedValue([
          credito({ id: 'bom', valor: 20 }),
          // Estorno: nasce liberado e com validade em 2099 de propósito.
          credito({ id: 'divida', valor: -50, origem: 'estorno_devolucao', expiraEm: dia(9999) }),
        ]),
      },
    });
    const s = await svc(prisma).saldo(CPF);

    // A dívida (-50) supera o crédito (20): mostra 0, não -30.
    expect(s.disponivel).toBe(0);
  });

  it('a dívida NÃO expira — senão bastaria esperar pra ela sumir', async () => {
    const prisma = prismaMock({
      cashbackCredito: {
        findMany: jest.fn().mockResolvedValue([
          credito({ id: 'bom', valor: 100 }),
          // Data de expiração no passado: mesmo assim o negativo pesa.
          credito({ id: 'divida', valor: -40, expiraEm: dia(-100), liberaEm: dia(-100) }),
        ]),
      },
    });
    const s = await svc(prisma).saldo(CPF);

    expect(s.disponivel).toBe(60);
  });

  it('CPF torto devolve saldo zero em vez de explodir', async () => {
    const s = await svc(prismaMock()).saldo('123');
    expect(s.disponivel).toBe(0);
    expect(s.cpf).toBe('');
  });

  /* ─────────────────────────── quanto pode usar ─────────────────────────── */

  it('limita ao teto de 30% da compra', async () => {
    const prisma = prismaMock({
      cashbackCredito: { findMany: jest.fn().mockResolvedValue([credito({ valor: 200 })]) },
    });
    const r = await svc(prisma).quantoPodeUsar(CPF, 100);

    expect(r.permitido).toBe(30);
    expect(r.saldo).toBe(200);
    expect(r.motivo).toMatch(/30%/);
  });

  it('recusa saldo abaixo do mínimo, com o motivo escrito', async () => {
    const prisma = prismaMock({
      cashbackCredito: { findMany: jest.fn().mockResolvedValue([credito({ valor: 3 })]) },
    });
    const r = await svc(prisma).quantoPodeUsar(CPF, 500);

    expect(r.permitido).toBe(0);
    expect(r.motivo).toMatch(/mínimo/i);
  });

  it('programa desligado não deixa resgatar, mesmo com saldo', async () => {
    const prisma = prismaMock({
      systemSetting: {
        findUnique: jest.fn().mockResolvedValue({ value: JSON.stringify({ ...CFG, ativo: false }) }),
      },
      cashbackCredito: { findMany: jest.fn().mockResolvedValue([credito({ valor: 500 })]) },
    });
    const r = await svc(prisma).quantoPodeUsar(CPF, 1000);

    expect(r.ativo).toBe(false);
    expect(r.permitido).toBe(0);
  });

  /* ───────────────────────────── usar ───────────────────────────── */

  it('consome primeiro o crédito que VENCE ANTES', async () => {
    const vencePrimeiro = credito({ id: 'curto', valor: 20, expiraEm: dia(+2) });
    const venceDepois = credito({ id: 'longo', valor: 80, expiraEm: dia(+25) });
    const prisma = prismaMock({
      cashbackCredito: {
        findMany: jest.fn().mockResolvedValue([vencePrimeiro, venceDepois]),
        update: jest.fn().mockResolvedValue({}),
      },
    });

    const r = await svc(prisma).usar({ cpf: CPF, saleId: 'v1', storeCode: '01', valor: 50 });

    expect(r.usado).toBe(50);
    const updates = prisma.cashbackCredito.update.mock.calls;
    expect(updates[0][0].where.id).toBe('curto');
    expect(updates[0][0].data.usado.increment).toBe(20);
    expect(updates[1][0].where.id).toBe('longo');
    expect(updates[1][0].data.usado.increment).toBe(30);
  });

  it('usa o que dá quando o saldo mudou entre a tela e o clique — não estoura', async () => {
    const prisma = prismaMock({
      cashbackCredito: {
        findMany: jest.fn().mockResolvedValue([credito({ valor: 12 })]),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    const r = await svc(prisma).usar({ cpf: CPF, saleId: 'v1', storeCode: '01', valor: 50 });

    // Quem chama tem que gravar o pagamento pelo USADO, não pelo pedido.
    expect(r.usado).toBe(12);
  });

  it('cada resgate deixa a linha que diz qual crédito bancou', async () => {
    const prisma = prismaMock({
      cashbackCredito: {
        findMany: jest.fn().mockResolvedValue([credito({ id: 'c9', valor: 40 })]),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    await svc(prisma).usar({ cpf: CPF, saleId: 'v1', storeCode: '07', valor: 40 });

    expect(prisma.cashbackUso.create).toHaveBeenCalledWith({
      data: { cpf: CPF, creditoId: 'c9', saleId: 'v1', storeCode: '07', valor: 40 },
    });
  });

  /* ─────────────────────────── desfazer ─────────────────────────── */

  it('devolver o uso volta ao MESMO crédito e marca a linha como estornada', async () => {
    const prisma = prismaMock({
      cashbackUso: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'u1', creditoId: 'c1', valor: 18, estornadoEm: null },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    const r = await svc(prisma).estornarUso('v1', 'teste');

    expect(r.devolvido).toBe(18);
    expect(prisma.cashbackCredito.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { usado: { decrement: 18 } },
    });
    expect(prisma.cashbackUso.update.mock.calls[0][0].data.estornadoEm).toBeInstanceOf(Date);
  });

  it('devolver duas vezes não devolve em dobro', async () => {
    // A segunda chamada não acha mais linha com estornadoEm null.
    const prisma = prismaMock({
      cashbackUso: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const r = await svc(prisma).estornarUso('v1');

    expect(r.devolvido).toBe(0);
    expect(prisma.cashbackCredito.update).not.toHaveBeenCalled();
  });

  it('devolução parcial cancela a fatia proporcional do cashback', async () => {
    const prisma = prismaMock({
      cashbackCredito: {
        findFirst: jest.fn().mockResolvedValue(
          credito({ valor: 100, base: 1000, usado: 0, cancelado: 0 }),
        ),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    // Voltou 30% da compra (R$ 300 de R$ 1000) → cancela 30% do crédito.
    const r = await svc(prisma).estornarDevolucao({
      saleId: 'v1', returnId: 'r1', valorDevolvido: 300, storeCode: '01',
    });

    expect(r?.cancelado).toBe(30);
    expect(prisma.cashbackCredito.create).not.toHaveBeenCalled();
  });

  it('devolveu depois de gastar: o descoberto vira DÍVIDA que não expira', async () => {
    const prisma = prismaMock({
      cashbackCredito: {
        // Ganhou 100 e já gastou 80 — só 20 dá pra cancelar.
        findFirst: jest.fn().mockResolvedValue(credito({ valor: 100, base: 1000, usado: 80 })),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    const r = await svc(prisma).estornarDevolucao({
      saleId: 'v1', returnId: 'r1', valorDevolvido: 1000, storeCode: '01',
    });

    expect(r?.cancelado).toBe(100);
    const criado = prisma.cashbackCredito.create.mock.calls[0][0].data;
    expect(criado.valor).toBe(-80);
    expect(criado.origem).toBe('estorno_devolucao');
    // 2099: o negativo não pode evaporar com o tempo.
    expect(new Date(criado.expiraEm).getUTCFullYear()).toBe(2099);
  });

  it('venda cancelada revoga o que ela creditou', async () => {
    const prisma = prismaMock({
      cashbackCredito: {
        findFirst: jest.fn().mockResolvedValue(credito({ valor: 45, usado: 0 })),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    const r = await svc(prisma).cancelarCreditoDeVenda('v1');

    expect(r?.cancelado).toBe(45);
    expect(prisma.cashbackCredito.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { cancelado: { increment: 45 } },
    });
  });

  it('venda cancelada com o crédito já gasto deixa saldo negativo', async () => {
    const prisma = prismaMock({
      cashbackCredito: {
        findFirst: jest.fn().mockResolvedValue(credito({ valor: 45, usado: 45 })),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    const r = await svc(prisma).cancelarCreditoDeVenda('v1');

    expect(r?.cancelado).toBe(45);
    expect(prisma.cashbackCredito.create.mock.calls[0][0].data.valor).toBe(-45);
  });

  /* ───────────────────────────── creditar ───────────────────────────── */

  it('não credita cashback sobre o pedaço pago COM cashback', async () => {
    const prisma = prismaMock();
    const s = svc(prisma) as any;
    jest.spyOn(s, 'ehPrimeiraCompra').mockResolvedValue(false);

    await s.creditarVenda({
      saleId: 'v1', cpf: CPF, storeCode: '01', total: 200, pagoComCashback: 50,
    });

    // 3% de 150 (e não de 200): pagar cashback sobre cashback é juro sobre
    // o próprio benefício.
    expect(prisma.cashbackCredito.create.mock.calls[0][0].data.valor).toBe(4.5);
  });

  it('venda de TREINAMENTO não credita nada', async () => {
    const prisma = prismaMock();
    const r = await svc(prisma).creditarVenda({
      saleId: 'v1', cpf: CPF, storeCode: '15', total: 500, isTraining: true,
    });

    expect(r).toBeNull();
    expect(prisma.cashbackCredito.create).not.toHaveBeenCalled();
  });

  it('venda sem CPF não credita — sem chave não há como a cliente reencontrar', async () => {
    const prisma = prismaMock();
    const r = await svc(prisma).creditarVenda({
      saleId: 'v1', cpf: null, storeCode: '01', total: 500,
    });

    expect(r).toBeNull();
  });

  it('programa desligado não credita', async () => {
    const prisma = prismaMock({
      systemSetting: {
        findUnique: jest.fn().mockResolvedValue({ value: JSON.stringify({ ...CFG, ativo: false }) }),
      },
    });
    const r = await svc(prisma).creditarVenda({
      saleId: 'v1', cpf: CPF, storeCode: '01', total: 500,
    });

    expect(r).toBeNull();
  });

  it('config ilegível NÃO liga o cashback sozinha', async () => {
    const prisma = prismaMock({
      systemSetting: { findUnique: jest.fn().mockRejectedValue(new Error('banco fora')) },
    });
    const cfg = await svc(prisma).config();

    expect(cfg.ativo).toBe(false);
  });
});
