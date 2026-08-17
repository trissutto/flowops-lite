import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoutingService } from '../routing/routing.service';
import { RoutingResult } from '../routing/types';
import { montarComplementoBairroWc, montarNumeroWc } from '../common/endereco-wc';
import { ehItemSemEstoque } from '../common/item-sem-estoque';
import { PedidoEmailService } from '../loja-orders/pedido-email.service';
import { ErpService } from '../erp/erp.service';

/**
 * PEDIDO ONLINE (14/08) — a Venda Online do PDV vira um Order no trilho do
 * site, gated por PEDIDO_ONLINE_ROTEAMENTO=1.
 *
 * A venda continua 100% no caixa da loja vendedora (comissão, fechamento);
 * este Order é o trilho LOGÍSTICO+FINANCEIRO: separação com card verde ONLINE,
 * etiqueta Correios e acerto fornecedora→vendedora (Order.sellerStoreCode).
 *
 * Três caminhos na criação:
 *   - loja vendedora TEM tudo e a entrega é MOTOBOY → nasce 'shipped' NELA: o
 *     estoque baixa nela na hora e NENHUM card é aberto (ver
 *     `fecharNaLojaVendedora`). Motoboy sai da mão da loja: não existe etiqueta,
 *     rastreio nem postagem pra fazer, então card ali é tarefa fantasma.
 *   - loja vendedora TEM tudo e é SEDEX/PAC/RETIRADA → auto-atende: nasce
 *     'separating' com o card na PRÓPRIA loja (decisão do dono 14/08,
 *     "PIRACICABA ATENDE O PEDIDO TODO"). ⚠️ O card é a FERRAMENTA de postar —
 *     é NELE que ficam "Gerar envio Correios", "Etiqueta + NF" e "Já postei"
 *     (`frontend/src/app/minha-loja/page.tsx`). Tirar o card de um pedido
 *     SEDEX/PAC deixa a loja sem como emitir etiqueta e a cliente sem rastreio.
 *   - falta peça → nasce 'processing' e cai na tela de roteamento da matriz,
 *     igual pedido do site.
 *
 * ⚠️ TRAVA DE BAIXA DUPLA: quem cria o Order NÃO baixa estoque no finalize —
 * o finalize marca sale.stockDecreasedAt e quem baixa é a loja que SEPARA
 * (runAutoDebit no bipe do card), OU este serviço quando fecha na vendedora.
 * Ver o call-site no PdvService.finalize.
 */
@Injectable()
export class PedidoOnlineService {
  private readonly logger = new Logger(PedidoOnlineService.name);

  /** Faixa sintética própria — longe do WC real, da live (900M) e da loja (950M). */
  static readonly ONLINE_WC_ID_BASE = 960_000_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: RoutingService,
    private readonly pedidoEmail: PedidoEmailService,
    private readonly erp: ErpService,
  ) {}

  enabled(): boolean {
    return String(process.env.PEDIDO_ONLINE_ROTEAMENTO ?? '').trim() === '1';
  }

  private digits(v: any): string {
    return String(v ?? '').replace(/\D+/g, '');
  }

  /** Mesma normalização do espelho: loja/código sem zeros à esquerda. */
  private semZeros(v: any): string {
    return String(v ?? '').trim().replace(/^0+/, '') || '0';
  }

  private numeroPedido(seq: number): string {
    return `ON-${String(seq).padStart(6, '0')}`;
  }

  /**
   * FORMA DE ENTREGA escolhida no PDV (`PdvSale.entregaTipo`) → o que a
   * retaguarda precisa saber pra despachar.
   *
   * `kind` é o mesmo vocabulário do checkout do site (`checkoutInfo.shipping`),
   * então a tela de pedido, a etiqueta e a expedição leem sem tradução.
   * Venda antiga (antes de 14/08) e venda sem escolha caem em `correios`
   * genérico — o rótulo diz "não informada" em vez de mentir "Correios".
   */
  private entrega(tipo: string | null | undefined, storeName?: string | null) {
    switch (String(tipo || '').trim().toLowerCase()) {
      case 'sedex':
        return { id: 'sedex', kind: 'correios', label: 'SEDEX', pickup: false };
      case 'pac':
        return { id: 'pac', kind: 'correios', label: 'PAC', pickup: false };
      case 'motoboy':
        return { id: 'motoboy', kind: 'motoboy', label: 'MOTOBOY', pickup: false };
      case 'retirada':
        return {
          id: 'retirada',
          kind: 'pickup',
          label: `RETIRADA NA LOJA${storeName ? ` — ${storeName}` : ''}`,
          pickup: true,
        };
      default:
        return { id: 'correios', kind: 'correios', label: 'Entrega (não informada)', pickup: false };
    }
  }

  private async proximaSequencia(): Promise<number> {
    const base = PedidoOnlineService.ONLINE_WC_ID_BASE;
    const ultimo = await (this.prisma as any).order.findFirst({
      where: { source: 'pdv_online', wcOrderId: { gte: base } },
      orderBy: { wcOrderId: 'desc' },
      select: { wcOrderId: true },
    });
    return ultimo ? Number(ultimo.wcOrderId) - base : 0;
  }

  /** Endereço no shape do WooCommerce — o que etiqueta/separação já leem. */
  private montarShippingWc(sale: any) {
    const partesNome = String(sale.customerName || '').trim().split(/\s+/);
    return {
      first_name: partesNome[0] || '',
      last_name: partesNome.slice(1).join(' '),
      address_1: [sale.customerEndereco, sale.customerNumero].filter(Boolean).join(', '),
      ...montarComplementoBairroWc(sale.customerComplemento, sale.customerBairro),
      ...montarNumeroWc(sale.customerNumero),
      city: sale.customerCidade || '',
      state: String(sale.customerUf || '').toUpperCase().slice(0, 2),
      postcode: this.digits(sale.customerCep),
      phone: this.digits(sale.customerPhone),
    };
  }

  /** A loja vendedora tem TODAS as peças da venda? (espelho wincred_estoque) */
  private async lojaTemTudo(pecas: any[], storeCode: string): Promise<boolean> {
    const porSku = new Map<string, number>();
    for (const it of pecas) {
      const sku = this.semZeros(it.sku);
      porSku.set(sku, (porSku.get(sku) || 0) + Number(it.qty || 1));
    }
    const lojaAlvo = this.semZeros(storeCode);
    const est: any[] = await (this.prisma as any).wincredEstoque.findMany({
      where: { codigo: { in: [...porSku.keys()] } },
      select: { codigo: true, loja: true, estoque: true },
    });
    const disponivel = new Map<string, number>();
    for (const r of est) {
      if (this.semZeros(r.loja) !== lojaAlvo) continue;
      const c = this.semZeros(r.codigo);
      disponivel.set(c, (disponivel.get(c) || 0) + (Number(r.estoque) || 0));
    }
    for (const [sku, qtd] of porSku) {
      if ((disponivel.get(sku) || 0) < qtd) return false;
    }
    return true;
  }

  /**
   * Fecha o pedido na PRÓPRIA loja vendedora: baixa o estoque dela e marca o
   * Order como enviado, sem abrir card de separação pra ninguém.
   *
   * A baixa usa `decreaseStockAsync` de propósito: aplica o delta no Flow
   * (fonte do estoque desde 14/07) na hora e enfileira a réplica no outbox, em
   * vez de pendurar o finalize esperando MySQL.
   *
   * `allowNegative`/`skipNotFound` porque a peça JÁ SAIU fisicamente — igual ao
   * `runAutoDebit` da separação. Divergência de saldo não pode impedir o
   * sistema de registrar o que de fato aconteceu; saldo negativo aparecendo na
   * tela é melhor que peça fantasma vendida de novo no site.
   *
   * Retorna false se a baixa não aplicou nada — aí o chamador deixa o pedido
   * em 'processing' e ele cai na matriz (degradação segura).
   */
  private async fecharNaLojaVendedora(
    order: any,
    store: any,
    pecas: any[],
    sale: any,
  ): Promise<boolean> {
    try {
      const items = pecas.map((it) => ({
        sku: String(it.sku),
        qty: Number(it.qty || 1),
        storeCode: store.code,
      }));

      const r = await this.erp.decreaseStockAsync(items, {
        allowNegative: true,
        skipNotFound: true,
      });
      if (!r?.success) {
        this.logger.error(
          `[pedido-online] ${order.wcOrderNumber}: baixa na vendedora ${store.name} ` +
            `falhou (${r?.error || 'sem detalhe'}) — pedido segue pro roteamento`,
        );
        return false;
      }

      const vendedora = sale?.sellerName || sale?.vendedorName || null;
      await (this.prisma as any).order.update({
        where: { id: order.id },
        data: {
          status: 'shipped',
          // A peça saiu da vendedora: os itens são DELA, não de quem separaria.
          // Sem isso o acerto ÷2,5 e a auditoria de roteamento ficam sem dono.
          items: { updateMany: { where: { orderId: order.id }, data: { assignedStoreId: store.id } } },
        },
      });

      await (this.prisma as any).orderHistory
        .create({
          data: {
            orderId: order.id,
            fromStatus: 'processing',
            toStatus: 'shipped',
            note:
              `Venda online entregue pela própria ${store.name}` +
              `${vendedora ? ` (vendedora: ${vendedora})` : ''} — ` +
              `${items.length} peça(s) baixada(s) do estoque dela no fechamento. ` +
              `Sem separação: a peça já estava em mãos e saiu pra cliente.`,
          },
        })
        .catch(() => null);

      this.logger.log(
        `[pedido-online] ${order.wcOrderNumber} FECHADO na ${store.name} — ` +
          `${items.length} peça(s) baixada(s)${r.gigaEnfileirado ? ' (réplica no outbox)' : ''}`,
      );
      return true;
    } catch (e: any) {
      this.logger.error(
        `[pedido-online] ${order?.wcOrderNumber}: falha ao fechar na vendedora ` +
          `(${e?.message || e}) — pedido segue pro roteamento`,
      );
      return false;
    }
  }

  /**
   * Chamado pelo finalize (venda 100% 'venda_online', flag ligada, não-treino).
   * NUNCA lança: qualquer falha → null e o finalize segue no comportamento
   * legado (baixa na própria loja). Retorna info pro front exibir a mensagem.
   */
  async criarDoFinalize(sale: any): Promise<{
    wcOrderNumber: string;
    autoAtendida: boolean;
    /** Loja vendedora entregou ela mesma: estoque já baixou nela, sem card. */
    fechadoNaLoja: boolean;
    storeName: string | null;
  } | null> {
    try {
      if (!this.enabled()) return null;
      const items = (sale.items || []) as any[];
      if (!items.length) return null;

      /**
       * PEÇAS × LINHAS QUE NÃO SÃO PEÇA (14/08 — bug do ON-000001).
       *
       * O Order é o trilho LOGÍSTICO: só entra nele o que uma loja separa.
       * FRETE e itens MANUAIS ficam de fora — o dinheiro deles já está no
       * `totalAmount` (é o total da venda) e no caixa da loja vendedora.
       * Copiar a linha de FRETE pra cá fazia o roteamento caçar estoque do
       * SKU "FRETE" e o pedido nascer em ruptura falsa.
       */
      const pecas = items.filter((it) => !ehItemSemEstoque(it));
      const freteReais = items
        .filter((it) => String(it?.ref ?? it?.sku ?? '').trim().toUpperCase() === 'FRETE')
        .reduce((s, it) => s + (Number(it.total) || Number(it.precoUnit) || 0), 0);
      if (!pecas.length) {
        this.logger.warn(`[pedido-online] venda ${sale.id} sem nenhuma PEÇA (só frete/manual) — não vira Order`);
        return null;
      }

      const store: any = await (this.prisma as any).store
        .findFirst({ where: { code: sale.storeCode } })
        .catch(() => null);
      if (!store) {
        this.logger.warn(`[pedido-online] venda ${sale.id}: loja code=${sale.storeCode} não achada em Store — fluxo legado`);
        return null;
      }

      // RETIRADA EM LOJA não tem entrega — a cliente busca no balcão. Exigir
      // CEP dela derrubaria o pedido pro fluxo legado (sem card, sem trilho)
      // justamente no caso mais simples.
      const entrega = this.entrega(sale.entregaTipo, store.name);
      if (!entrega.pickup && !this.digits(sale.customerCep)) {
        this.logger.warn(`[pedido-online] venda ${sale.id} SEM CEP — não vira Order (baixa local, fluxo legado)`);
        return null;
      }

      const autoAtende = await this.lojaTemTudo(pecas, store.code).catch(() => false);

      /**
       * A LOJA VENDEDORA ENTREGA ELA MESMA (17/08) — não vira tarefa de
       * separação pra ninguém.
       *
       * CASO SUZANO / ON-000004 (15/08): a loja fechou a venda no caixa,
       * escolheu MOTOBOY e mandou a peça pra cliente no mesmo dia. O pedido
       * nasceu 'processing', passou o fim de semana na fila da matriz e na
       * segunda foi roteado pra SOROCABA — 150 km de distância, que ia separar
       * e enviar uma SEGUNDA peça pra mesma cliente. Pior: a trava de baixa
       * dupla tinha delegado a baixa pra "quem separar", então o estoque de
       * Suzano ficou FANTASMA (a peça saiu fisicamente, o saldo não baixou) e
       * as redes de segurança do outbox/reconcile pulam por causa do mesmo
       * `stockDecreasedAt`. Ninguém no balcão sabia que um pedido tinha nascido.
       *
       * Quem fecha uma venda online no PRÓPRIO caixa e entrega DE MOTOBOY é quem
       * resolve tudo. Então o pedido nasce FECHADO nela: estoque baixa nela na
       * hora e nenhum card é aberto.
       *
       * ⚠️ SÓ MOTOBOY. SEDEX/PAC e RETIRADA continuam abrindo card na própria
       * loja de propósito — o card é a FERRAMENTA do trabalho que ainda falta:
       *   - SEDEX/PAC → "Gerar envio Correios" / "Etiqueta + NF" / "Já postei"
       *     vivem NO card. Sem card a loja não tem como emitir etiqueta e a
       *     cliente não recebe rastreio.
       *   - RETIRADA → separar e guardar a peça pro balcão é tarefa real, e o
       *     `routePickup` já dá prioridade total à loja da retirada.
       * Motoboy é o único caso em que a peça sai da mão da vendedora sem nenhum
       * artefato do sistema no caminho — foi exatamente onde o card virou
       * tarefa fantasma e alguém reportou "sem estoque" de peça já entregue.
       */
      const fechaNaLoja = autoAtende && entrega.kind === 'motoboy';

      const checkoutInfo = {
        origem: 'pdv_online',
        pdvSaleId: sale.id,
        sellerStoreCode: sale.storeCode,
        sellerStoreName: sale.storeName,
        vendedora: sale.sellerName || sale.vendedorName || null,
        // Frete no shape do site (a tela de pedido, a etiqueta e a expedição
        // leem daqui): a FORMA vem da escolha da loja no PDV e o VALOR é o
        // que ela cobrou da cliente na linha FRETE — não mais "Correios 0,00".
        shipping: {
          id: entrega.id,
          kind: entrega.kind,
          label: entrega.label,
          price: freteReais,
          etaDays: null,
        },
        address: {
          cep: this.digits(sale.customerCep),
          street: sale.customerEndereco || '',
          number: sale.customerNumero || '',
          complement: sale.customerComplemento || null,
          neighborhood: sale.customerBairro || '',
          city: sale.customerCidade || '',
          uf: String(sale.customerUf || '').toUpperCase().slice(0, 2),
        },
        items: pecas.map((it) => ({
          sku: String(it.sku),
          name: it.descricao,
          size: it.tamanho || null,
          color: it.cor || null,
          quantity: Number(it.qty || 1),
          unitPrice: Number(it.precoUnit || 0),
        })),
      };

      const base = PedidoOnlineService.ONLINE_WC_ID_BASE;
      const seq0 = await this.proximaSequencia();
      let order: any = null;
      // Retry em colisão de wcOrderId — mesma defesa do e-commerce/live. A
      // sequência nasce e é consumida DENTRO do create: colisão dá P2002 e
      // tenta a próxima (nada de contador fora da transação — caso LP-000012).
      for (let tent = 0; tent < 6; tent++) {
        const seq = seq0 + 1 + tent;
        try {
          order = await (this.prisma as any).order.create({
            data: {
              wcOrderId: base + seq,
              wcOrderNumber: this.numeroPedido(seq),
              source: 'pdv_online',
              // Dinheiro JÁ entrou (o finalize só roda com pago=total):
              // 'processing' = direto na fila de roteamento da matriz.
              status: 'processing',
              paidAt: new Date(),
              sellerStoreCode: sale.storeCode,
              customerName: String(sale.customerName || '').trim() || null,
              customerEmail: String(sale.customerEmail || '').trim() || null,
              customerPhone: this.digits(sale.customerPhone) || null,
              customerCpf: this.digits(sale.customerCpf) || null,
              shippingCep: this.digits(sale.customerCep) || null,
              shippingAddress: JSON.stringify(this.montarShippingWc(sale)),
              totalAmount: Number(sale.total || 0),
              // FORMA DE ENTREGA (14/08): SEDEX/PAC/MOTOBOY/RETIRADA, do jeito
              // que a loja escolheu. Retirada marca `isPickup` — a separação
              // trava na própria loja e a tela mostra o banner de retirada.
              shippingMethod: entrega.label,
              isPickup: entrega.pickup,
              pickupStoreCode: entrega.pickup ? store.code : null,
              wcDateCreated: new Date(),
              checkoutInfo: JSON.stringify(checkoutInfo),
              items: {
                create: pecas.map((it) => ({
                  sku: String(it.sku),
                  productName: it.descricao || [it.ref, it.cor, it.tamanho].filter(Boolean).join(' · '),
                  // REF · COR · TAM em coluna — o formato que a loja lê na
                  // arara (13/08). Sem isto o card do pedido online mostrava
                  // só o nome comprido do cadastro.
                  ref: it.ref || null,
                  cor: it.cor || null,
                  tamanho: it.tamanho || null,
                  quantity: Number(it.qty || 1),
                  unitPrice: Number(it.precoUnit || 0),
                  // Base do acerto ÷2,5 — preço de tabela do PDV (o desconto
                  // da venda é da loja vendedora, não muda o acerto).
                  baseUnitPrice: Number(it.precoUnit || 0),
                })),
              },
            },
            // `include` pro e-mail de confirmação listar as peças — sem ele o
            // create devolve o pedido sem itens e a mensagem sai vazia.
            include: { items: true },
          });
          break;
        } catch (e: any) {
          if (e?.code !== 'P2002') throw e;
        }
      }
      if (!order) throw new Error('colisão de wcOrderId em 6 tentativas');

      let autoOk = false;
      let fechadoNaLoja = false;

      // FECHA NA VENDEDORA: baixa o estoque dela e marca 'shipped', sem card.
      // Se a baixa falhar, o pedido FICA em 'processing' e cai na matriz — o
      // status só avança depois que o estoque mexeu de verdade, senão eu
      // recriaria o estoque fantasma que este fix existe pra matar.
      if (fechaNaLoja) {
        fechadoNaLoja = await this.fecharNaLojaVendedora(order, store, pecas, sale);
      }

      if (!fechadoNaLoja && autoAtende) {
        // AUTO-ATENDE: a própria loja vendedora tem tudo → card nela AGORA,
        // pulando a matriz. confirmRoute cuida de pick-order + assignedStoreId
        // + status separating + histórico + socket (mesmo trilho da matriz).
        const result: RoutingResult = {
          success: true,
          strategy: 'single-store',
          assignments: [
            {
              storeId: store.id,
              storeCode: store.code,
              storeName: store.name,
              items: pecas.map((it) => ({ sku: String(it.sku), quantity: Number(it.qty || 1) })),
            },
          ],
          missing: [],
        };
        try {
          const r = await this.routing.confirmRoute(order.id, result);
          autoOk = !!(r as any)?.persisted;
        } catch (e: any) {
          // Falhou o auto-atende → o pedido FICA em 'processing' e cai na
          // matriz. Pior caso é o fluxo normal, nunca pedido perdido.
          this.logger.warn(`[pedido-online] auto-atende do ${order.wcOrderNumber} falhou (${e?.message || e}) — vai pro roteamento`);
        }
      }

      // CONFIRMAÇÃO PRA CLIENTE (14/08) — a venda online nasceu muda. A
      // vendedora já falou com ela no WhatsApp, mas ninguém mandava o número
      // do pedido nem o registro do que foi comprado. Fire-and-forget e sem
      // e-mail no cadastro simplesmente não sai (o `destinatario` filtra).
      // O pedido já nasce PAGO, então a mensagem certa é a de pagamento
      // confirmado, não a de "aguardando".
      void this.pedidoEmail
        .aoConfirmarPagamento({ ...order, items: order.items ?? [] })
        .catch((e: any) => this.logger.warn(`[pedido-online] aviso ao cliente falhou: ${e?.message || e}`));

      const destino = fechadoNaLoja
        ? `FECHADO na ${store.name} (estoque baixado lá, sem separação)`
        : autoOk
          ? `AUTO-ATENDE na ${store.name}`
          : 'fila de roteamento';
      this.logger.log(`[pedido-online] venda ${sale.id} → pedido ${order.wcOrderNumber} (${destino})`);
      return {
        wcOrderNumber: order.wcOrderNumber,
        autoAtendida: autoOk,
        fechadoNaLoja,
        storeName: store.name,
      };
    } catch (e: any) {
      this.logger.error(`[pedido-online] venda ${sale?.id}: ${e?.message || e} — fluxo legado (baixa local)`);
      return null;
    }
  }
}
