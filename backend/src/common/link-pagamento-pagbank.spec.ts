import {
  ORIGEM_LINK_PAGBANK,
  ORIGEM_LIVE_CARTAO,
  ORIGEM_TROCA_LINK,
  ORIGENS_CARTAO_RECONCILIADAS,
  ORIGENS_PAGINA_PAGUE,
  ehOrigemVendaOnline,
  saleIdDaTroca,
  situacaoDoCartao,
  statusDaTrocaComoVenda,
  swapIdDoSaleId,
  estadoDoLinkPagbank,
  gatewayDoLinkPdv,
  horasDoLinkPagbank,
  linkPagbankVenceEm,
  maxParcelasLink,
  maxTentativasCartaoLink,
  referenciaCartaoLink,
} from './link-pagamento-pagbank';

describe('link de pagamento do PDV pelo PagBank — a régua', () => {
  const envOriginal = { ...process.env };
  afterEach(() => {
    process.env = { ...envOriginal };
  });

  it('venda online = "Gerar PIX" OU link; balcão e site não', () => {
    expect(ehOrigemVendaOnline('venda_online')).toBe(true);
    expect(ehOrigemVendaOnline(ORIGEM_LINK_PAGBANK)).toBe(true);
    expect(ehOrigemVendaOnline('site')).toBe(false);
    expect(ehOrigemVendaOnline(null)).toBe(false);
    expect(ehOrigemVendaOnline('')).toBe(false);
  });

  it('a origem do link cabe na coluna (VarChar 32)', () => {
    expect(ORIGEM_LINK_PAGBANK.length).toBeLessThanOrEqual(32);
  });

  it('validade padrão 72h, env muda, teto de 7 dias, lixo volta ao padrão', () => {
    delete process.env.PAGBANK_LINK_HORAS;
    expect(horasDoLinkPagbank()).toBe(72);
    process.env.PAGBANK_LINK_HORAS = '24';
    expect(horasDoLinkPagbank()).toBe(24);
    process.env.PAGBANK_LINK_HORAS = '999';
    expect(horasDoLinkPagbank()).toBe(168);
    process.env.PAGBANK_LINK_HORAS = 'abc';
    expect(horasDoLinkPagbank()).toBe(72);
    process.env.PAGBANK_LINK_HORAS = '0';
    expect(horasDoLinkPagbank()).toBe(72);
  });

  it('vence contando de quando a loja GEROU o link', () => {
    const criado = new Date('2026-09-21T18:00:00Z');
    expect(linkPagbankVenceEm(criado, 72).toISOString()).toBe('2026-09-24T18:00:00.000Z');
  });

  it('teto de cartão: 4 por padrão, configurável, nunca acima de 10', () => {
    delete process.env.PAGBANK_LINK_MAX_CARTAO;
    expect(maxTentativasCartaoLink()).toBe(4);
    process.env.PAGBANK_LINK_MAX_CARTAO = '2';
    expect(maxTentativasCartaoLink()).toBe(2);
    process.env.PAGBANK_LINK_MAX_CARTAO = '50';
    expect(maxTentativasCartaoLink()).toBe(10);
  });

  it('parcelas: 12 por padrão; segue PAGARME_MAX_PARCELAS da rede se a do link não existir', () => {
    delete process.env.PAGBANK_LINK_MAX_PARCELAS;
    delete process.env.PAGARME_MAX_PARCELAS;
    expect(maxParcelasLink()).toBe(12);
    process.env.PAGARME_MAX_PARCELAS = '6';
    expect(maxParcelasLink()).toBe(6);
    process.env.PAGBANK_LINK_MAX_PARCELAS = '10';
    expect(maxParcelasLink()).toBe(10);
    process.env.PAGBANK_LINK_MAX_PARCELAS = '40';
    expect(maxParcelasLink()).toBe(12);
  });

  it('gateway do link: PagBank sem env; "pagarme" (qualquer caixa) volta a Pagar.me', () => {
    delete process.env.PDV_LINK_GATEWAY;
    expect(gatewayDoLinkPdv()).toBe('pagbank');
    process.env.PDV_LINK_GATEWAY = ' Pagarme ';
    expect(gatewayDoLinkPdv()).toBe('pagarme');
    process.env.PDV_LINK_GATEWAY = 'qualquer';
    expect(gatewayDoLinkPdv()).toBe('pagbank');
  });

  it('reference_id de cartão é único por tentativa e cabe em 64', () => {
    const saleId = '7200b58d-aa56-4870-a169-82f4d0421877';
    const r1 = referenciaCartaoLink(saleId, '05', 1);
    const r2 = referenciaCartaoLink(saleId, '05', 2);
    expect(r1).not.toBe(r2);
    expect(r1.length).toBeLessThanOrEqual(64);
    expect(referenciaCartaoLink(saleId, 'SITE-LONGA-DEMAIS-XXXXXXXXXXXX', 12).length).toBeLessThanOrEqual(64);
  });

  describe('estado do link', () => {
    const venceEm = new Date('2026-09-24T18:00:00Z');
    const antes = new Date('2026-09-22T12:00:00Z').getTime();
    const depois = new Date('2026-09-25T12:00:00Z').getTime();

    it('dinheiro na conta ganha de tudo — até de venda fechada e link vencido', () => {
      expect(
        estadoDoLinkPagbank({ statusDasCobrancas: ['cancelled', 'paid'], statusDaVenda: 'finalized', venceEm, agora: depois }),
      ).toBe('pago');
    });

    it('venda que não está mais aberta encerra o link (cobrança em dobro)', () => {
      expect(
        estadoDoLinkPagbank({ statusDasCobrancas: ['pending'], statusDaVenda: 'finalized', venceEm, agora: antes }),
      ).toBe('encerrado');
      expect(
        estadoDoLinkPagbank({ statusDasCobrancas: ['pending'], statusDaVenda: 'cancelled', venceEm, agora: antes }),
      ).toBe('encerrado');
      expect(estadoDoLinkPagbank({ statusDasCobrancas: [], statusDaVenda: null, venceEm, agora: antes })).toBe('encerrado');
    });

    it('cartão recusado NÃO mata o link — a cliente tenta de novo até vencer', () => {
      expect(
        estadoDoLinkPagbank({ statusDasCobrancas: ['expired', 'cancelled'], statusDaVenda: 'open', venceEm, agora: antes }),
      ).toBe('aberto');
    });

    it('passou da validade do link = vencido', () => {
      expect(
        estadoDoLinkPagbank({ statusDasCobrancas: ['pending'], statusDaVenda: 'open', venceEm, agora: depois }),
      ).toBe('vencido');
    });
  });
});

describe('cartão da live e link da troca pelo PagBank (22/09) — a régua', () => {
  it('a página /pague abre o link do PDV E o da troca; nunca o cartão da live', () => {
    expect(ORIGENS_PAGINA_PAGUE).toEqual([ORIGEM_LINK_PAGBANK, ORIGEM_TROCA_LINK]);
    expect(ORIGENS_PAGINA_PAGUE).not.toContain(ORIGEM_LIVE_CARTAO);
  });

  it('o reconciliador pergunta pelos três cartões EM ANÁLISE — o do site tem o dele', () => {
    expect([...ORIGENS_CARTAO_RECONCILIADAS].sort()).toEqual(
      [ORIGEM_LINK_PAGBANK, ORIGEM_TROCA_LINK, ORIGEM_LIVE_CARTAO].sort(),
    );
    expect(ORIGENS_CARTAO_RECONCILIADAS).not.toContain('site');
  });

  it('saleId da troca: ida e volta', () => {
    expect(saleIdDaTroca('abc-123')).toBe('troca:abc-123');
    expect(swapIdDoSaleId('troca:abc-123')).toBe('abc-123');
    expect(swapIdDoSaleId('abc-123')).toBeNull();
    expect(swapIdDoSaleId('troca:')).toBeNull();
    expect(swapIdDoSaleId(null)).toBeNull();
  });

  it('troca vista como venda: só a pendente aceita pagamento', () => {
    expect(statusDaTrocaComoVenda('pending')).toBe('open');
    expect(statusDaTrocaComoVenda('settled')).toBe('finalized');
    expect(statusDaTrocaComoVenda('cancelled')).toBe('cancelled');
    expect(statusDaTrocaComoVenda('canceled')).toBe('cancelled');
    // Estado que ninguém conhece não reabre cobrança.
    expect(statusDaTrocaComoVenda(undefined)).toBe('finalized');
  });

  describe('situacaoDoCartao — pode tentar o cartão agora?', () => {
    it('sem nada cobrado: pode, com o teto inteiro', () => {
      expect(situacaoDoCartao([], 4)).toEqual({ pode: true, usadas: 0, restantes: 4 });
    });

    it('PIX pendente não conta como tentativa de cartão', () => {
      expect(situacaoDoCartao([{ method: 'pix', status: 'pending' }], 4)).toEqual({ pode: true, usadas: 0, restantes: 4 });
    });

    it('qualquer cobrança PAGA (até PIX) fecha a porta — não cobra duas vezes', () => {
      const r = situacaoDoCartao([{ method: 'pix', status: 'paid' }], 4);
      expect(r.pode).toBe(false);
      expect(r.motivo).toBe('pago');
    });

    it('cartão EM ANÁLISE segura a próxima tentativa (senão vira cobrança em dobro)', () => {
      const r = situacaoDoCartao([{ method: 'credit_card', status: 'pending' }], 4);
      expect(r).toEqual({ pode: false, motivo: 'analise', usadas: 1, restantes: 3 });
    });

    it('recusas gastam tentativa até o teto', () => {
      const recusas = Array.from({ length: 3 }, () => ({ method: 'credit_card', status: 'cancelled' }));
      expect(situacaoDoCartao(recusas, 4)).toEqual({ pode: true, usadas: 3, restantes: 1 });
      const r = situacaoDoCartao([...recusas, { method: 'credit_card', status: 'cancelled' }], 4);
      expect(r).toEqual({ pode: false, motivo: 'tentativas', usadas: 4, restantes: 0 });
    });
  });
});
