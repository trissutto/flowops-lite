import { isSupremo, supremoEmails } from './supremo';

describe('supremo — quem entra no módulo Imóveis', () => {
  afterEach(() => {
    delete process.env.SUPREMO_EMAILS;
  });

  it('o dono entra sem env nenhuma', () => {
    expect(isSupremo('trissutto@gmail.com')).toBe(true);
  });

  it('a Taline entra (login atendimento@, liberada pelo dono em 16/09)', () => {
    expect(isSupremo('atendimento@lurds.com.br')).toBe(true);
  });

  it('e-mail do token vem com caixa/espaço variados e ainda casa', () => {
    expect(isSupremo('  TRISSUTTO@Gmail.com ')).toBe(true);
  });

  it('quem não está na lista não entra — nem vazio, nem nulo', () => {
    expect(isSupremo('vendedora@lurdsplussize.com.br')).toBe(false);
    expect(isSupremo('')).toBe(false);
    expect(isSupremo(null)).toBe(false);
    expect(isSupremo(undefined)).toBe(false);
  });

  // Antes a env SUBSTITUÍA a lista: setada sem o dono, trancava o dono fora.
  it('env SOMA à lista fixa — nunca tira o dono', () => {
    process.env.SUPREMO_EMAILS = 'Outra@Exemplo.com, ,';
    expect(isSupremo('outra@exemplo.com')).toBe(true);
    expect(isSupremo('trissutto@gmail.com')).toBe(true);
    expect(supremoEmails().filter((e) => e === 'trissutto@gmail.com')).toHaveLength(1);
  });

  it('env em branco não abre a porta pra e-mail vazio', () => {
    process.env.SUPREMO_EMAILS = '   ';
    expect(supremoEmails()).not.toContain('');
    expect(isSupremo('   ')).toBe(false);
  });
});
