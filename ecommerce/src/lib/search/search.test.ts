/**
 * Testes do motor de busca — os caminhos que, se quebrarem, a cliente
 * digita "vestido pra casamento" e recebe uma página morta.
 *
 * Tudo com fixtures inline (zero rede): o contrato é `Product` → o mesmo
 * shape que o mapPeca produz. Cobertura: frases naturais da spec, typo,
 * zero-results que relaxa, boost de merchandising e o teto da
 * personalização (desempata, nunca domina).
 */

import { describe, expect, it } from 'vitest';

import type { Product } from '@/types';
import { applyBoosts } from '@/lib/merchandising/boost';
import { DEFAULT_BOOST_RULES, loadBoostRules } from '@/lib/merchandising/rules';
import { createSearchIndex, heuristicInterpreter, rankSearch } from './index';

/* ---------------------------------------------------------------- FIXTURES */

function produto(partial: Partial<Product> & Pick<Product, 'id' | 'name' | 'category'>): Product {
  return {
    slug: partial.id,
    price: 199,
    images: [],
    sizes: [{ label: '48', available: true }],
    sku: partial.id,
    ...partial,
  };
}

const CATALOGO: Product[] = [
  produto({
    id: 'vestido-midi-crepe',
    name: 'Vestido Midi Crepe Marsala',
    category: 'vestidos',
    price: 289,
    fabric: 'crepe',
    fit: 'evasê',
    colors: [{ name: 'Vinho', hex: '#7a3b46' }],
    occasions: ['casamento', 'festa'],
  }),
  produto({
    id: 'vestido-soltinho-visco',
    name: 'Vestido Soltinho Viscolycra Preto',
    category: 'vestidos',
    price: 179,
    fabric: 'viscolycra premium',
    fit: 'soltinho',
    colors: [{ name: 'Preto', hex: '#1a1614' }],
    occasions: ['dia-a-dia'],
    badges: ['novo'],
  }),
  produto({
    id: 'vestido-longo-manga',
    name: 'Vestido Longo Manga Crepe Azul Marinho',
    category: 'vestidos',
    price: 319,
    fabric: 'crepe',
    fit: 'longo',
    colors: [{ name: 'Azul Marinho', hex: '#1f3350' }],
    occasions: ['igreja', 'casamento'],
  }),
  produto({
    id: 'blazer-alfaiataria',
    name: 'Blazer Alfaiataria Bege',
    category: 'jaquetas',
    price: 349,
    fabric: 'alfaiataria',
    colors: [{ name: 'Bege', hex: '#d9cdb4' }],
    occasions: ['trabalho'],
  }),
  produto({
    id: 'calca-pantalona',
    name: 'Calça Pantalona Alfaiataria Preta',
    category: 'calcas',
    price: 229,
    fabric: 'alfaiataria',
    colors: [{ name: 'Preto', hex: '#1a1614' }],
    occasions: ['trabalho'],
  }),
  produto({
    id: 'conjunto-malha',
    name: 'Conjunto Malha Canelada Verde',
    category: 'conjuntos',
    price: 199,
    fabric: 'malha',
    fit: 'soltinho',
    colors: [{ name: 'Verde', hex: '#4f7355' }],
    occasions: ['viagem', 'dia-a-dia'],
  }),
  produto({
    id: 'blusa-linho-nova',
    name: 'Blusa Bata Linho Off White',
    category: 'blusas',
    price: 159,
    fabric: 'linho',
    colors: [{ name: 'Off White', hex: '#f1eadf' }],
    badges: ['novo'],
  }),
  produto({
    id: 'blusa-linho-classica',
    name: 'Blusa Bata Linho Natural',
    category: 'blusas',
    price: 159,
    fabric: 'linho',
    colors: [{ name: 'Bege', hex: '#d9cdb4' }],
  }),
];

const DOCS = createSearchIndex(CATALOGO);
const ids = (outcome: ReturnType<typeof rankSearch>) => outcome.results.map((r) => r.doc.product.id);

/* ------------------------------------------------------------------ ÍNDICE */

describe('createSearchIndex', () => {
  it('normaliza acento e caixa nos campos do doc', () => {
    const doc = DOCS.find((d) => d.product.id === 'calca-pantalona')!;
    expect(doc.name).toBe('calca pantalona alfaiataria preta');
    expect(doc.category).toBe('calcas');
    expect(doc.haystack).toContain('trabalho');
  });
});

/* ---------------------------------------------------- INTENÇÃO (spec inteira) */

describe('heuristicInterpreter — frases da spec', () => {
  it('"Vestido para casamento" → categoria + ocasião', () => {
    const intent = heuristicInterpreter.interpret('Vestido para casamento');
    expect(intent.facets.category).toBe('vestidos');
    expect(intent.facets.occasion).toBe('casamento');
    expect(intent.residual).toBe('');
    expect(intent.label).toBe('vestidos para casamento');
    expect(intent.confidence).toBe('alta');
  });

  it('"Roupa confortável" → atributos de conforto (malha/viscolycra)', () => {
    const intent = heuristicInterpreter.interpret('Roupa confortável');
    expect(intent.facets.attributes).toEqual(expect.arrayContaining(['malha', 'viscolycra']));
    expect(intent.confidence).toBe('alta');
  });

  it('"Quero esconder barriga" → soltinho/evasê/acinturado', () => {
    const intent = heuristicInterpreter.interpret('Quero esconder barriga');
    expect(intent.facets.attributes).toEqual(expect.arrayContaining(['soltinho', 'evase', 'acinturado']));
    expect(intent.residual).toBe('');
  });

  it('"Roupa elegante" → alfaiataria/crepe', () => {
    const intent = heuristicInterpreter.interpret('Roupa elegante');
    expect(intent.facets.attributes).toEqual(expect.arrayContaining(['alfaiataria', 'crepe']));
  });

  it('"Look trabalho" → ocasião trabalho', () => {
    const intent = heuristicInterpreter.interpret('Look trabalho');
    expect(intent.facets.occasion).toBe('trabalho');
    expect(intent.residual).toBe('');
  });

  it('"Roupa para viajar" → ocasião viagem', () => {
    const intent = heuristicInterpreter.interpret('Roupa para viajar');
    expect(intent.facets.occasion).toBe('viagem');
  });

  it('"Look moderno" → atributo moderna', () => {
    const intent = heuristicInterpreter.interpret('Look moderno');
    expect(intent.facets.attributes).toEqual(expect.arrayContaining(['moderna']));
  });

  it('"Moda evangélica" → igreja + comprimento midi/longo + manga', () => {
    const intent = heuristicInterpreter.interpret('Moda evangélica');
    expect(intent.facets.occasion).toBe('igreja');
    expect(intent.facets.attributes).toEqual(expect.arrayContaining(['midi', 'longo', 'manga']));
  });

  it('teto de preço: "vestido até 200 reais"', () => {
    const intent = heuristicInterpreter.interpret('vestido até 200 reais');
    expect(intent.facets.category).toBe('vestidos');
    expect(intent.facets.priceMax).toBe(200);
  });

  it('frase sem vocabulário conhecido → confiança baixa, residual preservado', () => {
    const intent = heuristicInterpreter.interpret('aurora boreal');
    expect(intent.confidence).toBe('baixa');
    expect(intent.residual).toBe('aurora boreal');
  });
});

/* ------------------------------------------------------------------ MOTOR */

describe('rankSearch — relevância', () => {
  it('frase natural filtra pela faceta: só vestidos de casamento', () => {
    const outcome = rankSearch(DOCS, { term: 'Vestido para casamento' });
    expect(outcome.relaxed).toBe(false);
    expect(ids(outcome)).toEqual(
      expect.arrayContaining(['vestido-midi-crepe', 'vestido-longo-manga']),
    );
    expect(ids(outcome)).not.toContain('vestido-soltinho-visco'); // não é de casamento
    expect(ids(outcome)).not.toContain('blazer-alfaiataria'); // não é vestido
  });

  it('typo "vestdio" ainda encontra vestidos (fuzzy por bigramas)', () => {
    const outcome = rankSearch(DOCS, { term: 'vestdio' });
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results[0].doc.category).toBe('vestidos');
  });

  it('"quero esconder barriga" prioriza modelagem soltinho/evasê', () => {
    const outcome = rankSearch(DOCS, { term: 'quero esconder barriga' });
    expect(outcome.results.length).toBeGreaterThan(0);
    // Os dois vestidos com modelagem que disfarça vêm no resultado.
    expect(ids(outcome)).toEqual(
      expect.arrayContaining(['vestido-soltinho-visco', 'vestido-midi-crepe']),
    );
  });

  it('teto de preço é filtro duro no passo estrito', () => {
    const outcome = rankSearch(DOCS, { term: 'vestido até 200 reais' });
    expect(outcome.relaxed).toBe(false);
    expect(ids(outcome)).toEqual(['vestido-soltinho-visco']); // único vestido ≤ 200
  });

  it('nome exato ganha de tudo', () => {
    const outcome = rankSearch(DOCS, { term: 'Conjunto Malha Canelada Verde' });
    expect(outcome.results[0].doc.product.id).toBe('conjunto-malha');
  });
});

describe('rankSearch — zero results NUNCA', () => {
  it('faceta impossível relaxa em camadas e ainda devolve a categoria', () => {
    // Não existe vestido amarelo no catálogo — solta a cor, mantém vestidos.
    const outcome = rankSearch(DOCS, { term: 'vestido amarelo' });
    expect(outcome.relaxed).toBe(true);
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results.every((r) => r.doc.category === 'vestidos')).toBe(true);
    expect(outcome.suggestions.length).toBeGreaterThan(0);
  });

  it('termo sem nenhuma relação ainda devolve catálogo + sugestões', () => {
    const outcome = rankSearch(DOCS, { term: 'xqzwky' });
    expect(outcome.relaxed).toBe(true);
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.suggestions.length).toBeGreaterThan(0);
  });

  it('busca vazia vira vitrine (nunca caixa vazia)', () => {
    const outcome = rankSearch(DOCS, { term: '' });
    expect(outcome.results.length).toBe(CATALOGO.length);
  });
});

/* ---------------------------------------------------------- MERCHANDISING */

describe('boosts de merchandising', () => {
  it('novidade sobe: entre duas blusas iguais, a com badge "novo" vence', () => {
    const outcome = rankSearch(DOCS, { term: 'blusa de linho' });
    const posNova = ids(outcome).indexOf('blusa-linho-nova');
    const posClassica = ids(outcome).indexOf('blusa-linho-classica');
    expect(posNova).toBeGreaterThanOrEqual(0);
    expect(posClassica).toBeGreaterThanOrEqual(0);
    expect(posNova).toBeLessThan(posClassica);
  });

  it('a razão do boost aparece no resultado (auditável no painel)', () => {
    const outcome = rankSearch(DOCS, { term: 'blusa de linho' });
    const nova = outcome.results.find((r) => r.doc.product.id === 'blusa-linho-nova')!;
    expect(nova.reasons.join(' ')).toContain('Novidade');
  });

  it('applyBoosts multiplica só regra habilitada que casa', () => {
    const alvo = CATALOGO.find((p) => p.id === 'blusa-linho-nova')!;
    const { score, reasons } = applyBoosts(100, alvo, DEFAULT_BOOST_RULES);
    expect(score).toBe(125); // só novidade (1.25) casa — sem promo/best-seller
    expect(reasons).toHaveLength(1);
  });

  it('loadBoostRules devolve as default com as 4 regras ligadas', () => {
    const rules = loadBoostRules();
    expect(rules.map((r) => r.id).sort()).toEqual(['best-seller', 'novidade', 'promocao', 'ultimas-pecas']);
    expect(rules.every((r) => r.enabled)).toBe(true);
  });
});

/* --------------------------------------------------------- PERSONALIZAÇÃO */

describe('personalização — desempata, nunca domina', () => {
  it('desempata: mesma relevância, categoria favorita primeiro', () => {
    // "alfaiataria" pontua blazer e calça igual; favorita = calças.
    const outcome = rankSearch(DOCS, {
      term: 'alfaiataria',
      personalization: { topCategories: ['calcas'], topFabrics: [] },
    });
    const posCalca = ids(outcome).indexOf('calca-pantalona');
    const posBlazer = ids(outcome).indexOf('blazer-alfaiataria');
    expect(posCalca).toBeLessThan(posBlazer);
  });

  it('não domina: match de texto forte continua na frente da favorita', () => {
    // Busca literal pelo blazer com perfil todo voltado pra calças.
    const outcome = rankSearch(DOCS, {
      term: 'Blazer Alfaiataria Bege',
      personalization: { topCategories: ['calcas'], topFabrics: ['alfaiataria'] },
    });
    expect(outcome.results[0].doc.product.id).toBe('blazer-alfaiataria');
  });

  it('fator de personalização é travado em ≤ 1.3', () => {
    const alvo = CATALOGO.find((p) => p.id === 'calca-pantalona')!;
    const { score } = applyBoosts(100, alvo, [], {
      topCategories: ['calcas'],
      topFabrics: ['alfaiataria'],
    });
    expect(score).toBeLessThanOrEqual(130);
    expect(score).toBeGreaterThan(100); // mas pontuou
  });
});
