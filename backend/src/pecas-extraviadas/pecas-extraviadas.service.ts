import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PEÇA EXTRAVIADA — "não peça mais ela, mas não desapareça"
 *  (27/08 — ordem do dono)
 *
 *  A loja reporta "não achei". Duas saídas erradas, as duas já tentadas:
 *
 *   1. ZERAR o saldo (o que o sistema fazia até hoje de manhã): apaga
 *      inventário de verdade na palavra de uma pessoa. Peça fora do lugar,
 *      arara trocada, bipe errado — tudo virava "não existe", e o saldo real
 *      não voltava sozinho.
 *   2. NÃO FAZER NADA (o que sobrou ao desligar aquilo): o número continua
 *      contando, o roteamento manda o próximo pedido pra mesma loja, e a
 *      matriz fica no carrossel de "não temos" — "vira festa".
 *
 *  A saída certa separa as duas coisas que estavam grudadas:
 *   · o SALDO fica (Consulta, balcão, inventário — nada muda);
 *   · o ROTEAMENTO passa longe daquela loja PRA AQUELE SKU.
 *
 *  E é por LOJA+SKU, não por pedido. A trava que existia era de tela ("já
 *  negou este pedido") e só valia pro pedido em curso — a loja que não achou
 *  hoje era escolhida de novo amanhã.
 *
 *  Achou depois? `marcarAchada` devolve a peça pro jogo. A linha continua no
 *  histórico: extraviada que vive reaparecendo é sintoma de arara bagunçada,
 *  e isso precisa de rastro.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** SKU sem zeros à esquerda — a mesma régua do espelho e do roteamento. */
const normSku = (sku: unknown) => String(sku ?? '').trim().replace(/^0+/, '');

@Injectable()
export class PecasExtraviadasService {
  private readonly logger = new Logger(PecasExtraviadasService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `0` desliga a exclusão no roteamento (a marcação continua sendo gravada —
   * o histórico não se perde, só deixa de influenciar a escolha da loja).
   */
  private get bloqueiaRoteamento(): boolean {
    return String(process.env.EXTRAVIADA_BLOQUEIA_ROTEAMENTO ?? '1').trim() !== '0';
  }

  /**
   * Marca peça(s) como extraviada(s) numa loja. Idempotente por
   * (loja, sku) ABERTO: reportar de novo não empilha linha — só soma a
   * quantidade se a loja disse que faltam mais.
   */
  async marcar(
    entradas: Array<{ storeCode: string; sku: string; qty?: number }>,
    ctx: { orderId?: string | null; pickOrderId?: string | null; motivo?: string; nota?: string | null; userId?: string | null } = {},
  ): Promise<number> {
    let gravadas = 0;
    for (const e of entradas) {
      const storeCode = String(e?.storeCode ?? '').trim();
      const sku = normSku(e?.sku);
      const qty = Math.max(1, Math.floor(Number(e?.qty) || 1));
      if (!storeCode || !sku) continue;

      const aberta = await (this.prisma as any).pecaExtraviada.findFirst({
        where: { storeCode, sku, achadaEm: null },
        select: { id: true, qty: true },
      });
      if (aberta) {
        if (qty > aberta.qty) {
          await (this.prisma as any).pecaExtraviada.update({
            where: { id: aberta.id },
            data: { qty },
          });
        }
        continue; // já estava marcada — não duplica
      }
      await (this.prisma as any).pecaExtraviada.create({
        data: {
          storeCode, sku, qty,
          orderId: ctx.orderId ?? null,
          pickOrderId: ctx.pickOrderId ?? null,
          motivo: ctx.motivo ?? null,
          nota: ctx.nota ?? null,
          marcadaPor: ctx.userId ?? null,
        },
      });
      gravadas++;
    }
    if (gravadas) {
      this.logger.log(
        `[extraviada] ${gravadas} peça(s) marcada(s): ` +
          entradas.map((e) => `${e.storeCode}/${normSku(e.sku)}`).join(', '),
      );
    }
    return gravadas;
  }

  /**
   * Mapa pro roteamento: `${storeCode}::${sku}` → quantidade extraviada ABERTA.
   * Mesma chave do `committed`, de propósito — as duas descontam no mesmo lugar.
   */
  async mapaParaRoteamento(skus: string[], storeCodes: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.bloqueiaRoteamento) return out;
    const skusNorm = Array.from(new Set(skus.map(normSku).filter(Boolean)));
    if (!skusNorm.length || !storeCodes.length) return out;

    const linhas = await (this.prisma as any).pecaExtraviada.findMany({
      where: { sku: { in: skusNorm }, storeCode: { in: storeCodes }, achadaEm: null },
      select: { storeCode: true, sku: true, qty: true },
    });
    for (const l of linhas) {
      const k = `${l.storeCode}::${l.sku}`;
      out.set(k, (out.get(k) ?? 0) + (Number(l.qty) || 1));
    }
    return out;
  }

  /** As extraviadas abertas desses SKUs — a tela pinta de vermelho com isto. */
  async abertasPorSkus(skus: string[]) {
    const skusNorm = Array.from(new Set((skus || []).map(normSku).filter(Boolean)));
    if (!skusNorm.length) return [];
    return (this.prisma as any).pecaExtraviada.findMany({
      where: { sku: { in: skusNorm }, achadaEm: null },
      orderBy: { marcadaEm: 'desc' },
      select: {
        id: true, storeCode: true, sku: true, qty: true, motivo: true,
        nota: true, marcadaEm: true, orderId: true,
      },
    });
  }

  /** Lista pra tela de gestão (abertas por padrão). */
  async listar(opts: { incluirAchadas?: boolean; storeCode?: string } = {}) {
    const linhas = await (this.prisma as any).pecaExtraviada.findMany({
      where: {
        ...(opts.incluirAchadas ? {} : { achadaEm: null }),
        ...(opts.storeCode ? { storeCode: opts.storeCode } : {}),
      },
      orderBy: { marcadaEm: 'desc' },
      take: 500,
    });
    if (!linhas.length) return [];

    /**
     * SKU SOZINHO NÃO SERVE PRA NINGUÉM PROCURAR PEÇA.
     *
     * Quem vai à arara precisa de REF · COR · TAMANHO — é assim que a peça é
     * achada fisicamente (a mesma razão de o `OrderItem` congelar esses três
     * campos). Nome da loja idem: "15" não diz nada pra quem não decorou os
     * códigos. Duas consultas em lote, não N+1.
     */
    const skus: string[] = Array.from(new Set<string>(linhas.map((l: any) => String(l.sku))));
    const lojas: string[] = Array.from(new Set<string>(linhas.map((l: any) => String(l.storeCode))));
    const pedidoIds: string[] = linhas.map((l: any) => l.orderId).filter(Boolean);

    const [produtos, stores, pedidos] = await Promise.all([
      (this.prisma as any).wincredProduto
        .findMany({
          where: { codigo: { in: skus } },
          select: { codigo: true, ref: true, cor: true, tamanho: true, descricaoCompleta: true, descricaoPdv: true },
        })
        .catch(() => [] as any[]) as Promise<any[]>,
      this.prisma.store
        .findMany({ where: { code: { in: lojas } }, select: { code: true, name: true } })
        .catch(() => [] as any[]) as Promise<any[]>,
      this.prisma.order
        .findMany({ where: { id: { in: pedidoIds } }, select: { id: true, wcOrderNumber: true } })
        .catch(() => [] as any[]) as Promise<any[]>,
    ]);
    const prodPorSku = new Map<string, any>(produtos.map((p: any) => [String(p.codigo), p]));
    const nomePorLoja = new Map<string, string>(stores.map((s: any) => [String(s.code), String(s.name)]));
    const pedidoPorId = new Map<string, string | null>(
      pedidos.map((o: any) => [String(o.id), o.wcOrderNumber ?? null]),
    );

    return linhas.map((l: any) => {
      const p: any = prodPorSku.get(String(l.sku));
      const rotulo = [p?.ref, p?.cor, p?.tamanho].filter(Boolean).join(' · ');
      return {
        ...l,
        storeName: nomePorLoja.get(l.storeCode) ?? null,
        ref: p?.ref ?? null,
        cor: p?.cor ?? null,
        tamanho: p?.tamanho ?? null,
        descricao: p?.descricaoCompleta || p?.descricaoPdv || null,
        // O que a pessoa lê na tela — cai pro SKU quando a peça não está no
        // catálogo (peça antiga, código digitado errado).
        rotulo: rotulo || String(l.sku),
        pedido: l.orderId ? pedidoPorId.get(l.orderId) ?? null : null,
        /** Dias parada — é o que separa "aconteceu hoje" de "ninguém olhou". */
        diasParada: Math.floor((Date.now() - new Date(l.marcadaEm).getTime()) / 86_400_000),
      };
    });
  }

  /**
   * "Achei a peça" — devolve ao jogo. Não apaga a linha: o histórico de quem
   * marcou e quem achou é o que denuncia arara bagunçada.
   */
  async marcarAchada(id: string, userId?: string | null) {
    return (this.prisma as any).pecaExtraviada.updateMany({
      where: { id, achadaEm: null },
      data: { achadaEm: new Date(), achadaPor: userId ?? null },
    });
  }

  /** Achei todas de um SKU numa loja (o caminho do conferidor de estoque). */
  async marcarAchadaPorSku(storeCode: string, sku: string, userId?: string | null) {
    return (this.prisma as any).pecaExtraviada.updateMany({
      where: { storeCode: String(storeCode).trim(), sku: normSku(sku), achadaEm: null },
      data: { achadaEm: new Date(), achadaPor: userId ?? null },
    });
  }
}
