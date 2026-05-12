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
      select: { id: true, refCode: true, cor: true, tamanho: true, qtyOrigem: true } as any,
    });
    if (!items.length) return { ok: true, totalItems: 0, problemas: [] };

    // Resolve SKU pra cada item
    const stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }> = [];
    const unresolved: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];
    for (const it of items as any[]) {
      try {
        const sku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho);
        if (!sku) {
          unresolved.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
          continue;
        }
        stockItems.push({ sku, qty: it.qtyOrigem || 1, storeCode: shipment.fromStoreCode, refCode: it.refCode });
      } catch {
        unresolved.push({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho });
      }
    }

    const { problemas } = await this.precheckStockForShipment(items as any[], stockItems);
    return {
      ok: problemas.length === 0 && unresolved.length === 0,
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

    // Resolve SKU de cada item.
    // PRIORIDADE: usa o codigoBipado (CODIGO real do Giga, salvo na hora do
    // bipe). Sem ambiguidade quando há peças com mesma REF+COR+TAMANHO mas
    // códigos diferentes (ex: linha CHIC vs 3/4 ambas REF 2088).
    // FALLBACK: items antigos (pré-feature) tem codigoBipado=null. Usa o
    // findCodigoByRefCorTam clássico — pode dar ambiguidade.
    const stockItems: Array<{ sku: string; qty: number; storeCode: string; refCode: string }> = [];
    const unresolved: Array<{ refCode: string; cor: string | null; tamanho: string | null }> = [];

    for (const it of items as any[]) {
      try {
        let sku: string | null = it.codigoBipado || null;
        if (!sku) {
          // Fallback pra items antigos sem codigoBipado
          sku = await this.erp.findCodigoByRefCorTam(it.refCode, it.cor, it.tamanho);
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

    if (unresolved.length) {
      throw new BadRequestException(
        `Não consegui resolver SKU pra ${unresolved.length} item(ns): ` +
          unresolved.map((u) => `${u.refCode} ${u.cor || ''}/${u.tamanho || ''}`).join(', '),
      );
    }

    // Pré-verifica estoque antes de iniciar transação. Antes bloqueava o
    // fechamento. Agora, como permitimos estoque negativo em realinhamento
    // (a peça já está em mãos fisicamente), apenas loga warning com a lista
    // de divergências pra auditoria. NÃO bloqueia mais.
    const precheck = await this.precheckStockForShipment(items as any[], stockItems);
    if (precheck.problemas.length > 0) {
      this.logger.warn(
        `closeAndSend ${shipment.code}: ${precheck.problemas.length} item(ns) com estoque insuficiente no Giga — fechando mesmo assim (allowNegative). Detalhes: ${JSON.stringify(precheck.problemas).slice(0, 500)}`,
      );
    }

    // BAIXA estoque Giga origem em transação (todos ou nada).
    // allowNegative=true: a peça já está em mãos fisicamente, então deixamos
    // o Giga ficar negativo se houver divergência. Loga warning pra rastro.
    const result = await this.erp.decreaseStock(
      stockItems.map((s) => ({ sku: s.sku, qty: s.qty, storeCode: s.storeCode })),
      { allowNegative: true, skipNotFound: true },
    );
    if (!result.success) {
      throw new BadRequestException(
        `Falha ao baixar estoque Giga origem: ${result.error}. Remessa NÃO foi fechada.`,
      );
    }

    // Atualiza shipment → in_transit
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
      },
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
    // Reduz tempo total de 60 peças de ~9s pra ~2s.
    if (!matchedItemId && pendingItems.length > 0) {
      let cached = this.skuCache.get(shipment.id);
      const nowMs = Date.now();
      if (!cached || cached.expiresAt < nowMs) {
        const codigoMap = await this.erp.batchFindCodigosByRefCorTam(
          (items as any[]).map((it) => ({ refCode: it.refCode, cor: it.cor, tamanho: it.tamanho })),
        );
        cached = { skuMap: codigoMap, expiresAt: nowMs + this.CACHE_TTL_MS };
        this.skuCache.set(shipment.id, cached);
        this.logger.log(`[shipment] cache SKU populado pra ${shipment.code} (${codigoMap.size} entradas)`);
      }
      for (const it of pendingItems) {
        const key = `${norm(it.refCode)}|${norm(it.cor)}|${norm(it.tamanho)}`;
        const itemSku = cached.skuMap.get(key);
        if (itemSku && stripZeros(itemSku) === skuBipadoStripped) {
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
      throw new BadRequestException(
        `SKU ${skuBipado} nao pertence a essa remessa (ou ja foi bipado). ` +
          (info?.ref ? `Resolvido como ${info.ref}/${info.cor || ''}/${info.tamanho || ''}.` : ''),
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
      },
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
