import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { startOfDayBR } from '../lib/date-br';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OrderStatus } from '../common/enums';
import { conferenciaTravaLigada } from '../common/prova-pagamento';
import { pedidoPago } from '../common/pedido-pago';
import { voltariaProFluxo, motivoDaRecusa } from '../common/volta-pro-fluxo';
import {
  RASTREIO_JANELA_DIAS as JANELA_DIAS,
  inicioDaJanela,
  despachadoEm,
  despachadoDentroDaJanela,
  despachadoForaDaJanela,
} from '../common/janela-rastreio';
import { StockService } from '../stock/stock.service';
import { RoutingService } from '../routing/routing.service';
import { PrismaService } from '../prisma/prisma.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';
import { ErpService } from '../erp/erp.service';
import { PickScanService } from '../pick-orders/pick-scan.service';
import { JuntadaService } from '../pick-orders/juntada.service';
import { TrocaPecaService } from './troca-peca.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { extractAttribution, extractAttributionRaw } from '../woocommerce/attribution.util';
import { montarCascataAtribuicao, EntradaAtribuicao } from './atribuicao-cascata.util';
import { extractCpf, detectPickup, extractVariantFromLineItem } from '../woocommerce/wc-order-extract.util';

/**
 * ABA DA TELA DE SEPARAÇÃO → status dos pedidos NATIVOS do Flow (live + site
 * novo), que vivem só no Postgres e não têm status de WooCommerce.
 *
 * Mora aqui desde 13/08 porque a LISTA e o CONTADOR da aba liam mapas
 * diferentes: a lista já trazia `['live', 'ecommerce']`, o contador só somava
 * `live`. Resultado na tela: aba **"Processando 2"** com **5 pedidos na fila**
 * — os 3 do site novo apareciam na lista e não no número. Contador que
 * discorda da lista faz a operação achar que perdeu pedido.
 */
export const STATUS_LOCAL_POR_ABA: Record<string, string[]> = {
  // 'pending' entra em Processando (17/08): o Recalcular sem loja
  // alternativa deixava o pedido nativo em pending — status que nenhuma
  // aba conhecia. O ON- sumia da fila inteira com o dinheiro já na conta.
  //
  // 'awaiting_stock' e 'routing' pelo MESMO motivo (17/08, caso ON-000006):
  // ruptura/pickup-blocked joga o pedido em awaiting_stock (`confirmRoute`
  // com success:false) e ele saía da lista — pago, cliente esperando, só
  // alcançável pela URL direta. Consertaram 'pending' e deixaram esses dois
  // de fora; são todos o mesmo caso: "sem card e ninguém olhando".
  //
  // ⚠️ Status que não cai em nenhuma aba = PEDIDO INVISÍVEL. Ao criar status
  // novo, mapear aqui é obrigatório.
  processing: ['processing', 'pending', 'awaiting_stock', 'routing'],
  separacao: ['separating'],
  'em-separacao': ['separating'],
  // 'shipped' saiu daqui em 19/08 e virou a aba "Em trânsito" — ver
  // `whereNativoDaAba`. Despachado e ENTREGUE moravam na mesma aba: a matriz
  // via "Concluído" no pedido que ainda estava no caminhão.
  completed: ['delivered'],
};

/** As origens que a fila mostra junto com o WooCommerce.
 *  'pdv_online' (14/08): venda online do PDV que virou pedido — faixa 960M,
 *  mesma vida do pedido do site (roteamento → card → envio), sem WooCommerce. */
export const ORIGENS_NATIVAS = ['live', 'ecommerce', 'pdv_online'];

/**
 * A JANELA DO RASTREIO — a MESMA do `RastreioSyncCron.candidatos()` (30 dias).
 *
 * A régua inteira (e o motivo de ela NÃO poder medir por `updatedAt`) mora em
 * `common/janela-rastreio.ts`, porque a lista, o badge e o cron precisam ler
 * exatamente a mesma coisa. Reexportado aqui só pra não quebrar quem já
 * importava desta porta.
 */
export const RASTREIO_JANELA_DIAS = JANELA_DIAS;

/** Pedido com código de rastreio — no próprio pedido ou em algum card da loja. */
const TEM_RASTREIO = {
  OR: [
    { trackingCode: { not: null } },
    { pickOrders: { some: { trackingCode: { not: null } } } },
  ],
};

/**
 * O `where` do pedido NATIVO por aba da tela de separação.
 *
 * Existe pelo mesmo motivo que o `STATUS_LOCAL_POR_ABA` mora neste arquivo: a
 * LISTA e o CONTADOR precisam ler a MESMA regra. "Em trânsito" e "Concluídos"
 * não cabem num mapa de status porque dependem de ter rastreio e de quando o
 * pedido foi despachado — se a lista calcular de um jeito e o badge de outro,
 * a operação acha que perdeu pedido (foi o defeito de 13/08).
 *
 * ⚠️ As duas abas são COMPLEMENTARES de propósito: todo pedido `shipped` ou
 * `delivered` cai em uma delas e em uma só. Pedido que não cai em aba nenhuma
 * é pedido invisível.
 */
/**
 * O CARD JÁ SEPARADO — peça na mão, esperando etiqueta/postagem.
 *
 * `separated` é o status que a loja grava quando termina de bipar (`ready` é o
 * antigo, ainda existe em card velho). Card nesse estado não pede mais nada da
 * arara: pede POSTAGEM.
 */
const CARD_PRONTO = ['separated', 'ready'];
/** O card ainda na arara — ninguém terminou de separar. */
const CARD_SEPARANDO = ['new', 'separating'];

export function whereNativoDaAba(slug: string): Record<string, any> | null {
  const desde = inicioDaJanela();

  /**
   * PRONTO PRA POSTAR (24/08/2026, ordem do dono) — o buraco entre separar e
   * despachar.
   *
   * "Entre separação e em trânsito ele fica parado, sem movimentar status."
   * Estava certo: o pedido entra em `separating` quando a loja recebe o card e
   * só sai quando alguém posta E cola o rastreio. Entre bipar a última peça e
   * postar a caixa não existia status nenhum — e a aba "Em separação" não
   * distinguia "ainda procurando na arara" de "sacola pronta no balcão".
   *
   * Medição de 24/08: 31 cards `separated` parados, 36h de média e o pior com
   * 6,3 dias. Nenhum deles aparecia como pendência de postagem em lugar
   * nenhum — só como mais uma linha de "Em separação".
   *
   * ⚠️ COMPLEMENTAR a `separacao` de propósito, pela mesma regra que já vale
   * pra "Em trânsito"/"Concluídos": todo pedido `separating` cai em uma das
   * duas e em uma só. Se A = "tem card ainda separando" e B = "tem card
   * pronto", aqui é ¬A ∧ B e lá é A ∨ ¬B. Pedido sem card nenhum e pedido com
   * todos os cards já despachados continuam em "Em separação" — invisível é
   * pior que na aba errada.
   */
  if (slug === 'pronto-postar') {
    return {
      AND: [
        { status: 'separating' },
        { pickOrders: { none: { status: { in: CARD_SEPARANDO } } } },
        { pickOrders: { some: { status: { in: CARD_PRONTO } } } },
      ],
    };
  }

  // EM SEPARAÇÃO = o resto do `separating`: card ainda na arara, pedido sem
  // card e pedido cujos cards já saíram. Escrito por extenso (não como NOT do
  // bloco acima) — negação sobre relação é onde o Postgres some com linha sem
  // avisar, e some sem erro.
  if (slug === 'separacao' || slug === 'em-separacao') {
    return {
      AND: [
        { status: 'separating' },
        {
          OR: [
            { pickOrders: { some: { status: { in: CARD_SEPARANDO } } } },
            { pickOrders: { none: { status: { in: CARD_PRONTO } } } },
          ],
        },
      ],
    };
  }

  // EM TRÂNSITO = a loja despachou E colocou o rastreio, e o objeto ainda está
  // dentro da janela em que dá pra saber onde ele está.
  //
  // ⚠️ A janela mede por `shippedAt`, NÃO por `updatedAt` (25/08): tocar a
  // linha por qualquer outro motivo — atribuir vendedora, carimbar conversão
  // do Google Ads, avisar a cliente — trazia pedido velho de volta pra cá.
  if (slug === 'em-transito') {
    return { AND: [{ status: 'shipped' }, despachadoDentroDaJanela(desde), TEM_RASTREIO] };
  }

  // CONCLUÍDOS = entregue (o rastreio confirmou e o cron fechou o pedido) OU
  // despachado sem nada pra rastrear: retirada, motoboy, loja que não colou o
  // código, e o que envelheceu fora da janela. Escrito por extenso em vez de
  // um NOT do bloco de cima — negação com campo nulo no meio é onde o Postgres
  // some com linha sem avisar.
  if (slug === 'completed') {
    return {
      OR: [
        { status: 'delivered' },
        {
          AND: [
            { status: 'shipped' },
            {
              OR: [
                despachadoForaDaJanela(desde),
                {
                  AND: [
                    { trackingCode: null },
                    { pickOrders: { none: { trackingCode: { not: null } } } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  const statuses = STATUS_LOCAL_POR_ABA[slug];
  return statuses?.length ? { status: { in: statuses } } : null;
}

/**
 * EM QUE ABA ESTE PEDIDO MORA — o caminho de volta do `whereNativoDaAba`.
 *
 * A busca agora atravessa as abas (ver `wcList`), então a linha tem que dizer
 * onde o pedido está: achar o pedido e não saber pra onde ir é meio conserto.
 * Escrito com as MESMAS constantes da ida (`CARD_PRONTO`, `CARD_SEPARANDO`,
 * `RASTREIO_JANELA_DIAS`) — se a ida e a volta divergirem, a tela manda a
 * matriz pra uma aba onde o pedido não está.
 *
 * `null` = status que não cai em aba nenhuma (`awaiting_payment`,
 * `payment_failed`, `cancelled` do nativo). Nesse caso a tela mostra o rótulo
 * cru e NÃO oferece atalho — melhor sem link do que com link que mente.
 */
export function abaDoNativo(
  status: string,
  pickStatuses: string[],
  /** QUANDO A CAIXA SAIU — `shippedAt`, com `updatedAt` só como plano B da
   *  linha antiga. Ver `common/janela-rastreio.ts`. */
  despachoEm: Date | null | undefined,
  temRastreio: boolean,
): string | null {
  if (status === 'separating') {
    const temSeparando = pickStatuses.some((s) => CARD_SEPARANDO.includes(s));
    const temPronto = pickStatuses.some((s) => CARD_PRONTO.includes(s));
    return !temSeparando && temPronto ? 'pronto-postar' : 'separacao';
  }
  if (status === 'shipped') {
    const desde = inicioDaJanela();
    const dentroDaJanela = !!despachoEm && new Date(despachoEm) >= desde;
    return dentroDaJanela && temRastreio ? 'em-transito' : 'completed';
  }
  if (status === 'delivered') return 'completed';
  for (const [slug, statuses] of Object.entries(STATUS_LOCAL_POR_ABA)) {
    // 'separacao'/'em-separacao'/'completed' já foram tratados por extenso
    // acima; sobra o mapa simples (Processando e seus vizinhos).
    if (slug === 'processing' && statuses.includes(status)) return slug;
  }
  return null;
}

/**
 * O `where` DA BUSCA LIVRE — o que a matriz digita naquele campo.
 *
 *   nº do pedido  → `ON-000126`, `LP-000162`, `126` (contains)
 *   nome          → `Erica`
 *   e-mail        → o placeholder oferecia desde sempre e NINGUÉM consultava a
 *                   coluna: buscar por e-mail dava zero
 *   telefone      → digitado com máscara `(11) 99894-1591`; a coluna guarda só
 *                   dígitos, então compara dígito com dígito
 *   rastreio      → `AA123456789BR` colado do aviso da cliente
 *   nº interno    → `960000126`, o da URL /pedidos/wc/…
 *
 * Fora daqui, quem chama já tirou o `#` do termo (a tela mostra `#ON-000126` e
 * é assim que a matriz digita).
 */
export function filtroBuscaPedido(search: string): Record<string, any> {
  const alvos: any[] = [
    { wcOrderNumber: { contains: search, mode: 'insensitive' } },
    { customerName: { contains: search, mode: 'insensitive' } },
    { customerEmail: { contains: search, mode: 'insensitive' } },
    { trackingCode: { contains: search, mode: 'insensitive' } },
  ];
  // Só entra no terreno numérico quem digitou SÓ número/pontuação. Se o termo
  // tem letra (`ON-000126`), os dígitos soltos dele ("000126") não podem sair
  // casando com pedaço de telefone alheio — linha a mais numa busca é o mesmo
  // alarme falso que faz a operação parar de confiar na tela.
  const soDigitos = /[a-z]/i.test(search) ? '' : search.replace(/\D/g, '');
  if (soDigitos.length >= 4) {
    alvos.push({ customerPhone: { contains: soDigitos } });
    const comoId = Number(soDigitos);
    // ⚠️ TETO DE INT32 obrigatório: `wc_order_id` é `Int` no Postgres e um
    // telefone (11998941591) NÃO cabe — o Prisma estoura a query inteira e a
    // busca por telefone viraria 500. Medido em 25/08: "value is out of range
    // for type integer".
    const CABE_EM_INT32 = 2_147_483_647;
    if (comoId > 0 && comoId <= CABE_EM_INT32 && soDigitos.length >= 8) {
      alvos.push({ wcOrderId: comoId });
    }
  }
  return { OR: alvos };
}

/** Rótulo humano do status local — o que a matriz lê na linha da busca. */
export const ROTULO_STATUS_LOCAL: Record<string, string> = {
  pending: 'Processando',
  processing: 'Processando',
  routing: 'Processando',
  awaiting_stock: 'Sem estoque',
  separating: 'Em separação',
  ready: 'Pronto pra postar',
  shipped: 'Despachado',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
  refunded: 'Reembolsado',
  awaiting_payment: 'Aguardando pagamento',
  payment_failed: 'Pagamento recusado',
};

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly stock: StockService,
    private readonly routing: RoutingService,
    private readonly prisma: PrismaService,
    private readonly wc: WooCommerceService,
    private readonly erp: ErpService,
    // Estorno dos bipes quando o pedido é cancelado/reembolsado no site.
    private readonly pickScans: PickScanService,
    // Juntada de pedido dividido: loja âncora envia tudo (21/08).
    private readonly juntada: JuntadaService,
    // Troca manual de item: dados canônicos da peça nova via espelho.
    private readonly catalog: WincredCatalogService,
    // Troca de peça COM acerto do dinheiro (link da diferença / vale).
    private readonly trocaPeca: TrocaPecaService,
  ) {}

  /**
   * A TELA DE SEPARAÇÃO AINDA PERGUNTA PRO WOOCOMMERCE?
   *
   * Não desde 22/08/2026 — o dono cortou: "WOOCOMMERCE NÃO EXISTE MAIS". A
   * última venda por lá foi 19/08 (virada de `lurds.com.br` pro site novo),
   * mas a API do WordPress continua no ar respondendo o ARQUIVO — e era ele
   * que enchia as abas com trabalho que ninguém vai fazer:
   *
   *   Concluídos 22.780 = 22.538 do WooCommerce + 242 da operação de verdade
   *   Cancelados    212 = 212 do WooCommerce + 0
   *   Aguardando      4 = 4 pedidos parados lá desde antes da virada
   *   Em separação   34 = 3 do WooCommerce (presos) + 31 de verdade
   *
   * Badge que mistura arquivo morto com pendência real é badge que ninguém
   * olha — a mesma regra da fila da loja ("alarme falso mata a confiança na
   * fila inteira"). A tela agora conta e lista SÓ a operação viva.
   *
   * O pedido antigo não sumiu: ele mora no nosso Postgres e continua achável
   * pela BUSCA desta mesma tela (ver `wcList`) e pela URL direta.
   *
   * Kill-switch: `SEPARACAO_WOOCOMMERCE=1` traz o arquivo de volta.
   */
  private get separacaoComWoo(): boolean {
    return String(process.env.SEPARACAO_WOOCOMMERCE ?? '0').trim() === '1';
  }

  // ---------- Rotas estáticas PRIMEIRO (senão o `:id` come) ----------

  /**
   * GET /orders/diagnostico/carrinho-recuperado?dias=30
   *
   * MEDIÇÃO ANTES DE CONSTRUIR (17/08) — duas perguntas que decidem se a
   * atribuição de carrinho recuperado é fácil ou impossível hoje.
   *
   * O CONTEXTO: no site novo o "carrinho abandonado" É um Order
   * (`source: 'ecommerce'`, `paidAt: null`) — e Order já guarda `utm*` e
   * `trackingInfo` (fbp/fbc). As meninas recuperam por WhatsApp e fecham no
   * PDV, o que cria um SEGUNDO Order (`source: 'pdv_online'`) com o dinheiro
   * mas SEM campanha. Resultado: a mesma cliente conta como ABANDONO no funil
   * e como RECEITA SEM ORIGEM no ROAS. Erra pros dois lados.
   *
   * O que este diagnóstico responde:
   *   1. Quantas vendas de PDV casam com um carrinho abandonado (por
   *      telefone/e-mail/CPF, carrinho criado ANTES)? = tamanho da ponte.
   *   2. Desses carrinhos, quantos têm `utmCampaign` de verdade? Se vier
   *      vazio, o elo existe mas não carrega nada — o problema é no tracking,
   *      não na ponte (ver o histórico de UTM podada antes de gravar).
   *   3. Quantos dias entre abandonar e recuperar? Acima de 7 o Meta não
   *      atribui mais (janela de clique), então o CAPI ajuda pouco e o que
   *      vale é o relatório interno.
   *   4. `conferenciaMeta`: pedidos do site PAGOS por dia, pra comparar com o
   *      "Compras" do Gerenciador. Divergência = pixel + CAPI contando a
   *      mesma venda duas vezes (event_id que não casa).
   *
   * Read-only. Não grava nada.
   */
  @Get('diagnostico/carrinho-recuperado')
  async diagnosticoCarrinhoRecuperado(@Query('dias') diasRaw?: string) {
    const dias = Math.min(Math.max(Number(diasRaw) || 30, 1), 180);
    const desde = new Date(Date.now() - dias * 86_400_000);
    // Carrinho pode ser bem mais velho que a venda — a janela de busca do
    // carrinho é maior, senão a ponte parece menor do que é.
    const desdeCarrinho = new Date(Date.now() - (dias + 60) * 86_400_000);

    const soDigitos = (v: any) => String(v ?? '').replace(/\D+/g, '');
    /** Telefone comparável: últimos 11 dígitos (mesma régua do scanConversions). */
    const fone = (v: any) => {
      const d = soDigitos(v);
      return d.length >= 10 ? d.slice(-11) : '';
    };
    const email = (v: any) => String(v ?? '').trim().toLowerCase();

    const [vendasPdv, carrinhos, pagosSite] = await Promise.all([
      (this.prisma as any).order.findMany({
        where: { source: 'pdv_online', createdAt: { gte: desde } },
        select: {
          id: true, wcOrderNumber: true, createdAt: true, totalAmount: true,
          customerPhone: true, customerEmail: true, customerCpf: true,
          utmCampaign: true, utmSource: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      // Carrinho abandonado = pedido do site que nunca foi pago.
      (this.prisma as any).order.findMany({
        where: { source: 'ecommerce', paidAt: null, createdAt: { gte: desdeCarrinho } },
        select: {
          id: true, wcOrderNumber: true, createdAt: true, totalAmount: true,
          customerPhone: true, customerEmail: true, customerCpf: true,
          utmCampaign: true, utmSource: true, utmMedium: true, utmId: true,
          trackingInfo: true, status: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      /**
       * TODO pedido PAGO — a base pra conferir com o "Compras" do Meta.
       *
       * ⚠️ SEM FILTRO DE SOURCE de propósito (correção 17/08). A primeira
       * versão contava só `source: 'ecommerce'` (site novo) e deu divergência
       * de 4,6× contra o Gerenciador (Meta R$ 1.497 × Flow R$ 324) — o que
       * parecia bug de tracking era denominador errado: se o mesmo pixel serve
       * o site ANTIGO (WooCommerce, `source: 'site'`), as compras de lá entram
       * no número do Meta e não entravam no meu. Comparar métrica de fora com
       * recorte de dentro mais estreito SEMPRE acusa inflação que não existe.
       * Agora quebra por origem: a soma bate com o Meta, e o detalhe mostra
       * quanto é de cada site.
       */
      (this.prisma as any).order.findMany({
        where: { paidAt: { not: null }, createdAt: { gte: desde } },
        select: { id: true, paidAt: true, totalAmount: true, utmCampaign: true, source: true },
      }),
    ]);

    // Índices do carrinho por telefone/e-mail/CPF — 1 passada, sem N queries.
    const porFone = new Map<string, any[]>();
    const porEmail = new Map<string, any[]>();
    const porCpf = new Map<string, any[]>();
    const empilha = (m: Map<string, any[]>, k: string, v: any) => {
      if (!k) return;
      const arr = m.get(k);
      if (arr) arr.push(v);
      else m.set(k, [v]);
    };
    for (const c of carrinhos) {
      empilha(porFone, fone(c.customerPhone), c);
      empilha(porEmail, email(c.customerEmail), c);
      empilha(porCpf, soDigitos(c.customerCpf), c);
    }

    const casados: any[] = [];
    const semCarrinho: any[] = [];
    for (const v of vendasPdv) {
      const cands = [
        ...(porFone.get(fone(v.customerPhone)) ?? []),
        ...(porEmail.get(email(v.customerEmail)) ?? []),
        ...(porCpf.get(soDigitos(v.customerCpf)) ?? []),
      ];
      // Carrinho tem que ser ANTES da venda. Entre vários, o mais recente
      // antes da venda é o que a cliente realmente abandonou.
      const antes = cands
        .filter((c) => new Date(c.createdAt) < new Date(v.createdAt))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const carrinho = antes[0];
      if (!carrinho) {
        semCarrinho.push({
          pedido: v.wcOrderNumber,
          total: Number(v.totalAmount ?? 0),
          criadoEm: v.createdAt,
        });
        continue;
      }
      let track: any = {};
      try { track = carrinho.trackingInfo ? JSON.parse(carrinho.trackingInfo) : {}; } catch { track = {}; }
      casados.push({
        pedido: v.wcOrderNumber,
        total: Number(v.totalAmount ?? 0),
        vendaEm: v.createdAt,
        carrinho: carrinho.wcOrderNumber,
        carrinhoEm: carrinho.createdAt,
        diasEntre: Math.round(
          (new Date(v.createdAt).getTime() - new Date(carrinho.createdAt).getTime()) / 86_400_000,
        ),
        // Só conta como "tem campanha" se veio nome de campanha — utmSource
        // sozinho ("facebook") não diz qual anúncio pagou.
        campanha: carrinho.utmCampaign ?? null,
        utmSource: carrinho.utmSource ?? null,
        utmId: carrinho.utmId ?? null,
        temFbc: !!track?.fbc,
        temFbp: !!track?.fbp,
        // Venda já tem UTM própria? Hoje nunca tem — é o furo.
        vendaJaTemUtm: !!v.utmCampaign,
      });
    }

    const comCampanha = casados.filter((c) => c.campanha);
    const dentroDe7 = comCampanha.filter((c) => c.diasEntre <= 7);
    const soma = (arr: any[]) => arr.reduce((s, x) => s + Number(x.total || 0), 0);

    // Receita recuperada por campanha — o número que falta no ROAS.
    const porCampanha = new Map<string, { vendas: number; valor: number }>();
    for (const c of comCampanha) {
      const k = String(c.campanha);
      const cur = porCampanha.get(k) ?? { vendas: 0, valor: 0 };
      cur.vendas += 1;
      cur.valor += Number(c.total || 0);
      porCampanha.set(k, cur);
    }

    // Conferência com o Gerenciador: pedidos pagos por dia, QUEBRADOS POR
    // ORIGEM. O Meta soma tudo que o pixel dele vê; se o pixel serve os dois
    // sites, o comparável é o TOTAL — e o detalhe por origem mostra de onde
    // vem. `pdv_online` fica de fora do total do site: o Meta não vê venda
    // fechada no PDV (é justamente a receita invisível que este relatório
    // está medindo), então somar aqui esconderia o furo.
    const porDia = new Map<
      string,
      { total: number; valor: number; porOrigem: Record<string, { pedidos: number; valor: number }> }
    >();
    for (const p of pagosSite) {
      const k = new Date(p.paidAt).toISOString().slice(0, 10);
      const cur = porDia.get(k) ?? { total: 0, valor: 0, porOrigem: {} };
      const src = String(p.source || 'desconhecido');
      const o = cur.porOrigem[src] ?? { pedidos: 0, valor: 0 };
      o.pedidos += 1;
      o.valor += Number(p.totalAmount || 0);
      cur.porOrigem[src] = o;
      // 'pdv_online' NÃO entra no total comparável com o Meta.
      if (src !== 'pdv_online') {
        cur.total += 1;
        cur.valor += Number(p.totalAmount || 0);
      }
      porDia.set(k, cur);
    }

    const diasOrdenados = [...comCampanha].map((c) => c.diasEntre).sort((a, b) => a - b);
    const mediana = diasOrdenados.length
      ? diasOrdenados[Math.floor(diasOrdenados.length / 2)]
      : null;

    return {
      janelaDias: dias,
      resumo: {
        vendasPdvOnline: vendasPdv.length,
        casaramComCarrinho: casados.length,
        // ⚠️ ESTE é o número que decide: sem campanha no carrinho, a ponte
        // não carrega nada e o problema está no tracking, não aqui.
        comCampanhaNoCarrinho: comCampanha.length,
        semCarrinhoNenhum: semCarrinho.length,
        receitaRecuperadaComCampanha: Number(soma(comCampanha).toFixed(2)),
        receitaSemOrigem: Number((soma(casados) + soma(semCarrinho) - soma(comCampanha)).toFixed(2)),
        // Fora da janela de 7 dias o Meta não atribui — CAPI não recupera.
        dentroJanelaMeta7d: dentroDe7.length,
        foraJanelaMeta7d: comCampanha.length - dentroDe7.length,
        medianaDiasAteRecuperar: mediana,
        comFbcParaCapi: comCampanha.filter((c) => c.temFbc).length,
      },
      porCampanha: [...porCampanha.entries()]
        .map(([campanha, v]) => ({ campanha, ...v, valor: Number(v.valor.toFixed(2)) }))
        .sort((a, b) => b.valor - a.valor),
      /**
       * Compare `comparavelComMeta` com o "Compras"/"Valor de conversão" do
       * Gerenciador no MESMO dia. Ainda maior no Meta depois disso? Então é
       * de fora: pixel do site antigo com outro dedup, janela de atribuição
       * (compra de hoje creditada a clique de dias atrás) ou conta de anúncio
       * com mais de um pixel. `detalhePorOrigem` diz de qual site veio.
       */
      conferenciaMeta: [...porDia.entries()]
        .map(([dia, v]) => ({
          dia,
          comparavelComMeta: { pedidos: v.total, valor: Number(v.valor.toFixed(2)) },
          detalhePorOrigem: Object.fromEntries(
            Object.entries(v.porOrigem).map(([k, o]) => [
              k,
              { pedidos: o.pedidos, valor: Number(o.valor.toFixed(2)) },
            ]),
          ),
        }))
        .sort((a, b) => (a.dia < b.dia ? 1 : -1)),
      amostraCasados: casados.slice(0, 25),
      amostraSemCarrinho: semCarrinho.slice(0, 15),
    };
  }

  @Get('stats/counts')
  counts() {
    return this.orders.countByStatus();
  }

  /**
   * Financeiro/analítico: KPIs + breakdowns no intervalo [from, to].
   * Ex: GET /orders/analytics?from=2026-04-01&to=2026-04-21
   * Sem defaults: se um dos dois faltar, retorna 400.
   */
  @Get('analytics')
  async analytics(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!from || !to) {
      throw new BadRequestException('Parâmetros "from" e "to" são obrigatórios (YYYY-MM-DD).');
    }
    try {
      return await this.orders.analytics(from, to);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Falha ao gerar analítico');
    }
  }

  /**
   * Relatório VENDAS POR CAMPANHA (De/Até). Agrupa pedidos do site pela
   * campanha de origem (utmCampaign do Order Attribution do WC).
   * Ex: GET /orders/report/campanhas?from=2026-07-01&to=2026-07-25
   */
  @Get('report/campanhas')
  async campanhasReport(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!from || !to) {
      throw new BadRequestException('Parâmetros "from" e "to" são obrigatórios (YYYY-MM-DD).');
    }
    try {
      return await this.orders.campanhasReport(from, to);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Falha ao gerar relatório de campanhas');
    }
  }

  /**
   * Lista pedidos DIRETO do WooCommerce (espelho do admin WP).
   * Não usa banco local. Contadores e dados vêm sempre atualizados.
   */
  @Get('wc')
  async wcList(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
    @Query('search') search?: string,
    @Query('after') after?: string,
    @Query('before') before?: string,
    @Query('storeCode') storeCode?: string,
  ) {
    // A TELA exibe os números com '#' (#ON-000115), então é assim que a matriz
    // digita na busca — mas o banco guarda SEM o '#', e um contains com a
    // cerquilha na frente não acha nada (25/08: "POR QUE NAO CONSIGO BUSCAR
    // POR NUMERO????"). Normaliza aqui, no funil único: vale pro caminho
    // nativo E pro WooCommerce.
    search = search ? search.replace(/#/g, '').trim() : search;
    // Quando filtra por loja, pega per_page MAIOR pra compensar o filtro local.
    // LIMITE 100 — WooCommerce REST API REJEITA per_page > 100 com 500.
    const effectivePerPage = storeCode
      ? Math.min(100, Number(perPage || 50) * 2)
      : (perPage ? Number(perPage) : 50);

    /**
     * "Em trânsito" NÃO pergunta pro WooCommerce (19/08).
     *
     * A aba existia desde sempre e vivia zerada, e a razão estava a um arquivo
     * de distância: quando a loja despacha, o pick-order marca o pedido no WC
     * como **`completed`**, não `shipped` — de propósito, porque só o hook
     * nativo `order_status_completed` dispara o WhatsApp do plugin
     * (`WC_STATUS_SHIPPED` em pick-orders.service.ts). Ou seja: a aba pedia um
     * status que o sistema nunca escreve, e a chamada só gastava HTTP.
     *
     * Quem sabe o que está viajando é o Postgres — `Order` + `rastreio_objetos`
     * — pra TODAS as origens, WooCommerce incluído.
     */
    const ehEmTransito = status === 'em-transito';
    // Sem WooCommerce, a lista sai inteira do Postgres — o mesmo caminho que
    // "Em trânsito" já usava desde 19/08.
    const res = ehEmTransito || !this.separacaoComWoo
      ? { data: [] as any[], total: 0, totalPages: 0 }
      : await this.wc.listOrders({
          status,
          page: page ? Number(page) : 1,
          perPage: effectivePerPage,
          search,
          after,
          before,
        });

    // Enriquecimento: pra cada pedido retornado, anexa
    //   - loja(s) responsável(is) pela separação (via PickOrder local)
    //   - rastreio (trackingCode/carrier) do pick-order (quem enviou bota aqui)
    //   - flag `shipped` se TODOS os pick-orders do pedido já foram enviados
    // Tudo em 1 query só (batch) — não faz N+1.
    const wcIds = res.data.map((o: any) => Number(o.id)).filter(Boolean);
    const ordersWithPicks =
      wcIds.length > 0
        ? await (this.prisma as any).order.findMany({
            where: { wcOrderId: { in: wcIds } },
            select: {
              wcOrderId: true,
              sellerId: true,
              sellerName: true,
              pickOrders: {
                select: {
                  status: true,
                  trackingCode: true,
                  carrier: true,
                  store: { select: { code: true, name: true } },
                },
              },
            },
          })
        : [];
    const picksByWcId = new Map<number, any[]>();
    const sellerByWcId = new Map<number, { id: string | null; name: string | null }>();
    for (const ord of ordersWithPicks) {
      picksByWcId.set(ord.wcOrderId, ord.pickOrders || []);
      sellerByWcId.set(ord.wcOrderId, {
        id: ord.sellerId ?? null,
        name: ord.sellerName ?? null,
      });
    }

    const data = res.data.map((o: any) => {
      const picks = picksByWcId.get(Number(o.id)) || [];
      const pickOrders = picks.map((p: any) => ({
        storeCode: p.store?.code ?? null,
        storeName: p.store?.name ?? null,
        status: p.status,
        trackingCode: p.trackingCode ?? null,
        carrier: p.carrier ?? null,
      }));
      // "shipped" = TODOS os pick-orders enviados (quando há >1 loja, todas precisam marcar shipped)
      const allShipped =
        pickOrders.length > 0 && pickOrders.every((p) => p.status === 'shipped');
      // 1º tracking disponível (normalmente só há 1 loja por pedido)
      const firstTracking = pickOrders.find((p) => !!p.trackingCode);
      return {
        id: o.id,
        number: o.number,
        status: o.status,
        // Mesmo par de campos das linhas nativas, pra tela não ter que saber
        // de onde veio a linha na hora de mostrar "onde este pedido está".
        statusLocal: o.status,
        statusLabel: ROTULO_STATUS_LOCAL[o.status] ?? o.status,
        abaSlug: null,
        dateCreatedGmt: o.date_created_gmt ?? o.date_created,
        total: o.total,
        currency: o.currency,
        customerName: `${o.billing?.first_name ?? ''} ${o.billing?.last_name ?? ''}`.trim(),
        // Título do método de envio (SEDEX / PAC / Retirar na Loja de X / etc)
        // — lido direto do shipping_lines que o WC já devolve na listagem.
        shippingMethod: o.shipping_lines?.[0]?.method_title ?? null,
        // UF do destinatário — pra resolver "PROMOCIONAL" → SEDEX (SP) ou PAC.
        shippingState: o.shipping?.state ?? o.billing?.state ?? null,
        // NOVO: loja responsável + rastreio + flag enviado
        pickOrders,
        shipped: allShipped,
        trackingCode: firstTracking?.trackingCode ?? null,
        trackingCarrier: firstTracking?.carrier ?? null,
        // Vendedora atribuída (cache denormalizado no Order local)
        sellerId: sellerByWcId.get(Number(o.id))?.id ?? null,
        sellerName: sellerByWcId.get(Number(o.id))?.name ?? null,
        // Origem do pedido (site/live) — 'source' já é a atribuição UTM do WC
        orderSource: 'site',
        ...extractAttribution(o.meta_data ?? []),
        // NOME cru da campanha (pra badge de "veio da campanha X" na separação)
        utmCampaign: extractAttributionRaw(o.meta_data ?? []).utmCampaign,
      };
    });

    // ── Pedidos NATIVOS do Flow — MESMA fila, MESMA linha ──
    // Duas origens vivem só no Postgres (wcOrderId sintético, sem WooCommerce):
    //   'live'      → Live Commerce, nº "LIVE-<comanda>", faixa 900M
    //   'ecommerce' → site NOVO (sprint 011), nº "LP-xxxxxx", faixa 950M
    // Mapeia o slug da aba pro status local equivalente e devolve no formato
    // idêntico ao das linhas do WC, pra tela não saber de onde veio.
    //
    // Pedido do e-commerce só entra aqui depois de PAGO: ele nasce
    // 'awaiting_payment' e vira 'processing' na confirmação — separar o que
    // não foi pago seria pedir prejuízo.
    const whereAba = status ? whereNativoDaAba(status) : null;

    /**
     * BUSCA ATRAVESSA AS ABAS (25/08/2026 — "ARRUME A BUSCA DOS PEDIDOS, NÃO
     * FILTRA").
     *
     * Quem digita `ON-000126` está perguntando "onde está ESTE pedido", não
     * "este pedido está nesta aba?". E a aba era exatamente o que sumia com
     * ele: a busca entrava como mais um `AND` junto do `whereAba`, então
     * procurar da aba Processando por um pedido que já está `separating`
     * devolvia ZERO — sem erro, sem aviso, com o pedido vivo do outro lado da
     * tela (era o caso do dia: ON-000126 = `separating`, procurado de
     * Processando).
     *
     * Pior: aba sem regra nativa (`Pagto pendente`, `Aguardando`,
     * `Cancelados`, `Carrinhos`) devolve `whereNativoDaAba` = null e o bloco
     * inteiro nem rodava — buscar dali era um campo de texto decorativo.
     *
     * Com termo digitado, o funil é UM só: varre TODO o Postgres (todo status,
     * toda origem, o arquivo do site antigo incluído) e a tela avisa em que
     * status cada linha está. Sem termo, nada muda — a aba continua mandando.
     */
    const buscando = !!search;
    let liveRows: any[] = [];
    if (whereAba || buscando) {
      // Composto com AND explícito: a regra da aba e a busca livre usam `OR`
      // no mesmo nível, e duas chaves `OR` no mesmo objeto — uma sobrescreve a
      // outra em silêncio. Filtro que some sem erro é o pior tipo de filtro.
      const filtros: any[] = whereAba && !buscando ? [whereAba] : [];
      // "Em trânsito" é a ÚNICA aba que também traz o pedido do site ANTIGO:
      // quem sabe onde o objeto está é o Postgres (`rastreio_objetos`), não o
      // WooCommerce — e a loja despacha os dois pelo mesmo card, com o mesmo
      // código de rastreio.
      //
      // ⚠️ A BUSCA ENXERGA O ARQUIVO. Sem o WooCommerce na lista, o pedido
      // antigo só é achável por aqui — e a matriz procura pedido de julho o
      // tempo todo (troca, reclamação, segunda via). Ele mora no nosso
      // Postgres desde o sync, então quem digitou algo na busca recebe os dois
      // mundos; quem está só olhando a aba recebe o trabalho de hoje.
      if (!ehEmTransito && !search) filtros.push({ source: { in: ORIGENS_NATIVAS } });
      if (search) filtros.push(filtroBuscaPedido(search));
      if (after) filtros.push({ wcDateCreated: { gte: new Date(after) } });
      if (before) filtros.push({ wcDateCreated: { lte: new Date(before) } });

      const liveOrders = await (this.prisma as any).order.findMany({
        where: { AND: filtros },
        include: {
          pickOrders: {
            select: {
              status: true,
              trackingCode: true,
              carrier: true,
              // `updatedAt` (24/08): é o carimbo de QUANDO a loja terminou de
              // separar. A aba "Pronto pra postar" existe pra mostrar o que
              // está PARADO — sem a hora, a linha não diz se esperou 1h ou 6
              // dias, e uma fila sem idade não é fila, é lista.
              updatedAt: true,
              store: { select: { code: true, name: true } },
            },
          },
        },
        /**
         * "Pronto pra postar" ordena pelo MAIS PARADO primeiro — é uma fila de
         * pendência, não um extrato: quem espera há 6 dias tem que estar na
         * primeira linha, não na página 2 do mais-recente-primeiro.
         *
         * ⚠️ Ordenava por `order.updatedAt` (24/08) e isso MENTIA a partir do
         * momento em que alguém encostava no pedido: atribuir a vendedora pela
         * tag rosa carimba `updatedAt` com agora e joga a caixa parada há 3
         * dias pro fim da fila, como se tivesse acabado de ser trabalhada.
         * Quem manda é `prontoDesde` — o carimbo do CARD separado mais antigo,
         * que é o mesmo número do chip "⏱ parado há X". O `wcDateCreated asc`
         * aqui só garante que o `take` pegue os mais VELHOS quando a aba passar
         * de 100; a ordem final é a do `prontoDesde`, logo abaixo.
         *
         * Buscando, o mais RECENTE primeiro sempre: quem procura um pedido
         * procura o de agora, não o mais parado da fila.
         */
        orderBy:
          !buscando && status === 'pronto-postar'
            ? { wcDateCreated: 'asc' }
            : { wcDateCreated: 'desc' },
        take: buscando || ehEmTransito ? 200 : 100,
      });

      // ── Onde o objeto está AGORA ──
      // Uma consulta só no cache que o `RastreioSyncCron` mantém — nunca na API
      // dos Correios: a lista tem que abrir mesmo com a transportadora fora, e
      // é a mesma leitura que alimenta o aviso "seu pedido chegou" (divergir
      // aí faria a tela dizer uma coisa e a cliente ouvir outra).
      const eventos = new Map<string, any>();
      if (ehEmTransito) {
        const codigos = [
          ...new Set(
            liveOrders
              .flatMap((o: any) => [o.trackingCode, ...(o.pickOrders || []).map((p: any) => p.trackingCode)])
              .map((c: any) => String(c || '').trim().toUpperCase())
              .filter(Boolean),
          ),
        ];
        if (codigos.length) {
          const objetos: any[] = await (this.prisma as any).rastreioObjeto.findMany({
            where: { codigo: { in: codigos } },
            select: {
              codigo: true, status: true, local: true, eventoEm: true,
              previsaoEm: true, entregue: true, consultadoEm: true,
            },
          });
          for (const r of objetos) eventos.set(r.codigo, r);
        }
      }
      liveRows = liveOrders.map((o: any) => {
        const pickOrders = (o.pickOrders || []).map((p: any) => ({
          storeCode: p.store?.code ?? null,
          storeName: p.store?.name ?? null,
          status: p.status,
          trackingCode: p.trackingCode ?? null,
          carrier: p.carrier ?? null,
        }));
        const allShipped =
          pickOrders.length > 0 && pickOrders.every((p: any) => p.status === 'shipped');
        // DESDE QUANDO A CAIXA ESTÁ PRONTA — o card separado mais ANTIGO, que
        // é o que manda: pedido dividido só posta quando a última loja separa,
        // mas quem está esperando há mais tempo é quem define a urgência.
        const prontoDesde =
          (o.pickOrders || [])
            .filter((p: any) => CARD_PRONTO.includes(p.status))
            .map((p: any) => p.updatedAt)
            .sort((a: any, b: any) => +new Date(a) - +new Date(b))[0] ?? o.updatedAt ?? null;
        const firstTracking = pickOrders.find((p: any) => !!p.trackingCode);
        let addrState: string | null = null;
        try { addrState = JSON.parse(o.shippingAddress || '{}')?.state ?? null; } catch {}
        const codigo = String(o.trackingCode || firstTracking?.trackingCode || '').trim().toUpperCase();
        const evento = codigo ? eventos.get(codigo) : null;
        return {
          id: o.wcOrderId,
          number: o.wcOrderNumber,
          status,
          // ONDE O PEDIDO ESTÁ DE VERDADE. O `status` acima é o slug da ABA
          // pedida — servia enquanto a lista só trazia pedido daquela aba. Com
          // a busca atravessando tudo, a linha precisa dizer o status real e
          // pra qual aba ir; sem isso o resultado vira "achei, mas não sei
          // onde está".
          statusLocal: o.status,
          statusLabel: ROTULO_STATUS_LOCAL[o.status] ?? o.status,
          abaSlug: abaDoNativo(
            o.status,
            (o.pickOrders || []).map((p: any) => p.status),
            despachadoEm(o),
            !!(o.trackingCode || firstTracking?.trackingCode),
          ),
          dateCreatedGmt: (o.wcDateCreated ?? o.createdAt)?.toISOString?.() ?? null,
          total: String(o.totalAmount ?? 0),
          currency: 'BRL',
          customerName: o.customerName ?? '',
          shippingMethod: o.shippingMethod ?? (o.source === 'ecommerce' ? 'SITE' : 'LIVE'),
          shippingState: addrState,
          pickOrders,
          shipped: allShipped,
          prontoDesde: prontoDesde?.toISOString?.() ?? prontoDesde ?? null,
          trackingCode: o.trackingCode ?? firstTracking?.trackingCode ?? null,
          trackingCarrier: o.carrier ?? firstTracking?.carrier ?? null,
          // Volumes: pedido dividido despacha uma caixa por loja, e ele só vira
          // ENTREGUE quando TODAS chegam (regra do `RastreioSyncCron`).
          volumes: pickOrders.filter((p: any) => !!p.trackingCode).length || (o.trackingCode ? 1 : 0),
          // Último evento conhecido (cache, não API). Null = objeto que o cron
          // ainda não visitou — e "sem movimento" é diferente de "sem dado".
          rastreio: evento
            ? {
                status: evento.status ?? null,
                local: evento.local ?? null,
                eventoEm: evento.eventoEm?.toISOString?.() ?? null,
                previsaoEm: evento.previsaoEm?.toISOString?.() ?? null,
                entregue: !!evento.entregue,
                consultadoEm: evento.consultadoEm?.toISOString?.() ?? null,
              }
            : null,
          entregueEm: o.deliveredAt?.toISOString?.() ?? null,
          sellerId: o.sellerId ?? null,
          sellerName: o.sellerName ?? null,
          // A origem sai do REGISTRO, não fixa: a mesma consulta agora traz
          // live e e-commerce, e a tela filtra/pinta por este campo.
          orderSource: o.source,
          origem:
            o.source === 'ecommerce'
              ? 'Site (novo)'
              : o.source === 'pdv_online'
                ? 'Venda Online'
                : o.source === 'live'
                  ? 'Live Commerce'
                  : 'Site',
        };
      });

      // A fila de POSTAGEM ordena pelo tempo que a CAIXA está pronta, não pelo
      // que aconteceu com a linha do pedido. Ver o comentário do `orderBy`.
      if (!buscando && status === 'pronto-postar') {
        liveRows.sort(
          (a: any, b: any) =>
            (a.prontoDesde ? +new Date(a.prontoDesde) : Infinity) -
            (b.prontoDesde ? +new Date(b.prontoDesde) : Infinity),
        );
      }
    }
    const dataMerged = [...liveRows, ...data];

    // Filtro por loja responsável (aplicado APÓS enriquecer com pickOrders)
    // Match flexível: normaliza removendo acentos + uppercase + compara code OU name
    const normalize = (s: any) =>
      String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // remove diacríticos (acentos)
        .toUpperCase()
        .trim();
    const targetNorm = normalize(storeCode);
    const filteredData = storeCode
      ? dataMerged.filter((o: any) =>
          (o.pickOrders || []).some((p: any) => {
            const codeN = normalize(p.storeCode);
            const nameN = normalize(p.storeName);
            return codeN === targetNorm || nameN === targetNorm;
          }),
        )
      : dataMerged;

    return {
      data: filteredData,
      total: storeCode ? filteredData.length : res.total + liveRows.length,
      totalPages: storeCode ? 1 : res.totalPages,
      filteredByStore: !!storeCode,
    };
  }

  /**
   * Lista lojas com a contagem do TRABALHO NA MÃO de cada loja.
   * Usado pelo dropdown de filtro na tela /separacao.
   *
   * ⚠️ O número era `status notIn ['shipped','cancelled']` — "card que ainda
   * não acabou", que na prática virou saco de tudo. Medição de 24/08/2026: 56
   * cards, contra 11 pedidos na aba "Em separação". A diferença NÃO era pedido
   * dividido:
   *   · 34 cards já `separated` — peça na sacola, trabalho da aba de POSTAGEM;
   *   ·  4 com problema reportado — o card JÁ saiu da fila da loja
   *     (`reportarProblema` grava `issueReportedAt` e não mexe no status);
   *   ·  9 de pedido `pdv_online` que o cron fechou como `shipped` sem ninguém
   *     encostar no card — o mais velho com 5 dias.
   * Sobravam 9 reais. Número que infla 6× é número que a matriz para de olhar,
   * e aí o filtro inteiro perde a serventia.
   *
   * Responde à ABA porque em "Pronto pra postar" a pergunta é outra (quantas
   * caixas desta loja esperam etiqueta): mostrar 0 pra loja com 7 caixas
   * paradas seria o mesmo defeito ao contrário — silêncio no lugar do alarme.
   */
  @Get('wc/stores-load')
  async wcStoresLoad(@Query('aba') aba?: string) {
    const stores = await (this.prisma as any).store.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true, city: true, state: true },
      orderBy: { name: 'asc' },
    });

    // A MESMA régua de `whereNativoDaAba`: o card na arara (ou o card pronto, na
    // aba de postagem) enquanto o pedido está de fato em separação. O
    // `order: { status: 'separating' }` é o que mata o card órfão de pedido já
    // despachado.
    const prontoPostar = aba === 'pronto-postar';
    const countsRaw = await (this.prisma as any).pickOrder.groupBy({
      by: ['storeId'],
      where: {
        status: { in: prontoPostar ? CARD_PRONTO : CARD_SEPARANDO },
        issueReportedAt: null,
        order: {
          status: 'separating',
          // O ¬A de `whereNativoDaAba('pronto-postar')`: pedido que ainda tem
          // peça na arara mora na aba "Em separação", e a caixa já pronta dele
          // NÃO pode contar aqui. Sem esta linha eram 32 contra 28 na lista —
          // 4 a mais, e número que não bate com a tela é o defeito que esta
          // mudança veio consertar.
          ...(prontoPostar
            ? { pickOrders: { none: { status: { in: CARD_SEPARANDO } } } }
            : {}),
        },
      },
      _count: { _all: true },
    });
    const countMap = new Map<string, number>();
    for (const c of countsRaw) countMap.set(c.storeId, c._count._all);

    return {
      stores: stores.map((s: any) => ({
        code: s.code,
        name: s.name,
        city: s.city,
        state: s.state,
        openOrders: countMap.get(s.id) || 0,
      })),
    };
  }

  /**
   * GET /orders/wc/:wcOrderId/routing-audit
   *
   * Auditoria COMPLETA do roteamento de um pedido:
   *  - PickOrders atuais (lojas que estão/estavam separando)
   *  - Items + assignedStoreId (qual loja foi responsável por cada peça)
   *  - OrderHistory completo (mudanças de status + swaps)
   *  - Detecção de duplicidade (lojas com mesmo item)
   *
   * Usado pra investigar "saiu por loja X mas começou por loja Y".
   */
  @Get('wc/:wcOrderId/routing-audit')
  async routingAudit(@Param('wcOrderId') wcOrderId: string) {
    const wcId = Number(wcOrderId);
    if (!wcId || isNaN(wcId)) {
      throw new Error('wcOrderId inválido');
    }

    const order = await (this.prisma as any).order.findFirst({
      where: { wcOrderId: wcId },
      include: {
        items: {
          select: {
            id: true,
            sku: true,
            quantity: true,
            assignedStoreId: true,
          },
        },
        pickOrders: {
          include: {
            store: { select: { code: true, name: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        history: {
          orderBy: { createdAt: 'asc' },
          take: 100,
        },
      },
    });

    if (!order) {
      return { found: false, wcOrderId: wcId };
    }

    // Enriquece items com nome da loja
    const storeMap = new Map<string, { code: string; name: string }>();
    const allStoreIds = new Set<string>();
    order.items.forEach((it: any) => it.assignedStoreId && allStoreIds.add(it.assignedStoreId));
    order.pickOrders.forEach((p: any) => allStoreIds.add(p.storeId));

    if (allStoreIds.size > 0) {
      const stores = await (this.prisma as any).store.findMany({
        where: { id: { in: Array.from(allStoreIds) } },
        select: { id: true, code: true, name: true },
      });
      stores.forEach((s: any) => storeMap.set(s.id, { code: s.code, name: s.name }));
    }

    // Detecta possível duplicidade: pick-orders ativos com mesmo SKU
    const activePickOrders = order.pickOrders.filter(
      (p: any) => !['cancelled'].includes(p.status),
    );
    const skusByStore: Record<string, string[]> = {};
    for (const it of order.items) {
      if (!it.assignedStoreId) continue;
      const loja = storeMap.get(it.assignedStoreId);
      const key = `${loja?.code || it.assignedStoreId}`;
      if (!skusByStore[key]) skusByStore[key] = [];
      skusByStore[key].push(it.sku);
    }
    const skuConflicts: Array<{ sku: string; stores: string[] }> = [];
    const allSkus = new Set(order.items.map((i: any) => i.sku));
    for (const sku of allSkus) {
      const stores = Object.entries(skusByStore).filter(([_, skus]) => skus.includes(sku as string)).map(([s]) => s);
      if (stores.length > 1) skuConflicts.push({ sku: sku as string, stores });
    }

    return {
      found: true,
      orderId: order.id,
      wcOrderId: wcId,
      status: order.status,
      createdAt: order.createdAt,
      pickOrders: order.pickOrders.map((p: any) => ({
        id: p.id,
        storeCode: p.store?.code,
        storeName: p.store?.name,
        status: p.status,
        trackingCode: p.trackingCode,
        carrier: p.carrier,
        isTransfer: p.isTransfer,
        transferToStoreCode: p.transferToStoreCode,
        issueReason: p.issueReason,
        issueNote: p.issueNote,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
      items: order.items.map((it: any) => ({
        id: it.id,
        sku: it.sku,
        quantity: it.quantity,
        assignedStoreCode: it.assignedStoreId ? storeMap.get(it.assignedStoreId)?.code : null,
        assignedStoreName: it.assignedStoreId ? storeMap.get(it.assignedStoreId)?.name : null,
      })),
      history: order.history.map((h: any) => ({
        id: h.id,
        createdAt: h.createdAt,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        note: h.note,
        userId: h.userId,
      })),
      // FLAGS DE RISCO
      activePickOrderCount: activePickOrders.length,
      hasDuplicateRisk: skuConflicts.length > 0,
      skuConflicts,
      summary: {
        totalSwaps: order.history.filter((h: any) => (h.note || '').toLowerCase().includes('swap')).length,
        totalItems: order.items.length,
        totalPickOrders: order.pickOrders.length,
        firstPickOrderStore: order.pickOrders[0]?.store?.name,
        lastPickOrderStore: order.pickOrders[order.pickOrders.length - 1]?.store?.name,
      },
    };
  }

  /**
   * GET /orders/pdv-online/abertos
   *
   * MUTIRÃO DA VENDA ONLINE (17/08) — pedidos nascidos de Venda Online do PDV
   * que ainda não fecharam, com o diagnóstico de CADA um.
   *
   * Por que existe: a loja fecha a venda no caixa, manda a peça pra cliente e
   * segue a vida — ninguém no balcão sabe que um pedido nasceu e foi pra fila
   * da matriz. Foi assim que o ON-000004 de Suzano passou o fim de semana
   * parado e na segunda foi roteado pra Sorocaba (150 km) pra separar uma
   * SEGUNDA peça, com o estoque de Suzano fantasma.
   *
   * `situacao` diz o que fazer com cada um:
   *   - 'roteado-pra-outra' → card numa loja que NÃO vendeu. É o caso grave:
   *     risco de peça dupla. Resolve com POST .../fechar-na-loja-vendedora.
   *   - 'na-fila'           → sem card nenhum, esperando a matriz. Se a loja já
   *     entregou, fecha; se não, roteia.
   *   - 'na-vendedora'      → card na própria loja que vendeu. Normal (retirada
   *     ou auto-atende), só precisa a loja bipar.
   */
  @Get('pdv-online/abertos')
  async pdvOnlineAbertos() {
    const pedidos = await (this.prisma as any).order.findMany({
      where: {
        source: 'pdv_online',
        status: { notIn: ['shipped', 'delivered', 'cancelled'] },
      },
      include: {
        items: { select: { sku: true, quantity: true, ref: true, cor: true, tamanho: true } },
        pickOrders: {
          select: { id: true, status: true, store: { select: { code: true, name: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const lojas = await (this.prisma as any).store.findMany({
      select: { code: true, name: true },
    });
    const nomePorCode = new Map<string, string>(
      lojas.map((s: any) => [String(s.code), String(s.name)]),
    );

    const agora = Date.now();
    const linhas = pedidos.map((p: any) => {
      const sellerCode = String(p.sellerStoreCode || '').trim() || null;
      const ativos = p.pickOrders.filter((po: any) =>
        ['new', 'separating'].includes(po.status),
      );
      const foraDaVendedora = ativos.filter(
        (po: any) => sellerCode && String(po.store?.code || '') !== sellerCode,
      );

      const situacao = !sellerCode
        ? 'sem-loja-vendedora'
        : foraDaVendedora.length > 0
          ? 'roteado-pra-outra'
          : ativos.length > 0
            ? 'na-vendedora'
            : 'na-fila';

      const criado = new Date(p.wcDateCreated ?? p.createdAt).getTime();
      return {
        wcOrderId: p.wcOrderId,
        wcOrderNumber: p.wcOrderNumber,
        status: p.status,
        situacao,
        // 'roteado-pra-outra' é o único que pode gerar peça dupla — a tela
        // ordena e pinta por aqui em vez de reimplementar a regra.
        risco: situacao === 'roteado-pra-outra',
        diasAberto: Math.floor((agora - criado) / 86_400_000),
        criadoEm: new Date(criado).toISOString(),
        lojaVendedora: sellerCode
          ? { code: sellerCode, name: nomePorCode.get(sellerCode) ?? sellerCode }
          : null,
        lojasComCard: ativos.map((po: any) => ({
          code: po.store?.code ?? null,
          name: po.store?.name ?? null,
          status: po.status,
        })),
        entrega: p.shippingMethod ?? null,
        isPickup: !!p.isPickup,
        cliente: p.customerName ?? null,
        cidade: (() => {
          try {
            const end = JSON.parse(p.shippingAddress || '{}');
            return [end.city, end.state].filter(Boolean).join('/') || null;
          } catch {
            return null;
          }
        })(),
        total: Number(p.totalAmount ?? 0),
        pecas: p.items.length,
      };
    });

    // Risco primeiro, depois o que está parado há mais tempo.
    linhas.sort(
      (a: any, b: any) => Number(b.risco) - Number(a.risco) || b.diasAberto - a.diasAberto,
    );

    return {
      total: linhas.length,
      comRisco: linhas.filter((l: any) => l.risco).length,
      naFila: linhas.filter((l: any) => l.situacao === 'na-fila').length,
      pedidos: linhas,
    };
  }

  /**
   * PATCH /orders/wc/:wcId/entrega { tipo, storeCode? }
   *
   * TROCAR A FORMA DE ENTREGA de um pedido já criado (17/08). O "Corrigir"
   * da tela só editava endereço; forma de entrega não tinha conserto por
   * tela nenhuma. Caso ON-000006: nasceu "Entrega (não informada)" (o
   * entregaTipo do PDV não gravou) pra cliente que ia RETIRAR em São José
   * dos Campos — a matriz não tinha como dizer isso ao pedido, e sem
   * `pickupStoreCode` a engine ia mandar as 11 peças pra cliente pelos
   * Correios em pacotes separados.
   *
   * `tipo`: sedex | pac | motoboy | retirada. `storeCode` = loja que atende
   * (obrigatório pra retirada; opcional pra motoboy). Atualiza o Order
   * (shippingMethod/isPickup/pickupStoreCode) E o checkoutInfo.shipping —
   * o banner da tela lê o checkoutInfo primeiro.
   *
   * Roteamento depois da troca:
   *   - card ativo (new/separating) em alguma loja → recalcula (o recalcular
   *     apaga os ativos e re-roteia lendo o pickupStoreCode novo);
   *   - sem card e trava numa loja (retirada/motoboy) → roteia NA HORA,
   *     igual ao pedido online nascendo (engine determinística);
   *   - sem card, SEDEX/PAC → fica pra matriz, como sempre.
   * RECUSA se algum card já passou de "separando": peça já saiu, trocar a
   * entrega agora é decisão de gente.
   */
  @Patch('wc/:wcId/entrega')
  async trocarEntrega(
    @Req() req: any,
    @Param('wcId') wcId: string,
    @Body() body: { tipo: string; storeCode?: string | null },
  ) {
    const wcOrderId = Number(wcId);
    if (!wcOrderId || isNaN(wcOrderId)) throw new BadRequestException('wcOrderId inválido');

    const tipo = String(body?.tipo || '').trim().toLowerCase();
    const FORMAS: Record<string, { id: string; kind: string; label: string; pickup: boolean }> = {
      sedex: { id: 'sedex', kind: 'correios', label: 'SEDEX', pickup: false },
      pac: { id: 'pac', kind: 'correios', label: 'PAC', pickup: false },
      motoboy: { id: 'motoboy', kind: 'motoboy', label: 'MOTOBOY', pickup: false },
      retirada: { id: 'retirada', kind: 'pickup', label: 'RETIRADA NA LOJA', pickup: true },
    };
    const forma = FORMAS[tipo];
    if (!forma) throw new BadRequestException('Forma inválida (use sedex, pac, motoboy ou retirada)');

    const order: any = await (this.prisma as any).order.findFirst({
      where: { wcOrderId },
      include: { pickOrders: { select: { id: true, status: true, trackingCode: true, carrier: true } } },
    });
    if (!order) throw new BadRequestException(`Pedido ${wcId} não encontrado`);
    if (['shipped', 'delivered', 'cancelled'].includes(String(order.status))) {
      throw new BadRequestException(`Pedido já está ${order.status} — não dá pra trocar a entrega`);
    }
    const picks: any[] = order.pickOrders || [];
    const avancados = picks.filter((p: any) => !['new', 'separating'].includes(p.status));
    /**
     * SEDEX ↔ PAC CONTINUA PERMITIDO ATÉ A CAIXA SAIR (24/08/2026).
     *
     * A trava era "passou de separando, não mexe" — o que é certo pra RETIRADA
     * e MOTOBOY (mudam quem atende e refazem o roteamento) e exagerado pra
     * SEDEX↔PAC: trocar o serviço não move peça nenhuma, só muda o que vai
     * escrito na etiqueta. No ON-000105 a matriz precisou trocar o serviço com
     * a peça já separada e a tela respondeu 400 — a correção teve que ser
     * feita à mão no banco, que é o tipo de conserto que não escala pra loja.
     *
     * Régua nova: enquanto NADA foi postado (`shipped`), trocar entre serviços
     * dos Correios passa — e sem re-rotear, porque a separação já está pronta
     * onde está. Postou, acabou: aí é decisão de gente, não de tela.
     */
    const jaPostado = picks.some((p: any) => String(p.status) === 'shipped');
    const eraCorreios =
      !order.isPickup && !/motoboy|moto boy/i.test(String(order.shippingMethod || ''));
    const soTrocaDeServico = (tipo === 'sedex' || tipo === 'pac') && eraCorreios && !jaPostado;
    if (avancados.length > 0 && !soTrocaDeServico) {
      throw new BadRequestException(
        `${avancados.length} separação(ões) já passaram de "separando" (${[...new Set(avancados.map((a: any) => a.status))].join(', ')}). ` +
          'A peça já saiu — trocar a entrega agora não é conserto de sistema.',
      );
    }

    // Loja que atende: retirada EXIGE (a cliente busca em algum lugar);
    // motoboy é opcional (sem loja = a engine escolhe por estoque).
    const storeCode = String(body?.storeCode || '').trim();
    let loja: any = null;
    if (forma.pickup || (tipo === 'motoboy' && storeCode)) {
      if (!storeCode) throw new BadRequestException('Retirada precisa da loja onde a cliente busca');
      loja = await (this.prisma as any).store.findFirst({ where: { code: storeCode, active: true } });
      if (!loja) throw new BadRequestException(`Loja ${storeCode} não existe ou está inativa`);
    }
    const label = forma.pickup && loja ? `${forma.label} — ${loja.name}` : forma.label;

    // checkoutInfo.shipping é o que o banner/etiqueta leem primeiro.
    let ck: any = {};
    try { ck = order.checkoutInfo ? JSON.parse(order.checkoutInfo) : {}; } catch { ck = {}; }
    const antes = ck?.shipping?.label ?? order.shippingMethod ?? 'não informada';
    ck.shipping = {
      ...(ck.shipping || {}),
      id: forma.id,
      kind: forma.kind,
      label,
      price: Number(ck?.shipping?.price ?? 0),
    };

    await (this.prisma as any).order.update({
      where: { id: order.id },
      data: {
        shippingMethod: label,
        isPickup: forma.pickup,
        pickupStoreCode: loja ? loja.code : null,
        checkoutInfo: JSON.stringify(ck),
      },
    });
    await (this.prisma as any).orderHistory
      .create({
        data: {
          orderId: order.id,
          userId: req?.user?.id ?? null,
          fromStatus: order.status,
          toStatus: order.status,
          note: `Entrega trocada: ${antes} → ${label}${loja ? ` (loja que atende: ${loja.name})` : ''}.`,
        },
      })
      .catch(() => null);

    // Roteamento coerente com a entrega nova. Quando é só troca de serviço
    // com peça JÁ SEPARADA, ninguém re-roteia: recalcular apagaria um card
    // pronto pra refazer a mesma separação.
    const ativos = picks.filter((p: any) => ['new', 'separating'].includes(p.status));
    const congelado = soTrocaDeServico && avancados.length > 0;
    let roteamento: any = { acao: congelado ? 'nenhuma (peça já separada)' : 'nenhuma' };
    try {
      if (congelado) {
        /* separação pronta: só o rótulo do envio mudou */
      } else if (ativos.length > 0) {
        const r: any = await this.routing.recalculateForWc(order.id);
        roteamento = { acao: 'recalculado', ok: !!r?.ok, detalhe: r?.message ?? null };
      } else if (loja) {
        const preview: any = await this.routing.previewRoute(order.id);
        const r: any = await this.routing.confirmRoute(order.id, preview);
        roteamento = { acao: 'roteado', ok: !!r?.persisted, estrategia: preview?.strategy ?? null };
      }
    } catch (e: any) {
      roteamento = { acao: ativos.length > 0 ? 'recalculado' : 'roteado', ok: false, detalhe: e?.message || String(e) };
    }

    /**
     * ETIQUETA VELHA NA MÃO: a pré-postagem já gerada carrega o serviço
     * ANTIGO. Trocar o pedido não troca o papel — quem gerou tem que Reabrir
     * pra cancelar e emitir de novo, senão a caixa sai com o serviço errado
     * mesmo com a tela dizendo o certo.
     */
    const comEtiqueta = picks.filter((p: any) => p.trackingCode);
    const aviso = comEtiqueta.length
      ? `Já existe etiqueta gerada (${comEtiqueta
          .map((p: any) => `${p.carrier || 'etiqueta'} ${p.trackingCode}`)
          .join(', ')}). Ela ainda está com a entrega antiga — use "Reabrir" no card pra cancelar e gerar de novo.`
      : null;

    return {
      ok: true,
      shippingMethod: label,
      isPickup: forma.pickup,
      pickupStoreCode: loja?.code ?? null,
      pickupStoreName: loja?.name ?? null,
      roteamento,
      aviso,
    };
  }

  /**
   * POST /orders/wc/:wcId/fechar-na-loja-vendedora
   *
   * A loja que VENDEU já entregou: cancela card indevido, baixa o estoque nela
   * e fecha o pedido. Ver `RoutingService.fecharNaLojaPedinte` pro porquê.
   */
  @Post('wc/:wcId/fechar-na-loja-vendedora')
  async fecharNaLojaVendedora(@Req() req: any, @Param('wcId') wcId: string) {
    const wcOrderId = Number(wcId);
    if (!wcOrderId || isNaN(wcOrderId)) {
      throw new BadRequestException('wcOrderId inválido');
    }
    const local = await (this.prisma as any).order.findFirst({
      where: { wcOrderId },
      select: { id: true },
    });
    if (!local) throw new BadRequestException(`Pedido ${wcId} não encontrado`);
    return this.routing.fecharNaLojaPedinte(local.id, req?.user?.id);
  }

  /** Contadores por status (pra renderizar os filtros com número exato do WC). */
  @Get('wc/counts')
  async wcCounts() {
    const totals = this.separacaoComWoo ? await this.wc.countByStatus() : [];
    const byStatus: Record<string, { name: string; total: number }> = {};
    let grand = 0;
    for (const t of totals) {
      byStatus[t.slug] = { name: t.name, total: t.total };
      grand += t.total;
    }
    /**
     * Soma os pedidos NATIVOS do Flow (live + site novo) nos badges das abas.
     *
     * Usa `STATUS_LOCAL_POR_ABA`, o MESMO mapa da lista — antes daqui o
     * contador só somava `live` e a aba dizia "Processando 2" com 5 pedidos na
     * tela, porque os 3 do site novo entravam na lista e não no número.
     */
    try {
      const locais = await (this.prisma as any).order.groupBy({
        by: ['status'],
        where: { source: { in: ORIGENS_NATIVAS } },
        _count: { _all: true },
      });
      const porStatus = new Map<string, number>();
      for (const c of locais) porStatus.set(c.status, c._count._all);

      for (const [slug, statuses] of Object.entries(STATUS_LOCAL_POR_ABA)) {
        const n = statuses.reduce((s, st) => s + (porStatus.get(st) ?? 0), 0);
        if (!n) continue;
        byStatus[slug] = { name: byStatus[slug]?.name ?? slug, total: (byStatus[slug]?.total ?? 0) + n };
        // 'separacao' e 'em-separacao' são a MESMA aba com dois slugs — somar
        // os dois no grand total contaria o pedido duas vezes.
        if (slug !== 'em-separacao') grand += n;
      }

      /**
       * "Em trânsito" e "Concluídos" contam pelo MESMO `where` da lista.
       *
       * Um `groupBy` por status não serve pras duas: elas dependem de ter
       * rastreio e de estar dentro da janela de 30 dias — e badge que discorda
       * da lista é o defeito de 13/08 se repetindo ("Processando 2" com 5
       * pedidos na fila). Duas contagens a mais por ciclo de 30s é barato
       * perto de a operação achar que perdeu pedido.
       */
      const [emTransito, concluidosNativos, prontoPostar, emSeparacao] = await Promise.all([
        (this.prisma as any).order.count({ where: whereNativoDaAba('em-transito')! }),
        (this.prisma as any).order.count({
          where: { AND: [{ source: { in: ORIGENS_NATIVAS } }, whereNativoDaAba('completed')!] },
        }),
        (this.prisma as any).order.count({
          where: { AND: [{ source: { in: ORIGENS_NATIVAS } }, whereNativoDaAba('pronto-postar')!] },
        }),
        (this.prisma as any).order.count({
          where: { AND: [{ source: { in: ORIGENS_NATIVAS } }, whereNativoDaAba('separacao')!] },
        }),
      ]);
      byStatus['em-transito'] = { name: 'Em trânsito', total: emTransito };
      grand += emTransito;
      /**
       * "Pronto pra postar" REPARTE o número de "Em separação", não soma.
       *
       * O laço acima já contou todo `separating` uma vez, dentro de
       * `separacao` — e as duas abas são complementares. Recalcular as duas
       * pelo MESMO `where` da lista mantém badge e tela dizendo a mesma coisa
       * (o defeito de 13/08), e o `grand` fica intacto porque a soma das duas
       * é exatamente o que ele já tem.
       */
      const wcSeparacao = totals.find((t: any) => t.slug === 'separacao')?.total ?? 0;
      byStatus['pronto-postar'] = { name: 'Pronto pra postar', total: prontoPostar };
      byStatus['separacao'] = {
        name: byStatus['separacao']?.name ?? 'Em separação',
        total: wcSeparacao + emSeparacao,
      };
      byStatus['em-separacao'] = byStatus['separacao'];
      // `completed` já pode ter vindo do laço acima (delivered) — aqui ele é
      // recalculado pela regra completa e substitui aquele número.
      byStatus['completed'] = {
        name: byStatus['completed']?.name ?? 'completed',
        total: (totals.find((t: any) => t.slug === 'completed')?.total ?? 0) + concluidosNativos,
      };
    } catch { /* badge sem pedido nativo é melhor que quebrar a tela */ }
    return { byStatus, grand };
  }

  /**
   * Conta pedidos com status=completed que foram concluídos HOJE (modified_after).
   * O WC marca como "completed" quando a baixa do pedido é confirmada — então
   * filtramos por modified_after = hoje 00:00 (timezone do servidor).
   *
   * Estratégia: pedimos só 1 item (per_page=1) e lemos o header x-wp-total.
   * Custo: 1 request HTTP, sem baixar dados.
   */
  @Get('wc/completed-today')
  async wcCompletedToday() {
    const start = startOfDayBR();
    const res = await this.wc.listOrders({
      status: 'completed',
      perPage: 1,
      page: 1,
      modifiedAfter: start.toISOString(),
    });
    return { total: res.total, since: start.toISOString() };
  }

  /**
   * Detalhe do pedido do SITE NOVO, montado do banco — nunca do WooCommerce.
   *
   * Devolve exatamente o shape que a tela de pedido já consome (o mesmo do
   * pedido da live), pra retaguarda não precisar saber de onde o pedido veio.
   *
   * Fonte dos valores: `checkoutInfo`, o snapshot gravado no fechamento. Ele
   * tem endereço no formato original, frete escolhido e os descontos
   * DISCRIMINADOS (cupom e Pix separados) — que é o que a conferência de caixa
   * precisa e o `Order` não tem coluna pra guardar.
   */
  private async detalheEcommerce(pedido: any) {
    const ler = (raw: any) => {
      if (!raw) return {};
      if (typeof raw === 'object') return raw;
      try {
        return JSON.parse(String(raw));
      } catch {
        return {};
      }
    };

    const ck: any = ler(pedido.checkoutInfo);
    const pi: any = ler(pedido.paymentInfo);
    const enderecoWc: any = ler(pedido.shippingAddress);

    /** Vocabulário da operação → slug que a tela de pedido entende. */
    /**
     * Status interno → slug que a TELA fala (vocabulário do WooCommerce).
     *
     * ⚠️ `pending` é ambíguo de nascença: no enum quer dizer "aguardando
     * pagamento", mas o roteamento também usava a palavra pra dizer "voltou
     * pra fila" — e aí um pedido PAGO aparecia como "Pagamento pendente" e a
     * tela travava a separação (LP-000161, 24/08). O `recalculateForWc` passou
     * a gravar `awaiting_stock`; aqui ele entra junto de `routing` como
     * "Processando" — pago, sem card, esperando estoque.
     */
    const STATUS_SLUG: Record<string, string> = {
      awaiting_payment: 'pending',
      processing: 'processing',
      routing: 'processing',
      awaiting_stock: 'processing',
      separating: 'separacao',
      shipped: 'completed',
      delivered: 'completed',
      pending: 'pending',
      cancelled: 'cancelled',
    };

    const rastreio = (pedido.pickOrders || []).find((p: any) => p.trackingCode);
    const lojas = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true },
    });

    /**
     * REF · COR · TAMANHO dos itens. Desde 13/08 são colunas do `OrderItem`;
     * pedido anterior a isso não tem — e aí o snapshot do checkout salva, que
     * guarda `productId` (= a REF que o carrinho manda), `color` e `size`.
     * Sem esse fallback, os pedidos que já existem ficariam com a coluna vazia
     * justamente na tela em que o dono foi olhar.
     */
    const doSnapshot = new Map<string, { ref: string | null; cor: string | null; tamanho: string | null }>();
    for (const it of (ck.items || []) as any[]) {
      const chave = String(it?.sku || '').trim();
      if (!chave || doSnapshot.has(chave)) continue;
      doSnapshot.set(chave, {
        ref: it?.ref || it?.productId || null,
        cor: it?.color || null,
        tamanho: it?.size || null,
      });
    }

    const pagamento =
      pi.method === 'card'
        ? `Cartão de crédito${pi.installments ? ` (${pi.installments}x)` : ''}`
        : pi.method === 'pix'
          ? 'PIX'
          : 'Site';

    /**
     * A NOTA vira o lugar de mostrar o que foi descontado. Sem isso, quem
     * confere o caixa vê "R$ 79,90" e não tem como saber que houve 5% de Pix —
     * e some com a diferença procurando erro que não existe.
     */
    const notas: string[] = [];
    if (ck.couponCode) notas.push(`Cupom ${ck.couponCode}: −${this.reaisBr(ck.descontoCupom)}`);
    if (Number(ck.descontoPix) > 0) notas.push(`Desconto Pix: −${this.reaisBr(ck.descontoPix)}`);

    // QUAL FILIAL PEDIU — só o pedido nascido no PDV tem loja pedinte
    // (`sellerStoreCode`). O nome vem da lista de lojas ativas; se a loja
    // saiu do ar, o código ainda identifica de onde veio.
    const codigoPedinte = pedido.sellerStoreCode ?? ck.sellerStoreCode ?? null;
    const lojaPedinte = codigoPedinte
      ? {
          code: String(codigoPedinte),
          name:
            lojas.find((s) => s.code === String(codigoPedinte))?.name ??
            ck.sellerStoreName ??
            String(codigoPedinte),
        }
      : null;

    /**
     * DE ONDE VEIO A CLIENTE — o pedido nativo é o único que tem a história
     * inteira: as colunas `utm_*` (gravadas no fechamento) mais o
     * `trackingInfo.attribution`, que guarda o que elas não têm (posicionamento
     * do anúncio, página de entrada, fbclid).
     */
    const atribuicao = await this.cascataAtribuicao({
      utmSource: pedido.utmSource,
      utmMedium: pedido.utmMedium,
      utmCampaign: pedido.utmCampaign,
      utmId: pedido.utmId,
      utmContent: pedido.utmContent,
      trackingInfo: ler(pedido.trackingInfo),
      // Venda online do PDV não veio de anúncio nenhum — veio da vendedora.
      origemFixa: lojaPedinte ? `Venda online da loja ${lojaPedinte.name}` : null,
    });

    return {
      id: pedido.wcOrderId,
      number: pedido.wcOrderNumber,
      status: STATUS_SLUG[pedido.status] ?? pedido.status,
      dateCreatedGmt: (pedido.wcDateCreated ?? pedido.createdAt)?.toISOString?.() ?? null,
      dateModifiedGmt: pedido.updatedAt?.toISOString?.() ?? null,
      total: String(pedido.totalAmount ?? 0),
      currency: 'BRL',
      paymentMethodTitle: pagamento,
      customerNote: notas.join(' · '),
      billing: {
        first_name: String(pedido.customerName || '').split(' ')[0] || '',
        last_name: String(pedido.customerName || '').split(' ').slice(1).join(' '),
        email: pedido.customerEmail || '',
        phone: pedido.customerPhone || '',
      },
      // O `shippingAddress` do Order já está no shape do WooCommerce — é o que
      // a etiqueta e a separação leem. Não desmontar aqui.
      shipping: enderecoWc,
      customerCpf: pedido.customerCpf || '',
      lineItems: (pedido.items || []).map((it: any) => {
        const snap = doSnapshot.get(String(it.sku || '').trim());
        return {
          id: it.id,
          name: it.productName,
          sku: it.sku,
          ref: it.ref || snap?.ref || null,
          cor: it.cor || snap?.cor || null,
          tamanho: it.tamanho || snap?.tamanho || null,
          quantity: it.quantity,
          total: String((it.unitPrice ?? 0) * (it.quantity ?? 1)),
          price: it.unitPrice,
          image: null,
        };
      }),
      shippingLines: [
        {
          method: ck.shipping?.label ?? pedido.shippingMethod ?? 'Entrega',
          total: String(ck.shipping?.price ?? ck.shippingPrice ?? 0),
        },
      ],
      tracking: {
        number: rastreio?.trackingCode ?? pedido.trackingCode ?? '',
        carrier: rastreio?.carrier ?? pedido.carrier ?? '',
        url: '',
      },
      pickup: {
        isPickup: !!pedido.isPickup,
        storeCode: pedido.pickupStoreCode ?? null,
        storeName: pedido.pickupStoreCode
          ? lojas.find((s) => s.code === pedido.pickupStoreCode)?.name ?? null
          : null,
        shippingMethodTitle: pedido.shippingMethod ?? 'Entrega',
        unresolvedCityName: null,
      },
      attribution: {
        origem: lojaPedinte ? `Loja ${lojaPedinte.name}` : 'Site',
        source: lojaPedinte
          ? `Venda online da loja${ck.vendedora ? ` · ${ck.vendedora}` : ''}`
          : [pedido.utmSource, pedido.utmMedium, pedido.utmCampaign]
              .filter(Boolean)
              .join(' / ') || '(Site) (direto)',
      },
      atribuicao,
      /**
       * DE ONDE VEIO O PEDIDO (14/08). Pedido do site não tem loja pedinte —
       * o do PDV tem, e sem mostrar isso a matriz abria o pedido sem saber
       * QUEM vendeu (a loja que separa pode ser outra, e é ela que cobra
       * desta no acerto). NULL = pedido do site, como sempre foi.
       */
      origemLoja: lojaPedinte
        ? {
            code: lojaPedinte.code,
            name: lojaPedinte.name,
            vendedora: ck.vendedora ?? null,
          }
        : null,
      sellerId: pedido.sellerId ?? null,
      sellerName: pedido.sellerName ?? null,
      /**
       * O DINHEIRO ENTROU? — a MESMA régua dos relatórios (`pedidoPago`).
       *
       * Existe porque a palavra do status não decide isso sozinha: a tela
       * bloqueava a separação por status, e um pedido pago que voltou pra fila
       * de roteamento (`pending`/`awaiting_stock`) virava "PAGAMENTO NÃO
       * CONFIRMADO" com o PIX já na conta (LP-000161, 24/08). Quem manda é o
       * carimbo `paidAt` do gateway.
       */
      pago: pedidoPago(pedido),
      paidAt: pedido.paidAt?.toISOString?.() ?? null,
      // Item vive no Postgres → a tela pode oferecer "Trocar" por item.
      canEditItems: true,
    };
  }

  /** R$ com vírgula — só pra texto de nota, não pra conta. */
  private reaisBr(v: any): string {
    return `R$ ${(Number(v) || 0).toFixed(2).replace('.', ',')}`;
  }

  /**
   * DE QUAL CAMPANHA VEIO ESTE PEDIDO — a cascata que a tela abre no clique.
   *
   * Só faz uma coisa a mais que a função pura: buscar o nome ATUAL da campanha
   * no espelho de gasto (`meta_ads_gasto_dia`), pelo `utm_id`. É o que conserta
   * o rótulo do pedido cuja campanha foi renomeada no Gerenciador depois de já
   * ter vendido — o id é imutável, o nome não (mesma regra do MetaAdsGastoDia).
   */
  private async cascataAtribuicao(entrada: EntradaAtribuicao) {
    let nomeOficial: string | null = null;
    const id = String(entrada.utmId ?? '').trim();
    if (id) {
      const gasto = await (this.prisma as any).metaAdsGastoDia
        .findFirst({
          where: { campanhaId: id, campanhaNome: { not: null } },
          orderBy: { dia: 'desc' },
          select: { campanhaNome: true },
        })
        .catch(() => null);
      nomeOficial = gasto?.campanhaNome ?? null;
    }
    return montarCascataAtribuicao({ ...entrada, nomeOficial });
  }

  /**
   * O pedido NASCEU AQUI e não existe no WooCommerce?
   *
   * Duas origens usam `wcOrderId` sintético só pra caber no campo `@unique Int`
   * herdado do WC: a **live** (faixa 900M) e o **site novo** (950M). Nenhuma
   * das duas pode ser buscada no WooCommerce — lá é 404, o axios estoura e a
   * tela mostra "500: Internal server error".
   *
   * ⚠️ Existe porque a regra estava ESPALHADA como `source === 'live'` em
   * cinco lugares deste arquivo. Quando a segunda faixa nasceu, quatro deles
   * não foram atualizados — e o primeiro pedido real do site apareceu na fila
   * de separação sem conseguir ser aberto nem separado.
   *
   * Origem sintética nova entra AQUI, num lugar só.
   */
  private origemSintetica(source?: string | null): boolean {
    return ORIGENS_NATIVAS.includes(String(source || ''));
  }

  /** Detalhe de 1 pedido direto do WC. */
  @Get('wc/:wcId')
  async wcGetOne(@Param('wcId') wcId: string) {
    // Pedido da LIVE: monta o MESMO payload de detalhe a partir do Order local
    // (wcOrderId sintético — não existe no WooCommerce; buscar lá dava 500).
    const liveLocal = await (this.prisma as any).order.findUnique({
      where: { wcOrderId: Number(wcId) },
      include: {
        items: true,
        pickOrders: { select: { trackingCode: true, carrier: true } },
      },
    });

    /**
     * ⚠️ PEDIDO DO SITE NOVO (`source='ecommerce'`, faixa 950M) — corrigido
     * 06/08, com o primeiro pedido real na tela.
     *
     * A guarda logo abaixo cobria só `source === 'live'`. O pedido do
     * e-commerce tem wcOrderId sintético pelo MESMO motivo (faixa 950M em vez
     * de 900M) e caía direto no `wc.getOrder()` — o WooCommerce responde 404,
     * o axios estoura, e a tela mostra "500: Internal server error".
     *
     * Sintoma exato: o pedido APARECE na fila de separação (a lista lê o
     * banco), mas não abre. Ou seja, a retaguarda enxerga o pedido e não
     * consegue trabalhar nele — sem etiqueta e sem NF-e.
     *
     * O comentário acima já avisava ("buscar lá dava 500"); faltou estender a
     * regra quando a segunda faixa sintética nasceu.
     */
    if (liveLocal && (liveLocal.source === 'ecommerce' || liveLocal.source === 'pdv_online')) {
      // 'pdv_online' grava checkoutInfo no MESMO shape do e-commerce — o
      // detalhe local serve pros dois (buscar no WC daria o mesmo 500 da live).
      return this.detalheEcommerce(liveLocal);
    }

    if (liveLocal?.source === 'live') {
      let addr: any = {};
      try { addr = JSON.parse(liveLocal.shippingAddress || '{}'); } catch {}
      const liveCart = liveLocal.liveCartId
        ? await (this.prisma as any).livePdvCart
            .findUnique({ where: { id: liveLocal.liveCartId }, select: { freteCents: true, customerInstagram: true } })
            .catch(() => null)
        : null;
      const STATUS_SLUG: Record<string, string> = {
        processing: 'processing',
        routing: 'processing',
        awaiting_stock: 'processing', // pago, sem card — ver o mapa do e-commerce
        separating: 'separacao',
        shipped: 'completed',
        delivered: 'completed',
        pending: 'pending',
        cancelled: 'cancelled',
      };
      const track = (liveLocal.pickOrders || []).find((p: any) => p.trackingCode);
      const stores = await this.prisma.store.findMany({
        where: { active: true },
        select: { code: true, name: true },
      });
      return {
        id: liveLocal.wcOrderId,
        number: liveLocal.wcOrderNumber,
        status: STATUS_SLUG[liveLocal.status] ?? liveLocal.status,
        dateCreatedGmt: (liveLocal.wcDateCreated ?? liveLocal.createdAt)?.toISOString?.() ?? null,
        dateModifiedGmt: liveLocal.updatedAt?.toISOString?.() ?? null,
        total: String(liveLocal.totalAmount ?? 0),
        currency: 'BRL',
        paymentMethodTitle: 'PIX (Live Commerce)',
        customerNote: liveCart?.customerInstagram ? `Instagram: @${liveCart.customerInstagram}` : '',
        billing: {
          first_name: liveLocal.customerName || '',
          last_name: '',
          email: liveLocal.customerEmail || '',
          phone: liveLocal.customerPhone || '',
        },
        shipping: addr,
        customerCpf: liveLocal.customerCpf || '',
        lineItems: (liveLocal.items || []).map((it: any) => ({
          id: it.id,
          name: it.productName,
          sku: it.sku,
          ref: it.ref ?? null,
          cor: it.cor ?? null,
          tamanho: it.tamanho ?? null,
          quantity: it.quantity,
          total: String((it.unitPrice ?? 0) * (it.quantity ?? 1)),
          price: it.unitPrice,
          image: null,
        })),
        shippingLines: [
          {
            method: liveLocal.shippingMethod ?? 'LIVE',
            total: liveCart ? String((liveCart.freteCents || 0) / 100) : '0',
          },
        ],
        tracking: {
          number: track?.trackingCode ?? '',
          carrier: track?.carrier ?? '',
          url: '',
        },
        pickup: {
          isPickup: !!liveLocal.isPickup,
          storeCode: liveLocal.pickupStoreCode ?? null,
          storeName: liveLocal.pickupStoreCode
            ? stores.find((s) => s.code === liveLocal.pickupStoreCode)?.name ?? null
            : null,
          shippingMethodTitle: liveLocal.shippingMethod ?? 'LIVE',
          unresolvedCityName: null,
        },
        attribution: { origem: 'Live Commerce', source: '(Live) ()' },
        atribuicao: montarCascataAtribuicao({ origemFixa: 'Live Commerce' }),
        sellerId: liveLocal.sellerId ?? null,
        sellerName: liveLocal.sellerName ?? null,
        // O dinheiro entrou? — mesma régua do e-commerce (ver `detalheEcommerce`).
        pago: pedidoPago(liveLocal),
        paidAt: liveLocal.paidAt?.toISOString?.() ?? null,
        // Item vive no Postgres → a tela pode oferecer "Trocar" por item.
        canEditItems: true,
      };
    }

    const o = await this.wc.getOrder(Number(wcId));

    const getMeta = (key: string) => {
      const m = (o.meta_data ?? []).find((x: any) => x?.key === key);
      return m ? String(m.value ?? '') : '';
    };

    const attribution = extractAttribution(o.meta_data ?? []);
    const customerCpf = extractCpf(o);

    // Detecta retirada em loja (pra UI mostrar badge + destacar loja)
    const activeStores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
    });
    const pickup = detectPickup(o, activeStores);

    // Vendedora atribuída (cache denormalizado) + a atribuição de marketing.
    // O UTM sai daqui, não do WooCommerce: o sync já copiou o
    // `_wc_order_attribution_*` pras colunas do Order, e é ele que o relatório
    // de campanhas usa — ler os dois lugares só criaria chance de divergir.
    const localOrder = await this.prisma.order.findFirst({
      where: { wcOrderId: Number(wcId) },
      select: {
        sellerId: true,
        sellerName: true,
        utmSource: true,
        utmMedium: true,
        utmCampaign: true,
        utmId: true,
        utmContent: true,
      },
    });

    // ⚠️ O WOOCOMMERCE ACABOU (última venda por lá em 19/08/2026, virada pro
    // site novo). Este caminho só existe pros ~22 mil pedidos históricos, e a
    // atribuição deles vive NO NOSSO Postgres — o sync já tinha copiado o
    // `_wc_order_attribution_*` pras colunas `utm_*` do Order. Ler o
    // `meta_data` de volta seria depender de um site que não responde mais.
    const atribuicao = await this.cascataAtribuicao({
      utmSource: localOrder?.utmSource,
      utmMedium: localOrder?.utmMedium,
      utmCampaign: localOrder?.utmCampaign,
      utmId: localOrder?.utmId,
      utmContent: localOrder?.utmContent,
      // Pedido velho não tem `trackingInfo` — isso nasceu com o site novo.
      // Sem UTM gravado, a cascata diz "sem campanha" em vez de inventar.
    });

    return {
      id: o.id,
      number: o.number,
      status: o.status,
      dateCreatedGmt: o.date_created_gmt ?? o.date_created,
      dateModifiedGmt: o.date_modified_gmt ?? o.date_modified,
      total: o.total,
      currency: o.currency,
      paymentMethodTitle: o.payment_method_title,
      customerNote: o.customer_note,
      billing: o.billing ?? {},
      shipping: o.shipping ?? {},
      customerCpf,
      lineItems: (o.line_items ?? []).map((li: any) => ({
        id: li.id,
        name: li.name,
        sku: li.sku,
        quantity: li.quantity,
        total: li.total,
        price: li.price,
        image: li.image?.src ?? null,
      })),
      shippingLines: (o.shipping_lines ?? []).map((sl: any) => ({
        method: sl.method_title,
        total: sl.total,
      })),
      tracking: {
        number: getMeta('_tracking_number'),
        carrier: getMeta('_tracking_carrier') || getMeta('_tracking_provider'),
        url: getMeta('_tracking_url'),
      },
      pickup: {
        isPickup: pickup.isPickup,
        storeCode: pickup.pickupStoreCode,
        storeName: pickup.pickupStoreCode
          ? activeStores.find((s) => s.code === pickup.pickupStoreCode)?.name ?? null
          : null,
        shippingMethodTitle: pickup.shippingMethodTitle,
        unresolvedCityName: pickup.unresolvedCityName ?? null,
      },
      attribution,
      atribuicao,
      sellerId: localOrder?.sellerId ?? null,
      sellerName: localOrder?.sellerName ?? null,
    };
  }

  /**
   * Atualiza um pedido no WooCommerce (grava direto no site).
   * Body: { status?, trackingNumber?, trackingCarrier?, trackingUrl?, customerNote?, addNote? }
   *
   * ⚠ Hook importante: quando status === 'separacao' e ainda NÃO existe pick-order
   * local, este endpoint dispara o roteamento automático (cria pick-order, aloca loja
   * e emite socket). Isso é fonte única — todos os caminhos do front (bulk WhatsApp,
   * botão individual, wa.me, mudança manual de status) passam por aqui e ganham o
   * registro de qual loja é responsável. Sem este hook, pedido vira "Separação" sem
   * loja associada e o painel "Status ao vivo" fica vazio.
   */
  /**
   * Corrige o ENDEREÇO DE ENTREGA do pedido.
   * PATCH /orders/wc/:wcId/endereco-entrega
   *
   * Rota própria, e não mais um campo no `PATCH wc/:wcId`: aquele sincroniza
   * status/rastreio com o WooCommerce, e endereço aqui é correção LOCAL do
   * snapshot que a etiqueta lê. Misturar os dois faria uma correção de
   * complemento disparar sync de pedido no site.
   */
  @Patch('wc/:wcId/endereco-entrega')
  async wcUpdateEndereco(
    @Param('wcId') wcId: string,
    @Body()
    body: {
      cep?: string; endereco?: string; numero?: string; complemento?: string;
      bairro?: string; cidade?: string; uf?: string; nome?: string; telefone?: string;
    },
    @Req() req: any,
  ) {
    return this.orders.atualizarEnderecoEntrega(Number(wcId), body, {
      userId: req?.user?.userId ?? req?.user?.sub ?? null,
      name: req?.user?.name ?? req?.user?.nome ?? req?.user?.username ?? null,
      storeCode: req?.user?.storeCode ?? null,
    });
  }

  @Patch('wc/:wcId')
  async wcUpdate(
    @Param('wcId') wcId: string,
    @Body()
    body: {
      status?: string;
      trackingNumber?: string;
      trackingCarrier?: string;
      trackingUrl?: string;
      customerNote?: string;
      addNote?: { text: string; notifyCustomer?: boolean };
    },
  ) {
    const wcOrderId = Number(wcId);

    /**
     * Pedido de origem SINTÉTICA (live 900M, site novo 950M): existe SÓ no
     * Flow — nunca toca o WooCommerce. As mesmas ações (gerar separação, nota)
     * são aplicadas localmente.
     *
     * ⚠️ 06/08: chamava-se `isLive` e testava só `'live'`. Com o pedido do site
     * novo, mudar o status tentaria escrever num pedido que o WooCommerce não
     * tem — 404 na escrita, e o status ficaria dessincronizado sem ninguém ver.
     * O nome mudou junto com a regra: `isLive` mentia sobre o que a variável é.
     */
    const localForSource = await (this.prisma as any).order.findUnique({
      where: { wcOrderId },
      select: { id: true, source: true, status: true },
    });
    const isLive = this.origemSintetica(localForSource?.source);

    /**
     * 🔴 PEDIDO QUE JÁ SAIU NÃO VOLTA PRO FLUXO (25/08/2026, dono).
     *
     * Este PATCH aceitava qualquer status em qualquer ordem. Mandar
     * `separacao` num pedido **já despachado** fazia DUAS coisas, nesta
     * sequência, e nenhuma com trava:
     *   1. `ensurePickOrdersForWc` CRIAVA card novo nas lojas — peça já postada
     *      voltando pra arara de alguém procurar;
     *   2. `aplicarStatusLocal` puxava o pedido de `shipped` de volta pra
     *      `separating`, ressuscitando ele na fila da matriz.
     *
     * Aconteceu com o LP-000210 em 24/08 18:46 (`shipped` → `separating`, nota
     * default = veio de um PATCH sem nota) — o pedido tinha sido concluído às
     * 18:34 e 12 minutos depois estava separando de novo. É a mesma família dos
     * 22 relançamentos de 24/08 que viraram separação fantasma; o `confirmRoute`
     * já recusava por lá, e esta porta continuava aberta.
     *
     * A volta legítima existe e tem porta própria: "Recalcular separação"
     * (`POST /orders/wc/:id/recalculate-separation`), que cancela os cards
     * antigos antes de reabrir. Aqui é status na mão, e status na mão não
     * desfaz postagem.
     */
    if (voltariaProFluxo(localForSource?.status, body.status)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[orders] PATCH recusado: pedido ${wcOrderId} está ${localForSource.status} e ` +
          `pediram status "${body.status}" — não devolve pedido postado pro fluxo.`,
      );
      return {
        ok: false,
        id: wcOrderId,
        status: localForSource.status,
        requestedStatus: body.status,
        statusApplied: false,
        warning: motivoDaRecusa(localForSource.status),
      };
    }

    // 1) Se está indo pra 'separacao', garante pick-orders criados ANTES.
    //    Se não conseguir (sem estoque etc), aborta sem mexer no WC — não faz
    //    sentido marcar "separação" se ninguém vai separar.
    let ensuredPickOrders: Array<{ id: string; storeCode: string; storeName: string }> | undefined;
    let alreadyHadPickOrders = false;
    if (body.status === 'separacao') {
      const ensured = await this.ensurePickOrdersForWc(wcOrderId);
      if (!ensured.ok) {
        return {
          ok: false,
          id: wcOrderId,
          status: null,
          requestedStatus: body.status,
          statusApplied: false,
          warning:
            `Não foi possível gerar a ordem de separação: ${ensured.message}. ` +
            `O status no site NÃO foi alterado. Abra o pedido e clique em "Gerar separação" ` +
            `pra ver o diagnóstico (SKU sem estoque, ruptura, etc).`,
        };
      }
      ensuredPickOrders = ensured.pickOrders;
      alreadyHadPickOrders = !!ensured.already;
    }

    if (isLive) {
      // TRAVA DO "CONCLUÍDO" NA MÃO (20/08 — caso ON-000049): marcado ENVIADO
      // com o card intocado e sem rastreio = pedido some das filas sem peça
      // sair. Só deixa concluir quando houve separação OU há rastreio (o caso
      // das LIVE presas que o fix de 17/08 destravou). Kill-switch:
      // conferenciaTravaLigada().
      const travaConcluido = await this.bloquearConcluidoSemSeparacao(wcOrderId, body.status);
      if (travaConcluido) {
        return {
          ok: false,
          id: wcOrderId,
          status: localForSource!.status,
          requestedStatus: body.status,
          statusApplied: false,
          warning: travaConcluido,
        };
      }
      // Nota vira histórico local; status já foi aplicado pelo confirmRoute
      // (processing→separating). Nada de WooCommerce.
      if (body.addNote?.text?.trim()) {
        await (this.prisma as any).orderHistory
          .create({
            data: {
              orderId: localForSource!.id,
              fromStatus: localForSource!.status,
              toStatus: localForSource!.status,
              note: body.addNote.text.trim(),
            },
          })
          .catch(() => {});
      }
      // Pedido da live/loja não tem WooCommerce pra recusar nada — o status
      // é aplicado aqui mesmo (cancelar mexe nas ordens de separação;
      // concluir/processar/separar só trocam o status do pedido).
      await this.cancelarLocalmente(wcOrderId, body.status);
      await this.aplicarStatusLocal(wcOrderId, body.status, body.addNote?.text);
      return {
        ok: true,
        id: wcOrderId,
        status: body.status ?? localForSource!.status,
        requestedStatus: body.status,
        statusApplied: true,
        pickOrdersCreated: ensuredPickOrders && !alreadyHadPickOrders ? ensuredPickOrders : undefined,
        pickOrdersAlreadyExisted: alreadyHadPickOrders,
      };
    }

    const updated = await this.wc.updateOrder(wcOrderId, {
      status: body.status,
      trackingNumber: body.trackingNumber,
      trackingCarrier: body.trackingCarrier,
      trackingUrl: body.trackingUrl,
      customerNote: body.customerNote,
    });

    if (body.addNote?.text?.trim()) {
      await this.wc.addOrderNote(wcOrderId, body.addNote.text, body.addNote.notifyCustomer ?? false);
    }

    const requestedStatus = body.status;
    const rejectedStatus = updated._flowops_statusRejected as string | undefined;
    const statusApplied = !requestedStatus || updated.status === requestedStatus;

    // CANCELAR/REEMBOLSAR não é só trocar um rótulo no site: o pedido tem que
    // SAIR DA FILA daqui e a loja tem que parar de separar. Sem isto o Flow
    // continuava mostrando o pedido em "Processando" e a ordem de separação
    // seguia viva na filial — alguém ia empacotar peça de pedido cancelado.
    if (statusApplied && !rejectedStatus) {
      await this.cancelarLocalmente(wcOrderId, requestedStatus);
    }

    let warning: string | undefined;
    if (rejectedStatus) {
      warning =
        `O status "${rejectedStatus}" NÃO existe no seu WooCommerce — o WP recusou. ` +
        `O tracking e/ou a nota foram salvos, mas o status continua "${updated.status}". ` +
        `Pra usar "Separação" você precisa registrar o slug "em-separacao" no site ` +
        `(plugin "WooCommerce Custom Order Status" ou registro via functions.php).` +
        (updated._flowops_apiError ? ` WC disse: ${updated._flowops_apiError}` : '');
    } else if (!statusApplied) {
      warning =
        `WooCommerce retornou status "${updated.status}" mas foi pedido "${requestedStatus}". ` +
        `Pode ser plugin bloqueando a transição ou permissão insuficiente da chave REST.`;
    }

    return {
      ok: statusApplied && !rejectedStatus,
      id: updated.id,
      status: updated.status,
      requestedStatus,
      statusApplied: statusApplied && !rejectedStatus,
      warning,
      pickOrdersCreated: ensuredPickOrders && !alreadyHadPickOrders ? ensuredPickOrders : undefined,
      pickOrdersAlreadyExisted: alreadyHadPickOrders,
    };
  }

  /**
   * Aplica o CANCELAMENTO no Flow quando o pedido é cancelado/reembolsado.
   *
   * Roda depois do WooCommerce aceitar (ou direto, no caso da live/loja, que
   * não tem WC). Faz três coisas, nesta ordem de importância:
   *   1. o pedido sai da fila local (status 'cancelled');
   *   2. as ordens de separação em aberto são canceladas — a loja para de
   *      separar peça de pedido morto;
   *   3. fica o registro no histórico do pedido.
   *
   * Nunca lança: o status já mudou no site, e derrubar a resposta aqui faria
   * parecer que o cancelamento falhou.
   */
  /**
   * "CONCLUIR" EM PEDIDO LOCAL ERA UM NO-OP QUE SE DIZIA SUCESSO (17/08).
   *
   * O ramo `isLive` devolvia `ok: true, statusApplied: true` mas só o
   * `cancelarLocalmente` mexia no banco — e ele sai no primeiro `if` pra
   * qualquer status que não seja cancelado/reembolsado. Resultado na tela:
   * a equipe selecionava os pedidos da live já enviados, clicava em
   * "Concluído", a lista sumia com eles… e no F5 estavam todos lá de novo.
   * Ficaram semanas presos na aba de separação (LIVE-137, 293, 260, 29,
   * todos com rastreio) porque nenhum clique surtia efeito.
   *
   * Aqui o slug da aba vira o status local equivalente. `on-hold` não tem
   * par local: fica como está (e a resposta continua honesta, ver abaixo).
   */
  /**
   * O "Concluído" manual pode rodar? Devolve a MENSAGEM do bloqueio quando
   * não pode (nenhuma peça separada e sem rastreio), ou null quando pode.
   */
  private async bloquearConcluidoSemSeparacao(
    wcOrderId: number,
    statusPedido?: string,
  ): Promise<string | null> {
    if (String(statusPedido || '').toLowerCase() !== 'completed') return null;
    if (!conferenciaTravaLigada()) return null;
    const gate = await (this.prisma as any).order.findUnique({
      where: { wcOrderId },
      select: { id: true, trackingCode: true, wcOrderNumber: true },
    });
    if (!gate) return null;
    if (String(gate.trackingCode || '').trim()) return null; // rastreio = saiu de verdade
    const picks: any[] = await (this.prisma as any).pickOrder.findMany({
      where: { orderId: gate.id },
      select: { status: true },
    });
    const nadaSeparado = picks.length === 0 || picks.every((p) => p.status === 'new');
    if (!nadaSeparado) return null;
    return (
      `Nenhuma peça do pedido ${gate.wcOrderNumber || wcOrderId} foi separada e não há rastreio — ` +
      `marcar CONCLUÍDO na mão esconderia o pedido das filas sem a peça ter saído (caso ON-000049). ` +
      `Separe pelo card da loja ou registre o envio; se a peça já saiu por fora, use o ` +
      `"fechar na loja vendedora" do pedido.`
    );
  }

  private async aplicarStatusLocal(wcOrderId: number, statusPedido?: string, nota?: string) {
    const s = String(statusPedido || '').toLowerCase();
    const mapa: Record<string, string> = {
      completed: 'shipped',
      separacao: 'separating',
      'em-separacao': 'separating',
      processing: 'processing',
    };
    const destino = mapa[s];
    if (!destino) return;
    try {
      const local = await (this.prisma as any).order.findUnique({
        where: { wcOrderId },
        select: { id: true, status: true },
      });
      if (!local || local.status === destino) return;
      // Rede de segurança da trava lá de cima (25/08): quem escreve o status
      // também recusa a marcha à ré. Se um caminho novo chamar isto sem passar
      // pela porta da frente, o pedido postado continua postado. Aqui o
      // parâmetro já é o status LOCAL (`separating`), não o slug da tela.
      if (
        ['shipped', 'delivered'].includes(local.status) &&
        ['separating', 'processing'].includes(destino)
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          `[orders] aplicarStatusLocal recusou ${local.status} → ${destino} no pedido ${wcOrderId}.`,
        );
        return;
      }
      await (this.prisma as any).order.update({
        where: { id: local.id },
        // Carimbo do despacho junto com o status — ver `common/janela-rastreio.ts`.
        data: { status: destino, ...(destino === 'shipped' ? { shippedAt: new Date() } : {}) },
      });
      await (this.prisma as any).orderHistory
        .create({
          data: {
            orderId: local.id,
            fromStatus: local.status,
            toStatus: destino,
            note: nota?.trim() || `Status alterado pra ${destino} pelo Flow`,
          },
        })
        .catch(() => {});
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(`[orders] aplicarStatusLocal falhou (wc=${wcOrderId}): ${e?.message || e}`);
    }
  }

  private async cancelarLocalmente(wcOrderId: number, statusPedido?: string) {
    const s = String(statusPedido || '').toLowerCase();
    if (!['cancelled', 'canceled', 'refunded'].includes(s)) return;
    try {
      const local = await (this.prisma as any).order.findUnique({
        where: { wcOrderId },
        select: { id: true, status: true },
      });
      if (!local) return;

      await (this.prisma as any).order.update({
        where: { id: local.id },
        data: { status: 'cancelled' },
      });

      // Ordens de separação que ainda não saíram: não há mais o que separar.
      // Lê os ids ANTES do update — depois de cancelados, o filtro por status
      // não acha mais quem eram, e é deles que vêm as peças a devolver.
      const cancelaveis = await (this.prisma as any).pickOrder.findMany({
        where: { orderId: local.id, status: { notIn: ['shipped', 'cancelled'] } },
        select: { id: true },
      });
      const picks = await (this.prisma as any).pickOrder.updateMany({
        where: { orderId: local.id, status: { notIn: ['shipped', 'cancelled'] } },
        data: { status: 'cancelled' },
      });

      // DEVOLVE o que a loja já tinha bipado. Desde 18/08 o bipe baixa o
      // estoque na hora: sem este estorno, o pedido cancelado no site deixava
      // as peças separadas fora do estoque pra sempre — invisíveis no balcão e
      // no site, sem ninguém pra reclamar delas.
      const estorno = await this.pickScans.revertOrderStock(local.id, {
        reason: 'order_cancelled',
        pickOrderIds: cancelaveis.map((p: any) => p.id),
      });

      await (this.prisma as any).orderHistory
        .create({
          data: {
            orderId: local.id,
            fromStatus: local.status,
            toStatus: 'cancelled',
            note:
              `Pedido ${s === 'refunded' ? 'REEMBOLSADO' : 'CANCELADO'} pelo Flow` +
              (picks.count ? ` · ${picks.count} ordem(ns) de separação cancelada(s)` : '') +
              (estorno.pecas ? ` · ${estorno.pecas} peça(s) bipada(s) devolvida(s) ao estoque` : ''),
          },
        })
        .catch(() => {});
    } catch (e: any) {
      // Não bloqueia: o cancelamento no site já valeu.
      // eslint-disable-next-line no-console
      console.error(`[orders] cancelarLocalmente falhou (wc=${wcOrderId}): ${e?.message || e}`);
    }
  }

  /**
   * Idempotente: garante que existem pick-orders locais pro wcOrderId.
   *  - Se já existe → retorna { ok: true, already: true } sem refazer nada.
   *  - Se não existe → puxa do WC, upsert, roda routing, cria pick-orders e emite socket.
   *  - Se routing falhar (sem estoque etc) → retorna { ok: false, message }.
   */
  private async ensurePickOrdersForWc(wcOrderId: number): Promise<{
    ok: boolean;
    already?: boolean;
    pickOrders?: Array<{ id: string; storeCode: string; storeName: string }>;
    message?: string;
  }> {
    // Já tem?
    const existing = await this.prisma.order.findFirst({
      where: { wcOrderId },
      include: {
        pickOrders: {
          include: { store: { select: { code: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (existing && existing.pickOrders.length > 0) {
      return {
        ok: true,
        already: true,
        pickOrders: existing.pickOrders.map((p) => ({
          id: p.id,
          storeCode: p.store.code,
          storeName: p.store.name,
        })),
      };
    }

    // Origem SINTÉTICA (live 900M, site novo 950M): já existe local com itens
    // — roteia direto, sem WC. Buscar lá é 404 e derruba o roteamento.
    if (existing && this.origemSintetica((existing as any).source)) {
      try {
        const preview = await this.routing.previewRoute(existing.id);
        if (!preview.success) {
          const missingLabel = preview.missing?.length
            ? `${preview.missing.length} SKU(s) sem estoque (${preview.missing.slice(0, 3).map((m: any) => m.sku).join(', ')}${preview.missing.length > 3 ? '…' : ''})`
            : `estratégia ${preview.strategy}`;
          return { ok: false, message: missingLabel };
        }
        await this.routing.confirmRoute(existing.id, preview as any);
        const pickOrders = await this.prisma.pickOrder.findMany({
          where: { orderId: existing.id },
          include: { store: { select: { code: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        });
        return {
          ok: true,
          pickOrders: pickOrders.map((p) => ({
            id: p.id,
            storeCode: p.store.code,
            storeName: p.store.name,
          })),
        };
      } catch (e: any) {
        return { ok: false, message: e?.message || 'erro no roteamento do pedido' };
      }
    }

    // Não tem — puxa do WC e roteia
    try {
      const o = await this.wc.getOrder(wcOrderId);
      const { orderId } = await this.orders.upsertFromWooCommerce(o);
      const preview = await this.routing.previewRoute(orderId);
      if (!preview.success) {
        const missingLabel = preview.missing?.length
          ? `${preview.missing.length} SKU(s) sem estoque (${preview.missing.slice(0, 3).map((m: any) => m.sku).join(', ')}${preview.missing.length > 3 ? '…' : ''})`
          : `estratégia ${preview.strategy}`;
        return { ok: false, message: missingLabel };
      }
      await this.routing.confirmRoute(orderId, preview as any);
      const pickOrders = await this.prisma.pickOrder.findMany({
        where: { orderId },
        include: { store: { select: { code: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return {
        ok: true,
        pickOrders: pickOrders.map((p) => ({
          id: p.id,
          storeCode: p.store.code,
          storeName: p.store.name,
        })),
      };
    } catch (e: any) {
      return { ok: false, message: e?.message || 'erro desconhecido no routing' };
    }
  }

  // ---------- Rotas de listagem geral ----------

  @Get()
  list(
    @Query('status') status?: OrderStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.orders.list({
      status,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
  }

  // ---------- Rotas paramétricas DEPOIS ----------

  @Get(':id')
  get(@Param('id') id: string) {
    return this.orders.getById(id);
  }

  /**
   * Estoque por loja para todos os SKUs do pedido (consulta ERP com cache).
   */
  @Get(':id/stock-by-store')
  async stockByStore(@Param('id') id: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });
    const stores = await this.prisma.store.findMany({ where: { active: true } });
    const storeCodes = stores.map((s) => s.code);
    const skus = [...new Set(order.items.map((i) => i.sku))];

    const entries = await this.stock.getStockFor(skus, storeCodes);

    const result: Record<string, Array<any>> = {};
    for (const sku of skus) {
      result[sku] = stores.map((s) => {
        const match = entries.find((e) => e.sku === sku && e.storeCode === s.code);
        return {
          storeId: s.id,
          storeCode: s.code,
          storeName: s.name,
          city: s.city,
          state: s.state,
          qty: match?.availableQty ?? 0,
        };
      });
    }

    return { skus, stock: result };
  }

  /**
   * Preview: calcula o roteamento SEM persistir. Retorna quais lojas atenderiam.
   */
  @Post(':id/preview-route')
  async previewRoute(@Param('id') id: string) {
    return this.routing.previewRoute(id);
  }

  /**
   * Confirma o preview e persiste: cria pick_orders, muda status do pedido.
   */
  @Post(':id/confirm-route')
  async confirmRoute(@Param('id') id: string, @Body() body: any) {
    return this.routing.confirmRoute(id, body);
  }

  /**
   * Atalho automático: roteia e persiste numa chamada só.
   */
  @Post(':id/route')
  async route(@Param('id') id: string) {
    const result = await this.routing.routeOrder(id);
    return { ok: result.success, ...result };
  }

  /**
   * A SEPARAÇÃO QUE ESTÁ VALENDO — não uma simulação nova (25/08).
   *
   * 🚨 O PAPEL DIZIA A LOJA ERRADA. A ordem de separação impressa em
   * `/separacao/imprimir/[wcId]` chamava `prepare-separation`, que **roda a
   * engine de novo com o estoque de AGORA** e ainda desconta os pick-orders do
   * próprio pedido (ele existe pra recalcular rota). Como a baixa acontece no
   * BIPE, assim que as lojas designadas bipam as peças elas deixam de ter
   * estoque — e a simulação da impressão escolhe OUTRA loja.
   *
   * Caso LP-000254 (25/08): pedido de retirada em Jundiaí, roteado 17:49 pra
   * JUNDIAÍ (1 peça) + ITANHAÉM (1 peça, transferência). Às 18:40 o papel saiu
   * com "LOJA: SOROCABA (06)" e as DUAS peças numa folha só — Sorocaba nunca
   * teve card nenhum desse pedido; era o resultado de uma rota nova, calculada
   * na hora de imprimir.
   *
   * Aqui a fonte é o que foi CONFIRMADO: os `pick_orders` vivos do pedido e o
   * `assignedStoreId` de cada item — os mesmos campos que a bipagem da loja
   * usa pra saber o que esperar. Sem rota confirmada (pedido ainda não
   * distribuído), cai no preview de sempre, que é o certo pra esse caso.
   */
  @Get('wc/:wcId/separation-confirmed')
  async separationConfirmed(@Param('wcId') wcId: string) {
    const confirmada = await this.separacaoConfirmadaDoPedido(Number(wcId));
    if (confirmada) return confirmada;
    return this.prepareSeparation(wcId);
  }

  /**
   * Monta os grupos a partir da rota JÁ PERSISTIDA. Devolve `null` quando o
   * pedido não tem rota (aí quem chama usa o preview).
   *
   * Item sem loja não é inventado: vai pra `missing`, que é o mesmo lugar da
   * ruptura e da peça reportada como "não achei" — na folha ela não aparece
   * como se alguém devesse separá-la.
   */
  private async separacaoConfirmadaDoPedido(wcOrderId: number) {
    if (!Number.isFinite(wcOrderId)) return null;
    const order: any = await (this.prisma as any).order.findUnique({
      where: { wcOrderId },
      include: { items: true },
    });
    if (!order) return null;

    const picks: any[] = await (this.prisma as any).pickOrder.findMany({
      where: { orderId: order.id, status: { not: 'cancelled' } },
      include: { store: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!picks.length) return null;

    const groups: any[] = [];
    const missing: any[] = [];
    const lojasComCard = new Set(picks.map((p) => p.storeId));

    // Nome da loja que RECEBE a transferência — a folha do feeder tem que
    // dizer pra onde a peça vai; código sozinho não diz nada no balcão.
    const codigosDestino = [
      ...new Set(picks.filter((p) => p.isTransfer && p.transferToStoreCode).map((p) => p.transferToStoreCode)),
    ] as string[];
    const destinos = codigosDestino.length
      ? await (this.prisma as any).store.findMany({
          where: { code: { in: codigosDestino } },
          select: { code: true, name: true },
        })
      : [];
    const nomeDestino = new Map<string, string>(destinos.map((s: any) => [s.code, s.name]));

    for (const pick of picks) {
      const itens = (order.items || []).filter((i: any) => i.assignedStoreId === pick.storeId);
      if (!itens.length) continue;
      groups.push({
        storeId: pick.storeId,
        storeCode: pick.store?.code ?? '',
        storeName: pick.store?.name ?? '',
        storeCity: pick.store?.city ?? null,
        storeState: pick.store?.state ?? null,
        whatsapp: pick.store?.whatsapp ?? null,
        // A folha do feeder precisa dizer que a peça vai pra OUTRA LOJA, não
        // pra cliente — é o que a transferência da retirada e a juntada fazem.
        isTransfer: !!pick.isTransfer,
        transferToStoreCode: pick.transferToStoreCode ?? null,
        transferToStoreName: pick.transferToStoreCode
          ? nomeDestino.get(pick.transferToStoreCode) ?? null
          : null,
        items: itens.map((i: any) => ({
          sku: String(i.sku ?? ''),
          quantity: Number(i.quantity ?? 1),
          productName: String(i.productName ?? ''),
          variant: undefined,
        })),
      });
    }

    for (const i of (order.items || []) as any[]) {
      if (i.assignedStoreId && lojasComCard.has(i.assignedStoreId)) continue;
      missing.push({
        sku: String(i.sku ?? ''),
        quantity: Number(i.quantity ?? 1),
        productName: String(i.productName ?? ''),
      });
    }

    return {
      success: groups.length > 0,
      confirmed: true,
      strategy: groups.length > 1 ? ('multi-store' as const) : ('single-store' as const),
      shippingMethod: order.shippingMethod ?? '',
      groups,
      missing,
    };
  }

  /**
   * Preview de separação pra um pedido WOOCOMMERCE (sem passar pelo banco local).
   *  1. Busca pedido no WC
   *  2. Extrai SKUs + cliente + método de envio
   *  3. Roda a engine de roteamento (1 loja preferido, múltiplas se necessário)
   *  4. Retorna grupos prontos pra enviar WhatsApp
   *
   * ⚠️ É SIMULAÇÃO, e refeita a cada chamada com o estoque do momento. Pra
   * saber quem está separando de verdade, use `separation-confirmed` — foi
   * chamar este aqui na hora de IMPRIMIR que mandou o papel do LP-000254 pra
   * uma loja que não tinha card nenhum do pedido.
   */
  @Get('wc/:wcId/prepare-separation')
  async prepareSeparation(
    @Param('wcId') wcId: string,
    @Query('preferStoreCode') preferStoreCode?: string,
    // Troca manual no preview ("↔ Trocar loja"): CSV de lojas excluídas do
    // roteamento + CSV de lojas fixadas (entram primeiro no split).
    @Query('excludeStoreCodes') excludeStoreCodesCsv?: string,
    @Query('pinStoreCodes') pinStoreCodesCsv?: string,
  ) {
    const wcOrderId = Number(wcId);
    const excludeStoreCodes = (excludeStoreCodesCsv ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const pinStoreCodes = (pinStoreCodesCsv ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    /**
     * Pedido com wcOrderId SINTÉTICO monta o preview do Order local — ele não
     * existe no WooCommerce e buscar lá estoura 404 → 500.
     *
     * ⚠️ 06/08: a guarda dizia só `'live'` (faixa 900M). O pedido do site novo
     * usa a faixa 950M pelo mesmo motivo e caía no `wc.getOrder()`. Como este
     * é o endpoint do botão **1-CLIQUE**, o efeito não era só a tela não
     * abrir: era a SEPARAÇÃO não sair.
     *
     * Duas faixas sintéticas, uma regra: qualquer origem que não seja o
     * WooCommerce se resolve aqui dentro.
     */
    const local = await (this.prisma as any).order.findUnique({
      where: { wcOrderId },
      include: { items: true },
    });
    if (this.origemSintetica(local?.source)) {
      let addr: any = {};
      try { addr = JSON.parse(local.shippingAddress || '{}'); } catch { /* endereço cru */ }
      // Rótulo só informativo no preview; o meio real está no `paymentInfo`.
      const meioPagamento = local.source === 'live' ? 'PIX (Live)' : 'Site';
      return this.routing.previewSeparationForWc({
        wcOrderId,
        wcOrderNumber: String(local.wcOrderNumber ?? wcOrderId),
        orderDateIso: (local.wcDateCreated ?? local.createdAt).toISOString(),
        totalAmount: Number(local.totalAmount ?? 0),
        paymentMethod: meioPagamento,
        items: (local.items || []).map((li: any) => ({
          sku: String(li.sku ?? '').trim(),
          quantity: Number(li.quantity ?? 0),
          productName: String(li.productName ?? ''),
          variant: undefined,
        })),
        customerName: local.customerName ?? '',
        customerPhone: local.customerPhone ?? null,
        customerEmail: local.customerEmail ?? null,
        customerCpf: local.customerCpf ?? null,
        shippingMethod: local.shippingMethod ?? (local.source === 'live' ? 'LIVE' : 'Entrega'),
        isPickup: !!local.isPickup,
        pickupStoreCode: local.pickupStoreCode ?? null,
        preferStoreCode: preferStoreCode?.trim() || null,
        excludeStoreCodes,
        pinStoreCodes,
        address: {
          street: addr.address_1 ?? null,
          number: null, // já embutido em address_1 ("Rua X, 123")
          complement: addr.address_2 ?? null,
          neighborhood: null,
          city: addr.city ?? null,
          state: addr.state ?? null,
          postcode: addr.postcode ?? null,
        },
      });
    }

    const o = await this.wc.getOrder(wcOrderId);

    // Monta items com variante (tamanho/cor) vindo do meta_data
    const items = (o.line_items ?? []).map((li: any) => {
      const variant = extractVariantFromLineItem(li);
      return {
        sku: String(li.sku ?? '').trim(),
        quantity: Number(li.quantity ?? 0),
        productName: String(li.name ?? ''),
        variant,
      };
    });

    const shipping = o.shipping ?? {};
    const billing = o.billing ?? {};
    const shippingMethod = (o.shipping_lines ?? [])[0]?.method_title ?? 'Não informado';

    const customerName = [shipping.first_name || billing.first_name, shipping.last_name || billing.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();

    // Detecta retirada em loja e resolve storeCode
    const activeStores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
    });
    const pickup = detectPickup(o, activeStores);
    const customerCpf = extractCpf(o);

    return this.routing.previewSeparationForWc({
      wcOrderId,
      wcOrderNumber: String(o.number ?? wcOrderId),
      orderDateIso: o.date_created_gmt ?? o.date_created ?? new Date().toISOString(),
      totalAmount: Number(o.total ?? 0),
      paymentMethod: o.payment_method_title ?? '',
      items,
      customerName,
      customerPhone: billing.phone ?? null,
      customerEmail: billing.email ?? null,
      customerCpf,
      shippingMethod,
      isPickup: pickup.isPickup,
      pickupStoreCode: pickup.pickupStoreCode,
      preferStoreCode: preferStoreCode?.trim() || null,
      excludeStoreCodes,
      pinStoreCodes,
      address: {
        street: shipping.address_1 ?? billing.address_1 ?? null,
        number: shipping.number ?? billing.number ?? null,
        complement: shipping.address_2 ?? billing.address_2 ?? null,
        neighborhood: shipping.neighborhood ?? billing.neighborhood ?? null,
        city: shipping.city ?? billing.city ?? null,
        state: shipping.state ?? billing.state ?? null,
        postcode: shipping.postcode ?? billing.postcode ?? null,
      },
    });
  }

  /**
   * BATELADA: preview de separação pra VÁRIOS pedidos WC de uma vez.
   * Aplica:
   *   - ESTOQUE VIRTUAL compartilhado (a mesma peça não cai em 2 pedidos)
   *   - PROPORCIONALIDADE INVERSA (loja que vendeu mais nos últimos 30d cede menos)
   *
   * Body:
   *   { wcOrderIds: number[] }   // Array de IDs WC a rotear em sequência
   *
   * Retorna: { previews: [...], cedeSummary: { byStore, totalCedeSoFar } }
   *
   * Não persiste — é preview. Pra commit, matriz chama confirmSeparation por pedido.
   */
  @Post('wc/prepare-separation-batch')
  async prepareSeparationBatch(@Body() body: { wcOrderIds: number[] }) {
    const ids = Array.isArray(body?.wcOrderIds) ? body.wcOrderIds.map(Number).filter((n) => n > 0) : [];
    if (ids.length === 0) {
      throw new BadRequestException('wcOrderIds vazio.');
    }
    // Cap de segurança — bateladas gigantes travariam a UI e o ERP.
    if (ids.length > 60) {
      throw new BadRequestException('Máximo de 60 pedidos por batelada.');
    }

    const activeStores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
    });

    const orderInputs: any[] = [];
    for (const wcOrderId of ids) {
      try {
        const o = await this.wc.getOrder(wcOrderId);
        const items = (o.line_items ?? []).map((li: any) => {
          const variant = extractVariantFromLineItem(li);
          return {
            sku: String(li.sku ?? '').trim(),
            quantity: Number(li.quantity ?? 0),
            productName: String(li.name ?? ''),
            variant,
          };
        });
        const shipping = o.shipping ?? {};
        const billing = o.billing ?? {};
        const shippingMethod = (o.shipping_lines ?? [])[0]?.method_title ?? 'Não informado';
        const customerName = [shipping.first_name || billing.first_name, shipping.last_name || billing.last_name]
          .filter(Boolean)
          .join(' ')
          .trim();
        const pickup = detectPickup(o, activeStores);
        const customerCpf = extractCpf(o);

        orderInputs.push({
          wcOrderId,
          wcOrderNumber: String(o.number ?? wcOrderId),
          orderDateIso: o.date_created_gmt ?? o.date_created ?? new Date().toISOString(),
          totalAmount: Number(o.total ?? 0),
          paymentMethod: o.payment_method_title ?? '',
          items,
          customerName,
          customerPhone: billing.phone ?? null,
          customerEmail: billing.email ?? null,
          customerCpf,
          shippingMethod,
          isPickup: pickup.isPickup,
          pickupStoreCode: pickup.pickupStoreCode,
          address: {
            street: shipping.address_1 ?? billing.address_1 ?? null,
            number: shipping.number ?? billing.number ?? null,
            complement: shipping.address_2 ?? billing.address_2 ?? null,
            neighborhood: shipping.neighborhood ?? billing.neighborhood ?? null,
            city: shipping.city ?? billing.city ?? null,
            state: shipping.state ?? billing.state ?? null,
            postcode: shipping.postcode ?? billing.postcode ?? null,
          },
        });
      } catch (e: any) {
        orderInputs.push({
          wcOrderId,
          wcOrderNumber: String(wcOrderId),
          orderDateIso: new Date().toISOString(),
          totalAmount: 0,
          paymentMethod: '',
          items: [],
          customerName: '',
          shippingMethod: '',
          address: {},
          _fetchError: e?.message ?? String(e),
        } as any);
      }
    }

    return this.routing.previewBatchForWc(orderInputs);
  }

  /**
   * DIAGNÓSTICO: pra investigar pedido roteado pra loja "errada".
   * Compara o que a engine VIU no momento (routingResult salvo) vs ERP AO VIVO agora.
   * Mostra por SKU e por loja:
   *  - Assignment persistido (qual loja pegou)
   *  - scoreBreakdown salvo (por que cada loja ficou de fora)
   *  - ERP AO VIVO agora (filtro ESTOQUE>0)
   *  - Cache atual
   * Com isso dá pra afirmar: foi bug da engine? ERP mudou depois? Dados duplicados?
   */
  @Get('wc/:wcId/routing-debug')
  async routingDebug(@Param('wcId') wcId: string) {
    const wcOrderId = Number(wcId);

    // Tenta pelo banco local (pedido já confirmado)
    let order = await this.prisma.order.findUnique({
      where: { wcOrderId },
      include: {
        items: { include: { assignedStore: { select: { code: true, name: true } } } },
        pickOrders: { include: { store: { select: { code: true, name: true } } } },
      },
    });

    // FALLBACK: pedido não está no banco → busca ao vivo no WC e monta SKUs sem persistir
    let liveMode = false;
    let wcLineItems: Array<{ sku: string; quantity: number; name: string }> = [];
    if (!order) {
      liveMode = true;
      try {
        const o = await this.wc.getOrder(wcOrderId);
        wcLineItems = (o.line_items ?? []).map((li: any) => ({
          sku: String(li.sku ?? '').trim(),
          quantity: Number(li.quantity ?? 0),
          name: String(li.name ?? ''),
        }));
      } catch (e: any) {
        return {
          error: `Order wc=${wcId} não está no banco local nem no WooCommerce: ${e?.message ?? e}`,
        };
      }
    }

    // routingResult é JSON string — parseia com cuidado
    let savedRouting: any = null;
    if (order) {
      try {
        savedRouting = order.routingResult ? JSON.parse(order.routingResult) : null;
      } catch {
        savedRouting = { _parseError: true, raw: order.routingResult };
      }
    }

    const stores = await this.prisma.store.findMany({ where: { active: true } });
    const storeCodes = stores.map((s) => s.code);
    const skus = liveMode
      ? [...new Set(wcLineItems.map((i) => i.sku).filter((s) => s?.trim()))]
      : [...new Set((order?.items ?? []).map((i) => i.sku).filter((s) => s?.trim()))];

    // ERP ao vivo (filtro ESTOQUE>0 — o que a engine usaria agora)
    const liveStock = await this.stock.getStockLive(skus, storeCodes);
    const liveMap = new Map<string, number>();
    for (const e of liveStock) {
      liveMap.set(`${e.storeCode}::${e.sku}`, e.availableQty);
    }

    // Comparação por SKU
    const bySku = await Promise.all(
      skus.map(async (sku) => {
        let totalQty = 0;
        let assignedStoreCodes: string[] = [];
        if (liveMode) {
          totalQty = wcLineItems
            .filter((i) => i.sku === sku)
            .reduce((acc, i) => acc + i.quantity, 0);
        } else {
          const orderItems = (order?.items ?? []).filter((i) => i.sku === sku);
          totalQty = orderItems.reduce((acc, i) => acc + i.quantity, 0);
          assignedStoreCodes = [
            ...new Set(
              orderItems
                .map((i) => i.assignedStore?.code)
                .filter((c): c is string => !!c),
            ),
          ];
        }

        // RAW do ERP pra esse SKU — todas as linhas (inclusive negativas/zero)
        const rawRows = await this.erp.getStockRawBySku(sku);
        const rawByStore = new Map<string, { sum: number; rows: number; positive: number }>();
        for (const r of rawRows) {
          const cur = rawByStore.get(r.storeCode) ?? { sum: 0, rows: 0, positive: 0 };
          cur.sum += r.qty;
          cur.rows += 1;
          if (r.qty > 0) cur.positive += r.qty;
          rawByStore.set(r.storeCode, cur);
        }

        const perStore = stores.map((s) => {
          const raw = rawByStore.get(s.code) ?? { sum: 0, rows: 0, positive: 0 };
          const live = liveMap.get(`${s.code}::${sku}`) ?? 0;
          const isAssigned = assignedStoreCodes.includes(s.code);
          return {
            storeCode: s.code,
            storeName: s.name,
            isAssigned,
            erpRawSum: raw.sum, // soma de TODAS as linhas (inclusive negativas)
            erpRawRows: raw.rows, // quantas linhas existem na tabela
            erpPositiveQty: raw.positive, // só as positivas (o que ESTOQUE>0 retorna)
            engineLiveSaw: live, // o que a engine receberia do stock service agora
            // 🚨 red flag: engine acha que tem, mas soma real é zero/negativa
            suspicious:
              live > 0 && raw.sum <= 0
                ? `engine vê ${live} mas soma real no ERP é ${raw.sum}`
                : null,
          };
        });

        return {
          sku,
          totalQtyInOrder: totalQty,
          assignedStoreCodes,
          perStore,
        };
      }),
    );

    return {
      liveMode,
      order: order
        ? {
            id: order.id,
            wcOrderId: order.wcOrderId,
            wcOrderNumber: order.wcOrderNumber,
            status: order.status,
            createdAt: order.createdAt,
          }
        : {
            id: null,
            wcOrderId,
            wcOrderNumber: String(wcId),
            status: 'NÃO-PERSISTIDO (pedido não passou pelo botão Confirmar separação)',
            createdAt: new Date().toISOString(),
          },
      savedRouting,
      pickOrders: order?.pickOrders.map((p) => ({
        id: p.id,
        status: p.status,
        storeCode: p.store.code,
        storeName: p.store.name,
      })) ?? [],
      bySku,
      wcLineItems: liveMode ? wcLineItems : undefined,
    };
  }

  /**
   * CONFIRMA a separação de um pedido WC: persiste localmente, cria pick-orders
   * pra cada loja roteada e EMITE socket pra elas (faz o card aparecer no app
   * /minha-loja em tempo real).
   *
   * Body opcional:
   *   - overrides?: { [skuOuStoreIdOriginal]: storeIdNovo }   // pra forçar loja diferente
   *
   * Retorna:
   *   { ok, pickOrders: [{id, storeCode, storeName, items}], orderId }
   */
  /**
   * RECALCULA a separação de um pedido WC já roteado.
   *
   * Quando usar: matriz percebe que a loja roteada não tem estoque (race condition,
   * peça quebrada, etc.) e quer reatribuir. Diferente do `confirm-separation` que é
   * idempotente, esse aqui CANCELA pick-orders ativos e cria novos.
   *
   * Bloqueio: se algum pick-order já está em separated/ready/shipped, retorna 200
   * com `ok: false, reason: 'advanced-status'` — a matriz precisa rejeitar manualmente
   * antes de poder reatribuir.
   *
   * Ganho extra: o roteamento agora desconta `committed` (peças prometidas em outros
   * pick-orders ativos), então não vai realocar pra mesma loja sem estoque.
   */
  @Post('wc/:wcId/recalculate-separation')
  async recalculateSeparation(
    @Param('wcId') wcId: string,
    @Body() body?: { excludeStoreCodes?: string[]; pickOrderId?: string; forceStoreCode?: string },
  ) {
    // SWAP CIRÚRGICO: se vier pickOrderId, troca SÓ aquele pick-order específico,
    // sem mexer nos outros (caso onde uma loja já enviou e outra precisa ser trocada).
    if (body?.pickOrderId) {
      return this.routing.swapSinglePickOrder(body.pickOrderId, {
        excludeStoreCodes: Array.isArray(body?.excludeStoreCodes)
          ? body.excludeStoreCodes
          : undefined,
        forceStoreCode: body?.forceStoreCode,
      });
    }

    const wcOrderId = Number(wcId);
    const local = await this.prisma.order.findFirst({
      where: { wcOrderId },
      select: { id: true },
    });
    if (!local) {
      // Sem Order local ainda → cai no fluxo normal de criar do zero
      return this.confirmSeparation(wcId);
    }
    return this.routing.recalculateForWc(local.id, {
      excludeStoreCodes: Array.isArray(body?.excludeStoreCodes)
        ? body!.excludeStoreCodes
        : undefined,
      forceStoreCode: body?.forceStoreCode,
    });
  }

  /**
   * JUNTADA (21/08): escolhe a LOJA ÂNCORA de um pedido dividido já
   * confirmado — os outros cards passam a mandar as peças PRA ELA (caixa
   * com NF de transferência + etiqueta pra loja), e só ela envia pra
   * cliente, com o pedido completo numa NF só.
   */
  @Post('wc/:wcId/juntar')
  async juntarPedido(
    @Param('wcId') wcId: string,
    @Body() body: { anchorStoreCode?: string },
    @Req() req?: any,
  ) {
    if (!body?.anchorStoreCode) throw new BadRequestException('anchorStoreCode é obrigatório');
    return this.juntada.juntarPedido(Number(wcId), String(body.anchorStoreCode), req?.user?.userId ?? null);
  }

  /** Desfaz a juntada (só enquanto nenhuma caixa nasceu). */
  @Post('wc/:wcId/juntar/desfazer')
  async desfazerJuntada(@Param('wcId') wcId: string) {
    return this.juntada.desfazerJuntada(Number(wcId));
  }

  /** Raio-X da juntada: âncora, caixas por loja e se o envio final liberou. */
  @Get('wc/:wcId/juntada')
  async statusJuntada(@Param('wcId') wcId: string) {
    return (await this.juntada.statusJuntada(Number(wcId))) ?? { juntando: false };
  }

  /**
   * TROCA DE PEÇA NO PEDIDO, COM ACERTO DO DINHEIRO (retaguarda).
   *
   * A primeira versão (21/08 de manhã) trocava o SKU e deixava o valor pago
   * intacto — "a diferença se acerta por fora". Por fora não acertava: a peça
   * mais cara saía de graça e a mais barata deixava a cliente sem o troco.
   * Agora o dinheiro fecha junto (decisões do dono, 21/08):
   *   - mais CARA  → link de pagamento da diferença e separação TRAVADA até
   *                  a cliente pagar;
   *   - mais BARATA → vale nominal no CPF (vale no site e no caixa da loja);
   *   - mesmo preço → troca seca.
   * Só até a loja BIPAR — depois disso a peça já saiu do estoque.
   *
   * Só pedido NATIVO (live 900M, site novo 950M, pdv_online 960M): o item
   * vive no Postgres. Pedido do WooCommerce legado se edita lá.
   */
  @Post('wc/:wcId/swap-item/preview')
  async swapItemPreview(
    @Param('wcId') wcId: string,
    @Body() body: { orderItemId: string; codigo: string },
  ) {
    await this.exigePedidoNativo(Number(wcId));
    if (!body?.orderItemId || !body?.codigo) {
      throw new BadRequestException('orderItemId e codigo são obrigatórios');
    }
    return this.trocaPeca.preview(Number(wcId), body.orderItemId, body.codigo);
  }

  @Post('wc/:wcId/swap-item')
  async swapOrderItem(
    @Param('wcId') wcId: string,
    @Body()
    body: {
      orderItemId: string;
      codigo: string;
      /** Diferença CONFIRMADA pela matriz (+cobra · −devolve). Omitido = a sugerida. */
      diferenca?: number;
      motivo?: string;
    },
    @Req() req?: any,
  ) {
    await this.exigePedidoNativo(Number(wcId));
    return this.trocaPeca.aplicar(
      Number(wcId),
      {
        orderItemId: body?.orderItemId,
        codigo: body?.codigo,
        diferenca: body?.diferenca,
        motivo: body?.motivo,
      },
      req?.user?.userId ?? null,
    );
  }

  /** Trocas já feitas neste pedido + se alguma está segurando a separação. */
  @Get('wc/:wcId/trocas')
  async listarTrocas(@Param('wcId') wcId: string) {
    return this.trocaPeca.listar(Number(wcId));
  }

  /** CORTESIA: destrava a separação sem receber a diferença. */
  @Post('trocas/:swapId/liberar-sem-cobrar')
  async liberarTrocaSemCobrar(
    @Param('swapId') swapId: string,
    @Body() body: { motivo?: string },
    @Req() req?: any,
  ) {
    const motivo = String(body?.motivo || '').trim();
    if (motivo.length < 3) {
      throw new BadRequestException('Escreva o motivo da cortesia — é ele que explica o dinheiro que a casa abriu mão.');
    }
    return this.trocaPeca.liberarSemCobrar(swapId, motivo, req?.user?.userId ?? null);
  }

  /** O pedido nasceu no Flow? (live/site novo/PDV online) — senão, não se edita aqui. */
  private async exigePedidoNativo(wcOrderId: number) {
    const local = await this.prisma.order.findFirst({
      where: { wcOrderId },
      select: { id: true, source: true, status: true },
    });
    if (!local || !this.origemSintetica(local.source)) {
      throw new BadRequestException(
        'Troca de item só vale pra pedido nascido no Flow (site novo, live, PDV online). Pedido do site antigo se edita no WooCommerce.',
      );
    }
    return local;
  }

  @Post('wc/:wcId/confirm-separation')
  async confirmSeparation(
    @Param('wcId') wcId: string,
    @Body()
    body?: {
      preferStoreCode?: string | null;
      // Troca manual feita no preview: o confirm re-roda o routing, então
      // precisa receber as mesmas exclusões/fixações pra separação criada
      // bater com a que o operador revisou na tela.
      excludeStoreCodes?: string[];
      pinStoreCodes?: string[];
    },
  ) {
    const wcOrderId = Number(wcId);

    // Idempotente: se já rodou (via PATCH→hook, botão anterior, etc), retorna o que existe.
    const existing = await this.prisma.order.findFirst({
      where: { wcOrderId },
      include: {
        pickOrders: {
          include: { store: { select: { code: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (existing && existing.pickOrders.length > 0) {
      return {
        ok: true,
        orderId: existing.id,
        alreadyExisted: true,
        pickOrders: existing.pickOrders.map((p) => ({
          id: p.id,
          status: p.status,
          storeCode: p.store.code,
          storeName: p.store.name,
        })),
      };
    }

    // 1) Garante o Order local com items.
    //    Pedido de origem SINTÉTICA (live 900M, site novo 950M) JÁ existe
    //    local — não busca no WC (buscar lá dava 500 na aprovação da quebra).
    let orderId: string;
    if (existing && this.origemSintetica((existing as any).source)) {
      orderId = existing.id;
    } else {
      const o = await this.wc.getOrder(wcOrderId);
      const up = await this.orders.upsertFromWooCommerce(o);
      orderId = up.orderId;
    }

    // 2) Roda o preview oficial (consulta estoque e roteia)
    //    Respeita `preferStoreCode` se o usuário escolheu via radio button no
    //    frontend — a engine força essa loja se ela cobrir o pedido inteiro.
    const preview = await this.routing.previewRoute(orderId, {
      preferStoreCode: body?.preferStoreCode?.trim() || null,
      excludeStoreCodes: Array.isArray(body?.excludeStoreCodes)
        ? body!.excludeStoreCodes.filter(Boolean)
        : undefined,
      pinStoreCodes: Array.isArray(body?.pinStoreCodes)
        ? body!.pinStoreCodes.filter(Boolean)
        : undefined,
    });

    if (!preview.success) {
      return {
        ok: false,
        reason: 'sem-estoque',
        message: 'Nenhuma loja tem estoque suficiente. Verifica o estoque ou divide manualmente.',
        missing: preview.missing,
        orderId,
      };
    }

    // 3) Confirma → cria PickOrders + emite socket pras lojas
    await this.routing.confirmRoute(orderId, preview as any);

    // 4) Re-lê os pick-orders criados pra retornar info detalhada
    const pickOrders = await this.prisma.pickOrder.findMany({
      where: { orderId },
      include: { store: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ok: true,
      orderId,
      strategy: preview.strategy,
      pickOrders: pickOrders.map((p) => ({
        id: p.id,
        status: p.status,
        storeCode: p.store.code,
        storeName: p.store.name,
      })),
    };
  }
}

// extractVariantFromLi
