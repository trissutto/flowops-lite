import 'server-only';

/**
 * PROVIDER DE PAGAMENTO — a fronteira entre o pedido e o gateway.
 *
 * O checkout não sabe quem cobra: pede uma cobrança PIX e recebe copia-e-cola,
 * txid e validade. Trocar de gateway (ou ligar o real) é implementar esta
 * interface e mudar a env `PAYMENT_PROVIDER` — nenhuma rota muda.
 *
 * Providers:
 *   'mock'    (default) — payload EMV real com chave de sandbox + auto-confirm
 *              em dev. Demonstra o fluxo inteiro sem mover um centavo.
 *   'pagbank' — esqueleto. Ver o aviso GRANDE em `PagBankProvider` antes de
 *              pensar em ligar.
 */

import type { Order, OrderStatus } from '@/types/checkout';
// Import de valor só do mock (o PagBank é esqueleto local). O mock importa
// deste arquivo apenas TIPOS — import type é apagado na compilação, então não
// há ciclo em runtime.
import { MockProvider } from './mock';

export interface PixCharge {
  /** Payload EMV completo — o que a cliente copia pro app do banco. */
  copyPaste: string;
  txid: string;
  /** ISO — depois disso o pedido expira sem pagamento. */
  expiresAt: string;
}

export interface PaymentProvider {
  /** Nome curto pra log — nunca exibido pra cliente. */
  readonly id: string;
  createPixCharge(order: Order): Promise<PixCharge>;
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
  const escolhido = process.env.PAYMENT_PROVIDER ?? 'mock';

  if (escolhido === 'pagbank') return new PagBankProvider();

  return new MockProvider();
}
