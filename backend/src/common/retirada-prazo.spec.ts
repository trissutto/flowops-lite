import { coberturaDaLoja, diasUteisRetiradaTransferencia, normalizaCodigo } from './retirada-prazo';

/**
 * LP-001490 (17/09/2026): retirada em São José com a peça em Itanhaém e o
 * site prometendo "pronto em ~3h". A régua do dono: 3h só com a peça NA
 * loja; vindo de outra, pelo menos 4 dias úteis.
 */
describe('coberturaDaLoja', () => {
  const saldo = new Map<string, number>([
    ['5410613', 1],
    ['5410614', 3],
  ]);

  it('toda peça com saldo na loja → loja (prazo em horas)', () => {
    expect(coberturaDaLoja([{ codigo: '5410613', qtd: 1 }], saldo)).toBe('loja');
    expect(coberturaDaLoja([{ codigo: '5410614', qtd: 3 }], saldo)).toBe('loja');
  });

  it('uma peça faltando já vira transferência (o caso LP-001490)', () => {
    expect(coberturaDaLoja([{ codigo: '5410613', qtd: 1 }, { codigo: '999', qtd: 1 }], saldo)).toBe('transferencia');
  });

  it('peça é peça: duas linhas do mesmo código somam contra o saldo', () => {
    expect(coberturaDaLoja([{ codigo: '5410613', qtd: 1 }, { codigo: '5410613', qtd: 1 }], saldo)).toBe('transferencia');
    expect(coberturaDaLoja([{ codigo: '5410614', qtd: 2 }, { codigo: '5410614', qtd: 1 }], saldo)).toBe('loja');
  });

  it('código com zero à esquerda casa com o saldo normalizado', () => {
    expect(coberturaDaLoja([{ codigo: '0005410613', qtd: 1 }], saldo)).toBe('loja');
  });

  it('código não resolvido ou sacola vazia → desconhecida (nunca promete 3h)', () => {
    expect(coberturaDaLoja([{ codigo: null, qtd: 1 }], saldo)).toBe('desconhecida');
    expect(coberturaDaLoja([], saldo)).toBe('desconhecida');
  });

  it('saldo negativo ou ausente conta como zero', () => {
    expect(coberturaDaLoja([{ codigo: '1', qtd: 1 }], new Map([['1', -2]]))).toBe('transferencia');
  });
});

describe('diasUteisRetiradaTransferencia', () => {
  const antes = process.env.RETIRADA_TRANSFER_DIAS_UTEIS;
  afterEach(() => {
    if (antes === undefined) delete process.env.RETIRADA_TRANSFER_DIAS_UTEIS;
    else process.env.RETIRADA_TRANSFER_DIAS_UTEIS = antes;
  });

  it('sem env = 4 dias úteis', () => {
    delete process.env.RETIRADA_TRANSFER_DIAS_UTEIS;
    expect(diasUteisRetiradaTransferencia()).toBe(4);
  });

  it('env válida vale', () => {
    process.env.RETIRADA_TRANSFER_DIAS_UTEIS = '6';
    expect(diasUteisRetiradaTransferencia()).toBe(6);
  });

  it('zero, lixo e negativo caem no padrão — prazo zero não é kill-switch, é promessa errada', () => {
    process.env.RETIRADA_TRANSFER_DIAS_UTEIS = '0';
    expect(diasUteisRetiradaTransferencia()).toBe(4);
    process.env.RETIRADA_TRANSFER_DIAS_UTEIS = 'abc';
    expect(diasUteisRetiradaTransferencia()).toBe(4);
  });
});

describe('normalizaCodigo', () => {
  it('tira zeros à esquerda e espaços', () => {
    expect(normalizaCodigo(' 000123 ')).toBe('123');
    expect(normalizaCodigo(null)).toBe('');
  });
});
