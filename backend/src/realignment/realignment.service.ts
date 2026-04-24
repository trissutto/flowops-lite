import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';

/**
 * RealignmentService — Realinhamento de estoques entre lojas.
 *
 * Porquê: às vezes loja A tem 10 peças paradas de uma REF e loja B tá zerada
 * da mesma peça. A cliente foi lá e não achou. Essa tela serve pra retaguarda
 * detectar essas distorções e gerar ordens de separação cruzadas (A → B)
 * sem precisar pedir de uma por uma no WhatsApp.
 *
 * Fluxo (pós-pivot #168..#172):
 *   1) preview(refs, origens, destinos, alvoMinimo) → lê estoque Giga, calcula
 *      déficit em cada destino e excedente em cada origem, monta plano de
 *      movimentações sem persistir nada.
 *   2) confirm(plano, solicitante) → cria N TransferOrder (tipo=REALINHAMENTO,
 *      realignmentStatus=pending) e EMITE socket `realignment:new` na sala da
 *      loja ORIGEM. A própria filial (/minha-loja) recebe o alerta e abre a
 *      tela de separação. Sem PDF, sem WhatsApp.
 *   3) listPendingForStore(storeCode) → filial busca as suas ordens pendentes
 *      (tipo=REALINHAMENTO, realignmentStatus=pending, lojaOrigemCode=storeCode).
 *   4) markAsSent(id, storeCode, userId) → filial marca como enviado,
 *      realignmentStatus=sent, emite `realignment:sent`.
 *
 * Regras (herdadas do routing do site):
 *   - Origem NUNCA fica abaixo de `keepMinOrigin` (default = alvoMinimo)
 *   - Maior excedente → maior déficit (empate: loja com mais estoque absoluto)
 *   - Um SKU pode ter múltiplas origens pra cobrir múltiplos destinos
 *   - Respeita escopo: só transfere entre lojas marcadas como origem/destino
 */
@Injectable()
export class RealignmentService {
  private readonly logger = new Logger(RealignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly gateway: RealtimeGateway,
  ) {}

  /**
   * Monta o plano sem persistir.
   */
  async preview(input: {
    refs?: string[];
    skus?: string[];
    originStoreCodes: string[];
    destStoreCodes: string[];
    minPerDest: number;
    keepMinOrigin?: number;
  }) {
    // 1) Expande REFs → SKUs via Giga (searchByRef retorna todas as variações de cor/tamanho)
    const refsIn = Array.from(
      new Set((input.refs || []).map((s) => s.trim()).filter(Boolean)),
    );
    const skusDirect = Array.from(
      new Set((input.skus || []).map((s) => s.trim()).filter(Boolean)),
    );

    const refMap: Record<string, Array<{ sku: string; cor: string | null; tamanho: string | null; desc: string }>> = {};
    const notFoundRefs: string[] = [];

    for (const ref of refsIn) {
      const rows = await this.erp.searchByRef(ref);
      if (!rows || rows.length === 0) {
        notFoundRefs.push(ref);
        continue;
      }
      refMap[ref] = rows.map((r: any) => ({
        sku: String(r.CODIGO || '').trim(),
        cor: r.COR ? String(r.COR).trim() : null,
        tamanho: r.TAMANHO ? String(r.TAMANHO).trim() : null,
        desc: r.DESCRICAOCOMPLETA ? String(r.DESCRICAOCOMPLETA).trim() : '',
      })).filter((x) => x.sku);
    }

    const expandedSkus = Object.values(refMap).flat().map((x) => x.sku);
    const skus = Array.from(new Set([...expandedSkus, ...skusDirect]));

    const origins = Array.from(new Set(input.originStoreCodes || []));
    const dests = Array.from(new Set(input.destStoreCodes || []));
    const minPerDest = Math.max(0, Number(input.minPerDest) || 0);
    const keepMinOrigin = Math.max(0, Number(input.keepMinOrigin ?? minPerDest));

    if (skus.length === 0) throw new BadRequestException(
      notFoundRefs.length > 0
        ? `Nenhuma variação encontrada para: ${notFoundRefs.join(', ')}`
        : 'Nenhuma referência ou SKU informado.',
    );
    if (origins.length === 0)
      throw new BadRequestException('Selecione pelo menos uma loja de origem.');
    if (dests.length === 0)
      throw new BadRequestException('Selecione pelo menos uma loja de destino.');

    const allCodes = Array.from(new Set([...origins, ...dests]));
    const stores = await this.prisma.store.findMany({
      where: { code: { in: allCodes } },
      select: { code: true, name: true, active: true, city: true, state: true },
    });
    const storeByCode = new Map(stores.map((s) => [s.code, s]));

    const missing = allCodes.filter((c) => !storeByCode.has(c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Loja(s) não encontrada(s): ${missing.join(', ')}`,
      );
    }

    const stockMap = await this.erp.getStockBySkusDetailed(skus);

    const skuMeta: Record<string, { ref: string; cor: string | null; tamanho: string | null; desc: string }> = {};
    for (const [ref, variants] of Object.entries(refMap)) {
      for (const v of variants) {
        skuMeta[v.sku] = { ref, cor: v.cor, tamanho: v.tamanho, desc: v.desc };
      }
    }

    type PlanLine = {
      sku: string;
      ref: string | null;
      cor: string | null;
      tamanho: string | null;
      desc: string;
      fromCode: string;
      fromName: string;
      toCode: string;
      toName: string;
      qty: number;
      stockFromBefore: number;
      stockToBefore: number;
      stockFromAfter: number;
      stockToAfter: number;
    };

    const plan: PlanLine[] = [];
    const perSku: Array<{
      sku: string;
      totalMoved: number;
      stillMissing: number;
      note?: string;
    }> = [];

    for (const sku of skus) {
      const lines = stockMap[sku] || [];
      const stockByStore = new Map<string, number>();
      for (const l of lines) {
        stockByStore.set(
          l.storeCode,
          (stockByStore.get(l.storeCode) || 0) + (l.qty || 0),
        );
      }

      const destDeficit = dests
        .map((code) => ({
          code,
          current: stockByStore.get(code) || 0,
          deficit: Math.max(0, minPerDest - (stockByStore.get(code) || 0)),
        }))
        .filter((d) => d.deficit > 0)
        .sort((a, b) => b.deficit - a.deficit || a.current - b.current);

      const originSurplus = origins
        .map((code) => ({
          code,
          current: stockByStore.get(code) || 0,
          surplus: Math.max(0, (stockByStore.get(code) || 0) - keepMinOrigin),
        }))
        .filter((o) => o.surplus > 0)
        .sort((a, b) => b.surplus - a.surplus || b.current - a.current);

      if (destDeficit.length === 0) {
        perSku.push({ sku, totalMoved: 0, stillMissing: 0, note: 'todos os destinos já atendem o mínimo' });
        continue;
      }
      if (originSurplus.length === 0) {
        const totalDef = destDeficit.reduce((a, d) => a + d.deficit, 0);
        perSku.push({
          sku,
          totalMoved: 0,
          stillMissing: totalDef,
          note: 'nenhuma origem tem excedente suficiente (estoque todo no limite)',
        });
        continue;
      }

      const remainingSurplus = new Map(originSurplus.map((o) => [o.code, o.surplus]));
      const remainingDeficit = new Map(destDeficit.map((d) => [d.code, d.deficit]));
      const currentAfter = new Map(stockByStore);

      let totalMoved = 0;

      for (const dest of destDeficit) {
        for (const orig of originSurplus) {
          const defLeft = remainingDeficit.get(dest.code) || 0;
          if (defLeft <= 0) break;
          if (orig.code === dest.code) continue;
          const surpLeft = remainingSurplus.get(orig.code) || 0;
          if (surpLeft <= 0) continue;

          const qty = Math.min(defLeft, surpLeft);
          if (qty <= 0) continue;

          const stockFromBefore = currentAfter.get(orig.code) || 0;
          const stockToBefore = currentAfter.get(dest.code) || 0;
          currentAfter.set(orig.code, stockFromBefore - qty);
          currentAfter.set(dest.code, stockToBefore + qty);

          const meta = skuMeta[sku];
          plan.push({
            sku,
            ref: meta?.ref ?? null,
            cor: meta?.cor ?? null,
            tamanho: meta?.tamanho ?? null,
            desc: meta?.desc ?? '',
            fromCode: orig.code,
            fromName: storeByCode.get(orig.code)!.name,
            toCode: dest.code,
            toName: storeByCode.get(dest.code)!.name,
            qty,
            stockFromBefore,
            stockToBefore,
            stockFromAfter: stockFromBefore - qty,
            stockToAfter: stockToBefore + qty,
          });

          remainingSurplus.set(orig.code, surpLeft - qty);
          remainingDeficit.set(dest.code, defLeft - qty);
          totalMoved += qty;
        }
      }

      const stillMissing = Array.from(remainingDeficit.values()).reduce(
        (a, v) => a + v,
        0,
      );
      perSku.push({ sku, totalMoved, stillMissing });
    }

    const totalMoves = plan.length;
    const totalUnits = plan.reduce((a, p) => a + p.qty, 0);
    const skusWithFullCoverage = perSku.filter((p) => p.stillMissing === 0 && p.totalMoved > 0).length;
    const skusUnchanged = perSku.filter((p) => p.totalMoved === 0).length;

    const perRef: Array<{ ref: string; desc: string; variants: number; totalMoved: number; stillMissing: number }> = [];
    for (const [ref, variants] of Object.entries(refMap)) {
      const skusOfRef = new Set(variants.map((v) => v.sku));
      const related = perSku.filter((p) => skusOfRef.has(p.sku));
      perRef.push({
        ref,
        desc: variants[0]?.desc || '',
        variants: variants.length,
        totalMoved: related.reduce((a, r) => a + r.totalMoved, 0),
        stillMissing: related.reduce((a, r) => a + r.stillMissing, 0),
      });
    }

    return {
      input: { refs: refsIn, skus, origins, dests, minPerDest, keepMinOrigin },
      stores: stores.map((s) => ({
        code: s.code,
        name: s.name,
        active: s.active,
        city: s.city,
        state: s.state,
      })),
      plan,
      perSku,
      perRef,
      notFoundRefs,
      totals: {
        totalMoves,
        totalUnits,
        skusWithFullCoverage,
        skusPartial: perSku.filter((p) => p.totalMoved > 0 && p.stillMissing > 0).length,
        skusUnchanged,
        refsScanned: refsIn.length,
        skusScanned: skus.length,
      },
    };
  }

  /**
   * Persiste o plano: cria N TransferOrder (tipo=REALINHAMENTO,
   * realignmentStatus=pending) e emite socket `realignment:new` agregando
   * por loja origem. A filial (/minha-loja) recebe o alerta em tempo real.
   *
   * Sem WhatsApp, sem PDF — a filial abre o app, vê o card de alerta e vai
   * pra tela /minha-loja/realinhamento separar uma a uma.
   */
  async confirm(input: {
    plan: Array<{
      sku: string;
      ref?: string | null;
      cor?: string | null;
      tamanho?: string | null;
      desc?: string;
      fromCode: string;
      toCode: string;
      qty: number;
      stockFromBefore?: number;
    }>;
    createdByUserId?: string;
    createdByName?: string;
    note?: string;
  }) {
    const lines = (input.plan || []).filter((p) => p.qty > 0);
    if (lines.length === 0) throw new BadRequestException('Plano vazio.');

    // Nomes + IDs das lojas envolvidas (precisamos do storeId pra emitir socket room)
    const codes = Array.from(
      new Set(lines.flatMap((p) => [p.fromCode, p.toCode])),
    );
    const stores = await this.prisma.store.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true, name: true },
    });
    const storeByCode = new Map(stores.map((s) => [s.code, s]));

    const labelOf = (p: { sku: string; ref?: string | null; cor?: string | null; tamanho?: string | null }) => {
      const parts = [p.ref || p.sku];
      if (p.cor) parts.push(p.cor);
      if (p.tamanho) parts.push(p.tamanho);
      return parts.join(' · ');
    };

    const solicitante = input.createdByName || 'Realinhamento (retaguarda)';

    // Cria TransferOrders linha-a-linha e agrupa pra emissão por loja origem
    type CreatedItem = {
      id: string;
      refCode: string;
      cor: string | null;
      tamanho: string | null;
      qtyOrigem: number;
      lojaDestinoCode: string;
      lojaDestinoName: string;
      mensagem: string;
      createdAt: string;
    };
    const createdByOrigin = new Map<string, CreatedItem[]>();

    for (const p of lines) {
      const label = labelOf(p);
      const destStore = storeByCode.get(p.toCode);
      const originStore = storeByCode.get(p.fromCode);
      if (!originStore) continue;

      const msgLine =
        `🔁 REALINHAMENTO — enviar pra ${destStore?.name || p.toCode}: ${label} (${p.qty}un)` +
        (input.note ? ` · ${input.note}` : '');
      const t = await this.prisma.transferOrder.create({
        data: {
          tipo: 'REALINHAMENTO',
          refCode: p.ref || p.sku,
          descricao: (p.desc ?? '').trim() || null,
          cor: p.cor ?? null,
          tamanho: p.tamanho ?? null,
          qtyOrigem: p.qty,
          lojaOrigemCode: p.fromCode,
          lojaOrigemName: originStore.name,
          lojaDestinoCode: p.toCode,
          lojaDestinoName: destStore?.name || p.toCode,
          solicitanteNome: solicitante,
          clienteNome: null,
          mensagem: msgLine,
          createdByUserId: input.createdByUserId ?? null,
          realignmentStatus: 'pending',
        },
      });

      const item: CreatedItem = {
        id: t.id,
        refCode: t.refCode,
        cor: t.cor,
        tamanho: t.tamanho,
        qtyOrigem: t.qtyOrigem,
        lojaDestinoCode: t.lojaDestinoCode,
        lojaDestinoName: t.lojaDestinoName,
        mensagem: t.mensagem,
        createdAt: t.createdAt.toISOString(),
      };
      if (!createdByOrigin.has(p.fromCode)) createdByOrigin.set(p.fromCode, []);
      createdByOrigin.get(p.fromCode)!.push(item);
    }

    // Emite socket agregado por loja origem (1 evento por loja = 1 alerta)
    const emissions: Array<{ storeCode: string; count: number; ok: boolean; error?: string }> = [];
    for (const [fromCode, items] of createdByOrigin.entries()) {
      const origin = storeByCode.get(fromCode);
      if (!origin) {
        emissions.push({ storeCode: fromCode, count: items.length, ok: false, error: 'loja não encontrada' });
        continue;
      }
      try {
        const totalUnits = items.reduce((a, it) => a + it.qtyOrigem, 0);
        this.gateway.emitRealignmentNew(origin.id, {
          storeId: origin.id,
          storeCode: origin.code,
          count: items.length,
          totalUnits,
          items,
          note: input.note || null,
          solicitante,
        });
        emissions.push({ storeCode: fromCode, count: items.length, ok: true });
      } catch (e: any) {
        emissions.push({
          storeCode: fromCode,
          count: items.length,
          ok: false,
          error: e?.message || String(e),
        });
      }
    }

    const totalCreated = Array.from(createdByOrigin.values()).reduce((a, v) => a + v.length, 0);
    this.logger.log(
      `[realignment] ${totalCreated} ordens criadas por ${solicitante} · ` +
      `alertas emitidos: ${emissions.filter((e) => e.ok).length}/${emissions.length}`,
    );

    return {
      ok: true,
      createdCount: totalCreated,
      alerts: {
        emitted: emissions.filter((e) => e.ok).length,
        total: emissions.length,
        byStore: emissions,
      },
    };
  }

  /**
   * Lista ordens pendentes de REALINHAMENTO pra LOJA ORIGEM dela.
   * Recebe storeId do JWT → resolve storeCode via Store (JWT atual não carrega
   * o code, só o id). Retorna [] se a loja não existir.
   */
  async listPendingForStore(storeId: string) {
    if (!storeId) return [];
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { code: true },
    });
    if (!store?.code) return [];
    const orders = await this.prisma.transferOrder.findMany({
      where: {
        tipo: 'REALINHAMENTO',
        realignmentStatus: 'pending',
        lojaOrigemCode: store.code,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        refCode: true,
        descricao: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
        lojaDestinoCode: true,
        lojaDestinoName: true,
        solicitanteNome: true,
        mensagem: true,
        createdAt: true,
      },
    });
    return orders.map((o) => ({
      ...o,
      createdAt: o.createdAt.toISOString(),
    }));
  }

  /**
   * Marca 1 ordem como enviada (filial clica "Enviei").
   * Valida que a loja do JWT é a origem da ordem pra não deixar outra loja
   * marcar ordem que não é dela.
   */
  async markAsSent(input: {
    transferId: string;
    storeId: string;
    userId?: string;
  }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, code: true },
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const order = await this.prisma.transferOrder.findUnique({
      where: { id: input.transferId },
      select: {
        id: true,
        tipo: true,
        lojaOrigemCode: true,
        realignmentStatus: true,
        refCode: true,
        cor: true,
        tamanho: true,
        lojaDestinoCode: true,
      },
    });
    if (!order) throw new NotFoundException('Ordem não encontrada');
    if (order.tipo !== 'REALINHAMENTO')
      throw new BadRequestException('Ordem não é de realinhamento');
    if (order.lojaOrigemCode !== store.code)
      throw new ForbiddenException('Essa ordem não é da sua loja');
    if (order.realignmentStatus === 'sent')
      throw new BadRequestException('Ordem já marcada como enviada');

    const now = new Date();
    const updated = await this.prisma.transferOrder.update({
      where: { id: order.id },
      data: {
        realignmentStatus: 'sent',
        realignmentSentAt: now,
        realignmentSentByUserId: input.userId ?? null,
      },
    });

    try {
      this.gateway.emitRealignmentSent(store.id, {
        transferId: updated.id,
        storeId: store.id,
        storeCode: store.code,
        refCode: updated.refCode,
        cor: updated.cor,
        tamanho: updated.tamanho,
        lojaDestinoCode: updated.lojaDestinoCode,
        sentAt: now.toISOString(),
      });
    } catch (e) {
      this.logger.warn(`[realignment] falha ao emitir socket sent: ${(e as Error).message}`);
    }

    return { ok: true, id: updated.id, sentAt: now.toISOString() };
  }
}
