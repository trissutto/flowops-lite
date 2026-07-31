import 'server-only';

/**
 * MOCK PROVIDER — o gateway de mentira que se comporta como um de verdade.
 *
 * Gera o payload EMV REAL (pix-emv) com a chave de sandbox: o app do banco
 * lê o QR, mostra "LURDS PLUS SIZE" e o valor — só não encontra destinatário,
 * porque a chave não existe no DICT. Perfeito pra demonstrar o fluxo inteiro
 * sem mover um centavo.
 *
 * AUTO-CONFIRMAÇÃO: pedido aguardando pagamento há mais de
 * `MOCK_PIX_CONFIRM_SECONDS` (default 25s) é confirmado no próximo check do
 * poll. Regras:
 *   - em DEV: sempre ligada (é o que faz a demo funcionar sozinha);
 *   - em PRODUÇÃO: DESLIGADA a menos que `MOCK_PIX_AUTOCONFIRM=1` — pedido
 *     "pago" sem dinheiro entrar é o pior bug possível num ecommerce.
 *
 * A confirmação passa pelo MESMO caminho do webhook (`confirmPayment`) de
 * propósito: o purchase, a idempotência e o log são exercitados aqui do mesmo
 * jeito que serão com o gateway real.
 */

import { confirmPayment } from '@/lib/orders/confirm';
import { getOrderStore } from '@/lib/orders/store';
import type { Order, OrderStatus } from '@/types/checkout';
import { buildPixPayload } from './pix-emv';
import type { PaymentProvider, PixCharge } from './provider';

/** Validade do PIX — 30min é o padrão de mercado pra cobrança de ecommerce. */
const PIX_EXPIRES_MINUTES = 30;

function confirmSeconds(): number {
  const raw = Number(process.env.MOCK_PIX_CONFIRM_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 25;
}

function autoConfirmLigado(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.MOCK_PIX_AUTOCONFIRM === '1';
}

export class MockProvider implements PaymentProvider {
  readonly id = 'mock';

  async createPixCharge(order: Order): Promise<PixCharge> {
    // Txid do PIX: derivado do id do pedido (idempotente — recriar a cobrança
    // do mesmo pedido gera o mesmo txid). Limite de 25 alfanuméricos do EMV.
    const txid = order.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 25);

    const copyPaste = buildPixPayload({
      amount: order.total,
      txid,
      // key/nome/cidade vêm das envs (PIX_KEY etc.) com defaults de sandbox.
    });

    const expiresAt = new Date(Date.now() + PIX_EXPIRES_MINUTES * 60_000).toISOString();
    return { copyPaste, txid, expiresAt };
  }

  /**
   * O check que o poll do PixPanel dispara. Devolve o status já refletido no
   * pedido — quando a auto-confirmação bate, quem roda é o `confirmPayment`,
   * o mesmo do webhook.
   */
  async checkStatus(order: Order): Promise<OrderStatus> {
    if (order.status !== 'awaiting_payment') return order.status;

    const idadeMs = Date.now() - Date.parse(order.createdAt);
    if (autoConfirmLigado() && idadeMs > confirmSeconds() * 1000) {
      await confirmPayment(order.id);
      return 'paid';
    }

    // PIX venceu sem pagamento → expira. Com o gateway real esse papel é do
    // webhook de expiração; no mock somos nós.
    const expiresAt = order.payment.pix?.expiresAt;
    if (expiresAt && Date.now() > Date.parse(expiresAt)) {
      await getOrderStore().markExpired(order.id);
      return 'expired';
    }

    return 'awaiting_payment';
  }
}
