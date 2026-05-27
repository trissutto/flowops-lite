import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CustomersEtlService — popula a tabela `customers` (mestre CRM) a partir das
 * fontes externas (WooCommerce, Giga, etc).
 *
 * Regras de atribuição de loja (acordadas com CEO em 2026-05):
 *  • Cliente que comprou SÓ no site → loja SITE (code 13)
 *  • Cliente que já existe vinculado a OUTRA loja (ex: Giga em Itanhaém) →
 *    NÃO sobrescreve. Primeira loja a cadastrar ganha (regra "Giga prevalece").
 *  • Métricas (orderCount, LTV, lastOrderAt) são SEMPRE recalculadas com base
 *    em todos os Orders do email — independente da loja.
 *
 * Performance: roda fire-and-forget (igual ao sync do WooCommerce em
 * customers.service.ts) e expõe estado via getState().
 */

const SITE_STORE_CODE = '13';   // loja "SITE" no Giga / Store table

export interface EtlState {
  running: boolean;
  source: 'woo' | 'giga' | null;
  totalEmails: number;
  processed: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
}

@Injectable()
export class CustomersEtlService {
  private readonly logger = new Logger(CustomersEtlService.name);

  private state: EtlState = {
    running: false,
    source: null,
    totalEmails: 0,
    processed: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null,
  };

  constructor(private readonly prisma: PrismaService) {}

  getState(): EtlState {
    return { ...this.state };
  }

  /** Dispara em background. Retorna true se iniciou, false se já rodando. */
  startWooSync(): boolean {
    if (this.state.running) return false;
    this.resetState('woo');
    this.runWooSync().catch((e) => {
      this.logger.error(`[ETL/woo] falha fatal: ${e.message}`);
      this.state.running = false;
      this.state.finishedAt = new Date();
      this.state.lastError = e.message;
    });
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────
  private resetState(source: 'woo' | 'giga') {
    this.state = {
      running: true,
      source,
      totalEmails: 0,
      processed: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      startedAt: new Date(),
      finishedAt: null,
      lastError: null,
    };
  }

  private normPhone(p: string | null | undefined): string | null {
    if (!p) return null;
    let d = p.replace(/\D/g, '');
    if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    if (d.length !== 10 && d.length !== 11) return null;
    return `+55${d}`;
  }

  /** WhatsApp = telefone se for celular (11 dígitos). Senão null. */
  private maybeWhatsapp(phone: string | null): string | null {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    // +55 11 9XXXX-XXXX → 13 dígitos depois do +. Sem DDI: 11 dígitos. Celular começa com 9.
    if (digits.length === 13 && digits.startsWith('55')) {
      const local = digits.slice(2);
      if (local.length === 11 && local[2] === '9') return phone;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SYNC WOOCOMMERCE → customers
  // ─────────────────────────────────────────────────────────────────────────
  private async runWooSync() {
    this.logger.log('[ETL/woo] iniciando sync clientes WC → customers...');

    // 1) Pega a loja SITE
    const siteStore = await this.prisma.store.findUnique({
      where: { code: SITE_STORE_CODE },
      select: { id: true, name: true },
    });
    if (!siteStore) {
      throw new Error(`Loja SITE (code=${SITE_STORE_CODE}) não encontrada. Crie antes.`);
    }
    this.logger.log(`[ETL/woo] loja SITE = ${siteStore.id} (${siteStore.name})`);

    // 2) Puxa SOMENTE pedidos CONCLUÍDOS — fonte de clientes "reais"
    const orders = await this.prisma.order.findMany({
      where: {
        customerEmail: { not: null },
        status: 'delivered',
      },
      select: {
        customerEmail: true,
        customerName: true,
        customerPhone: true,
        totalAmount: true,
        wcDateCreated: true,
        createdAt: true,
      },
    });

    // 3) Agrega por email
    const byEmail = new Map<
      string,
      {
        email: string;
        name: string | null;
        phone: string | null;
        orderCount: number;
        totalCents: number;
        firstOrder: Date;
        lastOrder: Date;
      }
    >();

    for (const o of orders) {
      if (!o.customerEmail) continue;
      const email = o.customerEmail.toLowerCase().trim();
      if (!email) continue;
      const date = o.wcDateCreated ?? o.createdAt;
      const cents = Math.round(Number(o.totalAmount ?? 0) * 100);

      let agg = byEmail.get(email);
      if (!agg) {
        agg = {
          email,
          name: o.customerName?.trim() || null,
          phone: o.customerPhone?.trim() || null,
          orderCount: 0,
          totalCents: 0,
          firstOrder: date,
          lastOrder: date,
        };
        byEmail.set(email, agg);
      }
      agg.orderCount += 1;
      agg.totalCents += cents;
      if (date > agg.lastOrder) agg.lastOrder = date;
      if (date < agg.firstOrder) agg.firstOrder = date;
      if (!agg.name && o.customerName?.trim()) agg.name = o.customerName.trim();
      if (!agg.phone && o.customerPhone?.trim()) agg.phone = o.customerPhone.trim();
    }

    this.state.totalEmails = byEmail.size;
    this.logger.log(`[ETL/woo] ${byEmail.size} e-mails únicos pra processar`);

    // 4) Upsert por email — preserva originStoreId existente
    for (const [email, agg] of byEmail) {
      try {
        const phone = this.normPhone(agg.phone);
        const whatsapp = this.maybeWhatsapp(phone);
        const ticketMedio = agg.orderCount > 0 ? Math.round(agg.totalCents / agg.orderCount) : 0;

        const existing = await this.prisma.customer.findUnique({
          where: { email },
          select: { id: true, originStoreId: true, originSource: true },
        });

        if (!existing) {
          // INSERIR — cliente vindo do site só (sem registro Giga)
          await this.prisma.customer.create({
            data: {
              email,
              name: agg.name ?? email.split('@')[0],
              phone: phone ?? undefined,
              whatsapp: whatsapp ?? undefined,
              originSource: 'woo',
              originStoreId: siteStore.id,
              orderCount: agg.orderCount,
              ltvCents: BigInt(agg.totalCents),
              ticketMedioCents: ticketMedio,
              firstOrderAt: agg.firstOrder,
              lastOrderAt: agg.lastOrder,
              cashbackBalance: { create: {} },
            },
          });
          this.state.inserted += 1;
        } else {
          // ATUALIZAR — só métricas. NUNCA mexe em originStoreId (regra "primeira loja ganha")
          await this.prisma.customer.update({
            where: { email },
            data: {
              // dados de contato só completam se estiverem vazios
              ...(agg.name ? { name: { set: agg.name } } : {}),
              ...(phone ? { phone: { set: phone } } : {}),
              ...(whatsapp ? { whatsapp: { set: whatsapp } } : {}),
              // métricas sempre recalculadas
              orderCount: agg.orderCount,
              ltvCents: BigInt(agg.totalCents),
              ticketMedioCents: ticketMedio,
              firstOrderAt: agg.firstOrder,
              lastOrderAt: agg.lastOrder,
            },
          });
          this.state.updated += 1;
        }

        this.state.processed += 1;

        // Log a cada 500
        if (this.state.processed % 500 === 0) {
          this.logger.log(
            `[ETL/woo] ${this.state.processed}/${this.state.totalEmails} ` +
            `(in=${this.state.inserted} upd=${this.state.updated} err=${this.state.errors})`,
          );
        }
      } catch (e: any) {
        this.state.errors += 1;
        this.state.lastError = `${email}: ${e.message}`;
        this.logger.warn(`[ETL/woo] erro em ${email}: ${e.message}`);
      }
    }

    this.state.running = false;
    this.state.finishedAt = new Date();
    this.logger.log(
      `[ETL/woo] FIM: ${this.state.inserted} inseridos, ` +
      `${this.state.updated} atualizados, ${this.state.errors} erros.`,
    );
  }
}
