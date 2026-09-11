import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { StockService } from '../stock/stock.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { PromoSiteService } from '../promo-site/promo-site.service';
import { RoutingService } from '../routing/routing.service';
import { ehItemSemEstoque } from '../common/item-sem-estoque';
import { conferirDiferencaNoGateway, diferencaDeTrocaPendente } from '../common/diferenca-troca';
import {
  CARD_ATIVO,
  CARD_ENVIADO,
  CARD_SEPARADO,
  avisoDaTroca,
  bloqueioDaTroca,
  cardDaPeca,
  type TrocaCtx,
} from '../common/troca-bloqueio';
import { motivoDeRecusaDoDestrave, notaDoDestrave, podeDestravar } from '../common/destrave-matriz';
import { LOJA_CANAL_CODES } from '../common/loja-canal';

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
 *  QUANDO PODE: até a peça SAIR (26/08). Separada ou bipada não trava — o
 *  fluxo cancela o card, estorna o bipe e re-roteia sozinho. O que trava é o
 *  ponto sem volta: card postado, caixa da juntada lacrada, NF-e autorizada.
 *
 *  E DEPOIS DISSO? A MATRIZ DESTRAVA (10/09 — LP-001312). Nenhuma dessas
 *  travas é mais o fim da linha: com motivo escrito, a matriz troca a peça
 *  assim mesmo e a história do pedido guarda o que a trava dizia e por que
 *  foi aberta (`common/destrave-matriz.ts`). Existe porque o "não" custava
 *  caro na vida real: a loja carimbava o rastreio no card, a peça continuava
 *  na arara, e o sistema mandava a matriz pro portal de devolução de uma
 *  peça que nunca viajou.
 *
 *  ⚠️ A régua é POR PEÇA, não por pedido (`common/troca-bloqueio.ts`): pedido
 *  dividido é o normal da casa, e a loja que já postou a peça DELA não fala
 *  pela peça que continua parada no card de outra.
 *
 *  O VALOR É SUGERIDO, NÃO IMPOSTO: o preview calcula a diferença pela régua
 *  do site (preço da loja, com a promoção de 50% quando elegível — 26/08),
 *  mas quem confirma o número é a matriz — ela é quem negociou com a cliente,
 *  e cortesia/arredondamento existe todo dia.
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

  async preview(
    wcOrderId: number,
    orderItemId: string,
    codigo: string,
    /** Quem está olhando — decide se a tela oferece a CHAVE da matriz. */
    ator?: { role?: string | null },
  ) {
    const { order, item } = await this.carregar(wcOrderId, orderItemId);
    const ctx = await this.contextoDaTroca(order, item);
    const trava = bloqueioDaTroca(ctx);
    const bloqueio = trava?.motivo ?? null;
    // Peça separada/bipada NÃO trava mais (ordem do dono 26/08) — mas a
    // matriz confirma sabendo que a troca desfaz a separação da loja.
    const aviso = bloqueio ? null : avisoDaTroca(ctx);

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
      // Sem a loja-canal: ela não cede peça (dono, 24/08 — `common/loja-canal.ts`),
      // e trocar por peça que "só existe" nela é ruptura marcada pra depois.
      const lojas = await this.prisma.store.findMany({
        where: { active: true, code: { notIn: LOJA_CANAL_CODES } },
        select: { code: true },
      });
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
      /**
       * A CHAVE DA MATRIZ (10/09, LP-001312). Trava deixou de ser fim de
       * linha: existindo uma, a tela mostra o que custa abrir
       * (`consequenciaDoForcar`) e — só pra matriz — o campo de motivo que
       * libera o `forcar`.
       */
      podeForcar: !!trava && podeDestravar(ator?.role),
      consequenciaDoForcar: trava?.consequencia ?? null,
      aviso,
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
      /** A CHAVE DA MATRIZ (10/09): troca mesmo com a trava fechada. */
      forcar?: boolean;
      /** Por que destravou — obrigatório junto do `forcar`. */
      motivoDestrave?: string;
    },
    userId?: string | null,
    /** Quem clicou. `role` é o que autoriza a chave; `nome` fica na história. */
    ator?: { role?: string | null; nome?: string | null },
  ) {
    const { order, item } = await this.carregar(wcOrderId, input.orderItemId);

    /**
     * A TRAVA E A CHAVE (10/09/2026 — LP-001312).
     *
     * A cliente pediu outro TAMANHO e a loja já tinha carimbado o rastreio no
     * card: daqui pra baixo tudo respondia "a troca agora é pelo portal de
     * trocas/devolução", que trata peça que VIAJOU. A peça não tinha viajado.
     *
     * A trava fica (cada uma tem incidente com nome). O que passou a existir
     * é a chave da matriz: destrava com motivo escrito, e o histórico do
     * pedido guarda o que a trava dizia e por que foi aberta.
     */
    const trava = bloqueioDaTroca(await this.contextoDaTroca(order, item));
    const destravou = !!trava && !!input.forcar;
    if (trava && !input.forcar) {
      throw new BadRequestException(
        `${trava.motivo} Se a peça ainda está na loja, a matriz destrava nesta mesma tela — com o motivo escrito.`,
      );
    }
    if (destravou) {
      const recusa = motivoDeRecusaDoDestrave({ role: ator?.role, motivo: input.motivoDestrave });
      if (recusa) throw new BadRequestException(recusa);
    }

    /**
     * Pedido dividido com irmão JÁ ENVIADO: o card desta peça é o único que
     * ainda dá pra mexer. Decidido aqui, antes da transação, porque muda o
     * que ela faz com o `assignedStoreId` — o re-roteamento cirúrgico acha a
     * peça POR ELE.
     */
    const cardDoItem = cardDaPeca((order.pickOrders || []) as any[], item as any);
    const temIrmaoAvancado = ((order.pickOrders || []) as any[]).some(
      (c: any) => !CARD_ATIVO.includes(String(c.status)),
    );
    /**
     * Cirúrgico também quando o card DA PEÇA está `separated`/`ready` (26/08):
     * a troca liberada de peça separada precisa desfazer SÓ o card dela —
     * `swapSinglePickOrder` cancela o card, estorna o bipe e re-roteia os
     * itens dele. O `recalculateForWc` não serve aqui: ou recusa (card
     * avançado no pedido) ou nem roda (nenhum card `new`/`separating`), e a
     * vendedora ficaria com a peça velha embalada e um card mentindo.
     */
    const cirurgico =
      !!cardDoItem &&
      (CARD_SEPARADO.includes(String(cardDoItem.status)) ||
        /**
         * DESTRAVE DE CARD POSTADO (10/09): só o caminho cirúrgico serve — o
         * `recalculateForWc` recusaria o pedido inteiro por causa do card
         * avançado e a peça ficaria sem card nenhum (a família do "pedido pago
         * sem card", invisível em toda tela). O estorno sai ANTES da reescrita
         * do SKU (`estornarCardDaTroca`, mais abaixo).
         *
         * Só `shipped` (11/09). Card `delivered` fica FORA: a peça está com a
         * cliente, não volta pro estoque agora, e apagar o card entregue
         * apagaria a prova da entrega. A peça nova vira separação nova pelo
         * `recalculateForWc`, que avisa se não conseguir.
         */
        (destravou && String(cardDoItem.status) === 'shipped') ||
        (temIrmaoAvancado && CARD_ATIVO.includes(String(cardDoItem.status))));

    /**
     * A loja do card continua na disputa quando a peça está FISICAMENTE com
     * ela (11/09 — LP-001312): card separado, ou postado por engano e aberto
     * pela chave. As outras peças do card estão na arara dela, e tirar a loja
     * da disputa mandava OUTRA loja separar o que ela já tem na mão. Card
     * ainda aberto com irmão avançado (26/08) segue a regra antiga. (Card
     * `delivered` nunca chega aqui — ver `cirurgico`.)
     */
    const manterLojaDeOrigem =
      cirurgico &&
      (CARD_SEPARADO.includes(String(cardDoItem!.status)) ||
        CARD_ENVIADO.includes(String(cardDoItem!.status)));

    /**
     * PEDIDO FECHADO QUE VOLTA PRO TRILHO. Com a chave usada num pedido
     * `shipped`/`delivered`/`cancelled`, reabrir o STATUS não é opcional: o
     * `confirmRoute` recusa gerar separação pra pedido concluído (trava dos 22
     * relançados de 24/08), e sem card a peça nova não aparece pra ninguém
     * separar. Reabre aqui, dentro da mesma transação da troca, e a história
     * do pedido registra que foi de propósito.
     *
     * Sem chave também, quando o pedido está `shipped` e NENHUMA outra caixa
     * está na rua (11/09 — LP-001312). É o caminho que a trava da NF-e
     * recomenda: "⇄ Status" tira o card do `shipped`, a nota é cancelada e a
     * troca nem trava — mas o PEDIDO continua `shipped`, e o `confirmRoute`
     * recusaria a separação nova DEPOIS de o card velho ser apagado (peça sem
     * card). Pedido dividido com outra caixa de verdade na rua fica como está:
     * ali o `shipped` é verdade. E pedido sem card nenhum também: sem card da
     * peça não há prova de que o `shipped` é que está velho.
     */
    const outraCaixaNaRua = ((order.pickOrders || []) as any[]).some(
      (c: any) => c.id !== cardDoItem?.id && CARD_ENVIADO.includes(String(c.status)),
    );
    const reabrirPedido =
      (destravou && ['shipped', 'delivered', 'cancelled'].includes(String(order.status))) ||
      (!!cardDoItem && String(order.status) === 'shipped' && !outraCaixaNaRua);

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

    /**
     * 🔴 O ESTORNO VEM ANTES DE REESCREVER O SKU (11/09/2026 — LP-001312).
     *
     * O `OrderItem` é reescrito in-place logo abaixo, e os estornos do card
     * leem o SKU DELE: o `revertPickOrderStock` de card finalizado (o
     * `debitApprovedAt` nasce no finish) devolve "o esperado" pelos itens
     * atribuídos, e o `swapSinglePickOrder` de card postado devolve pelos
     * mesmos itens. Rodando DEPOIS da transação — como rodava desde 26/08 —
     * os dois devolviam a peça NOVA pra loja de origem: peça fantasma na
     * Consulta e no site (uma SMILE 52 que Piracicaba nunca teve) e a peça
     * velha, que está na arara, sumida do estoque.
     *
     * Aqui o item ainda é o velho, então quem volta pro estoque é a peça que
     * de fato saiu. O `swapSinglePickOrder`, mais abaixo, encontra os bipes já
     * estornados e o carimbo da baixa limpo — e não devolve nada de novo.
     */
    if (cirurgico) {
      await this.routing.estornarCardDaTroca(cardDoItem!.id, {
        desfazerEnvio: destravou,
        motivo: input.motivoDestrave ?? null,
        userId: userId ?? null,
        nome: ator?.nome ?? null,
      });
    }

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
          // re-roteamento logo abaixo. No caminho cirúrgico o vínculo FICA:
          // é por ele que o `swapSinglePickOrder` acha a peça pra re-rotear.
          assignedStoreId: cirurgico ? undefined : null,
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

      if (reabrirPedido) {
        await tx.order.update({ where: { id: order.id }, data: { status: 'separating' } });
        await tx.orderHistory.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: 'separating',
            note:
              `Pedido REABERTO pela matriz pra trocar a peça (estava "${order.status}")` +
              (ator?.nome ? ` · por ${ator.nome}` : '') +
              `. Sem reabrir, o card novo não nasce e a peça fica invisível pra separação.`,
          },
        });
      }

      await tx.orderHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: reabrirPedido ? 'separating' : order.status,
          note:
            (destravou ? notaDoDestrave(trava!.motivo, input.motivoDestrave!, ator?.nome) + ' · ' : '') +
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

    /**
     * O DESTRAVE TAMBÉM VIRA LINHA DE AUDITORIA. A história do pedido é o que
     * a operação lê; o `integration_log` é o que a matriz consegue VARRER
     * depois ("quantas travas a gente abriu esse mês, e por quê").
     */
    if (destravou) {
      await this.prisma.integrationLog
        .create({
          data: {
            source: 'troca-peca',
            direction: 'internal',
            event: 'troca.destravada',
            payload: JSON.stringify({
              wcOrderNumber: order.wcOrderNumber ?? null,
              orderId: order.id,
              orderItemId: item.id,
              trava: trava!.motivo,
              consequencia: trava!.consequencia,
              motivo: input.motivoDestrave,
              porUserId: userId ?? null,
              porNome: ator?.nome ?? null,
              oldSku: item.sku,
              newSku: novo.sku,
              pedidoReaberto: reabrirPedido,
              statusAnterior: order.status,
            }),
            status: 200,
          },
        })
        .catch(() => null);
      this.logger.warn(
        `[troca-peca] ${order.wcOrderNumber}: TRAVA DESTRAVADA pela matriz (${ator?.nome ?? userId ?? '—'}) — ` +
          `"${trava!.motivo}" · motivo: ${input.motivoDestrave}`,
      );
    }

    // ── O acerto do dinheiro (fora da transação: fala com gateway) ──
    let cobranca: any = null;
    let vale: any = null;
    if (tipo === 'cobranca') {
      cobranca = await this.gerarCobranca(order, swap.id, Math.abs(diff)).catch((e: any) => {
        this.logger.error(`[troca-peca] link da diferença falhou (swap ${swap.id}): ${e?.message || e}`);
        return { erro: String(e?.message || e).slice(0, 300) };
      });
    } else if (tipo === 'vale') {
      vale = await this.gerarVale(order, swap.id, Math.abs(diff)).catch(async (e: any) => {
        const erro = String(e?.message || e).slice(0, 300);
        this.logger.error(`[troca-peca] vale falhou (swap ${swap.id}): ${erro}`);
        /**
         * Vale que não saiu é DÍVIDA COM A CLIENTE, não acerto fechado. O
         * swap nasce `settled` (vale não trava separação — o dinheiro é
         * nosso), mas sem `cupomCode` ele mentiria "pago" na tela. Registra
         * a falha no motivo pra virar pendência visível na retaguarda.
         */
        await (this.prisma as any).orderItemSwap
          .update({
            where: { id: swap.id },
            data: { motivo: [swap.motivo, `VALE NÃO EMITIDO: ${erro}`].filter(Boolean).join(' · ').slice(0, 300) },
          })
          .catch(() => null);
        await this.prisma.orderHistory
          .create({
            data: {
              orderId: order.id,
              note: `⚠️ Vale de R$ ${Math.abs(diff).toFixed(2)} NÃO emitido: ${erro} — cliente ainda tem esse valor a receber.`,
            },
          })
          .catch(() => null);
        return { erro };
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
    try {
      if (cirurgico) {
        /**
         * PEDIDO DIVIDIDO: o `recalculateForWc` se recusa a mexer num pedido
         * que tem card avançado — e faz bem, a peça da outra loja está no
         * correio. Sem esta saída a peça nova ficava sem loja e o card antigo
         * VAZIO na fila da loja (alarme falso na fila que a casa promete não
         * dar).
         *
         * O `swapSinglePickOrder` cancela SÓ o card desta peça e roteia só os
         * itens dele — o estorno já saiu ANTES da reescrita do SKU
         * (`estornarCardDaTroca`). Tirar a loja de origem da disputa era o
         * padrão de 26/08 ("dela a matriz acabou de trocar a peça, em geral
         * porque ela não tinha"); desde 11/09 ela FICA quando a peça está
         * fisicamente com ela — ver `manterLojaDeOrigem`.
         */
        reroteado = await this.routing.swapSinglePickOrder(cardDoItem!.id, {
          manterLojaDeOrigem,
          // Só o nome: o `userId` do token não passou pela conferência da FK,
          // e a história do swap roda numa transação que um id inválido
          // derrubaria inteira.
          ator: { userId: null, nome: ator?.nome ?? null },
        });
      } else {
        const tinhaCards = await this.prisma.pickOrder.count({
          where: { orderId: order.id, status: { in: ['new', 'separating'] } },
        });
        /**
         * Com a chave usada, TENTA mesmo sem card ativo (10/09). O caso é a
         * peça sem `assignedStoreId` num pedido de várias lojas: ninguém
         * responde por ela, o caminho cirúrgico não serve, e sem esta
         * tentativa ela ficaria trocada e sem card — invisível em toda tela.
         */
        if (tinhaCards > 0 || destravou) reroteado = await this.routing.recalculateForWc(order.id);
      }
    } catch (e: any) {
      reroteado = { ok: false, motivo: String(e?.message || e).slice(0, 300) };
      this.logger.log(
        `[troca-peca] ${order.wcOrderNumber}: cards cancelados e separação NÃO recriada — ${reroteado.motivo}`,
      );
    }

    /**
     * A PEÇA FICOU COM LOJA? (10/09). Re-roteamento que não aconteceu era
     * silêncio: a troca dava certo, o card não nascia e a peça nova sumia de
     * todas as filas. Com `cobranca` a recusa é ESPERADA (a separação fica
     * travada até a cliente pagar, e a tela já diz isso) — fora daí, quem
     * trocou precisa saber que falta um passo.
     */
    let avisoDaSeparacao: string | null = null;
    if (tipo !== 'cobranca') {
      if (reroteado && reroteado.ok === false) {
        avisoDaSeparacao =
          `A peça trocou, mas a separação NÃO foi refeita: ` +
          `${reroteado.message ?? reroteado.motivo ?? 'motivo não informado'} ` +
          `Use "Recalcular separação" ou escolha a loja na mão — sem card, a peça nova não aparece pra ninguém separar.`;
      } else if (destravou && !reroteado) {
        avisoDaSeparacao =
          'A peça trocou e nenhum card foi refeito. Confira no pedido se a peça nova ficou com loja — ' +
          'sem card ela não aparece pra separar.';
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
      /** A tela precisa dizer o que ela mesma acabou de abrir. */
      destravado: destravou ? trava!.motivo : null,
      pedidoReaberto: reabrirPedido,
      /** Falta alguém separar a peça nova? — silêncio aqui vira peça sumida. */
      avisoDaSeparacao,
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
      include: {
        pickOrders: {
          // storeId/store: a trava é POR PEÇA e precisa saber QUAL card está
          // com ela (`common/troca-bloqueio.ts`).
          select: {
            id: true,
            status: true,
            storeId: true,
            store: { select: { code: true, name: true } },
          },
        },
      },
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
   * Tudo que a régua (`common/troca-bloqueio`) precisa saber DESTA peça.
   * Montado uma vez e usado pro bloqueio E pro aviso do preview.
   */
  private async contextoDaTroca(order: any, item: any): Promise<TrocaCtx> {
    const card = cardDaPeca((order.pickOrders || []) as any[], item);

    /**
     * Bipes DESTA peça, separados em dois destinos. O scan congela o SKU (o
     * swap reescreve o do item) e o `pickOrderId` diz de qual card ele é:
     * - bipe do card VIVO e aberto → só AVISO (a troca estorna sozinha);
     * - bipe de card POSTADO ou APAGADO sem estorno → prova de que a peça
     *   saiu (é a evidência que sobra quando o card morre — ON-000106), e aí
     *   trava: o que já saiu se resolve por devolução.
     */
    let bipesDaPeca = 0;
    let bipesEnviados = 0;
    try {
      const scans: Array<{ pickOrderId: string }> = await (this.prisma as any).pickOrderScan.findMany({
        where: { orderId: order.id, sku: String(item.sku || ''), revertedAt: null },
        select: { pickOrderId: true },
      });
      const statusPorCard = new Map(
        ((order.pickOrders || []) as any[]).map((c: any) => [c.id, String(c.status)]),
      );
      for (const s of scans) {
        const st = statusPorCard.get(s.pickOrderId);
        if (!st || st === 'shipped' || st === 'delivered') bipesEnviados += 1;
        else if (!card || s.pickOrderId === card.id) bipesDaPeca += 1;
      }
    } catch {
      /* sem os bipes a régua decide pelo resto */
    }

    // Nota do envio DESTE card — a nota da outra loja lista as peças dela.
    const notaAutorizada = card
      ? await (this.prisma as any).nfeDoc
          .findFirst({
            where: { shipmentId: `envio:${card.id}`, status: 'authorized' },
            select: { numero: true },
          })
          .catch(() => null)
      : null;

    // Caixa de juntada nascida deste card (feeder) — lacrada, a peça viaja.
    const caixaDaJuntada = card
      ? await (this.prisma as any).realignmentShipment
          .findFirst({
            where: { pickOrderId: card.id, status: { not: 'cancelled' } },
            select: { status: true },
          })
          .catch(() => null)
      : null;

    return {
      orderStatus: String(order.status),
      card,
      bipesDaPeca,
      bipesEnviados,
      notaAutorizada,
      caixaDaJuntada,
    };
  }

  /**
   * A peça nova, com o preço QUE O SITE COBRA hoje — a mesma régua do
   * catálogo (26/08): o preço da LOJA (`vendaUn`), com a promoção de 50%
   * automática quando elegível.
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

    // O preço do site É o da loja (26/08) — `vendaUn` com a única promoção
    // compartilhada (50% do caixa). O `precoPromo` digitado saiu da fórmula
    // aqui junto com a vitrine e a trava do carrinho.
    let precoSite = precoErp;
    let motivoDoPreco = 'preço da loja (ERP)';
    if (ref) {
      const chave = ref.toUpperCase().replace(/\s+/g, '');
      const promo = await this.promo.porChave(chave).catch(() => null);
      if (promo?.elegivel && this.promo.ligada && precoErp > 0) {
        precoSite = this.promo.precoComDesconto(precoErp);
        motivoDoPreco = `promoção de 50% (${promo.motivo})`;
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
