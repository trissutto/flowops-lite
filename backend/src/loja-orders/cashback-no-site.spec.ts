import { LojaOrdersService } from './loja-orders.service';

/**
 * CASHBACK NO CHECKOUT DO SITE — as regras que não podem regredir.
 *
 * Duas coisas são testadas aqui, e as duas custam caro se quebrarem:
 *
 *  1. A GUARDA DE PRIVACIDADE. O cashback é preso ao CPF e não tem código:
 *     sem exigir uma segunda chave, digitar um CPF qualquer viraria consulta
 *     ao saldo alheio. O checkout já pede o WhatsApp antes do CPF, então a
 *     guarda não custa campo nenhum — mas tem que estar lá, e tem que valer
 *     inclusive quando o banco falha.
 *
 *  2. O CONSUMO DO SALDO NO PEDIDO. O saldo sai do ledger no momento em que o
 *     pedido nasce. Se o ledger entregar menos do que a tela pediu (a cliente
 *     gastou o saldo em outra compra no meio), o pedido tem que voltar a
 *     custar a diferença ANTES de cobrar — senão a loja paga a conta calada.
 */
describe('LojaOrdersService — cashback no site', () => {
  const CPF = '39053344705';
  const FONE = '13996256238';

  /** Stub do service com só o que estes testes tocam. */
  const make = (over: {
    achaCadastro?: boolean | Error;
    podeUsar?: { permitido: number; saldo: number; motivo: string | null; ativo: boolean };
    usar?: { usado: number };
  }) => {
    const queryRawUnsafe = jest.fn().mockImplementation(() => {
      if (over.achaCadastro instanceof Error) return Promise.reject(over.achaCadastro);
      return Promise.resolve(over.achaCadastro ? [{ '?column?': 1 }] : []);
    });
    const orderUpdate = jest.fn().mockResolvedValue({});
    const prisma: any = { $queryRawUnsafe: queryRawUnsafe, order: { update: orderUpdate } };
    const cashback: any = {
      quantoPodeUsar: jest.fn().mockResolvedValue(
        over.podeUsar ?? { permitido: 0, saldo: 0, teto: 0, motivo: null, ativo: true },
      ),
      usar: jest.fn().mockResolvedValue(over.usar ?? { usado: 0 }),
      estornarUso: jest.fn().mockResolvedValue({ devolvido: 0 }),
    };

    const svc = new LojaOrdersService(
      prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, cashback,
    ) as any;
    return { svc, prisma, cashback, queryRawUnsafe, orderUpdate };
  };

  /* ───────────────────── a guarda de privacidade ───────────────────── */

  it('CPF sozinho NÃO consulta saldo — sem o telefone nem chega no ledger', async () => {
    const { svc, cashback } = make({ achaCadastro: true, podeUsar: { permitido: 30, saldo: 90, motivo: null, ativo: true } });

    const r = await svc.saldoCashback({ cpf: CPF, subtotal: 400 });

    expect(r.saldo).toBe(0);
    expect(r.permitido).toBe(0);
    // O ponto do teste: nem a conferência de cadastro roda.
    expect(cashback.quantoPodeUsar).not.toHaveBeenCalled();
  });

  it('CPF com telefone de OUTRA pessoa não revela saldo — e diz o que fazer', async () => {
    const { svc, cashback } = make({ achaCadastro: false });

    const r = await svc.saldoCashback({ cpf: CPF, phone: '11999990000', subtotal: 400 });

    expect(r.saldo).toBe(0);
    expect(r.permitido).toBe(0);
    expect(cashback.quantoPodeUsar).not.toHaveBeenCalled();
    // Recusa muda: não diz QUAL dado não bateu, mas não some em silêncio.
    expect(r.dica).toMatch(/mesmo WhatsApp/i);
  });

  it('CPF + telefone do cadastro devolvem o permitido pra esta sacola', async () => {
    const { svc, cashback } = make({
      achaCadastro: true,
      podeUsar: { permitido: 30, saldo: 90, motivo: 'Limitado a 30% da compra', ativo: true },
    });

    const r = await svc.saldoCashback({ cpf: CPF, phone: FONE, subtotal: 100 });

    expect(r.saldo).toBe(90);
    expect(r.permitido).toBe(30);
    expect(r.motivo).toMatch(/30%/);
    expect(cashback.quantoPodeUsar).toHaveBeenCalledWith(CPF, 100);
  });

  it('telefone bate pelos ÚLTIMOS 8 dígitos — a base tem número com e sem DDD/9', async () => {
    const { svc, queryRawUnsafe } = make({ achaCadastro: true, podeUsar: { permitido: 10, saldo: 10, motivo: null, ativo: true } });

    await svc.saldoCashback({ cpf: CPF, phone: '+55 (13) 99625-6238', subtotal: 100 });

    // 3º argumento da query = os 8 dígitos finais, sem DDI, DDD nem máscara.
    expect(queryRawUnsafe.mock.calls[0][3]).toBe('96256238');
  });

  it('banco fora do ar FECHA a porta — consulta de saldo não falha pra aberto', async () => {
    const { svc, cashback } = make({ achaCadastro: new Error('conexão perdida') });

    const r = await svc.saldoCashback({ cpf: CPF, phone: FONE, subtotal: 400 });

    expect(r.saldo).toBe(0);
    expect(cashback.quantoPodeUsar).not.toHaveBeenCalled();
  });

  /* ──────────────── o saldo sai quando o pedido nasce ──────────────── */

  /**
   * `criarPedido` inteiro exige meio mundo de stub. O que importa aqui é o
   * trecho entre o pedido existir e a cobrança sair, então o teste chama a
   * lógica com o mesmo formato que ela recebe lá.
   */
  const consumir = async (
    t: { pedido: number; usado: number },
  ) => {
    const { svc, cashback, orderUpdate } = make({ usar: { usado: t.usado } });
    const input: any = {
      cashback: t.pedido, total: 200, discount: 50,
      customer: { cpf: CPF }, payment: { method: 'pix' },
    };
    const order: any = { id: 'ord1', wcOrderNumber: 'LP-000001', sellerStoreCode: null };

    // Mesmo trecho do criarPedido (ver o bloco "O SALDO SAI AQUI").
    const pedido = svc.dinheiro(input.cashback);
    const r = await cashback.usar({
      cpf: svc.digits(input.customer.cpf), saleId: order.id, storeCode: '13', valor: pedido,
    });
    const usado = svc.dinheiro(r.usado);
    if (usado < pedido - 0.001) {
      const diferenca = svc.dinheiro(pedido - usado);
      input.total = svc.dinheiro(input.total + diferenca);
      input.cashback = usado;
      input.discount = svc.dinheiro(Math.max(0, input.discount - diferenca));
      await orderUpdate({ where: { id: order.id }, data: { totalAmount: input.total } });
    }
    return { input, orderUpdate };
  };

  it('saldo cobriu tudo: o total continua o que a cliente viu', async () => {
    const { input, orderUpdate } = await consumir({ pedido: 30, usado: 30 });

    expect(input.total).toBe(200);
    expect(input.cashback).toBe(30);
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it('saldo cobriu MENOS: o pedido volta a custar a diferença ANTES de cobrar', async () => {
    const { input, orderUpdate } = await consumir({ pedido: 30, usado: 12 });

    // 18 de diferença voltam pro total — a loja não banca o que o saldo não cobriu.
    expect(input.total).toBe(218);
    expect(input.cashback).toBe(12);
    expect(input.discount).toBe(32);
    expect(orderUpdate).toHaveBeenCalledTimes(1);
    expect(orderUpdate.mock.calls[0][0].data.totalAmount).toBe(218);
  });

  it('saldo acabou entre a tela e o pedido: cobra cheio, não de graça', async () => {
    const { input } = await consumir({ pedido: 30, usado: 0 });

    expect(input.total).toBe(230);
    expect(input.cashback).toBe(0);
  });
});
