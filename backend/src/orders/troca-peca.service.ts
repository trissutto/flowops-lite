import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { StockService } from '../stock/stock.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { PromoSiteService } from '../promo-site/promo-site.service';
import { RoutingService } from '../routing/routing.service';
import { ehItemSemEstoque } from '../common/item-sem-estoque';
import { conferirDiferencaNoGateway, diferencaDeTrocaPendente } from '../common/diferenca-troca';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TROCAR A PEÇA DO PEDIDO, PELA RETAGUARDA (21/08 — pedido do dono)
 *
 *  A cliente compra e pede outra cor/tamanho no WhatsApp; ou a peça sai de
 *  linha entre a compra e a separação. Trocar o SKU é a parte fácil — o que
 *  faltava era o DINHEIRO fechar, e é isso que este serviço resolve:
 *
 *    peça nova MAIS CARA  → link de pagamento da diferença (/pg/<token>) e a
 *                           separação fica TRAVADA até a cliente pagar;
 *    peça nova MAIS BARATA → vale nominal no CPF dela (o mesmo `SiteCupom`
 *                           `origem='troca'` do portal, que vale no site E no
 *                           caixa das lojas);
 *    mesmo preço          → troca seca.
 *
 *  QUANDO PODE (decisão do dono): até a loja BIPAR. Depois do bipe a peça já
 *  saiu do estoque e está separada fisicamente na arara de alguém — trocar
 *  ali é confusão na loja. Daí em diante o caminho é devolução/troca.
 *
 *  O VALOR É SUGERIDO, NÃO IMPOSTO: o preview calcula a diferença pela régua
 *  do site (precoPromo digitado > promoção de 50% > preço do ERP), mas quem
 *  confirma o número é a matriz — ela é quem negociou com a cliente, e
 *  cortesia/arredondamento existe todo dia.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class TrocaPecaService {
  private readonly logger = new Logger(TrocaPecaService.name);

  /** Loja-canal do site: é dela a config do gateway na cobrança da diferença. */
  private static readonly CANAL_STORE_CODE = '13';

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: WincredCatalogService,
    private readonly stock: StockService,
    private readonly pagarme: PagarmeService,
    private readonly promo: PromoSiteService,
    private readonly routing: RoutingService,
  ) {}

  /** A trava da diferença está ligada? `TROCA_PECA_TRAVA=0` desliga. */
  static travaLigada(): boolean {
    return String(process.env.TROCA_PECA_TRAVA ?? '').trim() !== '0';
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PREVIEW — o que vai acontecer se trocar por esta peça
  // ─────────────────────────────────────────────────────────────────────────

  async preview(wcOrderId: number, orderItemId: string, codigo: string) {
    const { order, item } = await this.carregar(wcOrderId, orderItemId);
    const bloqueio = await this.motivoDeBloqueio(order);

    const novo = await this.resolverPeca(codigo);
    const qty = Math.max(1, Number(item.quantity) || 1);
    const precoAntigo = Number(item.unitPrice ?? 0);
    const diffUnit = Math.round((novo.precoSite - precoAntigo) * 100) / 100;
    const diffTotal = Math.round(diffUnit * qty * 100) / 100;

    // Estoque da peça nova na rede — a matriz não deveria trocar por peça que
    // ninguém tem (viraria ruptura logo em seguida).
    let estoqueRede = 0;
    let lojasComEstoque: Array<{ storeCode: string; qty: number }> = [];
    try {
      const lojas = await this.prisma.store.findMany({ where: { active: true }, select: { code: true } });
      const entradas = await this.stock.getStockFor([novo.sku], lojas.map((l) => l.code));
      lojasComEstoque = entradas
        .filter((e) => e.availableQty > 0)
        .map((e) => ({ storeCode: e.storeCode, qty: e.availableQty }))
        .sort((a, b) => b.qty - a.qty);
      estoqueRede = lojasComEstoque.reduce((s, l) => s + l.qty, 0);
    } catch (e: any) {
      this.logger.warn(`[troca-peca] estoque da peça nova indisponível: ${e?.message || e}`);
    }

    return {
      ok: !bloqueio,
      bloqueio,
      item: {
        id: item.id,
        sku: item.sku,
        nome: item.productName,
        ref: (item as any).ref ?? null,
        cor: (item as any).cor ?? null,
        tamanho: (item as any).tamanho ?? null,
        qty,
        precoPago: precoAntigo,
      },
      nova: {
        sku: novo.sku,
        nome: novo.nome,
        ref: novo.ref,
        cor: novo.cor,
        tamanho: novo.tamanho,
        precoErp: novo.precoErp,
        precoSite: novo.precoSite,
        motivoDoPreco: novo.motivoDoPreco,
        estoqueRede,
        lojasComEstoque: lojasComEstoque.slice(0, 5),
      },
      // Sugestão — a tela deixa a matriz ajustar antes de confirmar.
      diferencaSugerida: diffTotal,
      tipoSugerido: diffTotal > 0.009 ? 'cobranca' : diffTotal < -0.009 ? 'vale' : 'neutro',
      clienteTemCpf: !!String(order.customerCpf || '').replace(/\D/g, ''),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  APLICAR
  // ─────────────────────────────────────────────────────────────────────────

  async aplicar(
    wcOrderId: number,
    input: {
      orderItemId: string;
      codigo: string;
      /** Valor CONFIRMADO pela matriz (positivo cobra, negativo devolve). */
      diferenca?: number;
      motivo?: string;
    },
    userId?: string | null,
  ) {
    const { order, item } = await this.carregar(wcOrderId, input.orderItemId);
    const bloqueio = await this.motivoDeBloqueio(order);
    if (bloqueio) throw new BadRequestException(bloqueio);

    const novo = await this.resolverPeca(input.codigo);
    if (novo.sku === item.sku) throw new BadRequestException('É a mesma peça — nada pra trocar.');

    const qty = Math.max(1, Number(item.quantity) || 1);
    const precoAntigo = Number(item.unitPrice ?? 0);
    const sugerida = Math.round((novo.precoSite - precoAntigo) * qty * 100) / 100;
    const diff = input.diferenca == null ? sugerida : Math.round(Number(input.diferenca) * 100) / 100;
    const diffCents = Math.round(diff * 100);
    const tipo = diffCents > 0 ? 'cobranca' : diffCents < 0 ? 'vale' : 'neutro';

    // O preço que fica no item é o que a cliente EFETIVAMENTE paga por ele:
    // o que ela já tinha pago mais a diferença acertada agora. Assim a nota
    // fiscal e o acerto entre lojas contam a mesma história do dinheiro.
    const novoUnit = Math.round((precoAntigo + diff / qty) * 100) / 100;

    const swap = await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          sku: novo.sku,
          productName: novo.nome,
          ref: novo.ref,
          cor: novo.cor,
          tamanho: novo.tamanho,
          unitPrice: novoUnit,
          baseUnitPrice: novo.precoErp || novoUnit,
          // A peça nova pode estar em OUTRA loja — quem separa se decide no
          // re-roteamento logo abaixo.
          assignedStoreId: null,
        },
      });

      const criado = await (tx as any).orderItemSwap.create({
        data: {
          orderId: order.id,
          orderItemId: item.id,
          wcOrderNumber: order.wcOrderNumber ?? null,
          oldSku: item.sku,
          oldName: item.productName ?? null,
          oldPriceCents: Math.round(precoAntigo * 100),
          newSku: novo.sku,
          newName: novo.nome,
          newPriceCents: Math.round(novoUnit * 100),
          qty,
          diffCents,
          tipo,
          status: tipo === 'cobranca' ? 'pending' : 'settled',
          settledAt: tipo === 'cobranca' ? null : new Date(),
          motivo: (input.motivo || '').slice(0, 300) || null,
          createdByUserId: userId ?? null,
        },
      });

      // Total do pedido acompanha a troca — senão a tela, a nota e o acerto
      // seguem falando do valor antigo.
      const itens = await tx.orderItem.findMany({ where: { orderId: order.id } });
      const somaPecas = itens
        .filter((i: any) => !ehItemSemEstoque(i))
        .reduce((s: number, i: any) => s + Number(i.unitPrice || 0) * (Number(i.quantity) || 1), 0);
      const frete = this.freteDoPedido(order);
      const desconto = this.descontoDoPedido(order);
      await tx.order.update({
        where: { id: order.id },
        data: { totalAmount: Math.round((somaPecas + frete - desconto) * 100) / 100 },
      });

      await tx.orderHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: order.status,
          note:
            `Peça trocada pela retaguarda: ${item.sku} (${item.productName ?? '—'}) → ` +
            `${novo.sku} (${novo.nome}). ` +
            (tipo === 'cobranca'
              ? `Diferença de R$ ${diff.toFixed(2)} A COBRAR — separação travada até a cliente pagar.`
              : tipo === 'vale'
                ? `Diferença de R$ ${Math.abs(diff).toFixed(2)} A DEVOLVER — vale nominal no CPF.`
                : 'Mesmo preço, sem acerto.') +
            (input.motivo ? ` Motivo: ${input.motivo}` : ''),
        },
      });

      return criado;
    });

    // ── O acerto do dinheiro (fora da transação: fala com gateway) ──
    let cobranca: any = null;
    let vale: any = null;
    if (tipo === 'cobranca') {
      cobranca = await this.gerarCobranca(order, swap.id, Math.abs(diff)).catch((e: any) => {
        this.logger.error(`[troca-peca] link da diferença falhou (swap ${swap.id}): ${e?.message || e}`);
        return { erro: String(e?.message || e).slice(0, 300) };
      });
    } else if (tipo === 'vale') {
      vale = await this.gerarVale(order, swap.id, Math.abs(diff)).catch((e: any) => {
        this.logger.error(`[troca-peca] vale falhou (swap ${swap.id}): ${e?.message || e}`);
        return { erro: String(e?.message || e).slice(0, 300) };
      });
    }

    /**
     * RE-ROTEIA — o card da loja mostra as peças pelo `assignedStoreId`, e a
     * peça nova pode nem existir na loja que estava separando. Sem refazer,
     * a vendedora abre o card e procura na arara uma peça que mudou.
     *
     * `recalculateForWc` cancela os cards ativos, devolve o que estivesse
     * bipado e roteia de novo. Com diferença A COBRAR o próprio
     * `confirmRoute` recusa recriar (a trava) — e é isso que a gente quer:
     * cards cancelados, pedido esperando o dinheiro. O erro da trava é
     * resultado esperado, não falha.
     */
    let reroteado: any = null;
    const tinhaCards = await this.prisma.pickOrder.count({
      where: { orderId: order.id, status: { in: ['new', 'separating'] } },
    });
    if (tinhaCards > 0) {
      try {
        reroteado = await this.routing.recalculateForWc(order.id);
      } catch (e: any) {
        reroteado = { ok: false, motivo: String(e?.message || e).slice(0, 300) };
        this.logger.log(
          `[troca-peca] ${order.wcOrderNumber}: cards cancelados e separação NÃO recriada — ${reroteado.motivo}`,
        );
      }
    }

    this.logger.log(
      `[troca-peca] ${order.wcOrderNumber}: ${item.sku} → ${novo.sku} · ${tipo} R$ ${diff.toFixed(2)}` +
        (cobranca?.shortUrl ? ` · link ${cobranca.shortUrl}` : '') +
        (vale?.code ? ` · vale ${vale.code}` : ''),
    );

    return {
      ok: true,
      swapId: swap.id,
      tipo,
      diferenca: diff,
      novoItem: { sku: novo.sku, nome: novo.nome, precoUnit: novoUnit },
      cobranca,
      vale,
      reroteado,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  ACERTOS
  // ─────────────────────────────────────────────────────────────────────────

  /** Link de pagamento da diferença (Pagar.me, pelo nosso /pg/<token>). */
  private async gerarCobranca(order: any, swapId: string, valor: number) {
    const link = await this.pagarme.createCheckoutLink({
      // `saleId` aqui não é venda de PDV: é a chave de rastreio do pagamento.
      // O webhook só atualiza o `pagarme_payments` por `pagarmeOrderId`, e o
      // resto do fluxo dele ignora saleId que não é carrinho de live.
      saleId: `troca:${swapId}`,
      valor,
      storeCode: TrocaPecaService.CANAL_STORE_CODE,
      customerName: order.customerName || undefined,
      customerCpf: order.customerCpf || undefined,
      customerEmail: order.customerEmail || undefined,
      customerPhone: order.customerPhone || undefined,
    });
    await (this.prisma as any).orderItemSwap.update({
      where: { id: swapId },
      data: {
        pagarmeOrderId: link.pagarmeOrderId,
        linkToken: link.shortUrl.split('/').pop() ?? null,
        linkUrl: link.shortUrl,
        linkExpiresAt: link.expiresAt,
      },
    });
    return { shortUrl: link.shortUrl, expiresAt: link.expiresAt, valor };
  }

  /**
   * Vale NOMINAL no CPF da cliente — o mesmo `SiteCupom` do portal de trocas
   * (`origem='troca'`), que é o único que o caixa do PDV aceita. Sem CPF no
   * pedido não dá pra emitir: vale sem dono vira código circulando em print
   * de WhatsApp.
   */
  private async gerarVale(order: any, swapId: string, valor: number) {
    const cpf = String(order.customerCpf || '').replace(/\D/g, '');
    if (cpf.length !== 11) {
      throw new BadRequestException(
        'Pedido sem CPF — o vale é nominal e não pode ser emitido. Preencha o CPF da cliente no pedido e refaça o acerto.',
      );
    }
    const code = `TROCA${String(order.wcOrderNumber || '').replace(/\D/g, '').slice(-6)}${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`.slice(0, 30);
    const noventaDias = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await (this.prisma as any).siteCupom.create({
      data: {
        code,
        label: `Vale da troca do pedido ${order.wcOrderNumber ?? ''}`.trim().slice(0, 80),
        tipo: 'fixed',
        valor,
        usoMaximo: 1,
        ativo: true,
        fimEm: noventaDias,
        cpf,
        origem: 'troca',
        atualizadoPor: 'troca-peca-retaguarda',
      },
    });
    await (this.prisma as any).orderItemSwap.update({
      where: { id: swapId },
      data: { cupomCode: code },
    });
    return { code, valor, validoAte: noventaDias };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  STATUS / TRAVA
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Trocas do pedido, com o estado do dinheiro ATUALIZADO — a cobrança
   * pendente é conferida no gateway (o webhook grava `paid` no
   * `pagarme_payments`) e vira `settled` na hora em que a cliente paga.
   */
  async listar(wcOrderId: number) {
    const order = await this.prisma.order.findFirst({
      where: { wcOrderId },
      select: { id: true },
    });
    if (!order) return { trocas: [], travando: false };

    const swaps: any[] = await (this.prisma as any).orderItemSwap.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
    });
    const atualizados: any[] = [];
    for (const s of swaps) {
      atualizados.push(await conferirDiferencaNoGateway(this.prisma as any, s));
    }
    return {
      trocas: atualizados.map((s) => ({
        id: s.id,
        tipo: s.tipo,
        status: s.status,
        oldSku: s.oldSku,
        oldName: s.oldName,
        newSku: s.newSku,
        newName: s.newName,
        diferenca: s.diffCents / 100,
        linkUrl: s.linkUrl,
        linkExpiresAt: s.linkExpiresAt,
        cupomCode: s.cupomCode,
        motivo: s.motivo,
        createdAt: s.createdAt,
        settledAt: s.settledAt,
      })),
      travando: atualizados.some((s) => s.tipo === 'cobranca' && s.status === 'pending'),
    };
  }

  /**
   * A diferença de uma troca ainda está esperando pagamento? A régua mora em
   * `common/diferenca-troca.ts` porque o routing consulta a MESMA — e ele não
   * pode importar este módulo (ciclo).
   */
  async diferencaPendente(orderId: string): Promise<{ travado: boolean; motivo?: string }> {
    return diferencaDeTrocaPendente(this.prisma as any, orderId);
  }

  /**
   * CORTESIA: libera a separação sem receber a diferença. Existe porque
   * trava sem porta de saída vira pedido parado — e às vezes a casa decide
   * absorver (peça com defeito, erro nosso, cliente antiga).
   */
  async liberarSemCobrar(swapId: string, motivo: string, userId?: string | null) {
    const swap: any = await (this.prisma as any).orderItemSwap.findUnique({ where: { id: swapId } });
    if (!swap) throw new NotFoundException('Troca não encontrada');
    if (swap.status !== 'pending') return { ok: true, jaResolvido: true, status: swap.status };
    const atualizado = await (this.prisma as any).orderItemSwap.update({
      where: { id: swapId },
      data: {
        status: 'settled',
        settledAt: new Date(),
        motivo: [swap.motivo, `CORTESIA por ${userId ?? 'matriz'}: ${motivo}`].filter(Boolean).join(' · ').slice(0, 300),
      },
    });
    await this.prisma.orderHistory.create({
      data: {
        orderId: swap.orderId,
        fromStatus: 'separating',
        toStatus: 'separating',
        note: `Diferença de R$ ${(swap.diffCents / 100).toFixed(2)} LIBERADA SEM COBRAR (cortesia): ${motivo}`,
      },
    });
    this.logger.warn(`[troca-peca] swap ${swapId} liberado sem cobrar: ${motivo}`);
    return { ok: true, status: atualizado.status };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async carregar(wcOrderId: number, orderItemId: string) {
    const order: any = await this.prisma.order.findFirst({
      where: { wcOrderId },
      include: { pickOrders: { select: { id: true, status: true } } },
    });
    if (!order) throw new NotFoundException('Pedido não encontrado no banco local.');
    const item = await this.prisma.orderItem.findUnique({ where: { id: orderItemId } });
    if (!item || item.orderId !== order.id) {
      throw new NotFoundException('Item não pertence a este pedido.');
    }
    if (ehItemSemEstoque(item as any)) {
      throw new BadRequestException('Frete não é peça — não dá pra trocar essa linha.');
    }
    return { order, item };
  }

  /**
   * Por que ESTE pedido não pode ter peça trocada agora. Null = pode.
   * A ordem é a da operação: o que já saiu fisicamente pesa mais.
   */
  private async motivoDeBloqueio(order: any): Promise<string | null> {
    if (['shipped', 'delivered', 'cancelled'].includes(String(order.status))) {
      return 'Pedido já despachado ou cancelado — a troca agora é pelo portal de trocas/devolução.';
    }
    const avancado = (order.pickOrders || []).find((p: any) =>
      ['separated', 'ready', 'shipped'].includes(String(p.status)),
    );
    if (avancado) {
      return 'A loja já finalizou a separação — a peça está separada fisicamente. Use devolução/troca.';
    }
    // Bipe ativo = peça na mão da vendedora e estoque já baixado (18/08).
    const bipes = await (this.prisma as any).pickOrderScan
      .count({ where: { orderId: order.id, revertedAt: null } })
      .catch(() => 0);
    if (bipes > 0) {
      return 'A loja já começou a bipar este pedido — a peça saiu do estoque. Peça pra ela reportar o item ou finalize e trate como devolução.';
    }
    const nota = await (this.prisma as any).nfeDoc
      .findFirst({
        where: {
          shipmentId: { in: (order.pickOrders || []).map((p: any) => `envio:${p.id}`) },
          status: 'authorized',
        },
        select: { numero: true },
      })
      .catch(() => null);
    if (nota) {
      return `Já existe NF-e autorizada (nº ${nota.numero}) para este pedido — trocar a peça agora deixaria a nota errada.`;
    }
    return null;
  }

  /**
   * A peça nova, com o preço QUE O SITE COBRA hoje — a mesma régua do
   * catálogo: `precoPromo` digitado vence tudo; senão, a promoção de 50%
   * automática; senão, o preço do ERP.
   */
  private async resolverPeca(codigo: string) {
    const sku = String(codigo || '').trim();
    if (!sku) throw new BadRequestException('Informe o código da peça nova.');
    const info = await this.catalog.getPdvProductInfo(sku).catch(() => null);
    if (!info) {
      throw new BadRequestException(`Peça ${sku} não encontrada no catálogo — confira o código.`);
    }
    const precoErp = Number(info.preco || 0);
    const ref = info.ref ? String(info.ref).trim() : null;

    let precoSite = precoErp;
    let motivoDoPreco = 'preço do ERP';
    if (ref) {
      const site: any = await (this.prisma as any).siteProduto
        .findFirst({ where: { ref }, select: { precoPromo: true } })
        .catch(() => null);
      const digitado = site?.precoPromo != null && Number(site.precoPromo) > 0 ? Number(site.precoPromo) : null;
      if (digitado) {
        precoSite = Math.round(digitado * 100) / 100;
        motivoDoPreco = 'preço promocional digitado no site';
      } else {
        const chave = ref.toUpperCase().replace(/\s+/g, '');
        const promo = await this.promo.porChave(chave).catch(() => null);
        if (promo?.elegivel && this.promo.ligada && precoErp > 0) {
          precoSite = this.promo.precoComDesconto(precoErp);
          motivoDoPreco = `promoção de 50% (${promo.motivo})`;
        }
      }
    }

    return {
      sku: info.sku,
      nome: [ref, info.descricao, info.cor, info.tamanho].filter(Boolean).join(' ').trim() || info.descricao || sku,
      ref,
      cor: info.cor ? String(info.cor).trim() : null,
      tamanho: info.tamanho ? String(info.tamanho).trim() : null,
      precoErp,
      precoSite,
      motivoDoPreco,
    };
  }

  /** Frete cobrado da cliente (snapshot do checkout; 0 quando não há). */
  private freteDoPedido(order: any): number {
    try {
      const ck = JSON.parse(order.checkoutInfo || '{}');
      return Math.round((Number(ck?.shipping?.price ?? ck?.shippingPrice ?? 0) || 0) * 100) / 100;
    } catch {
      return 0;
    }
  }

  /** Desconto concedido (cupom + PIX) do checkout. */
  private descontoDoPedido(order: any): number {
    try {
      const ck = JSON.parse(order.checkoutInfo || '{}');
      const d = Number(ck?.discount ?? 0) || Number(ck?.descontoCupom ?? 0) + Number(ck?.descontoPix ?? 0);
      return Math.max(0, Math.round((d || 0) * 100) / 100);
    } catch {
      return 0;
    }
  }
}
