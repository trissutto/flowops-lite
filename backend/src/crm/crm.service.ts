import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CrmService — Segmentação RFM (Recência/Frequência/Valor).
 *
 * Reaproveita a mesma agregação do CustomersService (por email, status=delivered).
 * Classifica cada cliente em UM ÚNICO tier por ordem de prioridade:
 *
 *   VIP       → alto valor, comprou recente  (top 20% em totalSpent OU >= R$ 1500) E daysSinceLast <= 60
 *   EM_RISCO  → comprador recorrente parado há 60–180 dias (orderCount >= 2 E totalSpent >= R$ 500)
 *   NOVOS     → 1 pedido nos últimos 30 dias (foco: puxar 2ª compra)
 *   INATIVOS  → 2+ pedidos mas sem comprar há > 180 dias
 *   ONE_SHOT  → comprou 1x há mais de 30 dias (base pra lookalike Meta)
 *   REGULARES → resto (comprador ativo não-VIP) — fallback
 *
 * Observação: thresholds de valor são calculados em cima do percentil 80
 * da base real de clientes (mínimo R$ 1500 pra VIP, R$ 500 pra em risco).
 */

export type SegmentKey =
  | 'vip'
  | 'em_risco'
  | 'novos'
  | 'inativos'
  | 'one_shot'
  | 'regulares';

export interface SegmentedCustomer {
  email: string;
  name: string | null;
  phone: string | null;
  orderCount: number;
  totalSpent: number;
  avgTicket: number;
  firstOrder: Date;
  lastOrder: Date;
  daysSinceFirst: number;
  daysSinceLast: number;
  segment: SegmentKey;
}

interface SegmentInfo {
  key: SegmentKey;
  label: string;
  description: string;
  action: string; // ação de marketing sugerida
  count: number;
  totalValue: number; // soma do totalSpent dos clientes do segmento
}

interface ComputedThresholds {
  p80TotalSpent: number;
  vipMinSpent: number;
  riskMinSpent: number;
  totalCustomers: number;
}

@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Classifica todos os clientes e retorna agregados + lista completa em memória.
   * Com 14k clientes roda em <2s. Se a base crescer muito, virar cache.
   */
  private async computeAll(): Promise<{
    customers: SegmentedCustomer[];
    thresholds: ComputedThresholds;
  }> {
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

    // Agrega por email normalizado
    const map = new Map<
      string,
      {
        email: string;
        name: string | null;
        phone: string | null;
        orderCount: number;
        totalSpent: number;
        firstOrder: Date;
        lastOrder: Date;
      }
    >();

    for (const o of orders) {
      if (!o.customerEmail) continue;
      const email = o.customerEmail.toLowerCase().trim();
      if (!email) continue;

      let c = map.get(email);
      if (!c) {
        c = {
          email,
          name: o.customerName?.trim() || null,
          phone: o.customerPhone?.trim() || null,
          orderCount: 0,
          totalSpent: 0,
          firstOrder: o.createdAt,
          lastOrder: o.createdAt,
        };
        map.set(email, c);
      }
      c.orderCount += 1;
      c.totalSpent += Number(o.totalAmount ?? 0);
      if (o.createdAt > c.lastOrder) c.lastOrder = o.createdAt;
      if (o.createdAt < c.firstOrder) c.firstOrder = o.createdAt;
      if (!c.name && o.customerName?.trim()) c.name = o.customerName.trim();
      if (!c.phone && o.customerPhone?.trim()) c.phone = o.customerPhone.trim();
    }

    const base = Array.from(map.values());

    // Calcula percentil 80 do totalSpent (corte VIP dinâmico)
    const spents = base.map((c) => c.totalSpent).sort((a, b) => a - b);
    const p80Idx = Math.max(0, Math.floor(spents.length * 0.8) - 1);
    const p80TotalSpent = spents[p80Idx] ?? 0;

    // Piso: VIP precisa gastar no mínimo R$ 1500 ou estar no top 20%, o que for maior
    const vipMinSpent = Math.max(1500, p80TotalSpent);
    const riskMinSpent = 500;

    const now = Date.now();
    const DAY = 1000 * 60 * 60 * 24;

    const customers: SegmentedCustomer[] = base.map((c) => {
      const daysSinceLast = Math.floor((now - c.lastOrder.getTime()) / DAY);
      const daysSinceFirst = Math.floor((now - c.firstOrder.getTime()) / DAY);
      const avgTicket = c.orderCount > 0 ? c.totalSpent / c.orderCount : 0;

      // Classificação EXCLUSIVA por ordem de prioridade
      let segment: SegmentKey;

      if (c.totalSpent >= vipMinSpent && daysSinceLast <= 60) {
        segment = 'vip';
      } else if (
        c.orderCount >= 2 &&
        c.totalSpent >= riskMinSpent &&
        daysSinceLast > 60 &&
        daysSinceLast <= 180
      ) {
        segment = 'em_risco';
      } else if (c.orderCount === 1 && daysSinceFirst <= 30) {
        segment = 'novos';
      } else if (c.orderCount >= 2 && daysSinceLast > 180) {
        segment = 'inativos';
      } else if (c.orderCount === 1 && daysSinceFirst > 30) {
        segment = 'one_shot';
      } else {
        segment = 'regulares';
      }

      return {
        email: c.email,
        name: c.name,
        phone: c.phone,
        orderCount: c.orderCount,
        totalSpent: c.totalSpent,
        avgTicket,
        firstOrder: c.firstOrder,
        lastOrder: c.lastOrder,
        daysSinceFirst,
        daysSinceLast,
        segment,
      };
    });

    return {
      customers,
      thresholds: {
        p80TotalSpent,
        vipMinSpent,
        riskMinSpent,
        totalCustomers: customers.length,
      },
    };
  }

  /**
   * Contadores + valor agregado por segmento (resumo da tela).
   */
  async getSegmentsSummary(): Promise<{
    segments: SegmentInfo[];
    thresholds: ComputedThresholds;
    generatedAt: Date;
  }> {
    const { customers, thresholds } = await this.computeAll();

    const info: Record<SegmentKey, SegmentInfo> = {
      vip: {
        key: 'vip',
        label: 'VIPs',
        description: `Alto valor (≥ R$ ${thresholds.vipMinSpent.toFixed(0)}) e comprou nos últimos 60 dias`,
        action: 'Campanha exclusiva de lançamento, pré-venda, acesso antecipado',
        count: 0,
        totalValue: 0,
      },
      em_risco: {
        key: 'em_risco',
        label: 'Em Risco',
        description: 'Comprador recorrente (2+ pedidos) parado há 60–180 dias',
        action: 'WhatsApp com cupom forte (15–20%) + linha exclusiva',
        count: 0,
        totalValue: 0,
      },
      novos: {
        key: 'novos',
        label: 'Novos',
        description: '1 pedido nos últimos 30 dias — janela crítica pra 2ª compra',
        action: 'Nurture: WhatsApp agradecimento + cupom 10% na 2ª compra',
        count: 0,
        totalValue: 0,
      },
      inativos: {
        key: 'inativos',
        label: 'Inativos',
        description: '2+ pedidos mas sem comprar há mais de 180 dias',
        action: 'Reativação agressiva: cupom 20% + frete grátis',
        count: 0,
        totalValue: 0,
      },
      one_shot: {
        key: 'one_shot',
        label: 'One-Shot',
        description: 'Comprou só 1 vez, há mais de 30 dias',
        action: 'Base pra lookalike no Meta Ads + reativação suave',
        count: 0,
        totalValue: 0,
      },
      regulares: {
        key: 'regulares',
        label: 'Regulares',
        description: 'Comprador ativo que não se encaixou nos demais grupos',
        action: 'Manter engajamento — campanhas sazonais',
        count: 0,
        totalValue: 0,
      },
    };

    for (const c of customers) {
      info[c.segment].count += 1;
      info[c.segment].totalValue += c.totalSpent;
    }

    return {
      segments: [
        info.vip,
        info.em_risco,
        info.novos,
        info.inativos,
        info.one_shot,
        info.regulares,
      ],
      thresholds,
      generatedAt: new Date(),
    };
  }

  /**
   * Lista clientes de um segmento específico (com busca e ordenação).
   */
  async listBySegment(
    segment: SegmentKey,
    opts: {
      search?: string;
      orderBy?: 'totalSpent' | 'orderCount' | 'lastOrder' | 'name';
      order?: 'asc' | 'desc';
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{
    data: SegmentedCustomer[];
    total: number;
    page: number;
    limit: number;
    segment: SegmentKey;
  }> {
    const { customers } = await this.computeAll();

    let list = customers.filter((c) => c.segment === segment);

    if (opts.search && opts.search.trim()) {
      const q = opts.search.toLowerCase().trim();
      list = list.filter(
        (c) =>
          c.email.includes(q) ||
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.phone && c.phone.includes(q)),
      );
    }

    const orderBy = opts.orderBy ?? 'totalSpent';
    const order = opts.order ?? 'desc';
    const dir = order === 'asc' ? 1 : -1;

    list.sort((a, b) => {
      switch (orderBy) {
        case 'orderCount':
          return (a.orderCount - b.orderCount) * dir;
        case 'lastOrder':
          return (a.lastOrder.getTime() - b.lastOrder.getTime()) * dir;
        case 'name': {
          const av = (a.name ?? a.email).toLowerCase();
          const bv = (b.name ?? b.email).toLowerCase();
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        }
        case 'totalSpent':
        default:
          return (a.totalSpent - b.totalSpent) * dir;
      }
    });

    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100000, Math.max(1, opts.limit ?? 50));
    const total = list.length;
    const start = (page - 1) * limit;
    const data = list.slice(start, start + limit);

    return { data, total, page, limit, segment };
  }
}
