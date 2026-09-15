import {
  CAMPANHA_PADRAO,
  chaveDaCampanha,
  chaveDaFamilia,
  compilarTermo,
  criarRegra,
  formaDeComparacao,
  normalizarConfig,
  precoComDesconto,
  totalDoItemComDesconto,
} from './promo-por-termo';

/**
 * A régua da promoção por termo (inverno 30%, 15/09/2026). Ela é chamada pela
 * vitrine, pela trava do carrinho, pela troca de peça e pelo caixa — o que
 * este arquivo tranca é que os quatro recebam a MESMA resposta.
 */
describe('promo-por-termo — quem entra', () => {
  const regra = (termos: string[], excecoes: any[] = [], over: any = {}) =>
    criarRegra({ ...CAMPANHA_PADRAO, termos, ...over }, excecoes);

  const linha = (descricao: string, over: any = {}) => ({
    ref: '700979', codigo: '8001', descricao, descricaoPdv: null, grupo: null, ...over,
  });

  it('as palavras do dono entram de fábrica', () => {
    const r = criarRegra(CAMPANHA_PADRAO);
    expect(r.decidir(linha('CASACO LONGO PLUS SIZE PRETO 52')).entra).toBe(true);
    expect(r.decidir(linha('JAQUETA JEANS PLUS SIZE 48')).entra).toBe(true);
    expect(r.decidir(linha('BLUSA COLEÇÃO INVERNO 50')).entra).toBe(true);
    expect(r.decidir(linha('VESTIDO MIDI ALCINHA 46')).entra).toBe(false);
  });

  it('termo de 2 palavras pede as DUAS, em qualquer ordem e com palavra no meio', () => {
    const r = regra(['CALÇA MOLETOM']);
    expect(r.decidir(linha('CALCA JOGGER EM MOLETOM PLUS 54')).entra).toBe(true);
    expect(r.decidir(linha('MOLETOM CALÇA FLANELADA')).entra).toBe(true);
    // Só uma das palavras: a blusa de moletom NÃO é "calça moletom".
    expect(r.decidir(linha('BLUSA MOLETOM CAPUZ')).entra).toBe(false);
    expect(r.decidir(linha('CALÇA ALFAIATARIA')).entra).toBe(false);
  });

  it('acento, caixa e pontuação não atrapalham', () => {
    const r = regra(['calça moletom', 'TRICÔ']);
    expect(r.decidir(linha('Calça-Moletom básica')).entra).toBe(true);
    expect(r.decidir(linha('CARDIGAN TRICO LISTRADO')).entra).toBe(true);
  });

  it('plural e singular são a mesma palavra — nos dois sentidos', () => {
    expect(regra(['CASACO']).decidir(linha('KIT 2 CASACOS')).entra).toBe(true);
    expect(regra(['CASACOS']).decidir(linha('CASACO PELUCIA')).entra).toBe(true);
    expect(regra(['BLUSÃO']).decidir(linha('BLUSÕES DE LÃ')).entra).toBe(true);
    expect(regra(['SUÉTER']).decidir(linha('SUETERES GOLA ALTA')).entra).toBe(true);
  });

  it('MOLETOM e MOLETON (e o plural MOLETONS) são a mesma coisa no cadastro', () => {
    const r = regra(['MOLETOM']);
    expect(r.decidir(linha('BLUSA MOLETON')).entra).toBe(true);
    expect(r.decidir(linha('CONJUNTO MOLETONS')).entra).toBe(true);
    expect(formaDeComparacao('CARDIGANS')).toBe(formaDeComparacao('CARDIGAN'));
  });

  it('palavra INTEIRA: LUVA não pega LUVARIA, CAPA não pega CAPACETE', () => {
    expect(regra(['LUVA']).decidir(linha('LUVARIA TESTE')).entra).toBe(false);
    expect(regra(['CAPA']).decidir(linha('CAPACETE')).entra).toBe(false);
  });

  it('com * no fim pega o começo da palavra', () => {
    const r = regra(['TRIC*']);
    expect(r.decidir(linha('BLUSA TRICOT')).entra).toBe(true);
    expect(r.decidir(linha('CARDIGAN TRICÔ')).entra).toBe(true);
    expect(r.decidir(linha('BLUSA TRANÇADA')).entra).toBe(false);
  });

  it('* curto demais é ignorado (C* pegaria meio catálogo)', () => {
    expect(compilarTermo('C*')).toBeNull();
    expect(regra(['C*']).decidir(linha('CASACO')).entra).toBe(false);
  });

  it('hífen no termo separa palavra igual separa no texto', () => {
    const r = regra(['CORTA-VENTO']);
    expect(r.decidir(linha('JAQUETA CORTA VENTO')).entra).toBe(true);
    expect(r.decidir(linha('JAQUETA CORTA-VENTO')).entra).toBe(true);
  });

  it('o GRUPO e a descrição do PDV também contam', () => {
    const r = regra(['CALÇA MOLETOM', 'CASACO']);
    expect(r.decidir(linha('JOGGER MOLETOM 50', { grupo: 'CALÇAS' })).entra).toBe(true);
    expect(r.decidir(linha('', { descricaoPdv: 'CASACO PLUS P 52' })).entra).toBe(true);
  });

  it('a REF entra no texto: o sufixo -INV da coleção vira termo se a matriz quiser', () => {
    const r = regra(['INV']);
    expect(r.decidir(linha('VESTIDO LONGO', { ref: '13050-INV' })).entra).toBe(true);
    expect(r.decidir(linha('VESTIDO LONGO', { ref: '13050' })).entra).toBe(false);
  });

  it('o motivo diz qual termo casou, do jeito que a matriz digitou', () => {
    const d = regra(['CALÇA MOLETOM']).decidir(linha('CALCA MOLETOM'));
    expect(d.termo).toBe('CALÇA MOLETOM');
    expect(d.motivo).toContain('CALÇA MOLETOM');
  });

  it('campanha desligada: ninguém entra, nem a incluída na mão', () => {
    const r = regra(['CASACO'], [{ chave: '700979', decisao: 'dentro' }], { ativa: false });
    expect(r.decidir(linha('CASACO')).entra).toBe(false);
    expect(r.decidir(linha('VESTIDO')).entra).toBe(false);
  });
});

describe('promo-por-termo — a exceção na mão é da FAMÍLIA', () => {
  const excecao = (chave: string, decisao: 'fora' | 'dentro') => ({ chave, decisao, usuario: 'Ana', storeCode: '05' });

  it('tirada na mão vence o termo', () => {
    const r = criarRegra({ ...CAMPANHA_PADRAO, termos: ['JAQUETA'] }, [excecao('VMS-223', 'fora')]);
    const d = r.decidir({ ref: 'VMS-223', descricao: 'JAQUETA SARJA' });
    expect(d.entra).toBe(false);
    expect(d.excecao?.usuario).toBe('Ana');
  });

  /**
   * A vendedora tirou a MARINHO (VMS-223 MA). A PRETA do mesmo modelo
   * (VMS-223 P) não pode continuar com desconto no próximo bipe, nem o site
   * mostrar a mesma peça com dois preços.
   */
  it('tirar uma cor tira todas as cores do modelo (REF-BASE)', () => {
    const chave = chaveDaFamilia('VMS-223 MA');
    expect(chave).toBe('VMS-223');
    const r = criarRegra({ ...CAMPANHA_PADRAO, termos: ['JAQUETA'] }, [excecao(chave, 'fora')]);
    expect(r.decidir({ ref: 'VMS-223 P', descricao: 'JAQUETA SARJA PRETA' }).entra).toBe(false);
    expect(r.decidir({ ref: 'VMS-223MA', descricao: 'JAQUETA SARJA MARINHO' }).entra).toBe(false);
    // Outro modelo (dígito diferente) não é afetado.
    expect(r.decidir({ ref: 'VMS-2231', descricao: 'JAQUETA SARJA' }).entra).toBe(true);
  });

  it('incluída na mão entra sem termo nenhum', () => {
    const r = criarRegra({ ...CAMPANHA_PADRAO, termos: ['CASACO'] }, [excecao('555', 'dentro')]);
    const d = r.decidir({ ref: '555', descricao: 'BLUSA MANGA LONGA' });
    expect(d.entra).toBe(true);
    expect(d.motivo).toContain('na mão');
  });

  it('peça sem REF é família pelo código', () => {
    expect(chaveDaFamilia('', '8000123')).toBe('#8000123');
    expect(chaveDaFamilia('MARCADO', '8000123')).toBe('#8000123');
    const r = criarRegra({ ...CAMPANHA_PADRAO, termos: ['MEIA CALÇA'] }, [excecao('#8000123', 'fora')]);
    expect(r.decidir({ ref: null, codigo: '8000123', descricao: 'MEIA CALÇA FIO 80' }).entra).toBe(false);
  });

  it('a assinatura muda quando entra/sai exceção ou muda termo (a vitrine remonta por ela)', () => {
    const a = criarRegra(CAMPANHA_PADRAO).assinatura;
    const b = criarRegra(CAMPANHA_PADRAO, [excecao('1', 'fora')]).assinatura;
    const c = criarRegra({ ...CAMPANHA_PADRAO, termos: ['CASACO'] }).assinatura;
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('promo-por-termo — dinheiro', () => {
  it('30% de R$ 199,90 = R$ 139,93', () => {
    expect(precoComDesconto(199.9, 30)).toBe(139.93);
  });

  /**
   * Com float o site dava R$ 69,97 e o caixa (que desconta e subtrai) R$ 69,96.
   * O item do PDV parte do MESMO preço unitário da vitrine.
   */
  it('site e caixa cobram o mesmo centavo (R$ 99,95)', () => {
    const site = precoComDesconto(99.95, 30);
    const caixa = totalDoItemComDesconto(99.95, 1, 30);
    expect(caixa.total).toBe(site);
    expect(caixa.desconto).toBe(Math.round((99.95 - site) * 100) / 100);
  });

  it('quantidade multiplica o preço já com desconto', () => {
    const r = totalDoItemComDesconto(99.95, 3, 30);
    expect(r.bruto).toBe(299.85);
    expect(r.total).toBe(Math.round(precoComDesconto(99.95, 30) * 3 * 100) / 100);
    expect(Math.round((r.total + r.desconto) * 100) / 100).toBe(r.bruto);
  });

  it('a etiqueta do PDV começa com PROMO (é o prefixo que o caixa reconhece)', () => {
    expect(criarRegra(CAMPANHA_PADRAO).rotulo).toBe('PROMO 30% · inverno');
  });
});

describe('promo-por-termo — configuração', () => {
  it('termo repetido (com ou sem acento/plural) fica uma vez só', () => {
    const c = normalizarConfig({ termos: ['CASACO', 'casacos', 'Calça Moletom', 'CALCA MOLETOM', ''] });
    expect(c.termos).toEqual(['CASACO', 'CALÇA MOLETOM']);
  });

  it('% fora da faixa é travado (30 digitado como 300 não vira desconto de 300%)', () => {
    expect(normalizarConfig({ pct: 300 }).pct).toBe(90);
    expect(normalizarConfig({ pct: 0 }).pct).toBe(1);
    expect(normalizarConfig({ pct: 'abc' as any }).pct).toBe(30);
  });

  it('sem config gravada, vale o padrão do dono (Inverno 30%, ligada)', () => {
    const c = normalizarConfig(null);
    expect(c).toEqual(CAMPANHA_PADRAO);
  });

  it('a chave das exceções é o nome da campanha', () => {
    expect(chaveDaCampanha('Inverno')).toBe('inverno');
    expect(chaveDaCampanha('Inverno 2026')).toBe('inverno-2026');
    expect(chaveDaCampanha('Verão')).toBe('verao');
  });
});
