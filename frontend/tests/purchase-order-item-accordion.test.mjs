import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPurchaseOrderCollection,
  getPurchaseOrderCollection,
  isPurchaseOrderItemCollapsed,
  toggleExpandedPurchaseOrderItem,
} from '../src/lib/purchase-order-item-accordion.mjs';

test('referencia pendente permanece aberta', () => {
  assert.equal(isPurchaseOrderItemCollapsed(false, null, 'ref-1'), false);
});

test('referencia conferida nasce recolhida', () => {
  assert.equal(isPurchaseOrderItemCollapsed(true, null, 'ref-1'), true);
});

test('referencia conferida selecionada pode ser reaberta', () => {
  assert.equal(isPurchaseOrderItemCollapsed(true, 'ref-1', 'ref-1'), false);
});

test('acordeao abre uma referencia por vez e recolhe ao clicar novamente', () => {
  let expanded = toggleExpandedPurchaseOrderItem(null, 'ref-1');
  assert.equal(expanded, 'ref-1');

  expanded = toggleExpandedPurchaseOrderItem(expanded, 'ref-2');
  assert.equal(expanded, 'ref-2');

  expanded = toggleExpandedPurchaseOrderItem(expanded, 'ref-2');
  assert.equal(expanded, null);
});

test('colecao do cabecalho atualiza apenas referencias pendentes', () => {
  const recebido = { tempId: '1', colecaoId: 'antiga', conferido: { pecas: 2 } };
  const pendente = { tempId: '2', colecaoId: '' };
  const resultado = applyPurchaseOrderCollection([recebido, pendente], 'inverno');

  assert.equal(resultado[0], recebido);
  assert.equal(resultado[0].colecaoId, 'antiga');
  assert.equal(resultado[1].colecaoId, 'inverno');
});

test('pedido reaberto recupera a primeira colecao preenchida', () => {
  assert.equal(getPurchaseOrderCollection([
    { colecaoId: '' },
    { colecaoId: 'verao-27' },
  ]), 'verao-27');
});
