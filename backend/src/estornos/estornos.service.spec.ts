import { EstornosService } from './estornos.service';

/**
 * O CAMINHO DO DINHEIRO — os testes que importam (22/09/2026).
 *
 * Cada um destes é um jeito conhecido de perder dinheiro ou mentir na tela:
 * cobrar duas vezes no duplo clique, oferecer saldo que já foi estornado por
 * fora, carimbar "processado" com o gateway em dúvida, ou dizer "recusado"
 * quando o dinheiro pode estar a caminho.
 */

const AGORA = new Date('2026-09-22T12:00:00.000Z');

function fakePrisma(over: any = {}) {
  const estornos: any[] = over.estornos || [];
  const tabela = (linhas: any[]) => ({ findMany: async () => linhas });
  return {
    estornos,
    pagbankPayment: {
      findUnique: async () => ({
        id: 'pay1',
        saleId: 'order1',
        storeCode: 'SITE',
        pagbankOrderId: 'ORDE_1',
        pagbankChargeId: 'CHAR_1',
        method: 'credit_card',
        valor: 100,
        status: 'paid',
        paidAt: new Date('2026-09-20T10:00:00.000Z'),
        origem: 'site',
        ...(over.pagamento || {}),
      }),
    },
    pagarmePayment: { findUnique: async () => null },
    estornoPagamento: {
      findUnique: async ({ where }: any) => estornos.find((e) => e.idempotencyKey === where.idempotencyKey || e.id === where.id) || null,
      findFirst: async ({ where }: any) =>
        estornos.find(
          (e) => e.gatewayChargeId === where.gatewayChargeId && (where.status?.in || []).includes(e.status),
        ) || null,
      findMany: async () => estornos,
      create: async ({ data }: any) => {
        const linha = { id: `est${estornos.length + 1}`, ...data };
        estornos.push(linha);
        return linha;
      },
      update: async ({ where, data }: any) => {
        const linha = estornos.find((e) => e.id === where.id);
        Object.assign(linha, data);
        return linha;
      },
    },
    estornoEvento: { create: async () => ({}), findMany: async () => [] },
    order: tabela([
      { id: 'order1', wcOrderNumber: 'LP-000123', wcOrderId: 123, status: 'delivered', customerName: 'Maria', customerCpf: '12345678909', customerEmail: 'maria@x.com', totalAmount: 100 },
    ]),
    pdvSale: tabela([]),
    livePdvCart: tabela([]),
    crediarioBaixa: tabela([]),
    orderItemSwap: tabela([]),
  } as any;
}

function montar(over: any = {}) {
  const prisma = fakePrisma(over);
  const chamadas = { consultas: 0, estornos: 0 };
  const pagbank = {
    consultarCobranca: async () => {
      chamadas.consultas++;
      return over.cobranca || { status: 'PAID', amount: { value: 10000, summary: { paid: 10000, refunded: 0 } } };
    },
    estornarCobranca: async () => {
      chamadas.estornos++;
      return over.resposta || { ok: true, charge: { status: 'CANCELED', amount: { summary: { paid: 10000, refunded: 10000 } } } };
    },
  } as any;
  const pagarme = { consultarCobranca: async () => null, estornarCobranca: async () => null } as any;
  const acesso = { registrar: async () => undefined } as any;
  const service = new EstornosService(prisma, pagbank, pagarme, acesso);
  return { service, prisma, chamadas };
}

const ator = { userId: 'u1', nome: 'Thiago', ip: '1.2.3.4', dispositivo: 'jest' };
const pedido = {
  pagamentoId: 'pagbank:pay1',
  tipo: 'integral' as const,
  motivo: 'devolucao_produto',
  ator,
  nivel: 'MASTER',
};

describe('EstornosService.solicitar', () => {
  it('integral aprovado vira processado com o total que o gateway confirmou', async () => {
    const { service, chamadas } = montar();
    const r = await service.solicitar(pedido);
    expect(r.estorno.status).toBe('processado');
    expect(r.estorno.valorCents).toBe(10000);
    expect(r.estorno.estornadoTotalCents).toBe(10000);
    expect(chamadas.estornos).toBe(1);
  });

  it('o mesmo operacaoId NÃO cobra o gateway de novo (duplo clique)', async () => {
    const { service, chamadas } = montar();
    await service.solicitar({ ...pedido, operacaoId: 'op-1' });
    const segunda = await service.solicitar({ ...pedido, operacaoId: 'op-1' });
    expect(segunda.repetida).toBe(true);
    expect(chamadas.estornos).toBe(1);
  });

  it('recusa quando já existe estorno EM ANDAMENTO na mesma cobrança', async () => {
    const { service, chamadas } = montar({
      estornos: [{ id: 'est0', gatewayChargeId: 'CHAR_1', status: 'processando', valorCents: 5000 }],
    });
    await expect(service.solicitar(pedido)).rejects.toThrow(/em andamento/i);
    expect(chamadas.estornos).toBe(0);
  });

  it('o saldo vem do GATEWAY — estorno feito pelo painel do PagBank encolhe o que dá pra devolver', async () => {
    const { service } = montar({
      cobranca: { status: 'PAID', amount: { value: 10000, summary: { paid: 10000, refunded: 7000 } } },
    });
    // Integral passa a valer só o resto (R$ 30), não os R$ 100 originais.
    const r = await service.solicitar(pedido);
    expect(r.estorno.valorCents).toBe(3000);
    expect(r.estorno.jaEstornadoCents).toBe(7000);
  });

  it('parcial acima do saldo é barrado antes de falar com o gateway', async () => {
    const { service, chamadas } = montar({
      cobranca: { status: 'PAID', amount: { value: 10000, summary: { paid: 10000, refunded: 9000 } } },
    });
    await expect(service.solicitar({ ...pedido, tipo: 'parcial', valorCents: 5000 })).rejects.toThrow(/maior que o saldo/i);
    expect(chamadas.estornos).toBe(0);
  });

  it('gateway sem resposta (timeout) fica EM PROCESSAMENTO, nunca "erro"', async () => {
    const { service } = montar({
      resposta: { ok: false, ambigua: true, detalhe: 'timeout', charge: null },
    });
    const r = await service.solicitar(pedido);
    expect(r.estorno.status).toBe('processando');
  });

  it('recusa do gateway NÃO vira processado', async () => {
    const { service } = montar({
      resposta: { ok: false, ambigua: false, httpStatus: 400, detalhe: 'charge not paid' },
    });
    const r = await service.solicitar(pedido);
    expect(r.estorno.status).toBe('recusado');
    expect(r.estorno.mensagemGateway).toMatch(/not paid/);
  });

  it('não confirma o saldo = não estorna (nada sai no escuro)', async () => {
    const { service, chamadas } = montar();
    (service as any).lerCobranca = async () => {
      throw new Error('502 bad gateway');
    };
    await expect(service.solicitar(pedido)).rejects.toThrow(/saldo/i);
    expect(chamadas.estornos).toBe(0);
  });

  it('motivo "outros" sem descrição é recusado', async () => {
    const { service } = montar();
    await expect(service.solicitar({ ...pedido, motivo: 'outros' })).rejects.toThrow(/descrição/i);
  });

  it('pagamento sem chargeId não tem o que estornar', async () => {
    const { service } = montar({ pagamento: { pagbankChargeId: null } });
    await expect(service.solicitar(pedido)).rejects.toThrow(/cobrança no gateway/i);
  });

  it('guarda quem autorizou e por qual nível (auditoria)', async () => {
    const { service } = montar();
    const r = await service.solicitar({ ...pedido, nivel: 'SUPREMA', autorizadoPorNome: 'Fulana', autorizadoPorCpf: '111' });
    expect(r.estorno.nivelAutorizacao).toBe('SUPREMA');
    expect(r.estorno.autorizadoPorNome).toBe('Fulana');
    expect(r.estorno.usuarioNome).toBe('Thiago');
    expect(r.estorno.ip).toBe('1.2.3.4');
  });
});

describe('EstornosService.consultar', () => {
  it('fecha o pendente quando o gateway confirma o valor devolvido', async () => {
    const { service } = montar({
      estornos: [
        {
          id: 'est1',
          gateway: 'pagbank',
          gatewayChargeId: 'CHAR_1',
          storeCode: 'SITE',
          status: 'processando',
          valorCents: 10000,
          jaEstornadoCents: 0,
        },
      ],
      cobranca: { status: 'CANCELED', amount: { summary: { paid: 10000, refunded: 10000 } } },
    });
    const r = await service.consultar('est1');
    expect(r.status).toBe('processado');
  });

  it('NÃO transforma pendente em recusado — a cobrança não guarda "o estorno falhou"', async () => {
    const { service } = montar({
      estornos: [
        {
          id: 'est1',
          gateway: 'pagbank',
          gatewayChargeId: 'CHAR_1',
          storeCode: 'SITE',
          status: 'processando',
          valorCents: 10000,
          jaEstornadoCents: 0,
        },
      ],
      cobranca: { status: 'DECLINED', amount: { summary: { paid: 10000, refunded: 0 } } },
    });
    const r = await service.consultar('est1');
    expect(r.status).toBe('processando');
  });

  it('estorno já fechado não é reconsultado', async () => {
    const { service, chamadas } = montar({
      estornos: [{ id: 'est1', gateway: 'pagbank', gatewayChargeId: 'CHAR_1', status: 'processado', valorCents: 100 }],
    });
    await service.consultar('est1');
    expect(chamadas.consultas).toBe(0);
  });
});

describe('EstornosService.historico', () => {
  it('o resumo conta o MESMO recorte da lista (sem contar recusado como dinheiro)', async () => {
    const { service } = montar({
      estornos: [
        { id: 'a', status: 'processado', metodo: 'pix', valorCents: 5000, createdAt: AGORA },
        { id: 'b', status: 'processando', metodo: 'credit_card', valorCents: 3000, createdAt: AGORA },
        { id: 'c', status: 'recusado', metodo: 'pix', valorCents: 9900, createdAt: AGORA },
      ],
    });
    const r = await service.historico({});
    expect(r.resumo.quantidade).toBe(3);
    expect(r.resumo.totalCents).toBe(8000);
    expect(r.resumo.pixCents).toBe(5000);
    expect(r.resumo.cartaoCents).toBe(3000);
    expect(r.resumo.pendentes).toBe(1);
    expect(r.resumo.erros).toBe(1);
  });
});
