import 'server-only';

/**
 * PROVIDER DE PAGAMENTO — FERRAMENTA DE DESENVOLVIMENTO/TESTE.
 *
 * ⚠️ ESTE MÓDULO SAIU DO CAMINHO DE PRODUÇÃO NA SPRINT 011.
 *
 * Quem cobra de verdade é o BACKEND FlowOps: o pedido nasce em
 * `POST /public/loja/pedido`, a cobrança na Pagar.me é criada lá (com a conta
 * já configurada no `PagarmeService`) e o webhook do gateway chega lá. Nenhuma
 * rota do ecommerce chama `getPaymentProvider()` no fluxo real — ver
 * `src/lib/orders/store.ts` e `docs/payments.md`.
 *
 * Por que continua no repositório em vez de virar `git rm`:
 *   - `pix-emv.ts` (e o teste dele) gera payload EMV BR Code correto e é
 *     conhecimento útil que ninguém quer reescrever — conferir um copia-e-cola
 *     de produção, montar um QR de teste, depurar valor/CRC;
 *   - o `MockProvider` deixa qualquer pessoa gerar um PIX de mentira sem
 *     backend rodando, o que é ouro pra mexer na UI do PixPanel;
 *   - a interface documenta a fronteira caso um dia o ecommerce volte a cobrar
 *     sozinho (não é o plano — dois sistemas cobrando na mesma conta é a
 *     receita de confusão que esta sprint eliminou).
 *
 * REGRA: nada em `src/app/api/**` deve importar daqui. Se importar, o pedido
 * voltou a ter dois donos.
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
   * Consulta o status no gateway (opcional). Ninguém implementa hoje: o
   * status do pedido é do backend, e o poll do PixPanel pergunta a ELE.
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
