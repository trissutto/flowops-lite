import {
  contaQueCobrouAVenda,
  contaQueCobrouOPedido,
  corteDaNotaSemEnvio,
  decidirEmitente,
  erroTransitorio,
  notaSegueContaLigada,
  pdvSaleIdDoPedido,
  raizDoCnpj,
  raizTitularPagbank,
} from './emitente-venda-online';

const TO = '20104813'; // T.O. RISSUTTO
const LURDS = '30246592';
const MDD = '50213437';

const ENVS = [
  'NFE_SEGUE_CONTA_DO_LINK',
  'PAGBANK_TITULAR_RAIZ',
  'PAGBANK_TITULAR_RAIZ_POR_LOJA',
  'NFE_NOTA_SEM_ENVIO_DESDE',
];

/** Prisma de faz-de-conta: só o `pagbankPayment.findFirst` que a régua usa. */
function prismaCom(pagos: Array<{ saleId: string; status: string; storeCode: string }>) {
  const chamadas: any[] = [];
  return {
    chamadas,
    pagbankPayment: {
      findFirst: async (args: any) => {
        chamadas.push(args);
        return pagos.find((p) => p.saleId === args.where.saleId && p.status === args.where.status) ?? null;
      },
    },
  };
}

const pedidoOnline = (saleId: string) => ({ source: 'pdv_online', checkoutInfo: JSON.stringify({ pdvSaleId: saleId }) });

describe('emitente-venda-online — a nota segue o CNPJ da conta que cobrou', () => {
  beforeEach(() => ENVS.forEach((e) => delete process.env[e]));
  afterAll(() => ENVS.forEach((e) => delete process.env[e]));

  describe('raizTitularPagbank', () => {
    it('sem env nenhuma, o titular é a T.O. RISSUTTO (o que a produção tem)', () => {
      expect(raizTitularPagbank('11')).toBe(TO);
      expect(raizTitularPagbank(null)).toBe(TO);
    });

    it('PAGBANK_TITULAR_RAIZ troca o titular geral; pontuação é ignorada', () => {
      process.env.PAGBANK_TITULAR_RAIZ = '30.246.592';
      expect(raizTitularPagbank('07')).toBe(LURDS);
    });

    it('loja com conta própria ganha do titular geral', () => {
      process.env.PAGBANK_TITULAR_RAIZ_POR_LOJA = JSON.stringify({ '11': LURDS });
      expect(raizTitularPagbank('11')).toBe(LURDS);
      expect(raizTitularPagbank('02')).toBe(TO);
    });

    it('env torta NÃO vira "sem titular": cai no padrão em vez de devolver a nota pro CNPJ errado', () => {
      process.env.PAGBANK_TITULAR_RAIZ = '123';
      process.env.PAGBANK_TITULAR_RAIZ_POR_LOJA = '{isso não é json';
      expect(raizTitularPagbank('11')).toBe(TO);
      process.env.PAGBANK_TITULAR_RAIZ_POR_LOJA = JSON.stringify({ '11': '999' });
      expect(raizTitularPagbank('11')).toBe(TO);
    });
  });

  describe('pdvSaleIdDoPedido', () => {
    it('só responde pra venda online do PDV', () => {
      expect(pdvSaleIdDoPedido(pedidoOnline('venda-1'))).toBe('venda-1');
      expect(pdvSaleIdDoPedido({ source: 'ecommerce', checkoutInfo: JSON.stringify({ pdvSaleId: 'x' }) })).toBeNull();
      expect(pdvSaleIdDoPedido({ source: 'live', checkoutInfo: null })).toBeNull();
      expect(pdvSaleIdDoPedido(null)).toBeNull();
    });

    it('snapshot cru ou sem a venda → null, sem lançar', () => {
      expect(pdvSaleIdDoPedido({ source: 'pdv_online', checkoutInfo: '{quebrado' })).toBeNull();
      expect(pdvSaleIdDoPedido({ source: 'pdv_online', checkoutInfo: '{}' })).toBeNull();
    });
  });

  describe('contaQueCobrou…', () => {
    it('venda com cobrança PAGA no PagBank → raiz do titular, com a loja da cobrança', async () => {
      const prisma = prismaCom([{ saleId: 'v1', status: 'paid', storeCode: '11' }]);
      await expect(contaQueCobrouAVenda(prisma, 'v1')).resolves.toEqual({ raiz: TO, lojaDaCobranca: '11', saleId: 'v1' });
      await expect(contaQueCobrouOPedido(prisma, pedidoOnline('v1'))).resolves.toEqual({ raiz: TO, lojaDaCobranca: '11', saleId: 'v1' });
    });

    it('link gerado e NÃO pago não conta — ninguém recebeu nada', async () => {
      const prisma = prismaCom([{ saleId: 'v1', status: 'pending', storeCode: '11' }]);
      await expect(contaQueCobrouAVenda(prisma, 'v1')).resolves.toBeNull();
    });

    it('venda paga fora do gateway (franquia na maquininha dela) → null: a nota segue como estava', async () => {
      const prisma = prismaCom([]);
      await expect(contaQueCobrouOPedido(prisma, pedidoOnline('v-franquia'))).resolves.toBeNull();
    });

    it('pedido do site e da live ficam FORA da regra, mesmo pagos no PagBank', async () => {
      const prisma = prismaCom([{ saleId: 'pedido-site', status: 'paid', storeCode: 'SITE' }]);
      await expect(
        contaQueCobrouOPedido(prisma, { source: 'ecommerce', checkoutInfo: JSON.stringify({ pdvSaleId: 'pedido-site' }) }),
      ).resolves.toBeNull();
      expect(prisma.chamadas).toHaveLength(0);
    });

    it('kill-switch desligado → null sem nem consultar o banco', async () => {
      process.env.NFE_SEGUE_CONTA_DO_LINK = '0';
      const prisma = prismaCom([{ saleId: 'v1', status: 'paid', storeCode: '11' }]);
      expect(notaSegueContaLigada()).toBe(false);
      await expect(contaQueCobrouAVenda(prisma, 'v1')).resolves.toBeNull();
      expect(prisma.chamadas).toHaveLength(0);
    });

    it('erro do banco SOBE — "não consegui ler" não pode virar "ninguém cobrou"', async () => {
      const prisma = { pagbankPayment: { findFirst: async () => { throw new Error('conexão caiu'); } } };
      await expect(contaQueCobrouAVenda(prisma, 'v1')).rejects.toThrow('conexão caiu');
    });
  });

  describe('decidirEmitente', () => {
    it('ON-000592 — Limeira (LURDS) despacha venda cobrada no link da T.O.: a nota sai pela T.O.', () => {
      expect(decidirEmitente({ source: 'pdv_online', lojaQueDespacha: '11', raizDaConta: TO })).toEqual({
        storeCode: '11',
        emitirPorRaiz: TO,
        regra: 'conta-que-cobrou',
      });
    });

    it('franquia (MDD) despachando peça de venda cobrada pela rede: nota pela conta, não pela franquia', () => {
      const r = decidirEmitente({ source: 'pdv_online', lojaQueDespacha: '03', raizDaConta: TO, lojaRaiz: MDD });
      expect(r).toEqual({ storeCode: '03', emitirPorRaiz: TO, regra: 'conta-que-cobrou' });
    });

    it('a conta ganha da empresa do site, e a nota parte da loja que DESPACHA (não da loja do site)', () => {
      const r = decidirEmitente({
        source: 'pdv_online', lojaQueDespacha: '06', raizDaConta: TO, siteRaiz: LURDS, siteStore: '13',
      });
      expect(r).toEqual({ storeCode: '06', emitirPorRaiz: TO, regra: 'conta-que-cobrou' });
    });

    it('sem conta de gateway e sem env: a identidade da loja que despacha (o de sempre)', () => {
      expect(decidirEmitente({ source: 'pdv_online', lojaQueDespacha: '17' })).toEqual({
        storeCode: '17',
        regra: 'loja-que-despacha',
      });
    });

    it('envs antigas preservadas: empresa do site pra tudo que não é live', () => {
      expect(decidirEmitente({ source: 'ecommerce', lojaQueDespacha: '05', siteRaiz: LURDS, siteStore: '13' })).toEqual({
        storeCode: '13', emitirPorRaiz: LURDS, regra: 'empresa-do-site',
      });
      // sem a loja do site, parte da própria loja
      expect(decidirEmitente({ source: 'ecommerce', lojaQueDespacha: '05', siteRaiz: LURDS })).toEqual({
        storeCode: '05', emitirPorRaiz: LURDS, regra: 'empresa-do-site',
      });
    });

    it('envs antigas preservadas: live ignora a empresa do site e usa a raiz por loja', () => {
      expect(decidirEmitente({ source: 'live', lojaQueDespacha: '10', siteRaiz: LURDS, siteStore: '13', lojaRaiz: MDD })).toEqual({
        storeCode: '10', emitirPorRaiz: MDD, regra: 'raiz-da-loja',
      });
      expect(decidirEmitente({ source: 'live', lojaQueDespacha: '10', siteRaiz: LURDS })).toEqual({
        storeCode: '10', regra: 'loja-que-despacha',
      });
    });

    it('raiz que não tem 8 dígitos não decide nada', () => {
      expect(decidirEmitente({ source: 'pdv_online', lojaQueDespacha: '11', raizDaConta: '2010' }).regra).toBe('loja-que-despacha');
    });
  });

  describe('apoios', () => {
    it('raizDoCnpj', () => {
      expect(raizDoCnpj('20.104.813/0001-39')).toBe(TO);
      expect(raizDoCnpj('123')).toBe('');
      expect(raizDoCnpj(null)).toBe('');
    });

    it('corte da nota automática: 04/10/2026 00:00 de Brasília; env move; env torta não derruba', () => {
      expect(corteDaNotaSemEnvio().toISOString()).toBe('2026-10-04T03:00:00.000Z');
      process.env.NFE_NOTA_SEM_ENVIO_DESDE = '2026-11-01T03:00:00.000Z';
      expect(corteDaNotaSemEnvio().toISOString()).toBe('2026-11-01T03:00:00.000Z');
      process.env.NFE_NOTA_SEM_ENVIO_DESDE = 'amanhã';
      expect(corteDaNotaSemEnvio().toISOString()).toBe('2026-10-04T03:00:00.000Z');
    });

    it('erro de rede repete; cadastro incompleto e rejeição esperam gente', () => {
      expect(erroTransitorio('connect ETIMEDOUT 200.1.2.3:443')).toBe(true);
      expect(erroTransitorio('socket hang up')).toBe(true);
      expect(erroTransitorio('Request failed with status code 503')).toBe(true);
      expect(erroTransitorio('Dados da cliente incompletos pra NF-e do envio: CPF/CNPJ.')).toBe(false);
      expect(erroTransitorio('Loja 11 sem certificado A1 na config fiscal da NF-e')).toBe(false);
      expect(erroTransitorio(null)).toBe(false);
    });
  });
});
