import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';

/**
 * CustomersService
 *
 * Não temos tabela Customer física — clientes são derivados dos pedidos.
 * Agregamos por email (case-insensitive) e retornamos:
 *   - nome, telefone mais recentes disponíveis
 *   - quantidade de pedidos
 *   - valor total gasto (soma)
 *   - ticket médio
 *   - data do primeiro e último pedido
 *
 * Excluímos pedidos cancelados/falhados da soma de receita.
 */
export interface CustomerRow {
  email: string;
  name: string | null;
  phone: string | null;
  orderCount: number;
  totalSpent: number;
  avgTicket: number;
  firstOrder: Date;
  lastOrder: Date;
}

export interface CustomersQuery {
  search?: string;
  orderBy?: 'totalSpent' | 'orderCount' | 'avgTicket' | 'lastOrder' | 'name';
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface CustomersResult {
  data: CustomerRow[];
  total: number;
  page: number;
  limit: number;
  stats: {
    totalCustomers: number;
    totalRevenue: number;
    overallAvgTicket: number;
  };
}

export interface SyncState {
  running: boolean;
  page: number;
  totalPages: number;
  imported: number;
  errors: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
}

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  // Estado singleton da sincronização de histórico WC
  private syncState: SyncState = {
    running: false,
    page: 0,
    totalPages: 0,
    imported: 0,
    errors: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly wc: WooCommerceService,
  ) {}

  async list(query: CustomersQuery = {}): Promise<CustomersResult> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const orderBy = query.orderBy ?? 'totalSpent';
    const order = query.order ?? 'desc';

    // 1) Puxa SOMENTE pedidos CONCLUÍDOS (delivered = completed do WC).
    //    Cliente só conta se efetivamente comprou e recebeu.
    //    Ordena desc por data pra pegar o nome/telefone mais recente quando agrupar.
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
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // 2) Agrupa por email normalizado (lowercase + trim)
    const byEmail = new Map<string, CustomerRow>();

    for (const o of orders) {
      if (!o.customerEmail) continue;
      const email = o.customerEmail.toLowerCase().trim();
      if (!email) continue;

      let c = byEmail.get(email);
      if (!c) {
        c = {
          email,
          name: o.customerName?.trim() || null,
          phone: o.customerPhone?.trim() || null,
          orderCount: 0,
          totalSpent: 0,
          avgTicket: 0,
          firstOrder: o.createdAt,
          lastOrder: o.createdAt,
        };
        byEmail.set(email, c);
      }

      c.orderCount += 1;
      c.totalSpent += Number(o.totalAmount ?? 0);

      if (o.createdAt > c.lastOrder) c.lastOrder = o.createdAt;
      if (o.createdAt < c.firstOrder) c.firstOrder = o.createdAt;

      // Nome/telefone: já que orders estão em ordem desc, o primeiro registro
      // que cai aqui (quando não tinha) é o mais recente. Mantém se não estiver vazio.
      if (!c.name && o.customerName?.trim()) c.name = o.customerName.trim();
      if (!c.phone && o.customerPhone?.trim()) c.phone = o.customerPhone.trim();
    }

    // 3) Calcula ticket médio e converte em array
    let customers: CustomerRow[] = Array.from(byEmail.values()).map((c) => ({
      ...c,
      avgTicket: c.orderCount > 0 ? c.totalSpent / c.orderCount : 0,
    }));

    // 4) Stats globais (antes da busca/paginação)
    const totalCustomers = customers.length;
    const totalRevenue = customers.reduce((s, c) => s + c.totalSpent, 0);
    const totalOrderCount = customers.reduce((s, c) => s + c.orderCount, 0);
    const overallAvgTicket = totalOrderCount > 0 ? totalRevenue / totalOrderCount : 0;

    // 5) Busca (em memória, suficiente pra <10k clientes)
    if (query.search && query.search.trim()) {
      const q = query.search.toLowerCase().trim();
      customers = customers.filter(
        (c) =>
          c.email.includes(q) ||
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.phone && c.phone.includes(q)),
      );
    }

    // 6) Ordenação
    const dir = order === 'asc' ? 1 : -1;
    customers.sort((a, b) => {
      let av: any;
      let bv: any;
      switch (orderBy) {
        case 'orderCount':
          av = a.orderCount;
          bv = b.orderCount;
          break;
        case 'avgTicket':
          av = a.avgTicket;
          bv = b.avgTicket;
          break;
        case 'lastOrder':
          av = a.lastOrder.getTime();
          bv = b.lastOrder.getTime();
          break;
        case 'name':
          av = (a.name ?? a.email).toLowerCase();
          bv = (b.name ?? b.email).toLowerCase();
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        case 'totalSpent':
        default:
          av = a.totalSpent;
          bv = b.totalSpent;
      }
      return (av - bv) * dir;
    });

    // 7) Paginação
    const total = customers.length;
    const start = (page - 1) * limit;
    const data = customers.slice(start, start + limit);

    return {
      data,
      total,
      page,
      limit,
      stats: {
        totalCustomers,
        totalRevenue,
        overallAvgTicket,
      },
    };
  }

  /**
   * Detalhe do cliente: lista completa dos pedidos dele.
   */
  async getByEmail(email: string) {
    const normalized = email.toLowerCase().trim();

    const orders = await this.prisma.order.findMany({
      where: {
        customerEmail: { not: null },
        status: 'delivered',
      },
      select: {
        id: true,
        wcOrderId: true,
        wcOrderNumber: true,
        status: true,
        totalAmount: true,
        customerName: true,
        customerEmail: true,
        customerPhone: true,
        shippingCep: true,
        createdAt: true,
        wcDateCreated: true,
        items: { select: { sku: true, productName: true, quantity: true, unitPrice: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const filtered = orders.filter((o) => o.customerEmail?.toLowerCase().trim() === normalized);

    if (filtered.length === 0) {
      return null;
    }

    const totalSpent = filtered.reduce((s, o) => s + Number(o.totalAmount ?? 0), 0);
    const orderCount = filtered.length;

    return {
      email: normalized,
      name: filtered.find((o) => o.customerName)?.customerName ?? null,
      phone: filtered.find((o) => o.customerPhone)?.customerPhone ?? null,
      orderCount,
      totalSpent,
      avgTicket: orderCount > 0 ? totalSpent / orderCount : 0,
      firstOrder: filtered[filtered.length - 1].createdAt,
      lastOrder: filtered[0].createdAt,
      orders: filtered,
    };
  }

  // =========================================================================
  // SYNC COMPLETO DO HISTÓRICO WOOCOMMERCE
  // =========================================================================
  // Pagina TODOS os pedidos do WC e faz upsert na base local.
  // Necessário pra ter TODOS os clientes históricos (não só os do polling recente).
  // Roda em background — controller retorna 202 e frontend faz polling do status.
  // =========================================================================

  getSyncState(): SyncState {
    return { ...this.syncState };
  }

  /**
   * Dispara sync em background. Retorna true se iniciou, false se já está rodando.
   */
  startSync(): boolean {
    if (this.syncState.running) return false;

    this.syncState = {
      running: true,
      page: 0,
      totalPages: 0,
      imported: 0,
      errors: 0,
      startedAt: new Date(),
      finishedAt: null,
      lastError: null,
    };

    // Fire-and-forget — roda em background, não bloqueia o request
    this.runSync().catch((e) => {
      this.logger.error(`[SYNC] falha fatal: ${e.message}`);
      this.syncState.running = false;
      this.syncState.finishedAt = new Date();
      this.syncState.lastError = e.message;
    });

    return true;
  }

  private async runSync() {
    const PER_PAGE = 100;
    let page = 1;

    this.logger.log('[SYNC] Iniciando sync — somente pedidos CONCLUÍDOS (completed)…');

    // Só importa status = completed. Cliente só conta se efetivamente comprou.
    // Pending, processing, cancelled, failed, refunded NÃO entram.
    while (true) {
      try {
        this.syncState.page = page;

        const res = await this.wc.listOrders({
          page,
          perPage: PER_PAGE,
          status: 'completed',
        });

        if (page === 1) {
          this.syncState.totalPages = res.totalPages;
          this.logger.log(`[SYNC] Total: ${res.total} pedidos em ${res.totalPages} páginas.`);
        }

        if (!res.data || res.data.length === 0) {
          this.logger.log(`[SYNC] Página ${page} vazia — finalizando.`);
          break;
        }

        // Importa sequencialmente pra não estourar rate-limit do WC nem do banco SQLite
        for (const wcOrder of res.data) {
          try {
            await this.orders.upsertFromWooCommerce(wcOrder);
            this.syncState.imported += 1;
          } catch (e: any) {
            this.syncState.errors += 1;
            this.logger.warn(`[SYNC] erro no pedido #${wcOrder.id}: ${e.message}`);
          }
        }

        this.logger.log(
          `[SYNC] Página ${page}/${res.totalPages} importada — total ok: ${this.syncState.imported}, erros: ${this.syncState.errors}`,
        );

        // Última página?
        if (page >= res.totalPages) break;

        page += 1;

        // respiro pra não martelar o WC (400ms entre páginas)
        await new Promise((r) => setTimeout(r, 400));
      } catch (e: any) {
        this.syncState.errors += 1;
        this.syncState.lastError = e.message;
        this.logger.error(`[SYNC] erro na página ${page}: ${e.message}`);
        // Retry simples: 3s e tenta de novo a mesma página, máx 2 vezes
        // (depois pula pra próxima pra não travar)
        await new Promise((r) => setTimeout(r, 3000));
        page += 1;
        if (page > (this.syncState.totalPages || 1) * 2) break;
      }
    }

    this.syncState.running = false;
    this.syncState.finishedAt = new Date();
    this.logger.log(
      `[SYNC] Concluído — ${this.syncState.imported} importados, ${this.syncState.errors} erros.`,
    );
  }
}
