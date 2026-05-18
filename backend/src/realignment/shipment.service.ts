import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';

/**
 * RealignmentShipmentService — gerencia o ciclo de REMESSA entre lojas.
 *
 * Diferente do markAsSent antigo (item-a-item), agora a vendedora MONTA uma
 * remessa adicionando peças, e quando termina FECHA → vira código único e
 * baixa estoque Giga em batch. Loja destino bipa cada peça e dá entrada.
 *
 * Convenção: TODOS endpoints só pra role=store (vendedora) ou admin.
 * O role check fica no controller.
 */
@Injectable()
export class RealignmentShipmentService {
  private readonly logger = new Logger(RealignmentShipmentService.name);

  // ⚡ Cache de SKUs por remessa — populado no 1º bipe, reutilizado nos próximos.
  // Reduz bipe de ~150ms pra ~30ms (zero queries Wincred após o 1º).
  private readonly skuCache = new Map<string, { skuMap: Map<string, string>; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 30 * 60 * 1000;
  private invalidateSkuCache(shipmentId: string) { this.skuCache.delete(shipmentId); }

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly gateway: RealtimeGateway,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // GERAÇÃO DE CÓDIGO (REM-YYYY-NNNNNN sequencial global)
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Gera o próximo código de remessa baseado no MAIOR código existente do ano
   * (não em `count()`). Razão: se uma remessa for deletada, count() retorna
   * um número que JÁ EXISTE → UNIQUE constraint violation no INSERT.
   *
   * Estratégia: pega último código com MAX(numero) e soma 1.
   * Se houver race com outra vendedora, o caller faz retry com nextSuffix.
   */
  private async generateShipmentCode(suffix = 0): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `REM-${year}-`;
    // Pega o último código existente do ano (ordenando desc por code).
    // Como o code tem padding de 6 zeros, ordenação alfabética = numérica.
    const last = await (this.prisma as any).realignmentShipment.findFirst({
      where: { code: { startsWith: prefix } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    let lastNum = 0;
    if (last?.code) {
      const m = String(last.code).match(/-(\d+)$/);
      if (m) lastNum = parseInt(m[1], 10) || 0;
    }
    const nextNum = lastNum + 1 + suffix;
    return `${prefix}${String(nextNum).padStart(6, '0')}`;
  }

  /**
   * Cria a remessa com retry — se 2 vendedoras criarem simultâneo, o INSERT
   * pode falhar com UNIQUE constraint. Tenta até 5x com sufixo crescente.
   */
  private async createShipmentWithRetry(data: {
    fromStoreCode: string;
    fromStoreName: string;
    toStoreCode: string;
    toStoreName: string;
    openedByUserId?: string | null;
  }): Promise<any> {
    let lastErr: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = await this.generateShipmentCode(attempt);
      try {
        return await (this.prisma as any).realignmentShipment.create({
          data: {
            code,
            fromStoreCode: data.fromStoreCode,
            fromStoreName: data.fromStoreName,
            toStoreCode: data.toStoreCode,
            toStoreName: data.toStoreName,
            status: 'open',
            openedByUserId: data.openedByUserId ?? null,
          },
        });
      } catch (e: any) {
        lastErr = e;
        // P2002 = unique constraint violation no Prisma. Tenta próximo número.
        const isUnique = e?.code === 'P2002' || /Unique constraint/i.test(e?.message || '');
        if (!isUnique) throw e;
        this.logger.warn(
          `[shipment] code ${code} colidiu (tentativa ${attempt + 1}/5), tentando próximo`,
        );
      }
    }
    throw lastErr || new Error('Falha ao gerar código de remessa após 5 tentativas');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LOJA ORIGEM — montar e enviar remessa
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lista as remessas ABERTAS da loja origem (ainda em montagem).
   * Cada par origem→destino só pode ter 1 remessa aberta por vez —
   * a vendedora vai acumulando peças nela até fechar e enviar.
   */
  async listOpenShipmentsForOrigin(storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { code: true, name: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipments = await (this.prisma as any).realignmentShipment.findMany({
      where: { fromStoreCode: (store as any).code, status: 'open' },
      orderBy: { openedAt: 'asc' },
    });

    // Pra cada shipment, conta quantos itens já estão dentro
    const result = await Promise.all(
      shipments.map(async (s: any) => {
        const items = await this.prisma.transferOrder.findMany({
          where: { shipmentId: s.id } as any,
          select: {
            id: true,
            refCode: true,
            cor: true,
            tamanho: true,
            qtyOrigem: true,
            descricao: true,
          } as any,
        });
        return { ...s, items };
      }),
    );

    return result;
  }

  /**
   * Adiciona uma TransferOrder a uma remessa (criando ou reutilizando a
   * remessa aberta do par origem→destino).
   *
   * Vendedora chama esse método uma vez por peça que está separando.
   * Não baixa Giga ainda — só linka ao shipment.
   */
  async addItemToShipment(input: {
    transferOrderId: string;
    storeId: string;
    userId?: string;
  }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, code: true, name: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const order = await this.prisma.transferOrder.findUnique({
      where: { id: input.transferOrderId },
      select: {
        id: true,
        tipo: true,
        lojaOrigemCode: true,
        lojaOrigemName: true,
        lojaDestinoCode: true,
        lojaDestinoName: true,
        realignmentStatus: true,
        shipmentId: true,
        refCode: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
      } as any,
    });
    if (!order) throw new NotFoundException('Ordem não encontrada');
    const o = order as any;
    if (o.tipo !== 'REALINHAMENTO')
      throw new BadRequestException('Ordem não é de realinhamento');
    if (o.lojaOrigemCode !== (store as any).code)
      throw new ForbiddenException('Essa ordem não é da sua loja');
    if (o.realignmentStatus === 'sent')
      throw new BadRequestException('Item já está em uma remessa');
    if (o.realignmentStatus === 'received')
      throw new BadRequestException('Item já foi recebido');

    // Procura remessa OPEN do par origem→destino
    let shipment = await (this.prisma as any).realignmentShipment.findFirst({
      where: {
        fromStoreCode: o.lojaOrigemCode,
        toStoreCode: o.lojaDestinoCode,
        status: 'open',
      },
    });

    // Se não tem aberta, cria nova (com retry em caso de colisão de code)
    if (!shipment) {
      shipment = await this.createShipmentWithRetry({
        fromStoreCode: o.lojaOrigemCode,
        fromStoreName: o.lojaOrigemName,
        toStoreCode: o.lojaDestinoCode,
        toStoreName: o.lojaDestinoName,
        openedByUserId: input.userId ?? null,
      });
      this.logger.log(`[shipment] Nova remessa ${shipment.code} aberta ${o.lojaOrigemCode}→${o.lojaDestinoCode}`);
    }

    // Marca item como sent + linka ao shipment
    const updated = await this.prisma.transferOrder.update({
      where: { id: o.id },
      data: {
        realignmentStatus: 'sent',
        realignmentSentAt: new Date(),
        realignmentSentByUserId: input.userId ?? null,
        shipmentId: shipment.id,
      } as any,
    });

    return { ok: true, shipmentId: shipment.id, shipmentCode: shipment.code, transferOrderId: (updated as any).id };
  }

  /**
   * Remove um item de uma remessa OPEN (vendedora errou, quer tirar).
   * Volta status pra pending.
   */
  /**
   * Pré-verifica estoque Giga pra todos os items da remessa, SEM fazer UPDATE.
   * Retorna lista de items com problema (estoque insuficiente). Usado pelo
   * fluxo de fechamento ANTES da transação real, e pelo endpoint de precheck
   * que o frontend chama pra mostrar UI de problemas.
   *
   * @param items items da remessa (transferOrders) — fonte da verdade
   * @param stockItems items já com SKU resolvido pelo findCodigoByRefCorTam
   */
  private async precheckStockForShipment(
    items: Array<{ id: string; refCode: string; cor: string | null; tamanho: string | null; qtyOrigem: number }>,
    stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }>,
  ): Promise<{
    problemas: Array<{
      transferOrderId: string;
      refCode: string;
      cor: string | null;
      tamanho: string | null;
      qtyRequerida: number;
      sku: string;
      storeCode: string;
      estoqueGiga: number;
    }>;
  }> {
    const problemas: Array<any> = [];
    // Mapeia transferOrders por (refCode, cor, tamanho) pra associar com stockItems
    const itemByKey = new Map<string, typeof items[0]>();
    for (const it of items) {
      const key = `${it.refCode}::${it.cor || ''}::${it.tamanho || ''}`;
      itemByKey.set(key, it);
    }

    // FIX 2 (root cause): o Giga tem MÚLTIPLOS CODIGOs cadastrados pra MESMA
    // peça (REF+COR+TAM). `findCodigoByRefCorTam` retorna só UM (LIMIT 1) — se
    // esse SKU está zerado mas OUTRO SKU da mesma peça tem estoque, o precheck
    // bloqueava tudo mesmo com peça física disponível.
    //
    // Solução: agrupa stockItems por (refCode, cor, tamanho) e soma a qty pedida
    // de cada grupo, depois pra cada grupo busca SOMA de TODOS os SKUs daquela
    // peça via getStockByRefCorTamInStore.

    // Agrupa stockItems por (refCode, cor, tamanho) usando o item original pra
    // pegar cor/tamanho (stockItems não tem essas infos diretamente).
    const stockByItem = new Map<string, { item: typeof items[0]; qtyTotal: number; sku: string; storeCode: string }>();
    for (const si of stockItems) {
      const itemMatch = items.find((it) => it.refCode === si.refCode);
      if (!itemMatch) continue;
      const key = `${si.refCode}::${itemMatch.cor || ''}::${itemMatch.tamanho || ''}::${si.storeCode}`;
      const prev = stockByItem.get(key);
      if (prev) {
        prev.qtyTotal += si.qty;
      } else {
        stockByItem.set(key, {
          item: itemMatch,
          qtyTotal: si.qty,
          sku: si.sku,
          storeCode: si.storeCode,
        });
      }
    }

    // BATCH: 1 query so pra resolver REF+COR+TAM → estoque (em vez de N queries seriais)
    const batchInput: Array<{ refCode: string; cor: string | null; tamanho: string | null; storeCode: string }> = [];
    for (const grp of stockByItem.values()) {
      batchInput.push({
        refCode: grp.item.refCode,
        cor: grp.item.cor,
        tamanho: grp.item.tamanho,
        storeCode: grp.storeCode,
      });
    }
    let batchResult = new Map<string, { totalQty: number; codigos: string[] }>();
    try {
      batchResult = await this.erp.getStockByRefCorTamInStoreBatch(batchInput);
    } catch (e) {
      this.logger.warn(`precheck: getStockByRefCorTamInStoreBatch falhou: ${(e as Error).message} — caindo pra leitura individual`);
    }

    for (const grp of stockByItem.values()) {
      const key = `${String(grp.item.refCode).trim().toUpperCase()}::${String(grp.item.cor || '').trim().toUpperCase()}::${String(grp.item.tamanho || '').trim().toUpperCase()}::${String(grp.storeCode).trim()}`;
      let estoqueGiga = 0;
      const found = batchResult.get(key);
      if (found) {
        estoqueGiga = found.totalQty;
      } else {
        // Fallback individual (caso o batch tenha falhado)
        try {
          const r = await this.erp.getStockByRefCorTamInStore(
            grp.item.refCode,
            grp.item.cor,
            grp.item.tamanho,
            grp.storeCode,
          );
          estoqueGiga = r.totalQty;
        } catch (e) {
          this.logger.warn(`precheck fallback ${grp.item.refCode}: ${(e as Error).message}`);
        }
      }
      if (estoqueGiga < grp.qtyTotal) {
        problemas.push({
          transferOrderId: grp.item.id,
          refCode: grp.item.refCode,
          cor: grp.item.cor,
          tamanho: grp.item.tamanho,
          qtyRequerida: grp.qtyTotal,
          sku: grp.sku,
          storeCode: grp.storeCode,
          estoqueGiga,
        });
      }
    }
    return { problemas };
  }

  /**
   * Versão pública do precheck — usado pelo frontend ANTES de tentar fechar
   * a remessa. Retorna lista de items com estoque problemático pra UI mostrar
   * antes de chamar closeAndSend.
   */
  async precheckCloseShipment(input: { shipmentId: string; storeId: string }) {
    const tStart = Date.now();
    const store = await this.prisma.store.findUnique({ where: { id: input.storeId } });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.fromStoreCode !== (store as any).code)
      throw new ForbiddenException('Essa remessa não é da sua loja');
    if (shipment.status !== 'open')
      throw new BadRequestException(`Remessa não está aberta (status=${shipment.status})`);

    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id } as any,
      select: { id: true, refCode: true, codigoBipado: true, cor: true, tamanho: true, qtyOrigem: true } as any,
    });
    if (!items.length) return { ok: true, totalItems: 0, problemas: [] };

    // OTIMIZADO: items com codigoBipado vao DIRETO (zero query). Os outros
    // resolvem via 1 query batch unica. Antes: loop sync com N queries seriais
    // = ~3-5 segundos pra 45 itens. Agora: ~150ms total.
    const tResolve = Date.now();
    const stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }> = [];
    const unresolved: Array<{ transferOrderId: string; refCode: string; cor: string | null; tamanho: string | null }> = [];

    const itemsSemCodigoBipado: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      if (!it.codigoBipado) {
        itemsSemCodigoBipado.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }

    let batchSkus = new Map<string, string>();
    if (itemsSemCodigoBipado.length > 0) {
      try {
        batchSkus = await this.erp.batchFindCodigosByRefCorTam(itemsSemCodigoBipado);
      } catch (e) {
        this.logger.warn(`[precheck] batchFindCodigosByRefCorTam falhou: ${(e as Error).message}`);
      }
    }
    const keyOf = (ref: string, cor: string | null, tam: string | null) =>
      `${String(ref).trim().toUpperCase()}|${String(cor || '').trim().toUpperCase()}|${String(tam || '').trim().toUpperCase()}`;

    for (const it of items as any[]) {
      try {
        let sku: string | null = it.codigoBipado || null;
        if (!sku) sku = batchSkus.get(keyOf(it.refCode, it.cor, it.tamanho)) || null;
        if (!sku) {
          unresolved.push({ transferOrderId: it.id, refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
          continue;
        }
        stockItems.push({ sku, qty: it.qtyOrigem || 1, storeCode: shipment.fromStoreCode, refCode: it.refCode });
      } catch {
        unresolved.push({ transferOrderId: it.id, refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }
    this.logger.log(`[precheck] resolveSku ${items.length} items em ${Date.now() - tResolve}ms`);

    const tStock = Date.now();
    const { problemas } = await this.precheckStockForShipment(items as any[], stockItems);
    this.logger.log(`[precheck] stockCheck em ${Date.now() - tStock}ms. TOTAL: ${Date.now() - tStart}ms`);
    // `ok` agora considera SO `unresolved` (SKU nao encontrado) como bloqueador.
    // Estoque divergente (problemas) e apenas AVISO - backend ja roda
    // closeAndSend com allowNegative, peca em maos prevalece.
    return {
      ok: unresolved.length === 0,
      totalItems: items.length,
      unresolved,
      problemas,
    };
  }

  async removeItemFromShipment(input: { transferOrderId: string; storeId: string }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const order = await this.prisma.transferOrder.findUnique({
      where: { id: input.transferOrderId },
      select: {
        id: true,
        lojaOrigemCode: true,
        shipmentId: true,
        realignmentStatus: true,
      } as any,
    });
    if (!order) throw new NotFoundException('Ordem não encontrada');
    const o = order as any;
    if (o.lojaOrigemCode !== (store as any).code)
      throw new ForbiddenException('Essa ordem não é da sua loja');
    if (!o.shipmentId) throw new BadRequestException('Item não está em remessa');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: o.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.status !== 'open')
      throw new BadRequestException('Remessa já foi fechada — não pode remover item');

    await this.prisma.transferOrder.update({
      where: { id: o.id },
      data: {
        realignmentStatus: 'pending',
        realignmentSentAt: null,
        realignmentSentByUserId: null,
        shipmentId: null,
      } as any,
    });

    return { ok: true };
  }

  /**
   * FECHA a remessa: status → in_transit, baixa Giga origem em batch,
   * emite socket pra loja destino mostrar alerta.
   *
   * NÃO permite fechar remessa vazia (precisa ter pelo menos 1 item).
   */
  async closeAndSend(input: { shipmentId: string; storeId: string; userId?: string }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.fromStoreCode !== (store as any).code)
      throw new ForbiddenException('Essa remessa não é da sua loja');
    if (shipment.status !== 'open')
      throw new BadRequestException(`Remessa não está aberta (status=${shipment.status})`);

    // Itens da remessa
    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id } as any,
      select: {
        id: true,
        refCode: true,
        codigoBipado: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
      } as any,
    });
    if (!items.length) throw new BadRequestException('Remessa vazia — adicione itens antes de fechar');

    // Resolve SKU de cada item — OTIMIZADO: items com codigoBipado direto,
    // items sem fazem 1 ÚNICA query batch pra resolver todos de uma vez.
    //
    // ANTES (lento): loop sync com N queries MySQL serial pelo
    // findCodigoByRefCorTam — uma remessa com 114 itens fazia 114 queries
    // sequenciais, ~50ms cada = ~5-6 segundos só pra resolver SKUs.
    // AGORA (rápido): items com codigoBipado vão direto (zero query); items
    // sem usam batchFindCodigosByRefCorTam (1 query SQL com OR pra todos).
    const tStart = Date.now();
    const stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }> = [];
    const unresolved: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];

    const itemsSemCodigoBipado: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      if (!it.codigoBipado) {
        itemsSemCodigoBipado.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }

    let batchSkus = new Map<string, string>();
    if (itemsSemCodigoBipado.length > 0) {
      try {
        batchSkus = await this.erp.batchFindCodigosByRefCorTam(itemsSemCodigoBipado);
      } catch (e) {
        this.logger.warn(
          `[closeAndSend] batchFindCodigosByRefCorTam falhou: ${(e as Error).message}. ` +
          `Caindo pra resolucao individual.`,
        );
      }
    }
    const keyOf = (ref: string, cor: string | null, tam: string | null) =>
      `${String(ref).trim().toUpperCase()}|${String(cor || '').trim().toUpperCase()}|${String(tam || '').trim().toUpperCase()}`;

    for (const it of items as any[]) {
      try {
        let sku: string | null = it.codigoBipado || null;
        if (!sku) {
          sku = batchSkus.get(keyOf(it.refCode, it.cor, it.tamanho)) || null;
          if (!sku) {
            sku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho);
          }
        }
        if (!sku) {
          unresolved.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
          continue;
        }
        stockItems.push({
          sku,
          qty: it.qtyOrigem || 1,
          storeCode: shipment.fromStoreCode,
          refCode: it.refCode,
        });
      } catch (e) {
        unresolved.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }
    this.logger.log(
      `[closeAndSend] resolveSku: ${items.length} items em ${Date.now() - tStart}ms ` +
      `(${itemsSemCodigoBipado.length} via batch, ${items.length - itemsSemCodigoBipado.length} via codigoBipado)`,
    );

    // POLITICA: itens unresolved (REF+COR+TAM nao casam no Giga) NAO bloqueiam mais
    // o fechamento. Vendedora ja confirmou peca em maos clicando FORCAR FECHAMENTO.
    // Esses itens passam adiante (status sent + shipment in_transit) MAS nao baixam
    // estoque Giga na origem (porque nao tem SKU pra baixar). Admin acompanha pelo
    // log e pode resolver depois.
    //
    // ANTES: bloqueava com BadRequestException -> vendedora nao conseguia fechar
    // remessas com cadastro divergente, pecas paravam de circular.
    if (unresolved.length) {
      this.logger.warn(
        `[closeAndSend] ${shipment.code}: ${unresolved.length} item(ns) sem SKU resolvido - ` +
        `seguem na remessa SEM baixa Giga. Itens: ` +
        unresolved.map((u) => `${u.refCode} ${u.cor || ''}/${u.tamanho || ''}`).join(', '),
      );
    }

    // Pré-verifica estoque antes de iniciar transação.
    const tPrecheck = Date.now();
    const precheck = await this.precheckStockForShipment(items as any[], stockItems);
    this.logger.log(`[closeAndSend] precheck: ${Date.now() - tPrecheck}ms`);
    if (precheck.problemas.length > 0) {
      this.logger.warn(
        `closeAndSend ${shipment.code}: ${precheck.problemas.length} item(ns) com estoque insuficiente no Giga - fechando mesmo assim (allowNegative). Detalhes: ${JSON.stringify(precheck.problemas).slice(0, 500)}`,
      );
    }

    // BAIXA estoque Giga origem em transação (todos ou nada).
    const tDecrease = Date.now();
    const result = await this.erp.decreaseStock(
      stockItems.map((s) => ({ sku: s.sku, qty: s.qty, storeCode: s.storeCode })),
      { allowNegative: true, skipNotFound: true },
    );
    const appliedCount = result.applied?.length || 0;
    this.logger.log(
      `[closeAndSend] decreaseStock: ${Date.now() - tDecrease}ms ` +
      `(${stockItems.length} SKUs solicitados, ${appliedCount} aplicados)`,
    );
    // ALERTA: se decreaseStock retornou success mas NENHUM SKU foi aplicado,
    // significa que o estoque não baixou (skipNotFound silenciou). Causa
    // comum: storeCode não bate com formato LOJA do Giga, ou todos SKUs
    // estavam zerados/inexistentes na tabela estoque.
    if (!result.success) {
      throw new BadRequestException(
        `Falha ao baixar estoque Giga origem: ${result.error}. Remessa NÃO foi fechada.`,
      );
    }
    if (stockItems.length > 0 && appliedCount === 0) {
      this.logger.error(
        `[closeAndSend] ${shipment.code}: decreaseStock retornou success mas 0 SKUs aplicados! ` +
        `Possível mismatch de storeCode. fromStoreCode=${shipment.fromStoreCode} ` +
        `SKUs=[${stockItems.slice(0, 5).map((s) => s.sku).join(',')}${stockItems.length > 5 ? '...' : ''}]. ` +
        `Use POST /realignment/shipments/:id/reprocess-stock pra reaplicar.`,
      );
    }

    // Atualiza shipment → in_transit + marca stockDecreasedAt apenas se aplicou
    const now = new Date();
    const totalQty = stockItems.reduce((s, x) => s + x.qty, 0);
    await (this.prisma as any).realignmentShipment.update({
      where: { id: shipment.id },
      data: {
        status: 'in_transit',
        sentAt: now,
        sentByUserId: input.userId ?? null,
        totalItems: items.length,
        totalQty,
        // Só marca se realmente aplicou — assim reprocess sabe quem precisa
        stockDecreasedAt: appliedCount > 0 ? now : null,
      } as any,
    });

    // ── FINANCEIRO: cria obrigações p/ itens entre grupos diferentes (REDE↔FILIAL)
    // Captura preço Giga em batch (via SKU já resolvido acima) pra ser snapshot.
    try {
      await this.createObligationsForShipment(shipment, items, stockItems, now);
    } catch (e) {
      this.logger.warn(
        `[shipment] falha criando obrigações financeiras (não bloqueante): ${(e as Error).message}`,
      );
    }

    // Emite socket pra loja DESTINO
    try {
      const destStore = await this.prisma.store.findUnique({
        where: { code: shipment.toStoreCode },
        select: { id: true } as any,
      });
      if (destStore) {
        this.gateway.emitToStore((destStore as any).id, 'shipment:incoming', {
          shipmentId: shipment.id,
          code: shipment.code,
          fromStoreCode: shipment.fromStoreCode,
          fromStoreName: shipment.fromStoreName,
          totalItems: items.length,
          totalQty,
          sentAt: now.toISOString(),
        });
      }
    } catch (e) {
      this.logger.warn(`[shipment] falha emitindo socket: ${(e as Error).message}`);
    }

    this.logger.log(
      `[shipment] ${shipment.code} fechada e enviada: ${items.length} itens, ${totalQty} peças, ` +
        `Giga ${shipment.fromStoreCode} baixou ${result.applied.length} SKUs`,
    );

    return { ok: true, code: shipment.code, totalItems: items.length, totalQty };
  }

  /**
   * Cria obrigações financeiras pra todos os itens do shipment quando
   * as lojas envolvidas são de grupos diferentes (REDE↔FILIAL).
   *
   * Snapshot do preço Giga é capturado em batch. Mês de referência = mês
   * da data de envio. Convenção: TO (destino) paga FROM (origem).
   */
  private async createObligationsForShipment(
    shipment: any,
    items: any[],
    stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }>,
    sentAt: Date,
  ) {
    // Carrega tipo das 2 lojas (snapshot — preserva histórico)
    const [from, to] = await Promise.all([
      this.prisma.store.findUnique({
        where: { code: shipment.fromStoreCode },
        select: { code: true, name: true, tipo: true } as any,
      }),
      this.prisma.store.findUnique({
        where: { code: shipment.toStoreCode },
        select: { code: true, name: true, tipo: true } as any,
      }),
    ]);
    const fromTipo = (from as any)?.tipo || 'REDE';
    const toTipo = (to as any)?.tipo || 'REDE';

    // Mesmo grupo → sem cobrança
    if (fromTipo === toTipo) return;

    // Busca preços Giga em batch
    const skus = stockItems.map((s) => s.sku);
    const priceMap = await this.erp.getProductPricesBySkus(skus);

    // Mapa REF→SKU pra encontrar item correto
    const refToSku = new Map<string, string>();
    for (const s of stockItems) refToSku.set(s.refCode, s.sku);

    // Mês de referência
    const mesReferencia = `${sentAt.getFullYear()}-${String(sentAt.getMonth() + 1).padStart(2, '0')}`;

    for (const it of items as any[]) {
      const sku = refToSku.get(it.refCode);
      const preco = sku ? priceMap.get(sku) || 0 : 0;
      const qty = it.qtyOrigem || 1;
      const precoTotal = preco * qty;
      const divisor = 2.5;
      const valorObrigacao = precoTotal / divisor;

      await (this.prisma as any).interStoreObligation.create({
        data: {
          transferOrderId: it.id,
          fromStoreCode: shipment.fromStoreCode,
          fromStoreName: shipment.fromStoreName,
          fromStoreTipo: fromTipo,
          toStoreCode: shipment.toStoreCode,
          toStoreName: shipment.toStoreName,
          toStoreTipo: toTipo,
          refCode: it.refCode,
          sku: sku || null,
          cor: it.cor,
          tamanho: it.tamanho,
          descricao: it.descricao,
          qty,
          precoUnitario: preco,
          precoTotal,
          divisor,
          valorObrigacao,
          mesReferencia,
          status: 'pending',
        },
      });
    }

    this.logger.log(
      `[shipment] ${shipment.code}: ${items.length} obrigações financeiras criadas ` +
        `(${fromTipo}→${toTipo}) mês=${mesReferencia}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LOJA DESTINO — receber e dar entrada
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lista remessas chegando na loja destino (status in_transit).
   * Inclui contagem de itens já bipados pra UI mostrar progresso.
   */
  async listIncomingShipments(storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipments = await (this.prisma as any).realignmentShipment.findMany({
      where: { toStoreCode: (store as any).code, status: 'in_transit' },
      orderBy: { sentAt: 'desc' },
    });

    return shipments;
  }

  /**
   * Detalhe completo de uma remessa (todos os itens com status individual).
   * Usado pela tela de recebimento — vendedora vê o que tem que conferir.
   */
  async getShipmentDetail(input: { shipmentId: string; storeId: string }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.toStoreCode !== (store as any).code)
      throw new ForbiddenException('Essa remessa não é da sua loja');

    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id } as any,
      orderBy: [{ refCode: 'asc' }],
      select: {
        id: true,
        refCode: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
        descricao: true,
        realignmentStatus: true,
        realignmentReceivedAt: true,
        realignmentMissingAt: true,
        realignmentMissingNote: true,
      } as any,
    });

    return { ...shipment, items };
  }

  /**
   * Bipa um item da remessa pra marcar como conferido.
   *
   * A vendedora bipa o EAN/SKU. O sistema procura na lista de itens da
   * remessa um que case por SKU (resolvido via Giga REF+cor+tamanho).
   * Se achar, marca como `received`. Se não, retorna erro com sugestão.
   *
   * Itens já marcados como `received` ou `missing` não podem ser bipados de novo.
   */
  async scanItem(input: { shipmentId: string; sku: string; storeId: string; userId?: string }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.toStoreCode !== (store as any).code)
      throw new ForbiddenException('Essa remessa não é da sua loja');
    if (shipment.status !== 'in_transit')
      throw new BadRequestException(`Remessa não está em trânsito (status=${shipment.status})`);

    const skuBipado = String(input.sku || '').trim();
    if (!skuBipado) throw new BadRequestException('SKU vazio');

    // ⚡ PARALELO: resolveSkuInfo (Wincred) + findMany items (Postgres) rodam
    // ao mesmo tempo — bipe mais rápido (~50-100ms a menos por bipe).
    const [info, items] = await Promise.all([
      this.erp.resolveSkuInfo(skuBipado),
      this.prisma.transferOrder.findMany({
        where: { shipmentId: shipment.id } as any,
        select: {
          id: true,
          refCode: true,
          cor: true,
          tamanho: true,
          realignmentStatus: true,
          codigoBipado: true,
        } as any,
      }),
    ]);
    const skuNormalizado = info?.codigo || skuBipado;

    const stripZeros = (s: string) => String(s || '').trim().replace(/^0+/, '') || '0';
    const norm = (s: any) => String(s ?? '').trim().toUpperCase();
    const skuBipadoStripped = stripZeros(skuNormalizado);

    // === MATCH EM MEMORIA — zero queries MySQL no loop ===
    let matchedItemId: string | null = null;
    let matchedRefCode: string | null = null;
    const pendingItems = (items as any[]).filter(
      (it) => it.realignmentStatus !== 'received' && it.realignmentStatus !== 'missing',
    );

    // E1: match direto via codigoBipado salvo (re-bipe / idempotencia)
    for (const it of pendingItems) {
      if (it.codigoBipado && stripZeros(it.codigoBipado) === skuBipadoStripped) {
        matchedItemId = it.id;
        matchedRefCode = it.refCode;
        break;
      }
    }

    // E2: BATCH lookup Wincred COM CACHE — 1 query no 1º bipe, próximos batem na memória.
    // Usa batchFindAllCodigos (não o que filtra por estoque) — bipagem precisa
    // comparar com TODOS os CODIGOs candidatos. Wincred costuma ter cadastro
    // duplicado (mesma REF+COR+TAM em 2 CODIGOs); a peça física pode ser
    // QUALQUER UM deles, não só o de maior estoque.
    if (!matchedItemId && pendingItems.length > 0) {
      let cached = this.skuCache.get(shipment.id);
      const nowMs = Date.now();
      if (!cached || cached.expiresAt < nowMs) {
        const allCodigosMap = await this.erp.batchFindAllCodigosByRefCorTam(
          (items as any[]).map((it) => ({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho })),
        );
        // Mantém compatibilidade do skuCache (Map<string, string>) gravando
        // todos os CODIGOs separados por vírgula. Match abaixo trata como Set.
        const flatMap = new Map<string, string>();
        for (const [k, set] of allCodigosMap.entries()) {
          flatMap.set(k, Array.from(set).join(','));
        }
        cached = { skuMap: flatMap, expiresAt: nowMs + this.CACHE_TTL_MS };
        this.skuCache.set(shipment.id, cached);
        this.logger.log(`[shipment] cache SKU populado pra ${shipment.code} (${flatMap.size} chaves, ${Array.from(allCodigosMap.values()).reduce((s, set) => s + set.size, 0)} CODIGOs totais)`);
      }
      for (const it of pendingItems) {
        const key = `${norm(it.refCode)}|${norm(it.cor)}|${norm(it.tamanho)}`;
        const allCodigosStr = cached.skuMap.get(key);
        if (!allCodigosStr) continue;
        // Compara com TODOS os CODIGOs candidatos (split por vírgula)
        const candidatos = allCodigosStr.split(',');
        const hit = candidatos.some((c) => stripZeros(c) === skuBipadoStripped);
        if (hit) {
          matchedItemId = it.id;
          matchedRefCode = it.refCode;
          break;
        }
      }
    }

    // E3: fallback LIKE/REF+TAM (cobre REF "12852" vs "12852V", cor "BEGE" vs "XADREZ BEGE").
    // Só roda pros items que sobraram (raro).
    if (!matchedItemId) {
      for (const it of pendingItems) {
        try {
          const itemSku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho);
          if (itemSku && stripZeros(itemSku) === skuBipadoStripped) {
            matchedItemId = it.id;
            matchedRefCode = it.refCode;
            break;
          }
        } catch { /* segue */ }
      }
    }

    if (!matchedItemId) {
      // LOG DETALHADO pra debug — quando bipe não acha, manda TUDO pro Railway log
      this.logger.error(
        `[scanItem] FALHA shipment=${shipment.code} skuBipado=${skuBipado} skuNormalizado=${skuNormalizado} skuStripped=${skuBipadoStripped}`,
      );
      this.logger.error(
        `[scanItem] info Wincred: ${info ? JSON.stringify({ref: info.ref, cor: info.cor, tamanho: info.tamanho, codigo: info.codigo}) : 'NULL'}`,
      );
      this.logger.error(
        `[scanItem] items pendentes (${pendingItems.length}): ${pendingItems.map((it) => `${it.refCode}/${it.cor}/${it.tamanho}[codBip=${it.codigoBipado || '-'}]`).join('; ')}`,
      );
      const cached = this.skuCache.get(shipment.id);
      if (cached) {
        this.logger.error(
          `[scanItem] cache (${cached.skuMap.size} chaves): ${Array.from(cached.skuMap.entries()).slice(0, 10).map(([k, v]) => `${k}=>[${v}]`).join(' | ')}`,
        );
      } else {
        this.logger.error(`[scanItem] cache VAZIO`);
      }
      throw new BadRequestException(
        `SKU ${skuBipado} nao pertence a essa remessa (ou ja foi bipado). ` +
          (info?.ref ? `Resolvido como ${info.ref}/${info.cor || ''}/${info.tamanho || ''}.` : 'SKU nao encontrado no Wincred.'),
      );
    }

    // Salva codigoBipado junto com status — economiza re-resolucao na finalizacao
    await this.prisma.transferOrder.update({
      where: { id: matchedItemId },
      data: {
        realignmentStatus: 'received',
        realignmentReceivedAt: new Date(),
        realignmentReceivedByUserId: input.userId ?? null,
        codigoBipado: skuNormalizado,
      } as any,
    });

    return { ok: true, transferOrderId: matchedItemId, refCode: matchedRefCode };
  }

  /**
   * Marca um item da remessa como FALTANTE (extraviada na remessa).
   * Não dá entrada Giga e CANCELA a obrigação financeira correspondente.
   */
  async markItemMissing(input: {
    shipmentId: string;
    transferOrderId: string;
    storeId: string;
    note?: string;
    userId?: string;
  }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const order = await this.prisma.transferOrder.findUnique({
      where: { id: input.transferOrderId },
      select: { id: true, shipmentId: true, realignmentStatus: true } as any,
    });
    if (!order) throw new NotFoundException('Item não encontrado');
    const o = order as any;
    if (o.shipmentId !== input.shipmentId)
      throw new BadRequestException('Item não pertence a essa remessa');
    if (o.realignmentStatus === 'received')
      throw new BadRequestException('Item já foi recebido — não pode marcar como faltante');

    await this.prisma.transferOrder.update({
      where: { id: o.id },
      data: {
        realignmentStatus: 'missing',
        realignmentMissingAt: new Date(),
        realignmentMissingNote: input.note?.trim() || null,
        realignmentReceivedByUserId: input.userId ?? null,
      } as any,
    });

    // Cancela obrigação financeira correspondente automaticamente
    try {
      await (this.prisma as any).interStoreObligation.updateMany({
        where: { transferOrderId: o.id, status: { in: ['pending', 'closed'] } },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: 'Item faltante no recebimento da remessa',
        },
      });
    } catch (e) {
      this.logger.warn(`[shipment] falha cancelando obrigação de item missing: ${(e as Error).message}`);
    }

    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — visão geral (matriz)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lista TODAS as remessas com filtros opcionais (uso admin).
   * Inclui contagem de itens (total, recebidos, faltantes) já calculada
   * pra UI mostrar progresso sem precisar de N+1 queries no frontend.
   *
   * Filtros:
   *   - status: open | in_transit | received (opcional)
   *   - fromStoreCode (opcional)
   *   - toStoreCode (opcional)
   *   - search: substring no code da remessa (opcional)
   *   - daysAgo: filtra remessas abertas/enviadas nos últimos N dias (default 30)
   */
  // ═══════════════════════════════════════════════════════════════════════
  // REPROCESSAMENTO DE ESTOQUE — remessas fechadas que NÃO baixaram Giga
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Lista remessas FECHADAS recentes pra reprocessamento manual de estoque.
   * Inclui TODAS as in_transit/received do periodo — admin escolhe quais
   * reprocessar baseado no problema observado.
   *
   * O campo stockDecreasedAt eh exibido (se existir na migration); admin
   * usa pra saber se ja foi conciliada. Quando null, mostra alerta vermelho.
   */
  async listShipmentsNeedingStockReprocess(daysAgo: number = 30, forceAll: boolean = false) {
    // Estratégia robusta via RAW SQL — NÃO depende de stock_decreased_at /
    // stock_increased_at existirem (caso migration nao tenha rodado).
    // Filtra por opened_at (sempre presente) ao invés de sent_at (pode ser null).
    // Tenta enriquecer com os 2 campos novos via segundo query tolerante.

    let rows: any[] = [];
    try {
      // Query base — usa SOMENTE colunas que sempre existem
      const sql = `
        SELECT id, code, from_store_code, from_store_name, to_store_code, to_store_name,
               status, opened_at, sent_at, received_at, total_items, total_qty,
               received_qty, missing_qty
        FROM realignment_shipments
        WHERE status IN ('in_transit', 'received')
          AND opened_at >= NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY COALESCE(sent_at, opened_at) DESC
        LIMIT 500
      `;
      rows = await (this.prisma as any).$queryRawUnsafe(sql, daysAgo);
      this.logger.log(`[needs-reprocess] daysAgo=${daysAgo} forceAll=${forceAll} → ${rows.length} remessa(s) base`);
    } catch (e: any) {
      this.logger.error(`[needs-reprocess] RAW query falhou: ${e?.message}`);
      return [];
    }

    // Tenta carregar os marcadores stock_decreased_at / stock_increased_at
    // num segundo query. Se a coluna NÃO existir (migration pendente), seta tudo null.
    const markers = new Map<string, { stockDecreasedAt: Date | null; stockIncreasedAt: Date | null }>();
    try {
      const ids = rows.map((r: any) => r.id);
      if (ids.length) {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        const sql2 = `
          SELECT id, stock_decreased_at, stock_increased_at
          FROM realignment_shipments
          WHERE id IN (${placeholders})
        `;
        const mr: any[] = await (this.prisma as any).$queryRawUnsafe(sql2, ...ids);
        for (const m of mr) {
          markers.set(m.id, {
            stockDecreasedAt: m.stock_decreased_at || null,
            stockIncreasedAt: m.stock_increased_at || null,
          });
        }
      }
    } catch (e: any) {
      this.logger.warn(`[needs-reprocess] markers query falhou (migration pendente?): ${e?.message}`);
    }

    const result = await Promise.all(
      rows.map(async (s: any) => {
        const cnt = await this.prisma.transferOrder.count({
          where: { shipmentId: s.id } as any,
        });
        const mk = markers.get(s.id) || { stockDecreasedAt: null, stockIncreasedAt: null };
        const needsDecrease = !mk.stockDecreasedAt;
        const needsIncrease = s.status === 'received' && !mk.stockIncreasedAt;
        return {
          id: s.id,
          code: s.code,
          fromStoreCode: s.from_store_code,
          fromStoreName: s.from_store_name,
          toStoreCode: s.to_store_code,
          toStoreName: s.to_store_name,
          status: s.status,
          openedAt: s.opened_at,
          sentAt: s.sent_at,
          receivedAt: s.received_at,
          totalItems: s.total_items,
          totalQty: s.total_qty,
          receivedQty: s.received_qty,
          missingQty: s.missing_qty,
          stockDecreasedAt: mk.stockDecreasedAt,
          stockIncreasedAt: mk.stockIncreasedAt,
          totalItemsLive: cnt,
          needsDecrease,
          needsIncrease,
        };
      }),
    );

    // Se forceAll=true → retorna TUDO (admin pode forçar baixa em qualquer).
    // Caso contrario → filtra só quem PRECISA de algo (needsDecrease OU needsIncrease).
    const filtered = forceAll
      ? result
      : result.filter((r) => r.needsDecrease || r.needsIncrease);
    this.logger.log(`[needs-reprocess] retornando ${filtered.length} de ${result.length} (forceAll=${forceAll})`);
    return filtered;
  }

  /**
   * Reprocessa o AUMENTO de estoque Giga no destino pra uma remessa
   * recebida (status='received') que nao teve increaseStock aplicado.
   * Idempotente: recusa se ja tem stockIncreasedAt (a menos que force=true).
   *
   * Aplica apenas pros items que foram RECEBIDOS (realignmentStatus='received')
   * — os 'missing' ficam de fora (vendedora ja marcou como faltante).
   */
  async reprocessStockIncreaseForShipment(input: { shipmentId: string; force?: boolean; userId?: string }) {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa nao encontrada');
    if (shipment.status !== 'received') {
      throw new BadRequestException(
        `Remessa esta com status=${shipment.status} — so reprocessa aumento em remessas com status=received`,
      );
    }
    if (shipment.stockIncreasedAt && !input.force) {
      throw new BadRequestException(
        `Remessa ${shipment.code} ja teve aumento Giga destino em ${new Date(shipment.stockIncreasedAt).toLocaleString('pt-BR')}. ` +
        `Use force=true se TEM CERTEZA que precisa reaplicar (cuidado: vai duplicar entrada).`,
      );
    }

    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id, realignmentStatus: 'received' } as any,
      select: { id: true, refCode: true, codigoBipado: true, cor: true, tamanho: true, qtyOrigem: true } as any,
    });
    if (!items.length) {
      throw new BadRequestException('Remessa sem itens recebidos — nada pra reprocessar');
    }

    const itemsSemCodigoBipado: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      if (!it.codigoBipado) {
        itemsSemCodigoBipado.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }
    let batchSkus = new Map<string, string>();
    if (itemsSemCodigoBipado.length > 0) {
      try {
        batchSkus = await this.erp.batchFindCodigosByRefCorTam(itemsSemCodigoBipado);
      } catch (e) {
        this.logger.warn(`[reprocess-increase] batchFind falhou: ${(e as Error).message}`);
      }
    }
    const keyOf = (ref: string, cor: string | null, tam: string | null) =>
      `${String(ref).trim().toUpperCase()}|${String(cor || '').trim().toUpperCase()}|${String(tam || '').trim().toUpperCase()}`;

    const stockItems: Array<{ sku: string; qty: number; storeCode: string }> = [];
    const unresolved: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      let sku: string | null = it.codigoBipado || null;
      if (!sku) sku = batchSkus.get(keyOf(it.refCode, it.cor, it.tamanho)) || null;
      if (!sku) {
        try { sku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho); } catch {}
      }
      if (!sku) {
        unresolved.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
        continue;
      }
      stockItems.push({ sku, qty: it.qtyOrigem || 1, storeCode: shipment.toStoreCode });
    }

    if (stockItems.length === 0) {
      throw new BadRequestException(
        `Nenhum SKU resolvido. Unresolved: ${unresolved.map((u) => `${u.refCode}/${u.cor}/${u.tamanho}`).join(', ')}`,
      );
    }

    const result = await this.erp.increaseStock(stockItems);
    const appliedCount = result.applied?.length || 0;

    this.logger.log(
      `[reprocess-increase] ${shipment.code} (${shipment.fromStoreCode}->${shipment.toStoreCode}): ` +
      `${stockItems.length} SKUs solicitados, ${appliedCount} aplicados por user=${input.userId || 'unknown'}`,
    );

    if (!result.success) {
      throw new BadRequestException(`increaseStock falhou: ${result.error}`);
    }
    if (appliedCount === 0) {
      throw new BadRequestException(
        `increaseStock retornou success mas 0 SKUs aplicados. Possivel mismatch de storeCode "${shipment.toStoreCode}" com formato LOJA do Giga.`,
      );
    }

    await (this.prisma as any).realignmentShipment.update({
      where: { id: shipment.id },
      data: { stockIncreasedAt: new Date() } as any,
    });

    return {
      ok: true,
      code: shipment.code,
      itemsTotal: items.length,
      stockItemsAttempted: stockItems.length,
      stockItemsApplied: appliedCount,
      unresolved: unresolved.length,
      message: `Entrada Giga reaplicada em ${shipment.toStoreCode}: ${appliedCount} SKUs.`,
    };
  }

  /**
   * Reprocessa a baixa de estoque Giga origem pra uma remessa específica.
   * Idempotente: se já tem stockDecreasedAt setado, recusa (a menos que force=true).
   *
   * Útil pra consertar remessas tipo "São José → Campinas" onde o decreaseStock
   * silenciosamente pulou (skipNotFound). Reaplica a baixa pelos itens da
   * remessa, atualiza stockDecreasedAt no sucesso.
   */
  /**
   * Lista TODAS as remessas de uma loja origem (opcionalmente filtrando por
   * loja destino) nos últimos N dias. RAW SQL — não depende de
   * stock_decreased_at existir. Pra rotina rápida "ver tudo que saiu de
   * SJOSE essa semana e baixar Giga".
   */
  async listShipmentsByRoute(input: {
    fromStoreCode: string;
    toStoreCode?: string | null;
    daysAgo: number;
  }) {
    const days = Math.max(1, Math.min(180, input.daysAgo || 7));
    let rows: any[] = [];
    try {
      const sql = `
        SELECT id, code, from_store_code, from_store_name, to_store_code, to_store_name,
               status, opened_at, sent_at, received_at, total_items, total_qty
        FROM realignment_shipments
        WHERE from_store_code = $1
          AND status IN ('in_transit', 'received')
          AND opened_at >= NOW() - ($2::int * INTERVAL '1 day')
          ${input.toStoreCode ? 'AND to_store_code = $3' : ''}
        ORDER BY COALESCE(sent_at, opened_at) DESC
        LIMIT 500
      `;
      const params: any[] = [input.fromStoreCode, days];
      if (input.toStoreCode) params.push(input.toStoreCode);
      rows = await (this.prisma as any).$queryRawUnsafe(sql, ...params);
    } catch (e: any) {
      this.logger.error(`[by-route] RAW falhou: ${e?.message}`);
      return [];
    }

    // Tenta enriquecer com marcador (tolerante)
    const markers = new Map<string, Date | null>();
    try {
      const ids = rows.map((r: any) => r.id);
      if (ids.length) {
        const ph = ids.map((_, i) => `$${i + 1}`).join(',');
        const mr: any[] = await (this.prisma as any).$queryRawUnsafe(
          `SELECT id, stock_decreased_at FROM realignment_shipments WHERE id IN (${ph})`,
          ...ids,
        );
        for (const m of mr) markers.set(m.id, m.stock_decreased_at || null);
      }
    } catch (e: any) {
      this.logger.warn(`[by-route] markers query falhou: ${e?.message}`);
    }

    return Promise.all(
      rows.map(async (s: any) => {
        const cnt = await this.prisma.transferOrder.count({ where: { shipmentId: s.id } as any });
        const stockDecreasedAt = markers.get(s.id) || null;
        return {
          id: s.id,
          code: s.code,
          fromStoreCode: s.from_store_code,
          fromStoreName: s.from_store_name,
          toStoreCode: s.to_store_code,
          toStoreName: s.to_store_name,
          status: s.status,
          openedAt: s.opened_at,
          sentAt: s.sent_at,
          receivedAt: s.received_at,
          totalItems: s.total_items,
          totalQty: s.total_qty,
          totalItemsLive: cnt,
          stockDecreasedAt,
          alreadyDecreased: !!stockDecreasedAt,
        };
      }),
    );
  }

  async reprocessStockForShipment(input: { shipmentId: string; force?: boolean; userId?: string }) {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.status === 'open') {
      throw new BadRequestException('Remessa ainda aberta — use o fluxo normal de fechamento');
    }
    if (shipment.stockDecreasedAt && !input.force) {
      throw new BadRequestException(
        `Remessa ${shipment.code} já teve baixa Giga em ${new Date(shipment.stockDecreasedAt).toLocaleString('pt-BR')}. ` +
        `Use force=true se TEM CERTEZA que precisa reaplicar (cuidado: vai duplicar baixa).`,
      );
    }

    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id } as any,
      select: { id: true, refCode: true, codigoBipado: true, cor: true, tamanho: true, qtyOrigem: true } as any,
    });
    if (!items.length) {
      throw new BadRequestException('Remessa sem items — nada pra reprocessar');
    }

    // Resolve SKU (igual closeAndSend) — usa codigoBipado direto, batch pro resto
    const itemsSemCodigoBipado: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      if (!it.codigoBipado) {
        itemsSemCodigoBipado.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }
    let batchSkus = new Map<string, string>();
    if (itemsSemCodigoBipado.length > 0) {
      try {
        batchSkus = await this.erp.batchFindCodigosByRefCorTam(itemsSemCodigoBipado);
      } catch (e) {
        this.logger.warn(`[reprocess] batchFind falhou: ${(e as Error).message}`);
      }
    }
    const keyOf = (ref: string, cor: string | null, tam: string | null) =>
      `${String(ref).trim().toUpperCase()}|${String(cor || '').trim().toUpperCase()}|${String(tam || '').trim().toUpperCase()}`;

    const stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }> = [];
    const unresolved: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      let sku: string | null = it.codigoBipado || null;
      if (!sku) sku = batchSkus.get(keyOf(it.refCode, it.cor, it.tamanho)) || null;
      if (!sku) {
        try { sku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho); } catch {}
      }
      if (!sku) {
        unresolved.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
        continue;
      }
      stockItems.push({ sku, qty: it.qtyOrigem || 1, storeCode: shipment.fromStoreCode, refCode: it.refCode });
    }

    if (stockItems.length === 0) {
      throw new BadRequestException(
        `Nenhum SKU resolvido pra reprocessar. Items unresolved: ${unresolved.map((u) => `${u.refCode}/${u.cor}/${u.tamanho}`).join(', ')}`,
      );
    }

    // Aplica baixa
    const result = await this.erp.decreaseStock(
      stockItems.map((s) => ({ sku: s.sku, qty: s.qty, storeCode: s.storeCode })),
      { allowNegative: true, skipNotFound: true },
    );
    const appliedCount = result.applied?.length || 0;

    this.logger.log(
      `[reprocess] ${shipment.code} (${shipment.fromStoreCode}→${shipment.toStoreCode}): ` +
      `${stockItems.length} SKUs solicitados, ${appliedCount} aplicados por user=${input.userId || 'unknown'}`,
    );

    if (!result.success) {
      throw new BadRequestException(
        `decreaseStock falhou: ${result.error}. Estoque não reaplicado.`,
      );
    }

    if (appliedCount === 0) {
      throw new BadRequestException(
        `decreaseStock retornou success mas 0 SKUs aplicados. Possível mismatch de storeCode "${shipment.fromStoreCode}" com formato LOJA do Giga (pode ser "01", "02", etc). Verifique no Giga e ajuste o mapping.`,
      );
    }

    // Marca stockDecreasedAt
    await (this.prisma as any).realignmentShipment.update({
      where: { id: shipment.id },
      data: { stockDecreasedAt: new Date() } as any,
    });

    return {
      ok: true,
      code: shipment.code,
      itemsTotal: items.length,
      stockItemsAttempted: stockItems.length,
      stockItemsApplied: appliedCount,
      unresolved: unresolved.length,
      message: `Baixa Giga reaplicada em ${shipment.fromStoreCode}: ${appliedCount} SKUs.`,
    };
  }

  async listAllShipmentsAdmin(input: {
    status?: string;
    fromStoreCode?: string;
    toStoreCode?: string;
    search?: string;
    daysAgo?: number;
  }) {
    const where: any = {};
    if (input.status) where.status = input.status;
    if (input.fromStoreCode) where.fromStoreCode = input.fromStoreCode;
    if (input.toStoreCode) where.toStoreCode = input.toStoreCode;
    if (input.search) where.code = { contains: input.search.trim(), mode: 'insensitive' };

    const days = Number.isFinite(input.daysAgo) && (input.daysAgo as number) > 0 ? (input.daysAgo as number) : 30;
    const since = new Date();
    since.setDate(since.getDate() - days);
    where.openedAt = { gte: since };

    const shipments = await (this.prisma as any).realignmentShipment.findMany({
      where,
      orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
      take: 200,
    });

    // Conta itens por shipment via groupBy (1 query só)
    const ids = shipments.map((s: any) => s.id);
    if (ids.length === 0) return [];

    const itemsRaw = await this.prisma.transferOrder.findMany({
      where: { shipmentId: { in: ids } } as any,
      select: { shipmentId: true, realignmentStatus: true, qtyOrigem: true } as any,
    });

    const summary = new Map<string, { totalItems: number; totalQty: number; received: number; missing: number; sent: number }>();
    for (const s of shipments) summary.set(s.id, { totalItems: 0, totalQty: 0, received: 0, missing: 0, sent: 0 });
    for (const it of itemsRaw as any[]) {
      const agg = summary.get(it.shipmentId);
      if (!agg) continue;
      agg.totalItems += 1;
      agg.totalQty += it.qtyOrigem || 1;
      if (it.realignmentStatus === 'received') agg.received += 1;
      else if (it.realignmentStatus === 'missing') agg.missing += 1;
      else if (it.realignmentStatus === 'sent') agg.sent += 1;
    }

    return shipments.map((s: any) => {
      const agg = summary.get(s.id) || { totalItems: 0, totalQty: 0, received: 0, missing: 0, sent: 0 };
      // Tempo em trânsito (em horas) pra alertar remessas paradas
      let hoursInTransit: number | null = null;
      if (s.status === 'in_transit' && s.sentAt) {
        hoursInTransit = (Date.now() - new Date(s.sentAt).getTime()) / 1000 / 60 / 60;
      }
      return {
        ...s,
        totalItemsLive: agg.totalItems,
        totalQtyLive: agg.totalQty,
        receivedCount: agg.received,
        missingCount: agg.missing,
        pendingScanCount: agg.sent,
        hoursInTransit,
      };
    });
  }

  /**
   * Detalhe de uma remessa qualquer (uso admin — sem filtro de loja).
   */
  async getShipmentDetailAdmin(shipmentId: string) {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId } as any,
      orderBy: [{ refCode: 'asc' }],
      select: {
        id: true,
        refCode: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
        descricao: true,
        realignmentStatus: true,
        realignmentReceivedAt: true,
        realignmentMissingAt: true,
        realignmentMissingNote: true,
      } as any,
    });
    return { ...shipment, items };
  }

  /**
   * KPIs agregados (cards do topo da tela admin).
   */
  async getShipmentsKPIs() {
    const all = await (this.prisma as any).realignmentShipment.findMany({
      where: { openedAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
      select: { id: true, status: true, sentAt: true, totalQty: true } as any,
    });
    const open = all.filter((s: any) => s.status === 'open').length;
    const inTransit = all.filter((s: any) => s.status === 'in_transit').length;
    const received = all.filter((s: any) => s.status === 'received').length;
    // Remessas paradas (in_transit há mais de 48h)
    const stuck = all.filter((s: any) => {
      if (s.status !== 'in_transit' || !s.sentAt) return false;
      const hours = (Date.now() - new Date(s.sentAt).getTime()) / 1000 / 60 / 60;
      return hours > 48;
    }).length;
    return { open, inTransit, received, stuck, total90d: all.length };
  }

  /**
   * "Dar Entrada" — finaliza o recebimento da remessa.
   *
   * Pré-condição: TODOS itens da remessa devem ter status final
   * (`received` ou `missing`). Itens ainda `sent` bloqueiam.
   *
   * Faz:
   *   1. Resolve SKU dos itens `received`
   *   2. Chama erp.increaseStock em batch (transação ACID)
   *   3. Marca shipment.status = 'received'
   *   4. Emite socket pra retaguarda
   */
  async confirmReceived(input: { shipmentId: string; storeId: string; userId?: string }) {
    const store = await this.prisma.store.findUnique({
      where: { id: input.storeId },
      select: { code: true } as any,
    });
    if (!store) throw new ForbiddenException('Loja inválida');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: input.shipmentId },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.toStoreCode !== (store as any).code)
      throw new ForbiddenException('Essa remessa não é da sua loja');
    if (shipment.status !== 'in_transit')
      throw new BadRequestException(`Remessa não está em trânsito (status=${shipment.status})`);

    // Verifica que TODOS itens estão em status final.
    // ⚡ Inclui codigoBipado pra evitar refazer lookup no Giga na entrada
    // (codigoBipado já foi resolvido e salvo durante o bipe).
    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id } as any,
      select: {
        id: true,
        refCode: true,
        cor: true,
        tamanho: true,
        qtyOrigem: true,
        realignmentStatus: true,
        codigoBipado: true,
      } as any,
    });

    const pendingItems = (items as any[]).filter(
      (i) => i.realignmentStatus !== 'received' && i.realignmentStatus !== 'missing',
    );
    if (pendingItems.length > 0) {
      throw new BadRequestException(
        `Ainda há ${pendingItems.length} item(ns) sem conferir. ` +
          `Bipe todos ou marque como faltante antes de dar entrada.`,
      );
    }

    const receivedItems = (items as any[]).filter((i) => i.realignmentStatus === 'received');
    const missingItems = (items as any[]).filter((i) => i.realignmentStatus === 'missing');

    // ⚡ OTIMIZADO: usa codigoBipado salvo no scan (CODIGO real do Giga já
    //    resolvido durante a bipagem). Evita 1 query por peça no Wincred —
    //    pra remessa de 60 peças economiza ~6-10s. Fallback PARALELO pros
    //    raros casos sem codigoBipado (itens antigos ou marcados sem bipe).
    const stockItems: Array<{ sku: string; qty: number; storeCode: string }> = [];
    const naoResolvidos: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    const itensSemCodigo: any[] = [];
    for (const it of receivedItems as any[]) {
      if (it.codigoBipado) {
        stockItems.push({ sku: String(it.codigoBipado), qty: it.qtyOrigem || 1, storeCode: shipment.toStoreCode });
      } else {
        itensSemCodigo.push(it);
      }
    }
    if (itensSemCodigo.length > 0) {
      const results = await Promise.all(
        itensSemCodigo.map(async (it) => {
          try {
            const sku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho);
            return { it, sku, err: null as string | null };
          } catch (e) {
            return { it, sku: null, err: (e as Error).message };
          }
        }),
      );
      for (const r of results) {
        if (r.sku) {
          stockItems.push({ sku: r.sku, qty: r.it.qtyOrigem || 1, storeCode: shipment.toStoreCode });
        } else {
          naoResolvidos.push({ refCode: r.it.refCode, cor: r.it.cor, tamanho: r.it.tamanho });
          this.logger.warn(`[shipment] confirmReceived: não resolveu SKU pra ${r.it.refCode}/${r.it.cor}/${r.it.tamanho}${r.err ? ` (${r.err})` : ''}`);
        }
      }
    }
    // Se algum item não resolveu, NÃO finaliza — força admin a corrigir o cadastro
    if (naoResolvidos.length > 0) {
      throw new BadRequestException(
        `Não consegui resolver SKU pra ${naoResolvidos.length} item(ns) (verifique cadastro Giga): ` +
          naoResolvidos
            .map((u) => `${u.refCode} ${u.cor || ''}/${u.tamanho || ''}`)
            .join(', '),
      );
    }

    let increaseResult: any = { success: true, applied: [] };
    if (stockItems.length > 0) {
      increaseResult = await this.erp.increaseStock(stockItems);
      if (!increaseResult.success) {
        throw new BadRequestException(
          `Falha ao dar entrada Giga: ${increaseResult.error}. Remessa NÃO foi finalizada.`,
        );
      }
    }
    const appliedIncreaseCount = increaseResult.applied?.length || 0;
    if (stockItems.length > 0 && appliedIncreaseCount === 0) {
      this.logger.error(
        `[confirmReceived] ${shipment.code}: increaseStock retornou success mas 0 SKUs aplicados! ` +
        `Possivel mismatch de storeCode. toStoreCode=${shipment.toStoreCode}. ` +
        `Use POST /realignment/shipments/admin/:id/reprocess-stock-increase pra reaplicar.`,
      );
    }

    // Atualiza shipment
    const now = new Date();
    const receivedQty = receivedItems.reduce((s, i: any) => s + (i.qtyOrigem || 1), 0);
    const missingQty = missingItems.reduce((s, i: any) => s + (i.qtyOrigem || 1), 0);

    await (this.prisma as any).realignmentShipment.update({
      where: { id: shipment.id },
      data: {
        status: 'received',
        receivedAt: now,
        receivedByUserId: input.userId ?? null,
        receivedQty,
        missingQty,
        // So marca se realmente aplicou — pra reprocess saber quem precisa
        stockIncreasedAt: appliedIncreaseCount > 0 ? now : null,
      } as any,
    });

    this.invalidateSkuCache(shipment.id);

    this.logger.log(
      `[shipment] ${shipment.code} recebida: ${receivedItems.length} itens entrada (Giga aplicou ${increaseResult.applied?.length || 0}), ` +
        `${missingItems.length} faltantes`,
    );

    // Emite socket pra retaguarda atualizar dashboards
    try {
      this.gateway.emitToAdmins('shipment:received', {
        shipmentId: shipment.id,
        code: shipment.code,
        toStoreCode: shipment.toStoreCode,
        receivedItems: receivedItems.length,
        missingItems: missingItems.length,
      });
    } catch (e) {
      /* não bloqueia */
    }

    return {
      ok: true,
      code: shipment.code,
      receivedItems: receivedItems.length,
      missingItems: missingItems.length,
      gigaApplied: increaseResult.applied?.length || 0,
    };
  }
}
