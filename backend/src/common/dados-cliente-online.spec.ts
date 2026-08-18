import {
  cpfValido,
  faltandoDadosBasicosClienteOnline,
  faltandoDadosClienteOnline,
  nomeCompletoOk,
  pecaViaja,
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

/** Cadastro de quem vai BUSCAR na loja: sem uma linha de endereço. */
const SO_CONTATO = {
  customerName: 'Maria Aparecida Silva',
  customerCpf: '52998224725',
  customerPhone: '(15) 99999-1234',
  customerEmail: 'maria@gmail.com',
  entregaTipo: 'retirada',
};

describe('pecaViaja', () => {
  test('SEDEX, PAC e MOTOBOY levam a peça até um endereço', () => {
    expect(pecaViaja('sedex')).toBe(true);
    expect(pecaViaja('pac')).toBe(true);
    expect(pecaViaja('motoboy')).toBe(true);
  });

  test('retirada em loja não viaja (espaço/caixa alta idem)', () => {
    expect(pecaViaja('retirada')).toBe(false);
    expect(pecaViaja(' RETIRADA ')).toBe(false);
  });

  test('sem escolha ainda → trata como se viajasse (padrão seguro)', () => {
    expect(pecaViaja(null)).toBe(true);
    expect(pecaViaja('')).toBe(true);
  });
});

describe('faltandoDadosBasicosClienteOnline', () => {
  test('nunca fala de endereço — é a régua do botão "V. Online"', () => {
    expect(faltandoDadosBasicosClienteOnline({})).toEqual([
      'nome completo (nome e sobrenome)',
      'CPF válido',
      'WhatsApp com DDD',
      'e-mail',
    ]);
  });

  test('contato de pé passa mesmo sem uma linha de endereço', () => {
    expect(faltandoDadosBasicosClienteOnline(SO_CONTATO)).toEqual([]);
  });
});

describe('faltandoDadosClienteOnline — RETIRADA não pede endereço (dono 18/08)', () => {
  test('retirada fecha só com contato: a cliente busca no balcão', () => {
    expect(faltandoDadosClienteOnline(SO_CONTATO)).toEqual([]);
  });

  test('retirada ainda exige nome, CPF, WhatsApp e e-mail (NF-e e aviso)', () => {
    expect(faltandoDadosClienteOnline({ entregaTipo: 'retirada' })).toEqual([
      'nome completo (nome e sobrenome)',
      'CPF válido',
      'WhatsApp com DDD',
      'e-mail',
    ]);
  });

  test('a peça viajando, o endereço volta a ser cobrado', () => {
    for (const tipo of ['sedex', 'pac', 'motoboy']) {
      expect(faltandoDadosClienteOnline({ ...SO_CONTATO, entregaTipo: tipo })).toEqual([
        'CEP',
        'rua',
        'número',
        'bairro',
        'cidade',
        'UF',
      ]);
    }
  });

  test('endereço torto na retirada não atrapalha — nem é olhado', () => {
    expect(
      faltandoDadosClienteOnline({ ...SO_CONTATO, customerCep: '123', customerUf: 'CI' }),
    ).toEqual([]);
  });

  test('venda antiga (sem entregaTipo gravado) segue cobrando tudo', () => {
    expect(faltandoDadosClienteOnline({ ...SO_CONTATO, entregaTipo: null })).toContain('CEP');
  });
});
