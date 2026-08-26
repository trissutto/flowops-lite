import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoutingService } from '../routing/routing.service';
import { RoutingResult } from '../routing/types';
import { montarComplementoBairroWc, montarNumeroWc } from '../common/endereco-wc';
import { ehItemSemEstoque } from '../common/item-sem-estoque';
import { ehLojaCanal } from '../common/loja-canal';
import { PedidoEmailService } from '../loja-orders/pedido-email.service';
import { vendaOnlineTemProva } from '../common/prova-pagamento';
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
 *   - loja vendedora TEM tudo e a entrega NÃO é retirada → nasce 'shipped'
 *     NELA: o estoque baixa nela na hora e NENHUM card é aberto (ver
 *     `fecharNaLojaVendedora`).
 *   - loja vendedora TEM tudo e é RETIRADA → auto-atende: nasce 'separating'
 *     com o card na PRÓPRIA loja (a peça precisa ser separada e guardada pro
 *     balcão — decisão do dono 14/08, "PIRACICABA ATENDE O PEDIDO TODO").
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

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  QUEM ENTREGA — cobertura de CADA loja pras peças desta venda (26/08).
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Substitui a REGRA A do motoboy (17/08), que dizia "motoboy só sai da loja
   * vendedora" e RECUSAVA a escolha quando a arara da vendedora não tinha a
   * peça. A regra nasceu certa pelo motivo certo — sem `pickupStoreCode` o
   * pedido motoboy caía numa loja a 150 km (ON-000004) — mas hoje a trava é
   * outra: a atendente ESCOLHE a loja que manda o motoboy, e a engine
   * (`routePickup`) prende o pedido nela. Distância virou decisão de gente,
   * não sorteio do roteamento.
   *
   * Caso que derrubou a regra (dono, 26/08): Itanhaém vende, a cliente é de
   * PIRACICABA e quem entrega de moto é PIRACICABA. A vendedora clicava
   * MOTOBOY e levava "sua loja não tem: 5354658" — um código que não está na
   * etiqueta, sobre uma loja que nunca ia entregar nada.
   *
   * Então em vez de RECUSAR, a tela INFORMA antes: cada loja vem com o que
   * ela cobre desta sacola. A loja escolhida recebe o card; o que faltar
   * chega por transferência (`pickup-transfer`), **mesmo que ela não tenha
   * nenhuma peça** — ordem do dono. Bloquear virou trabalho de nenhum
   * ninguém: quem sabe se dá pra esperar a transferência é quem está com a
   * cliente no telefone.
   *
   * ⚠️ LOJA-CANAL FORA DA LISTA: `routing.service` tira `LOJA_CANAL_CODES` das
   * lojas roteáveis, então escolher a 13 como quem entrega gerava um pedido
   * `pickup-blocked` (a engine não acha a loja de destino). Ela não tem arara
   * nem moto — não é candidata. Isso fecha a ponta que estava aberta desde
   * 17/08, quando a 13 ganhou exceção pra ESCOLHER motoboy sem ter onde
   * ancorar a entrega.
   */
  async coberturaPorLoja(saleId: string) {
    const sale: any = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      select: {
        storeCode: true,
        customerCidade: true,
        items: {
          select: {
            sku: true, ref: true, cor: true, tamanho: true, descricao: true, qty: true,
          },
        },
      },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');

    const lojas = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
      orderBy: { name: 'asc' },
    });
    const candidatas = lojas.filter((s) => !ehLojaCanal(s.code));
    const cidadeCliente = this.chaveCidade(sale.customerCidade);
    const daCliente = (s: { city: string | null }) =>
      !!cidadeCliente && this.chaveCidade(s.city) === cidadeCliente;
    const ehVendedora = (code: string) =>
      this.semZeros(code) === this.semZeros(sale.storeCode);

    const pecas = (sale.items || []).filter((it: any) => !ehItemSemEstoque(it));

    // Sacola só de FRETE/MANUAL: não há peça pra procurar, toda loja "cobre".
    if (!pecas.length) {
      return {
        total: 0,
        cidadeCliente: sale.customerCidade || null,
        lojas: candidatas.map((s) => ({
          code: s.code,
          name: s.name,
          city: s.city || null,
          cobertas: 0,
          total: 0,
          temTudo: true,
          faltam: [] as string[],
          cidadeDaCliente: daCliente(s),
          ehVendedora: ehVendedora(s.code),
        })),
      };
    }

    const { porSku, porLoja } = await this.disponivelPorLoja(
      pecas,
      candidatas.map((s) => s.code),
    );

    // REF · COR · TAM é o que está na etiqueta e na arara — o `sku` (código
    // do Wincred) não está em lugar nenhum que a vendedora consiga olhar.
    const rotulo = new Map<string, string>();
    for (const it of pecas) {
      const sku = this.semZeros(it.sku);
      if (!rotulo.has(sku)) rotulo.set(sku, this.rotuloPeca(it));
    }
    const totalPecas = [...porSku.values()].reduce((a, b) => a + b, 0);

    const linhas = candidatas.map((s) => {
      const disp = porLoja.get(this.semZeros(s.code)) || new Map<string, number>();
      let cobertas = 0;
      const faltam: string[] = [];
      for (const [sku, qtd] of porSku) {
        const tem = Math.min(qtd, Math.max(0, disp.get(sku) || 0));
        cobertas += tem;
        if (tem < qtd) {
          const nome = rotulo.get(sku) || sku;
          faltam.push(qtd > 1 ? `${nome} (tem ${tem} de ${qtd})` : nome);
        }
      }
      return {
        code: s.code,
        name: s.name,
        city: s.city || null,
        cobertas,
        total: totalPecas,
        temTudo: faltam.length === 0,
        faltam,
        cidadeDaCliente: daCliente(s),
        ehVendedora: ehVendedora(s.code),
      };
    });

    /**
     * ORDEM DA LISTA: CIDADE DA CLIENTE PRIMEIRO, não "quem tem a peça".
     *
     * Motoboy é distância — a loja que tem a sacola inteira a 150 km não
     * entrega nada, e a que não tem nenhuma peça mas fica na esquina entrega
     * depois da transferência. Estoque desempata; endereço decide.
     */
    linhas.sort(
      (a, b) =>
        Number(b.cidadeDaCliente) - Number(a.cidadeDaCliente) ||
        Number(b.temTudo) - Number(a.temTudo) ||
        b.cobertas - a.cobertas ||
        a.name.localeCompare(b.name, 'pt-BR'),
    );

    return { total: totalPecas, cidadeCliente: sale.customerCidade || null, lojas: linhas };
  }

  /** REF · COR · TAM (o que está na etiqueta); cai pro nome do cadastro. */
  private rotuloPeca(it: any): string {
    return (
      [it?.ref, it?.cor, it?.tamanho].filter(Boolean).join(' · ') ||
      String(it?.descricao || '').trim() ||
      this.semZeros(it?.sku)
    );
  }

  /** Cidade comparável: sem acento, sem caixa, sem espaço nas pontas. */
  private chaveCidade(v: any): string {
    return String(v ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .trim()
      .toUpperCase();
  }

  /**
   * O `disponivelNaLoja` de VÁRIAS lojas de uma vez — mesma conta (espelho
   * MENOS peça prometida), duas queries no total em vez de duas por loja.
   * Com 14 lojas e a lista abrindo no meio da venda, 28 idas ao banco pra
   * responder uma pergunta de tela não se justificam.
   */
  private async disponivelPorLoja(
    pecas: any[],
    storeCodes: string[],
  ): Promise<{ porSku: Map<string, number>; porLoja: Map<string, Map<string, number>> }> {
    const porSku = new Map<string, number>();
    const skusCrus = new Set<string>();
    for (const it of pecas) {
      const sku = this.semZeros(it.sku);
      porSku.set(sku, (porSku.get(sku) || 0) + Number(it.qty || 1));
      const cru = String(it.sku ?? '').trim();
      if (cru) skusCrus.add(cru);
      if (sku) skusCrus.add(sku);
    }

    const porLoja = new Map<string, Map<string, number>>();
    for (const c of storeCodes) porLoja.set(this.semZeros(c), new Map());

    const est: any[] = await (this.prisma as any).wincredEstoque.findMany({
      where: { codigo: { in: [...porSku.keys()] } },
      select: { codigo: true, loja: true, estoque: true },
    });
    for (const r of est) {
      const alvo = porLoja.get(this.semZeros(r.loja));
      if (!alvo) continue;
      const c = this.semZeros(r.codigo);
      alvo.set(c, (alvo.get(c) || 0) + (Number(r.estoque) || 0));
    }

    // Falha aqui NÃO trava a tela: sem o comprometido a conta volta a ser a
    // do espelho cheio, que é o comportamento conhecido.
    const comprometido = await this.routing
      .getCommittedStock([...skusCrus], storeCodes)
      .catch((e: any) => {
        this.logger.warn(
          `[pedido-online] comprometido das lojas falhou (${e?.message || e}) — segue com estoque cheio`,
        );
        return new Map<string, number>();
      });
    for (const [chave, qtd] of comprometido) {
      const [lojaCru, skuCru] = chave.split('::');
      const alvo = porLoja.get(this.semZeros(lojaCru));
      const sku = this.semZeros(skuCru ?? '');
      if (!alvo || !sku || !alvo.has(sku)) continue;
      alvo.set(sku, Math.max(0, (alvo.get(sku) || 0) - qtd));
    }

    return { porSku, porLoja };
  }

  /**
   * O que a loja TEM DE VERDADE pras peças desta venda: espelho
   * `wincred_estoque` MENOS as peças já prometidas a cards de separação
   * abertos nela.
   *
   * PEÇA PROMETIDA NÃO É PEÇA DISPONÍVEL (22/08, ordem do dono). O estoque só
   * desce quando a vendedora BIPA — até lá o espelho conta a peça que já tem
   * dono, e sem descontar aqui o auto-atende abre um SEGUNDO card pra mesma
   * peça (e o motoboy sai prometendo peça de outro pedido). Mesma conta do
   * roteamento (`RoutingService.getCommittedStock`), pra que a decisão de
   * quem separa não dependa de qual porta o pedido entrou.
   *
   * @returns `porSku` = o que a venda pede · `disponivel` = o que sobra (líquido).
   */
  private async disponivelNaLoja(
    pecas: any[],
    storeCode: string,
  ): Promise<{ porSku: Map<string, number>; disponivel: Map<string, number> }> {
    const porSku = new Map<string, number>();
    // O `sku` do OrderItem é o do PDV, cru; o espelho normaliza sem zeros à
    // esquerda. Manda as duas formas pro comprometido e casa na volta.
    const skusCrus = new Set<string>();
    for (const it of pecas) {
      const sku = this.semZeros(it.sku);
      porSku.set(sku, (porSku.get(sku) || 0) + Number(it.qty || 1));
      const cru = String(it.sku ?? '').trim();
      if (cru) skusCrus.add(cru);
      if (sku) skusCrus.add(sku);
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

    // Falha aqui NÃO trava a venda: sem o comprometido a conta volta a ser a
    // de antes (estoque cheio), que é o comportamento conhecido.
    const comprometido = await this.routing
      .getCommittedStock([...skusCrus], [String(storeCode ?? '').trim()])
      .catch((e: any) => {
        this.logger.warn(
          `[pedido-online] comprometido da loja ${storeCode} falhou (${e?.message || e}) — segue com estoque cheio`,
        );
        return new Map<string, number>();
      });
    for (const [chave, qtd] of comprometido) {
      const sku = this.semZeros(chave.split('::')[1] ?? '');
      if (!sku || !disponivel.has(sku)) continue;
      disponivel.set(sku, Math.max(0, (disponivel.get(sku) || 0) - qtd));
    }

    return { porSku, disponivel };
  }

  /** SKUs (com quantidade) que a loja NÃO cobre. Vazio = tem tudo. */
  private async faltamNaLoja(pecas: any[], storeCode: string): Promise<string[]> {
    const { porSku, disponivel } = await this.disponivelNaLoja(pecas, storeCode);
    const faltam: string[] = [];
    for (const [sku, qtd] of porSku) {
      const tem = disponivel.get(sku) || 0;
      if (tem < qtd) faltam.push(qtd > 1 ? `${sku} (tem ${tem} de ${qtd})` : sku);
    }
    return faltam;
  }

  /** A loja vendedora tem TODAS as peças da venda? (espelho − prometido) */
  private async lojaTemTudo(pecas: any[], storeCode: string): Promise<boolean> {
    const { porSku, disponivel } = await this.disponivelNaLoja(pecas, storeCode);
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
          // QUANDO A CAIXA SAIU — aqui o "despacho" é a peça indo na mão da
          // cliente. Ver `common/janela-rastreio.ts`.
          shippedAt: new Date(),
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
    /** Retirada/motoboy em OUTRA loja: o card já nasceu nela (com transferências, se faltar peça). */
    lojaEscolhida: { code: string; name: string } | null;
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

      /**
       * LOJA QUE ATENDE (17/08) — `PdvSale.entregaStoreCode`. Só existe pra
       * RETIRADA (onde a cliente busca) e MOTOBOY (quem sai de moto); null =
       * a própria vendedora. Quando é OUTRA loja, o pedido não passa por
       * auto-atende nem por matriz: nasce travado nela (`pickupStoreCode`),
       * a engine manda o que ela não tem por transferência e ela recebe o
       * card na hora. Caso ON-000006: a loja-canal 13 vendeu 11 peças pra
       * cliente de São José dos Campos retirar lá — e o pedido nasceu
       * "Entrega (não informada)", sem SJC em lugar nenhum.
       */
      const lojaQueAtende: any =
        sale.entregaStoreCode && sale.entregaStoreCode !== store.code
          ? await (this.prisma as any).store
              .findFirst({ where: { code: sale.entregaStoreCode, active: true } })
              .catch(() => null)
          : null;
      if (sale.entregaStoreCode && sale.entregaStoreCode !== store.code && !lojaQueAtende) {
        this.logger.warn(
          `[pedido-online] venda ${sale.id}: loja que atende ${sale.entregaStoreCode} não achada/inativa — segue como se fosse a vendedora`,
        );
      }
      const lojaEntrega = lojaQueAtende ?? store;

      // RETIRADA EM LOJA não tem entrega — a cliente busca no balcão. Exigir
      // CEP dela derrubaria o pedido pro fluxo legado (sem card, sem trilho)
      // justamente no caso mais simples.
      const entrega = this.entrega(sale.entregaTipo, lojaEntrega.name);
      if (!entrega.pickup && !this.digits(sale.customerCep)) {
        this.logger.warn(`[pedido-online] venda ${sale.id} SEM CEP — não vira Order (baixa local, fluxo legado)`);
        return null;
      }

      // Trava de roteamento: retirada E motoboy travam na loja que atende
      // (a engine trata os dois como "pickup" — a loja fica com o card e o
      // resto chega por transferência). `isPickup` continua só pra retirada:
      // é o que decide banner/etiqueta/"cliente retirou" no card.
      const travaNaLoja = entrega.pickup || entrega.kind === 'motoboy';
      const outraLojaAtende = !!lojaQueAtende;

      // Auto-atende só quando é a PRÓPRIA vendedora que atende. Se outra loja
      // foi escolhida, checar o estoque da vendedora não diz nada.
      const autoAtende = outraLojaAtende
        ? false
        : await this.lojaTemTudo(pecas, store.code).catch(() => false);

      /**
       * CARRINHO DE ORIGEM (17/08) — a venda nasceu de "Importar carrinho pro
       * PDV"? Então o carrinho abandonado é o ÚNICO lugar onde a campanha
       * existe: `utm*` e `trackingInfo` (fbp/fbc) são gravados no checkout do
       * site e a venda do PDV nasce sem nada disso.
       *
       * Sem carregar aqui, a mesma cliente conta duas vezes errado: ABANDONO
       * no funil (o carrinho nunca sai da lista) e RECEITA SEM ORIGEM no ROAS.
       * Medido em 30 dias: R$ 2.133,89 de venda recuperada sem campanha.
       */
      let carrinho: any = sale.carrinhoOrderId
        ? await (this.prisma as any).order
            .findUnique({
              where: { id: sale.carrinhoOrderId },
              select: {
                id: true, wcOrderNumber: true, paidAt: true,
                utmSource: true, utmMedium: true, utmCampaign: true,
                utmId: true, utmContent: true, trackingInfo: true,
              },
            })
            .catch(() => null)
        : null;

      /**
       * MESMA HISTÓRIA, OUTRA TABELA (18/08): a venda nasceu de um CONTATO
       * capturado no checkout (`CheckoutRecovery`), que nunca virou pedido —
       * é metade do abandono do site. A campanha existe ali, em
       * `attribution`, e sem copiar daqui a venda recuperada nasce sem origem
       * exatamente como nascia antes do bloco acima.
       *
       * `trackingInfo` fica null: a captura não guarda fbp/fbc, então o
       * Purchase pro Meta CAPI vai sem os cookies do navegador. A campanha
       * (utm) é o que dá pra recuperar, e é o que a cascata de ROAS usa.
       */
      if (!carrinho && (sale as any).carrinhoRecoveryId) {
        const captura: any = await (this.prisma as any).checkoutRecovery
          .findUnique({
            where: { id: (sale as any).carrinhoRecoveryId },
            select: { attribution: true },
          })
          .catch(() => null);
        const at: any = captura?.attribution || null;
        if (at) {
          carrinho = {
            // Sem `id`/`paidAt` de propósito — não é um `Order`. É o que o if
            // lá embaixo usa pra NÃO tentar marcar pedido que não existe.
            id: null,
            paidAt: null,
            utmSource: at.utm_source ?? at.source ?? null,
            utmMedium: at.utm_medium ?? at.medium ?? null,
            utmCampaign: at.utm_campaign ?? at.campaign ?? null,
            utmId: at.utm_id ?? at.id ?? null,
            utmContent: at.utm_content ?? at.content ?? null,
            trackingInfo: null,
          };
        }
      }

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
       * ⚠️ SÓ MOTOBOY — a régua NÃO é "a loja tem a peça", é "a peça precisa
       * ser POSTADA". A primeira versão deste fix usava `!entrega.pickup` e
       * quebrou SEDEX/PAC em produção: os botões "Gerar envio Correios",
       * "Etiqueta + NF" e "Já postei" vivem DENTRO do card
       * (`frontend/src/app/minha-loja/page.tsx`). Sem card, a loja não emite
       * pré-postagem, a peça fica na arara e o pedido diz "enviado" — a cliente
       * pagou e não recebe nada, em silêncio.
       *
       * Então o pedido nasce fechado só quando NÃO sobra artefato do sistema
       * pra ninguém:
       *   - MOTOBOY  → sai da mão da vendedora. Sem etiqueta, sem rastreio.
       *   - SEDEX/PAC → card na própria loja: o card É a ferramenta de postar.
       *   - RETIRADA  → card na própria loja: separar e guardar pro balcão é
       *                 tarefa real, e o `routePickup` já dá prioridade total à
       *                 loja da retirada.
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
              // que a loja escolheu. `pickupStoreCode` é a TRAVA da engine
              // (retirada E motoboy travam na loja que atende); `isPickup`
              // é só retirada — decide banner, "cliente retirou" e nada de
              // etiqueta.
              shippingMethod: entrega.label,
              isPickup: entrega.pickup,
              pickupStoreCode: travaNaLoja ? lojaEntrega.code : null,
              wcDateCreated: new Date(),
              // ATRIBUIÇÃO DO CARRINHO RECUPERADO: a campanha só existe no
              // carrinho. Copiada aqui, o ROAS em cascata e o funil que já
              // existem passam a contar esta venda sem relatório novo.
              // `trackingInfo` traz fbp/fbc — é o que permite mandar o
              // Purchase pro Meta CAPI com a atribuição certa depois.
              utmSource: carrinho?.utmSource ?? null,
              utmMedium: carrinho?.utmMedium ?? null,
              utmCampaign: carrinho?.utmCampaign ?? null,
              utmId: carrinho?.utmId ?? null,
              utmContent: carrinho?.utmContent ?? null,
              trackingInfo: carrinho?.trackingInfo ?? null,
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

      /**
       * ENTREGA TRAVADA NUMA LOJA (retirada/motoboy) → card NELA agora, sem
       * esperar a matriz. A engine com `pickupStoreCode` é determinística
       * (REGRA 0): trava na loja escolhida, e o que ela não tem vira card de
       * transferência nas lojas que têm, apontando pra ela. Não há decisão
       * humana a tomar aqui — passar pela matriz seria só um atraso (o
       * ON-000006 ficou 2 dias esperando alguém rotear na mão). Se nem a rede
       * cobre (`pickup-blocked`), o confirmRoute deixa em `awaiting_stock` e
       * aí sim a matriz olha.
       *
       * `travaNaLoja` e não `outraLojaAtende` (26/08): com a Regra A fora, a
       * PRÓPRIA vendedora pode escolher motoboy sem ter a peça — e esse caso
       * caía em `processing`, parado na matriz, esperando um roteamento que
       * a engine já sabe fazer sozinha. Quando é a vendedora E ela tem tudo,
       * `fechaNaLoja`/`autoAtende` já resolveram antes e este bloco nem roda.
       */
      let lojaEscolhidaOk = false;
      if (!fechadoNaLoja && !autoOk && travaNaLoja) {
        try {
          const preview: any = await this.routing.previewRoute(order.id);
          const r = await this.routing.confirmRoute(order.id, preview as RoutingResult);
          lojaEscolhidaOk = !!(r as any)?.persisted;
          if (!lojaEscolhidaOk) {
            this.logger.warn(
              `[pedido-online] ${order.wcOrderNumber}: roteamento pra ${lojaEntrega.name} não persistiu ` +
                `(${preview?.strategy || 'sem estratégia'}) — fica pra matriz`,
            );
          }
        } catch (e: any) {
          this.logger.warn(
            `[pedido-online] ${order.wcOrderNumber}: roteamento pra ${lojaEntrega.name} falhou (${e?.message || e}) — fica pra matriz`,
          );
        }
      }

      /**
       * CARRINHO SAI DO ABANDONO (17/08). O relatório de abandonados é
       * `Order` com `source: 'ecommerce'` e `paidAt: null` — então enquanto o
       * carrinho não é marcado, a MESMA cliente aparece como perda no funil e
       * como venda no faturamento. Duplo desconto na leitura, e o time ainda
       * corre atrás de quem já comprou.
       *
       * Marca `paidAt` (vira "recovered" na régua do `listEcommercePending`) e
       * deixa o rastro dos dois lados no histórico. `cancelled` não serve: o
       * carrinho não foi perdido, foi ganho por outro caminho.
       *
       * ⚠️ `carrinho.id` no if, não `carrinho`: o objeto pode ser o da CAPTURA
       * do checkout (só atribuição, sem `Order` nenhum por trás). Esse sai do
       * abandono na `checkout_recoveries` — quem marca é o `finalize`.
       */
      if (carrinho?.id && !carrinho.paidAt) {
        try {
          await (this.prisma as any).order.update({
            where: { id: carrinho.id },
            data: { status: 'cancelled', paidAt: new Date() },
          });
          await (this.prisma as any).orderHistory
            .create({
              data: {
                orderId: carrinho.id,
                toStatus: 'cancelled',
                note:
                  `Carrinho RECUPERADO: fechado no PDV pela ${store.name} como ` +
                  `${order.wcOrderNumber}. Sai do relatório de abandono — a venda ` +
                  `existe, só entrou por outro caminho.`,
              },
            })
            .catch(() => null);
          this.logger.log(
            `[carrinho-recuperado] ${carrinho.wcOrderNumber} → ${order.wcOrderNumber}` +
              `${carrinho.utmCampaign ? ` (campanha: ${carrinho.utmCampaign})` : ' (sem campanha no carrinho)'}`,
          );
        } catch (e: any) {
          this.logger.warn(
            `[carrinho-recuperado] falha ao marcar ${carrinho.wcOrderNumber}: ${e?.message || e}`,
          );
        }
      }

      // CONFIRMAÇÃO PRA CLIENTE (14/08) — a venda online nasceu muda. A
      // vendedora já falou com ela no WhatsApp, mas ninguém mandava o número
      // do pedido nem o registro do que foi comprado. Fire-and-forget e sem
      // e-mail no cadastro simplesmente não sai (o `destinatario` filtra).
      //
      // ⚠️ "O pedido já nasce PAGO" era MENTIRA em parte dos casos (20/08,
      // ON-000049): "PIX recebido" e "Link externo" finalizam no braço, sem
      // gateway nenhum conferindo — a vendedora fechou, a cliente recebeu
      // "Recebemos o seu pagamento" às 17:26 e respondeu "Nao paguei ainda"
      // às 17:27. Então a mensagem de PAGAMENTO CONFIRMADO só sai quando um
      // gateway PAGO lastreia a venda (Link Pagar.me / PIX gerado PagBank);
      // sem prova, sai o registro do pedido SEM afirmar pagamento.
      void vendaOnlineTemProva(this.prisma, sale.id)
        .then((temProva) => {
          if (temProva) {
            return this.pedidoEmail.aoConfirmarPagamento({ ...order, items: order.items ?? [] });
          }
          this.logger.warn(
            `[pedido-online] ${order.wcOrderNumber}: venda ${sale.id} finalizada SEM prova de ` +
              `pagamento no gateway (PIX recebido/Link externo) — aviso "pagamento confirmado" ` +
              `retido; enviado registro neutro do pedido.`,
          );
          return this.pedidoEmail.aoRegistrarPedidoOnlineSemProva({ ...order, items: order.items ?? [] });
        })
        .catch((e: any) => this.logger.warn(`[pedido-online] aviso ao cliente falhou: ${e?.message || e}`));

      const destino = fechadoNaLoja
        ? `FECHADO na ${store.name} (estoque baixado lá, sem separação)`
        : autoOk
          ? `AUTO-ATENDE na ${store.name}`
          : lojaEscolhidaOk
            ? `card na ${lojaEntrega.name} (loja escolhida, ${entrega.pickup ? 'retirada' : 'motoboy'})`
            : 'fila de roteamento';
      this.logger.log(`[pedido-online] venda ${sale.id} → pedido ${order.wcOrderNumber} (${destino})`);
      return {
        wcOrderNumber: order.wcOrderNumber,
        autoAtendida: autoOk,
        fechadoNaLoja,
        lojaEscolhida: lojaEscolhidaOk ? { code: lojaEntrega.code, name: lojaEntrega.name } : null,
        storeName: store.name,
      };
    } catch (e: any) {
      this.logger.error(`[pedido-online] venda ${sale?.id}: ${e?.message || e} — fluxo legado (baixa local)`);
      return null;
    }
  }

  // A régua de "prova de pagamento" mora em common/prova-pagamento.ts —
  // compartilhada com a trava de separação (confirmRoute) e a tela
  // Conferência de Vendas, pra nunca divergirem.
}
