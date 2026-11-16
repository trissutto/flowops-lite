import axios from 'axios';
import { CnpjConsultaService } from './cnpj-consulta.service';

jest.mock('axios');
const get = axios.get as unknown as jest.Mock;

const CNPJ = '66503871000136';
const brasilApi = {
  uf: 'SP', cep: '11045400', cnpj: CNPJ, bairro: 'EMBARE', numero: '22', municipio: 'SANTOS',
  logradouro: 'BARTOLOMEU DE GUSMAO', razao_social: 'CONDOMINIO EDIFICIO EXCELSIOR',
  descricao_situacao_cadastral: 'ATIVA', codigo_municipio_ibge: 3548500,
  descricao_tipo_de_logradouro: 'AVENIDA',
};
const cnpja = {
  taxId: CNPJ, company: { name: 'CONDOMINIO EDIFICIO EXCELSIOR' }, status: { id: 2, text: 'Ativa' },
  address: { municipality: 3548500, street: 'Avenida Bartolomeu de Gusmao', number: '22', district: 'Embare', city: 'Santos', state: 'SP', zip: '11045400' },
};

describe('CnpjConsultaService', () => {
  const antes = process.env.CNPJ_CONSULTA;
  beforeEach(() => {
    get.mockReset();
    delete process.env.CNPJ_CONSULTA;
  });
  afterAll(() => {
    if (antes === undefined) delete process.env.CNPJ_CONSULTA;
    else process.env.CNPJ_CONSULTA = antes;
  });

  it('a primeira fonte que responde com o cadastro ganha — e a resposta fica guardada', async () => {
    get.mockResolvedValueOnce({ status: 200, data: brasilApi });
    const svc = new CnpjConsultaService();
    const r = await svc.consultar('66.503.871/0001-36');
    expect(r).toMatchObject({ status: 'encontrado', cadastro: { cnpj: CNPJ, uf: 'SP', codMunicipio: '3548500', fonte: 'brasilapi' } });
    expect(get.mock.calls[0][0]).toBe(`https://brasilapi.com.br/api/cnpj/v1/${CNPJ}`);

    await svc.consultar(CNPJ);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('fonte fora do ar cai pra próxima', async () => {
    get
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))
      .mockResolvedValueOnce({ status: 429, data: {} })
      .mockResolvedValueOnce({ status: 200, data: cnpja });
    const r = await new CnpjConsultaService().consultar(CNPJ);
    expect(r).toMatchObject({ status: 'encontrado', cadastro: { fonte: 'cnpja', uf: 'SP' } });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('dígito errado nem sai pra rede', async () => {
    expect(await new CnpjConsultaService().consultar('66503871000137')).toEqual({ status: 'invalido' });
    expect(await new CnpjConsultaService().consultar('31403708819')).toEqual({ status: 'invalido' });
    expect(get).not.toHaveBeenCalled();
  });

  it('"não existe" só quando alguma fonte RESPONDEU que não tem', async () => {
    get.mockResolvedValue({ status: 404, data: { message: 'não encontrado' } });
    expect(await new CnpjConsultaService().consultar(CNPJ)).toEqual({ status: 'inexistente' });
  });

  it('ninguém respondeu = indisponível, nunca "não existe" — e não fica guardado', async () => {
    get.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const svc = new CnpjConsultaService();
    const r = await svc.consultar(CNPJ);
    expect(r.status).toBe('indisponivel');

    get.mockReset();
    get.mockResolvedValueOnce({ status: 200, data: brasilApi });
    expect((await svc.consultar(CNPJ)).status).toBe('encontrado');
  });

  it('resposta de OUTRO CNPJ é descartada — endereço errado não entra em nota', async () => {
    get
      .mockResolvedValueOnce({ status: 200, data: { ...brasilApi, cnpj: '20104813000643' } })
      .mockResolvedValueOnce({ status: 404, data: {} })
      .mockResolvedValueOnce({ status: 404, data: {} });
    expect((await new CnpjConsultaService().consultar(CNPJ)).status).toBe('inexistente');
  });

  it('CNPJ_CONSULTA=0 desliga sem tocar a rede', async () => {
    process.env.CNPJ_CONSULTA = '0';
    const r = await new CnpjConsultaService().consultar(CNPJ);
    expect(r.status).toBe('indisponivel');
    expect(get).not.toHaveBeenCalled();
  });
});
