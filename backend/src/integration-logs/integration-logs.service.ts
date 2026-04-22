import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ListIntegrationLogsFilters {
  source?: string;
  event?: string;
  eventPrefix?: string;
  status?: 'success' | 'failed' | 'all';
  storeCode?: string;
  from?: string; // ISO date
  to?: string;   // ISO date
  q?: string;    // substring em payload/error
  limit?: number;
  offset?: number;
}

export interface IntegrationLogRow {
  id: number;
  source: string;
  direction: string;
  event: string;
  status: number | null;
  error: string | null;
  createdAt: Date;
  // campos derivados do payload JSON (quando aplicável a baixas)
  storeCode: string | null;
  pickOrderId: string | null;
  approvedBy: string | null;
  itemsCount: number | null;
  appliedCount: number | null;
  payloadPreview: string;
}

/**
 * Serviço read-only pra auditar registros de integração (tabela integration_logs).
 *
 * Foco principal: baixas de estoque no Gigasistemas (events `debit.real.applied`,
 * `debit.real.failed`, `debit.approved.shadow`, `debit.bulk-approved.*`).
 *
 * Também serve pra qualquer outro tipo de log (scans de bipagem, publicações WC,
 * etc.) via filtro `source` + `event`.
 */
@Injectable()
export class IntegrationLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filters: ListIntegrationLogsFilters): Promise<{
    rows: IntegrationLogRow[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const offset = Math.max(Number(filters.offset) || 0, 0);

    const where: any = {};

    if (filters.source) where.source = filters.source;
    if (filters.event) where.event = filters.event;
    if (filters.eventPrefix) where.event = { startsWith: filters.eventPrefix };

    // status=success → 200; status=failed → diferente de 200 (tipicamente 500)
    if (filters.status === 'success') where.status = 200;
    else if (filters.status === 'failed') where.status = { not: 200 };

    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) (where.createdAt as any).gte = new Date(filters.from);
      if (filters.to) (where.createdAt as any).lte = new Date(filters.to);
    }

    // Filtros textuais em payload/error são via `contains` (SQLite/Postgres case sensitive)
    const or: any[] = [];
    if (filters.storeCode) {
      // storeCode é armazenado dentro do payload JSON — usa substring matching
      or.push({ payload: { contains: `"storeCode":"${filters.storeCode}"` } });
    }
    if (filters.q) {
      or.push({ payload: { contains: filters.q } });
      or.push({ error: { contains: filters.q } });
    }
    if (or.length > 0) where.OR = or;

    const [rows, total] = await Promise.all([
      this.prisma.integrationLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.integrationLog.count({ where }),
    ]);

    return {
      rows: rows.map((r) => this.decorate(r)),
      total,
      limit,
      offset,
    };
  }

  async findOne(id: number): Promise<
    | (IntegrationLogRow & { payload: any })
    | null
  > {
    const row = await this.prisma.integrationLog.findUnique({ where: { id } });
    if (!row) return null;
    const decorated = this.decorate(row);
    let parsed: any = null;
    try {
      parsed = row.payload ? JSON.parse(row.payload) : null;
    } catch {
      parsed = row.payload; // se não for JSON válido, devolve o raw string
    }
    return { ...decorated, payload: parsed };
  }

  /**
   * Extrai campos comuns (storeCode, pickOrderId, approvedBy, itemsCount) do payload JSON
   * pra facilitar a listagem. Se não rolar parse, devolve null nos campos.
   */
  private decorate(row: {
    id: number;
    source: string;
    direction: string;
    event: string;
    payload: string | null;
    status: number | null;
    error: string | null;
    createdAt: Date;
  }): IntegrationLogRow {
    let storeCode: string | null = null;
    let pickOrderId: string | null = null;
    let approvedBy: string | null = null;
    let itemsCount: number | null = null;
    let appliedCount: number | null = null;

    if (row.payload) {
      try {
        const p = JSON.parse(row.payload);
        storeCode = typeof p.storeCode === 'string' ? p.storeCode : null;
        pickOrderId = typeof p.pickOrderId === 'string' ? p.pickOrderId : null;
        approvedBy = typeof p.approvedBy === 'string' ? p.approvedBy : null;
        if (Array.isArray(p.items)) itemsCount = p.items.length;
        if (Array.isArray(p.applied)) appliedCount = p.applied.length;
        if (typeof p.approvedCount === 'number') appliedCount = p.approvedCount;
      } catch {
        /* payload não é JSON — ignora */
      }
    }

    return {
      id: row.id,
      source: row.source,
      direction: row.direction,
      event: row.event,
      status: row.status,
      error: row.error,
      createdAt: row.createdAt,
      storeCode,
      pickOrderId,
      approvedBy,
      itemsCount,
      appliedCount,
      payloadPreview:
        row.payload && row.payload.length > 240
          ? row.payload.slice(0, 240) + '…'
          : row.payload ?? '',
    };
  }

  /**
   * Lista eventos distintos presentes na tabela (pra popular o filtro do frontend).
   * Retorna apenas os N mais recentes pra não explodir em bases gigantes.
   */
  async listDistinctEvents(): Promise<{ event: string; count: number }[]> {
    const rows: Array<{ event: string; count: bigint }> = await this.prisma.$queryRawUnsafe(
      `SELECT event, COUNT(*) as count FROM integration_logs GROUP BY event ORDER BY count DESC LIMIT 200`,
    );
    return rows.map((r) => ({ event: r.event, count: Number(r.count) }));
  }

  /**
   * Estatísticas agregadas pro header da tela: total, sucesso, falha, shadow nas
   * últimas 24h / 7d. Útil pra dar visibilidade rápida sem precisar paginar a lista.
   */
  async stats(filters: { eventPrefix?: string }): Promise<{
    last24h: { total: number; success: number; failed: number; shadow: number };
    last7d: { total: number; success: number; failed: number; shadow: number };
  }> {
    const now = new Date();
    const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const whereBase: any = {};
    if (filters.eventPrefix) whereBase.event = { startsWith: filters.eventPrefix };

    async function bucket(prisma: PrismaService, since: Date) {
      const [total, success, failed, shadow] = await Promise.all([
        prisma.integrationLog.count({ where: { ...whereBase, createdAt: { gte: since } } }),
        prisma.integrationLog.count({
          where: { ...whereBase, createdAt: { gte: since }, status: 200, event: { contains: 'real' } },
        }),
        prisma.integrationLog.count({
          where: { ...whereBase, createdAt: { gte: since }, status: { not: 200 } },
        }),
        prisma.integrationLog.count({
          where: { ...whereBase, createdAt: { gte: since }, event: { contains: 'shadow' } },
        }),
      ]);
      return { total, success, failed, shadow };
    }

    return {
      last24h: await bucket(this.prisma, h24),
      last7d: await bucket(this.prisma, d7),
    };
  }
}
