import { NfceService } from './nfce.service';
import { lerBrasilApi } from '../common/cnpj-cadastro';

/**
 * NFC-e 425 de Santos (16/11/2026): R$ 219,80 no crédito pro CONDOMÍNIO
 * EDIFÍCIO EXCELSIOR, rejeitada com 181 "CNPJ do destinatário não cadastrado
 * na Receita Federal". O CNPJ existe e está ativo — o que faltava era a UF do
 * destinatário, metade da chave que a SEFAZ usa pra achá-lo na base da
 * Receita desde aquele dia (NT 2026.007, regra 12E02-10).
 */
describe('NFC-e — destinatário identificado por CNPJ', () => {
  const cadastro = lerBrasilApi({
    uf: 'SP', cep: '11045400', cnpj: '66503871000136', bairro: 'EMBARE', numero: '22',
    municipio: 'SANTOS', logradouro: 'BARTOLOMEU DE GUSMAO', complemento: '',
    razao_social: 'CONDOMINIO EDIFICIO EXCELSIOR', nome_fantasia: '',
    situacao_cadastral: 2, descricao_situacao_cadastral: 'ATIVA',
    codigo_municipio_ibge: 3548500, descricao_tipo_de_logradouro: 'AVENIDA',
  })!;

  const config = {
    ambiente: '1', uf: 'SP', cnpj: '20104813000643', razaoSocial: 'T. O. RISSUTTO LTDA',
    fantasia: 'LURDS PLUS SIZE', ie: '633747350114', regime: '1', serie: '6',
    cscId: '1', cscToken: 'x',
    endereco: {
      logradouro: 'AV ANA COSTA', numero: '549', bairro: 'GONZAGA',
      codMunicipio: '3548500', municipio: 'SANTOS', uf: 'SP', cep: '11060003',
    },
  };
  const venda = (extra: any = {}) => ({
    id: 'b8b23e6a', storeCode: '02', total: 219.8, desconto: 0,
    customerCpf: '66503871000136', customerName: null,
    items: [{ sku: '8000000012345', descricao: 'VESTIDO', ncm: '62044300', qty: 1, precoUnit: 219.8, desconto: 0 }],
    payments: [{ method: 'credito', valor: 219.8 }],
    ...extra,
  });
  const montar = async (sale: any, consulta?: any) => {
    const svc = new NfceService({} as any, consulta);
    const xml: string = await (svc as any).buildXml(sale, config, '3'.repeat(44), 425);
    return (xml.match(/<dest>[\s\S]*?<\/dest>/) || [''])[0];
  };
  const achou = { consultar: jest.fn().mockResolvedValue({ status: 'encontrado', cadastro }) };

  it('sai com a razão social e o endereço da Receita — UF e código IBGE incluídos', async () => {
    const dest = await montar(venda(), achou);
    expect(dest).toBe(
      '<dest><CNPJ>66503871000136</CNPJ><xNome>CONDOMINIO EDIFICIO EXCELSIOR</xNome>' +
        '<enderDest><xLgr>AVENIDA BARTOLOMEU DE GUSMAO</xLgr><nro>22</nro><xBairro>EMBARE</xBairro>' +
        '<cMun>3548500</cMun><xMun>SANTOS</xMun><UF>SP</UF><CEP>11045400</CEP>' +
        '<cPais>1058</cPais><xPais>BRASIL</xPais></enderDest>' +
        '<indIEDest>9</indIEDest></dest>',
    );
    expect(achou.consultar).toHaveBeenCalledWith('66503871000136', { prazoMs: 6000 });
  });

  it('o nome que a loja digitou ganha da razão social', async () => {
    const dest = await montar(venda({ customerName: 'Cond. Excelsior' }), achou);
    expect(dest).toContain('<xNome>Cond. Excelsior</xNome><enderDest>');
  });

  it.each([
    ['fonte fora do ar', { status: 'indisponivel', erro: 'timeout' }],
    ['CNPJ que as fontes não têm', { status: 'inexistente' }],
  ])('%s: o cupom sai como sempre saiu, e quem decide é a SEFAZ', async (_caso, resposta) => {
    const dest = await montar(venda(), { consultar: jest.fn().mockResolvedValue(resposta) });
    expect(dest).toBe('<dest><CNPJ>66503871000136</CNPJ><xNome>CONSUMIDOR</xNome><indIEDest>9</indIEDest></dest>');
  });

  it('consulta que explode não derruba a emissão', async () => {
    const dest = await montar(venda(), { consultar: jest.fn().mockRejectedValue(new Error('boom')) });
    expect(dest).toBe('<dest><CNPJ>66503871000136</CNPJ><xNome>CONSUMIDOR</xNome><indIEDest>9</indIEDest></dest>');
  });

  it('cadastro sem código IBGE não gera endereço pela metade (seria 225 de schema)', async () => {
    const semIbge = { consultar: jest.fn().mockResolvedValue({ status: 'encontrado', cadastro: { ...cadastro, codMunicipio: '' } }) };
    const dest = await montar(venda(), semIbge);
    expect(dest).toBe('<dest><CNPJ>66503871000136</CNPJ><xNome>CONDOMINIO EDIFICIO EXCELSIOR</xNome><indIEDest>9</indIEDest></dest>');
  });

  it('razão social com "&" sai escapada', async () => {
    const eComercial = { consultar: jest.fn().mockResolvedValue({ status: 'encontrado', cadastro: { ...cadastro, razaoSocial: 'SILVA & FILHOS LTDA' } }) };
    expect(await montar(venda(), eComercial)).toContain('<xNome>SILVA &amp; FILHOS LTDA</xNome>');
  });

  it('CPF e venda sem documento não consultam nada (regressão)', async () => {
    const consulta = { consultar: jest.fn() };
    expect(await montar(venda({ customerCpf: '31403708819', customerName: 'Ana' }), consulta)).toBe(
      '<dest><CPF>31403708819</CPF><xNome>Ana</xNome><indIEDest>9</indIEDest></dest>',
    );
    expect(await montar(venda({ customerCpf: null }), consulta)).toBe('');
    expect(consulta.consultar).not.toHaveBeenCalled();
  });

  it('sem o serviço de consulta (specs antigos) o cupom sai como antes', async () => {
    expect(await montar(venda())).toBe(
      '<dest><CNPJ>66503871000136</CNPJ><xNome>CONSUMIDOR</xNome><indIEDest>9</indIEDest></dest>',
    );
  });

  it('venda com CNPJ e sem nome ganha a razão social gravada; nome digitado fica', async () => {
    const update = jest.fn().mockResolvedValue({});
    const svc = new NfceService({ pdvSale: { update } } as any, achou as any);
    const semNome: any = venda();
    await (svc as any).nomearDestinatarioPj(semNome);
    expect(semNome.customerName).toBe('CONDOMINIO EDIFICIO EXCELSIOR');
    expect(update).toHaveBeenCalledWith({ where: { id: 'b8b23e6a' }, data: { customerName: 'CONDOMINIO EDIFICIO EXCELSIOR' } });

    update.mockClear();
    const comNome: any = venda({ customerName: 'Cond. Excelsior' });
    await (svc as any).nomearDestinatarioPj(comNome);
    expect(comNome.customerName).toBe('Cond. Excelsior');
    expect(update).not.toHaveBeenCalled();
  });
});
