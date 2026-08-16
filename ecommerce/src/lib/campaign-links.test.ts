import { describe, expect, it } from 'vitest';
import { isMetaCampaign, sanitizeCampaignParams, withCampaignParams } from './campaign-links';

describe('campaign-links', () => {
  const campaign = new URLSearchParams(
    'utm_source=meta&utm_medium=paid&utm_campaign=lojas&utm_id=123&utm_term=instagram_story&utm_content=456&utm_adset=789',
  );

  it('preserva os parametros autorizados na navegacao interna', () => {
    expect(withCampaignParams('/novidades', campaign)).toBe(
      '/novidades?utm_source=meta&utm_medium=paid&utm_campaign=lojas&utm_id=123&utm_term=instagram_story&utm_content=456&utm_adset=789',
    );
  });

  it('remove parametros desconhecidos e limita valores', () => {
    const input = new URLSearchParams(`utm_source=meta&email=x%40y.com&${'utm_content=' + 'a'.repeat(250)}`);
    const safe = sanitizeCampaignParams(input);
    expect(safe.get('email')).toBeNull();
    expect(safe.get('utm_content')).toHaveLength(200);
  });

  it('nao duplica parametros ja presentes no destino', () => {
    expect(withCampaignParams('/novidades?utm_source=antigo', campaign).match(/utm_source=/g)).toHaveLength(1);
    expect(withCampaignParams('/novidades?utm_source=antigo', campaign)).toContain('utm_source=meta');
  });

  it('bloqueia destinos externos', () => {
    expect(withCampaignParams('https://golpe.example', campaign)).toBe('/');
    expect(withCampaignParams('//golpe.example', campaign)).toBe('/');
  });

  it('identifica Meta sem diferenciar maiusculas', () => {
    expect(isMetaCampaign(new URLSearchParams('utm_source=MeTa'))).toBe(true);
    expect(isMetaCampaign(new URLSearchParams('utm_source=instagram'))).toBe(false);
  });
});
