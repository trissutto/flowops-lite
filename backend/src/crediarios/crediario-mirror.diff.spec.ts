import { diffEspelhoAbertas, EspelhoAberta } from './crediario-mirror.service';

/**
 * O diff que substituiu o full-replace do espelho de abertas (01/09).
 * O que está em jogo: escrever SÓ a diferença sem nunca divergir do que o
 * replace integral produziria — linha a mais, a menos ou diferente.
 */

const linha = (over: Partial<EspelhoAberta> = {}): EspelhoAberta => ({
  registro: '900000001',
  controle: '123',
  numeroCompra: '456',
  loja: '01',
  codCliente: '789',
  nome: 'MARIA DA SILVA',
  parcela: 1,
  totalParcelas: 5,
  vencimento: new Date('2026-09-10T00:00:00Z'),
  valorParcela: 150,
  obs: null,
  ...over,
});

describe('diffEspelhoAbertas', () => {
  it('listas idênticas → nenhuma mudança', () => {
    const nativas = [linha(), linha({ registro: '900000002', parcela: 2 })];
    const espelho = [linha({ registro: '900000002', parcela: 2 }), linha()];
    const d = diffEspelhoAbertas(nativas, espelho);
    expect(d.inserir).toHaveLength(0);
    expect(d.atualizar).toHaveLength(0);
    expect(d.apagar).toHaveLength(0);
  });

  it('parcela nova na nativa → inserir', () => {
    const nova = linha({ registro: '900000003' });
    const d = diffEspelhoAbertas([linha(), nova], [linha()]);
    expect(d.inserir).toEqual([nova]);
    expect(d.atualizar).toHaveLength(0);
    expect(d.apagar).toHaveLength(0);
  });

  it('parcela que saiu da nativa (paga/cancelada) → apagar', () => {
    const d = diffEspelhoAbertas([linha()], [linha(), linha({ registro: '900000009' })]);
    expect(d.apagar).toEqual(['900000009']);
    expect(d.inserir).toHaveLength(0);
    expect(d.atualizar).toHaveLength(0);
  });

  it('campo mudou (vencimento renegociado) → atualizar', () => {
    const renegociada = linha({ vencimento: new Date('2026-10-10T00:00:00Z') });
    const d = diffEspelhoAbertas([renegociada], [linha()]);
    expect(d.atualizar).toEqual([renegociada]);
  });

  it('Decimal do Prisma vs number: "150.00" e 150 são o MESMO valor', () => {
    // O Prisma devolve Decimal (vira "150" ou "150.00" no valueOf) e a nativa
    // pode carregar number — representação diferente não é mudança.
    const d = diffEspelhoAbertas(
      [linha({ valorParcela: '150.00' })],
      [linha({ valorParcela: 150 })],
    );
    expect(d.atualizar).toHaveLength(0);
  });

  it('valor de fato diferente → atualizar', () => {
    const d = diffEspelhoAbertas(
      [linha({ valorParcela: '151.00' })],
      [linha({ valorParcela: 150 })],
    );
    expect(d.atualizar).toHaveLength(1);
  });

  it('datas iguais em instâncias diferentes não são mudança; null vs data é', () => {
    const igual = diffEspelhoAbertas(
      [linha({ vencimento: new Date('2026-09-10T00:00:00Z') })],
      [linha({ vencimento: new Date('2026-09-10T00:00:00Z') })],
    );
    expect(igual.atualizar).toHaveLength(0);

    const mudou = diffEspelhoAbertas([linha({ vencimento: null })], [linha()]);
    expect(mudou.atualizar).toHaveLength(1);
  });

  it('espelho vazio (primeira carga) → tudo é inserir', () => {
    const nativas = [linha(), linha({ registro: '900000002' })];
    const d = diffEspelhoAbertas(nativas, []);
    expect(d.inserir).toHaveLength(2);
    expect(d.apagar).toHaveLength(0);
  });

  it('obs null vs string vazia normalizada: null === null passa, null vs texto muda', () => {
    expect(diffEspelhoAbertas([linha({ obs: null })], [linha({ obs: null })]).atualizar).toHaveLength(0);
    expect(diffEspelhoAbertas([linha({ obs: 'PROMISSORIA 3' })], [linha({ obs: null })]).atualizar).toHaveLength(1);
  });
});
