/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CHAVE DA MATRIZ — trava do pedido não pode ser beco sem saída (10/09/2026)
 *
 *  ORDEM DO DONO: "preciso que a qualquer tempo possamos mudar o status, o
 *  produto... etc".
 *
 *  O caso que provou: **LP-001312**. A cliente pediu outro TAMANHO de uma
 *  peça; a loja já tinha carimbado o rastreio no card. Daí em diante o
 *  sistema respondia NÃO em todas as portas — "a loja já postou esta peça",
 *  "pedido já despachado não volta pra separação" — e a única saída que a
 *  tela oferecia era o portal de trocas/devolução, que trata peça que
 *  VIAJOU. A peça não tinha viajado: estava ali, na loja, esperando trocar
 *  de tamanho.
 *
 *  As travas continuam existindo e continuam certas — cada uma tem incidente
 *  com nome (`volta-pro-fluxo.ts`, `troca-bloqueio.ts`, o envio duplicado do
 *  `pick-orders.service`). O que faltava era a CHAVE: a matriz abre, dizendo
 *  por escrito por que abriu, e o histórico do pedido guarda quem abriu, o
 *  que a trava dizia e o motivo. Trava vira decisão registrada em vez de
 *  parede.
 *
 *  A régua mora no `common` pelo mesmo motivo do `volta-pro-fluxo.ts`: ela é
 *  a MESMA nas três portas (status do pedido, troca da peça, status do card)
 *  e o teste dela não pode depender de meio Nest pra rodar. Divergir aqui
 *  seria pior que não ter — cada porta pedindo um motivo diferente.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Quem tem a chave: a MATRIZ. Vendedora de loja não destrava. */
export const ROLES_QUE_DESTRAVAM = ['admin', 'operator'];

/**
 * Tamanho mínimo do motivo. Cinco caracteres não fazem ninguém escrever um
 * romance — fazem "ok" e "." não passarem. Mesma régua da cortesia da troca
 * (`liberarSemCobrar`), que já pedia motivo desde 21/08.
 */
export const MOTIVO_MINIMO = 5;

export type PedidoDeDestrave = {
  /** `req.user.role` de quem clicou. */
  role?: string | null;
  /** O que a pessoa escreveu na tela. */
  motivo?: string | null;
};

/** A matriz? (admin/operator). Vendedora e qualquer outro papel: não. */
export function podeDestravar(role?: string | null): boolean {
  return ROLES_QUE_DESTRAVAM.includes(String(role ?? '').trim().toLowerCase());
}

/**
 * Por que ESTE destrave não pode acontecer. Null = pode.
 *
 * Devolve texto pronto pra tela: o "não" sempre diz o que falta, nunca só
 * que não deu.
 */
export function motivoDeRecusaDoDestrave(p: PedidoDeDestrave): string | null {
  if (!podeDestravar(p.role)) {
    return 'Só a matriz destrava (admin/operator). Peça pra quem tem acesso da retaguarda.';
  }
  if (String(p.motivo ?? '').trim().length < MOTIVO_MINIMO) {
    return (
      'Escreva o motivo do destrave — é ele que explica, daqui a seis meses, ' +
      'por que este pedido saiu do trilho normal.'
    );
  }
  return null;
}

/**
 * A linha que vai pro `order_history`. Guarda as TRÊS coisas que a auditoria
 * vai querer: que foi destrave, o que a trava dizia e por quê.
 */
export function notaDoDestrave(
  trava: string,
  motivo: string,
  ator?: string | null,
): string {
  const quem = String(ator ?? '').trim();
  return (
    `🔓 DESTRAVADO PELA MATRIZ${quem ? ` (${quem})` : ''} — a trava dizia: ` +
    `"${String(trava).trim()}". Motivo: ${String(motivo).trim()}`
  );
}
