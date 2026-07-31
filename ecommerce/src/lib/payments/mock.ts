import 'server-only';

/**
 * MOCK PROVIDER — FERRAMENTA DE DESENVOLVIMENTO (fora do caminho de produção).
 *
 * ⚠️ Sprint 011: quem cria a cobrança de verdade é o BACKEND FlowOps. Nenhuma
 * rota chama este provider no fluxo real — ver o cabeçalho de `provider.ts`.
 *
 * O que ele ainda serve: gerar um PIX de mentira SEM backend rodando, pra
 * mexer na UI do PixPanel (QR, copia-e-cola, contagem regressiva) sem depender
 * de ninguém. O payload EMV é REAL (pix-emv) com a chave de sandbox: o app do
 * banco lê o QR, mostra "LURDS PLUS SIZE" e o valor — só não encontra
 * destinatário, porque a chave não existe no DICT.
 *
 * A AUTO-CONFIRMAÇÃO FOI REMOVIDA. Ela dependia de marcar o pedido como pago
 * no store local, e store local não existe mais: o status do pedido é do
 * Postgres do Flow, e um "pago" inventado por este arquivo seria uma mentira
 * que nem o backend nem o CRM iriam conhecer. Pra testar o caminho de pago
 * hoje, o gatilho certo é o backend (ou um POST no webhook com o segredo).
 */

import type { Order } from '@/types/checkout';
import { buildPixPayload } from './pix-emv';
import type { PaymentProvider, PixCharge } from './provider';

/** Validade do PIX — 30min é o padrão de mercado pra cobrança de ecommerce. */
const PIX_EXPIRES_MINUTES = 30;

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
}
