import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

/**
 * RealignmentService — Realinhamento de estoques entre lojas.
 *
 * Porquê: às vezes loja A tem 10 peças paradas de uma REF e loja B tá zerada
 * da mesma peça. A cliente foi lá e não achou. Essa tela serve pra retaguarda
 * detectar essas distorções e gerar ordens de separação cruzadas (A → B)
 * sem precisar pedir de uma por uma no WhatsApp.
 *
 * Fluxo:
 *   1) preview(skus, origens, destinos, alvoMinimo) → lê estoque Giga, calcula
 *      déficit em cada destino e excedente em cada origem, monta plano de
 *      movimentações sem persistir nada.
 *   2) confirm(plano, solicitante) → cria N TransferOrder (tipo=REALINHAMENTO)
 *      + opcionalmente dispara WhatsApp consolidado por loja origem.
 *
 * Regras (herdadas do routing do site):
 *   - Origem NUNCA fica abaixo de `keepMinOrigin` (default = alvoMinimo)
 *     → evita desabastecer quem mandou
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
    private readonly whatsapp: WhatsappService,
  ) {}

  /**
   * Monta o plano sem persistir.
   *
   * @param skus Lista de SKUs do Gigasistemas (ex: VMS-223-PRETO-M). 1 por linha.
   * @param originStoreCodes Códigos das lojas que PODEM mandar. Vazio = nenhuma pode.
   * @param destStoreCodes Códigos das lojas que RECEBEM. Vazio = nenhuma recebe.
   * @param minPerDest Alvo mínimo que cada destino precisa ter de cada SKU.
   * @param keepMinOrigin Mínimo que origem mantém (default = minPerDest).
   */
  async preview(input: {
    skus: string[];
    originStoreCodes: string[];
    destStoreCodes: string[];
    minPerDest: number;
    keepMinOrigin?: number;
  }) {
    const skus = Array.from(
      new Set((input.skus || []).map((s) => s.trim()).filter(Boolean)),
    );
    const origins = Array.from(new Set(input.originStoreCodes || []));
    const dests = Array.from(new Set(input.destStoreCodes || []));
    const minPerDest = Math.max(0, Number(input.minPerDest) || 0);
    const keepMinOrigin = Math.max(0, Number(input.keepMinOrigin ?? minPerDest));

    if (skus.length === 0) throw new BadRequestException('Nenhum SKU informado.');
    if (origins.length === 0)
      throw new BadRequestException('Selecione pelo menos uma loja de origem.');
    if (dests.length === 0)
      throw new BadRequestException('Selecione pelo menos uma loja de destino.');

    // Loja nunca pode ser origem E destino ao mesmo tempo numa mesma movimentação
    // — mas pode aparecer em ambas as listas. O algoritmo naturalmente não propõe
    // mover X → X, porque sobra é calculada sobre o próprio estoque.

    // Carrega nomes das lojas envolvidas
    const allCodes = Array.from(new Set([...origins, ...dests]));
    const stores = await this.prisma.store.findMany({
      where: { code: { in: allCodes } },
      select: { code: true, name: true, active: true, city: true, state: true },
    });
    const storeByCode = new Map(stores.map((s) => [s.code, s]));

    // Valida códigos
    const missing = allCodes.filter((c) => !storeByCode.has(c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Loja(s) não encontrada(s): ${missing.join(', ')}`,
      );
    }

    // Carrega estoque detalhado do Giga pra todos os SKUs de uma vez
    const stockMap = await this.erp.getStockBySkusDetailed(skus);

    type PlanLine = {
      sku: string;
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
    // Relatório por SKU: quanto foi movido, quanto faltou, se nem começou
    const perSku: Array<{
      sku: string;
      totalMoved: number;
      stillMissing: number; // déficit não atendido (falta estoque na origem)
      note?: string;
    }> = [];

    for (const sku of skus) {
      const lines = stockMap[sku] || [];
      const stockByStore = new Map<string, number>();
      for (const l of lines) {
        // Soma se por acaso houver duplicata
        stockByStore.set(
          l.storeCode,
          (stockByStore.get(l.storeCode) || 0) + (l.qty || 0),
        );
      }

      // Déficit dos destinos
      const destDeficit = dests
        .map((code) => ({
          code,
          current: stockByStore.get(code) || 0,
          deficit: Math.max(0, minPerDest - (stockByStore.get(code) || 0)),
        }))
        .filter((d) => d.deficit > 0)
        // Maior déficit primeiro; empate → loja com menor estoque atual (mais crítica)
        .sort((a, b) => b.deficit - a.deficit || a.current - b.current);

      // Excedente das origens (respeitando keepMinOrigin)
      const originSurplus = origins
        .map((code) => ({
          code,
          current: stockByStore.get(code) || 0,
          surplus: Math.max(0, (stockByStore.get(code) || 0) - keepMinOrigin),
        }))
        .filter((o) => o.surplus > 0)
        // Maior excedente primeiro (distribui de quem tem mais)
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

      // Estado mutável do algoritmo
      const remainingSurplus = new Map(originSurplus.map((o) => [o.code, o.surplus]));
      const remainingDeficit = new Map(destDeficit.map((d) => [d.code, d.deficit]));
      const currentAfter = new Map(stockByStore); // vai sendo atualizado

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

          plan.push({
            sku,
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

    // Totais
    const totalMoves = plan.length;
    const totalUnits = plan.reduce((a, p) => a + p.qty, 0);
    const skusWithFullCoverage = perSku.filter((p) => p.stillMissing === 0 && p.totalMoved > 0).length;
    const skusUnchanged = perSku.filter((p) => p.totalMoved === 0).length;

    return {
      input: { skus, origins, dests, minPerDest, keepMinOrigin },
      stores: stores.map((s) => ({
        code: s.code,
        name: s.name,
        active: s.active,
        city: s.city,
        state: s.state,
      })),
      plan,
      perSku,
      totals: {
        totalMoves,
        totalUnits,
        skusWithFullCoverage,
        skusPartial: perSku.filter((p) => p.totalMoved > 0 && p.stillMissing > 0).length,
        skusUnchanged,
      },
    };
  }

  /**
   * Persiste o plano: cria N TransferOrder (tipo=REALINHAMENTO) + opcionalmente
   * dispara WhatsApp consolidado por loja origem.
   *
   * ATENÇÃO: ao contrário do VENDA_CERTA/REPOSICAO do módulo filial, aqui
   * `solicitanteNome` vem como "Realinhamento (retaguarda)" e `clienteNome`
   * fica null. Esse tipo é detectável pelo `tipo=REALINHAMENTO` no relatório.
   */
  async confirm(input: {
    plan: Array<{
      sku: string;
      fromCode: string;
      toCode: string;
      qty: number;
      stockFromBefore?: number;
    }>;
    createdByUserId?: string;
    createdByName?: string;
    sendWhatsapp?: boolean;
    note?: string; // texto livre opcional pra incluir na msg (ex: "pro lançamento do sábado")
  }) {
    const lines = (input.plan || []).filter((p) => p.qty > 0);
    if (lines.length === 0) throw new BadRequestException('Plano vazio.');

    // Nomes das lojas envolvidas
    const codes = Array.from(
      new Set(lines.flatMap((p) => [p.fromCode, p.toCode])),
    );
    const stores = await this.prisma.store.findMany({
      where: { code: { in: codes } },
      select: { code: true, name: true, whatsapp: true },
    });
    const storeByCode = new Map(stores.map((s) => [s.code, s]));

    // Mensagem base por origem (consolidada)
    // Ex: "🔁 REALINHAMENTO\nSeparar e enviar:\n• LJ05 (Centro): VMS-223-P (2un)\n• LJ02 (Shopping): VMS-223-M (1un)"
    type Line = { sku: string; toCode: string; toName: string; qty: number };
    const byOrigin = new Map<string, Line[]>();
    for (const p of lines) {
      if (!byOrigin.has(p.fromCode)) byOrigin.set(p.fromCode, []);
      byOrigin.get(p.fromCode)!.push({
        sku: p.sku,
        toCode: p.toCode,
        toName: storeByCode.get(p.toCode)?.name || p.toCode,
        qty: p.qty,
      });
    }

    const solicitante = input.createdByName || 'Realinhamento (retaguarda)';
    const createdTransfers: string[] = [];
    const whatsappResults: Array<{ storeCode: string; ok: boolean; error?: string }> = [];

    // Cria TransferOrder linha-a-linha (1 por movimentação)
    // Usa o refCode como o próprio SKU (já é granular: inclui cor/tamanho)
    for (const p of lines) {
      const msgLine =
        `🔁 REALINHAMENTO — enviar pra ${storeByCode.get(p.toCode)?.name || p.toCode}: ${p.sku} (${p.qty}un)` +
        (input.note ? ` · ${input.note}` : '');
      const t = await this.prisma.transferOrder.create({
        data: {
          tipo: 'REALINHAMENTO',
          refCode: p.sku,
          cor: null,
          tamanho: null,
          qtyOrigem: p.stockFromBefore ?? 0,
          lojaOrigemCode: p.fromCode,
          lojaOrigemName: storeByCode.get(p.fromCode)?.name || p.fromCode,
          lojaDestinoCode: p.toCode,
          lojaDestinoName: storeByCode.get(p.toCode)?.name || p.toCode,
          solicitanteNome: solicitante,
          clienteNome: null,
          mensagem: msgLine,
          createdByUserId: input.createdByUserId ?? null,
        },
      });
      createdTransfers.push(t.id);
    }

    // Dispara WhatsApp consolidado por loja origem
    if (input.sendWhatsapp) {
      for (const [fromCode, items] of byOrigin.entries()) {
        const origin = storeByCode.get(fromCode);
        if (!origin?.whatsapp) {
          whatsappResults.push({
            storeCode: fromCode,
            ok: false,
            error: 'loja sem whatsapp cadastrado',
          });
          continue;
        }
        const header =
          `🔁 *REALINHAMENTO DE ESTOQUE*\n\n` +
          `Por favor separar e enviar as peças abaixo pras lojas indicadas:\n`;
        const body = items
          .map((it) => `• *${it.sku}* → ${it.toCode} ${it.toName} · *${it.qty}un*`)
          .join('\n');
        const footer =
          (input.note ? `\n\nObs: ${input.note}` : '') +
          `\n\n_Enviado por: ${solicitante}_`;
        const message = header + body + footer;
        try {
          await this.whatsapp.sendText(origin.whatsapp, message);
          whatsappResults.push({ storeCode: fromCode, ok: true });
        } catch (e: any) {
          whatsappResults.push({
            storeCode: fromCode,
            ok: false,
            error: e?.message || String(e),
          });
        }
      }
    }

    this.logger.log(
      `[realignment] ${createdTransfers.length} transferências criadas por ${solicitante}` +
        (input.sendWhatsapp ? ` (whatsapp: ${whatsappResults.filter((r) => r.ok).length}/${whatsappResults.length})` : ''),
    );

    return {
      ok: true,
      createdCount: createdTransfers.length,
      transferIds: createdTransfers,
      whatsapp: {
        attempted: input.sendWhatsapp ? whatsappResults.length : 0,
        sent: whatsappResults.filter((r) => r.ok).length,
        failures: whatsappResults.filter((r) => !r.ok),
      },
    };
  }
}
