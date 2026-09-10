/**
 * A CÉLULA DA GRADE DA CONSULTA SOMA — e por isso bate com a linha Total.
 *
 * 10/09/2026, REF 22 (loja 01 Itanhaém): dois códigos caíam na mesma
 * cor×tamanho (camiseta manga longa 14 = 9 e regata 14 = 23). O mapa fazia
 * `set(tam, v)`: o último sobrescrevia (célula 23) enquanto os totais somavam
 * (Total 32). A vendedora lia 23 e a peça que ela procurava estava em zero.
 *
 *   npm run test:grade-consulta
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { montarGradeConsulta, rotuloGrade } from '../src/lib/grade-consulta.ts';

const v = (sku, cor, tamanho, myStoreQty, preco = null) => ({ sku, cor, tamanho, myStoreQty, preco });

test('dois códigos na mesma cor×tamanho: a célula SOMA e fica igual ao Total do tamanho', () => {
  const g = montarGradeConsulta([
    v('184861', 'BRANCA', '01', 25, 49.9),
    v('10016', 'BRANCA', '14', 9, 59.9),   // camiseta manga longa 14
    v('9959', 'BRANCA', '14', 23, 59.9),   // regata 14
  ]);

  const c14 = g.celulas.get('BRANCA').get('14');
  assert.equal(c14.myStoreQty, 32, 'célula = 9 + 23');
  assert.equal(g.totalsBySize.get('14'), 32, 'Total do tamanho = a mesma soma');
  assert.deepEqual(c14.skus, ['10016', '9959'], 'guarda TODOS os códigos da célula');
  assert.equal(c14.sku, '9959', 'o código principal é o de mais estoque (preço/hover saem dele)');
  assert.equal(g.totalsByColor.get('BRANCA'), 25 + 9 + 23);
});

test('célula com um código só continua idêntica à variante (sku, preço, 1 código)', () => {
  const g = montarGradeConsulta([v('184861', 'BRANCA', '01', 25, 49.9)]);
  const c = g.celulas.get('BRANCA').get('01');
  assert.equal(c.sku, '184861');
  assert.equal(c.myStoreQty, 25);
  assert.equal(c.preco, 49.9);
  assert.deepEqual(c.skus, ['184861']);
});

test('em QUALQUER grade, a soma das células de um tamanho é o Total daquele tamanho', () => {
  // Grade "suja" de propósito: cores repetidas, tamanho vazio, zero, três códigos na mesma célula.
  const variants = [
    v('a', 'PRETO', 'P', 3), v('b', 'PRETO', 'P', 0), v('c', 'PRETO', 'P', 5),
    v('d', 'PRETO', 'M', 2), v('e', 'AZUL', 'P', 1), v('f', 'AZUL', '', 4), v('g', 'AZUL', '', 6),
  ];
  const g = montarGradeConsulta(variants);
  for (const tam of g.tamanhos) {
    let soma = 0;
    for (const cor of g.cores) soma += g.celulas.get(cor).get(tam)?.myStoreQty ?? 0;
    assert.equal(soma, g.totalsBySize.get(tam), `tamanho ${tam}`);
  }
  assert.equal(g.celulas.get('PRETO').get('P').skus.length, 3);
});

test('cor/tamanho vazios viram "—" e a ordem de chegada é preservada (quem chama ordena)', () => {
  assert.equal(rotuloGrade(''), '—');
  assert.equal(rotuloGrade(undefined), '—');
  assert.equal(rotuloGrade(' 46 '), '46');
  const g = montarGradeConsulta([v('1', 'VERDE', 'G', 1), v('2', 'AZUL', '', 1), v('3', 'VERDE', 'P', 1)]);
  assert.deepEqual(g.cores, ['VERDE', 'AZUL']);
  assert.deepEqual(g.tamanhos, ['G', '—', 'P']);
  assert.equal(g.celulas.get('AZUL').get('—').myStoreQty, 1);
});
