/**
 * O MODAL DO LEITOR — avançar de linha e barrar o Confirmar (15/10/2026).
 *
 * Compra com "código de barras próprio": na conferência o leitor lê UMA peça
 * de cada tamanho. O leitor USB manda o código + Enter; a tela precisa pular
 * pra próxima linha sozinha, recusar o mesmo EAN em dois tamanhos e só liberar
 * o Confirmar com tudo lido. A régua que vale é a do backend — esta é a cópia
 * da tela.
 *
 *   npm run test:codigo-barras
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chaveDaLinha,
  conferirLeitura,
  linhaComMesmoCodigo,
  montarEansPorGrupo,
  motivoCodigoBarrasInvalido,
  normalizarCodigoBarras,
  proximaLinhaPendente,
} from '../src/lib/codigo-barras-fornecedor.ts';

const linha = (grupo, tamanho, extra = {}) => ({
  chave: chaveDaLinha(grupo, tamanho), grupo, cor: grupo, tamanho, qty: 1, ...extra,
});
const AZUL = [linha('AZUL', 'P'), linha('AZUL', 'M'), linha('AZUL', 'G')];

test('normaliza como o backend: sem espaço, maiúsculas, zero à esquerda fica', () => {
  assert.equal(normalizarCodigoBarras(' 7891 234567895 '), '7891234567895');
  assert.equal(normalizarCodigoBarras('0123456789012'), '0123456789012');
  assert.equal(normalizarCodigoBarras(null), '');
});

test('código curto, longo ou com símbolo é recusado na hora', () => {
  assert.match(motivoCodigoBarrasInvalido('1234567'), /curto/);
  assert.match(motivoCodigoBarrasInvalido('1'.repeat(21)), /longo/);
  assert.match(motivoCodigoBarrasInvalido('7891234.567895'), /hífen/);
  assert.equal(motivoCodigoBarrasInvalido('7891234567895'), null);
});

test('a próxima linha pendente vem DEPOIS da atual e dá a volta', () => {
  assert.equal(proximaLinhaPendente(AZUL, {}), 'AZUL|P');
  assert.equal(proximaLinhaPendente(AZUL, { 'AZUL|P': '7891234567895' }, 'AZUL|P'), 'AZUL|M');
  // M e G lidos, P ficou pra trás: depois de G volta pro P
  assert.equal(
    proximaLinhaPendente(AZUL, { 'AZUL|M': '7891234567895', 'AZUL|G': '7891234567901' }, 'AZUL|G'),
    'AZUL|P',
  );
});

test('todas lidas = null (o foco vai pro botão)', () => {
  const todos = { 'AZUL|P': '7891234567895', 'AZUL|M': '7891234567901', 'AZUL|G': '7891234567918' };
  assert.equal(proximaLinhaPendente(AZUL, todos, 'AZUL|G'), null);
});

test('o mesmo EAN já lido em outro tamanho é apontado', () => {
  const valores = { 'AZUL|P': '7891234567895' };
  assert.equal(linhaComMesmoCodigo(AZUL, valores, 'AZUL|M', '7891234567895')?.tamanho, 'P');
  // a própria linha não conta como "outra"
  assert.equal(linhaComMesmoCodigo(AZUL, valores, 'AZUL|P', '7891234567895'), null);
  assert.equal(linhaComMesmoCodigo(AZUL, valores, 'AZUL|M', '7891234567901'), null);
});

test('Confirmar só com tudo lido, válido e sem repetição', () => {
  assert.equal(conferirLeitura(AZUL, {}).ok, false);
  assert.equal(conferirLeitura(AZUL, {}).faltando.length, 3);

  const parcial = conferirLeitura(AZUL, { 'AZUL|P': '7891234567895', 'AZUL|M': '123' });
  assert.equal(parcial.ok, false);
  assert.equal(parcial.lidas, 1);
  assert.equal(parcial.invalidas[0].linha.tamanho, 'M');
  assert.equal(parcial.faltando[0].tamanho, 'G');

  const repetido = conferirLeitura(AZUL, {
    'AZUL|P': '7891234567895', 'AZUL|M': '7891234567895', 'AZUL|G': '7891234567918',
  });
  assert.equal(repetido.ok, false);
  assert.deepEqual(repetido.repetidas[0].linhas.map((l) => l.tamanho), ['P', 'M']);

  const completo = conferirLeitura(AZUL, {
    'AZUL|P': '7891234567895', 'AZUL|M': '7891234567901', 'AZUL|G': '7891234567918',
  });
  assert.equal(completo.ok, true);
  assert.equal(completo.lidas, 3);
});

test('o payload sai por grupo (cor ou item) → tamanho → código normalizado', () => {
  const linhas = [linha('item-1', '46'), linha('item-1', '48'), linha('item-2', '46')];
  const eans = montarEansPorGrupo(linhas, {
    'item-1|46': ' 7891234567895', 'item-1|48': '7891234567901', 'item-2|46': '7891234567918',
  });
  assert.deepEqual(eans, {
    'item-1': { '46': '7891234567895', '48': '7891234567901' },
    'item-2': { '46': '7891234567918' },
  });
});
