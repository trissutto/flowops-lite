import { CAMPANHA_PADRAO, MOTIVO_SO_CAIXA, criarRegra, normalizarConfig } from './promo-por-termo';

/**
 * ONDE A CAMPANHA VALE (dono, 26/11/2026, primeiro dia da Black Friday):
 * "no site não habilite promoção de Black". O caixa aplica a campanha sempre
 * que ela está ligada; o SITE (vitrine, trava do carrinho, troca de peça) só
 * quando a matriz marca "vale no site". Este arquivo tranca que a vista do
 * site (`paraSite()`) obedeça, sem mexer no que o caixa vê.
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

const antiga = { ref: '700979', codigo: '8001', descricao: 'BLUSA VISCOLYCRA PLUS SIZE 48', descricaoPdv: null, grupo: null, dataCadastro: '2024-05-10' };

describe('promo-por-termo — onde vale (caixa × site)', () => {
  it('nasce SÓ no caixa: config sem o campo, padrão e `false` deixam o site fora', () => {
    expect(CAMPANHA_PADRAO.valeNoSite).toBe(false);
    expect(normalizarConfig({ nome: 'Inverno', pct: 30, termos: ['CASACO'] } as any).valeNoSite).toBe(false);
    expect(normalizarConfig({ ...BLACK, valeNoSite: undefined } as any).valeNoSite).toBe(false);
    expect(normalizarConfig({ ...BLACK, valeNoSite: 'sim' } as any).valeNoSite).toBe(false);
    expect(normalizarConfig({ ...BLACK, valeNoSite: true }).valeNoSite).toBe(true);
  });

  it('Black Friday ligada e na janela: o CAIXA dá 50%, o SITE cobra o preço cheio', () => {
    const caixa = criarRegra(BLACK, [], null, null, { hoje: '2026-11-27' });
    const site = caixa.paraSite();

    expect(caixa.ligada).toBe(true);
    expect(caixa.decidir(antiga).entra).toBe(true);
    expect(caixa.precoComDesconto(100)).toBe(50);

    expect(site.ligada).toBe(false);
    expect(site.motivoDesligada).toBe(MOTIVO_SO_CAIXA);
    const d = site.decidir(antiga);
    expect(d.entra).toBe(false);
    expect(d.criterio).toBe('desligada');
    expect(d.motivo).toBe(MOTIVO_SO_CAIXA);
    // A vista do site não é "outra campanha": mesma config, mesmo %, mesma chave de exceções.
    expect(site.config).toBe(caixa.config);
    expect(site.campanha).toBe(caixa.campanha);
    expect(site.paraSite()).toBe(site);
  });

  it('a vista do site não passa por cima de família INCLUÍDA na mão: a campanha não vale no site, ponto', () => {
    const caixa = criarRegra(BLACK, [{ chave: '700979', decisao: 'dentro' }], null, null, { hoje: '2026-11-27' });
    expect(caixa.decidir(antiga).criterio).toBe('excecao');
    expect(caixa.paraSite().decidir(antiga).entra).toBe(false);
  });

  it('marcado "vale no site": a vista do site É a régua do caixa', () => {
    const caixa = criarRegra({ ...BLACK, valeNoSite: true }, [], null, null, { hoje: '2026-11-27' });
    expect(caixa.paraSite()).toBe(caixa);
    expect(caixa.paraSite().decidir(antiga).entra).toBe(true);
  });

  it('campanha desligada ou fora da janela: o site repete o motivo do caixa, não inventa "só no caixa"', () => {
    const desligada = criarRegra({ ...BLACK, ativa: false }, [], null, null, { hoje: '2026-11-27' }).paraSite();
    expect(desligada.ligada).toBe(false);
    expect(desligada.motivoDesligada).toBe('campanha desligada');
    expect(desligada.decidir(antiga).motivo).toBe('campanha desligada');

    const vespera = criarRegra(BLACK, [], null, null, { hoje: '2026-11-25' }).paraSite();
    expect(vespera.motivoDesligada).toMatch(/fora da vigência/);
  });

  it('marcar/desmarcar o site muda a assinatura das DUAS vistas (a vitrine remonta por ela)', () => {
    const soCaixa = criarRegra(BLACK, [], null, null, { hoje: '2026-11-27' });
    const comSite = criarRegra({ ...BLACK, valeNoSite: true }, [], null, null, { hoje: '2026-11-27' });
    expect(soCaixa.assinatura).not.toBe(comSite.assinatura);
    expect(soCaixa.paraSite().assinatura).not.toBe(comSite.paraSite().assinatura);
    // E a vista do site carrega o próprio estado: desligada no site ≠ ligada no caixa.
    expect(soCaixa.paraSite().assinatura).not.toBe(soCaixa.assinatura);
  });

  it('a virada da janela não muda o que o site cobra quando a campanha é só do caixa', () => {
    const dentro = criarRegra(BLACK, [], null, null, { hoje: '2026-11-27' }).paraSite();
    const depois = criarRegra(BLACK, [], null, null, { hoje: '2026-11-30' }).paraSite();
    expect(dentro.decidir(antiga).entra).toBe(false);
    expect(depois.decidir(antiga).entra).toBe(false);
    expect(dentro.precoComDesconto(100)).toBe(50); // a conta do % existe; quem decide se aplica é `decidir`
  });
});
