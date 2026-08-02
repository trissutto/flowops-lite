import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A validação do consentimento salvo saiu do zod pra uma guarda escrita à mão
 * (o zod eram 74 KB no bundle de todas as páginas). O comportamento não pode
 * mudar: registro fora do formato tem que ser DESCARTADO e cair no default
 * tudo-negado. Um falso positivo aqui é rastrear quem não consentiu.
 *
 * `hydrateConsent` guarda estado de módulo, então cada caso recarrega o módulo.
 */
const STORAGE_KEY = 'lurds_consent';

const VALIDO = {
  necessary: true,
  analytics: true,
  marketing: false,
  personalization: true,
  decided_at: '2026-08-01T12:00:00.000Z',
  version: 1,
};

async function carregarCom(bruto: string | null) {
  vi.resetModules();
  window.localStorage.clear();
  if (bruto !== null) window.localStorage.setItem(STORAGE_KEY, bruto);
  return import('./consent');
}

describe('hydrateConsent', () => {
  beforeEach(() => window.localStorage.clear());

  it('adota o consentimento salvo quando o registro é válido', async () => {
    const { getConsent, needsDecision } = await carregarCom(JSON.stringify(VALIDO));
    expect(getConsent()).toEqual(VALIDO);
    expect(needsDecision()).toBe(false);
  });

  it('cai no tudo-negado quando não há nada salvo', async () => {
    const { getConsent, needsDecision, isAllowed } = await carregarCom(null);
    expect(getConsent().analytics).toBe(false);
    expect(getConsent().marketing).toBe(false);
    expect(getConsent().personalization).toBe(false);
    expect(needsDecision()).toBe(true);
    // `necessary` é o único que passa sem decisão.
    expect(isAllowed('necessary')).toBe(true);
    expect(isAllowed('analytics')).toBe(false);
  });

  const invalidos: Array<[string, unknown]> = [
    ['necessary falso', { ...VALIDO, necessary: false }],
    ['necessary como string', { ...VALIDO, necessary: 'true' }],
    ['campo faltando', { ...VALIDO, personalization: undefined }],
    ['booleano como string', { ...VALIDO, analytics: 'sim' }],
    ['decided_at numérico', { ...VALIDO, decided_at: 1754049600000 }],
    ['version não inteira', { ...VALIDO, version: 1.5 }],
    ['version como string', { ...VALIDO, version: '1' }],
    ['não é objeto', 'aceito'],
    ['nulo', null],
  ];

  it.each(invalidos)('descarta registro adulterado: %s', async (_nome, valor) => {
    const { getConsent, needsDecision } = await carregarCom(JSON.stringify(valor));
    expect(getConsent().analytics).toBe(false);
    expect(getConsent().decided_at).toBeNull();
    expect(needsDecision()).toBe(true);
  });

  it('descarta consentimento de versão antiga (o texto mudou)', async () => {
    const { getConsent, needsDecision } = await carregarCom(
      JSON.stringify({ ...VALIDO, version: 0 }),
    );
    expect(getConsent().analytics).toBe(false);
    expect(needsDecision()).toBe(true);
  });

  it('não estoura com JSON quebrado no storage', async () => {
    const { getConsent } = await carregarCom('{nao é json');
    expect(getConsent().analytics).toBe(false);
  });
});
