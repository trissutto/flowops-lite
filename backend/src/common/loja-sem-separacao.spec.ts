import {
  LOJAS_SEM_SEPARACAO_CODES,
  LOJAS_FORA_DA_SEPARACAO,
  ehLojaSemSeparacao,
  naoSepara,
  condSoQuemSepara,
  SQL_SO_QUEM_SEPARA,
} from './loja-sem-separacao';

describe('loja-sem-separacao — a DEPOSITO (20) não separa pedido (dono, 19/10)', () => {
  it('a 20 está na lista por padrão, em todas as grafias do espelho', () => {
    expect(LOJAS_SEM_SEPARACAO_CODES).toContain('20');
    expect(ehLojaSemSeparacao('20')).toBe(true);
    expect(ehLojaSemSeparacao(' 20 ')).toBe(true);
    expect(ehLojaSemSeparacao('LJ20')).toBe(true);
    expect(ehLojaSemSeparacao('020')).toBe(true);
  });

  it('não pega loja de verdade por engano', () => {
    expect(ehLojaSemSeparacao('02')).toBe(false);
    expect(ehLojaSemSeparacao('2')).toBe(false);
    expect(ehLojaSemSeparacao('200')).toBe(false);
    expect(ehLojaSemSeparacao('01')).toBe(false);
    expect(ehLojaSemSeparacao('')).toBe(false);
    expect(ehLojaSemSeparacao(null)).toBe(false);
  });

  it('a loja-canal continua sem separar, e não vira "sem separação" (o saldo dela some da Consulta, o da 20 não)', () => {
    expect(naoSepara('13')).toBe(true);
    expect(naoSepara('20')).toBe(true);
    expect(naoSepara('01')).toBe(false);
    expect(ehLojaSemSeparacao('13')).toBe(false);
  });

  it('a lista do roteamento soma as duas réguas', () => {
    expect(LOJAS_FORA_DA_SEPARACAO).toEqual(expect.arrayContaining(['13', '20']));
  });

  it('o SQL do saldo que o site promete tira as duas', () => {
    expect(condSoQuemSepara('e.loja')).toBe("TRIM(UPPER(e.loja)) NOT IN ('13', '20')");
    expect(SQL_SO_QUEM_SEPARA.trim().startsWith('WHERE')).toBe(true);
  });
});
