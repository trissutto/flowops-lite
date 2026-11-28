import { NfeTransferService } from './nfe-transfer.service';

/** A nota do LOTE (28/11/2026) é transferência SEM imposto mesmo no Lucro
 *  Presumido; a nota avulsa segue destacando (contador 29/07). */
describe('NF-e de transferência — imposto zero no lote', () => {
  const svc = new NfeTransferService({} as any, {} as any, {} as any) as any;
  const ender = {
    logradouro: 'AV X', numero: '1', bairro: 'B', municipio: 'ITANHAEM', cep: '11740000',
    uf: 'SP', codMunicipio: '3522109',
  };
  const fiscal = (storeCode: string, cnpj: string) => ({
    storeCode, cnpj, ie: '063746069', razaoSocial: 'LURDS', fantasia: 'LURDS', uf: 'SP',
    ambiente: '1', regime: '3', certPfxB64: '', certPfxPass: '', ender,
  });
  const base = {
    chave: '3'.repeat(44), cUF: '35', cNF: '12345678', serie: '1', numero: 10,
    dhEmi: '2026-11-28T12:00:00-03:00', tpAmb: '1', natOp: 'TRANSFERENCIA DE MERC ADQ TERCEIROS',
    origem: fiscal('13', '30246592000197'), destino: fiscal('07', '30246592000430'),
    interestadual: false,
    items: [{ sku: '123', ean: 'SEM GTIN', xProd: 'BLUSA MANGA', ncm: '61069000', cfop: '5152', qty: 2, vUn: 50, vProd: 100 }],
    valorTotal: 100, remCode: 'REM-1',
  };

  it('lote: ICMS CST 90 + cBenef, PIS/COFINS zerados, infCpl do lote', () => {
    const xml: string = svc.buildXml({ ...base, impostoZero: true, infCpl: 'Nota emitida em regularizacao' });
    expect(xml).toContain('<ICMS90><orig>0</orig><CST>90</CST></ICMS90>');
    expect(xml).toContain('<cBenef>SP099000</cBenef>');
    expect(xml).toContain('<PISOutr><CST>49</CST><vBC>0.00</vBC>');
    expect(xml).toContain('<COFINSOutr><CST>49</CST><vBC>0.00</vBC>');
    expect(xml).toContain('<vICMS>0.00</vICMS>');
    expect(xml).toContain('<vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS>');
    expect(xml).toContain('<CFOP>5152</CFOP>');
    expect(xml).toContain('<xProd>BLUSA</xProd>');
    expect(xml).toContain('<infCpl>Nota emitida em regularizacao</infCpl>');
    expect(xml).not.toContain('<IBSCBS');
  });

  it('avulsa: continua destacando ICMS 18% e PIS/COFINS no Presumido', () => {
    const xml: string = svc.buildXml(base);
    expect(xml).toContain('<CST>00</CST>');
    expect(xml).toContain('<vICMS>18.00</vICMS>');
    expect(xml).toContain('<PISAliq><CST>01</CST>');
    expect(xml).toContain('<infCpl>Transferencia de mercadoria - Remessa REM-1</infCpl>');
  });
});
