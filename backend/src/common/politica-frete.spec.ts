import {
  consolidacaoObrigatoria,
  dentroDeSaoPaulo,
  ehEntregaMotoboy,
  pacotesAguardandoLiberacao,
} from './politica-frete';

describe('politica-frete', () => {
  afterEach(() => {
    delete process.env.ROUTING_JUNTADA_FORA_ESTADO;
    delete process.env.ROUTING_JUNTADA_MOTOBOY;
    delete process.env.PACOTES_GATE_DENTRO_SP;
  });

  test('CEP de SP começa com 0 ou 1; fora começa com 2+; ilegível é null', () => {
    expect(dentroDeSaoPaulo('01310-000')).toBe(true); // capital
    expect(dentroDeSaoPaulo('11740-000')).toBe(true); // Itanhaém
    expect(dentroDeSaoPaulo('20040-002')).toBe(false); // RJ
    expect(dentroDeSaoPaulo('88000000')).toBe(false); // SC
    expect(dentroDeSaoPaulo('123')).toBeNull();
    expect(dentroDeSaoPaulo(null)).toBeNull();
  });

  test('motoboy: pega pelo checkoutInfo.kind E pelo texto do método', () => {
    expect(ehEntregaMotoboy('MOTOBOY — Santos', null)).toBe(true);
    expect(ehEntregaMotoboy('Moto Boy', null)).toBe(true);
    expect(ehEntregaMotoboy('SEDEX', JSON.stringify({ shipping: { kind: 'motoboy' } }))).toBe(true);
    expect(ehEntregaMotoboy('SEDEX', null)).toBe(false);
  });

  test('fora do estado = consolidação obrigatória; dentro não; retirada nunca', () => {
    expect(consolidacaoObrigatoria({ shippingCep: '20040-002' })).toBe(true);
    expect(consolidacaoObrigatoria({ shippingCep: '01310-000' })).toBe(false);
    expect(consolidacaoObrigatoria({ shippingCep: '20040-002', isPickup: true })).toBe(false);
    // CEP ilegível não força (conservador: melhor 2 pacotes que âncora errada)
    expect(consolidacaoObrigatoria({ shippingCep: '' })).toBe(false);
  });

  test('motoboy = consolidação obrigatória mesmo dentro de SP', () => {
    expect(
      consolidacaoObrigatoria({ shippingCep: '11040-000', shippingMethod: 'MOTOBOY' }),
    ).toBe(true);
  });

  test('kill-switches desligam cada regra separadamente', () => {
    process.env.ROUTING_JUNTADA_FORA_ESTADO = '0';
    expect(consolidacaoObrigatoria({ shippingCep: '20040-002' })).toBe(false);
    process.env.ROUTING_JUNTADA_MOTOBOY = '0';
    expect(
      consolidacaoObrigatoria({ shippingCep: '11040-000', shippingMethod: 'MOTOBOY' }),
    ).toBe(false);
  });

  const prismaFake = (order: any, pacotes: number) => ({
    order: { findUnique: async () => order },
    pickOrder: { count: async () => pacotes },
  });

  test('gate: 2+ pacotes dentro de SP sem carimbo TRAVA; 1 pacote não', async () => {
    const dentro = { isPickup: false, shippingCep: '01310-000', wcOrderNumber: 'X1', pacotesLiberadosEm: null };
    expect((await pacotesAguardandoLiberacao(prismaFake(dentro, 2) as any, 'o1')).travado).toBe(true);
    expect((await pacotesAguardandoLiberacao(prismaFake(dentro, 1) as any, 'o1')).travado).toBe(false);
  });

  test('gate: carimbo da matriz, retirada e fora-de-SP passam direto', async () => {
    const liberado = { isPickup: false, shippingCep: '01310-000', pacotesLiberadosEm: new Date() };
    expect((await pacotesAguardandoLiberacao(prismaFake(liberado, 3) as any, 'o1')).travado).toBe(false);
    const pickup = { isPickup: true, shippingCep: '01310-000', pacotesLiberadosEm: null };
    expect((await pacotesAguardandoLiberacao(prismaFake(pickup, 3) as any, 'o1')).travado).toBe(false);
    const fora = { isPickup: false, shippingCep: '20040-002', pacotesLiberadosEm: null };
    expect((await pacotesAguardandoLiberacao(prismaFake(fora, 3) as any, 'o1')).travado).toBe(false);
  });

  test('gate: kill-switch PACOTES_GATE_DENTRO_SP=0 desliga tudo', async () => {
    process.env.PACOTES_GATE_DENTRO_SP = '0';
    const dentro = { isPickup: false, shippingCep: '01310-000', pacotesLiberadosEm: null };
    expect((await pacotesAguardandoLiberacao(prismaFake(dentro, 5) as any, 'o1')).travado).toBe(false);
  });
});
