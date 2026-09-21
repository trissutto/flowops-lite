import { DonoDoPagamento, PagamentoDaVenda } from '../common/dono-do-pagamento';
import {
  classificarPagamentos, MOTIVO_MAX, origemDoPagamento, pagamentoQueCita, TransacaoPaga,
} from './classificar-pagamentos';

const pag = (id: string, method: string, reais: number, cita?: string): PagamentoDaVenda => ({
  id,
  method,
  cents: Math.round(reais * 100),
  details: cita ? JSON.stringify({ pagbankOrderId: cita, txid: 'x' }) : method === 'dinheiro' ? null : '{}',
});

const venda = (reais: number, pagamentos: PagamentoDaVenda[], status = 'finalized'): DonoDoPagamento => ({
  tipo: 'pdv',
  cents: Math.round(reais * 100),
  clienteNome: null,
  status,
  situacao: status === 'cancelled' ? 'cancelado' : status === 'open' ? 'em_aberto' : 'ok',
  pagamentos,
});

const dono = (
  tipo: 'live' | 'crediario' | 'site',
  reais: number,
  status: string,
  situacao: DonoDoPagamento['situacao'] = 'ok',
): DonoDoPagamento => ({ tipo, cents: Math.round(reais * 100), clienteNome: null, status, situacao });

const tx = (id: string, pedidoRef: string | null, reais: number, formaGateway = 'pix'): TransacaoPaga => ({
  id,
  pedidoRef,
  gatewayOrderId: id,
  cents: Math.round(reais * 100),
  formaGateway,
});

describe('classificarPagamentos', () => {
  describe('venda do PDV DIVIDIDA — o alarme falso dos 126 "Divergente"', () => {
    it('PIX parcial casa com o pagamento que cita a order, não com o total da venda', () => {
      const donos = new Map([['v1', venda(300, [pag('p1', 'pix', 100, 'ORDE_AAAAAAAA'), pag('p2', 'dinheiro', 200)])]]);
      const v = classificarPagamentos([tx('ORDE_AAAAAAAA', 'v1', 100)], donos).get('ORDE_AAAAAAAA')!;
      expect(v.status).toBe('CONCILIADO');
      expect(v.valorSistemaCents).toBe(10000);
      expect(v.motivo).toBe('casou com o pagamento pix de R$ 100,00 (venda de R$ 300,00 dividida em 2 pagamentos)');
    });

    it('dois PIX de uma venda dividida NÃO são duplicado (caso real: R$ 1.300 + R$ 1.339,48)', () => {
      const donos = new Map([
        ['v1', venda(2639.48, [pag('p1', 'pix', 1300, 'ORDE_11111111'), pag('p2', 'pix', 1339.48, 'ORDE_22222222')])],
      ]);
      const r = classificarPagamentos([tx('ORDE_11111111', 'v1', 1300), tx('ORDE_22222222', 'v1', 1339.48)], donos);
      expect(r.get('ORDE_11111111')!.status).toBe('CONCILIADO');
      expect(r.get('ORDE_22222222')!.status).toBe('CONCILIADO');
      expect(r.get('ORDE_22222222')!.motivo).toContain('R$ 1.339,48');
    });

    it('meio a meio (R$ 330 + R$ 330): cada order casa com o SEU pagamento', () => {
      const donos = new Map([
        ['v1', venda(660, [pag('p1', 'pix', 330, 'or_aaaaaaaa1'), pag('p2', 'pix', 330, 'or_bbbbbbbb2')])],
      ]);
      const r = classificarPagamentos([tx('or_aaaaaaaa1', 'v1', 330), tx('or_bbbbbbbb2', 'v1', 330)], donos);
      expect([...r.values()].map((v) => v.status)).toEqual(['CONCILIADO', 'CONCILIADO']);
    });

    it('lançamento picado diferente do gateway, mas a SOMA fecha → conciliado (caso real: 36,90 + 250 = 286,90)', () => {
      const donos = new Map([
        [
          'v1',
          venda(286.9, [
            pag('p1', 'pix', 36.9, 'ORDE_33333333'),
            pag('p2', 'pix', 36.9),
            pag('p3', 'venda_online', 213.1, 'or_cccccccc3'),
          ]),
        ],
      ]);
      const r = classificarPagamentos([tx('ORDE_33333333', 'v1', 36.9), tx('or_cccccccc3', 'v1', 250)], donos);
      expect(r.get('ORDE_33333333')!.status).toBe('CONCILIADO');
      const link = r.get('or_cccccccc3')!;
      expect(link.status).toBe('CONCILIADO');
      expect(link.motivo).toContain('somam R$ 286,90');
      expect(link.valorSistemaCents).toBe(25000);
    });

    it('cliente pagou DUAS vezes (dois QR, um só lançado): o que sobra é DUPLICADO', () => {
      const donos = new Map([['v1', venda(330, [pag('p1', 'pix', 330, 'ORDE_55555555')])]]);
      const r = classificarPagamentos([tx('ORDE_44444444', 'v1', 330), tx('ORDE_55555555', 'v1', 330)], donos);
      expect(r.get('ORDE_55555555')!.status).toBe('CONCILIADO');
      const sobra = r.get('ORDE_44444444')!;
      expect(sobra.status).toBe('DUPLICADO');
      expect(sobra.motivo).toContain('gateway R$ 660,00 × venda R$ 330,00');
    });

    it('PIX em dobro NÃO se esconde atrás de dinheiro do mesmo valor', () => {
      // Venda 660 = pix 330 + dinheiro 330, e o gateway recebeu 330 DUAS vezes:
      // a soma do gateway (660) bate com o TOTAL, mas não com o que a venda lançou em PIX (330).
      const donos = new Map([['v1', venda(660, [pag('p1', 'pix', 330, 'ORDE_66666666'), pag('p2', 'dinheiro', 330)])]]);
      const r = classificarPagamentos([tx('ORDE_66666666', 'v1', 330), tx('ORDE_77777777', 'v1', 330)], donos);
      expect(r.get('ORDE_66666666')!.status).toBe('CONCILIADO');
      expect(r.get('ORDE_77777777')!.status).toBe('DUPLICADO');
    });
  });

  describe('venda do PDV com um pagamento só', () => {
    it('sem citação no details (venda antiga): compara com o total', () => {
      const donos = new Map([['v1', venda(199.9, [pag('p1', 'pix', 199.9)])]]);
      const v = classificarPagamentos([tx('ORDE_88888888', 'v1', 199.9)], donos).get('ORDE_88888888')!;
      expect(v).toEqual({ status: 'CONCILIADO', motivo: 'casou com venda do PDV', valorSistemaCents: 19990, origem: 'loja' });
    });

    it('divergência REAL continua divergente (caso real: gateway R$ 1.059,15 × venda R$ 209,70 no crédito)', () => {
      const donos = new Map([['v1', venda(209.7, [pag('p1', 'credito', 209.7)])]]);
      const v = classificarPagamentos([tx('or_dddddddd4', 'v1', 1059.15)], donos).get('or_dddddddd4')!;
      expect(v.status).toBe('DIVERGENTE');
      expect(v.motivo).toBe('gateway R$ 1.059,15 ≠ venda do PDV R$ 209,70');
    });

    it('pagamento citado com valor diferente: o motivo aponta o pagamento (caso real: R$ 237 × pix R$ 227)', () => {
      const donos = new Map([['v1', venda(227, [pag('p1', 'pix', 227, 'or_eeeeeeee5')])]]);
      const v = classificarPagamentos([tx('or_eeeeeeee5', 'v1', 237)], donos).get('or_eeeeeeee5')!;
      expect(v.status).toBe('DIVERGENTE');
      expect(v.motivo).toBe('gateway R$ 237,00 ≠ pagamento pix de R$ 227,00 registrado na venda');
      expect(v.valorSistemaCents).toBe(22700);
    });

    it('1 centavo de arredondamento não é divergência', () => {
      const donos = new Map([['v1', venda(69.9, [pag('p1', 'pix', 69.9)])]]);
      expect(classificarPagamentos([tx('ORDE_99999999', 'v1', 69.89)], donos).get('ORDE_99999999')!.status).toBe('CONCILIADO');
    });
  });

  describe('dono que não está de pé — o silêncio falso', () => {
    it('PIX pago em venda CANCELADA não é conciliado, mesmo com o valor batendo', () => {
      const donos = new Map([['v1', venda(125, [pag('p1', 'pix', 125, 'ORDE_aaaaaaa1')], 'cancelled')]]);
      const v = classificarPagamentos([tx('ORDE_aaaaaaa1', 'v1', 125)], donos).get('ORDE_aaaaaaa1')!;
      expect(v.status).toBe('DIVERGENTE');
      expect(v.motivo).toBe('venda do PDV CANCELADA com pagamento PAGO no gateway — conferir se o dinheiro foi estornado');
      expect(v.valorSistemaCents).toBe(12500);
    });

    it('pedido do site cancelado com pagamento pago', () => {
      const donos = new Map([['o1', dono('site', 1137.41, 'cancelled', 'cancelado')]]);
      const v = classificarPagamentos([tx('ORDE_bbbbbbb2', 'o1', 1137.41)], donos).get('ORDE_bbbbbbb2')!;
      expect(v.status).toBe('DIVERGENTE');
      expect(v.motivo).toContain('pedido do site CANCELADO com pagamento PAGO');
    });

    it('PIX de crediário pago com a baixa ainda pendente', () => {
      const donos = new Map([['b1', dono('crediario', 640, 'pending', 'em_aberto')]]);
      const v = classificarPagamentos([tx('ORDE_ccccccc3', 'b1', 640)], donos).get('ORDE_ccccccc3')!;
      expect(v.status).toBe('DIVERGENTE');
      expect(v.motivo).toBe(
        'pagamento PAGO e baixa de crediário segue "pending" no sistema — o dinheiro entrou e o sistema não fechou',
      );
    });

    it('quem já era divergente/duplicado só ganha o aviso curto no fim (caso real: venda cancelada de R$ 1,95)', () => {
      const donos = new Map([['v1', venda(1.95, [pag('p1', 'pix', 1.95, 'or_fffffff66')], 'cancelled')]]);
      const r = classificarPagamentos([tx('or_ggggggg77', 'v1', 23.9), tx('or_fffffff66', 'v1', 1.95)], donos);
      expect(r.get('or_fffffff66')!.status).toBe('DIVERGENTE');
      const sobra = r.get('or_ggggggg77')!;
      expect(sobra.status).toBe('DUPLICADO');
      expect(sobra.motivo).toMatch(/ · venda do PDV CANCELADA$/);
    });
  });

  describe('live, crediário e pedido do site', () => {
    it('valor batendo com dono de pé = conciliado, e o motivo diz com o quê', () => {
      const donos = new Map([
        ['o1', dono('site', 275.61, 'separating')],
        ['b1', dono('crediario', 790.57, 'paid')],
        ['c1', dono('live', 159.9, 'shipped')],
      ]);
      const r = classificarPagamentos(
        [tx('ORDE_site0001', 'o1', 275.61), tx('ORDE_cred0001', 'b1', 790.57), tx('ORDE_live0001', 'c1', 159.9)],
        donos,
      );
      expect(r.get('ORDE_site0001')).toEqual({
        status: 'CONCILIADO', motivo: 'casou com pedido do site', valorSistemaCents: 27561, origem: 'site',
      });
      expect(r.get('ORDE_cred0001')!.motivo).toBe('casou com baixa de crediário');
      expect(r.get('ORDE_live0001')!.motivo).toBe('casou com carrinho da live');
    });

    it('valor diferente = divergente', () => {
      const donos = new Map([['o1', dono('site', 300, 'shipped')]]);
      const v = classificarPagamentos([tx('ORDE_site0002', 'o1', 280)], donos).get('ORDE_site0002')!;
      expect(v.status).toBe('DIVERGENTE');
      expect(v.motivo).toBe('gateway R$ 280,00 ≠ pedido do site R$ 300,00');
    });

    it('dois pagamentos pagos pro MESMO pedido do site = duplicado nos dois', () => {
      const donos = new Map([['o1', dono('site', 300, 'shipped')]]);
      const r = classificarPagamentos([tx('or_site00003', 'o1', 300), tx('ORDE_site0004', 'o1', 300)], donos);
      expect([...r.values()].map((v) => v.status)).toEqual(['DUPLICADO', 'DUPLICADO']);
      expect(r.get('or_site00003')!.motivo).toBe('2 transações pagas pro mesmo pedido do site — possível pagamento em dobro');
    });
  });

  describe('sem dono', () => {
    it('ref que não está em tabela nenhuma é o órfão de verdade', () => {
      const v = classificarPagamentos([tx('ORDE_orfao001', 'fantasma', 50)], new Map()).get('ORDE_orfao001')!;
      expect(v.status).toBe('NAO_ENCONTRADO');
      expect(v.motivo).toBe('fantasma não é venda, carrinho da live, baixa de crediário nem pedido do site');
    });

    it('sem ref', () => {
      const v = classificarPagamentos([tx('ORDE_orfao002', null, 50)], new Map()).get('ORDE_orfao002')!;
      expect(v).toEqual({
        status: 'NAO_ENCONTRADO', motivo: 'pagamento sem venda vinculada', valorSistemaCents: null, origem: null,
      });
    });
  });

  it(`o motivo nunca passa de ${MOTIVO_MAX} caracteres (a coluna é VarChar — texto maior derruba o upsert)`, () => {
    const donos = new Map([['v1', venda(123456.78, [pag('p1', 'venda_online', 123456.78, 'or_hhhhhhh88')], 'open')]]);
    const r = classificarPagamentos(
      [tx('or_iiiiiii99', 'v1', 987654.32), tx('or_hhhhhhh88', 'v1', 123456.78), tx('or_jjjjjjj00', 'v1', 555555.55)],
      donos,
    );
    for (const v of r.values()) expect((v.motivo || '').length).toBeLessThanOrEqual(MOTIVO_MAX);
    expect(r.get('or_iiiiiii99')!.status).toBe('DUPLICADO');
  });
});

describe('origemDoPagamento — "venda física na loja, crediário, venda link, estas coisas" (dono, 20/09)', () => {
  const citaPix = pag('p1', 'pix', 100, 'ORDE_AAAAAAAA');
  const citaOnline = pag('p2', 'venda_online', 100, 'ORDE_BBBBBBBB');

  it('PIX no balcão = loja', () => {
    expect(origemDoPagamento(tx('ORDE_AAAAAAAA', 'v1', 100), venda(100, [citaPix]), citaPix)).toBe('loja');
    // venda antiga, sem citação no details: continua balcão
    expect(origemDoPagamento(tx('ORDE_ZZZZZZZZ', 'v1', 100), venda(100, []), null)).toBe('loja');
  });

  it('checkout da Pagar.me = link de pagamento, mesmo que a venda tenha lançado outro método', () => {
    expect(origemDoPagamento(tx('or_link00001', 'v1', 100, 'checkout'), venda(100, [citaOnline]), citaOnline)).toBe('link');
    expect(origemDoPagamento(tx('or_link00002', 'v1', 100, 'checkout'), venda(100, []), null)).toBe('link');
    expect(origemDoPagamento(tx('or_link00003', 'v1', 100, 'CHECKOUT'), venda(100, [citaPix]), citaPix)).toBe('link');
  });

  it('link de pagamento do PDV pelo PagBank (21/09) = link, pago no cartão OU no PIX da página', () => {
    const citaLinkPix: PagamentoDaVenda = {
      id: 'p9',
      method: 'venda_online',
      cents: 10000,
      details: JSON.stringify({ tipo: 'pagbank_link', formaLink: 'pix', pagbankOrderId: 'ORDE_LINKPIX01' }),
    };
    expect(origemDoPagamento(tx('ORDE_LINKPIX01', 'v1', 100), venda(100, [citaLinkPix]), citaLinkPix)).toBe('link');
    expect(origemDoPagamento(tx('ORDE_LINKCARD1', 'v1', 100, 'credit_card'), venda(100, []), null)).toBe('link');
  });

  it('PIX mandado pra cliente à distância (método venda_online) = pix_online', () => {
    expect(origemDoPagamento(tx('ORDE_BBBBBBBB', 'v1', 100), venda(100, [citaOnline]), citaOnline)).toBe('pix_online');
  });

  it('PIX lançado como comum numa venda COM ENTREGA também é online — balcão não tem sedex nem motoboy', () => {
    const comEntrega = { ...venda(100, [citaPix]), vendaComEntrega: true };
    expect(origemDoPagamento(tx('ORDE_AAAAAAAA', 'v1', 100), comEntrega, citaPix)).toBe('pix_online');
  });

  it('crediário, site e live saem do próprio dono', () => {
    expect(origemDoPagamento(tx('ORDE_cred0001', 'b1', 10), dono('crediario', 10, 'paid'), null)).toBe('crediario');
    expect(origemDoPagamento(tx('ORDE_site0001', 'o1', 10, 'credit_card'), dono('site', 10, 'shipped'), null)).toBe('site');
    // live paga por link da Pagar.me continua sendo LIVE, não "link"
    expect(origemDoPagamento(tx('or_live00001', 'c1', 10, 'checkout'), dono('live', 10, 'shipped'), null)).toBe('live');
  });

  it('o veredito carrega a origem — inclusive no divergente e no duplicado', () => {
    const donos = new Map([
      ['v1', venda(330, [pag('p1', 'pix', 330, 'ORDE_55555555')])],
      ['o1', dono('site', 1137.41, 'cancelled', 'cancelado')],
    ]);
    const r = classificarPagamentos(
      [tx('ORDE_44444444', 'v1', 330), tx('ORDE_55555555', 'v1', 330), tx('ORDE_bbbbbbb2', 'o1', 1137.41, 'credit_card')],
      donos,
    );
    expect(r.get('ORDE_44444444')).toMatchObject({ status: 'DUPLICADO', origem: 'loja' });
    expect(r.get('ORDE_55555555')).toMatchObject({ status: 'CONCILIADO', origem: 'loja' });
    expect(r.get('ORDE_bbbbbbb2')).toMatchObject({ status: 'DIVERGENTE', origem: 'site' });
  });
});

describe('pagamentoQueCita', () => {
  const pagamentos = [pag('p1', 'pix', 10, 'ORDE_AAAAAAAA'), pag('p2', 'dinheiro', 20)];

  it('acha pelo id da order dentro do details', () => {
    expect(pagamentoQueCita(pagamentos, 'ORDE_AAAAAAAA')?.id).toBe('p1');
  });

  it('id curto, vazio ou nulo não casa por acaso', () => {
    expect(pagamentoQueCita(pagamentos, 'x')).toBeNull();
    expect(pagamentoQueCita(pagamentos, '')).toBeNull();
    expect(pagamentoQueCita(pagamentos, null)).toBeNull();
  });

  it('venda sem pagamentos / details nulo não quebra', () => {
    expect(pagamentoQueCita(undefined, 'ORDE_AAAAAAAA')).toBeNull();
    expect(pagamentoQueCita([pag('p2', 'dinheiro', 20)], 'ORDE_AAAAAAAA')).toBeNull();
  });
});
