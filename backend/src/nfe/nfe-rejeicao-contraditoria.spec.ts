import { NfeTransferService } from './nfe-transfer.service';
import {
  conferirSomatoriosNfe,
  rejeicaoDeSomatorioContraditoria,
  verAplicDaResposta,
} from '../common/nfe-somatorios';

/**
 * O caso que criou a régua: NF-e 214 de Suzano (13/10/2026) — CRT 1, três
 * itens CSOSN 102, vBC total 0,00 — rejeitada com 531 por um validador antigo
 * da SEFAZ-SP (SP_NFE_PL_008i2), com XML idêntico ao de dezenas de notas
 * autorizadas no mesmo dia pelo SP_NFE_PL009_V4.
 */
describe('NF-e — rejeição de somatório que o XML desmente', () => {
  const svc = new NfeTransferService(null as any, null as any, null as any);
  const ender = {
    logradouro: 'RUA AUGUSTA APARECIDA DE CARVALHO MORAES', numero: '85', bairro: 'JD SANTA HELENA',
    codMunicipio: '3552502', municipio: 'SUZANO', uf: 'SP', cep: '08674220',
  };
  const simples: any = { cnpj: '50213437000181', razaoSocial: 'M. D. D. CERQUEIRA LTDA', ie: '672633361110', regime: '1', ender };
  const presumido: any = { ...simples, regime: '3' };
  const dest = {
    cpfCnpj: '31403708819', nome: 'Cliente', endereco: 'Rua Siria', numero: '45',
    bairro: 'Jardim Oswaldo Cruz', cidade: 'Sao Jose dos Campos', uf: 'SP', cep: '12216530', codMun: '3549904',
  };
  // As três blusas da 214: 109,90 + 79,90 + 149,90 = 339,70.
  const tresBlusas = [109.9, 79.9, 149.9].map((v, i) => ({
    sku: `539534${i}`, ean: 'SEM GTIN', xProd: 'Blusa', ncm: '62179000', cfop: '5102', qty: 1, vUn: v, vProd: v,
  }));
  const montar = (origem: any, extra: any = {}) =>
    (svc as any).buildVendaXml({
      chave: '3'.repeat(44), cUF: '35', cNF: '87150149', serie: '1', numero: 214,
      dhEmi: '2026-10-13T09:52:06-03:00', tpAmb: '1', natOp: 'VENDA', cfop: '5102',
      origem, dest, interestadual: false, items: tresBlusas, valorTotal: 339.7, saleRef: 'envio 72459e50', ...extra,
    }) as string;

  it('a 214 como saiu: somas batem, e o 531 é contraditório', () => {
    const xml = montar(simples);
    expect(conferirSomatoriosNfe(xml)).toEqual({ ok: true, divergencias: [] });
    expect(rejeicaoDeSomatorioContraditoria('531', xml)).toBe(true);
  });

  it('CRT 3 com desconto e frete: as somas continuam batendo', () => {
    const xml = montar(presumido, { vFrete: 32.9, vDesc: 13.33 });
    expect(conferirSomatoriosNfe(xml).ok).toBe(true);
    expect(rejeicaoDeSomatorioContraditoria('532', xml)).toBe(true);
    expect(rejeicaoDeSomatorioContraditoria('610', xml)).toBe(true);
  });

  it('total adulterado: a rejeição é honesta e NÃO vira retentativa', () => {
    const xml = montar(presumido).replace(/<ICMSTot><vBC>[^<]*<\/vBC>/, '<ICMSTot><vBC>400.00</vBC>');
    const r = conferirSomatoriosNfe(xml);
    expect(r.ok).toBe(false);
    expect(r.divergencias).toEqual([expect.stringMatching(/^vBC: itens=339\.70 total=400\.00$/)]);
    expect(rejeicaoDeSomatorioContraditoria('531', xml)).toBe(false);
  });

  it('vNF que não fecha a conta é divergência', () => {
    const xml = montar(simples).replace(/<vNF>[^<]*<\/vNF>/, '<vNF>339.71</vNF>');
    expect(conferirSomatoriosNfe(xml).divergencias).toEqual(['vNF: conta=339.70 total=339.71']);
  });

  it('cStat que não é de soma nunca entra na régua (539 duplicidade, 225 schema, 100 ok)', () => {
    const xml = montar(simples);
    for (const c of ['539', '225', '100', '204', '778', '', undefined, null]) {
      expect(rejeicaoDeSomatorioContraditoria(c, xml)).toBe(false);
    }
  });

  it('XML sem itens ou sem totais não ganha retentativa', () => {
    expect(conferirSomatoriosNfe('<NFe/>').ok).toBe(false);
    expect(rejeicaoDeSomatorioContraditoria('531', '<NFe/>')).toBe(false);
  });

  it('lê os verAplic da resposta real da SEFAZ (lote e protocolo)', () => {
    const resposta =
      '<retEnviNFe versao="4.00"><tpAmb>1</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic><cStat>104</cStat>' +
      '<protNFe versao="4.00"><infProt><verAplic>SP_NFE_PL_008i2</verAplic><cStat>531</cStat></infProt></protNFe></retEnviNFe>';
    expect(verAplicDaResposta(resposta)).toEqual(['SP_NFE_PL009_V4', 'SP_NFE_PL_008i2']);
    expect(verAplicDaResposta(undefined)).toEqual([]);
  });
});
