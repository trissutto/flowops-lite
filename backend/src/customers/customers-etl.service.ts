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
        customerCpf: true,
        shippingCep: true,
        shippingAddress: true, // JSON serializado do WC shipping
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
        cpf: string | null;
        shippingCep: string | null;
        shippingAddressJson: string | null; // do pedido MAIS RECENTE com endereço
        shippingAddressDate: Date | null;
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
          cpf: o.customerCpf?.replace(/\D/g, '') || null,
          shippingCep: o.shippingCep?.replace(/\D/g, '') || null,
          shippingAddressJson: o.shippingAddress || null,
          shippingAddressDate: date,
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
      if (!agg.cpf && o.customerCpf) agg.cpf = o.customerCpf.replace(/\D/g, '');
      // Endereço: usa o do pedido MAIS RECENTE com shipping preenchido
      if (o.shippingAddress && date >= (agg.shippingAddressDate || new Date(0))) {
        agg.shippingAddressJson = o.shippingAddress;
        agg.shippingCep = o.shippingCep?.replace(/\D/g, '') || agg.shippingCep;
        agg.shippingAddressDate = date;
      }
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
          select: { id: true, originStoreId: true, originSource: true, cpf: true },
        });

        // CAMINHO C: personKey prioriza CPF (chave forte); fallback email
        const cpfDigits = agg.cpf && agg.cpf.length === 11 ? agg.cpf : null;
        const cpfFmt = cpfDigits
          ? `${cpfDigits.slice(0, 3)}.${cpfDigits.slice(3, 6)}.${cpfDigits.slice(6, 9)}-${cpfDigits.slice(9)}`
          : null;
        const personKey = cpfDigits ? `cpf:${cpfDigits}` : `email:${email.toLowerCase()}`;

        let customerId: string;

        if (!existing) {
          // INSERIR — cliente vindo do site só
          const created = await this.prisma.customer.create({
            data: {
              email,
              cpf: cpfFmt,
              name: agg.name ?? email.split('@')[0],
              phone: phone ?? undefined,
              whatsapp: whatsapp ?? undefined,
              originSource: 'woo',
              originStoreId: siteStore.id,
              personKey,
              orderCount: agg.orderCount,
              ltvCents: BigInt(agg.totalCents),
              ticketMedioCents: ticketMedio,
              firstOrderAt: agg.firstOrder,
              lastOrderAt: agg.lastOrder,
              cashbackBalance: { create: {} },
            },
          });
          customerId = created.id;
          this.state.inserted += 1;
        } else {
          // ATUALIZAR — métricas + cpf se faltar
          await this.prisma.customer.update({
            where: { email },
            data: {
              // dados de contato só completam se estiverem vazios
              ...(agg.name ? { name: { set: agg.name } } : {}),
              ...(phone ? { phone: { set: phone } } : {}),
              ...(whatsapp ? { whatsapp: { set: whatsapp } } : {}),
              // CPF: só seta se Customer ainda não tem
              ...(cpfFmt && !existing.cpf ? { cpf: { set: cpfFmt } } : {}),
              personKey: { set: personKey },
              orderCount: agg.orderCount,
              ltvCents: BigInt(agg.totalCents),
              ticketMedioCents: ticketMedio,
              firstOrderAt: agg.firstOrder,
              lastOrderAt: agg.lastOrder,
            },
          });
          customerId = existing.id;
          this.state.updated += 1;
        }

        // Endereço de entrega — usa shippingAddress JSON do último pedido
        if (agg.shippingAddressJson) {
          await this._upsertEnderecoEntregaWc(customerId, agg.shippingAddressJson, agg.shippingCep);
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

  /**
   * Upsert CustomerAddress(type='entrega') a partir do JSON shippingAddress
   * salvo no Order do WC. Parseia o JSON, normaliza campos pro schema
   * CustomerAddress (cep, street, number, complement, district, city, state).
   */
  private async _upsertEnderecoEntregaWc(
    customerId: string,
    shippingJson: string,
    shippingCep: string | null,
  ): Promise<void> {
    try {
      const s = JSON.parse(shippingJson);
      if (!s || typeof s !== 'object') return;

      // address_1 do WC vem geralmente como "Rua X, 123" — separa rua/numero
      const addr1 = String(s.address_1 || '').trim();
      let street = addr1;
      let number: string | null = null;
      const mNum = addr1.match(/^(.+?),\s*(\d+\w*)$/);
      if (mNum) {
        street = mNum[1].trim();
        number = mNum[2];
      }

      const cep = String(shippingCep || s.postcode || '').replace(/\D/g, '');
      const data = {
        customerId,
        type: 'entrega',
        isPrimary: true,
        active: true,
        cep: cep.length === 8 ? cep : null,
        street: street || null,
        number,
        complement: String(s.address_2 || '').trim() || null,
        district: String(s.neighborhood || s.bairro || '').trim() || null,
        city: String(s.city || '').trim() || null,
        state: String(s.state || '').trim().toUpperCase().slice(0, 2) || null,
      };

      // Procura endereço entrega existente
      const existing = await this.prisma.customerAddress.findFirst({
        where: { customerId, type: 'entrega' },
      });
      if (existing) {
        await this.prisma.customerAddress.update({
          where: { id: existing.id },
          data: {
            cep: data.cep,
            street: data.street,
            number: data.number,
            complement: data.complement,
            district: data.district,
            city: data.city,
            state: data.state,
          },
        });
      } else {
        await this.prisma.customerAddress.create({ data });
      }
    } catch (e: any) {
      this.logger.error(
        `[ETL/woo] criar endereço entrega falhou customer=${customerId}: ${e?.code || ''} ${e?.message}`,
      );
    }
  }
}
