/**
 * O STATUS DO PEDIDO NO VOCABULÁRIO DA CLIENTE — uma regra só (item 64).
 *
 * A operação tem uma dúzia de estados (routing, separating, picking...); a
 * cliente tem quatro perguntas: pagou? separou? saiu? chegou? Qualquer estado
 * intermediário vira "preparando" — detalhar a fila interna só gera ligação
 * perguntando o que "roteamento" quer dizer.
 *
 * Nasceu privado no `CustomersAppService`. Saiu pra cá quando a barra de
 * tarefas da conta passou a CONTAR pedidos por situação: se cada tela
 * traduzisse do seu jeito, o contador diria 2 e a lista mostraria 3 — e o
 * primeiro reflexo da cliente seria achar que sumiu pedido.
 */

export type ChaveSituacao =
  | 'aguardando_pagamento'
  | 'preparando'
  | 'enviado'
  | 'entregue'
  | 'cancelado';

export interface SituacaoPublica {
  chave: ChaveSituacao;
  rotulo: string;
}

export function situacaoPublica(o: {
  status: string | null;
  paidAt: Date | null;
  trackingCode: string | null;
}): SituacaoPublica {
  const s = String(o.status || '').toLowerCase();

  if (s === 'cancelled' || s === 'canceled') {
    return { chave: 'cancelado', rotulo: 'Cancelado' };
  }
  if (s === 'delivered') return { chave: 'entregue', rotulo: 'Entregue' };
  if (s === 'shipped' || o.trackingCode) {
    return { chave: 'enviado', rotulo: 'A caminho' };
  }
  if (!o.paidAt) {
    return { chave: 'aguardando_pagamento', rotulo: 'Aguardando pagamento' };
  }
  return { chave: 'preparando', rotulo: 'Preparando seu pedido' };
}
