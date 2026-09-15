import { CAMPANHA_PADRAO, compilarTermo, criarRegra, normalizarConfig } from './promo-por-termo';

/**
 * A 2ª RODADA DO DONO (15/09/2026): a lista de palavras, o que TEM que sair
 * (bermuda e o uniforme da Escola 22 de Abril, mesmo sendo moletom) e a ordem
 * de quem decide. Os casos usam descrições REAIS do catálogo daquele dia.
 */
describe('promo-por-termo — a lista do dono e o que tem que sair', () => {
  const r = criarRegra(CAMPANHA_PADRAO);
  const linha = (descricao: string, over: any = {}) => ({
    ref: '700979', codigo: '8001', descricao, descricaoPdv: null, grupo: null, ...over,
  });

  it('CASACO / CASACOS entra', () => {
    expect(r.decidir(linha('CASACO FEMININO LA BATIDA PLUS SIZE PRETO 52')).entra).toBe(true);
    expect(r.decidir(linha('KIT 2 CASACOS')).entra).toBe(true);
  });

  it('JAQUETA / JAQUETAS entra', () => {
    expect(r.decidir(linha('JAQUETA FEMININA COURO PLUS SIZE PRETO 50')).entra).toBe(true);
    expect(r.decidir(linha('JAQUETAS SORTIDAS')).entra).toBe(true);
  });

  it('peça com INVERNO na descrição entra', () => {
    expect(r.decidir(linha('CONJUNTO FEMININO INVERNO MOLETINHO PLUS SIZE PRETO')).entra).toBe(true);
  });

  it('CALÇA DE MOLETOM entra escrita de qualquer jeito', () => {
    for (const d of ['Calça de Moletom', 'CALCA DE MOLETOM', 'calça de moletom', 'CALCA MOLETOM FEMININA PLUS SIZE']) {
      expect(r.decidir(linha(d)).entra).toBe(true);
    }
  });

  it('MOLETOM entra (blusão, jaqueta, calça)', () => {
    expect(r.decidir(linha('BLUSAO MOLETOM FEMININO PLUS SIZE KASUAL PRETO')).entra).toBe(true);
  });

  it('PLUSH entra', () => {
    expect(r.decidir(linha('CALCA FEMININA PLUSH PLUS SIZE CAL1749 BEGE')).entra).toBe(true);
  });

  it('BLUSA comum, sem regra nenhuma, NÃO entra', () => {
    const d = r.decidir(linha('BLUSA VISCOLYCRA MANGA CURTA PLUS SIZE 48'));
    expect(d.entra).toBe(false);
    expect(d.criterio).toBe('nenhum');
  });

  it('BERMUDA sai mesmo sendo de moletom ("tudo o que for BERMUDA tem que sair")', () => {
    for (const d of ['BERMUDA INFANTIL O MOLETOM B0070 BEGE', 'BERMUDA MOLETON MENINO MALWEE PRETO', 'BERMUDAS MOLETOM']) {
      const x = r.decidir(linha(d));
      expect(x.entra).toBe(false);
      expect(x.criterio).toBe('exclusao');
      expect(x.exclusao).toBe('BERMUDA');
    }
  });

  it('uniforme da Escola 22 de Abril sai mesmo sendo moletom — com e sem o "DE"', () => {
    for (const d of [
      'BLUSAO DE MOLETOM ABERTO 22 DE ABRIL MESCLA 10',
      'CALCA DE MOL 22 DE ABRIL MESCLA 02',
      'JAQUETA DE TACTEL 22 DE ABRIL CINZA G',
    ]) {
      const x = r.decidir(linha(d, { descricaoPdv: 'BL MOLET 22 ABR 04' }));
      expect(x.entra).toBe(false);
      expect(x.exclusao).toBe('22 DE ABRIL');
    }
    // A grafia curta do cadastro: "22 ABRIL" (sem o DE).
    expect(r.decidir(linha('BLUSAO MOLETOM 22 ABRIL MESCLA')).entra).toBe(false);
    // O número sozinho não é o uniforme: moletom tamanho 22 continua entrando.
    expect(r.decidir(linha('BLUSAO MOLETOM MESCLA 22')).entra).toBe(true);
  });
});

describe('promo-por-termo — precedência: quem decide', () => {
  const excecao = (chave: string, decisao: 'fora' | 'dentro') => ({ chave, decisao, usuario: 'Matriz' });
  const config = { ...CAMPANHA_PADRAO, termos: ['MOLETOM'], termosExclusao: ['BERMUDA'], subgrupos: [53] };
  const estrutura = { porCodigo: new Map([['9001', 'subgrupo PLUSH (CONJUNTO FEMININO INVERNO)']]) };

  it('1. tirada na mão ganha de termo E de grupo', () => {
    const regra = criarRegra(config, [excecao('MOL-1', 'fora')], estrutura);
    const d = regra.decidir({ ref: 'MOL-1', codigo: '9001', descricao: 'BLUSAO MOLETOM' });
    expect(d).toMatchObject({ entra: false, criterio: 'excecao' });
  });

  it('2. incluída na mão ganha da palavra que exclui', () => {
    const regra = criarRegra(config, [excecao('BER-1', 'dentro')]);
    const d = regra.decidir({ ref: 'BER-1', codigo: '1', descricao: 'BERMUDA MOLETOM' });
    expect(d).toMatchObject({ entra: true, criterio: 'excecao' });
  });

  it('3. palavra que exclui ganha de termo E de grupo', () => {
    const regra = criarRegra(config, [], estrutura);
    expect(regra.decidir({ ref: 'X-1', codigo: '1', descricao: 'BERMUDA MOLETOM' })).toMatchObject({
      entra: false, criterio: 'exclusao', exclusao: 'BERMUDA',
    });
    expect(regra.decidir({ ref: 'X-2', codigo: '9001', descricao: 'BERMUDA PLUSH' })).toMatchObject({
      entra: false, criterio: 'exclusao',
    });
  });

  it('4. termo entra', () => {
    const d = criarRegra(config).decidir({ ref: 'X-3', codigo: '2', descricao: 'CALCA MOLETOM' });
    expect(d).toMatchObject({ entra: true, criterio: 'termo', termo: 'MOLETOM' });
  });

  it('4. grupo/subgrupo entra pelo CÓDIGO, sem palavra nenhuma', () => {
    const d = criarRegra(config, [], estrutura).decidir({ ref: 'CJ-9', codigo: '9001', descricao: 'CONJUNTO BLUSA E CALCA' });
    expect(d).toMatchObject({
      entra: true, criterio: 'estrutura', estrutura: 'subgrupo PLUSH (CONJUNTO FEMININO INVERNO)',
    });
    expect(d.motivo).toContain('subgrupo PLUSH');
  });

  it('5. nada disso: fora', () => {
    expect(criarRegra(config, [], estrutura).decidir({ ref: 'V-1', codigo: '3', descricao: 'VESTIDO' }).criterio)
      .toBe('nenhum');
  });

  it('campanha desligada: ninguém entra — nem por grupo, nem incluída na mão', () => {
    const regra = criarRegra({ ...config, ativa: false }, [excecao('CJ-9', 'dentro')], estrutura);
    expect(regra.decidir({ ref: 'CJ-9', codigo: '9001', descricao: 'CONJUNTO' }))
      .toMatchObject({ entra: false, criterio: 'desligada' });
  });

  it('mapa de estrutura sem grupo/subgrupo escolhido na config não dá desconto a ninguém', () => {
    const regra = criarRegra({ ...config, subgrupos: [] }, [], estrutura);
    expect(regra.decidir({ ref: 'CJ-9', codigo: '9001', descricao: 'CONJUNTO' }).entra).toBe(false);
  });

  it('a assinatura muda quando entra código novo no subgrupo (a vitrine remonta)', () => {
    const a = criarRegra(config, [], estrutura).assinatura;
    const b = criarRegra(config, [], {
      porCodigo: new Map([...estrutura.porCodigo, ['9002', 'subgrupo PLUSH']]),
    }).assinatura;
    expect(a).not.toBe(b);
  });
});

describe('promo-por-termo — conectivos e config nova', () => {
  it('DE/DA/COM… não viram palavra obrigatória; letra solta (tamanho) continua', () => {
    expect(compilarTermo('CALÇA DE MOLETOM')?.palavras.map((p) => p.raiz)).toEqual(['CALCA', 'MOLETOM']);
    expect(compilarTermo('MOLETOM COM PUNHO')?.palavras.map((p) => p.raiz)).toEqual(['MOLETOM', 'PUNHO']);
    expect(compilarTermo('BLUSA P')?.palavras.map((p) => p.raiz)).toEqual(['BLUSA', 'P']);
    expect(compilarTermo('DE')).toBeNull();
  });

  it('"CALÇA DE MOLETOM" e "CALÇA MOLETOM" são o mesmo termo (fica um)', () => {
    expect(normalizarConfig({ termos: ['CALÇA DE MOLETOM', 'calca moletom'] }).termos).toEqual(['CALÇA DE MOLETOM']);
  });

  it('exclusões deduplicam; grupo/subgrupo viram inteiros únicos em ordem', () => {
    const c = normalizarConfig({
      termosExclusao: ['bermuda', 'BERMUDAS', '22 de abril', ''],
      grupos: [13, '97' as any, 13, -1, 'x' as any],
      subgrupos: [53.5, 392, 53],
    });
    expect(c.termosExclusao).toEqual(['BERMUDA', '22 DE ABRIL']);
    expect(c.grupos).toEqual([13, 97]);
    expect(c.subgrupos).toEqual([53, 392]);
  });

  it('nulo/vazio NÃO vira o subgrupo 0 (que existe no ERP, com 4.726 blusas)', () => {
    const c = normalizarConfig({ grupos: [null, '', undefined, false, ' '] as any, subgrupos: [null, '0', 0] as any });
    expect(c.grupos).toEqual([]);
    // O 0 escolhido de propósito (número ou "0") continua valendo.
    expect(c.subgrupos).toEqual([0]);
  });

  it('config gravada antes dos campos novos lê as exclusões de fábrica', () => {
    const c = normalizarConfig({ ativa: true, nome: 'Inverno', pct: 30, termos: ['CASACO'] } as any);
    expect(c.termosExclusao).toEqual(['BERMUDA', '22 DE ABRIL']);
    expect(c.grupos).toEqual([]);
  });
});
