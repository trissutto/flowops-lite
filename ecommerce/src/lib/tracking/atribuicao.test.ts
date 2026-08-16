/**
 * O NOME DA CAMPANHA TEM QUE CHEGAR LEGÍVEL.
 *
 * O Meta codifica o `{{campaign.name}}` antes de montar a URL e a URL depois,
 * então `URLSearchParams.get()` — que decodifica UMA vez — entregava
 * `%7CSITENOVO%7C+Vendas+Capitais+VOGUE+Preta` no relatório da retaguarda.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { captureAttribution } from './identity';

const irPara = (query: string) => {
  window.history.replaceState({}, '', `/${query}`);
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  irPara('');
});

describe('captureAttribution — nome da campanha', () => {
  it('desfaz a codificação dupla do Meta', () => {
    irPara('?utm_source=meta&utm_medium=cpc&utm_campaign=%257CSITENOVO%257C%2BVendas%2BCapitais%2BVOGUE%2BPreta');

    expect(captureAttribution().campaign).toBe('|SITENOVO| Vendas Capitais VOGUE Preta');
  });

  it('trata a codificação simples, que é o caso normal', () => {
    irPara('?utm_source=meta&utm_campaign=Linha%20Conforto%20%7C%20SP');

    expect(captureAttribution().campaign).toBe('Linha Conforto | SP');
  });

  it('não estraga nome que já vem limpo', () => {
    irPara('?utm_source=meta&utm_campaign=1608-vogue-preta-capitais');

    expect(captureAttribution().campaign).toBe('1608-vogue-preta-capitais');
  });

  /** `%` solto não casa com `%XX`, então "PROMO 50%" atravessa inteiro. */
  it('preserva o por cento de uma campanha de promoção', () => {
    irPara('?utm_source=meta&utm_campaign=PROMO%2050%25%20OFF');

    expect(captureAttribution().campaign).toBe('PROMO 50% OFF');
  });

  it('decodifica também origem, mídia e posição', () => {
    irPara('?utm_source=meta&utm_medium=cpc&utm_term=Instagram%2BStories&utm_content=criativo%2B01');

    const attr = captureAttribution();
    expect(attr.term).toBe('Instagram Stories');
    expect(attr.content).toBe('criativo 01');
  });
});
