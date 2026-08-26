/**
 * CANCELAR PEDIDO EXIGE MOTIVO — E O MOTIVO FICA GRAVADO (26/08/2026, dono).
 *
 * O `PATCH /orders/wc/:id` aceitava `status: 'cancelled'` e escrevia uma nota
 * fixa (`Pedido CANCELADO pelo Flow`) **sem usuário e sem porquê**. Medido em
 * produção: **18 cancelamentos em 60 dias, 0 com `user_id`** — o histórico
 * provava QUANDO o pedido morreu e nada mais.
 *
 * Caso que provou: **ON-000017** (venda online de Suzano, R$ 159,80).
 * Cancelado em 22/08 12:28 (BRT) sem uma linha de explicação; pra reconstruir
 * o "por quê" foi preciso ler o reporte de ruptura da loja 18 do dia anterior
 * e conferir o estoque da rede peça por peça. Cancelamento é o fim da linha de
 * um pedido PAGO — é justamente o evento que não pode ser anônimo.
 *
 * A loja já é obrigada a dizer o porquê quando reporta problema numa peça
 * (`pick_orders.issue_reason`/`issue_note`); a retaguarda cancelando o pedido
 * inteiro não tinha exigência nenhuma.
 */

/** Tamanho mínimo do motivo — corta "ok", ".", "x" e afins. */
export const MOTIVO_MIN = 3;

/** Teto de caracteres gravados na nota (o resto vira ruído no histórico). */
export const MOTIVO_MAX = 300;

/** Os status que MATAM o pedido — os únicos que exigem motivo. */
const CANCELAMENTOS = new Set(['cancelled', 'canceled', 'refunded']);

/** O status pedido pela tela encerra o pedido? */
export function ehCancelamento(status: string | null | undefined): boolean {
  return CANCELAMENTOS.has(String(status ?? '').trim().toLowerCase());
}

/**
 * Primeiro texto aproveitável entre os candidatos (campo próprio de motivo,
 * nota digitada...). Devolve `null` quando nenhum serve.
 */
export function normalizarMotivo(
  ...candidatos: Array<string | null | undefined>
): string | null {
  for (const c of candidatos) {
    const t = String(c ?? '').trim();
    if (t.length >= MOTIVO_MIN) return t.slice(0, MOTIVO_MAX);
  }
  return null;
}

/** Está cancelando SEM dizer por quê? */
export function faltaMotivo(
  status: string | null | undefined,
  ...candidatos: Array<string | null | undefined>
): boolean {
  return ehCancelamento(status) && normalizarMotivo(...candidatos) === null;
}

/** O texto que a tela mostra quando a trava pega — diz o porquê E o que fazer. */
export function textoMotivoObrigatorio(status: string | null | undefined): string {
  const rotulo = String(status ?? '').trim().toLowerCase() === 'refunded' ? 'reembolsar' : 'cancelar';
  return (
    `Pra ${rotulo} o pedido é obrigatório dizer o motivo (mínimo ${MOTIVO_MIN} letras). ` +
    `Escreva o que aconteceu no campo "Motivo do cancelamento" — ele fica no ` +
    `histórico do pedido junto com o seu nome. Sem isso ninguém consegue ` +
    `explicar depois por que a cliente ficou sem a peça (caso ON-000017).`
  );
}

/** Como o motivo e o autor aparecem no histórico do pedido. */
export function assinaturaDoCancelamento(
  motivo: string | null | undefined,
  autor: string | null | undefined,
): string {
  const partes: string[] = [];
  const m = String(motivo ?? '').trim();
  const a = String(autor ?? '').trim();
  if (m) partes.push(`motivo: ${m}`);
  partes.push(a ? `por ${a}` : 'por usuário não identificado');
  return ` · ${partes.join(' · ')}`;
}
