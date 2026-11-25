import {
  CAMPANHA_PADRAO,
  criarRegra,
  dataBr,
  dentroDaVigencia,
  diaISO,
  normalizarConfig,
  rotuloDoCadastro,
  vigenciaTexto,
} from './promo-por-termo';

/**
 * BLACK FRIDAY (dono, 25/11/2026): "50% em todos os itens com data de
 * cadastro de 31/12/2025 pra trás, exceto os BÁSICOS, de quinta a domingo".
 * A campanha ganhou o corte de DATA DE CADASTRO e a VIGÊNCIA; este arquivo
 * tranca que os dois funcionem sem mexer na ordem de quem decide.
 */
const BLACK = {
  ...CAMPANHA_PADRAO,
  nome: 'Black Friday',
  pct: 50,
  termos: [] as string[],
  termosExclusao: [] as string[],
  cadastroAte: '2025-12-31',
  vigencia: { de: '2026-11-26', ate: '2026-11-29' },
};

const linha = (over: any = {}) => ({
  ref: '700979', codigo: '8001', descricao: 'BLUSA VISCOLYCRA PLUS SIZE 48', descricaoPdv: null, grupo: null, ...over,
});

describe('promo-por-termo — corte por data de cadastro', () => {
  const r = criarRegra(BLACK, [], null, null, { hoje: '2026-11-27' });

  it('cadastro até a data entra, com o critério "cadastro"', () => {
    const d = r.decidir(linha({ dataCadastro: '2025-12-31' }));
    expect(d.entra).toBe(true);
    expect(d.criterio).toBe('cadastro');
    expect(d.cadastro).toBe('2025-12-31');
    expect(r.decidir(linha({ dataCadastro: '2019-03-04' })).entra).toBe(true);
  });

  it('cadastro depois da data fica fora, e o motivo diz quando foi cadastrada', () => {
    const d = r.decidir(linha({ dataCadastro: '2026-01-01' }));
    expect(d.entra).toBe(false);
    expect(d.criterio).toBe('nenhum');
    expect(d.motivo).toContain('01/01/2026');
    expect(d.motivo).toContain('31/12/2025');
  });

  it('sem data de cadastro fica fora (não dá pra saber se é antiga)', () => {
    for (const v of [null, undefined, '', 'x']) {
      const d = r.decidir(linha({ dataCadastro: v }));
      expect(d.entra).toBe(false);
      expect(d.motivo).toBe('sem data de cadastro');
    }
  });

  it('a data chega do Prisma como Date em meia-noite UTC e NÃO passa pelo fuso', () => {
    // 31/12/2025 00:00 UTC — lida no fuso de Brasília viraria 30/12 (ainda
    // entra), mas 01/01/2026 00:00 UTC viraria 31/12/2025 e entraria errado.
    expect(r.decidir(linha({ dataCadastro: new Date('2025-12-31T00:00:00Z') })).entra).toBe(true);
    expect(r.decidir(linha({ dataCadastro: new Date('2026-01-01T00:00:00Z') })).entra).toBe(false);
  });

  it('o preço de 50% sai em centavos inteiros', () => {
    expect(r.precoComDesconto(99.9)).toBe(49.95);
    expect(r.precoComDesconto(149.9)).toBe(74.95);
    expect(r.rotulo).toBe('PROMO 50% · black friday');
  });
});

describe('promo-por-termo — a ordem de quem decide continua a mesma com o corte de data', () => {
  const hoje = { hoje: '2026-11-27' };
  const antiga = linha({ dataCadastro: '2024-05-10' });

  it('linha BÁSICA fica fora mesmo sendo antiga', () => {
    const r = criarRegra(BLACK, [], null, new Set(['700979']), hoje);
    const d = r.decidir(antiga);
    expect(d.entra).toBe(false);
    expect(d.criterio).toBe('basico');
  });

  it('família TIRADA na mão fica fora; INCLUÍDA na mão entra mesmo nova', () => {
    const fora = criarRegra(BLACK, [{ chave: '700979', decisao: 'fora' }], null, null, hoje);
    expect(fora.decidir(antiga).criterio).toBe('excecao');
    expect(fora.decidir(antiga).entra).toBe(false);
    const dentro = criarRegra(BLACK, [{ chave: '700979', decisao: 'dentro' }], null, null, hoje);
    const d = dentro.decidir(linha({ dataCadastro: '2026-10-01' }));
    expect(d.entra).toBe(true);
    expect(d.criterio).toBe('excecao');
  });

  it('palavra que exclui vence a data', () => {
    const r = criarRegra({ ...BLACK, termosExclusao: ['22 DE ABRIL'] }, [], null, null, hoje);
    const d = r.decidir(linha({ descricao: 'BLUSAO DE MOLETOM 22 DE ABRIL MESCLA 10', dataCadastro: '2023-01-01' }));
    expect(d.entra).toBe(false);
    expect(d.criterio).toBe('exclusao');
  });

  it('termo continua entrando antes da data — e a data soma com ele, nunca substitui', () => {
    const r = criarRegra({ ...BLACK, termos: ['CASACO'] }, [], null, null, hoje);
    const porTermo = r.decidir(linha({ descricao: 'CASACO LONGO PLUS SIZE 52', dataCadastro: '2026-06-01' }));
    expect(porTermo.entra).toBe(true);
    expect(porTermo.criterio).toBe('termo');
    const porData = r.decidir(linha({ descricao: 'VESTIDO MIDI 50', dataCadastro: '2025-06-01' }));
    expect(porData.entra).toBe(true);
    expect(porData.criterio).toBe('cadastro');
    const nenhum = r.decidir(linha({ descricao: 'VESTIDO MIDI 50', dataCadastro: '2026-06-01' }));
    expect(nenhum.entra).toBe(false);
    expect(nenhum.motivo).toContain('nenhum termo nem grupo');
  });

  it('sem `cadastroAte` a data da linha não pesa nada', () => {
    const r = criarRegra({ ...BLACK, cadastroAte: null }, [], null, null, hoje);
    const d = r.decidir(antiga);
    expect(d.entra).toBe(false);
    expect(d.criterio).toBe('nenhum');
    expect(d.motivo).toBe('nenhum termo nem grupo da campanha');
  });
});

describe('promo-por-termo — vigência', () => {
  const antiga = linha({ dataCadastro: '2024-05-10' });

  it('dentro da janela (inclusive nas pontas) a campanha vale', () => {
    for (const hoje of ['2026-11-26', '2026-11-27', '2026-11-29']) {
      const r = criarRegra(BLACK, [], null, null, { hoje });
      expect(r.ligada).toBe(true);
      expect(r.motivoDesligada).toBeNull();
      expect(r.decidir(antiga).entra).toBe(true);
    }
  });

  it('na véspera e no dia seguinte responde como DESLIGADA, dizendo a janela', () => {
    for (const hoje of ['2026-11-25', '2026-11-30']) {
      const r = criarRegra(BLACK, [], null, null, { hoje });
      expect(r.ligada).toBe(false);
      expect(r.config.ativa).toBe(true);
      expect(r.motivoDesligada).toBe('fora da vigência (de 26/11/2026 a 29/11/2026)');
      const d = r.decidir(antiga);
      expect(d.entra).toBe(false);
      expect(d.criterio).toBe('desligada');
    }
  });

  it('o interruptor "Ligada" continua mandando: desligada não vale nem dentro da janela', () => {
    const r = criarRegra({ ...BLACK, ativa: false }, [], null, null, { hoje: '2026-11-27' });
    expect(r.ligada).toBe(false);
    expect(r.motivoDesligada).toBe('campanha desligada');
  });

  it('a prévia da retaguarda ignora a vigência (confere na véspera o que vai entrar)', () => {
    const r = criarRegra(BLACK, [], null, null, { hoje: '2026-11-25', ignorarVigencia: true });
    expect(r.ligada).toBe(true);
    expect(r.decidir(antiga).entra).toBe(true);
  });

  it('a assinatura muda quando a janela abre — a vitrine remonta', () => {
    const vespera = criarRegra(BLACK, [], null, null, { hoje: '2026-11-25' }).assinatura;
    const quinta = criarRegra(BLACK, [], null, null, { hoje: '2026-11-26' }).assinatura;
    const sexta = criarRegra(BLACK, [], null, null, { hoje: '2026-11-27' }).assinatura;
    expect(vespera).not.toBe(quinta);
    expect(quinta).toBe(sexta);
  });

  it('só um lado da janela também vale', () => {
    expect(dentroDaVigencia({ de: '2026-11-26', ate: null }, '2026-12-25')).toBe(true);
    expect(dentroDaVigencia({ de: '2026-11-26', ate: null }, '2026-11-25')).toBe(false);
    expect(dentroDaVigencia({ de: null, ate: '2026-11-29' }, '2026-11-01')).toBe(true);
    expect(dentroDaVigencia({ de: null, ate: '2026-11-29' }, '2026-11-30')).toBe(false);
    expect(dentroDaVigencia({ de: null, ate: null }, '2030-01-01')).toBe(true);
    expect(dentroDaVigencia(null, '2030-01-01')).toBe(true);
  });

  it('janela invertida nunca vale', () => {
    expect(dentroDaVigencia({ de: '2026-11-29', ate: '2026-11-26' }, '2026-11-27')).toBe(false);
  });

  it('o texto da vigência', () => {
    expect(vigenciaTexto({ de: '2026-11-26', ate: '2026-11-29' })).toBe('de 26/11/2026 a 29/11/2026');
    expect(vigenciaTexto({ de: '2026-11-26', ate: null })).toBe('a partir de 26/11/2026');
    expect(vigenciaTexto({ de: null, ate: '2026-11-29' })).toBe('até 29/11/2026');
    expect(vigenciaTexto({ de: null, ate: null })).toBeNull();
  });
});

describe('promo-por-termo — datas na config', () => {
  it('a config antiga (sem os campos) lê sem corte e sem janela', () => {
    const c = normalizarConfig({ nome: 'Inverno', pct: 30, termos: ['CASACO'] } as any);
    expect(c.cadastroAte).toBeNull();
    expect(c.vigencia).toEqual({ de: null, ate: null });
  });

  it('data inválida vira null (quem grava valida alto antes)', () => {
    const c = normalizarConfig({ ...BLACK, cadastroAte: '2025-13-40', vigencia: { de: 'x', ate: '2026-02-30' } });
    expect(c.cadastroAte).toBeNull();
    expect(c.vigencia).toEqual({ de: null, ate: null });
  });

  it('diaISO aceita Date, ISO completo e YYYY-MM-DD; recusa o resto', () => {
    expect(diaISO('2025-12-31')).toBe('2025-12-31');
    expect(diaISO('2025-12-31T15:00:00.000Z')).toBe('2025-12-31');
    expect(diaISO(new Date('2025-12-31T00:00:00Z'))).toBe('2025-12-31');
    expect(diaISO('31/12/2025')).toBeNull();
    expect(diaISO('2025-02-30')).toBeNull();
    expect(diaISO(null)).toBeNull();
    expect(diaISO('')).toBeNull();
  });

  it('dataBr e o rótulo do cadastro', () => {
    expect(dataBr('2025-12-31')).toBe('31/12/2025');
    expect(dataBr(null)).toBe('');
    expect(rotuloDoCadastro('2025-12-31')).toBe('cadastro até 31/12/2025');
  });
});
