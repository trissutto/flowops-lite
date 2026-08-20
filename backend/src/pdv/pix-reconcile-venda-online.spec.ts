import { PdvService } from './pdv.service';

/**
 * O RECONCILIADOR DE PIX PAGBANK FECHA VENDA ONLINE COMO VENDA ONLINE (19/08).
 *
 * Caso Ivone / Moema (venda 95052462): PIX gerado no painel "Venda Online",
 * cliente pagou, o cron chegou antes da vendedora e registrou `pix` de
 * balcão. O finalize só abre pedido de separação quando TODOS os pagamentos
 * são `venda_online` — então a venda fechou sem card, com NFC-e tentada e
 * estoque baixado na vendedora. Estes testes seguram a régua:
 *
 *   - cobrança com `origem='venda_online'` → `venda_online` (+ detalhes iguais
 *     aos do botão FINALIZAR pra "Gerar PIX");
 *   - cobrança antiga (sem origem) mas venda com forma de entrega → idem;
 *   - nada disso → continua `pix` de balcão, igual sempre foi.
 *
 * `PdvService` tem um construtor enorme; aqui ele é montado pelo protótipo só
 * com o que `confirmPixPagoSeVendaAberta` usa (prisma, addPayment, finalize).
 */
function montar(opts: {
  sale: any;
  cobranca?: any;
  cobrancaFalha?: boolean;
}) {
  const addPayment = jest.fn().mockResolvedValue({ id: 'pay-1' });
  const finalize = jest.fn().mockResolvedValue({ ok: true });
  const prisma: any = {
    pdvSale: { findUnique: jest.fn().mockResolvedValue(opts.sale) },
    pdvSalePayment: { findMany: jest.fn().mockResolvedValue([]) },
    pagbankPayment: {
      findUnique: opts.cobrancaFalha
        ? jest.fn().mockRejectedValue(new Error('coluna não existe'))
        : jest.fn().mockResolvedValue(opts.cobranca ?? null),
    },
  };
  const svc: any = Object.create(PdvService.prototype);
  svc.prisma = prisma;
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.reconcileRetryFalhas = new Map();
  svc.addPayment = addPayment;
  svc.finalize = finalize;
  return { svc: svc as PdvService, addPayment, finalize };
}

const entrada = { saleId: 'venda-1', pagbankOrderId: 'ORDE_X', valor: 277.9 };

describe('confirmPixPagoSeVendaAberta — venda online fecha como venda online', () => {
  it('cobrança marcada como venda online → registra `venda_online` com os detalhes do "Gerar PIX"', async () => {
    const { svc, addPayment, finalize } = montar({
      sale: { id: 'venda-1', status: 'open', total: 277.9, entregaTipo: null },
      cobranca: { origem: 'venda_online' },
    });

    const r = await svc.confirmPixPagoSeVendaAberta(entrada);

    expect(r).toEqual({ handled: true });
    expect(addPayment).toHaveBeenCalledTimes(1);
    const arg = addPayment.mock.calls[0][0];
    expect(arg.method).toBe('venda_online');
    expect(arg.valor).toBe(277.9);
    expect(arg.details).toMatchObject({
      tipo: 'pix_gerar',
      origem: 'whatsapp_instagram',
      pixTxid: 'ORDE_X',
      pagbankOrderId: 'ORDE_X',
      pixProvider: 'pagbank',
      pixPaidByWebhook: true,
      reconciliadoPeloCron: true,
    });
    expect(finalize).toHaveBeenCalledWith({ saleId: 'venda-1' });
  });

  it('cobrança antiga sem origem, mas venda com forma de entrega (SEDEX) → também é venda online', async () => {
    const { svc, addPayment } = montar({
      sale: { id: 'venda-1', status: 'open', total: 277.9, entregaTipo: 'sedex' },
      cobranca: { origem: null },
    });

    await svc.confirmPixPagoSeVendaAberta(entrada);

    expect(addPayment.mock.calls[0][0].method).toBe('venda_online');
  });

  it('sem origem e sem entrega → PIX de balcão, como sempre foi', async () => {
    const { svc, addPayment } = montar({
      sale: { id: 'venda-1', status: 'open', total: 119.9, entregaTipo: null },
      cobranca: null,
    });

    await svc.confirmPixPagoSeVendaAberta(entrada);

    const arg = addPayment.mock.calls[0][0];
    expect(arg.method).toBe('pix');
    expect(arg.details.tipo).toBeUndefined();
    expect(arg.details).toMatchObject({ pixTxid: 'ORDE_X', pixProvider: 'pagbank' });
  });

  it('se a consulta da cobrança falhar, cai no sinal da entrega em vez de derrubar o ciclo', async () => {
    const { svc, addPayment } = montar({
      sale: { id: 'venda-1', status: 'open', total: 50, entregaTipo: 'retirada' },
      cobrancaFalha: true,
    });

    const r = await svc.confirmPixPagoSeVendaAberta(entrada);

    expect(r.handled).toBe(true);
    expect(addPayment.mock.calls[0][0].method).toBe('venda_online');
  });
});
