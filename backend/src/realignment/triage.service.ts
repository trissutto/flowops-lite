import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { RealignmentShipmentService } from './shipment.service';

/**
 * TriagemService — operação de "triagem do provador".
 *
 * Caso de uso real (Lurd's): vendedora tem N peças paradas no provador
 * que vieram de outra loja sem registro de transferência. Precisa decidir
 * pra onde mandar cada peça. Bipa o EAN/SKU, sistema sugere a loja onde
 * mais falta, vendedora joga na caixa daquela cidade. No final fecha
 * todas as remessas formadas.
 *
 * Decisão de destino (critério "B + empate proporcional"):
 *   1. Filtra os destinos elegíveis com estoque ZERO desse SKU exato.
 *      Entre eles, escolhe o que tem MAIS venda recente da REF (urgência).
 *   2. Se ninguém com 0, escolhe o de MENOR estoque do SKU.
 *   3. Empate (mesmo estoque + mesma venda): aleatório PROPORCIONAL ao
 *      "déficit" (quanto menos tem, maior a chance de ser escolhido).
 *
 * Reusa o fluxo de RealignmentShipment já existente: cada confirmação
 * cria um TransferOrder pending + linka ele numa remessa OPEN do par
 * origem→destino. Quando vendedora finaliza, fecha todas as remessas
 * (closeAndSend já faz decreaseStock origem + obrigações financeiras
 * + emit socket pra loja destino).
 */
@Injectable()
export class TriagemService {
  private readonly logger = new Logger(TriagemService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly shipment: RealignmentShipmentService,
  ) {}

  /**
   * Sugere o melhor destino pra um SKU bipado entre os candidatos.
   * Não persiste nada — só consulta.
   */
  async suggest(input: {
    sku: string;
    fromStoreCode: string;
    candidateStoreCodes: string[];
  }) {
    try {
      return await this._suggestInner(input);
    } catch (e: any) {
      // Re-lança erros de regra (Bad/Not Found/Forbidden) — esses já têm mensagem certa.
      if (
        e?.status === 400 ||
        e?.status === 403 ||
        e?.status === 404 ||
        e?.constructor?.name === 'BadRequestException' ||
        e?.constructor?.name === 'NotFoundException' ||
        e?.constructor?.name === 'ForbiddenException'
      ) {
        throw e;
      }
      // Erros transitórios de MySQL/Postgres viravam 500 cru.
      // Converte em BadRequest com diagnóstico amigável.
      const msg = String(e?.message || e || 'erro desconhecido');
      this.logger.error(`[triage.suggest] erro inesperado pro SKU "${input.sku}": ${msg}`);
      throw new BadRequestException(
        `Não consegui processar a sugestão (${msg}). Tente novamente em 5s ou bipe outro SKU.`,
      );
    }
  }

  private async _suggestInner(input: {
    sku: string;
    fromStoreCode: string;
    candidateStoreCodes: string[];
  }) {
    const sku = String(input.sku || '').trim();
    if (!sku) throw new BadRequestException('SKU vazio');
    if (!input.fromStoreCode) throw new BadRequestException('fromStoreCode obrigatório');
    if (!input.candidateStoreCodes?.length)
      throw new BadRequestException('Pelo menos 1 destino candidato');

    // Tira a loja origem da lista de candidatos (defensivo)
    const candidates = input.candidateStoreCodes
      .filter((c) => c && c !== input.fromStoreCode)
      .map((c) => String(c).trim());
    if (!candidates.length)
      throw new BadRequestException('Nenhum candidato válido (origem foi excluída)');

    // 1. Resolve dados do SKU (aceita EAN13 também — resolveSkuInfo faz fallback
    //    via colunas de barcode e devolve o CODIGO real do Giga).
    const info = await this.erp.resolveSkuInfo(sku);
    if (!info) {
      throw new NotFoundException(`SKU/EAN ${sku} não encontrado no Giga`);
    }
    if (!info.ref) {
      throw new BadRequestException(`SKU ${sku} sem REF cadastrada`);
    }

    // CRÍTICO: a partir daqui SEMPRE usar info.codigo (CODIGO real do Giga),
    // não o `sku` que veio do scanner — vendedora pode bipar o EAN13 que está
    // diferente do CODIGO. Sem isso, o getStockBySkuAndStores não acha estoque
    // e a sugestão fica errada (ou trava o fluxo).
    const codigoGiga = info.codigo;

    // 2. Busca em paralelo:
    //    - estoque do SKU exato em cada candidato (Giga) — usa CODIGO resolvido
    //    - venda da REF últimos 30d em cada candidato (Giga)
    //    - itens já bipados nas caixas OPEN do par origem→candidato (Postgres)
    const [stockMap, salesMap, openShipments] = await Promise.all([
      this.erp.getStockBySkuAndStores(codigoGiga, candidates),
      this.erp.getRecentSalesByRefAndStores(info.ref, candidates, 30),
      (this.prisma as any).realignmentShipment.findMany({
        where: {
          fromStoreCode: input.fromStoreCode,
          toStoreCode: { in: candidates },
          status: 'open',
        },
        select: {
          id: true,
          toStoreCode: true,
          // Pega itens só com a mesma REF (pra agrupar grade)
          // Filtra no JS pra evitar query complexa
        },
      }),
    ]);

    // Carrega itens das caixas open desses candidatos (filtrado por REF)
    const openShipmentIds = (openShipments as any[]).map((s) => s.id);
    const itensNasCaixas = openShipmentIds.length
      ? await this.prisma.transferOrder.findMany({
          where: {
            shipmentId: { in: openShipmentIds },
            refCode: info.ref,
          } as any,
          select: { shipmentId: true, refCode: true, cor: true, tamanho: true } as any,
        })
      : [];

    // Mapa: storeCode → { qtdMesmaRef, temSkuExato }
    const grade = new Map<string, { qtdMesmaRef: number; temSkuExato: boolean }>();
    for (const code of candidates) grade.set(code, { qtdMesmaRef: 0, temSkuExato: false });
    for (const s of openShipments as any[]) {
      const itensDessaCaixa = (itensNasCaixas as any[]).filter((i) => i.shipmentId === s.id);
      const cur = grade.get(s.toStoreCode) || { qtdMesmaRef: 0, temSkuExato: false };
      cur.qtdMesmaRef += itensDessaCaixa.length;
      // Verifica SKU exato (REF + cor + tamanho)
      const corBip = (info.cor || '').toUpperCase();
      const tamBip = (info.tamanho || '').toUpperCase();
      const dup = itensDessaCaixa.find(
        (i: any) =>
          (i.cor || '').toUpperCase() === corBip &&
          (i.tamanho || '').toUpperCase() === tamBip,
      );
      if (dup) cur.temSkuExato = true;
      grade.set(s.toStoreCode, cur);
    }

    // 3. Monta comparativo enriquecido
    const comparativo = candidates.map((code) => {
      const g = grade.get(code) || { qtdMesmaRef: 0, temSkuExato: false };
      return {
        storeCode: code,
        estoqueAtual: stockMap.get(code) || 0,
        vendaRef30d: salesMap.get(code) || 0,
        qtdMesmaRefNaCaixa: g.qtdMesmaRef,
        temSkuExatoNaCaixa: g.temSkuExato,
      };
    });

    // Carrega nomes de loja
    const stores = await this.prisma.store.findMany({
      where: { code: { in: candidates }, active: true },
      select: { code: true, name: true } as any,
    });
    const nameByCode = new Map<string, string>();
    for (const s of stores as any[]) nameByCode.set(s.code, s.name);

    // 4. NOVA LÓGICA — particiona em 3 grupos:
    //    A. EXCLUÍDOS — caixa já tem esse SKU exato (não duplica)
    //    B. PREFERENCIAIS — caixa já tem outras peças da mesma REF (agrupa grade)
    //    C. NORMAIS — sem caixa com essa REF, aplica critério de estoque
    const excluidos = comparativo.filter((c) => c.temSkuExatoNaCaixa);
    const preferenciais = comparativo.filter(
      (c) => !c.temSkuExatoNaCaixa && c.qtdMesmaRefNaCaixa > 0,
    );
    const normais = comparativo.filter(
      (c) => !c.temSkuExatoNaCaixa && c.qtdMesmaRefNaCaixa === 0,
    );

    // Se TUDO foi excluído, erro: SKU já está em todas as caixas elegíveis
    if (preferenciais.length === 0 && normais.length === 0) {
      throw new BadRequestException(
        `Esta peça (${info.ref} ${info.cor || ''}/${info.tamanho || ''}) já está em todas as caixas elegíveis. ` +
          `Não dá pra duplicar — confira se não foi bipada antes.`,
      );
    }

    // 5. Decisão
    let candidatosFinais: typeof comparativo;
    let reason: string;
    let estrategia: 'AGRUPAR_GRADE' | 'ESTOQUE_ZERO' | 'MENOR_ESTOQUE';

    if (preferenciais.length > 0) {
      // ESTRATÉGIA 1: agrupar grade — escolhe a caixa que JÁ TEM mais peças da REF
      const maxQtd = Math.max(...preferenciais.map((c) => c.qtdMesmaRefNaCaixa));
      candidatosFinais = preferenciais.filter((c) => c.qtdMesmaRefNaCaixa === maxQtd);
      estrategia = 'AGRUPAR_GRADE';
      reason = `Já tem ${maxQtd} peça(s) da REF ${info.ref} nessa caixa — agrupa grade`;
    } else {
      // ESTRATÉGIA 2/3: critério estoque (lógica antiga, só nas lojas NORMAIS)
      const comZero = normais.filter((c) => c.estoqueAtual === 0);
      if (comZero.length > 0) {
        const maxVenda = Math.max(...comZero.map((c) => c.vendaRef30d));
        candidatosFinais = comZero.filter((c) => c.vendaRef30d === maxVenda);
        estrategia = 'ESTOQUE_ZERO';
        reason =
          maxVenda > 0
            ? `Estoque 0 e ${maxVenda} venda(s) da REF nos últimos 30d`
            : 'Estoque 0 e sem venda recente';
      } else {
        const minEstoque = Math.min(...normais.map((c) => c.estoqueAtual));
        candidatosFinais = normais.filter((c) => c.estoqueAtual === minEstoque);
        estrategia = 'MENOR_ESTOQUE';
        reason = `Menor estoque do SKU (${minEstoque} pç)`;
      }
    }

    // 6. Empate: aleatório proporcional ao déficit
    let escolhido: typeof comparativo[0];
    if (candidatosFinais.length === 1) {
      escolhido = candidatosFinais[0];
    } else {
      escolhido = this.weightedRandom(candidatosFinais);
      reason += ` · ${candidatosFinais.length} candidatos empatados, sorteio proporcional`;
    }

    return {
      sku: info.codigo,
      ref: info.ref,
      cor: info.cor,
      tamanho: info.tamanho,
      descricao: info.descricao,
      sugerido: {
        storeCode: escolhido.storeCode,
        storeName: nameByCode.get(escolhido.storeCode) || escolhido.storeCode,
        reason,
        estrategia,
      },
      excluidos: excluidos.map((c) => ({
        storeCode: c.storeCode,
        storeName: nameByCode.get(c.storeCode) || c.storeCode,
        motivo: 'SKU já está nessa caixa',
      })),
      comparativo: comparativo
        .map((c) => ({
          ...c,
          storeName: nameByCode.get(c.storeCode) || c.storeCode,
        }))
        .sort((a, b) => {
          // Ordem: preferenciais primeiro, depois normais, depois excluídos
          const aRank = a.temSkuExatoNaCaixa ? 2 : a.qtdMesmaRefNaCaixa > 0 ? 0 : 1;
          const bRank = b.temSkuExatoNaCaixa ? 2 : b.qtdMesmaRefNaCaixa > 0 ? 0 : 1;
          if (aRank !== bRank) return aRank - bRank;
          return a.estoqueAtual - b.estoqueAtual || b.vendaRef30d - a.vendaRef30d;
        }),
    };
  }

  /**
   * Sorteio aleatório proporcional ao "déficit":
   * peso = vendaRef30d + 1 (evita peso 0 quando ninguém vendeu).
   * Quem vendeu mais e tá com 0 estoque tem mais chance.
   */
  private weightedRandom<T extends { vendaRef30d: number; estoqueAtual: number }>(items: T[]): T {
    // Peso: dá mais chance pra quem tem mais venda. Se ninguém vendeu,
    // peso = 1 pra todos (uniforme).
    const weights = items.map((i) => i.vendaRef30d + 1);
    const total = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /**
   * Confirma um item da triagem: cria TransferOrder pending + linka em
   * remessa OPEN do par origem→destino (criando a remessa se não existir).
   *
   * Reusa addItemToShipment do ShipmentService.
   */
  async confirm(input: {
    sku: string;
    fromStoreCode: string;
    toStoreCode: string;
    qty?: number;
    storeId: string; // loja física que tá fazendo a triagem (operadora)
    userId?: string;
  }) {
    const sku = String(input.sku || '').trim();
    if (!sku) throw new BadRequestException('SKU vazio');
    if (!input.fromStoreCode) throw new BadRequestException('fromStoreCode obrigatório');
    if (!input.toStoreCode) throw new BadRequestException('toStoreCode obrigatório');
    if (input.fromStoreCode === input.toStoreCode)
      throw new BadRequestException('Origem e destino não podem ser iguais');

    // Resolve SKU
    const info = await this.erp.resolveSkuInfo(sku);
    if (!info) throw new NotFoundException(`SKU ${sku} não encontrado`);

    // Carrega dados das 2 lojas
    const [from, to] = await Promise.all([
      this.prisma.store.findUnique({
        where: { code: input.fromStoreCode },
        select: { id: true, code: true, name: true } as any,
      }),
      this.prisma.store.findUnique({
        where: { code: input.toStoreCode },
        select: { id: true, code: true, name: true } as any,
      }),
    ]);
    if (!from) throw new BadRequestException(`Loja origem ${input.fromStoreCode} não cadastrada`);
    if (!to) throw new BadRequestException(`Loja destino ${input.toStoreCode} não cadastrada`);

    // Verifica se já tem o mesmo SKU exato na caixa OPEN do par
    // (REF + cor + tamanho). Bloqueia duplicação na grade.
    const existing = await (this.prisma as any).realignmentShipment.findFirst({
      where: {
        fromStoreCode: input.fromStoreCode,
        toStoreCode: input.toStoreCode,
        status: 'open',
      },
      select: { id: true },
    });
    if (existing && info.ref) {
      const dup = await this.prisma.transferOrder.findFirst({
        where: {
          shipmentId: existing.id,
          refCode: info.ref,
          cor: info.cor || null,
          tamanho: info.tamanho || null,
        } as any,
        select: { id: true },
      });
      if (dup) {
        throw new BadRequestException(
          `${info.ref} ${info.cor || ''}/${info.tamanho || ''} já está na caixa de ${(to as any).name}. ` +
            `Não duplica — escolha outra loja.`,
        );
      }
    }

    const qty = Math.max(1, Math.min(99, input.qty || 1));

    // Cria TransferOrder pending
    const order = await this.prisma.transferOrder.create({
      data: {
        tipo: 'REALINHAMENTO',
        lojaOrigemCode: (from as any).code,
        lojaOrigemName: (from as any).name,
        lojaDestinoCode: (to as any).code,
        lojaDestinoName: (to as any).name,
        refCode: info.ref || sku,
        cor: info.cor,
        tamanho: info.tamanho,
        descricao: info.descricao,
        qtyOrigem: qty,
        realignmentStatus: 'pending',
        solicitanteNome: 'TRIAGEM',
        mensagem: `Triagem provador (operada por ${input.storeId})`,
      } as any,
    });

    // Linka em remessa OPEN do par
    // OBS: addItemToShipment exige storeId == loja origem. Pra triagem operada
    // de OUTRA loja física, usamos o ID da loja origem mesmo (a remessa
    // pertence a SANTOS, mas vendedora de outra loja física tá montando ela).
    await this.shipment.addItemToShipment({
      transferOrderId: (order as any).id,
      storeId: (from as any).id,
      userId: input.userId,
    });

    return { ok: true, transferOrderId: (order as any).id };
  }

  /**
   * Lista as remessas OPEN do par fromStoreCode→qualquer destino (todas
   * as caixas em formação na triagem atual).
   */
  async listOpenShipmentsForOrigin(fromStoreCode: string) {
    const shipments = await (this.prisma as any).realignmentShipment.findMany({
      where: { fromStoreCode, status: 'open' },
      orderBy: { openedAt: 'asc' },
    });
    // Conta itens + qty por remessa
    const result = await Promise.all(
      (shipments as any[]).map(async (s) => {
        const items = await this.prisma.transferOrder.findMany({
          where: { shipmentId: s.id } as any,
          select: { qtyOrigem: true } as any,
        });
        const totalQty = (items as any[]).reduce((sum, i) => sum + (i.qtyOrigem || 1), 0);
        return {
          id: s.id,
          code: s.code,
          fromStoreCode: s.fromStoreCode,
          fromStoreName: s.fromStoreName,
          toStoreCode: s.toStoreCode,
          toStoreName: s.toStoreName,
          status: s.status,
          openedAt: s.openedAt,
          totalItems: items.length,
          totalQty,
        };
      }),
    );
    return result;
  }

  /**
   * Lista os itens de uma remessa OPEN (pra mostrar no modal de detalhe).
   * Usado pelo click em "caixa em formação" — vendedora vê o que tá dentro.
   */
  async getShipmentItems(shipmentId: string) {
    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: shipmentId },
      select: {
        id: true,
        code: true,
        fromStoreCode: true,
        fromStoreName: true,
        toStoreCode: true,
        toStoreName: true,
        status: true,
      },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    const items = await this.prisma.transferOrder.findMany({
      where: { shipmentId } as any,
      orderBy: { realignmentSentAt: 'desc' } as any,
      select: {
        id: true,
        refCode: true,
        cor: true,
        tamanho: true,
        descricao: true,
        qtyOrigem: true,
        realignmentSentAt: true,
      } as any,
    });
    return { ...shipment, items };
  }

  /**
   * Remove UM item de uma remessa OPEN (vendedora errou e quer tirar).
   * Deleta o TransferOrder em vez de apenas desvincular — não polui a base
   * com pedidos pending órfãos da triagem.
   */
  async removeItemFromOpen(input: {
    transferOrderId: string;
    fromStoreCode: string;
  }) {
    const order = await this.prisma.transferOrder.findUnique({
      where: { id: input.transferOrderId },
      select: { id: true, lojaOrigemCode: true, shipmentId: true } as any,
    });
    if (!order) throw new NotFoundException('Item não encontrado');
    const o = order as any;
    if (o.lojaOrigemCode !== input.fromStoreCode) {
      throw new BadRequestException('Item não pertence à origem informada');
    }
    if (!o.shipmentId) throw new BadRequestException('Item não está em remessa');

    const shipment = await (this.prisma as any).realignmentShipment.findUnique({
      where: { id: o.shipmentId },
      select: { id: true, status: true },
    });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (shipment.status !== 'open') {
      throw new BadRequestException('Remessa já foi fechada — não pode remover item');
    }

    // Deleta o item da triagem (vai sumir do TransferOrder)
    await this.prisma.transferOrder.delete({ where: { id: o.id } });

    // Se a remessa ficou vazia, deleta ela também
    const remaining = await this.prisma.transferOrder.count({
      where: { shipmentId: shipment.id } as any,
    });
    if (remaining === 0) {
      await (this.prisma as any).realignmentShipment.delete({ where: { id: shipment.id } });
      return { ok: true, shipmentDeleted: true };
    }
    return { ok: true, shipmentDeleted: false, remaining };
  }

  /**
   * LIMPA TUDO — deleta todos os TransferOrders das remessas OPEN da origem
   * e deleta as próprias remessas OPEN. Não toca em nada in_transit/received.
   *
   * Usado pelo botão "Limpar tudo" na tela de triagem.
   */
  async wipeOpenForOrigin(input: { fromStoreCode: string }) {
    const opens = await (this.prisma as any).realignmentShipment.findMany({
      where: { fromStoreCode: input.fromStoreCode, status: 'open' },
      select: { id: true },
    });
    if (!opens.length) return { ok: true, deletedShipments: 0, deletedItems: 0 };
    const shipmentIds = (opens as any[]).map((s) => s.id);

    // Deleta os transferOrders
    const itemsDel = await this.prisma.transferOrder.deleteMany({
      where: { shipmentId: { in: shipmentIds } } as any,
    });

    // Deleta as remessas
    const shipDel = await (this.prisma as any).realignmentShipment.deleteMany({
      where: { id: { in: shipmentIds } },
    });

    this.logger.log(
      `[triagem] WIPE: ${shipDel.count} remessas + ${itemsDel.count} itens deletados (origem ${input.fromStoreCode})`,
    );
    return { ok: true, deletedShipments: shipDel.count, deletedItems: itemsDel.count };
  }

  /**
   * Fecha TODAS as remessas OPEN do par fromStoreCode em batch.
   * Pra cada uma chama closeAndSend (decreaseStock + obrigações + emit socket).
   *
   * Retorna lista com ok/erro de cada remessa.
   */
  async finalizarTriagem(input: { fromStoreCode: string; userId?: string }) {
    const from = await this.prisma.store.findUnique({
      where: { code: input.fromStoreCode },
      select: { id: true, code: true } as any,
    });
    if (!from) throw new NotFoundException(`Loja origem ${input.fromStoreCode} não encontrada`);

    const opens = await (this.prisma as any).realignmentShipment.findMany({
      where: { fromStoreCode: (from as any).code, status: 'open' },
      select: { id: true, code: true, toStoreCode: true },
    });

    if (!opens.length) {
      return { ok: true, fechadas: 0, results: [] };
    }

    const results: Array<{ shipmentId: string; code: string; toStoreCode: string; ok: boolean; error?: string }> =
      [];
    for (const s of opens as any[]) {
      try {
        await this.shipment.closeAndSend({
          shipmentId: s.id,
          storeId: (from as any).id,
          userId: input.userId,
        });
        results.push({ shipmentId: s.id, code: s.code, toStoreCode: s.toStoreCode, ok: true });
      } catch (e) {
        results.push({
          shipmentId: s.id,
          code: s.code,
          toStoreCode: s.toStoreCode,
          ok: false,
          error: (e as Error).message,
        });
      }
    }

    return {
      ok: results.every((r) => r.ok),
      fechadas: results.filter((r) => r.ok).length,
      falhas: results.filter((r) => !r.ok).length,
      results,
    };
  }
}
