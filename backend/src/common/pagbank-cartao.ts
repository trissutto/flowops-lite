/**
 * RÉGUA DO CARTÃO PAGBANK — o que a resposta da Orders API quer dizer.
 *
 * Função pura, sem Nest e sem HTTP, pra ter spec e pra `PagbankService` e
 * `LojaOrdersService` lerem a MESMA resposta do mesmo jeito. É a irmã da
 * `classificarCartao` da Pagar.me (loja-orders.service.ts), com os status do
 * PagBank:
 *
 *   PAID         → dinheiro entrou.
 *   DECLINED     → a operadora disse NÃO (transação real, recusa de verdade).
 *   CANCELED     → cancelada antes de concluir — pra cliente é recusa.
 *   AUTHORIZED   → autorizada, captura ainda por vir (só sem `capture:true`).
 *   IN_ANALYSIS  → em análise (antifraude / operadora). Fica aguardando; quem
 *                  fecha é o webhook ou o reconcile — NUNCA uma 2ª cobrança.
 *   (outros)     → pendente, pelo mesmo motivo.
 *
 * Três estados, não dois: foi a lição de 17/08 na Pagar.me — tratar "em
 * análise" como recusa fez cliente pagar duas vezes.
 */

export type ClasseCartao = 'paid' | 'recusa' | 'pending';

export interface CartaoPagbankLido {
  classe: ClasseCartao;
  chargeId: string | null;
  chargeStatus: string | null;
  /** `payment_response.code` — 20000 é SUCESSO. */
  codigo: string | null;
  /** `payment_response.message` — texto da operadora, NUNCA vai pra tela cru. */
  mensagem: string | null;
  /** `payment_response.reference` — NSU/referência do adquirente. */
  referencia: string | null;
  bandeira: string | null;
  ultimos4: string | null;
  titular: string | null;
}

function texto(v: unknown, max = 80): string | null {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

/** Lê a order do PagBank (resposta do POST/GET /orders) e classifica o cartão. */
export function lerCartaoPagbank(order: any): CartaoPagbankLido {
  const charges: any[] = Array.isArray(order?.charges) ? order.charges : [];
  const st = (c: any) => String(c?.status || '').toUpperCase();
  // Qualquer charge PAGA vence (a Orders API pode acumular tentativas).
  const charge = charges.find((c) => st(c) === 'PAID') || charges[0] || null;
  const status = st(charge);

  let classe: ClasseCartao = 'pending';
  if (status === 'PAID') classe = 'paid';
  else if (status === 'DECLINED' || status === 'CANCELED') classe = 'recusa';

  const pr = charge?.payment_response || {};
  const card = charge?.payment_method?.card || {};
  return {
    classe,
    chargeId: texto(charge?.id, 80),
    chargeStatus: texto(status, 30),
    codigo: texto(pr.code, 20),
    mensagem: texto(pr.message, 200),
    referencia: texto(pr.reference, 60),
    bandeira: texto(card.brand, 30),
    ultimos4: texto(card.last_digits, 4),
    titular: texto(card.holder?.name, 80),
  };
}

/**
 * Erro HTTP 4xx da Orders API: é DADO DO CARTÃO ou é problema NOSSO?
 *
 * O PagBank devolve 400/422 com `error_messages[{code, description,
 * parameter_name}]`. Quando o parâmetro que falhou é o cartão criptografado
 * ou o titular (`charges[0].payment_method.card.*` / `...holder.*`), a
 * cliente ainda pode consertar (cartão mal digitado, CPF do titular). Todo o
 * resto (token, valor, endereço, 5xx) é integração — ela NÃO deve trocar de
 * cartão por causa disso.
 */
export function erroHttpEhDadoDoCartao(data: any): boolean {
  const msgs: any[] = Array.isArray(data?.error_messages) ? data.error_messages : [];
  return msgs.some((m) => /payment_method\.(card|holder)|\bholder\b|\bcard\b/i.test(String(m?.parameter_name || '')));
}

/** Resumo legível dos `error_messages` pro log/`paymentInfo.falha`. */
export function resumirErrosPagbank(data: any, fallback = ''): string {
  const msgs: any[] = Array.isArray(data?.error_messages) ? data.error_messages : [];
  if (!msgs.length) return String(fallback || '').slice(0, 300);
  return msgs
    .map((m) => [m?.parameter_name, m?.code, m?.description].filter(Boolean).join(' '))
    .join(' | ')
    .slice(0, 300);
}
