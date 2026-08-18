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

/**
 * A POSTURA é o que separa "não decidiu" de "recusou" — e é a linha inteira do
 * repasse à Meta. Antes os dois caíam no mesmo balde, e o efeito medido em
 * 17/08/2026 foi a campanha `52531954165766` levar 1.012 sessões e o Meta
 * saber de 8.
 *
 * O caso que NUNCA pode virar verde por acidente é `recusou`: registrar o não
 * e mandar assim mesmo é má-fé. Se alguém "simplificar" isso pra
 * `decided_at === null ? ... : ...` sem olhar as flags, este teste quebra.
 */
describe('posturaDe / metaServidorPodeReceber', () => {
  const base = { necessary: true as const, personalization: false, version: 1 };
  const naoDecidiu = { ...base, analytics: false, marketing: false, decided_at: null };
  const recusou = { ...base, analytics: false, marketing: false, decided_at: '2026-08-17T10:00:00.000Z' };
  const aceitou = { ...base, analytics: true, marketing: true, decided_at: '2026-08-17T10:00:00.000Z' };
  // Aceitou SÓ analytics: continua sendo um sim, e o repasse vale.
  const soAnalytics = { ...base, analytics: true, marketing: false, decided_at: '2026-08-17T10:00:00.000Z' };

  it('classifica as três posturas', async () => {
    const { posturaDe } = await carregarCom(null);
    expect(posturaDe(naoDecidiu)).toBe('nao_decidiu');
    expect(posturaDe(recusou)).toBe('recusou');
    expect(posturaDe(aceitou)).toBe('aceitou');
    expect(posturaDe(soAnalytics)).toBe('aceitou');
  });

  it('deixa a Meta receber de quem aceitou e de quem não decidiu', async () => {
    const { metaServidorPodeReceber } = await carregarCom(null);
    expect(metaServidorPodeReceber(aceitou)).toBe(true);
    expect(metaServidorPodeReceber(naoDecidiu)).toBe(true);
  });

  it('🚨 NUNCA deixa a Meta receber de quem recusou', async () => {
    const { metaServidorPodeReceber } = await carregarCom(null);
    expect(metaServidorPodeReceber(recusou)).toBe(false);
  });

  it('quem recusa DEPOIS de ter aceitado para de ser repassado', async () => {
    const { metaServidorPodeReceber, setConsent, getConsent } = await carregarCom(
      JSON.stringify(aceitou),
    );
    expect(metaServidorPodeReceber(getConsent())).toBe(true);
    setConsent({ analytics: false, marketing: false, personalization: false });
    expect(metaServidorPodeReceber(getConsent())).toBe(false);
  });
});
