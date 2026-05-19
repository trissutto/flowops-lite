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
    /**
     * Filtro de descrição por REF. Quando uma REF tem múltiplas "famílias"
     * de produtos (ex: REF 9002 = "Calça Mom" E "Pijama"), passar aqui
     * a descrição da família desejada faz o sistema filtrar.
     * Exemplo: { "9002": "calça mom" } → só pega variações cuja descrição
     * contém "calça" E "mom".
     */
    refFilters?: Record<string, string>;
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

    /**
     * Filtro PLUS aplica em NÍVEL DE REF (não por variação individual).
     *
     * Justificativa: O Lurd's tem REFs que se repetem entre universos (PLUS e
     * não-PLUS — chinelos, infantis, masculinos). Mas NUNCA mistura tamanhos
     * pequenos COM plus na MESMA REF. Então:
     *   - Se a REF tem alguma variação plus → é REF do universo plus, mantém
     *     todas as variações (todas as cores, todos os tamanhos plus).
     *   - Se a REF não tem nenhuma variação plus → é REF do universo não-plus
     *     (chinelo etc), descarta inteira.
     *
     * Antes: filtrava cada variação individualmente — algumas cores caíam fora
     * porque alguns tamanhos sai do filtro, mostrando 1 só cor.
     */
    const refIsPlusSize = (variations: Array<{ tamanho: string | null }>) => {
      if (!plusFilter) return true; // sem filtro = passa
      return variations.some((v) => isPlusSizeTamanho(v.tamanho));
    };

    const refMap: Record<string, Array<{ sku: string; cor: string | null; tamanho: string | null; desc: string }>> = {};
    const notFoundRefs: string[] = [];
    const ambiguousRefs: Array<{ ref: string; familias: Array<{ desc: string; count: number }> }> = [];

    // Normaliza string pra match (lowercase + sem acento)
    const norm = (s: string) =>
      String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');

    for (const ref of refsIn) {
      const rows = await this.erp.searchByRef(ref);
      if (!rows || rows.length === 0) {
        notFoundRefs.push(ref);
        continue;
      }
      const allVariations = rows
        .map((r: any) => ({
          sku: String(r.CODIGO || '').trim(),
          cor: r.COR ? String(r.COR).trim() : null,
          tamanho: r.TAMANHO ? String(r.TAMANHO).trim() : null,
          desc: r.DESCRICAOCOMPLETA ? String(r.DESCRICAOCOMPLETA).trim() : '',
        }))
        .filter((x) => x.sku);

      // FILTRO PLUS POR REF (não por variação individual):
      // Se a REF tem alguma variação plus, todas entram. Senão, descarta a REF.
      // (REFs do universo não-plus — chinelo, infantil — são puladas.)
      if (!refIsPlusSize(allVariations)) {
        notFoundRefs.push(ref); // sinaliza pro frontend que a REF foi filtrada
        continue;
      }
      // Dentro de uma REF plus, ainda filtra variações individuais por tamanho —
      // garante que tamanho 36/38 (não-plus) misturado por engano seja ignorado.
      let variations = allVariations.filter((x) => isPlusSizeTamanho(x.tamanho));

      // Aplica filtro de descrição se fornecido (caso "calça mom 9002" → só calças)
      const descFilter = input.refFilters?.[ref];
      if (descFilter) {
        const palavras = norm(descFilter)
          .split(/\s+/)
          .filter((w) => w.length >= 2);
        if (palavras.length > 0) {
          variations = variations.filter((v) => {
            const d = norm(v.desc);
            return palavras.every((w) => d.includes(w));
          });
        }
      } else {
        // ─── Detecção de AMBIGUIDADE (afrouxada) ───
        // Quando o user digita só a REF (sem descrição), o sistema só considera
        // ambíguo se a REF tiver produtos REALMENTE diferentes — tipo "BLUSA" e
        // "SAPATO" no mesmo número. Variações de cor com pequenas diferenças
        // textuais NÃO são consideradas ambíguas.
        //
        // Estratégia: agrupa pela 1ª palavra significativa (>=4 chars, ignorando
        // palavras genéricas como FEMININA/MASCULINA/PLUS/SIZE). Se as primeiras
        // palavras categóricas divergem, marca ambíguo.
        const STOPWORDS = new Set([
          'plus', 'size', 'feminina', 'feminino', 'masculino', 'masculina',
          'infantil', 'unissex', 'adulto', 'manga', 'curta', 'longa', 'comum',
          'basica', 'basico', 'alfaiataria', 'modelo',
        ]);
        const familias = new Map<string, { desc: string; count: number }>();
        for (const v of variations) {
          const palavras = norm(v.desc).split(/\s+/).filter(Boolean);
          // Categoria = primeira palavra com >=4 chars que NÃO é stopword
          const categoria = palavras.find((w) => w.length >= 4 && !STOPWORDS.has(w)) || '';
          if (!categoria) continue;
          const existing = familias.get(categoria);
          if (existing) {
            existing.count++;
          } else {
            familias.set(categoria, { desc: v.desc, count: 1 });
          }
        }
        // Só considera ambíguo se 2+ categorias E ambas têm pelo menos 2 variações
        // (evita falso positivo por cor com palavra rara isolada).
        const familiasSignificativas = Array.from(familias.values()).filter((f) => f.count >= 2);
        if (familiasSignificativas.length > 1) {
          ambiguousRefs.push({
            ref,
            familias: Array.from(familias.values()).sort(
              (a, b) => b.count - a.count,
            ),
          });
          continue; // Não inclui essa REF no plano até desambiguar
        }
      }

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

    // Se TODAS as REFs informadas foram detectadas como AMBÍGUAS, retorna
    // resposta vazia (plan=[]) COM ambiguousRefs populado — pra UI mostrar
    // os botões de escolha de família. Antes lançava 400, que escondia a
    // info de ambiguidade da UI.
    if (skus.length === 0 && ambiguousRefs.length > 0) {
      return {
        input: { refs: refsIn, skus, origins, dests, minPerDest, keepMinOrigin },
        stores: [],
        plan: [],
        perSku: [],
        perRef: [],
        notFoundRefs,
        ambiguousRefs,
        removedByValidation: [],
        totals: {
          totalMoves: 0,
          totalUnits: 0,
          skusWithFullCoverage: 0,
          skusPartial: 0,
          skusUnchanged: 0,
          refsScanned: refsIn.length,
          skusScanned: 0,
        },
      } as any;
    }
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

    // ─────────────────────────────────────────────────────────────────
    // VALIDAÇÃO DEFENSIVA — estoque REAL Giga na origem antes de devolver
    // ─────────────────────────────────────────────────────────────────
    // Porquê: o algoritmo acima itera POR SKU usando `stockMap` (que vem do
    // getStockBySkusDetailed). Se a mesma peça (REF+COR+TAM) tiver MÚLTIPLOS
    // CODIGOs cadastrados no Giga, o estoque pode estar fragmentado entre
    // esses CODIGOs e o algoritmo pode somar errado, OU pegar estoque de
    // um CODIGO que na verdade não existe fisicamente mas tem qty no Giga.
    //
    // Solução: depois de gerar o plano, RE-VALIDA cada linha contra o estoque
    // REAL agregado por (REF+COR+TAM, LOJA) — mesmo método usado pelo
    // precheck do shipment. Se na origem não tem estoque suficiente, remove
    // a linha do plano e marca como filtered pra log/auditoria.
    //
    // Isso evita o problema reportado de sugerir Itanhaém como origem
    // pra peças que ela não tem fisicamente nem no Giga.
    const removedByValidation: Array<{
      ref: string;
      cor: string | null;
      tamanho: string | null;
      fromCode: string;
      qtyOriginal: number;
      estoqueReal: number;
    }> = [];

    // ─────────────────────────────────────────────────────────────────
    // VALIDAÇÃO DEFENSIVA REMOVIDA (2026-05-19)
    // ─────────────────────────────────────────────────────────────────
    // Motivo: usava `getStockByRefCorTamInStoreBatch` que era mais restritivo
    // que o `getStockBySkusDetailed` do algoritmo principal — em ambientes
    // com dados inconsistentes no Wincred (LOJA="01" vs "1", CODIGOs
    // duplicados), reportava estoqueReal=0 mesmo com estoque existindo, e
    // removia TODAS as movimentações → plano sempre vazio.
    //
    // Se origem não tiver a peça física, o precheck/closeAndSend pega no
    // momento do envio (com allowNegative).
    // `removedByValidation` continua sendo retornado (sempre vazio) pra
    // compatibilidade com o frontend que lê esse campo.

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
      ambiguousRefs,
      removedByValidation,
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
    // ESTRATÉGIA NÃO-BLOQUEANTE pra latência sempre baixa (<500ms):
    //  - Imagens já em cache → vão no payload
    //  - Refs sem cache → dispara fetch BG (sem await), próxima chamada já tem
    //  - 1ª vez vê sem foto (fallback ícone), 2ª vez já vem completo
    const uniqueRefs = Array.from(new Set(orders.map((o) => o.refCode).filter(Boolean)));
    const imagesByRef = this.wpDb.getCachedImages(uniqueRefs);
    const semCache = uniqueRefs.filter((r) => imagesByRef[r] === undefined);
    if (semCache.length > 0) {
      // fire-and-forget — popula cache pra próxima chamada
      this.wpDb.getImagesByRefs(semCache).catch((e: any) => {
        this.logger.warn(`[realignment] pre-fetch BG imagens: ${e.message}`);
      });
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

    // Mesma estratégia não-bloqueante (ver comentário no listPendingForStore)
    const uniqueRefs = Array.from(new Set(orders.map((o) => o.refCode).filter(Boolean)));
    const imagesByRef = this.wpDb.getCachedImages(uniqueRefs);
    const semCache = uniqueRefs.filter((r) => imagesByRef[r] === undefined);
    if (semCache.length > 0) {
      this.wpDb.getImagesByRefs(semCache).catch((e: any) => {
        this.logger.warn(`[realignment] pre-fetch BG imagens (sent): ${e.message}`);
      });
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
    this.logger.log(`[markAsSent] START transferId=${input.transferId} storeId=${input.storeId}`);

    let store: any;
    try {
      store = await this.prisma.store.findUnique({
        where: { id: input.storeId },
        select: { id: true, code: true },
      });
    } catch (e: any) {
      this.logger.error(`[markAsSent] step=findStore failed: ${e?.message}`);
      throw new BadRequestException(`Erro ao buscar loja: ${e?.message}`);
    }
    if (!store) throw new ForbiddenException('Loja inválida');

    // Usa SQL raw pra independer do Prisma client conhecer todos os campos
    let order: any;
    try {
      const rows: any[] = await this.prisma.$queryRaw`
        SELECT id, tipo, ref_code as "refCode", descricao,
               cor, tamanho, qty_origem as "qtyOrigem",
               loja_origem_code as "lojaOrigemCode",
               loja_origem_name as "lojaOrigemName",
               loja_destino_code as "lojaDestinoCode",
               loja_destino_name as "lojaDestinoName",
               realignment_status as "realignmentStatus"
        FROM transfer_orders
        WHERE id = ${input.transferId}
        LIMIT 1
      `;
      order = rows[0] || null;
    } catch (e: any) {
      this.logger.error(`[markAsSent] step=findOrder failed: ${e?.message}`);
      throw new BadRequestException(
        `Erro ao buscar ordem: ${e?.message}. Provável: rodar 'prisma db push' no Railway.`,
      );
    }
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
    let shipment: any;
    try {
      shipment = await (this.prisma as any).realignmentShipment.findFirst({
        where: {
          fromStoreCode: o.lojaOrigemCode,
          toStoreCode: o.lojaDestinoCode,
          status: 'open',
        },
      });
    } catch (e: any) {
      this.logger.error(`[markAsSent] step=findShipment failed: ${e?.message}`);
      throw new BadRequestException(
        `Tabela RealignmentShipment não existe no Postgres. Rode "prisma db push" no Railway. Erro: ${e?.message}`,
      );
    }

    if (!shipment) {
      const year = now.getFullYear();
      const prefix = `REM-${year}-`;
      // Race condition: 2+ vendedoras clicando "Enviei" simultaneamente podem
      // computar o mesmo `count` antes de qualquer create commitar. Retry até
      // 10x incrementando o sufixo numérico — primeira que comitar ganha.
      let lastErr: any;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const count = await (this.prisma as any).realignmentShipment.count({
            where: { code: { startsWith: prefix } },
          });
          const next = count + 1 + attempt; // se conflitou, tenta count+2, count+3...
          const code = `${prefix}${String(next).padStart(6, '0')}`;
          // Antes de criar, faz outra checagem: já existe shipment OPEN do par?
          // (alguém ganhou a corrida e criou). Se sim, reaproveita.
          const racing = await (this.prisma as any).realignmentShipment.findFirst({
            where: {
              fromStoreCode: o.lojaOrigemCode,
              toStoreCode: o.lojaDestinoCode,
              status: 'open',
            },
          });
          if (racing) {
            shipment = racing;
            this.logger.log(`[markAsSent] reusing concurrent shipment ${racing.code}`);
            break;
          }
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
          this.logger.log(`[markAsSent] created shipment ${code} (attempt ${attempt + 1})`);
          break;
        } catch (e: any) {
          lastErr = e;
          // Prisma P2002 = unique constraint violation
          const isUniqueErr =
            e?.code === 'P2002' ||
            String(e?.message || '').toLowerCase().includes('unique');
          if (!isUniqueErr) {
            this.logger.error(`[markAsSent] step=createShipment failed: ${e?.message}`);
            throw new BadRequestException(`Erro ao criar remessa: ${e?.message}`);
          }
          // Conflito de unique — vai pro próximo attempt
          this.logger.warn(`[markAsSent] race on shipment code, retrying (${attempt + 1}/10)`);
        }
      }
      if (!shipment) {
        throw new BadRequestException(
          `Erro ao criar remessa após 10 tentativas: ${lastErr?.message}`,
        );
      }
    }

    // Usa SQL raw pra evitar dependência do Prisma Client estar atualizado
    // com os campos realignmentStatus/realignmentSentAt/shipmentId (que são
    // novos e podem ainda não estar no client gerado em produção).
    let updated: any;
    try {
      await this.prisma.$executeRaw`
        UPDATE transfer_orders
        SET realignment_status = 'sent',
            realignment_sent_at = ${now},
            realignment_sent_by_user_id = ${input.userId ?? null},
            shipment_id = ${shipment.id}
        WHERE id = ${o.id}
      `;
      updated = { id: o.id };
      this.logger.log(`[markAsSent] OK transferId=${o.id} shipmentId=${shipment.id}`);
    } catch (e: any) {
      this.logger.error(`[markAsSent] step=updateOrder failed: ${e?.message}`);
      throw new BadRequestException(
        `Erro ao atualizar ordem: ${e?.message}. Provável: rodar 'prisma db push' no Railway pra criar colunas novas.`,
      );
    }

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
    // Usa findCodigoByRefCorTam (método canônico, já trata duplicidade Wincred
    // priorizando CODIGO com estoque) em vez de searchByRef + find — assim o
    // SKU gravado na obrigação reflete o produto VIVO no estoque, e o preço
    // puxado bate com a peça que realmente saiu.
    let preco = 0;
    let sku: string | null = null;
    try {
      sku = await this.erp.findCodigoByRefCorTam(order.refCode, order.cor || null, order.tamanho || null);
      if (sku) {
        const priceMap = await this.erp.getProductPricesBySkus([sku]);
        preco = priceMap.get(sku) || 0;
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
   * Regras (atualizadas pra modelo de Shipment):
   *   - Só a própria loja origem pode reverter.
   *   - Só reverte se estiver `sent`.
   *   - Se a ordem está vinculada a uma remessa, ela só pode voltar se a
   *     remessa ainda está `open` (mercadoria ainda não saiu da loja).
   *     Se a remessa já foi `closed`/`sent`/`received`, BLOQUEIA — caso
   *     contrário ficaria estoque furado e obrigação financeira órfã.
   *   - Cancela obrigações financeiras pendentes vinculadas a essa ordem
   *     (caso edge: registros antigos do modelo anterior, ou se algum
   *     fluxo paralelo criou obrigação).
   *   - Limpa `realignmentSentAt`, `realignmentSentByUserId` e `shipmentId`.
   *   - Emite socket pra retaguarda + outros dispositivos da loja.
   */
  /**
   * Lista TODOS os itens reportados como "não encontrado" pela loja origem.
   * Usado pela tela admin /retaguarda/realinhamento/nao-encontrados.
   * Agrupa por REF pra facilitar análise.
   */
  async listNotFound() {
    const rows: any[] = await this.prisma.$queryRaw`
      SELECT id, tipo, ref_code as "refCode", descricao, cor, tamanho,
             qty_origem as "qtyOrigem",
             loja_origem_code as "lojaOrigemCode",
             loja_origem_name as "lojaOrigemName",
             loja_destino_code as "lojaDestinoCode",
             loja_destino_name as "lojaDestinoName",
             solicitante_nome as "solicitanteNome",
             realignment_not_found_at as "notFoundAt",
             realignment_not_found_note as "notFoundNote",
             created_at as "createdAt"
        FROM transfer_orders
       WHERE realignment_status = 'not_found'
       ORDER BY realignment_not_found_at DESC
       LIMIT 500
    `;
    return rows.map((r) => ({
      ...r,
      notFoundAt: r.notFoundAt ? new Date(r.notFoundAt).toISOString() : null,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    }));
  }

  /**
   * Cancela definitivamente um item "não encontrado" (status='cancelled').
   * Não tenta mais — desiste.
   */
  async cancelNotFound(transferId: string) {
    await this.prisma.$executeRaw`
      UPDATE transfer_orders
      SET realignment_status = 'cancelled'
      WHERE id = ${transferId} AND realignment_status = 'not_found'
    `;
    return { ok: true, id: transferId };
  }

  /**
   * Devolve item "não encontrado" pra fila pendente (loja tenta de novo).
   * Útil quando o problema foi resolvido (peça foi achada, etiqueta corrigida).
   */
  async restoreNotFound(transferId: string) {
    await this.prisma.$executeRaw`
      UPDATE transfer_orders
      SET realignment_status = NULL,
          realignment_not_found_at = NULL,
          realignment_not_found_note = NULL,
          realignment_not_found_by_user_id = NULL
      WHERE id = ${transferId} AND realignment_status = 'not_found'
    `;
    return { ok: true, id: transferId };
  }

  /**
   * Troca a loja ORIGEM de um item não encontrado pra outra loja que tem
   * estoque. Reseta status. Loja nova vai ver na fila dela na próxima recarga.
   */
  async swapOriginStore(input: {
    transferId: string;
    newOriginCode: string;
    newOriginName?: string;
  }) {
    if (!input.newOriginCode) {
      throw new BadRequestException('Loja origem nova é obrigatória');
    }
    // Busca nome da loja se não veio
    let name = input.newOriginName;
    if (!name) {
      const store = await this.prisma.store.findFirst({
        where: { code: input.newOriginCode },
        select: { name: true },
      });
      name = store?.name || input.newOriginCode;
    }
    await this.prisma.$executeRaw`
      UPDATE transfer_orders
      SET loja_origem_code = ${input.newOriginCode},
          loja_origem_name = ${name},
          realignment_status = NULL,
          realignment_not_found_at = NULL,
          realignment_not_found_note = NULL,
          realignment_not_found_by_user_id = NULL
      WHERE id = ${input.transferId}
    `;
    return { ok: true, id: input.transferId, newOrigin: input.newOriginCode };
  }

  /**
   * Loja origem reporta que NÃO encontrou a peça fisicamente. Não é erro
   * operacional — é informação pra matriz revisar (estoque divergente,
   * peça sumida, etiqueta errada, etc).
   *
   * Status: realignment_status = 'not_found' + grava motivo + timestamp.
   * Item sai da fila de pendentes mas APARECE na visão admin pra revisão.
   */
  async reportNotFound(input: {
    transferId: string;
    storeId: string;
    userId?: string;
    motivo: string;
  }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, code: true },
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    // Verifica que a ordem é da loja
    const rows: any[] = await this.prisma.$queryRaw`
      SELECT id, tipo, ref_code as "refCode",
             loja_origem_code as "lojaOrigemCode",
             loja_destino_code as "lojaDestinoCode",
             realignment_status as "realignmentStatus"
      FROM transfer_orders
      WHERE id = ${input.transferId}
      LIMIT 1
    `;
    const order = rows[0];
    if (!order) throw new NotFoundException('Ordem não encontrada');
    if (order.tipo !== 'REALINHAMENTO')
      throw new BadRequestException('Ordem não é de realinhamento');
    if (order.lojaOrigemCode !== store.code)
      throw new ForbiddenException('Essa ordem não é da sua loja');
    if (order.realignmentStatus === 'sent')
      throw new BadRequestException('Item já foi enviado — não dá pra reportar como não encontrado');

    const motivo = String(input.motivo || '').trim();
    const now = new Date();
    try {
      await this.prisma.$executeRaw`
        UPDATE transfer_orders
        SET realignment_status = 'not_found',
            realignment_not_found_at = ${now},
            realignment_not_found_note = ${motivo || null},
            realignment_not_found_by_user_id = ${input.userId ?? null}
        WHERE id = ${input.transferId}
      `;
      this.logger.log(
        `[reportNotFound] OK transferId=${input.transferId} ref=${order.refCode} motivo="${motivo}"`,
      );
    } catch (e: any) {
      this.logger.error(`[reportNotFound] failed: ${e?.message}`);
      throw new BadRequestException(
        `Erro ao reportar peça não encontrada: ${e?.message}. Provável: rodar 'prisma db push' no Railway.`,
      );
    }

    return { ok: true, id: input.transferId, reportedAt: now.toISOString() };
  }

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
        shipmentId: true,
      } as any,
    });
    if (!order) throw new NotFoundException('Ordem não encontrada');
    if (order.tipo !== 'REALINHAMENTO')
      throw new BadRequestException('Ordem não é de realinhamento');
    if (order.lojaOrigemCode !== store.code)
      throw new ForbiddenException('Essa ordem não é da sua loja');
    if (order.realignmentStatus !== 'sent')
      throw new BadRequestException('Ordem não está marcada como enviada');

    // ── Guarda Shipment ──
    // Se ordem está numa remessa, só permite reverter se a remessa ainda
    // está OPEN. Se já fechou (mercadoria saiu), bloqueia — admin tem que
    // resolver manualmente (devolução, cancelamento de obrigação, etc).
    const shipmentId = (order as any).shipmentId as string | null;
    if (shipmentId) {
      const shipment = await (this.prisma as any).realignmentShipment.findUnique({
        where: { id: shipmentId },
        select: { id: true, code: true, status: true },
      });
      if (shipment && shipment.status !== 'open') {
        throw new BadRequestException(
          `Remessa ${shipment.code} já foi fechada (status: ${shipment.status}). ` +
            `Não dá pra reverter — mercadoria já saiu da loja. Fale com a matriz pra resolver.`,
        );
      }
    }

    // ── Cancela obrigações pendentes vinculadas (se existirem) ──
    // No modelo novo, obrigações só são criadas em closeAndSend, então
    // ordens em remessa OPEN não devem ter obrigação ainda. Mas se vier
    // de registro antigo (modelo anterior), cancela.
    try {
      const cancelled = await (this.prisma as any).interStoreObligation.updateMany({
        where: {
          transferOrderId: order.id,
          status: 'pending',
        },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: 'Reverted by store (markAsUnsent)',
        },
      });
      if (cancelled.count > 0) {
        this.logger.log(
          `[realignment] Cancelou ${cancelled.count} obrigação(ões) órfã(s) ao reverter ordem ${order.id}`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `[realignment] falha ao cancelar obrigações ao reverter ${order.id}: ${(e as Error).message}`,
      );
    }

    const updated = await this.prisma.transferOrder.update({
      where: { id: order.id },
      data: {
        realignmentStatus: 'pending',
        realignmentSentAt: null,
        realignmentSentByUserId: null,
        shipmentId: null,
      } as any,
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
