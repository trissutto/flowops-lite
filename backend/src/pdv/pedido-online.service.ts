import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoutingService } from '../routing/routing.service';
import { RoutingResult } from '../routing/types';
import { montarComplementoBairroWc, montarNumeroWc } from '../common/endereco-wc';

/**
 * PEDIDO ONLINE (14/08) — a Venda Online do PDV vira um Order no trilho do
 * site, gated por PEDIDO_ONLINE_ROTEAMENTO=1.
 *
 * A venda continua 100% no caixa da loja vendedora (comissão, fechamento);
 * este Order é o trilho LOGÍSTICO+FINANCEIRO: separação com card verde ONLINE,
 * etiqueta Correios e acerto fornecedora→vendedora (Order.sellerStoreCode).
 *
 * Dois caminhos na criação:
 *   - loja vendedora TEM todas as peças → auto-atende: nasce 'separating' com
 *     o card na PRÓPRIA loja (pula o roteamento — decisão do dono 14/08,
 *     "PIRACICABA ATENDE O PEDIDO TODO").
 *   - falta peça → nasce 'processing' e cai na tela de roteamento da matriz,
 *     igual pedido do site.
 *
 * ⚠️ TRAVA DE BAIXA DUPLA: quem cria o Order NÃO baixa estoque no finalize —
 * o finalize marca sale.stockDecreasedAt e quem baixa é a loja que SEPARA
 * (runAutoDebit no bipe do card). Ver o call-site no PdvService.finalize.
 */
@Injectable()
export class PedidoOnlineService {
  private readonly logger = new Logger(PedidoOnlineService.name);

  /** Faixa sintética própria — longe do WC real, da live (900M) e da loja (950M). */
  static readonly ONLINE_WC_ID_BASE = 960_000_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: RoutingService,
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
  private async lojaTemTudo(sale: any, storeCode: string): Promise<boolean> {
    const porSku = new Map<string, number>();
    for (const it of sale.items as any[]) {
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
   * Chamado pelo finalize (venda 100% 'venda_online', flag ligada, não-treino).
   * NUNCA lança: qualquer falha → null e o finalize segue no comportamento
   * legado (baixa na própria loja). Retorna info pro front exibir a mensagem.
   */
  async criarDoFinalize(sale: any): Promise<{
    wcOrderNumber: string;
    autoAtendida: boolean;
    storeName: string | null;
  } | null> {
    try {
      if (!this.enabled()) return null;
      const items = (sale.items || []) as any[];
      if (!items.length) return null;
      if (!this.digits(sale.customerCep)) {
        this.logger.warn(`[pedido-online] venda ${sale.id} SEM CEP — não vira Order (baixa local, fluxo legado)`);
        return null;
      }
      const store: any = await (this.prisma as any).store
        .findFirst({ where: { code: sale.storeCode } })
        .catch(() => null);
      if (!store) {
        this.logger.warn(`[pedido-online] venda ${sale.id}: loja code=${sale.storeCode} não achada em Store — fluxo legado`);
        return null;
      }

      const autoAtende = await this.lojaTemTudo(sale, store.code).catch(() => false);

      const checkoutInfo = {
        origem: 'pdv_online',
        pdvSaleId: sale.id,
        sellerStoreCode: sale.storeCode,
        sellerStoreName: sale.storeName,
        vendedora: sale.sellerName || sale.vendedorName || null,
        // Stub de frete no shape do site: a etiqueta/expedição leem daqui.
        // Venda online do PDV não cota frete no checkout — Correios padrão.
        shipping: { id: 'correios', kind: 'correios', label: 'Correios', price: 0, etaDays: null },
        address: {
          cep: this.digits(sale.customerCep),
          street: sale.customerEndereco || '',
          number: sale.customerNumero || '',
          complement: sale.customerComplemento || null,
          neighborhood: sale.customerBairro || '',
          city: sale.customerCidade || '',
          uf: String(sale.customerUf || '').toUpperCase().slice(0, 2),
        },
        items: items.map((it) => ({
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
              shippingMethod: 'Envio Correios (venda online)',
              wcDateCreated: new Date(),
              checkoutInfo: JSON.stringify(checkoutInfo),
              items: {
                create: items.map((it) => ({
                  sku: String(it.sku),
                  productName: it.descricao || [it.ref, it.cor, it.tamanho].filter(Boolean).join(' · '),
                  quantity: Number(it.qty || 1),
                  unitPrice: Number(it.precoUnit || 0),
                  // Base do acerto ÷2,5 — preço de tabela do PDV (o desconto
                  // da venda é da loja vendedora, não muda o acerto).
                  baseUnitPrice: Number(it.precoUnit || 0),
                })),
              },
            },
          });
          break;
        } catch (e: any) {
          if (e?.code !== 'P2002') throw e;
        }
      }
      if (!order) throw new Error('colisão de wcOrderId em 6 tentativas');

      let autoOk = false;
      if (autoAtende) {
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
              items: items.map((it) => ({ sku: String(it.sku), quantity: Number(it.qty || 1) })),
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

      this.logger.log(
        `[pedido-online] venda ${sale.id} → pedido ${order.wcOrderNumber} ` +
          `(${autoOk ? `AUTO-ATENDE na ${store.name}` : 'fila de roteamento'})`,
      );
      return { wcOrderNumber: order.wcOrderNumber, autoAtendida: autoOk, storeName: store.name };
    } catch (e: any) {
      this.logger.error(`[pedido-online] venda ${sale?.id}: ${e?.message || e} — fluxo legado (baixa local)`);
      return null;
    }
  }
}
