/**
 * StoneService — Conciliação automática de transações da maquininha Stone.
 *
 * Fluxo:
 *   1. Stone envia POST pra /webhooks/stone com payload da transação
 *   2. Validação HMAC (Stone-Signature header) garante autenticidade
 *   3. Grava a transação em StoneTransaction (sempre, mesmo se não casar)
 *   4. Tenta achar PdvSale correspondente por (timestamp ± 5min, valor, bandeira)
 *   5. Se achar, marca a sale como conciliada (stoneConciliatedAt) e a
 *      StoneTransaction com matchedSaleId
 *   6. Se não achar, transação fica "órfã" pra revisão manual no admin
 */
import { Injectable, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StoneService {
  private readonly logger = new Logger(StoneService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Valida HMAC SHA-256 do payload usando STONE_WEBHOOK_SECRET.
   * Stone envia header `Stone-Signature` com o hash hex do body.
   *
   * Se não tem STONE_WEBHOOK_SECRET configurado, aceita o webhook em modo
   * "permissivo" e loga warning (útil em desenvolvimento ou enquanto o
   * cadastro Stone não está completo).
   */
  validateSignature(rawBody: string, signature: string | undefined): boolean {
    const secret = process.env.STONE_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.warn(
        '[stone] STONE_WEBHOOK_SECRET não configurado — webhook ACEITO sem validação. ' +
        'Configure a env var pra produção segura.',
      );
      return true;
    }
    if (!signature) {
      this.logger.warn('[stone] header Stone-Signature ausente — webhook REJEITADO');
      return false;
    }
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    // Comparação constant-time pra evitar timing attack
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Processa o evento da Stone:
   *   - Persiste em StoneTransaction
   *   - Tenta match com PdvSale
   *   - Marca sale como conciliada se achou
   */
  async handleWebhook(payload: any, rawBody: string): Promise<{ ok: boolean; matched: boolean; reason?: string }> {
    // Payload esperado (estrutura aproximada — ajustar conforme docs Stone):
    // {
    //   event: 'payment.captured' | 'payment.refunded' | ...,
    //   data: {
    //     transaction_id: '...',
    //     merchant_id: '...',
    //     amount: 12350,           // centavos
    //     card_brand: 'VISA',
    //     last_digits: '1234',
    //     installments: 3,
    //     authorization_code: '...',
    //     nsu: '...',
    //     captured_at: '2026-05-15T13:04:00Z'
    //   }
    // }
    const event = String(payload?.event || '').toLowerCase();
    const data = payload?.data || payload || {};
    const stoneTxId = String(data.transaction_id || data.id || '').trim();

    if (!stoneTxId) {
      throw new BadRequestException('Payload sem transaction_id');
    }

    // Só processa eventos de captura/aprovação. Refunds são tratados separado.
    const isCapture = event === '' || event.includes('captured') || event.includes('approved');
    if (!isCapture) {
      this.logger.log(`[stone] Evento ignorado: ${event} tx=${stoneTxId}`);
      return { ok: true, matched: false, reason: 'event_ignored' };
    }

    // Idempotência: se já temos essa tx, retorna o status atual sem reprocessar
    const existing = await (this.prisma as any).stoneTransaction.findUnique({
      where: { stoneTxId },
    });
    if (existing) {
      this.logger.log(`[stone] tx=${stoneTxId} já processada (matchedSaleId=${existing.matchedSaleId || 'NULL'})`);
      return { ok: true, matched: !!existing.matchedSaleId, reason: 'duplicate' };
    }

    const amount = Number(data.amount || 0) / 100; // Stone manda em centavos
    const bandeira = String(data.card_brand || data.brand || '').toUpperCase() || null;
    const last4 = String(data.last_digits || data.last4 || '').trim() || null;
    const capturedAtRaw = data.captured_at || data.created_at || new Date().toISOString();
    const capturedAt = new Date(capturedAtRaw);
    const merchantId = String(data.merchant_id || '').trim() || null;
    const nsu = String(data.nsu || data.authorization_code || '').trim() || null;
    const authorizationCode = String(data.authorization_code || '').trim() || null;
    const installments = Number(data.installments || 1);

    // Resolve storeCode pelo merchantId (tabela de mapping seria ideal,
    // mas por enquanto procuramos PdvSale candidatas em TODAS as lojas)
    const storeCode = merchantId ? await this.resolveStoreByMerchant(merchantId) : null;

    // ─── Tenta achar venda candidata ───
    // Critério: janela de tempo ± 5min, valor exato (tolerância 1 centavo),
    // ainda não conciliada, status finalized, bandeira batendo (se vier)
    const match = await this.findMatchingSale({
      amount,
      bandeira,
      last4,
      capturedAt,
      storeCode,
    });

    // ─── Persiste transação Stone ───
    const stoneRow = await (this.prisma as any).stoneTransaction.create({
      data: {
        stoneTxId,
        stoneNsu: nsu,
        authorizationCode,
        amount,
        bandeira,
        last4,
        installments,
        merchantId,
        storeCode,
        status: 'captured',
        capturedAt,
        matchedSaleId: match?.saleId || null,
        matchedAt: match?.saleId ? new Date() : null,
        matchScore: match?.score || null,
        matchReason: match?.reason || null,
        rawPayload: rawBody,
      },
    });

    // ─── Se achou, marca a sale como conciliada ───
    if (match?.saleId) {
      try {
        await (this.prisma as any).pdvSale.update({
          where: { id: match.saleId },
          data: {
            stoneConciliatedAt: new Date(),
            stoneTxId,
            stoneNsu: nsu,
            stoneBandeira: bandeira,
            stoneLast4: last4,
          },
        });
        this.logger.log(
          `[stone] CONCILIADO: tx=${stoneTxId} → saleId=${match.saleId} ` +
          `(score=${match.score}, reason=${match.reason}, amount=R$${amount.toFixed(2)})`,
        );
      } catch (e: any) {
        this.logger.error(`[stone] Falha ao marcar sale conciliada: ${e?.message}`);
      }
    } else {
      this.logger.warn(
        `[stone] ÓRFÃ: tx=${stoneTxId} amount=R$${amount.toFixed(2)} ` +
        `bandeira=${bandeira} last4=${last4} capturedAt=${capturedAt.toISOString()} ` +
        `— nenhuma venda PDV correspondeu`,
      );
    }

    return { ok: true, matched: !!match?.saleId, reason: match?.reason };
  }

  /**
   * Tenta resolver storeCode a partir do merchant_id da Stone.
   * Cada loja física tem um merchant_id (CNPJ + número da máquina).
   * TODO: criar tabela StoneMerchant pra mapping persistente.
   * Por ora retorna null — match procura em todas as lojas.
   */
  private async resolveStoreByMerchant(merchantId: string): Promise<string | null> {
    // Lê de env var (formato JSON: { "stone_merchant_id_123": "01", ... })
    // Ou de uma tabela de config no futuro.
    try {
      const map = JSON.parse(process.env.STONE_MERCHANT_MAP || '{}');
      return map[merchantId] || null;
    } catch {
      return null;
    }
  }

  /**
   * Procura PdvSale candidata por (timestamp ± 5min, valor exato).
   * Score:
   *   - 100 = match perfeito (storeCode + bandeira + valor + tempo)
   *   - 80 = sem storeCode mas com bandeira batendo
   *   - 60 = só valor + tempo
   */
  private async findMatchingSale(input: {
    amount: number;
    bandeira: string | null;
    last4: string | null;
    capturedAt: Date;
    storeCode: string | null;
  }): Promise<{ saleId: string; score: number; reason: string } | null> {
    const { amount, bandeira, capturedAt, storeCode } = input;
    const windowMs = 5 * 60 * 1000; // ±5min
    const tFrom = new Date(capturedAt.getTime() - windowMs);
    const tTo = new Date(capturedAt.getTime() + windowMs);

    // Busca candidatas:
    //  - status finalized
    //  - finalizedAt na janela
    //  - paymentMethod credito ou debito
    //  - total exato (tolerância 1 centavo)
    //  - ainda não conciliada
    const where: any = {
      status: 'finalized',
      finalizedAt: { gte: tFrom, lte: tTo },
      total: { gte: amount - 0.01, lte: amount + 0.01 },
      stoneConciliatedAt: null,
      paymentMethod: { in: ['credito', 'debito', 'CREDITO', 'DEBITO'] },
    };
    if (storeCode) where.storeCode = storeCode;

    const candidates = await (this.prisma as any).pdvSale.findMany({
      where,
      include: { payments: true },
      orderBy: { finalizedAt: 'asc' },
      take: 10,
    });

    if (!candidates.length) {
      // Fallback: amplia janela pra ±15min sem filtro de paymentMethod
      const tFromWide = new Date(capturedAt.getTime() - 15 * 60 * 1000);
      const tToWide = new Date(capturedAt.getTime() + 15 * 60 * 1000);
      const wide = await (this.prisma as any).pdvSale.findMany({
        where: {
          status: 'finalized',
          finalizedAt: { gte: tFromWide, lte: tToWide },
          total: { gte: amount - 0.01, lte: amount + 0.01 },
          stoneConciliatedAt: null,
        },
        take: 5,
      });
      if (!wide.length) return null;
      // Pega a mais próxima no tempo
      const best = wide.reduce((b: any, c: any) =>
        Math.abs(new Date(c.finalizedAt).getTime() - capturedAt.getTime()) <
        Math.abs(new Date(b.finalizedAt).getTime() - capturedAt.getTime())
          ? c
          : b,
      );
      return { saleId: best.id, score: 50, reason: 'fuzzy_wide_time' };
    }

    // Match exato — escolhe melhor por score
    let bestScore = 0;
    let bestSaleId: string | null = null;
    let bestReason = '';
    for (const sale of candidates as any[]) {
      let score = 60; // valor + tempo dentro da janela
      let reason = 'value_time';
      if (storeCode && sale.storeCode === storeCode) {
        score += 20;
        reason = 'store_match';
      }
      if (bandeira) {
        // Tenta ver se algum payment tem bandeira batendo
        const matchBandeira = (sale.payments || []).some((p: any) => {
          try {
            const det = p.details ? JSON.parse(p.details) : {};
            const b = String(det.bandeira || '').toUpperCase();
            return b && bandeira && (b === bandeira || b.includes(bandeira) || bandeira.includes(b));
          } catch {
            return false;
          }
        });
        if (matchBandeira) {
          score += 20;
          reason = 'full_match';
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestSaleId = sale.id;
        bestReason = reason;
      }
    }

    if (!bestSaleId) return null;
    return { saleId: bestSaleId, score: bestScore, reason: bestReason };
  }

  /**
   * Lista vendas + transações Stone do dia pra tela admin de conciliação.
   */
  async getConciliacao(date: Date): Promise<{
    date: string;
    salesTotal: number;
    salesConciliadas: number;
    salesNaoConciliadas: number;
    stoneTotal: number;
    stoneOrfas: number;
    sales: Array<any>;
    orfas: Array<any>;
  }> {
    const from = new Date(date);
    from.setHours(0, 0, 0, 0);
    const to = new Date(date);
    to.setHours(23, 59, 59, 999);

    // Vendas cartão do dia
    const sales = await (this.prisma as any).pdvSale.findMany({
      where: {
        status: 'finalized',
        finalizedAt: { gte: from, lte: to },
        paymentMethod: { in: ['credito', 'debito', 'CREDITO', 'DEBITO'] },
      },
      select: {
        id: true, storeCode: true, storeName: true, total: true,
        paymentMethod: true, sellerName: true, vendedorName: true,
        finalizedAt: true,
        stoneConciliatedAt: true, stoneTxId: true, stoneNsu: true,
        stoneBandeira: true, stoneLast4: true,
      },
      orderBy: { finalizedAt: 'desc' },
    });

    // Transações Stone órfãs (sem match) do dia
    const orfas = await (this.prisma as any).stoneTransaction.findMany({
      where: {
        capturedAt: { gte: from, lte: to },
        matchedSaleId: null,
      },
      orderBy: { capturedAt: 'desc' },
    });

    // Stone transactions totais do dia (matched + órfãs)
    const allStone = await (this.prisma as any).stoneTransaction.count({
      where: { capturedAt: { gte: from, lte: to } },
    });

    const conciliadas = (sales as any[]).filter((s) => !!s.stoneConciliatedAt).length;
    return {
      date: from.toISOString().slice(0, 10),
      salesTotal: sales.length,
      salesConciliadas: conciliadas,
      salesNaoConciliadas: sales.length - conciliadas,
      stoneTotal: allStone,
      stoneOrfas: orfas.length,
      sales: (sales as any[]).map((s) => ({
        ...s,
        finalizedAt: s.finalizedAt instanceof Date ? s.finalizedAt.toISOString() : s.finalizedAt,
        stoneConciliatedAt: s.stoneConciliatedAt instanceof Date ? s.stoneConciliatedAt.toISOString() : s.stoneConciliatedAt,
      })),
      orfas: (orfas as any[]).map((o) => ({
        ...o,
        capturedAt: o.capturedAt instanceof Date ? o.capturedAt.toISOString() : o.capturedAt,
        receivedAt: o.receivedAt instanceof Date ? o.receivedAt.toISOString() : o.receivedAt,
        rawPayload: undefined, // não envia payload bruto pro frontend
      })),
    };
  }

  /**
   * Conciliação manual: associa transação Stone X com venda Y.
   * Usado quando o match automático falha (timestamp muito longe, etc).
   */
  async conciliarManual(stoneTxId: string, saleId: string, userId?: string): Promise<{ ok: boolean }> {
    const tx = await (this.prisma as any).stoneTransaction.findUnique({ where: { stoneTxId } });
    if (!tx) throw new BadRequestException('Transação Stone não encontrada');
    const sale = await (this.prisma as any).pdvSale.findUnique({ where: { id: saleId } });
    if (!sale) throw new BadRequestException('Venda PDV não encontrada');
    if (sale.stoneConciliatedAt) {
      throw new BadRequestException('Venda já conciliada com outra transação');
    }
    await (this.prisma as any).$transaction([
      (this.prisma as any).stoneTransaction.update({
        where: { stoneTxId },
        data: { matchedSaleId: saleId, matchedAt: new Date(), matchReason: 'manual', matchScore: 100 },
      }),
      (this.prisma as any).pdvSale.update({
        where: { id: saleId },
        data: {
          stoneConciliatedAt: new Date(),
          stoneTxId: tx.stoneTxId,
          stoneNsu: tx.stoneNsu,
          stoneBandeira: tx.bandeira,
          stoneLast4: tx.last4,
        },
      }),
    ]);
    this.logger.log(`[stone] CONCILIADO MANUAL: tx=${stoneTxId} → saleId=${saleId} por user=${userId}`);
    return { ok: true };
  }
}
