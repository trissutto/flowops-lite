import { describe, expect, it } from 'vitest';
import { enderecoDaPeca, linkDoItem } from './variantes';

const SITE = 'https://lurds.com.br';

describe('endereço da peça nos feeds — por REF, nunca pelo slug', () => {
  it('não depende do nome nem da cor principal (o slug muda, a REF não)', () => {
    const antes = enderecoDaPeca({ ref: '207372', slug: 'blusa-manga-curta-207372-marrie-207372' }, SITE);
    const depois = enderecoDaPeca({ ref: '207372', slug: 'blusa-renomeada-207372-preto' }, SITE);
    expect(antes).toBe('https://lurds.com.br/produto/ref-207372');
    expect(depois).toBe(antes);
  });

  it('REF com letra, hífen e caixa alta vira a chave que a rota entende', () => {
    expect(enderecoDaPeca({ ref: 'VLM-222', slug: 'x' }, SITE)).toBe('https://lurds.com.br/produto/ref-vlm-222');
    expect(enderecoDaPeca({ ref: ' C0336 ', slug: 'x' }, SITE)).toBe('https://lurds.com.br/produto/ref-c0336');
    expect(enderecoDaPeca({ ref: 'BMM 001/A', slug: 'x' }, SITE)).toBe('https://lurds.com.br/produto/ref-bmm-001-a');
  });

  it('sem REF utilizável volta pro slug — melhor que /produto/ref-, que quebra sempre', () => {
    expect(enderecoDaPeca({ ref: '', slug: 'vestido-azul' }, SITE)).toBe('https://lurds.com.br/produto/vestido-azul');
    expect(enderecoDaPeca({ ref: '---', slug: 'vestido-azul' }, SITE)).toBe('https://lurds.com.br/produto/vestido-azul');
  });
});

describe('link do item', () => {
  const p = { ref: '9230', slug: 'vestido-9230' };

  it('peça de várias cores abre a ficha já na cor do anúncio', () => {
    expect(linkDoItem(p, { grupo: '9230', cor: 'AZUL' }, SITE)).toBe('https://lurds.com.br/produto/ref-9230?cor=AZUL');
    expect(linkDoItem(p, { grupo: '9230', cor: 'ESTAMPA SALMÃO' }, SITE)).toBe(
      'https://lurds.com.br/produto/ref-9230?cor=ESTAMPA%20SALM%C3%83O',
    );
  });

  it('peça de cor única não ganha query à toa', () => {
    expect(linkDoItem(p, { grupo: null, cor: 'PRETO' }, SITE)).toBe('https://lurds.com.br/produto/ref-9230');
  });
});
