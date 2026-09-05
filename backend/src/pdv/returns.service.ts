import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { CashService } from './cash.service';
import { CashbackService } from '../cashback/cashback.service';

/**
 * Devolução / Troca de venda finalizada.
 *
 * 3 modos:
 *   - 'dinheiro' → estorna estoque + sangria automática no caixa
 *   - 'troca'    → estorna estoque + gera vale-troca consumido no mesmo dia
 *                  (cliente já leva nova peça, ajuste vai pra split de pgto)
 *   - 'credito'  → estorna estoque + gera vale-troca com prazo (90d default)
 *                  cliente pode usar em outra venda futura
 *
 * Estoque sempre volta pro Flow via ErpService.increaseStock (mesma loja).
 *
 * Vale-troca tem código único (TROCA-XXXXX) que pode ser bipado no PDV em
 * qualquer venda futura — o ReturnsService.useCredit valida e marca como usado.
 */
@Injectable()
export class ReturnsService {
  private readonly logger = new Logger(ReturnsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly cash: CashService,
    private readonly cashback: CashbackService,
  ) {}

  // ── Lookup ─────────────────────────────────────────────────────────

  /**
   * Busca venda finalizada pra montar tela de devolução.
   * Aceita id (uuid) OU número do cupom (futuramente).
   */
  async lookupSale(query: string) {
    const cleanQ = String(query || '').trim();
    if (!cleanQ) throw new BadRequestException('Informe o ID/cupom da venda');

    let sale: any = null;

    // Tenta como UUID (id direto)
    if (/^[0-9a-f-]{20,}$/i.test(cleanQ)) {
      sale = await (this.prisma as any).pdvSale.findUnique({
        where: { id: cleanQ },
        include: {
          items: { orderBy: { createdAt: 'asc' } },
          payments: true,
        },
      });
    }

    // Tenta como número de NFC-e
    if (!sale) {
      sale = await (this.prisma as any).pdvSale.findFirst({
        where: { nfceNumber: cleanQ },
        include: {
          items: { orderBy: { createdAt: 'asc' } },
          payments: true,
        },
      });
    }

    // PEDIDO ONLINE no balcão (28/08): id do Order ou nº digitado
    // ("LP-000123"/"ON-000045") — mesmo shape de resposta da venda do PDV.
    if (!sale) {
      const pedido = await this.carregarPedidoDevolvivel(cleanQ);
      if (pedido) {
        const devolucoesAnteriores = await (this.prisma as any).pdvReturn.findMany({
          where: this.whereDevolucoesDe(pedido),
          include: { items: true },
        });
        const devolvido = new Map<string, number>();
        for (const ret of devolucoesAnteriores as any[]) {
          for (const it of ret.items) {
            const id = it.originalItemId || it.sku;
            devolvido.set(id, (devolvido.get(id) || 0) + (it.qty || 0));
          }
        }
        return {
          sale: {
            id: pedido.id,
            storeCode: pedido.storeCode,
            storeName: pedido.storeName,
            customerName: pedido.customerName,
            customerCpf: pedido.customerCpf,
            total: pedido.total,
            finalizedAt: pedido.finalizedAt,
            nfceNumber: null,
            origem: 'pedido_online',
            pedidoNumero: pedido.pedidoNumero,
          },
          items: (pedido.items as any[]).map((it) => {
            const jaDev = devolvido.get(it.id) || 0;
            return { ...it, jaDevolvido: jaDev, disponivel: Math.max(0, (it.qty || 0) - jaDev) };
          }),
          previousReturns: devolucoesAnteriores.length,
        };
      }
    }

    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'finalized') {
      throw new BadRequestException(`Venda está ${sale.status}, não dá pra devolver`);
    }

    // Já tem devolução? Quanto sobrou pra devolver?
    const previousReturns = await (this.prisma as any).pdvReturn.findMany({
      where: { originalSaleId: sale.id },
      include: { items: true },
    });

    const devolvidoPorItem = new Map<string, number>();
    for (const ret of previousReturns as any[]) {
      for (const it of ret.items) {
        const id = it.originalItemId || it.sku;
        devolvidoPorItem.set(id, (devolvidoPorItem.get(id) || 0) + (it.qty || 0));
      }
    }

    const itemsComSaldo = (sale.items as any[]).map((it: any) => {
      const jaDev = devolvidoPorItem.get(it.id) || 0;
      const disponivel = Math.max(0, (it.qty || 0) - jaDev);
      return {
        id: it.id,
        sku: it.sku,
        ref: it.ref,
        cor: it.cor,
        tamanho: it.tamanho,
        descricao: it.descricao,
        qty: it.qty,
        precoUnit: it.precoUnit,
        desconto: it.desconto,
        total: it.total,
        jaDevolvido: jaDev,
        disponivel,
      };
    });

    return {
      sale: {
        id: sale.id,
        storeCode: sale.storeCode,
        storeName: sale.storeName,
        customerName: sale.customerName,
        customerCpf: sale.customerCpf,
        total: sale.total,
        finalizedAt: sale.finalizedAt,
        nfceNumber: sale.nfceNumber,
      },
      items: itemsComSaldo,
      previousReturns: previousReturns.length,
    };
  }

  /**
   * Busca vendas FINALIZADAS que contém o SKU informado, ordenadas
   * da mais recente pra mais antiga. Permite vendedora bipar a peça
   * de volta sem precisar do cupom da venda original.
   *
   * Retorna até 20 vendas. Se houver MUITAS, vendedora pode digitar
   * o nome do cliente ou o cupom específico no campo busca tradicional.
   *
   * Cada venda já vem com info se o item específico foi totalmente
   * devolvido em devoluções anteriores (pra desabilitar essa venda
   * na UI se já foi devolvida).
   */
  /**
   * Busca vendas finalizadas com determinado SKU.
   *
   * @param sku       SKU/REF bipado pela vendedora
   * @param storeCode (opcional) FILTRO POR LOJA — modo A2 (estrito por loja
   *                  com override admin). Vendedora comum só vê vendas
   *                  da loja dela. Admin que precisa ver vendas de outra
   *                  loja passa storeCode=null (controller só permite
   *                  isso se role=admin/operator E ?crossStore=1).
   */
  async lookupSalesBySku(sku: string, homeStoreCode?: string | null) {
    const cleanSku = String(sku || '').trim();
    if (!cleanSku) throw new BadRequestException('Informe o SKU/REF da peça');

    // Busca vendas finalizadas que tem item com esse SKU/REF/EAN.
    // Janela 90 dias — cobre devolução de venda do mês passado +.
    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - 90);

    // ── Vendas de TODA a rede, loja local em DESTAQUE (regra do dono) ──
    // O bipe traz as vendas da LOJA ATUAL em cima e as das OUTRAS lojas
    // embaixo (cada bloco da mais nova pra mais velha). homeStoreCode marca
    // qual é a "casa" (sameStore=true). Tudo do Postgres do Flow.

    // VARIANTES: gera todas variacoes do SKU com/sem zeros a esquerda
    // (ex: '5210367', '0005210367', '00000005210367', ...). Sem isso, peca
    // bipada como '5210367' nao bateria em item salvo como '0005210367'.
    // skuVariants foi tornado publico no ErpService pra ser reutilizado aqui.
    const variants = this.erp.skuVariants(cleanSku);

    // Filtro RESTRITIVO: match EXATO contra qualquer variante em sku/ref/ean.
    // `IN` de Prisma usa index — bem mais rapido que startsWith.
    // Mantem startsWith APENAS pra sku/ref (cobrir REF base que tem multiplos
    // SKUs derivados, ex: '5210367' bate em '5210367-XL').
    const useStartsWith = cleanSku.length >= 5;
    const itemFilter: any = {
      OR: [
        { sku: { in: variants } },
        { ref: { in: variants } },
        { ean: { in: variants } },
        ...(useStartsWith ? [
          { sku: { startsWith: cleanSku, mode: 'insensitive' as const } },
          { ref: { startsWith: cleanSku, mode: 'insensitive' as const } },
        ] : []),
      ],
    };

    const home = (homeStoreCode || '').trim() || null;

    /**
     * MARCAÇÃO FORA DA BUSCA DE DEVOLUÇÃO (31/08).
     *
     * A marcação ("levou pra provar") é gravada como PdvSale `finalized` com
     * `paymentMethod='MARCADO'` e zero pagamento. Sem este filtro ela aparecia
     * aqui como venda devolvível: a vendedora bipava a peça que a cliente
     * trouxe de volta, escolhia a marcação, e o sistema emitia VALE DE TROCA
     * pelo valor cheio — crédito de um dinheiro que nunca entrou.
     *
     * Barrar só no `createReturn` não bastava: a peça continuaria aparecendo
     * na tela pra ela escolher e tomar erro. Peça de marcado volta pela tela
     * de Marcados → "Devolver ao estoque".
     */
    const naoEhMarcacao = {
      OR: [{ paymentMethod: null }, { paymentMethod: { not: 'MARCADO' } }],
    };

    const findFinalized = (extra: any, take: number) =>
      (this.prisma as any).pdvSale.findMany({
        where: {
          status: 'finalized',
          finalizedAt: { gte: dataLimite },
          items: { some: itemFilter },
          ...naoEhMarcacao,
          ...extra,
        },
        orderBy: { finalizedAt: 'desc' },
        take,
        include: { items: { where: itemFilter } },
      });

    // LOJA LOCAL (destaque) em cima, REDE (outras lojas) embaixo. Cada bloco
    // já vem da mais nova pra mais velha (orderBy finalizedAt desc).
    let localSales: any[] = home ? await findFinalized({ storeCode: home }, 20) : [];
    let otherSales: any[] = await findFinalized(home ? { storeCode: { not: home } } : {}, 20);
    let sales = [...localSales, ...otherSales];

    // Fallback: se NADA finalized, tenta vendas recentes (7d) em qualquer status
    // (PIX ainda não confirmado, venda cancelada por engano) — mesma ordem.
    if (sales.length === 0) {
      const dataRecente = new Date();
      dataRecente.setDate(dataRecente.getDate() - 7);
      const findRecent = (extra: any, take: number) =>
        (this.prisma as any).pdvSale.findMany({
          // `naoEhMarcacao` também aqui: sem isso o fallback reabria justamente
          // o caminho que o filtro de cima fechou — marcação é o caso mais
          // comum de "venda recente com essa peça" quando não há venda real.
          where: { createdAt: { gte: dataRecente }, items: { some: itemFilter }, ...naoEhMarcacao, ...extra },
          orderBy: { createdAt: 'desc' },
          take,
          include: { items: { where: itemFilter } },
        });
      const localR = home ? await findRecent({ storeCode: home }, 5) : [];
      const otherR = await findRecent(home ? { storeCode: { not: home } } : {}, 5);
      sales = [...localR, ...otherR];
    }

    // ── PEDIDO ONLINE com essa peça (28/08 — troca do site no balcão) ──
    // Site novo/live/venda online: pago. Site velho (WC, sem paidAt): já
    // despachado. Mesma janela de 90d do PDV.
    const filtroItemPedido: any = {
      cancelledAt: null,
      OR: [
        { sku: { in: variants } },
        { ref: { in: variants } },
        ...(useStartsWith
          ? [
              { sku: { startsWith: cleanSku, mode: 'insensitive' as const } },
              { ref: { startsWith: cleanSku, mode: 'insensitive' as const } },
            ]
          : []),
      ],
    };
    const pedidos: any[] = await (this.prisma as any).order
      .findMany({
        where: {
          createdAt: { gte: dataLimite },
          status: { notIn: ['cancelled', 'canceled', 'refunded'] },
          OR: [
            { paidAt: { not: null } },
            { source: 'site', status: { in: ['separating', 'shipped', 'delivered'] } },
          ],
          items: { some: filtroItemPedido },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { items: { where: filtroItemPedido } },
      })
      .catch(() => []);

    let linhasPedidos: any[] = [];
    if (pedidos.length) {
      const devolucoesPedidos = await (this.prisma as any).pdvReturn.findMany({
        where: { originalOrderId: { in: pedidos.map((o: any) => o.id) } },
        include: { items: true },
      });
      const devolvidoPedido = new Map<string, number>();
      for (const ret of devolucoesPedidos as any[]) {
        for (const it of ret.items) {
          const id = it.originalItemId || it.sku;
          devolvidoPedido.set(id, (devolvidoPedido.get(id) || 0) + (it.qty || 0));
        }
      }
      linhasPedidos = pedidos.map((o: any) => {
        const fator = this.fatorPagoDoPedido(o);
        const numero = o.wcOrderNumber || String(o.wcOrderId || o.id.slice(0, 8));
        const matchedItems = (o.items as any[]).map((it: any) => {
          const qty = Number(it.quantity) || 1;
          const precoUnit = Math.round((Number(it.unitPrice) || 0) * fator * 100) / 100;
          const jaDev = devolvidoPedido.get(it.id) || 0;
          return {
            id: it.id,
            sku: it.sku,
            ref: it.ref ?? null,
            cor: it.cor ?? null,
            tamanho: it.tamanho ?? null,
            descricao: it.productName || it.sku,
            qty,
            precoUnit,
            total: Math.round(precoUnit * qty * 100) / 100,
            jaDevolvido: jaDev,
            disponivel: Math.max(0, qty - jaDev),
          };
        });
        return {
          saleId: o.id,
          nfceNumber: null,
          origem: 'pedido_online',
          pedidoNumero: numero,
          storeCode: null,
          storeName: `Pedido online ${numero}`,
          sameStore: false,
          customerName: o.customerName,
          customerCpf: o.customerCpf,
          finalizedAt: o.paidAt || o.wcDateCreated || o.createdAt,
          totalVenda: Number(o.totalAmount) || 0,
          sellerName: o.sellerName ?? null,
          status: 'finalized',
          matchedItems,
          totalmenteDevolvido: matchedItems.every((it: any) => it.disponivel === 0),
        };
      });
    }

    if (sales.length === 0 && linhasPedidos.length === 0) {
      return { sku: cleanSku, homeStoreCode: home, sales: [] };
    }
    if (sales.length === 0) {
      return { sku: cleanSku, homeStoreCode: home, sales: linhasPedidos };
    }

    // Pra cada venda, calcula quanto desse SKU ainda pode ser devolvido
    // (qty original - qty já devolvida em devoluções anteriores)
    const saleIds = sales.map((s: any) => s.id);
    const previousReturns = await (this.prisma as any).pdvReturn.findMany({
      where: { originalSaleId: { in: saleIds } },
      include: { items: true },
    });
    const devolvidoPorItem = new Map<string, number>();
    for (const ret of previousReturns as any[]) {
      for (const it of ret.items) {
        const id = it.originalItemId || it.sku;
        devolvidoPorItem.set(id, (devolvidoPorItem.get(id) || 0) + (it.qty || 0));
      }
    }

    const result = sales.map((s: any) => {
      // Pode ter mais de 1 item matching (ex: vendeu 2 cores diferentes da mesma ref)
      const matchedItems = s.items.map((it: any) => {
        const jaDev = devolvidoPorItem.get(it.id) || 0;
        const disponivel = Math.max(0, (it.qty || 0) - jaDev);
        return {
          id: it.id,
          sku: it.sku,
          ref: it.ref,
          cor: it.cor,
          tamanho: it.tamanho,
          descricao: it.descricao,
          qty: it.qty,
          precoUnit: it.precoUnit,
          total: it.total,
          jaDevolvido: jaDev,
          disponivel,
        };
      });
      return {
        saleId: s.id,
        nfceNumber: s.nfceNumber,
        storeCode: s.storeCode,
        storeName: s.storeName,
        // sameStore: venda foi na loja ATUAL (destaque) vs outra loja da rede (abaixo)
        sameStore: !!home && s.storeCode === home,
        customerName: s.customerName,
        customerCpf: s.customerCpf,
        finalizedAt: s.finalizedAt || s.createdAt, // fallback p/ vendas open
        totalVenda: s.total,
        sellerName: s.sellerName,
        status: s.status, // 'finalized' | 'open' | 'cancelled' — frontend mostra alerta se ≠ finalized
        matchedItems,
        // Se TODOS os items matching já foram devolvidos, marca como indisponível
        totalmenteDevolvido: matchedItems.every((it: any) => it.disponivel === 0),
      };
    });

    // Vendas do PDV primeiro (loja local em destaque), pedidos online depois.
    return { sku: cleanSku, homeStoreCode: home, sales: [...result, ...linhasPedidos] };
  }

  // ── PEDIDO ONLINE NO BALCÃO (28/08 — "troca site igual troca loja") ──
  //
  // A cliente do site chegava na loja com a peça e o bipe não achava NADA:
  // venda online mora em Order/OrderItem, e o lookup só olhava PdvSale (e o
  // fallback manual, o histórico da caixa). A loja mandava a cliente pro portal de trocas —
  // dias de reversa pra quem estava com a peça NA MÃO, no balcão.
  //
  // Agora o pedido online entra no MESMO fluxo do botão verde: o bipe acha,
  // a devolução registra (PdvReturn.originalOrderId + source='pedido_online'),
  // a peça entra no estoque da loja que atendeu e o vale-troca sai na hora.

  /** Aceita devolução: pago (site novo/live/online) ou, no site velho (WC), já despachado. */
  private pedidoAceitaDevolucao(o: any): boolean {
    if (!o) return false;
    if (['cancelled', 'canceled', 'refunded'].includes(String(o.status || ''))) return false;
    if (o.paidAt) return true;
    return o.source === 'site' && ['separating', 'shipped', 'delivered'].includes(String(o.status || ''));
  }

  /**
   * Quanto do preço de etiqueta a cliente PAGOU de fato (desconto de pedido
   * rateado). O site novo guarda cupom/PIX no checkoutInfo — sem ratear, o
   * vale sairia maior do que entrou. Sem checkoutInfo (live/online/WC), o
   * unitPrice já é o pago → fator 1.
   */
  private fatorPagoDoPedido(order: any): number {
    try {
      const ck = JSON.parse(String(order?.checkoutInfo || '{}'));
      const subtotal = Number(ck?.subtotal);
      const desconto = Number(ck?.discount) || 0;
      if (!Number.isFinite(subtotal) || subtotal <= 0 || desconto <= 0) return 1;
      return Math.min(1, Math.max(0, (subtotal - desconto) / subtotal));
    } catch {
      return 1;
    }
  }

  /** OrderItems no shape que o fluxo de devolução já entende (id/sku/qty/total…). */
  private itensDevolviveisDoPedido(order: any): any[] {
    const fator = this.fatorPagoDoPedido(order);
    return ((order?.items || []) as any[])
      .filter((it) => !it.cancelledAt)
      .map((it) => {
        const qty = Number(it.quantity) || 1;
        const precoUnit = Math.round((Number(it.unitPrice) || 0) * fator * 100) / 100;
        return {
          id: it.id,
          sku: String(it.sku || ''),
          ref: it.ref ?? null,
          cor: it.cor ?? null,
          tamanho: it.tamanho ?? null,
          descricao: it.productName || it.sku || 'Peça',
          qty,
          precoUnit,
          desconto: null,
          total: Math.round(precoUnit * qty * 100) / 100,
        };
      });
  }

  /**
   * Localiza um PEDIDO devolvível por id OU nº (`LP-000123`/`ON-000045`) e o
   * devolve NORMALIZADO no shape de venda que o resto do fluxo usa.
   * `null` = não é pedido (deixa o chamador seguir o caminho normal).
   */
  private async carregarPedidoDevolvivel(query: string): Promise<any | null> {
    const q = String(query || '').replace(/#/g, '').trim();
    if (!q) return null;
    const order = await (this.prisma as any).order
      .findFirst({
        where: {
          OR: [{ id: q }, { wcOrderNumber: { equals: q, mode: 'insensitive' } }],
        },
        include: { items: true },
      })
      .catch(() => null);
    if (!order) return null;
    if (!this.pedidoAceitaDevolucao(order)) {
      throw new BadRequestException(
        `Pedido ${order.wcOrderNumber || q} está "${order.status}"${order.paidAt ? '' : ' e sem pagamento confirmado'} — não dá pra devolver.`,
      );
    }
    const numero = order.wcOrderNumber || String(order.wcOrderId || order.id.slice(0, 8));
    return {
      origem: 'pedido_online' as const,
      id: order.id,
      // Mesmos nomes de campo da PdvSale — o resto do fluxo não sabe a origem.
      nfceNumber: numero,
      pedidoNumero: numero,
      storeCode: null,
      storeName: `Pedido online ${numero}`,
      customerCpf: order.customerCpf || null,
      customerName: order.customerName || null,
      total: Number(order.totalAmount) || 0,
      finalizedAt: order.paidAt || order.wcDateCreated || order.createdAt,
      isTraining: false,
      items: this.itensDevolviveisDoPedido(order),
    };
  }

  /**
   * Venda original de uma devolução — PdvSale OU pedido online, no mesmo
   * shape. Lança os MESMOS erros do caminho antigo quando não dá.
   */
  private async carregarVendaDevolvivel(id: string): Promise<any> {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id },
      include: { items: true },
    });
    if (sale) {
      if (sale.status !== 'finalized') {
        throw new BadRequestException(`Venda está ${sale.status}, não dá pra devolver`);
      }
      /**
       * MARCAÇÃO NÃO É VENDA (31/08).
       *
       * "Marcado" é a peça que a cliente leva pra PROVAR em casa: não comprou,
       * não pagou, não assinou nada. Só que a marcação é gravada como PdvSale
       * `finalized` com `paymentMethod='MARCADO'` e ZERO pagamento — e a única
       * pergunta feita aqui era o status. Resultado: a marcação aparecia na
       * tela de devolução do PDV como venda devolvível, e devolver por ali
       * emitia VALE DE TROCA pelo valor cheio da peça. A cliente saía com
       * crédito de um dinheiro que nunca entrou.
       *
       * Medido em 31/08: 3 vales, R$ 173,70 — valor do vale IGUAL ao da
       * marcação nos três, um deles já gasto. E 204 marcações em 60 dias
       * (R$ 89.879,12) estavam expostas ao mesmo caminho.
       *
       * Regra do dono: "ao devolver simplesmente devolve e pronto — não gera
       * crédito nem vale troca nem nada". O caminho certo é a tela de Marcados
       * → "Devolver ao estoque" (`MarcadosService.devolverItemMarcado`), que
       * estorna o estoque e fecha a marcação, sem criar nada financeiro.
       */
      if (String((sale as any).paymentMethod || '').trim().toUpperCase() === 'MARCADO') {
        throw new BadRequestException(
          'Isso é uma MARCAÇÃO (peça que a cliente levou pra provar), não uma venda paga — ' +
            'devolver por aqui geraria vale de troca de um valor que nunca foi pago. ' +
            'Use a tela Marcados → "Devolver ao estoque": a peça volta pro estoque e não gera crédito nenhum.',
        );
      }
      return { ...sale, origem: 'pdv' as const };
    }
    const pedido = await this.carregarPedidoDevolvivel(id);
    if (!pedido) throw new NotFoundException('Venda original não encontrada');
    return pedido;
  }

  /** Filtro das devoluções anteriores da MESMA origem (venda ou pedido). */
  private whereDevolucoesDe(venda: any): any {
    return venda.origem === 'pedido_online'
      ? { originalOrderId: venda.id }
      : { originalSaleId: venda.id };
  }

  // ── Criar devolução ─────────────────────────────────────────────────

  /**
   * Gera código único TROCA-XXXXX (8 chars hex).
   */
  private genCreditoCode(): string {
    const hex = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return `TROCA-${hex.padEnd(8, '0')}`;
  }

  /**
   * Cria a devolução completa.
   *
   * Steps:
   *  1. Valida quantidade disponível por item
   *  2. Calcula valor total (proporcional ao item original)
   *  3. Estorna estoque no Flow (increaseStock) — se falhar, salva error e continua
   *  4. Cria PdvReturn + PdvReturnItem
   *  5. Se modo=dinheiro → cria sangria automática no caixa atual
   *  6. Se modo=credito ou troca → gera código TROCA-XXXXX
   */
  async createReturn(input: {
    originalSaleId: string;
    storeCode: string;
    storeName: string;
    modo: 'dinheiro' | 'pix' | 'troca' | 'credito';
    items: Array<{ originalItemId: string; qty: number }>;
    motivo?: string;
    creditoValidadeDias?: number;
    attachToSaleId?: string | null;
    userId?: string;
    userName?: string;
    /** MODO TREINAMENTO — sessão com header x-training-mode (união com sale.isTraining) */
    trainingRequest?: boolean;
    /** CONFIRMAÇÃO cross-store — usuário foi avisado que peça é de outra loja
     *  e confirma que a peça VAI ENTRAR no estoque da loja atual mesmo assim. */
    confirmCrossStore?: boolean;
  }) {
    const { originalSaleId, storeCode, storeName, modo, items, motivo, userId, userName } = input;
    const attachToSaleId = input.attachToSaleId || null;

    if (!['dinheiro', 'troca', 'credito'].includes(modo)) {
      throw new BadRequestException(`Modo inválido: ${modo}`);
    }
    if (!items?.length) throw new BadRequestException('Selecione ao menos uma peça');

    // Carrega venda original com itens — PdvSale OU pedido online (28/08),
    // no mesmo shape. Erros iguais aos de antes quando não dá.
    const sale = await this.carregarVendaDevolvivel(originalSaleId);
    const ehPedidoOnline = sale.origem === 'pedido_online';

    // ── ALERTA CROSS-STORE ─────────────────────────────────────────────
    // Se a venda original foi em loja DIFERENTE da loja atual da devolução,
    // pede confirmação explícita antes de seguir. A peça VAI ENTRAR no
    // estoque da loja atual (não da loja que vendeu). Pedido online SEMPRE
    // confirma — a peça saiu do estoque de quem separou, e vai entrar aqui.
    const isCrossStore = ehPedidoOnline || (sale.storeCode && storeCode && sale.storeCode !== storeCode);
    if (isCrossStore && !input.confirmCrossStore) {
      throw new BadRequestException({
        crossStoreAlert: true,
        message: ehPedidoOnline
          ? `Esta peça é do ${sale.storeName} (compra online). ` +
            `Se confirmar, ela entrará no estoque da loja ${storeName || storeCode} e a devolução fica registrada no pedido.`
          : `Esta peça foi vendida na loja ${sale.storeName || sale.storeCode}, ` +
            `mas a devolução está sendo feita na loja ${storeName || storeCode}. ` +
            `Se confirmar, a peça entrará no estoque da loja ${storeName || storeCode}.`,
        originalStoreCode: sale.storeCode,
        originalStoreName: sale.storeName,
        currentStoreCode: storeCode,
        currentStoreName: storeName,
      });
    }

    // Mapeia disponibilidade já considerando devoluções anteriores
    const previousReturns = await (this.prisma as any).pdvReturn.findMany({
      where: this.whereDevolucoesDe(sale),
      include: { items: true },
    });
    const devolvidoPorItem = new Map<string, number>();
    for (const ret of previousReturns as any[]) {
      for (const it of ret.items) {
        const id = it.originalItemId || it.sku;
        devolvidoPorItem.set(id, (devolvidoPorItem.get(id) || 0) + (it.qty || 0));
      }
    }

    // Valida cada item solicitado e calcula valor
    const itemsToCreate: any[] = [];
    let valorTotal = 0;
    for (const reqItem of items) {
      const original = (sale.items as any[]).find((i: any) => i.id === reqItem.originalItemId);
      if (!original) {
        throw new BadRequestException(`Item ${reqItem.originalItemId} não pertence à venda`);
      }
      const jaDev = devolvidoPorItem.get(original.id) || 0;
      const disponivel = (original.qty || 0) - jaDev;
      const qty = Math.max(1, Math.floor(Number(reqItem.qty) || 0));
      if (qty > disponivel) {
        throw new BadRequestException(
          `${original.descricao}: pediu ${qty} mas só tem ${disponivel} disponível pra devolução`,
        );
      }
      // Valor proporcional do item (preço unit já considera desconto rateado)
      const valorUnit = original.qty > 0 ? original.total / original.qty : original.precoUnit;
      const totalItem = valorUnit * qty;
      valorTotal += totalItem;
      itemsToCreate.push({
        originalItemId: original.id,
        sku: original.sku,
        ref: original.ref,
        cor: original.cor,
        tamanho: original.tamanho,
        descricao: original.descricao,
        qty,
        precoUnit: valorUnit,
        total: totalItem,
      });
    }

    valorTotal = Math.round(valorTotal * 100) / 100;

    // ── HERDA MODO TREINAMENTO da venda original OU da sessão (header) ──
    // Devolução de venda de treino é também treino: NÃO estorna estoque,
    // NÃO gera sangria/caixa, NÃO conta em relatórios. União com o header
    // pra sessão em treino não estornar estoque REAL de venda real.
    const isTraining = !!(sale as any).isTraining || !!input.trainingRequest;

    // Sessão de caixa atual (necessária pra dinheiro → sangria)
    const cashSession = await this.cash.getCurrentSession(storeCode);
    if ((modo === 'dinheiro' || modo === 'pix') && !cashSession && !isTraining) {
      throw new BadRequestException(
        'Modo dinheiro/PIX exige caixa aberto pra registrar a sangria.',
      );
    }

    // Tenta devolver a peça ao estoque (não bloqueia se falhar — registra erro)
    // PULA se for treinamento — não mexer em estoque real.
    const stockAttempts: Array<{ sku: string; ok: boolean; error?: string }> = [];
    if (isTraining) {
      for (const it of itemsToCreate) stockAttempts.push({ sku: it.sku, ok: true });
      this.logger.log(`[returns→TREINO] devolução simulada — skip increaseStock`);
    } else
    try {
      const erpResult = await this.erp.increaseStockAsync(
        itemsToCreate.map((it) => ({
          sku: it.sku,
          qty: it.qty,
          storeCode,
        })),
      );
      if (erpResult.success) {
        for (const it of itemsToCreate) {
          stockAttempts.push({ sku: it.sku, ok: true });
        }
      } else {
        for (const it of itemsToCreate) {
          stockAttempts.push({ sku: it.sku, ok: false, error: erpResult.error || 'falha na baixa' });
        }
      }
    } catch (e: any) {
      for (const it of itemsToCreate) {
        stockAttempts.push({ sku: it.sku, ok: false, error: e?.message || String(e) });
      }
    }

    // Crédito (se modo=troca ou credito)
    let creditoCode: string | null = null;
    let creditoValidade: Date | null = null;
    if (modo === 'troca' || modo === 'credito') {
      creditoCode = this.genCreditoCode();
      const dias = modo === 'troca' ? 1 : Math.max(1, input.creditoValidadeDias || 90);
      creditoValidade = new Date(Date.now() + dias * 86400_000);
    }

    // Persiste tudo
    const ret = await (this.prisma as any).pdvReturn.create({
      data: {
        originalSaleId: ehPedidoOnline ? null : originalSaleId,
        originalOrderId: ehPedidoOnline ? sale.id : null,
        source: ehPedidoOnline ? 'pedido_online' : 'flowops',
        originalSaleNumber: sale.nfceNumber || (ehPedidoOnline ? sale.pedidoNumero : null) || null,
        storeCode,
        storeName,
        cashSessionId: cashSession?.id || null,
        modo,
        valorTotal,
        status: 'completed',
        customerCpf: sale.customerCpf || null,
        customerName: sale.customerName || null,
        creditoCode,
        creditoValidade,
        userId: userId || null,
        userName: userName || null,
        motivo: motivo || null,
        isTraining,
        items: {
          create: itemsToCreate.map((it, idx) => ({
            originalItemId: it.originalItemId,
            sku: it.sku,
            ref: it.ref,
            cor: it.cor,
            tamanho: it.tamanho,
            descricao: it.descricao,
            qty: it.qty,
            precoUnit: it.precoUnit,
            total: it.total,
            stockReturnedAt: stockAttempts[idx]?.ok ? new Date() : null,
            stockError: stockAttempts[idx]?.ok ? null : stockAttempts[idx]?.error || null,
          })),
        },
      },
      include: { items: true },
    });

    // ── CASHBACK: a peça voltou, o cashback dela some ──
    // Decisão do dono (01/08). Se já foi gasto, o saldo fica NEGATIVO — é o que
    // fecha a brecha de comprar caro, pegar 10%, gastar e devolver.
    // Devolução parcial cancela proporcionalmente ao que voltou.
    // Best-effort: cashback nunca derruba uma devolução com a cliente no balcão.
    if (!isTraining && !ehPedidoOnline) {
      try {
        await this.cashback.estornarDevolucao({
          saleId: originalSaleId,
          returnId: ret.id,
          valorDevolvido: valorTotal,
          storeCode,
        });
      } catch (e: any) {
        this.logger.error(`[devolução] estorno de cashback falhou: ${e?.message || e}`);
      }
    } else if (ehPedidoOnline) {
      // Cashback de compra online não estorna por aqui (o vínculo é da venda
      // do PDV) — se um dia o site der cashback, o estorno entra na mesma
      // régua. Registrado no log pra auditoria.
      this.logger.log(`[devolução] pedido online ${sale.pedidoNumero}: sem estorno de cashback (fluxo do PDV)`);
      // Rastro na FICHA DO PEDIDO: a matriz que abrir o pedido vê que a peça
      // voltou no balcão (loja, modo, valor). Best-effort.
      try {
        await (this.prisma as any).orderHistory.create({
          data: {
            orderId: sale.id,
            note:
              `Devolução no balcão da loja ${storeName || storeCode}: ` +
              `${itemsToCreate.reduce((s, it) => s + it.qty, 0)} peça(s), ` +
              `R$ ${valorTotal.toFixed(2)} em ${modo}` +
              (creditoCode ? ` (vale ${creditoCode})` : '') +
              (userName ? ` — por ${userName}` : ''),
          },
        });
      } catch (e: any) {
        this.logger.warn(`[devolução] histórico do pedido não gravado: ${e?.message || e}`);
      }
    }

    // Sangria automatica se for em dinheiro OU pix (saiu valor do caixa).
    // PULA se treinamento (não mexe no caixa real).
    if ((modo === 'dinheiro' || modo === 'pix') && cashSession && !isTraining) {
      const tipoLabel = modo === 'pix' ? 'PIX devolucao' : 'Devolucao dinheiro';
      const origemLabel = ehPedidoOnline ? `pedido ${sale.pedidoNumero}` : `venda ${sale.nfceNumber || sale.id.slice(0, 8)}`;
      await this.cash.addMovement({
        storeCode,
        tipo: 'sangria',
        valor: valorTotal,
        motivo: `${tipoLabel} — ${origemLabel}${motivo ? ' · ' + motivo : ''}`,
        userId,
        userName,
      });
    }

    this.logger.log(
      `[devolução] ${ret.id} loja=${storeCode} ${ehPedidoOnline ? `pedido=${sale.pedidoNumero}` : `venda=${originalSaleId.slice(0, 8)}`} ` +
        `modo=${modo} R$${valorTotal.toFixed(2)} ` +
        (creditoCode ? `código=${creditoCode}` : ''),
    );

    // FLUXO MESMO-DIA (modo='troca'): dois caminhos:
    //
    //  A) attachToSaleId presente: vendedora veio do PDV com uma venda em
    //     andamento (ex.: cliente trazendo peça pra trocar no meio de uma
    //     compra). ANEXA o vale_troca naquela venda existente — sem reiniciar
    //     o carrinho. Itens já bipados permanecem intactos.
    //
    //  B) attachToSaleId ausente: vendedora começou direto pela tela de
    //     devolução (não tinha venda aberta). CRIA uma nova PdvSale com
    //     customer pré-preenchido e o vale_troca aplicado, e oferece o botão
    //     "CONTINUAR NO PDV" pra retomá-la.
    //
    // Cliente NUNCA precisa receber código nem cupom impresso pro modo troca.
    const itemsDevolvidosPayload = itemsToCreate.map((it) => ({
      sku: it.sku,
      ref: it.ref,
      cor: it.cor,
      tamanho: it.tamanho,
      descricao: it.descricao,
      qty: it.qty,
      valor: it.total,
    }));

    let directSaleId: string | null = null;
    let attachedToExistingSale = false;

    if (modo === 'troca' && creditoCode) {
      // Caminho A: anexa numa venda existente
      //
      // REGRA: se o frontend mandou attachToSaleId, é porque tem venda em
      // andamento no PDV. NUNCA criar venda nova nesse caso — se anexar
      // falhar, retorna erro claro. Senão sumiriam os itens do carrinho.
      if (attachToSaleId) {
        const target = await (this.prisma as any).pdvSale.findUnique({
          where: { id: attachToSaleId },
          select: { id: true, storeCode: true, status: true },
        });
        if (!target) {
          throw new BadRequestException(
            `Venda em andamento (${attachToSaleId.slice(0, 8)}) não foi encontrada. ` +
            `Atualize a página do PDV e tente novamente.`,
          );
        }
        if (target.status !== 'open') {
          throw new BadRequestException(
            `A venda em andamento está ${target.status}, não dá mais pra anexar troca. ` +
            `Comece uma nova venda no PDV.`,
          );
        }
        if (target.storeCode !== storeCode) {
          throw new BadRequestException(
            `A venda em andamento é da loja ${target.storeCode} mas a devolução é em ${storeCode}.`,
          );
        }
        await (this.prisma as any).pdvSalePayment.create({
          data: {
            saleId: target.id,
            method: 'vale_troca',
            valor: valorTotal,
            details: JSON.stringify({
              creditoCode,
              fromReturnId: ret.id,
              modo: 'troca-anexada',
              itemsDevolvidos: itemsDevolvidosPayload,
            }),
          },
        });
        attachedToExistingSale = true;
        this.logger.log(
          `[devolução/troca-anexa] Vale ${creditoCode} R$${valorTotal.toFixed(2)} ` +
          `anexado à venda ${target.id.slice(0, 8)} em andamento`,
        );
      }

      // Caminho B: cria nova venda (só se NÃO veio attachToSaleId — vendedora
      // começou direto pela tela de devolução, sem venda aberta no PDV)
      if (!attachToSaleId && !attachedToExistingSale) {
        try {
          const store = await this.prisma.store.findUnique({
            where: { code: storeCode },
            select: { code: true, name: true },
          });
          if (store) {
            let cashSessionId: string | null = null;
            try {
              const s = await (this.prisma as any).pdvCashSession.findFirst({
                where: { storeCode: store.code, status: 'open' },
                select: { id: true },
              });
              cashSessionId = s?.id || null;
            } catch { /* segue sem caixa */ }

            const newSale = await (this.prisma as any).pdvSale.create({
              data: {
                storeCode: store.code,
                storeName: store.name,
                cashSessionId,
                vendedorUserId: userId || null,
                vendedorName: userName || null,
                customerCpf: sale.customerCpf || null,
                customerName: sale.customerName || null,
                status: 'open',
              },
            });

            await (this.prisma as any).pdvSalePayment.create({
              data: {
                saleId: newSale.id,
                method: 'vale_troca',
                valor: valorTotal,
                details: JSON.stringify({
                  creditoCode,
                  fromReturnId: ret.id,
                  modo: 'troca-mesmo-dia',
                  itemsDevolvidos: itemsDevolvidosPayload,
                }),
              },
            });

            directSaleId = newSale.id;
            this.logger.log(
              `[devolução/troca-direta] Nova venda ${newSale.id.slice(0, 8)} criada com vale ${creditoCode} R$${valorTotal.toFixed(2)} aplicado`,
            );
          }
        } catch (e: any) {
          this.logger.warn(
            `[devolução/troca-direta] Falha ao criar venda direta: ${e?.message || e}. ` +
            `Vale-troca ${creditoCode} foi gerado normal — vendedora pode aplicar manual no PDV.`,
          );
        }
      }
    }

    return { ...ret, directSaleId, attachedToExistingSale };
  }

  // ── Listagem ────────────────────────────────────────────────────────

  /**
   * Lista devoluções (filtros opcionais por loja/cliente/data).
   */
  async list(input: {
    storeCode?: string;
    customerCpf?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }) {
    const where: any = {};
    if (input.storeCode) where.storeCode = input.storeCode;
    if (input.customerCpf) where.customerCpf = input.customerCpf;
    if (input.from || input.to) {
      where.createdAt = {};
      if (input.from) where.createdAt.gte = input.from;
      if (input.to) where.createdAt.lte = input.to;
    }
    return (this.prisma as any).pdvReturn.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, input.limit || 50)),
    });
  }

  // ── Vale-troca ──────────────────────────────────────────────────────

  /**
   * Valida e marca um vale-troca como usado em uma venda.
   * Chamado pelo PDV quando vendedora bipa o código TROCA-XXXXX.
   */
  async useCredit(input: { creditoCode: string; usedInSaleId: string }) {
    const ret = await (this.prisma as any).pdvReturn.findUnique({
      where: { creditoCode: input.creditoCode },
    });
    if (!ret) throw new NotFoundException('Vale-troca não encontrado');
    // Vale presente comprado mas com a venda de compra ainda não finalizada
    // (ou cancelada) — o código impresso só vale depois do dinheiro entrar.
    if (ret.source === 'vale_presente' && ret.status === 'pending') {
      throw new BadRequestException(
        'Vale presente ainda não ativado — a venda em que ele foi comprado não foi finalizada.',
      );
    }
    if (ret.status === 'used') {
      throw new BadRequestException(
        `Vale-troca já foi usado em ${ret.creditoUsadoAt ? new Date(ret.creditoUsadoAt).toLocaleString('pt-BR') : 'data desconhecida'}`,
      );
    }
    if (ret.creditoValidade && new Date(ret.creditoValidade).getTime() < Date.now()) {
      throw new BadRequestException(
        `Vale-troca venceu em ${new Date(ret.creditoValidade).toLocaleDateString('pt-BR')}`,
      );
    }

    return (this.prisma as any).pdvReturn.update({
      where: { id: ret.id },
      data: {
        status: 'used',
        creditoUsadoEm: input.usedInSaleId,
        creditoUsadoAt: new Date(),
      },
    });
  }

  /**
   * Lista vales-troca emitidos com filtros — pra auditoria/conferencia.
   * Status calculado: 'ativo' (nao usado, dentro da validade) | 'usado' | 'vencido'.
   */
  async listCreditos(filters: {
    from?: string;
    to?: string;
    storeCode?: string;
    status?: 'ativo' | 'usado' | 'vencido' | 'todos';
    code?: string;
    customerQ?: string;
    page?: number;
    size?: number;
  } = {}) {
    const where: any = {
      // Pega tudo que TEM creditoCode (modo=credito ou troca anexada com vale)
      creditoCode: { not: null },
    };
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = new Date(filters.from + 'T00:00:00');
      if (filters.to) where.createdAt.lte = new Date(filters.to + 'T23:59:59');
    }
    if (filters.storeCode) where.storeCode = filters.storeCode;
    if (filters.code) where.creditoCode = { contains: filters.code.toUpperCase().trim() };
    if (filters.customerQ) {
      const q = filters.customerQ.trim();
      where.OR = [
        { customerName: { contains: q } },
        { customerCpf: { contains: q.replace(/\D/g, '') } },
      ];
    }
    if (filters.status === 'ativo') {
      where.status = { not: 'used' };
      where.creditoValidade = { gte: new Date() };
    } else if (filters.status === 'usado') {
      where.status = 'used';
    } else if (filters.status === 'vencido') {
      where.status = { not: 'used' };
      where.creditoValidade = { lt: new Date() };
    }

    const page = Math.max(1, Number(filters.page || 1));
    const size = Math.min(200, Math.max(10, Number(filters.size || 50)));

    const [total, items] = await Promise.all([
      (this.prisma as any).pdvReturn.count({ where }),
      (this.prisma as any).pdvReturn.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * size,
        take: size,
        select: {
          id: true,
          creditoCode: true,
          modo: true,
          valorTotal: true,
          status: true,
          creditoValidade: true,
          creditoUsadoEm: true,
          creditoUsadoAt: true,
          storeCode: true,
          storeName: true,
          customerName: true,
          customerCpf: true,
          userName: true,
          motivo: true,
          createdAt: true,
          originalSaleNumber: true,
          originalSaleId: true,
        },
      }),
    ]);

    const now = Date.now();
    const totalAtivos = items.reduce((s: number, it: any) => {
      if (it.status === 'used') return s;
      const venc = it.creditoValidade ? new Date(it.creditoValidade).getTime() : Infinity;
      if (venc < now) return s;
      return s + Number(it.valorTotal || 0);
    }, 0);

    return {
      total,
      page,
      size,
      totalAtivos: Number(totalAtivos.toFixed(2)),
      items: items.map((it: any) => {
        const vencido = it.creditoValidade ? new Date(it.creditoValidade).getTime() < now : false;
        const status = it.status === 'used' ? 'usado' : vencido ? 'vencido' : 'ativo';
        return { ...it, statusCalculado: status };
      }),
    };
  }

  /**
   * Consulta saldo/validade de um vale-troca SEM marcar como usado.
   */
  async checkCredit(creditoCode: string) {
    const ret = await (this.prisma as any).pdvReturn.findUnique({
      where: { creditoCode },
      include: { items: true },
    });
    if (!ret) {
      // VALE DO SITE: o "TROCAR AGORA NA LOJA" (wc-returns) e o portal de
      // trocas gravam o vale em `site_cupons` (origem 'troca'), não em
      // `pdv_returns`. O addPayment já resolve os dois; a VALIDAÇÃO do modal
      // parava aqui com 404 e a vendedora nunca chegava no Aplicar (02/09,
      // relato das lojas). Mesma resposta, outra fonte.
      const valeSite = await this.checkCreditValeDoSite(creditoCode);
      if (valeSite) return valeSite;
      throw new NotFoundException('Vale-troca não encontrado');
    }
    if (ret.source === 'vale_presente' && ret.status === 'pending') {
      throw new BadRequestException(
        'Vale presente ainda não ativado — a venda em que ele foi comprado não foi finalizada.',
      );
    }

    // ── HISTORICO ──
    // Peças que foram DEVOLVIDAS pra gerar esse vale (PdvReturnItem)
    const pecasDevolvidas = (ret.items || []).map((it: any) => ({
      ref: it.ref,
      cor: it.cor,
      tamanho: it.tamanho,
      descricao: it.descricao,
      qty: it.qty,
      precoUnit: it.precoUnit,
      total: it.total,
    }));

    // Peças que ja foram LEVADAS — venda associada (originalSaleId pra residual
    // ou venda em que o vale foi usado pra modo='credito')
    let pecasLevadas: any[] = [];
    let saleAssociadaId: string | null = null;
    let saleAssociadaTotal = 0;
    let saleAssociadaData: string | null = null;
    // Caso 1: vale ja foi usado (status='used') — pega items da venda em que foi consumido
    if (ret.creditoUsadoEm) {
      saleAssociadaId = ret.creditoUsadoEm;
      const saleConsumida = await (this.prisma as any).pdvSale.findUnique({
        where: { id: ret.creditoUsadoEm },
        select: {
          id: true, total: true, finalizedAt: true, createdAt: true,
          items: { select: { ref: true, cor: true, tamanho: true, descricao: true, qty: true, precoUnit: true, total: true } },
        },
      });
      if (saleConsumida) {
        pecasLevadas = saleConsumida.items || [];
        saleAssociadaTotal = Number(saleConsumida.total || 0);
        saleAssociadaData = (saleConsumida.finalizedAt || saleConsumida.createdAt)?.toISOString() || null;
      }
    }
    // Caso 2: residual — originalSaleId aponta pra venda anexada onde sobrou crédito
    else if (ret.originalSaleId) {
      const saleOriginal = await (this.prisma as any).pdvSale.findUnique({
        where: { id: ret.originalSaleId },
        select: {
          id: true, total: true, finalizedAt: true, createdAt: true,
          items: { select: { ref: true, cor: true, tamanho: true, descricao: true, qty: true, precoUnit: true, total: true } },
        },
      });
      if (saleOriginal && (saleOriginal.items || []).length > 0) {
        saleAssociadaId = saleOriginal.id;
        pecasLevadas = saleOriginal.items || [];
        saleAssociadaTotal = Number(saleOriginal.total || 0);
        saleAssociadaData = (saleOriginal.finalizedAt || saleOriginal.createdAt)?.toISOString() || null;
      }
    }

    return {
      code: ret.creditoCode,
      valor: ret.valorTotal,
      status: ret.status,
      modo: ret.modo,
      source: ret.source, // 'flowops' | 'giga_manual' | 'vale_presente'
      motivo: ret.motivo, // vale presente: "comprado por X para Y · válido até Z"
      validade: ret.creditoValidade,
      vencido: ret.creditoValidade ? new Date(ret.creditoValidade).getTime() < Date.now() : false,
      usado: ret.status === 'used',
      usadoEm: ret.creditoUsadoAt,
      origem: { saleId: ret.originalSaleId, store: ret.storeCode, storeName: ret.storeName },
      customerName: ret.customerName,
      customerCpf: ret.customerCpf,
      createdAt: ret.createdAt,
      // Historico completo pra tela de demonstracao
      historico: {
        pecasDevolvidas,
        valorDevolvido: ret.valorTotal,
        pecasLevadas,
        valorLevado: saleAssociadaTotal,
        saleAssociadaId,
        saleAssociadaData,
      },
    };
  }

  /**
   * Vale de troca do SITE (`site_cupons`, origem 'troca') no formato do
   * `checkCredit` — o modal do PDV valida os dois sem saber a diferença.
   *
   * Só CONSULTA: quem aplica é o `addPayment` (via `resolverValeDoSite`, que
   * faz a checagem nominal de CPF contra a venda — aqui não há venda ainda).
   * `nominal: true` avisa o modal que a venda precisa estar no CPF da cliente.
   * Devolve null quando o código não é vale do site (cupom de campanha NÃO
   * passa — cupom público não é dinheiro de cliente).
   */
  private async checkCreditValeDoSite(code: string) {
    let cupom: any = null;
    try {
      cupom = await (this.prisma as any).siteCupom.findUnique({ where: { code } });
    } catch (e: any) {
      this.logger.warn(`[returns] site_cupons indisponível ao validar ${code}: ${e?.message || e}`);
      return null;
    }
    if (!cupom || cupom.origem !== 'troca') return null;

    // Mesmo critério do resolverValeDoSite: `usos >= usoMaximo` é o "já gastou".
    const usos = Number(cupom.usos) || 0;
    const maximo = cupom.usoMaximo == null ? null : Number(cupom.usoMaximo);
    const usado = maximo != null && usos >= maximo;
    const cpf = String(cupom.cpf || '').replace(/\D/g, '');
    const valor = Number(cupom.valor) || 0;

    return {
      code: cupom.code,
      valor,
      status: !cupom.ativo ? 'cancelled' : usado ? 'used' : 'completed',
      modo: 'credito',
      source: 'site_troca',
      motivo: cupom.label || 'Vale-troca do site',
      validade: cupom.fimEm,
      vencido: cupom.fimEm ? new Date(cupom.fimEm).getTime() < Date.now() : false,
      usado,
      usadoEm: cupom.usadoAt || null,
      origem: { saleId: null, store: 'SITE', storeName: 'Troca do site' },
      customerName: null,
      customerCpf: cpf || null,
      nominal: !!cpf,
      createdAt: cupom.createdAt || null,
      historico: {
        pecasDevolvidas: [],
        valorDevolvido: valor,
        pecasLevadas: [],
        valorLevado: 0,
        saleAssociadaId: null,
        saleAssociadaData: null,
      },
    };
  }

  /**
   * AJUSTA vale_troca payment da venda + CRIA vale residual no mesmo passo.
   * Usado no PDV quando vale_troca aplicado > total da venda e cliente nao
   * quer levar mais peca. Reduz o payment pra cobrir SO o total, e cria um
   * novo PdvReturn modo='credito' com o saldo + codigo TROCA-XXX (90 dias).
   *
   * Esse fluxo mantem a conciliacao em ordem (payment <= total da venda).
   */
  async dividirValeResidual(input: {
    saleId: string;
    customerCpf?: string;
    customerName?: string;
    validadeDias?: number;
    userId?: string;
    userName?: string;
  }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      include: { payments: true },
    });
    if (!sale) throw new NotFoundException('Venda nao encontrada');
    if (sale.status !== 'open') {
      throw new BadRequestException('So pode dividir vale em venda aberta');
    }

    const valePayment = (sale.payments as any[]).find((p) => String(p.method).toLowerCase() === 'vale_troca');
    if (!valePayment) throw new BadRequestException('Venda nao tem vale_troca aplicado');

    const valePayValor = Number(valePayment.valor || 0);
    const outrosPagamentos = (sale.payments as any[])
      .filter((p) => p.id !== valePayment.id)
      .reduce((s, p) => s + (Number(p.valor) || 0), 0);
    const totalVenda = Number(sale.total || 0);
    const valePrecisoCobrir = Math.max(0, totalVenda - outrosPagamentos);
    const valorResidual = Number((valePayValor - valePrecisoCobrir).toFixed(2));

    if (valorResidual <= 0.01) {
      throw new BadRequestException('Nao ha saldo residual — vale-troca cobre exatamente o total');
    }

    // Reduz o vale_troca payment pra cobrir apenas o necessario
    await (this.prisma as any).pdvSalePayment.update({
      where: { id: valePayment.id },
      data: { valor: Number(valePrecisoCobrir.toFixed(2)) },
    });

    // Cria novo PdvReturn modo='credito' com o saldo
    const code = this.genCreditoCode();
    const validadeDias = Math.max(1, input.validadeDias || 90);
    const validade = new Date(Date.now() + validadeDias * 86400_000);

    const ret = await (this.prisma as any).pdvReturn.create({
      data: {
        originalSaleId: sale.id,
        originalSaleNumber: sale.nfceNumber || null,
        storeCode: sale.storeCode,
        storeName: sale.storeName,
        cashSessionId: sale.cashSessionId || null,
        modo: 'credito',
        valorTotal: valorResidual,
        status: 'completed',
        customerCpf: input.customerCpf || sale.customerCpf || null,
        customerName: input.customerName || sale.customerName || null,
        creditoCode: code,
        creditoValidade: validade,
        userId: input.userId || null,
        userName: input.userName || null,
        motivo: 'Saldo residual — cliente nao levou mais pecas, vale guardado pra usar depois',
      },
    });

    this.logger.log(
      `[returns] vale RESIDUAL via divisao: saleId=${sale.id} valeAjustado=${valePrecisoCobrir.toFixed(2)} ` +
      `residual=R$${valorResidual.toFixed(2)} code=${code}`,
    );

    return {
      ok: true,
      returnId: ret.id,
      creditoCode: code,
      valorResidual,
      valeAjustadoPara: Number(valePrecisoCobrir.toFixed(2)),
      validade,
    };
  }

  /**
   * CRIA VALE RESIDUAL — quando a venda nova tem vale_troca aplicado MAIOR
   * que o total cobrado e o cliente nao quer levar mais peca. O saldo vira
   * um novo PdvReturn modo='credito' com codigo TROCA-XXX (90 dias).
   *
   * Input:
   *   - originalSaleId: venda do dia onde o vale_troca foi aplicado (e ficou saldo)
   *   - valorResidual: R$ X que sobrou
   *   - customerCpf/Name: opcional, herda da venda se nao informar
   */
  async createCreditoResidual(input: {
    originalSaleId: string;
    valorResidual: number;
    customerCpf?: string;
    customerName?: string;
    validadeDias?: number;
    userId?: string;
    userName?: string;
  }) {
    const { originalSaleId, valorResidual } = input;
    if (!originalSaleId) throw new BadRequestException('originalSaleId obrigatorio');
    if (!valorResidual || valorResidual <= 0) {
      throw new BadRequestException('valorResidual deve ser > 0');
    }

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: originalSaleId },
      select: {
        id: true, storeCode: true, storeName: true, cashSessionId: true,
        customerCpf: true, customerName: true, nfceNumber: true,
      },
    });
    if (!sale) throw new NotFoundException('Venda nao encontrada');

    const code = this.genCreditoCode();
    const validadeDias = Math.max(1, input.validadeDias || 90);
    const validade = new Date(Date.now() + validadeDias * 86400_000);

    const ret = await (this.prisma as any).pdvReturn.create({
      data: {
        originalSaleId: sale.id,
        originalSaleNumber: sale.nfceNumber || null,
        storeCode: sale.storeCode,
        storeName: sale.storeName,
        cashSessionId: sale.cashSessionId || null,
        modo: 'credito',
        valorTotal: Number(valorResidual.toFixed(2)),
        status: 'completed',
        customerCpf: input.customerCpf || sale.customerCpf || null,
        customerName: input.customerName || sale.customerName || null,
        creditoCode: code,
        creditoValidade: validade,
        userId: input.userId || null,
        userName: input.userName || null,
        motivo: 'Saldo residual de troca anexada — cliente nao levou outra peca',
        // NAO tem PdvReturnItem aqui — esse vale eh saldo, nao peca devolvida
      },
    });

    this.logger.log(
      `[returns] vale RESIDUAL criado: code=${code} valor=R$${valorResidual.toFixed(2)} ` +
      `saleId=${originalSaleId} cliente=${ret.customerName || '-'}`,
    );

    return {
      ok: true,
      returnId: ret.id,
      creditoCode: code,
      valor: ret.valorTotal,
      validade,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — Diagnostico + retry de estorno de estoque em devolucoes
  //
  // Pra cada PdvReturnItem, stockReturnedAt indica se a peca voltou pro
  // estoque da loja (increaseStock chamado com sucesso). stockError indica
  // erro caso tenha falhado. Estes endpoints listam o status e permitem
  // retry idempotente (so processa os com stockReturnedAt=null).
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Busca 1 devolucao por ID — usado pra imprimir comprovante de devolucao.
   */
  async getReturnById(returnId: string) {
    if (!returnId) throw new BadRequestException('returnId obrigatorio');
    const ret = await (this.prisma as any).pdvReturn.findUnique({
      where: { id: returnId },
      include: { items: true },
    });
    if (!ret) throw new NotFoundException('Devolucao nao encontrada');
    let originalSale: any = null;
    if (ret.originalSaleId) {
      originalSale = await (this.prisma as any).pdvSale.findUnique({
        where: { id: ret.originalSaleId },
        select: {
          id: true, nfceNumber: true, total: true, finalizedAt: true,
          paymentMethod: true, customerName: true, customerCpf: true,
        },
      });
    }
    return { ret, originalSale };
  }

  async getReturnsStockStatus(input: {
    sinceIso?: string;
    untilIso?: string;
    storeCode?: string;
  }): Promise<{
    sinceIso: string;
    untilIso: string;
    storeCode: string | null;
    totalReturns: number;
    totalItems: number;
    itemsOk: number;
    itemsPendentes: number;
    itemsComErro: number;
    pendentes: Array<{
      returnId: string;
      storeCode: string;
      modo: string;
      createdAt: string;
      customerName: string | null;
      itemsPendentes: Array<{ itemId: string; sku: string; descricao: string; qty: number; stockError: string | null }>;
    }>;
  }> {
    const sinceIso = input.sinceIso || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const untilIso = input.untilIso || new Date().toISOString();
    const since = new Date(sinceIso);
    const until = new Date(untilIso);
    const storeCode = input.storeCode?.trim() || null;

    const where: any = { createdAt: { gte: since, lte: until } };
    if (storeCode) where.storeCode = storeCode;

    const returns = await (this.prisma as any).pdvReturn.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { items: true },
      take: 500,
    });

    let totalItems = 0;
    let itemsOk = 0;
    let itemsPendentes = 0;
    let itemsComErro = 0;
    const pendentes: any[] = [];
    for (const r of returns as any[]) {
      const pendentesDoRet: any[] = [];
      for (const it of (r.items || []) as any[]) {
        totalItems++;
        if (it.stockReturnedAt) {
          itemsOk++;
        } else {
          itemsPendentes++;
          if (it.stockError) itemsComErro++;
          pendentesDoRet.push({
            itemId: it.id,
            sku: it.sku,
            descricao: it.descricao,
            qty: it.qty,
            stockError: it.stockError || null,
          });
        }
      }
      if (pendentesDoRet.length > 0) {
        pendentes.push({
          returnId: r.id,
          storeCode: r.storeCode,
          modo: r.modo,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
          customerName: r.customerName || null,
          itemsPendentes: pendentesDoRet,
        });
      }
    }

    return {
      sinceIso,
      untilIso,
      storeCode,
      totalReturns: (returns as any[]).length,
      totalItems,
      itemsOk,
      itemsPendentes,
      itemsComErro,
      pendentes,
    };
  }

  async retryReturnsStock(input: {
    sinceIso?: string;
    untilIso?: string;
    storeCode?: string;
    dryRun?: boolean;
    limit?: number;
  }): Promise<{
    mode: 'dry-run' | 'executed';
    sinceIso: string;
    untilIso: string;
    totalPendentes: number;
    itemsProcessados: number;
    itemsOk: number;
    itemsFalha: number;
    falhas: Array<{ returnId: string; sku: string; error: string }>;
    finished: boolean;
  }> {
    const sinceIso = input.sinceIso || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const untilIso = input.untilIso || new Date().toISOString();
    const since = new Date(sinceIso);
    const until = new Date(untilIso);
    const storeCode = input.storeCode?.trim() || null;
    const limit = Math.max(1, Math.min(500, input.limit || 100));
    const dryRun = !!input.dryRun;

    const where: any = {
      createdAt: { gte: since, lte: until },
      stockReturnedAt: null,
      // TREINO: devolução de treinamento NUNCA mexe em estoque real,
      // nem via retry admin (regra ouro do training.util).
      return: { isTraining: false },
    };
    if (storeCode) {
      where.return = { isTraining: false, storeCode };
    }

    const totalPendentes = await (this.prisma as any).pdvReturnItem.count({ where });

    const itemsPendentes = await (this.prisma as any).pdvReturnItem.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { return: { select: { id: true, storeCode: true, modo: true } } },
    });

    let itemsOk = 0;
    let itemsFalha = 0;
    const falhas: Array<{ returnId: string; sku: string; error: string }> = [];

    if (dryRun) {
      return {
        mode: 'dry-run',
        sinceIso,
        untilIso,
        totalPendentes,
        itemsProcessados: (itemsPendentes as any[]).length,
        itemsOk: 0,
        itemsFalha: 0,
        falhas: [],
        finished: (itemsPendentes as any[]).length < limit,
      };
    }

    // Agrupa items pendentes por storeCode pra usar 1 batch increaseStock por loja
    const byStore = new Map<string, Array<{ itemId: string; sku: string; qty: number; returnId: string }>>();
    for (const it of itemsPendentes as any[]) {
      const sc = it.return?.storeCode || '';
      if (!sc || !it.sku) {
        itemsFalha++;
        falhas.push({ returnId: it.return?.id || '', sku: it.sku || '', error: 'sku ou storeCode vazio' });
        continue;
      }
      if (!byStore.has(sc)) byStore.set(sc, []);
      byStore.get(sc)!.push({ itemId: it.id, sku: it.sku, qty: it.qty, returnId: it.return.id });
    }

    for (const [sc, items] of byStore) {
      try {
        const r = await this.erp.increaseStockAsync(
          items.map((i) => ({ sku: i.sku, qty: i.qty, storeCode: sc })),
        );
        if (r.success) {
          // Marca todos os items dessa loja como OK
          const ids = items.map((i) => i.itemId);
          await (this.prisma as any).pdvReturnItem.updateMany({
            where: { id: { in: ids } },
            data: { stockReturnedAt: new Date(), stockError: null },
          });
          itemsOk += items.length;
        } else {
          // Marca todos como erro (com a mesma mensagem do batch)
          const ids = items.map((i) => i.itemId);
          await (this.prisma as any).pdvReturnItem.updateMany({
            where: { id: { in: ids } },
            data: { stockError: r.error || 'falha desconhecida' },
          });
          itemsFalha += items.length;
          for (const i of items) {
            falhas.push({ returnId: i.returnId, sku: i.sku, error: r.error || 'falha' });
          }
        }
      } catch (e: any) {
        const msg = e?.message || String(e);
        const ids = items.map((i) => i.itemId);
        try {
          await (this.prisma as any).pdvReturnItem.updateMany({
            where: { id: { in: ids } },
            data: { stockError: msg },
          });
        } catch { /* segue */ }
        itemsFalha += items.length;
        for (const i of items) falhas.push({ returnId: i.returnId, sku: i.sku, error: msg });
      }
    }

    return {
      mode: 'executed',
      sinceIso,
      untilIso,
      totalPendentes,
      itemsProcessados: (itemsPendentes as any[]).length,
      itemsOk,
      itemsFalha,
      falhas,
      finished: (itemsPendentes as any[]).length < limit,
    };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     DEVOLUÇÃO MANUAL (Opção C — peça sem cupom localizado no sistema)

     Fluxo:
       1. Vendedora bipa SKU em loja X
       2. lookupManualReturnSku procura a peça no histórico da CAIXA daquela
          loja (`giga_caixa_mov`, tabela nativa do Postgres, janela de 60 dias)
       3. Se peça foi vendida → frontend chama createManualReturn
       4. Repõe estoque no Flow + gera vale-troca / dinheiro

     Diferenças do createReturn padrão:
       - SEM originalSaleId (NULL) — devolução órfã
       - source = 'giga_manual' (valor GRAVADO — nome herdado, não mexer:
         relatório e ficha filtram por ele)
       - manualSku = SKU bipado
       - Preço vem do histórico da caixa / cadastro, não do item original
       - Não emite NFC-e (registro interno)
     ═════════════════════════════════════════════════════════════════════════ */

  /**
   * Verifica se peça pode ser devolvida na loja atual:
   *   1. Busca SKU em pdvSale (flowops) — se achar, fluxo normal (não chega aqui)
   *   2. Busca no histórico da caixa daquela loja (Postgres), janela 60d
   *   3. Retorna produto + histórico OU mensagem de bloqueio
   */
  async lookupManualReturnSku(sku: string, storeCode: string, diasJanela = 60) {
    if (!sku?.trim()) throw new BadRequestException('SKU obrigatório');
    if (!storeCode?.trim()) throw new BadRequestException('Loja obrigatória');

    const result = await this.erp.lookupSaleHistoryByStoreAndSku(
      storeCode,
      sku,
      diasJanela,
    );

    if (!result.produto) {
      return {
        eligible: false,
        reason: 'sku_nao_cadastrado',
        message: `Peça "${sku}" não está no cadastro de produtos.`,
      };
    }
    if (!result.found) {
      return {
        eligible: false,
        reason: 'sem_historico_na_loja',
        message:
          `${result.produto.descricao || 'Peça'} (${result.produto.codigo}) ` +
          `nunca foi vendida em ${storeCode} nos últimos ${diasJanela} dias. ` +
          `A devolução deve ser feita na loja que vendeu.`,
        produto: result.produto,
      };
    }
    // VALOR DA DEVOLUÇÃO = o que a cliente PAGOU na venda mais recente desta
    // loja (linha da caixa, dividida pela quantidade), NÃO o preço atual da
    // etiqueta. Caso real (03/07): etiqueta R$ 239,90 mas a cliente pagou
    // R$ 232,48 — o vale saía R$ 7,42 maior que o pago. Fallback: preço atual
    // (histórico sem valor).
    const vendaRecente = result.vendas[0];
    const valorPagoUnit = vendaRecente && Number(vendaRecente.valor) > 0
      ? Math.round((Number(vendaRecente.valor) / Math.max(1, Number(vendaRecente.quantidade) || 1)) * 100) / 100
      : 0;
    const valorDevolucao = valorPagoUnit > 0 ? valorPagoUnit : (result.produto.preco || 0);

    return {
      eligible: true,
      produto: result.produto,
      vendas: result.vendas,
      salesCount: result.salesCount,
      diasJanela,
      valorDevolucao,
      valorBase: valorPagoUnit > 0 ? ('pago' as const) : ('etiqueta' as const),
    };
  }

  /**
   * Cria devolução manual SEM cupom localizado no sistema.
   * A peça volta pro estoque da loja atual (Postgres do Flow).
   * Sem NFC-e (registro interno).
   */
  async createManualReturn(input: {
    sku: string;
    storeCode: string;
    storeName: string;
    modo: 'dinheiro' | 'pix' | 'troca' | 'credito';
    motivo?: string;
    creditoValidadeDias?: number;
    attachToSaleId?: string | null;
    userId?: string;
    userName?: string;
    /** MODO TREINAMENTO — sessão com header x-training-mode: skip increaseStock/sangria */
    trainingRequest?: boolean;
  }) {
    const { sku, storeCode, storeName, modo, motivo, userId, userName } = input;
    const attachToSaleId = input.attachToSaleId || null;
    // Devolução manual é órfã (sem venda original) — treino vem só do header.
    const isTraining = !!input.trainingRequest;

    if (!['dinheiro', 'troca', 'credito'].includes(modo)) {
      throw new BadRequestException(`Modo inválido: ${modo}`);
    }

    // 1) Re-valida elegibilidade (anti-fraude: cliente pode passar pelo
    //    lookup e tentar burlar via POST direto)
    const elig = await this.lookupManualReturnSku(sku, storeCode, 60);
    if (!elig.eligible) {
      throw new BadRequestException(elig.message || 'Devolução não permitida');
    }
    const produto = elig.produto!;
    // Valor = o que a cliente PAGOU (calculado no lookupManualReturnSku a
    // partir do histórico da caixa desta loja) — etiqueta só como fallback.
    const valorTotal = (elig as any).valorDevolucao || produto.preco || 0;
    if (valorTotal <= 0) {
      throw new BadRequestException(
        `Peça ${produto.codigo} está sem preço no cadastro — peça pra matriz ` +
        `ajustar o preço no editor de produtos e refaça a devolução.`,
      );
    }

    // 2) Repõe estoque na loja atual (Postgres do Flow) — uma unidade
    // PULA se treinamento — não mexer em estoque real.
    let estoqueOk = false;
    let estoqueErr: string | null = null;
    if (isTraining) {
      estoqueOk = true;
      this.logger.log(`[devolucao/manual→TREINO] devolução simulada — skip increaseStock`);
    } else
    try {
      const r = await this.erp.increaseStockAsync([
        { sku: produto.codigo, qty: 1, storeCode },
      ]);
      estoqueOk = r.success;
      if (!r.success) estoqueErr = r.error || 'falha increaseStock';
    } catch (e: any) {
      estoqueErr = e?.message || String(e);
    }
    if (!estoqueOk) {
      this.logger.warn(
        `[devolucao/manual] estoque NÃO reposto pra ${produto.codigo}@${storeCode}: ${estoqueErr}`,
      );
      // Não bloqueia — admin reverte manualmente se precisar. Devolução
      // financeira (vale-troca/dinheiro) continua válida.
    }

    // 3) Pega cashSession da loja (mesmo padrão do createReturn normal)
    let cashSessionId: string | null = null;
    try {
      const s = await (this.prisma as any).pdvCashSession.findFirst({
        where: { storeCode, status: 'open' },
        select: { id: true },
      });
      cashSessionId = s?.id ?? null;
    } catch {}

    // 4) Cria PdvReturn órfão
    let creditoCode: string | null = null;
    let creditoValidade: Date | null = null;
    if (modo === 'troca' || modo === 'credito') {
      creditoCode = this.genCreditoCode();
      const dias = modo === 'troca' ? 1 : Math.max(1, input.creditoValidadeDias || 90);
      creditoValidade = new Date();
      creditoValidade.setDate(creditoValidade.getDate() + dias);
    }

    const ret = await (this.prisma as any).pdvReturn.create({
      data: {
        originalSaleId: null, // ← órfã
        originalSaleNumber: null,
        source: 'giga_manual',
        manualSku: produto.codigo,
        storeCode,
        storeName,
        cashSessionId,
        modo,
        valorTotal,
        status: 'completed',
        customerCpf: null,
        customerName: null,
        creditoCode,
        creditoValidade,
        userId: userId || null,
        userName: userName || null,
        motivo: motivo || 'Sem cupom',
        isTraining,
        items: {
          create: [
            {
              originalItemId: null,
              sku: produto.codigo,
              ref: produto.codigo,
              cor: produto.cor,
              tamanho: produto.tamanho,
              descricao: produto.descricao,
              qty: 1,
              precoUnit: produto.preco,
              total: produto.preco,
            },
          ],
        },
      } as any,
      include: { items: true },
    });

    // 5) Modo dinheiro → sangria automática
    // PULA se treinamento (não mexe no caixa real).
    if ((modo === 'dinheiro' || modo === 'pix') && cashSessionId && !isTraining) {
      try {
        const tipoLabel = modo === 'pix' ? 'PIX devolucao manual' : 'Devolucao manual';
        await this.cash.addMovement({
          storeCode,
          tipo: 'sangria',
          valor: valorTotal,
          motivo: `${tipoLabel} ${ret.id.slice(0, 8)} (${produto.codigo} sem cupom)`,
          userId,
          userName,
        });
      } catch (e: any) {
        this.logger.warn(`Sangria automática falhou: ${e?.message || e}`);
      }
    }

    // 6) Se modo=troca + attachToSaleId → anexa vale na venda em andamento
    let attachedToExistingSale = false;
    if (modo === 'troca' && creditoCode && attachToSaleId) {
      try {
        const target = await (this.prisma as any).pdvSale.findUnique({
          where: { id: attachToSaleId },
          select: { id: true, status: true, storeCode: true },
        });
        if (target && target.status === 'open' && target.storeCode === storeCode) {
          await (this.prisma as any).pdvSalePayment.create({
            data: {
              saleId: target.id,
              method: 'vale_troca',
              valor: valorTotal,
              details: JSON.stringify({
                creditoCode,
                fromReturnId: ret.id,
                modo: 'troca-anexada-manual',
                source: 'giga_manual',
                itemDevolvido: { sku: produto.codigo, descricao: produto.descricao },
              }),
            },
          });
          attachedToExistingSale = true;
          this.logger.log(
            `[devolucao/manual] Vale ${creditoCode} R$${valorTotal.toFixed(2)} ` +
              `anexado à venda ${target.id.slice(0, 8)} (origem=giga_manual)`,
          );
        }
      } catch (e: any) {
        this.logger.warn(`Anexar vale na venda em andamento falhou: ${e?.message || e}`);
      }
    }

    this.logger.log(
      `[devolução manual] ${ret.id} loja=${storeCode} sku=${produto.codigo} ` +
        `modo=${modo} valor=R$${valorTotal.toFixed(2)} estoqueOk=${estoqueOk}`,
    );

    return {
      id: ret.id,
      modo,
      creditoCode,
      creditoValidade: creditoValidade?.toISOString() ?? null,
      valorTotal,
      source: 'giga_manual',
      produto,
      estoqueReposto: estoqueOk,
      estoqueErro: estoqueErr,
      attachedToExistingSale,
      // campo extra só em treino — não muda o shape fora de treino
      ...(isTraining ? { training: true } : {}),
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // BATCH MULTI-VENDA: devolver peças de N vendas originais em UMA operação
  // ─────────────────────────────────────────────────────────────────────
  /**
   * Cliente devolve peças que saíram de COMPRAS DIFERENTES (vendas distintas).
   * Cada venda original vira UM PdvReturn (pra audit), mas:
   *  - UMA única sangria consolidada (se dinheiro/pix)
   *  - UM único creditoCode master (se troca/credito) — cliente recebe 1 vale
   *  - UM único estorno de estoque consolidado
   *  - UM único pagamento vale_troca na venda em andamento (se troca anexa)
   *
   * Aceita N vendas (sem limite — duas, três, dez compras juntas).
   */
  async createReturnBatch(input: {
    vendas: Array<{
      originalSaleId: string;
      items: Array<{ originalItemId: string; qty: number }>;
    }>;
    storeCode: string;
    storeName: string;
    modo: 'dinheiro' | 'pix' | 'troca' | 'credito';
    motivo?: string;
    creditoValidadeDias?: number;
    attachToSaleId?: string | null;
    userId?: string;
    userName?: string;
    /** MODO TREINAMENTO — sessão com header x-training-mode (união com sale.isTraining) */
    trainingRequest?: boolean;
    /** CONFIRMAÇÃO cross-store — igual ao createReturn (gap corrigido 22/07:
     *  o batch entrava sem avisar que a peça era de outra loja). */
    confirmCrossStore?: boolean;
  }) {
    const { vendas, storeCode, storeName, modo, motivo, userId, userName } = input;
    const attachToSaleId = input.attachToSaleId || null;

    if (!['dinheiro', 'pix', 'troca', 'credito'].includes(modo)) {
      throw new BadRequestException(`Modo inválido: ${modo}`);
    }
    if (!vendas?.length) throw new BadRequestException('Selecione ao menos uma venda');
    for (const v of vendas) {
      if (!v.originalSaleId) throw new BadRequestException('originalSaleId faltando em uma das vendas');
      if (!v.items?.length) throw new BadRequestException(`Venda ${v.originalSaleId.slice(0, 8)} sem itens`);
    }

    // ── ALERTA CROSS-STORE (mesma regra do createReturn) ──
    if (!input.confirmCrossStore && storeCode) {
      const ids = vendas.map((v) => v.originalSaleId);
      const salesLojas: any[] = await (this.prisma as any).pdvSale.findMany({
        where: { id: { in: ids } },
        select: { id: true, storeCode: true, storeName: true },
      });
      const outra = salesLojas.find((s) => s.storeCode && s.storeCode !== storeCode);
      // Id que não é PdvSale = pedido online no meio do lote (28/08) — também
      // pede confirmação: a peça vai entrar no estoque da loja atual.
      const achados = new Set(salesLojas.map((s) => s.id));
      const temPedidoOnline = ids.some((id) => !achados.has(id));
      if (outra || temPedidoOnline) {
        throw new BadRequestException({
          crossStoreAlert: true,
          message:
            (outra
              ? `Tem peça vendida na loja ${outra.storeName || outra.storeCode}`
              : `Tem peça de COMPRA ONLINE no meio`) +
            `, mas a devolução está sendo feita na loja ${storeName || storeCode}. ` +
            `Se confirmar, as peças entrarão no estoque da loja ${storeName || storeCode}.`,
          originalStoreCode: outra?.storeCode ?? null,
          originalStoreName: outra?.storeName ?? (temPedidoOnline ? 'Pedido online' : null),
          currentStoreCode: storeCode,
          currentStoreName: storeName,
        });
      }
    }

    // 1. Pré-carrega todas as vendas + valida items + monta itemsToCreate por venda
    type VendaProcessada = {
      sale: any;
      itemsToCreate: Array<any>;
      valorParcial: number;
      isTraining: boolean;
    };
    const processadas: VendaProcessada[] = [];
    let valorTotalGeral = 0;
    let alguemTreino = false;

    for (const v of vendas) {
      // PdvSale OU pedido online (28/08) — mesmo shape, mesmos erros.
      const sale = await this.carregarVendaDevolvivel(v.originalSaleId);

      // Devoluções anteriores pra essa venda/pedido
      const previousReturns = await (this.prisma as any).pdvReturn.findMany({
        where: this.whereDevolucoesDe(sale),
        include: { items: true },
      });
      const devolvidoPorItem = new Map<string, number>();
      for (const ret of previousReturns as any[]) {
        for (const it of ret.items) {
          const id = it.originalItemId || it.sku;
          devolvidoPorItem.set(id, (devolvidoPorItem.get(id) || 0) + (it.qty || 0));
        }
      }

      const itemsToCreate: any[] = [];
      let valorParcial = 0;
      for (const reqItem of v.items) {
        const original = (sale.items as any[]).find((i: any) => i.id === reqItem.originalItemId);
        if (!original) {
          throw new BadRequestException(`Item ${reqItem.originalItemId} não pertence à venda ${v.originalSaleId.slice(0, 8)}`);
        }
        const jaDev = devolvidoPorItem.get(original.id) || 0;
        const disponivel = (original.qty || 0) - jaDev;
        const qty = Math.max(1, Math.floor(Number(reqItem.qty) || 0));
        if (qty > disponivel) {
          throw new BadRequestException(
            `${original.descricao}: pediu ${qty} mas só tem ${disponivel} disponível (venda ${v.originalSaleId.slice(0, 8)})`,
          );
        }
        const valorUnit = original.qty > 0 ? original.total / original.qty : original.precoUnit;
        const totalItem = valorUnit * qty;
        valorParcial += totalItem;
        itemsToCreate.push({
          originalItemId: original.id,
          sku: original.sku,
          ref: original.ref,
          cor: original.cor,
          tamanho: original.tamanho,
          descricao: original.descricao,
          qty,
          precoUnit: valorUnit,
          total: totalItem,
        });
      }
      valorParcial = Math.round(valorParcial * 100) / 100;
      valorTotalGeral += valorParcial;
      // União: venda de treino OU sessão em treino (header) — em treino
      // nenhum item entra no estorno de estoque consolidado.
      const isTraining = !!(sale as any).isTraining || !!input.trainingRequest;
      if (isTraining) alguemTreino = true;

      processadas.push({ sale, itemsToCreate, valorParcial, isTraining });
    }

    valorTotalGeral = Math.round(valorTotalGeral * 100) / 100;

    // 2. Validações de caixa (1 sessão, modo dinheiro/pix)
    const cashSession = await this.cash.getCurrentSession(storeCode);
    if ((modo === 'dinheiro' || modo === 'pix') && !cashSession && !alguemTreino) {
      throw new BadRequestException('Modo dinheiro/PIX exige caixa aberto pra registrar a sangria.');
    }

    // 3. Estorno de estoque CONSOLIDADO (1 chamada com todos os itens de todas as vendas)
    const allItemsForStock = processadas.flatMap((p) =>
      p.isTraining ? [] : p.itemsToCreate.map((it) => ({ sku: it.sku, qty: it.qty, storeCode })),
    );
    const stockOkBySku = new Map<string, { ok: boolean; error?: string }>();
    if (allItemsForStock.length === 0) {
      // tudo treino — nada a estornar
      if (alguemTreino) this.logger.log(`[returns/batch→TREINO] devolução simulada — skip increaseStock`);
    } else {
      try {
        const erpResult = await this.erp.increaseStockAsync(allItemsForStock);
        if (erpResult.success) {
          for (const it of allItemsForStock) stockOkBySku.set(it.sku, { ok: true });
        } else {
          for (const it of allItemsForStock) stockOkBySku.set(it.sku, { ok: false, error: erpResult.error || 'falha' });
        }
      } catch (e: any) {
        for (const it of allItemsForStock) stockOkBySku.set(it.sku, { ok: false, error: e?.message || String(e) });
      }
    }

    // 4. Gera UM creditoCode master (se troca/credito)
    let creditoCodeMaster: string | null = null;
    let creditoValidadeMaster: Date | null = null;
    if (modo === 'troca' || modo === 'credito') {
      creditoCodeMaster = this.genCreditoCode();
      const dias = modo === 'troca' ? 1 : Math.max(1, input.creditoValidadeDias || 90);
      creditoValidadeMaster = new Date(Date.now() + dias * 86400_000);
    }

    // 5. Cria N PdvReturns (transação) — só o 1º recebe o creditoCode master
    const customerCpf = processadas[0].sale.customerCpf || null;
    const customerName = processadas[0].sale.customerName || null;
    const returnsCreated: any[] = [];
    await (this.prisma as any).$transaction(async (tx: any) => {
      for (let i = 0; i < processadas.length; i++) {
        const p = processadas[i];
        const isPrimeiro = i === 0;
        const ehPedidoOnline = p.sale.origem === 'pedido_online';
        const ret = await tx.pdvReturn.create({
          data: {
            originalSaleId: ehPedidoOnline ? null : p.sale.id,
            originalOrderId: ehPedidoOnline ? p.sale.id : null,
            source: ehPedidoOnline ? 'pedido_online' : 'flowops',
            originalSaleNumber: p.sale.nfceNumber || null,
            storeCode,
            storeName,
            cashSessionId: cashSession?.id || null,
            modo,
            valorTotal: p.valorParcial,
            status: 'completed',
            customerCpf: p.sale.customerCpf || null,
            customerName: p.sale.customerName || null,
            // Só o PRIMEIRO PdvReturn recebe o creditoCode master.
            // Os demais ficam com null e motivo apontando pro master pra audit.
            creditoCode: isPrimeiro ? creditoCodeMaster : null,
            creditoValidade: isPrimeiro ? creditoValidadeMaster : null,
            userId: userId || null,
            userName: userName || null,
            motivo: isPrimeiro
              ? (motivo || (vendas.length > 1 ? `Devolução multi-venda (${vendas.length} compras)` : null))
              : `Anexo ao vale ${creditoCodeMaster || '—'} (compra ${p.sale.nfceNumber || p.sale.id.slice(0, 8)})`,
            isTraining: p.isTraining,
            items: {
              create: p.itemsToCreate.map((it) => ({
                originalItemId: it.originalItemId,
                sku: it.sku,
                ref: it.ref,
                cor: it.cor,
                tamanho: it.tamanho,
                descricao: it.descricao,
                qty: it.qty,
                precoUnit: it.precoUnit,
                total: it.total,
                // TREINO: marca como "estoque ok" (simulado) pra item de treino
                // nunca aparecer como pendente nem ser pego pelo retry de estoque.
                stockReturnedAt: p.isTraining ? new Date() : (stockOkBySku.get(it.sku)?.ok ? new Date() : null),
                stockError: p.isTraining || stockOkBySku.get(it.sku)?.ok ? null : stockOkBySku.get(it.sku)?.error || null,
              })),
            },
          },
          include: { items: true },
        });
        returnsCreated.push(ret);
      }
    });

    // Rastro na ficha dos PEDIDOS online do lote (best-effort) — a matriz
    // que abrir o pedido vê que a peça voltou no balcão.
    for (const p of processadas) {
      if (p.sale.origem !== 'pedido_online') continue;
      try {
        await (this.prisma as any).orderHistory.create({
          data: {
            orderId: p.sale.id,
            note:
              `Devolução no balcão da loja ${storeName || storeCode}: ` +
              `${p.itemsToCreate.reduce((s: number, it: any) => s + it.qty, 0)} peça(s), ` +
              `R$ ${p.valorParcial.toFixed(2)} em ${modo}` +
              (creditoCodeMaster ? ` (vale ${creditoCodeMaster})` : '') +
              (userName ? ` — por ${userName}` : ''),
          },
        });
      } catch {
        /* rastro é conveniência */
      }
    }

    // 6. UMA sangria total (se dinheiro/pix)
    if ((modo === 'dinheiro' || modo === 'pix') && cashSession && !alguemTreino) {
      const tipoLabel = modo === 'pix' ? 'PIX devolucao' : 'Devolucao dinheiro';
      const vendasResumo = vendas.length === 1
        ? `venda ${processadas[0].sale.nfceNumber || processadas[0].sale.id.slice(0, 8)}`
        : `${vendas.length} compras`;
      await this.cash.addMovement({
        storeCode,
        tipo: 'sangria',
        valor: valorTotalGeral,
        motivo: `${tipoLabel} — ${vendasResumo}${motivo ? ' · ' + motivo : ''}`,
        userId,
        userName,
      });
    }

    // 7. Vale-troca: anexa ou cria venda direta (modo='troca')
    let directSaleId: string | null = null;
    let attachedToExistingSale = false;

    if (modo === 'troca' && creditoCodeMaster) {
      const itemsDevolvidosPayload = processadas.flatMap((p) =>
        p.itemsToCreate.map((it) => ({
          sku: it.sku,
          ref: it.ref,
          cor: it.cor,
          tamanho: it.tamanho,
          descricao: it.descricao,
          qty: it.qty,
          valor: it.total,
        })),
      );

      if (attachToSaleId) {
        const target = await (this.prisma as any).pdvSale.findUnique({
          where: { id: attachToSaleId },
          select: { id: true, storeCode: true, status: true },
        });
        if (!target) throw new BadRequestException(`Venda em andamento ${attachToSaleId.slice(0, 8)} não encontrada`);
        if (target.status !== 'open') throw new BadRequestException(`Venda em andamento está ${target.status}`);
        if (target.storeCode !== storeCode) {
          throw new BadRequestException(`Venda em andamento é da loja ${target.storeCode}, devolução em ${storeCode}`);
        }
        await (this.prisma as any).pdvSalePayment.create({
          data: {
            saleId: target.id,
            method: 'vale_troca',
            valor: valorTotalGeral,
            details: JSON.stringify({
              creditoCode: creditoCodeMaster,
              fromReturnIds: returnsCreated.map((r) => r.id),
              modo: 'troca-anexada-batch',
              vendasOriginais: processadas.length,
              itemsDevolvidos: itemsDevolvidosPayload,
            }),
          },
        });
        attachedToExistingSale = true;
      } else {
        try {
          const store = await this.prisma.store.findUnique({
            where: { code: storeCode },
            select: { code: true, name: true },
          });
          if (store) {
            let cashSessionId: string | null = null;
            try {
              const s = await (this.prisma as any).pdvCashSession.findFirst({
                where: { storeCode: store.code, status: 'open' },
                select: { id: true },
              });
              cashSessionId = s?.id || null;
            } catch {}
            const newSale = await (this.prisma as any).pdvSale.create({
              data: {
                storeCode: store.code,
                storeName: store.name,
                cashSessionId,
                vendedorUserId: userId || null,
                vendedorName: userName || null,
                customerCpf,
                customerName,
                status: 'open',
              },
            });
            await (this.prisma as any).pdvSalePayment.create({
              data: {
                saleId: newSale.id,
                method: 'vale_troca',
                valor: valorTotalGeral,
                details: JSON.stringify({
                  creditoCode: creditoCodeMaster,
                  fromReturnIds: returnsCreated.map((r) => r.id),
                  modo: 'troca-batch-mesmo-dia',
                  vendasOriginais: processadas.length,
                  itemsDevolvidos: itemsDevolvidosPayload,
                }),
              },
            });
            directSaleId = newSale.id;
          }
        } catch (e: any) {
          this.logger.warn(`[devolução/batch troca-direta] Falha ao criar venda direta: ${e?.message}`);
        }
      }
    }

    this.logger.log(
      `[devolução/BATCH] ${returnsCreated.length} return(s) loja=${storeCode} ` +
      `modo=${modo} valorTotal=R$${valorTotalGeral.toFixed(2)} ` +
      (creditoCodeMaster ? `code=${creditoCodeMaster}` : ''),
    );

    return {
      batch: true,
      returns: returnsCreated,
      vendasProcessadas: processadas.length,
      valorTotal: valorTotalGeral,
      modo,
      creditoCode: creditoCodeMaster,
      creditoValidade: creditoValidadeMaster?.toISOString() ?? null,
      directSaleId,
      attachedToExistingSale,
      customerCpf,
      customerName,
    };
  }
}

