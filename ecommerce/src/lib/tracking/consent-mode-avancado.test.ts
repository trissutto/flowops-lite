/**
 * CONSENT MODE AVANÇADO — a tag do Google carrega para quem NÃO DECIDIU (com
 * tudo negado) e continua fora para quem RECUSOU. É a mesma régua da CAPI da
 * Meta (`metaServidorPodeReceber`), aplicada ao gtag. Se um dia alguém
 * "simplificar" isto para `analytics || marketing`, 85% do funil volta a ser
 * invisível para GA4 e Ads sem nenhum erro aparecer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONSENT, googlePodeCarregar, metaServidorPodeReceber } from './consent';
import type { ConsentState } from './types';

const estado = (p: Partial<ConsentState>): ConsentState => ({ ...DEFAULT_CONSENT, ...p });

describe('googlePodeCarregar (Consent Mode avançado)', () => {
  const envAntes = process.env.NEXT_PUBLIC_CONSENT_MODE_AVANCADO;
  afterEach(() => {
    if (envAntes === undefined) delete process.env.NEXT_PUBLIC_CONSENT_MODE_AVANCADO;
    else process.env.NEXT_PUBLIC_CONSENT_MODE_AVANCADO = envAntes;
  });

  it('quem não decidiu recebe a tag (com sinais negados — quem nega é o gtag)', () => {
    expect(googlePodeCarregar(estado({ decided_at: null }))).toBe(true);
  });

  it('quem clicou "Só o necessário" NÃO recebe tag nem evento', () => {
    expect(googlePodeCarregar(estado({ decided_at: '2026-09-14T12:00:00.000Z' }))).toBe(false);
  });

  it('quem aceitou só Publicidade também carrega — a tag do Ads não pode depender de "Análise"', () => {
    expect(googlePodeCarregar(estado({ marketing: true, decided_at: '2026-09-14T12:00:00.000Z' }))).toBe(true);
  });

  it('quem aceitou Análise carrega, como sempre', () => {
    expect(googlePodeCarregar(estado({ analytics: true, decided_at: '2026-09-14T12:00:00.000Z' }))).toBe(true);
  });

  it('segue a MESMA régua da perna servidor da Meta nas três posturas', () => {
    for (const s of [
      estado({ decided_at: null }),
      estado({ decided_at: '2026-09-14T12:00:00.000Z' }),
      estado({ analytics: true, decided_at: '2026-09-14T12:00:00.000Z' }),
    ]) {
      expect(googlePodeCarregar(s)).toBe(metaServidorPodeReceber(s));
    }
  });

  it('NEXT_PUBLIC_CONSENT_MODE_AVANCADO=0 volta ao modo básico (só com aceite)', () => {
    process.env.NEXT_PUBLIC_CONSENT_MODE_AVANCADO = '0';
    expect(googlePodeCarregar(estado({ decided_at: null }))).toBe(false);
    expect(googlePodeCarregar(estado({ marketing: true, decided_at: '2026-09-14T12:00:00.000Z' }))).toBe(true);
  });
});
