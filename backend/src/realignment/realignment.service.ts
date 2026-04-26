import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import { WpDbService } from '../wp-db/wp-db.service';

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
    private readonly wpDb: WpDbService,
  ) {}

  /**
   * Monta o plano sem persistir.
   */
  /**
   * Lista de tamanhos PLUS SIZE aceitos no realinhamento.
   * Configurável via SystemSetting `realignment_plus_size_sizes` (lista
   * separada por vírgula). Filtro é case/space insensitive.
   *
   * Default: 46-60 + combinações comuns (46/48, 50/52, etc).
   *
   * Se a config existir mas estiver vazia (string vazia), filtro é
   * desabilitado e TODOS os tamanhos passam.
   */
  private async getPlusSizeFilterSet(): Promise<Set<string> | null> {
    try {
      const r = await (this.prisma as any).systemSetting.findUnique({
        where: { key: 'realignment_plus_size_sizes' },
      });
      const raw = r?.value;
      if (raw === undefined || raw === null) {
        // Sem config — usa default
        return new Set([
          '46', '48', '50', '52', '54', '56', '58', '60',
          '46/48', '48/50', '50/52', '52/54', '54/56', '56/58', '58/60',
        ]);
      }
      const trimmed = String(raw).trim();
      if (!trimmed) return null; // Config vazia = sem filtro
      return new Set(
        trimmed
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      );
    } catch {
      return null; // Em caso de erro, não filtra (failsafe)
    }
  }

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

    // Carrega filtro de tamanhos plus size (config). Se null = sem filtro.
    const plusFilter = await this.getPlusSizeFilterSet();
    const isPlusSizeTamanho = (tam: string | null) => {
      if (!plusFilter) return true;            // sem filtro
      if (!tam) return false;                  // sem tamanho não passa filtro
      return plusFilter.has(tam.trim().toUpperCase());
    };

    const refMap: Record<string, Array<{ sku: string; cor: string | null; tamanho: string | null; desc: string }>> = {};
    const notFoundRefs: string[] = [];

    for (const ref of refsIn) {
      const rows = await this.erp.searchByRef(ref);
      if (!rows || rows.length === 0) {
        notFoundRefs.push(ref);
        continue;
      }
      const variations = rows
        .map((r: any) => ({
          sku: String(r.CODIGO || '').trim(),
          cor: r.COR ? String(r.COR).trim() : null,
          tamanho: r.TAMANHO ? String(r.TAMANHO).trim() : null,
          desc: r.DESCRICAOCOMPLETA ? String(r.DESCRICAOCOMPLETA).trim() : '',
        }))
        .filter((x) => x.sku)
        .filter((x) => isPlusSizeTamanho(x.tamanho));

      if (variations.length > 0) {
        refMap[ref] = variations;
      } else {
        // REF tem variações no Giga mas NENHUMA passou no filtro plus size.
        // Loga pra auditoria mas não joga em notFound (não é erro de cadastro,
        // é a REF não ter peças plus size).
        this.logger.log(
          `[realignment] REF ${ref}: ${rows.length} variações no Giga, 0 plus size (filtradas)`,
        );
      }
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
    // Busca miniaturas de imagens em batch (1 query SQL no WP DB) pra enriquecer
    // cada ordem com a foto do produto. Se o WP DB não tiver configurado, o map
    // volta vazio e os itens ficam sem imageUrl — UI cai no fallback do ícone.
    const uniqueRefs = Array.from(new Set(orders.map((o) => o.refCode).filter(Boolean)));
    let imagesByRef: Record<string, string> = {};
    try {
      imagesByRef = await this.wpDb.getImagesByRefs(uniqueRefs);
    } catch (e: any) {
      this.logger.warn(`[realignment] falha buscando imagens: ${e.message}`);
    }

    return orders.map((o) => ({
      ...o,
      createdAt: o.createdAt.toISOString(),
      imageUrl: imagesByRef[o.refCode] ?? null,
    }));
  }

  /**
   * Lista ordens de REALINHAMENTO JÁ ENVIADAS HOJE pela loja origem.
   * Usado pra tela /minha-loja/realinhamento → aba "Enviados hoje" — permite
   * a vendedora conferir o que já separou durante o expediente sem precisar
   * recontar do zero (a peça some da fila de pendentes depois do clique).
   *
   * Janela: meia-noite local do servidor até agora. Se precisar de recorte
   * diferente (ex: últimas 24h), dá pra parametrizar depois.
   */
  async listSentTodayForStore(storeId: string) {
    if (!storeId) return [];
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { code: true },
    });
    if (!store?.code) return [];

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const orders = await this.prisma.transferOrder.findMany({
      where: {
        tipo: 'REALINHAMENTO',
        realignmentStatus: 'sent',
        lojaOrigemCode: store.code,
        realignmentSentAt: { gte: startOfDay },
      },
      orderBy: { realignmentSentAt: 'desc' },
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
        realignmentSentAt: true,
      },
    });

    const uniqueRefs = Array.from(new Set(orders.map((o) => o.refCode).filter(Boolean)));
    let imagesByRef: Record<string, string> = {};
    try {
      imagesByRef = await this.wpDb.getImagesByRefs(uniqueRefs);
    } catch (e: any) {
      this.logger.warn(`[realignment] falha buscando imagens (sent): ${e.message}`);
    }

    return orders.map((o) => ({
      ...o,
      createdAt: o.createdAt.toISOString(),
      sentAt: o.realignmentSentAt ? o.realignmentSentAt.toISOString() : null,
      imageUrl: imagesByRef[o.refCode] ?? null,
    }));
  }

  /**
   * Marca 1 ordem como enviada (filial clica "Enviei").
   *
   * NOVO MODELO (após Fase A-E de Shipment):
   *   Esse método agora apenas ADICIONA o item à remessa aberta do par
   *   origem→destino. Não baixa Giga ainda — só linka. A baixa Giga +
   *   criação de obrigações acontece quando vendedora clica "Fechar e
   *   enviar remessa" (closeAndSend no shipment service).
   *
   * Mantido por compat: tela `/minha-loja/realinhamento` antiga continua
   * chamando esse endpoint sem precisar refator pesado.
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
      // Pega TODOS campos relevantes pro snapshot financeiro (sku, qty, descrição, etc)
      select: {
        id: true,
        tipo: true,
        lojaOrigemCode: true,
        lojaOrigemName: true,
        lojaDestinoCode: true,
        lojaDestinoName: true,
        realignmentStatus: true,
        refCode: true,
        descricao: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
      } as any,
    });
    if (!order) throw new NotFoundException('Ordem não encontrada');
    if ((order as any).tipo !== 'REALINHAMENTO')
      throw new BadRequestException('Ordem não é de realinhamento');
    if ((order as any).lojaOrigemCode !== store.code)
      throw new ForbiddenException('Essa ordem não é da sua loja');
    if ((order as any).realignmentStatus === 'sent')
      throw new BadRequestException('Ordem já marcada como enviada');

    const now = new Date();
    const o = order as any;

    // Procura ou cria a remessa OPEN do par origem→destino
    let shipment = await (this.prisma as any).realignmentShipment.findFirst({
      where: {
        fromStoreCode: o.lojaOrigemCode,
        toStoreCode: o.lojaDestinoCode,
        status: 'open',
      },
    });
    if (!shipment) {
      // Gera código sequencial REM-YYYY-NNNNNN
      const year = now.getFullYear();
      const prefix = `REM-${year}-`;
      const count = await (this.prisma as any).realignmentShipment.count({
        where: { code: { startsWith: prefix } },
      });
      const code = `${prefix}${String(count + 1).padStart(6, '0')}`;
      shipment = await (this.prisma as any).realignmentShipment.create({
        data: {
          code,
          fromStoreCode: o.lojaOrigemCode,
          fromStoreName: o.lojaOrigemName,
          toStoreCode: o.lojaDestinoCode,
          toStoreName: o.lojaDestinoName,
          status: 'open',
          openedByUserId: input.userId ?? null,
        },
      });
    }

    const updated = await this.prisma.transferOrder.update({
      where: { id: o.id },
      data: {
        realignmentStatus: 'sent',
        realignmentSentAt: now,
        realignmentSentByUserId: input.userId ?? null,
        shipmentId: shipment.id,
      } as any,
    });

    // ── FINANCEIRO: a obrigação NÃO é mais criada aqui. Será criada em
    //    closeAndSend() do shipment service quando a remessa for fechada e
    //    enviada (porque esse é o momento que mercadoria efetivamente sai
    //    do estoque Giga). Manteve apenas o status sent + socket abaixo.
    try {
      this.gateway.emitRealignmentSent(store.id, {
        transferId: (updated as any).id,
        storeId: store.id,
        storeCode: store.code,
        refCode: (updated as any).refCode,
        cor: (updated as any).cor,
        tamanho: (updated as any).tamanho,
        lojaDestinoCode: (updated as any).lojaDestinoCode,
        sentAt: now.toISOString(),
      });
    } catch (e) {
      this.logger.warn(`[realignment] falha ao emitir socket sent: ${(e as Error).message}`);
    }

    return { ok: true, id: (updated as any).id, sentAt: now.toISOString() };
  }

  /**
   * Cria obrigação financeira automática se a transferência for entre grupos
   * diferentes (REDE↔FILIAL). Caso contrário (REDE↔REDE ou FILIAL↔FILIAL do
   * mesmo grupo), não faz nada.
   *
   * Lógica:
   *   1. Lê o tipo (REDE|FILIAL) das duas lojas envolvidas.
   *   2. Se mesmo grupo, sai (sem cobrança).
   *   3. Se grupos diferentes, busca preço Giga via SKU (TransferOrder não
   *      tem SKU direto — vou buscar via REF + cor + tamanho na próxima
   *      iteração; por enquanto tenta achar pelo SKU se vier no campo).
   *   4. Cria InterStoreObligation com snapshot.
   *
   * Convenção: TO (lojaDestino) paga FROM (lojaOrigem) — quem recebeu paga
   * quem enviou.
   */
  private async maybeCreateInterStoreObligation(
    order: any,
    sentAt: Date,
    userId?: string,
  ) {
    // Carrega tipo das 2 lojas
    const [from, to] = await Promise.all([
      this.prisma.store.findUnique({
        where: { code: order.lojaOrigemCode },
        select: { code: true, name: true, tipo: true } as any,
      }),
      this.prisma.store.findUnique({
        where: { code: order.lojaDestinoCode },
        select: { code: true, name: true, tipo: true } as any,
      }),
    ]);

    const fromTipo = (from as any)?.tipo || 'REDE';
    const toTipo = (to as any)?.tipo || 'REDE';

    // Mesmo grupo → sem cobrança
    if (fromTipo === toTipo) return;

    // ── busca preço Giga ──
    // TransferOrder não tem coluna SKU direto, mas o realinhamento foi criado
    // a partir de SKU em confirm() (em mensagem). Pra MVP, busca preço pela
    // primeira variação que casar com REF+cor+tamanho via Giga searchByRef.
    let preco = 0;
    let sku: string | null = null;
    try {
      const variations = await this.erp.searchByRef(order.refCode);
      const match = variations.find(
        (v: any) =>
          (v.cor || '').toUpperCase() === (order.cor || '').toUpperCase() &&
          (v.tamanho || '').toUpperCase() === (order.tamanho || '').toUpperCase(),
      );
      if (match) {
        sku = match.codigo || match.sku || null;
        if (sku) {
          const priceMap = await this.erp.getProductPricesBySkus([sku]);
          preco = priceMap.get(sku) || 0;
        }
      }
    } catch (e) {
      this.logger.warn(
        `[realignment] não conseguiu buscar preço pra ${order.refCode} ${order.cor}/${order.tamanho}: ${(e as Error).message}`,
      );
    }

    // Mesmo se preço = 0, cria a obrigação (admin vê e ajusta manualmente)
    const qty = order.qtyOrigem || 1;
    const precoTotal = preco * qty;
    const divisor = 2.5;
    const valorObrigacao = precoTotal / divisor;

    // Mês de referência = mês do envio (formato "YYYY-MM")
    const mesReferencia = `${sentAt.getFullYear()}-${String(sentAt.getMonth() + 1).padStart(2, '0')}`;

    await (this.prisma as any).interStoreObligation.create({
      data: {
        transferOrderId: order.id,
        fromStoreCode: order.lojaOrigemCode,
        fromStoreName: order.lojaOrigemName,
        fromStoreTipo: fromTipo,
        toStoreCode: order.lojaDestinoCode,
        toStoreName: order.lojaDestinoName,
        toStoreTipo: toTipo,
        refCode: order.refCode,
        sku: sku,
        cor: order.cor,
        tamanho: order.tamanho,
        descricao: order.descricao,
        qty,
        precoUnitario: preco,
        precoTotal,
        divisor,
        valorObrigacao,
        mesReferencia,
        status: 'pending',
      },
    });

    this.logger.log(
      `[financeiro] Obrigação criada: ${order.refCode} ${order.cor}/${order.tamanho} ` +
        `${order.lojaOrigemCode}→${order.lojaDestinoCode} ` +
        `qty=${qty} preco=R$${preco.toFixed(2)} ` +
        `valor=R$${valorObrigacao.toFixed(2)} mês=${mesReferencia}`,
    );
  }

  /**
   * REVERTE uma ordem "sent" de volta pra "pending" (desfaz o clique "Enviei").
   *
   * Caso de uso: vendedora clicou em "Enviei" numa peça errada (ou a peça
   * não foi encontrada depois de marcar) → precisa voltar pra fila de
   * separação sem criar nova ordem.
   *
   * Regras:
   *   - Só a própria loja origem pode reverter (mesmo check de markAsSent).
   *   - Só reverte se estiver `sent` — se já foi `cancelled`/outros estados,
   *     não faz nada.
   *   - Limpa `realignmentSentAt` e `realignmentSentByUserId`.
   *   - Emite socket `realignment:new` pra matriz atualizar o contador
   *     (reaparece na fila).
   */
  async markAsUnsent(input: {
    transferId: string;
    storeId: string;
  }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, code: true, name: true },
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
        qtyOrigem: true,
        lojaDestinoCode: true,
        lojaDestinoName: true,
        solicitanteNome: true,
        mensagem: true,
      },
    });
    if (!order) throw new NotFoundException('Ordem não encontrada');
    if (order.tipo !== 'REALINHAMENTO')
      throw new BadRequestException('Ordem não é de realinhamento');
    if (order.lojaOrigemCode !== store.code)
      throw new ForbiddenException('Essa ordem não é da sua loja');
    if (order.realignmentStatus !== 'sent')
      throw new BadRequestException('Ordem não está marcada como enviada');

    const updated = await this.prisma.transferOrder.update({
      where: { id: order.id },
      data: {
        realignmentStatus: 'pending',
        realignmentSentAt: null,
        realignmentSentByUserId: null,
      },
    });

    // Emite `realignment:unsent` pra retaguarda + outros dispositivos da loja
    // atualizarem a UI (a ordem voltou pra fila). A UI local já atualizou
    // otimisticamente — isso mantém sincronia com outros clientes logados.
    try {
      this.gateway.emitRealignmentUnsent(store.id, {
        transferId: updated.id,
        storeId: store.id,
        storeCode: store.code,
        refCode: updated.refCode,
        cor: updated.cor,
        tamanho: updated.tamanho,
        lojaDestinoCode: updated.lojaDestinoCode,
      });
    } catch (e) {
      this.logger.warn(`[realignment] falha ao emitir socket unsent: ${(e as Error).message}`);
    }

    return { ok: true, id: updated.id };
  }

  /**
   * Conta quantos realinhamentos existem (sem deletar).
   * Usado pra mostrar preview antes de chamar wipeAll().
   */
  async wipePreview() {
    const all = await this.prisma.transferOrder.findMany({
      where: { tipo: 'REALINHAMENTO' },
      select: { realignmentStatus: true, lojaOrigemCode: true, lojaOrigemName: true },
    });
    const byStatus: Record<string, number> = { pending: 0, sent: 0, cancelled: 0, null: 0 };
    const byStore: Record<string, { code: string; name: string; count: number }> = {};
    for (const r of all) {
      const s = r.realignmentStatus || 'null';
      byStatus[s] = (byStatus[s] || 0) + 1;
      const key = r.lojaOrigemCode;
      if (!byStore[key]) byStore[key] = { code: r.lojaOrigemCode, name: r.lojaOrigemName, count: 0 };
      byStore[key].count++;
    }
    return {
      total: all.length,
      byStatus,
      byStore: Object.values(byStore).sort((a, b) => b.count - a.count),
    };
  }

  /**
   * ⚠️ DESTRUTIVO ⚠️
   * Deleta TODOS os TransferOrder onde tipo='REALINHAMENTO'.
   * Preserva REPOSICAO e VENDA_CERTA (que usam a mesma tabela).
   *
   * Uso pretendido: limpar dados de teste antes de começar a usar
   * realinhamento de verdade. Não tem rollback — se for chamado por
   * engano, perde tudo.
   *
   * Proteção: o controller exige role=admin + query param confirm=YES.
   */
  async wipeAll() {
    const before = await this.prisma.transferOrder.count({
      where: { tipo: 'REALINHAMENTO' },
    });
    const result = await this.prisma.transferOrder.deleteMany({
      where: { tipo: 'REALINHAMENTO' },
    });
    this.logger.warn(
      `[realignment] WIPE ALL executado: ${result.count} ordens deletadas (count antes: ${before})`,
    );
    return { ok: true, deleted: result.count, countBefore: before };
  }
}
