import 'server-only';

/**
 * PROVIDER DE PAGAMENTO — a fronteira entre o pedido e o gateway.
 *
 * O checkout não sabe quem cobra: pede uma cobrança PIX e recebe copia-e-cola,
 * txid e validade. Trocar de gateway (ou ligar o real) é implementar esta
 * interface e mudar a env `PAYMENT_PROVIDER` — nenhuma rota muda.
 *
 * Providers:
 *   'pagarme' — o gateway REAL (decisão do dono 31/07: mesma estrutura do
 *              WordPress atual, checkout transparente). Liga sozinho quando
 *              `PAGARME_SECRET_KEY` existe.
 *   'mock'    — payload EMV real com chave de sandbox + auto-confirm em dev.
 *              Demonstra o fluxo inteiro sem mover um centavo.
 *   'pagbank' — esqueleto. Ver o aviso GRANDE em `PagBankProvider` antes de
 *              pensar em ligar.
 */

import type { Order, OrderStatus } from '@/types/checkout';
// Imports de valor só dos providers locais. Mock e Pagar.me importam deste
// arquivo apenas TIPOS — import type é apagado na compilação, sem ciclo.
import { MockProvider } from './mock';
import { isPagarmeConfigured, PagarmeProvider } from './pagarme';

export interface PixCharge {
  /** Payload EMV completo — o que a cliente copia pro app do banco. */
  copyPaste: string;
  txid: string;
  /** ISO — depois disso o pedido expira sem pagamento. */
  expiresAt: string;
  /** Id da order NO GATEWAY — é a chave do checkStatus e da conciliação. */
  gatewayOrderId?: string;
}

/** Cartão responde na hora: pago ou recusado (recusa é fluxo, não exceção). */
export interface CardChargeResult {
  status: 'paid' | 'refused';
  gatewayOrderId: string;
  /** Mensagem ELEGANTE pra UI quando recusado. */
  reason?: string;
}

export interface PaymentProvider {
  /** Nome curto pra log — nunca exibido pra cliente. */
  readonly id: string;
  createPixCharge(order: Order): Promise<PixCharge>;
  /** Cobrança de cartão com token (transparente). Ausente = método desligado. */
  createCardCharge?(order: Order, cardToken: string, installments: number): Promise<CardChargeResult>;
  /**
   * Consulta o status no gateway (opcional — gateway com webhook confiável
   * pode viver sem poll). Deve devolver o status JÁ refletido no pedido:
   * se o provider confirmar pagamento, ele mesmo chama `confirmPayment`.
   */
  checkStatus?(order: Order): Promise<OrderStatus>;
}

/**
 * ⚠️ PAGBANK — NÃO LIGAR SEM DECISÃO DO DONO.
 *
 * A conta PagBank da casa tem token ÚNICO de API, COMPARTILHADO com outro
 * sistema (Reservas Ita divide a mesma conta — ver memória do projeto
 * "PagBank: token único por conta"). Gerar um token novo pra este ecommerce
 * REVOGA o anterior e quebra o outro sistema EM SILÊNCIO. Ligar este provider
 * exige: (1) decisão do Thiago sobre qual conta/token usar, (2) conferir quem
 * mais usa o token atual. Até lá, o esqueleto lança erro claro em vez de
 * fingir que funciona.
 */
class PagBankProvider implements PaymentProvider {
  readonly id = 'pagbank';

  async createPixCharge(): Promise<PixCharge> {
    throw new Error(
      'PagBank não configurado — a conta tem token único compartilhado com outro sistema; ligar exige decisão do dono (ver docs/payments.md).',
    );
  }
}

export function getPaymentProvider(): PaymentProvider {
  // Sem PAYMENT_PROVIDER explícita, a presença da chave decide: configurou a
  // Pagar.me → ela assume. `PAYMENT_PROVIDER=mock` força o mock mesmo com
  // chave (útil pra testar o fluxo sem cobrar ninguém).
  const escolhido = process.env.PAYMENT_PROVIDER ?? (isPagarmeConfigured() ? 'pagarme' : 'mock');

  if (escolhido === 'pagarme') {
    if (!isPagarmeConfigured()) {
      throw new Error('PAYMENT_PROVIDER=pagarme exige a env PAGARME_SECRET_KEY (sk_test_* ou sk_*).');
    }
    return new PagarmeProvider();
  }
  if (escolhido === 'pagbank') return new PagBankProvider();

  return new MockProvider();
}
