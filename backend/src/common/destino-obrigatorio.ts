/**
 * O DESTINO OBRIGATÓRIO DO PEDIDO — a loja onde a peça TEM que chegar.
 *
 * Existe em dois pedidos: RETIRADA em loja (a cliente vem buscar ali) e
 * MOTOBOY com loja escolhida (a moto sai dali). Nos dois, quem separa não é
 * quem entrega: se a peça está em OUTRA loja, o card dela é um ALIMENTADOR
 * (`isTransfer` + `transferToStoreCode`), e é só isso que abre o trilho da
 * caixa — etiqueta pra loja de destino, NF de transferência e romaneio
 * (`criarCaixaDoFeederSePreciso`/`docsDaCaixa` recusam card sem `isTransfer`).
 *
 * Régua única porque TRÊS lugares perguntam a mesma coisa e não podem
 * divergir: a limpeza de cards vazios (que preserva o receptor legítimo na
 * loja de destino), o "forçar loja" e o "mover peça na mão". Os dois últimos
 * não perguntavam — e é daí que vem o caso abaixo.
 *
 * ⚠️ O CASO (LP-001224, 06/09/2026). Retirada em Moema, 7 peças espalhadas
 * pela rede. A separação foi montada na mão: o `forceStoreCode` chumbava
 * `isTransfer: false` no resultado sintético, e o `moverItensParaLoja` tirava
 * a âncora SÓ dos feeders já existentes — como o force acabara de zerar os
 * feeders, toda peça movida depois também nasceu em card comum. Resultado: 4
 * peças em SOROCABA, 3 em SÃO JOSÉ, ZERO em Moema, e nenhum botão pra mandar
 * as peças pra lá. Etiqueta de cliente não sai (retirada não gera envio) e
 * caixa de transferência também não (exige `isTransfer`), então o pedido
 * ficou MUDO por 3 dias: sem caixa, sem etiqueta, sem nota — e sem erro em
 * lugar nenhum. A cliente ia buscar em Moema e não encontrava nada.
 *
 * Fica com a MESMA detecção que o `cleanupEmptyActivePickOrders` e o
 * `JuntadaService` já usavam (isPickup, ou motoboy pelo título do envio) —
 * mudar o alcance da detecção é outro assunto, e alargar aqui mexeria em
 * quem já dependia dela.
 */
export function destinoObrigatorioDoPedido(order: {
  isPickup?: boolean | null;
  pickupStoreCode?: string | null;
  shippingMethod?: string | null;
}): string | null {
  const destino = String(order?.pickupStoreCode || '').trim();
  if (!destino) return null;
  const ehMotoboy = /motoboy|moto\s*boy/i.test(String(order?.shippingMethod || ''));
  return order?.isPickup || ehMotoboy ? destino : null;
}

/**
 * A LOJA QUE VAI SEPARAR É ALIMENTADORA? Só quando existe destino obrigatório
 * e ela NÃO é o próprio destino (senão a peça já está onde precisa estar).
 * Devolve o par pronto pra gravar no card.
 */
export function transferenciaParaDestino(
  order: { isPickup?: boolean | null; pickupStoreCode?: string | null; shippingMethod?: string | null },
  storeCode: string,
): { isTransfer: boolean; transferToStoreCode: string | null } {
  const destino = destinoObrigatorioDoPedido(order);
  if (!destino || String(storeCode).trim() === destino) {
    return { isTransfer: false, transferToStoreCode: null };
  }
  return { isTransfer: true, transferToStoreCode: destino };
}

/**
 * FEEDER APONTANDO PRA LOJA SEM CARD É ÓRFÃO? Depende do pedido.
 *
 * Em SEDEX/PAC a juntada exige uma ÂNCORA que separa: feeder apontando pra
 * loja sem card é caixa viajando pra quem não separa nada (LP-000244). Em
 * RETIRADA/MOTOBOY a loja de destino é RECEPTORA — ela recebe a caixa e
 * entrega pra cliente sem separar nada, então NÃO precisa ter card. Feeder
 * apontando pro destino obrigatório é o desenho certo, não um defeito.
 *
 * ⚠️ O CASO (950001490, 17/09/2026). Retirada em SÃO JOSÉ (08), peça em
 * Itanhaém. O card de Itanhaém nasceu feeder da 08, como devia — e a tela
 * subiu dois avisos vermelhos ("a juntada aponta pra loja 08, que NÃO tem
 * card") mandando reescolher a âncora. A tela e a limpeza de card vazio já
 * sabiam da exceção; o aviso do "mover peça" e o alerta da linha do tempo
 * não. Alarme falso na fila mata a confiança no alarme verdadeiro.
 */
export function feederOrfao(
  order: { isPickup?: boolean | null; pickupStoreCode?: string | null; shippingMethod?: string | null },
  transferToStoreCode: string | null | undefined,
  temCardNaAncora: boolean,
): boolean {
  const anc = String(transferToStoreCode || '').trim();
  if (!anc) return false;
  if (temCardNaAncora) return false;
  return destinoObrigatorioDoPedido(order) !== anc;
}
