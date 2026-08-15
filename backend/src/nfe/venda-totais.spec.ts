import { NfeTransferService } from './nfe-transfer.service';

/**
 * O caso que criou o teste: LP-000025 (15/08). A cliente pagou R$ 152,30
 * (R$ 149,80 em peças − R$ 7,49 de desconto PIX + R$ 9,99 de frete) e a NF-e 24
 * foi AUTORIZADA em produção com R$ 159,79 — o desconto não existia na nota.
 *
 * Regra do dono: frete no campo de frete, desconto no campo de desconto, e
 * imposto não incide sobre nenhum dos dois.
 */
describe('NF-e de venda — frete e desconto nos campos próprios', () => {
  // O montador só lê os argumentos; as dependências não são tocadas.
  const svc = new NfeTransferService(null as any, null as any, null as any);

  const ender = {
    logradouro: 'AV ANA COSTA', numero: '549', bairro: 'GONZAGA',
    codMunicipio: '3548500', municipio: 'SANTOS', uf: 'SP', cep: '11060003',
  };
  const simples: any = {
    cnpj: '20104813000643', razaoSocial: 'T. O. RISSUTTO LTDA', ie: '633747350114',
    regime: '1', ender,
  };
  const presumido: any = { ...simples, regime: '3' };
  const dest = {
    cpfCnpj: '31403708819', nome: 'Ana Paula', endereco: 'Rua Picuipeba', numero: '44',
    bairro: 'Vila Carolina', cidade: 'Sao Paulo', uf: 'SP', cep: '08040100', codMun: '3550308',
  };
  const duasBlusas = [
    { sku: '11598565', ean: 'SEM GTIN', xProd: 'Blusa', ncm: '62179000', cfop: '5102', qty: 1, vUn: 79.9, vProd: 79.9 },
    { sku: '8000000004208', ean: '8000000004208', xProd: 'Blusa', ncm: '62179000', cfop: '5102', qty: 1, vUn: 69.9, vProd: 69.9 },
  ];

  const montar = (extra: any, origem: any = simples, items = duasBlusas) =>
    (svc as any).buildVendaXml({
      chave: '3'.repeat(44), cUF: '35', cNF: '12345678', serie: '1', numero: 99,
      dhEmi: '2026-08-15T15:01:52-03:00', tpAmb: '1', natOp: 'VENDA', cfop: '5102',
      origem, dest, interestadual: false, items, saleRef: 'teste', ...extra,
    }) as string;

  /** Campo do bloco <total><ICMSTot>, que é o que a SEFAZ valida. */
  const totalDe = (xml: string, campo: string) => {
    const bloco = xml.match(/<ICMSTot>[\s\S]*?<\/ICMSTot>/)![0];
    return Number(bloco.match(new RegExp(`<${campo}>([^<]*)</${campo}>`))![1]);
  };
  /** vDesc de cada <det> (fora do ICMSTot). */
  const descontosDeItem = (xml: string) => {
    const semTotal = xml.replace(/<ICMSTot>[\s\S]*?<\/ICMSTot>/, '');
    return (semTotal.match(/<vDesc>([^<]*)<\/vDesc>/g) || []).map((s) => Number(s.replace(/[^\d.]/g, '')));
  };

  it('LP-000025: o desconto vai pro vDesc e a nota fecha nos R$ 152,30 pagos', () => {
    const xml = montar({ valorTotal: 149.8, vFrete: 9.99, vDesc: 7.49 });
    expect(totalDe(xml, 'vProd')).toBe(149.8);
    expect(totalDe(xml, 'vFrete')).toBe(9.99);
    expect(totalDe(xml, 'vDesc')).toBe(7.49);
    expect(totalDe(xml, 'vNF')).toBe(152.3);
    // O que a cliente paga é o total da nota, não a mercadoria cheia.
    expect(xml).toContain('<vPag>152.30</vPag>');
  });

  it('o desconto é rateado entre os itens, nunca embutido no preço unitário', () => {
    const xml = montar({ valorTotal: 149.8, vFrete: 9.99, vDesc: 7.49 });
    expect(descontosDeItem(xml)).toEqual([4.0, 3.49]);
    // Preço unitário continua o cheio — a SEFAZ exige vProd = qCom × vUnCom.
    expect(xml).toContain('<vUnCom>79.90</vUnCom><vProd>79.90</vProd>');
  });

  it('rateio com centavo quebrado: a soma dos itens bate com o total da nota', () => {
    const tres = [33.33, 33.33, 33.34].map((v, i) => ({
      sku: `S${i}`, ean: 'SEM GTIN', xProd: 'Peca', ncm: '62179000',
      cfop: '5102', qty: 1, vUn: v, vProd: v,
    }));
    const xml = montar({ valorTotal: 100, vFrete: 0, vDesc: 10.01 }, simples, tres);
    const soma = Math.round(descontosDeItem(xml).reduce((s, v) => s + v, 0) * 100) / 100;
    expect(soma).toBe(totalDe(xml, 'vDesc'));
    expect(totalDe(xml, 'vNF')).toBe(89.99);
  });

  it('sem desconto a nota sai exatamente como antes (regressão)', () => {
    const xml = montar({ valorTotal: 149.8, vFrete: 9.99 });
    expect(totalDe(xml, 'vDesc')).toBe(0);
    expect(totalDe(xml, 'vNF')).toBe(159.79);
    expect(descontosDeItem(xml)).toEqual([]);
  });

  it('CRT 3: imposto não incide sobre frete nem sobre desconto', () => {
    const xml = montar({ valorTotal: 149.8, vFrete: 9.99, vDesc: 7.49 }, presumido);
    // Base = só a mercadoria líquida: 149,80 − 7,49. Os 9,99 de frete ficam fora.
    expect(totalDe(xml, 'vBC')).toBe(142.31);
    expect(totalDe(xml, 'vNF')).toBe(152.3);
  });

  it('desconto maior que a mercadoria não gera nota negativa', () => {
    const xml = montar({ valorTotal: 149.8, vFrete: 9.99, vDesc: 999 });
    expect(totalDe(xml, 'vDesc')).toBe(149.8);
    expect(totalDe(xml, 'vNF')).toBe(9.99);
  });
});
