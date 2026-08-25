import { CobrancasOnlineService } from './cobrancas-online.service';

/**
 * A RÉGUA DA LISTA "AGUARDANDO PAGAMENTO" (25/08/2026).
 *
 * O que estes testes seguram, na ordem em que os erros doeriam de verdade:
 *
 *   1. PIX e link na MESMA lista — o defeito original era o widget enxergar só
 *      `pagarme_payments` e o PIX não existir em tela nenhuma;
 *   2. uma linha por VENDA — "gerar outro código" cria cobrança nova, e a
 *      venda da Marilda tinha 4 QRs do mesmo atendimento;
 *   3. QR vencido NÃO é "aguardando" — o cron do PagBank só carimba `expired`
 *      depois de 6h, então até lá o banco diz `pending` num código morto;
 *   4. venda já finalizada/cancelada sai da lista — senão a fila nunca esvazia
 *      e a loja para de olhar (alarme falso mata a confiança).
 */
function montar(dados: { pix?: any[]; links?: any[]; sales?: any[]; stores?: any[] }) {
  const prisma: any = {
    pagbankPayment: { findMany: jest.fn().mockResolvedValue(dados.pix ?? []) },
    pagarmePayment: { findMany: jest.fn().mockResolvedValue(dados.links ?? []) },
    pdvSale: { findMany: jest.fn().mockResolvedValue(dados.sales ?? []) },
    store: { findMany: jest.fn().mockResolvedValue(dados.stores ?? []) },
  };
  const svc: any = Object.create(CobrancasOnlineService.prototype);
  svc.prisma = prisma;
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { svc: svc as CobrancasOnlineService, prisma };
}

const agora = Date.now();
const min = (m: number) => new Date(agora + m * 60_000);

const venda = (over: Partial<any> = {}) => ({
  id: 'venda-1',
  storeCode: '13',
  status: 'open',
  total: 142.3,
  createdAt: min(-180),
  customerName: 'MARILDA ARAUJO',
  customerPhone: '11984335576',
  customerCpf: null,
  sellerName: 'KARINE',
  vendedorName: null,
  entregaTipo: 'sedex',
  payments: [],
  ...over,
});

const pix = (over: Partial<any> = {}) => ({
  saleId: 'venda-1',
  status: 'pending',
  valor: 142.3,
  pagbankOrderId: 'ORDE_1',
  linkToken: 'abc1234567',
  createdAt: min(-30),
  paidAt: null,
  expiresAt: min(30),
  ...over,
});

describe('CobrancasOnlineService — a lista que diz se a cliente pagou', () => {
  it('mostra o PIX do PagBank, que não aparecia em tela nenhuma', async () => {
    const { svc } = montar({ pix: [pix()], sales: [venda()], stores: [{ code: '13', name: 'SITE' }] });

    const r = await svc.listar({ storeCode: '13' });

    expect(r).toHaveLength(1);
    expect(r[0].meio).toBe('pix');
    expect(r[0].situacao).toBe('aguardando');
    expect(r[0].storeName).toBe('SITE');
    expect(r[0].link).toMatch(/\/qr\/abc1234567$/);
  });

  it('junta PIX e link Pagar.me na mesma lista', async () => {
    const { svc } = montar({
      pix: [pix()],
      links: [
        {
          saleId: 'venda-2',
          status: 'pending',
          valor: 288,
          pagarmeOrderId: 'or_X',
          linkToken: 'tok9876543',
          qrCodeText: 'https://checkout.pagar.me/cru',
          createdAt: min(-60),
          paidAt: null,
          expiresAt: min(600),
        },
      ],
      sales: [venda(), venda({ id: 'venda-2', total: 288, customerName: 'ALYNE' })],
    });

    const r = await svc.listar({ storeCode: null });

    expect(r.map((i) => i.meio).sort()).toEqual(['link', 'pix']);
    // O link que vai pra cliente é o NOSSO, nunca a URL crua da Pagar.me
    // (ela vira 404 assim que a cobrança fecha).
    expect(r.find((i) => i.meio === 'link')!.link).toMatch(/\/pg\/tok9876543$/);
  });

  it('4 QRs do mesmo atendimento viram UMA linha, com a conta das tentativas', async () => {
    const { svc } = montar({
      pix: [
        pix({ pagbankOrderId: 'ORDE_1', createdAt: min(-40) }),
        pix({ pagbankOrderId: 'ORDE_2', createdAt: min(-30) }),
        pix({ pagbankOrderId: 'ORDE_3', createdAt: min(-20) }),
        pix({ pagbankOrderId: 'ORDE_4', createdAt: min(-10) }),
      ],
      sales: [venda()],
    });

    const r = await svc.listar({ storeCode: '13' });

    expect(r).toHaveLength(1);
    expect(r[0].tentativas).toBe(4);
    // A cobrança que a tela mostra é a mais NOVA (é a que está na mão da
    // cliente); a idade conta da PRIMEIRA, que é há quanto tempo isso arrasta.
    expect(r[0].orderId).toBe('ORDE_4');
    expect(r[0].horas).toBe(1);
  });

  it('QR vencido não é "aguardando" — mesmo com o banco ainda dizendo pending', async () => {
    const { svc } = montar({
      pix: [pix({ expiresAt: min(-120) })],
      sales: [venda()],
    });

    const r = await svc.listar({ storeCode: '13' });

    expect(r[0].situacao).toBe('venceu');
    expect(r[0].statusGateway).toBe('pending');
  });

  it('cobrança paga vence as outras e vem primeiro na lista', async () => {
    const { svc } = montar({
      pix: [
        pix({ pagbankOrderId: 'ORDE_VELHO', status: 'expired', createdAt: min(-90), expiresAt: min(-30) }),
        pix({ pagbankOrderId: 'ORDE_PAGO', status: 'paid', paidAt: min(-5), createdAt: min(-20) }),
      ],
      links: [
        {
          saleId: 'venda-2',
          status: 'pending',
          valor: 288,
          pagarmeOrderId: 'or_X',
          linkToken: 'tok9876543',
          qrCodeText: null,
          createdAt: min(-600),
          paidAt: null,
          expiresAt: min(600),
        },
      ],
      sales: [venda(), venda({ id: 'venda-2', total: 288 })],
    });

    const r = await svc.listar({ storeCode: null });

    expect(r[0].situacao).toBe('pago');
    expect(r[0].orderId).toBe('ORDE_PAGO');
  });

  it('venda já finalizada sai da lista (quem consulta é o findMany, que só traz aberta)', async () => {
    const { svc, prisma } = montar({ pix: [pix()], sales: [] });

    const r = await svc.listar({ storeCode: '13' });

    expect(r).toEqual([]);
    expect(prisma.pdvSale.findMany.mock.calls[0][0].where.status).toEqual({ in: ['open', 'paused'] });
  });

  it('cobrança curta: o "cobrar de novo" recebe o RESTANTE, não o total', async () => {
    const { svc } = montar({
      pix: [pix()],
      sales: [venda({ total: 142.3, payments: [{ valor: 42.3 }] })],
    });

    const r = await svc.listar({ storeCode: '13' });

    expect(r[0].total).toBe(142.3);
    expect(r[0].restante).toBe(100);
  });
});
