import {
  cpfValido,
  faltandoDadosClienteOnline,
  nomeCompletoOk,
} from './dados-cliente-online';

/** Cadastro que pode virar pedido: nada falta. */
const COMPLETO = {
  customerName: 'Maria Aparecida Silva',
  customerCpf: '52998224725',
  customerPhone: '(15) 99999-1234',
  customerEmail: 'maria@gmail.com',
  customerCep: '18200-000',
  customerEndereco: 'Rua das Flores',
  customerNumero: '120',
  customerBairro: 'Centro',
  customerCidade: 'Itapetininga',
  customerUf: 'sp',
};

describe('cpfValido', () => {
  test('CPF de verdade passa (com ou sem máscara)', () => {
    expect(cpfValido('529.982.247-25')).toBe(true);
    expect(cpfValido('52998224725')).toBe(true);
  });

  test('CPF inventado não passa — os Correios e a NF-e recusam', () => {
    expect(cpfValido('11111111111')).toBe(false);
    expect(cpfValido('52998224726')).toBe(false); // dígito verificador errado
    expect(cpfValido('5299822472')).toBe(false);
    expect(cpfValido('')).toBe(false);
  });
});

describe('nomeCompletoOk', () => {
  test('rótulo genérico não é nome — foi assim que a etiqueta saiu "Cliente"', () => {
    expect(nomeCompletoOk('Cliente')).toBe(false);
    expect(nomeCompletoOk('CONSUMIDOR')).toBe(false);
    expect(nomeCompletoOk('sem nome')).toBe(false);
  });

  test('primeiro nome solto não entrega encomenda', () => {
    expect(nomeCompletoOk('Maria')).toBe(false);
  });

  test('nome e sobrenome passam', () => {
    expect(nomeCompletoOk('Maria Silva')).toBe(true);
    expect(nomeCompletoOk('Ana Sá')).toBe(true);
  });
});

describe('faltandoDadosClienteOnline', () => {
  test('cadastro completo → lista vazia', () => {
    expect(faltandoDadosClienteOnline(COMPLETO)).toEqual([]);
  });

  test('venda nova (nada preenchido) cobra os 10 campos', () => {
    expect(faltandoDadosClienteOnline({})).toEqual([
      'nome completo (nome e sobrenome)',
      'CPF válido',
      'WhatsApp com DDD',
      'e-mail',
      'CEP',
      'rua',
      'número',
      'bairro',
      'cidade',
      'UF',
    ]);
  });

  test('só CPF (o que a régua antiga aceitava) não fecha mais venda online', () => {
    expect(faltandoDadosClienteOnline({ customerCpf: '52998224725' })).toContain('CEP');
    expect(faltandoDadosClienteOnline({ customerCpf: '52998224725' })).toContain('e-mail');
  });

  test('UF torta ("CI" no lugar de SP) é pega', () => {
    expect(faltandoDadosClienteOnline({ ...COMPLETO, customerUf: 'CI' })).toEqual(['UF']);
  });

  test('e-mail sem domínio e telefone sem DDD não passam', () => {
    expect(faltandoDadosClienteOnline({ ...COMPLETO, customerEmail: 'maria@gmail' })).toEqual(['e-mail']);
    expect(faltandoDadosClienteOnline({ ...COMPLETO, customerPhone: '999991234' })).toEqual(['WhatsApp com DDD']);
  });

  test('"S/N" é número válido — casa sem numeração existe', () => {
    expect(faltandoDadosClienteOnline({ ...COMPLETO, customerNumero: 'S/N' })).toEqual([]);
  });

  test('CEP tem que ter 8 dígitos', () => {
    expect(faltandoDadosClienteOnline({ ...COMPLETO, customerCep: '182000000' })).toEqual(['CEP']);
    expect(faltandoDadosClienteOnline({ ...COMPLETO, customerCep: '1820000' })).toEqual(['CEP']);
  });

  test('complemento continua opcional — a maioria dos endereços não tem', () => {
    const semComplemento: any = { ...COMPLETO };
    expect(faltandoDadosClienteOnline(semComplemento)).toEqual([]);
  });
});
