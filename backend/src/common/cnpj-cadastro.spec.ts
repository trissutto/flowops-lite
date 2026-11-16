import {
  cnpjValido,
  enderecoDoDestinatario,
  formatarCnpj,
  lerBrasilApi,
  lerCnpjWs,
  lerCnpja,
} from './cnpj-cadastro';

/**
 * O caso que criou a régua: NFC-e 425 de Santos (16/11/2026), destinatário
 * CNPJ 66.503.871/0001-36 — rejeição 181 no dia em que a SEFAZ passou a
 * conferir o destinatário na base da Receita pela chave UF + CNPJ.
 *
 * As três respostas abaixo são o que cada fonte devolveu DE VERDADE pra esse
 * CNPJ naquele dia (encurtadas) — se uma fonte mudar o formato, é aqui que
 * aparece.
 */
describe('cadastro do CNPJ do destinatário', () => {
  const brasilApi = {
    uf: 'SP', cep: '11045400', cnpj: '66503871000136', bairro: 'EMBARE', numero: '22',
    municipio: 'SANTOS', logradouro: 'BARTOLOMEU DE GUSMAO', complemento: '',
    razao_social: 'CONDOMINIO EDIFICIO EXCELSIOR', nome_fantasia: '',
    situacao_cadastral: 2, descricao_situacao_cadastral: 'ATIVA',
    codigo_municipio: 7071, codigo_municipio_ibge: 3548500,
    descricao_tipo_de_logradouro: 'AVENIDA',
  };
  const cnpjWs = {
    cnpj_raiz: '66503871', razao_social: 'CONDOMINIO EDIFICIO EXCELSIOR',
    estabelecimento: {
      cnpj: '66503871000136', nome_fantasia: null, situacao_cadastral: 'Ativa',
      tipo_logradouro: 'AVENIDA', logradouro: 'BARTOLOMEU DE GUSMAO', numero: '22',
      complemento: null, bairro: 'EMBARE', cep: '11045400',
      estado: { sigla: 'SP', ibge_id: 35 }, cidade: { nome: 'Santos', ibge_id: 3548500 },
      inscricoes_estaduais: [],
    },
  };
  const cnpja = {
    taxId: '66503871000136', alias: null,
    company: { name: 'CONDOMINIO EDIFICIO EXCELSIOR' },
    status: { id: 2, text: 'Ativa' },
    address: {
      municipality: 3548500, street: 'Avenida Bartolomeu de Gusmao', number: '22',
      district: 'Embare', city: 'Santos', state: 'SP', details: null, zip: '11045400',
    },
  };

  it('confere os dígitos verificadores', () => {
    expect(cnpjValido('66503871000136')).toBe(true);
    expect(cnpjValido('66.503.871/0001-36')).toBe(true);
    expect(cnpjValido('20104813000643')).toBe(true); // a loja de Santos
    expect(cnpjValido('66503871000137')).toBe(false); // último dígito trocado
    expect(cnpjValido('66503817000136')).toBe(false); // dois dígitos invertidos
    expect(cnpjValido('11111111111111')).toBe(false);
    expect(cnpjValido('31403708819')).toBe(false); // CPF
    expect(cnpjValido('')).toBe(false);
    expect(cnpjValido(null)).toBe(false);
  });

  it('formata pra leitura', () => {
    expect(formatarCnpj('66503871000136')).toBe('66.503.871/0001-36');
    expect(formatarCnpj('123')).toBe('123');
  });

  it.each([
    ['brasilapi', lerBrasilApi, brasilApi],
    ['cnpjws', lerCnpjWs, cnpjWs],
    ['cnpja', lerCnpja, cnpja],
  ] as const)('lê a resposta real da fonte %s', (fonte, ler, resposta) => {
    const c = ler(resposta)!;
    expect(c).toMatchObject({
      cnpj: '66503871000136',
      razaoSocial: 'CONDOMINIO EDIFICIO EXCELSIOR',
      situacao: 'ATIVA',
      ativa: true,
      numero: '22',
      codMunicipio: '3548500',
      uf: 'SP',
      cep: '11045400',
      fonte,
    });
    expect(c.logradouro.toUpperCase()).toBe('AVENIDA BARTOLOMEU DE GUSMAO');
    expect(c.municipio.toUpperCase()).toBe('SANTOS');
    expect(c.bairro.toUpperCase()).toBe('EMBARE');
    expect(c.fantasia).toBeNull();
  });

  it('as três fontes dão o MESMO endereço de nota (UF e código IBGE incluídos)', () => {
    for (const c of [lerBrasilApi(brasilApi), lerCnpjWs(cnpjWs), lerCnpja(cnpja)]) {
      const e = enderecoDoDestinatario(c)!;
      expect(e).toMatchObject({ nro: '22', cMun: '3548500', UF: 'SP', CEP: '11045400' });
      expect(e.xLgr.toUpperCase()).toBe('AVENIDA BARTOLOMEU DE GUSMAO');
      expect(e.xMun.toUpperCase()).toBe('SANTOS');
    }
  });

  it('situação que não é ATIVA fica marcada (rejeição 182)', () => {
    const baixada = lerBrasilApi({ ...brasilApi, situacao_cadastral: 8, descricao_situacao_cadastral: 'BAIXADA' })!;
    expect(baixada.situacao).toBe('BAIXADA');
    expect(baixada.ativa).toBe(false);
    // Fonte que só manda o código da situação
    expect(lerBrasilApi({ ...brasilApi, descricao_situacao_cadastral: '', situacao_cadastral: 4 })!.situacao).toBe('INAPTA');
    expect(lerCnpjWs({ ...cnpjWs, estabelecimento: { ...cnpjWs.estabelecimento, situacao_cadastral: 'Inapta' } })!.ativa).toBe(false);
  });

  it('não repete o tipo do logradouro quando a rua já vem com ele', () => {
    const c = lerBrasilApi({ ...brasilApi, logradouro: 'AVENIDA BARTOLOMEU DE GUSMAO' })!;
    expect(c.logradouro).toBe('AVENIDA BARTOLOMEU DE GUSMAO');
  });

  it('resposta que não é um cadastro vira null — nunca um cadastro pela metade', () => {
    expect(lerBrasilApi(null)).toBeNull();
    expect(lerBrasilApi({ message: 'CNPJ não encontrado' })).toBeNull();
    expect(lerBrasilApi({ ...brasilApi, razao_social: '' })).toBeNull();
    expect(lerCnpjWs({ status: 404, titulo: 'Não encontrado' })).toBeNull();
    expect(lerCnpja({ code: 404, message: 'not found' })).toBeNull();
  });

  it('endereço que o schema da nota recusaria não vira enderDest', () => {
    const base = lerBrasilApi(brasilApi)!;
    expect(enderecoDoDestinatario(null)).toBeNull();
    // sem código IBGE
    expect(enderecoDoDestinatario({ ...base, codMunicipio: '' })).toBeNull();
    // município de OUTRA UF (3548500 é de SP)
    expect(enderecoDoDestinatario({ ...base, uf: 'RJ' })).toBeNull();
    // UF que não existe
    expect(enderecoDoDestinatario({ ...base, uf: 'XX' })).toBeNull();
    // sem logradouro
    expect(enderecoDoDestinatario({ ...base, logradouro: '' })).toBeNull();
  });

  it('número e bairro vazios ganham o texto que o schema exige, e CEP torto fica de fora', () => {
    const base = lerBrasilApi(brasilApi)!;
    const e = enderecoDoDestinatario({ ...base, numero: '', bairro: '', cep: '1104' })!;
    expect(e.nro).toBe('S/N');
    expect(e.xBairro).toBe('NAO INFORMADO');
    expect(e.CEP).toBeNull();
  });
});
