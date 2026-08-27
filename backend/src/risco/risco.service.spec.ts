import { RiscoService } from './risco.service';
import { RiscoPesosService, PESOS_PADRAO } from './risco-pesos.service';

/**
 * O CENÁRIO DO DOCUMENTO, item 22 — o teste que o dono pediu.
 *
 *   #198119  10/08  Nayara Santos   tel (21) 96541-5633  Rua Professor Manuel
 *                                   Ferreira 115  cartão 4016   CHARGEBACK
 *   #198281  17/08  Nayara Santos   MESMO tel, MESMO endereço, cartão 3112,
 *                                   titular Darli Martins Candida  CHARGEBACK
 *   LP-000129 21/08 Maiara Santoa   CPF DIFERENTE, e-mail DIFERENTE, MESMO tel,
 *                                   MESMO endereço, cartão diferente
 *
 * O item 23 diz o que o sistema TEM que conseguir enxergar ao analisar o
 * LP-000129, mesmo com CPF, nome e e-mail diferentes. É exatamente isso que
 * está verificado aqui.
 *
 * O banco é falso de propósito: o que está sob teste é a REGRA (o que cruza,
 * o que pontua, o que não pontua), não o Prisma.
 */

const TEL = '21965415633';
const END = 'rua professor manuel ferreira-115';
const CEP_NUM = '22451000-115';

type Linha = { tipo: string; valor: string; orderId: string };

/** As chaves de cada pedido do cenário. */
const CHAVES: Record<string, Array<{ tipo: string; valor: string }>> = {
  o198119: [
    { tipo: 'telefone', valor: TEL },
    { tipo: 'endereco', valor: END },
    { tipo: 'cep_numero', valor: CEP_NUM },
    { tipo: 'cpf', valor: '11111111111' },
    { tipo: 'email', valor: 'nayara@exemplo.com' },
    { tipo: 'cartao', valor: 'visa-4016' },
  ],
  o198281: [
    { tipo: 'telefone', valor: TEL },
    { tipo: 'endereco', valor: END },
    { tipo: 'cep_numero', valor: CEP_NUM },
    { tipo: 'cpf', valor: '11111111111' },
    { tipo: 'email', valor: 'nayara@exemplo.com' },
    { tipo: 'cartao', valor: 'visa-3112' },
    { tipo: 'titular', valor: 'darli martins candida' },
  ],
  lp129: [
    { tipo: 'telefone', valor: TEL },
    { tipo: 'endereco', valor: END },
    { tipo: 'cep_numero', valor: CEP_NUM },
    { tipo: 'cpf', valor: '22222222222' },
    { tipo: 'email', valor: 'maiara@exemplo.com' },
    { tipo: 'cartao', valor: 'mastercard-5678' },
  ],
};

const ONTEM = (dias: number) => new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

const PEDIDOS: Record<string, any> = {
  o198119: {
    id: 'o198119',
    wcOrderNumber: '#198119',
    customerName: 'Nayara Santos',
    customerCpf: '111.111.111-11',
    customerEmail: 'nayara@exemplo.com',
    totalAmount: 777.29,
    status: 'completed',
    source: 'site',
    paidAt: ONTEM(17),
    createdAt: ONTEM(17),
    wcDateCreated: ONTEM(17),
    chargebacks: [{ id: 'cb1', status: 'perdido', fraude: true, abertoEm: ONTEM(5) }],
  },
  o198281: {
    id: 'o198281',
    wcOrderNumber: '#198281',
    customerName: 'Nayara Santos',
    customerCpf: '111.111.111-11',
    customerEmail: 'nayara@exemplo.com',
    totalAmount: 969.59,
    status: 'completed',
    source: 'site',
    paidAt: ONTEM(10),
    createdAt: ONTEM(10),
    wcDateCreated: ONTEM(10),
    chargebacks: [{ id: 'cb2', status: 'em_analise', fraude: true, abertoEm: ONTEM(2) }],
  },
  lp129: {
    id: 'lp129',
    wcOrderNumber: 'LP-000129',
    customerName: 'Maiara Santoa',
    customerCpf: '222.222.222-22',
    customerEmail: 'maiara@exemplo.com',
    totalAmount: 827.29,
    status: 'cancelled',
    source: 'ecommerce',
    paidAt: ONTEM(6),
    createdAt: ONTEM(6),
    wcDateCreated: ONTEM(6),
    chargebacks: [],
  },
};

function montarPrisma(over: { chaves?: typeof CHAVES; pedidos?: typeof PEDIDOS } = {}) {
  const chaves = over.chaves || CHAVES;
  const pedidos = over.pedidos || PEDIDOS;

  const todas: Linha[] = Object.entries(chaves).flatMap(([orderId, cs]) =>
    cs.map((c) => ({ ...c, orderId })),
  );

  return {
    appConfig: { findUnique: jest.fn().mockResolvedValue(null) },
    order: {
      findUnique: jest.fn(async ({ where }: any) => pedidos[where.id] || null),
      findMany: jest.fn(async ({ where }: any) =>
        (where.id?.in || []).map((id: string) => pedidos[id]).filter(Boolean),
      ),
    },
    orderRiskAnalysis: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    orderRiskKey: {
      findMany: jest.fn(async ({ where }: any) => {
        // Chaves de UM pedido.
        if (typeof where.orderId === 'string') {
          return todas.filter((l) => l.orderId === where.orderId);
        }
        // Chaves de um conjunto de pedidos (multiplicidade).
        if (where.orderId?.in) {
          return todas.filter((l) => where.orderId.in.includes(l.orderId));
        }
        // O cruzamento: quem mais tem estas chaves.
        const alvos: Array<{ tipo: string; valor: string }> = where.OR || [];
        const excluir = where.orderId?.not;
        return todas.filter(
          (l) =>
            alvos.some((a) => a.tipo === l.tipo && a.valor === l.valor) &&
            (!excluir || l.orderId !== excluir),
        );
      }),
    },
  };
}

function montarServico(prisma: any) {
  const pesos = new RiscoPesosService(prisma as any);
  return new RiscoService(prisma as any, {} as any, pesos);
}

describe('motor de risco — cenário do documento (itens 22 e 23)', () => {
  it('LP-000129: acha a relação mesmo com CPF, nome e e-mail DIFERENTES', async () => {
    const prisma = montarPrisma();
    const r = await montarServico(prisma).analisar('lp129');

    const numeros = r.relacionados.map((x) => x.numero).sort();
    expect(numeros).toEqual(['#198119', '#198281']);

    // O item 23 exige: relação pelo telefone e pelo endereço.
    for (const rel of r.relacionados) {
      expect(rel.relacao).toEqual(expect.arrayContaining(['telefone', 'endereço']));
    }
  });

  it('LP-000129: enxerga os DOIS chargebacks relacionados', async () => {
    const prisma = montarPrisma();
    const r = await montarServico(prisma).analisar('lp129');

    expect(r.chargebacksRelacionados).toBe(2);
    expect(r.relacionados.filter((x) => x.situacao === 'chargeback')).toHaveLength(2);
    // O texto da situação vem do status real da contestação, não genérico.
    expect(r.relacionados.map((x) => x.situacaoTexto)).toEqual(
      expect.arrayContaining(['Chargeback perdido', 'Chargeback em análise']),
    );
  });

  it('LP-000129: sai CRÍTICO, e cada ponto tem um motivo escrito', async () => {
    const prisma = montarPrisma();
    const r = await montarServico(prisma).analisar('lp129');

    expect(r.nivel).toBe('critico');
    expect(r.score).toBeGreaterThanOrEqual(PESOS_PADRAO.faixaCritico);

    const chaves = r.motivos.map((m) => m.chave);
    expect(chaves).toContain('combo_telefone_endereco');
    expect(chaves).toContain('combo_cadastro_novo');
    expect(chaves).toContain('multi_cartoes');

    // ITEM 24: nunca um score sem motivo. A soma dos pesos É o score.
    const soma = r.motivos.reduce((s, m) => s + m.peso, 0);
    expect(Math.min(100, soma)).toBe(r.score);
    for (const m of r.motivos.filter((x) => x.peso > 0)) {
      expect(m.texto.length).toBeGreaterThan(10);
      expect(m.pedidos.length).toBeGreaterThan(0);
    }
  });

  it('nenhum texto gerado acusa a cliente de fraude', async () => {
    const prisma = montarPrisma();
    const r = await montarServico(prisma).analisar('lp129');
    const tudo = [r.resumo, ...r.motivos.map((m) => m.texto)].join(' ').toLowerCase();
    expect(tudo).not.toContain('fraude');
    expect(tudo).not.toContain('fraudador');
    expect(tudo).not.toContain('golpe');
  });

  it('#198281 aponta pro #198119 — o pedido anterior já contestado', async () => {
    const prisma = montarPrisma();
    const r = await montarServico(prisma).analisar('o198281');

    expect(r.relacionados.map((x) => x.numero)).toContain('#198119');
    // Mesmo CPF e mesmo e-mail: aqui NÃO é caso de "cadastro novo".
    expect(r.motivos.map((m) => m.chave)).not.toContain('combo_cadastro_novo');
    // Mas o CPF batendo num chargeback pontua.
    expect(r.motivos.map((m) => m.chave)).toContain('cb_cpf');
  });
});

describe('motor de risco — o que NÃO pode virar alarme', () => {
  it('pedido sem chave nenhuma não inventa risco', async () => {
    const prisma = montarPrisma({ chaves: { ...CHAVES, lp129: [] } as any });
    const r = await montarServico(prisma).analisar('lp129');
    expect(r.score).toBe(0);
    expect(r.nivel).toBe('baixo');
    expect(r.relacionados).toHaveLength(0);
  });

  it('vizinho SEM chargeback aparece como contexto, com peso ZERO', async () => {
    const limpos = JSON.parse(JSON.stringify(PEDIDOS));
    limpos.o198119.chargebacks = [];
    limpos.o198281.chargebacks = [];
    for (const k of Object.keys(limpos)) {
      for (const campo of ['paidAt', 'createdAt', 'wcDateCreated']) {
        limpos[k][campo] = new Date(limpos[k][campo]);
      }
    }
    const prisma = montarPrisma({ pedidos: limpos });
    const r = await montarServico(prisma).analisar('lp129');

    expect(r.chargebacksRelacionados).toBe(0);
    // As relações continuam visíveis — é o que inocenta a cliente.
    expect(r.relacionados).toHaveLength(2);
    expect(r.motivos.some((m) => m.chave.startsWith('rel_'))).toBe(true);
    // Sem chargeback, nenhuma regra de chargeback pontua.
    expect(r.motivos.filter((m) => m.chave.startsWith('cb_'))).toHaveLength(0);
    expect(r.motivos.some((m) => m.chave === 'combo_telefone_endereco')).toBe(false);
    expect(r.nivel).not.toBe('critico');
  });

  it('chave difusa (bate em pedido demais) é DESCARTADA e explicada', async () => {
    // 40 pedidos dividindo o mesmo IP — NAT de prédio, 4G de operadora.
    const chaves: any = { lp129: [{ tipo: 'ip', valor: '200.100.50.10' }] };
    const pedidos: any = { lp129: PEDIDOS.lp129 };
    for (let i = 0; i < 40; i += 1) {
      chaves[`v${i}`] = [{ tipo: 'ip', valor: '200.100.50.10' }];
      pedidos[`v${i}`] = { ...PEDIDOS.o198119, id: `v${i}`, wcOrderNumber: `#9${i}` };
    }
    const prisma = montarPrisma({ chaves, pedidos });
    const r = await montarServico(prisma).analisar('lp129');

    expect(r.score).toBe(0);
    expect(r.relacionados).toHaveLength(0);
    expect(r.chavesIgnoradas.join(' ')).toContain('IP');
  });

  it('um chargeback relacionado é ALTO; dois viram CRÍTICO (reincidência)', async () => {
    const um = JSON.parse(JSON.stringify(PEDIDOS));
    um.o198281.chargebacks = [];
    for (const k of Object.keys(um)) {
      for (const campo of ['paidAt', 'createdAt', 'wcDateCreated']) {
        um[k][campo] = new Date(um[k][campo]);
      }
    }
    const comUm = await montarServico(montarPrisma({ pedidos: um })).analisar('lp129');
    const comDois = await montarServico(montarPrisma()).analisar('lp129');

    expect(comUm.nivel).toBe('alto');
    expect(comDois.nivel).toBe('critico');
    expect(comDois.score).toBeGreaterThan(comUm.score);
  });
});
