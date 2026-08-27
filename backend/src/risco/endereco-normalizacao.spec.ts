import {
  normalizarLogradouro,
  extrairNumero,
  chavesDeEndereco,
} from './endereco-normalizacao';

/**
 * Os três primeiros casos são LITERALMENTE os do documento de especificação
 * (item 1): as três grafias que a mesma cliente usa em pedidos diferentes e
 * que precisam colidir.
 */
describe('normalização de endereço', () => {
  const GRAFIAS = [
    'Rua Professor Manuel Ferreira, 115',
    'R. Professor Manuel Ferreira, nº 115',
    'Rua Prof. Manuel Ferreira 115',
  ];

  it('as três grafias do documento viram a MESMA chave', () => {
    const chaves = GRAFIAS.map((g) => chavesDeEndereco({ logradouro: g, cep: '22451-000' }));
    expect(chaves[0].endereco).toBe('rua professor manuel ferreira-115');
    expect(new Set(chaves.map((c) => c.endereco)).size).toBe(1);
    expect(new Set(chaves.map((c) => c.cepNumero)).size).toBe(1);
  });

  it('expande abreviação de logradouro e de título', () => {
    expect(normalizarLogradouro('Av. Dr. Getúlio Vargas')).toBe('avenida doutor getulio vargas');
    expect(normalizarLogradouro('Praça Sta. Cecília')).toBe('praca santa cecilia');
    expect(normalizarLogradouro('TRAV. ENG. JOÃO SILVA')).toBe('travessa engenheiro joao silva');
  });

  it('marcador de número não entra no texto da chave', () => {
    expect(normalizarLogradouro('Rua X, nº 10')).toBe('rua x 10');
    expect(normalizarLogradouro('Rua X, n. 10')).toBe('rua x 10');
    expect(normalizarLogradouro('Rua X, num 10')).toBe('rua x 10');
  });

  it('número sai do campo próprio quando existe, senão do texto', () => {
    expect(extrairNumero('115', 'Rua Professor Manuel Ferreira')).toBe('115');
    expect(extrairNumero(null, 'Rua Professor Manuel Ferreira, 115')).toBe('115');
    // "Av. Brasil, 1500 A" — o caso que a regex antiga do endereço não pegava.
    expect(extrairNumero(null, 'Av. Brasil, 1500 A')).toBe('1500a');
  });

  it('SEM NÚMERO não gera chave — "s/n" juntaria a rua inteira', () => {
    expect(extrairNumero('s/n', 'Estrada do Mar')).toBe('');
    const c = chavesDeEndereco({ logradouro: 'Estrada do Mar, s/n', cep: '11746-692' });
    expect(c.endereco).toBe('');
    expect(c.cepNumero).toBe('');
  });

  it('CEP incompleto derruba só a chave de CEP, não a de texto', () => {
    const c = chavesDeEndereco({ logradouro: 'Rua das Flores', numero: '42', cep: '1174' });
    expect(c.cepNumero).toBe('');
    expect(c.endereco).toBe('rua das flores-42');
  });

  it('logradouro de UMA palavra não vira chave — juntaria a cidade', () => {
    expect(chavesDeEndereco({ logradouro: 'Centro', numero: '10' }).endereco).toBe('');
  });

  it('mesmo endereço com número diferente NÃO colide (apto ≠ prédio)', () => {
    const a = chavesDeEndereco({ logradouro: 'Rua Alfa', numero: '100', cep: '11746-692' });
    const b = chavesDeEndereco({ logradouro: 'Rua Alfa', numero: '200', cep: '11746-692' });
    expect(a.endereco).not.toBe(b.endereco);
    expect(a.cepNumero).not.toBe(b.cepNumero);
  });

  it('endereço vazio ou nulo não explode e não gera chave', () => {
    expect(chavesDeEndereco(null)).toEqual({ cepNumero: '', endereco: '' });
    expect(chavesDeEndereco({})).toEqual({ cepNumero: '', endereco: '' });
  });
});
