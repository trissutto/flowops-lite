import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { restanteCentsDaVenda } from '../common/cobranca-venda-online';
import { linkCheckoutAindaDePe } from '../common/cobranca-link-viva';
import { ORIGEM_LINK_PAGBANK, linkPagbankVenceEm } from '../common/link-pagamento-pagbank';

/**
 * COBRANÇA ONLINE AGUARDANDO PAGAMENTO — a lista que faltava (25/08/2026).
 *
 * ── O PROBLEMA (relato do dono) ──
 *
 * "os pedidos gerados pelo link PIX não aparecem como aguardando pagamento,
 * não conseguimos saber se a cliente pagou ou não".
 *
 * A venda online cobrada por PIX/link NÃO vira pedido enquanto o dinheiro não
 * cai — ela fica como `pdv_sales.status='open'`, igual a qualquer carrinho de
 * balcão pela metade. O único rastro de que existe cobrança na rua é a linha
 * na tabela do gateway. E os dois gateways moram em tabelas diferentes:
 *
 *   · Link Pagar.me → `pagarme_payments` (method='checkout')
 *   · PIX PagBank   → `pagbank_payments` (method='pix')
 *
 * O widget "🔗 Online" do PDV lia SÓ a primeira (`listOnlinePending`, do
 * PagarmeService). O PIX — o meio mais usado da venda online — não aparecia em
 * tela nenhuma do sistema.
 *
 * Medição em produção (25/08): a loja 13/SITE tinha **12 vendas abertas com
 * cobrança pendente, R$ 3.840,21**, a mais antiga de 18/08. Nenhuma outra loja
 * passava de 1 — as físicas resolvem no mesmo dia porque a vendedora está na
 * tela. Na 13 a venda nasce, o QR vai pro WhatsApp e ninguém mais olha.
 * Nenhuma delas era dinheiro perdido (os reconciliadores fecham a venda quando
 * o pagamento cai — 0 casos de pago-sem-fechar); o que faltava era a tela
 * dizer "esta cliente NÃO pagou".
 *
 * ── O QUE ESTA LISTA É ──
 *
 * Uma linha por VENDA (não por cobrança: a mesma venda costuma ter 3-4 QRs,
 * porque cada "gerar outro código" cria um novo), com a situação em palavra de
 * gente: PAGOU · AGUARDANDO · NÃO PAGOU. Serve as duas telas com a MESMA
 * régua — o widget do PDV (a vendedora) e a aba "Pagto pendente" da
 * /separacao (a matriz).
 *
 * ⚠️ Este service lê `pagbank_payments` pelo Prisma de propósito, sem importar
 * o PagbankModule: foi um import novo aqui que fechou o ciclo de módulos e
 * derrubou o backend em 07/08 (mesma regra do `PixPagbankReconcileService` e
 * do `PagarmeLinkReconcileService` ao lado).
 */

/** Situação da cobrança em palavra de gente. */
export type SituacaoCobranca = 'pago' | 'aguardando' | 'venceu';

export interface CobrancaOnline {
  saleId: string;
  saleCode: string;
  storeCode: string;
  storeName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerCpf: string | null;
  sellerName: string | null;
  entregaTipo: string | null;
  /** Total da venda. */
  total: number;
  /** Quanto ainda falta cobrar — é ELE que vai numa cobrança nova. */
  restante: number;
  meio: 'pix' | 'link';
  /**
   * Quem cobrou. `link` deixou de ser sinônimo de Pagar.me em 21/09 (link de
   * pagamento do PDV pelo PagBank) — quem registra o pagamento na mão precisa
   * saber em qual chave do `details` gravar a order (`pagbankOrderId` ×
   * `pagarmeOrderId`), senão a prova de pagamento não acha nada.
   */
  gateway: 'pagbank' | 'pagarme';
  situacao: SituacaoCobranca;
  /** Status cru do gateway (pending/paid/expired/canceled/failed). */
  statusGateway: string;
  valor: number;
  /** Link que a loja manda pra cliente: /qr/<token> (PIX) ou /pg/<token>. */
  link: string | null;
  orderId: string | null;
  createdAt: Date;
  paidAt: Date | null;
  expiresAt: Date | null;
  /** Quantas cobranças já foram geradas nesta venda. */
  tentativas: number;
  saleCreatedAt: Date;
  /** Horas desde a PRIMEIRA cobrança da venda — é a idade que importa. */
  horas: number;
}

type LinhaCobranca = {
  meio: 'pix' | 'link';
  /**
   * Link de pagamento do PDV pelo PagBank (21/09): o PIX da página e cada
   * tentativa de cartão viram linha aqui. Vale a validade do LINK (dias), não
   * a do código PIX (1h) — e cartão recusado não "vence" o link.
   */
  linkPagbank?: boolean;
  saleId: string;
  status: string;
  valor: number;
  orderId: string | null;
  linkToken: string | null;
  urlCrua: string | null;
  createdAt: Date;
  paidAt: Date | null;
  expiresAt: Date | null;
};

@Injectable()
export class CobrancasOnlineService {
  private readonly logger = new Logger(CobrancasOnlineService.name);

  /**
   * Janela da lista. 7 dias, não as 48h/96h do widget velho: a medição do dia
   * mostrou venda parada desde 18/08 (7 dias) — corte curto é justamente o que
   * some com o caso que ninguém resolveu.
   */
  private get dias(): number {
    const n = Number(process.env.COBRANCAS_ONLINE_DIAS);
    return Number.isFinite(n) && n > 0 ? n : 7;
  }

  constructor(private readonly prisma: PrismaService) {}

  async listar(input: { storeCode?: string | null }): Promise<CobrancaOnline[]> {
    const cutoff = new Date(Date.now() - this.dias * 24 * 3600_000);

    const [pix, links] = await Promise.all([
      (this.prisma as any).pagbankPayment.findMany({
        where: {
          createdAt: { gte: cutoff },
          OR: [{ method: 'pix' }, { method: 'credit_card', origem: ORIGEM_LINK_PAGBANK }],
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: {
          saleId: true, status: true, valor: true, pagbankOrderId: true,
          linkToken: true, createdAt: true, paidAt: true, expiresAt: true, origem: true,
        },
      }),
      (this.prisma as any).pagarmePayment.findMany({
        where: { method: 'checkout', createdAt: { gte: cutoff } },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: {
          saleId: true, status: true, valor: true, pagarmeOrderId: true,
          linkToken: true, qrCodeText: true, createdAt: true, paidAt: true, expiresAt: true,
        },
      }),
    ]);

    const linhas: LinhaCobranca[] = [
      ...pix.map((p: any) => {
        const doLink = p.origem === ORIGEM_LINK_PAGBANK;
        return {
          meio: doLink ? ('link' as const) : ('pix' as const),
          linkPagbank: doLink,
          saleId: p.saleId,
          status: String(p.status || ''),
          valor: Number(p.valor) || 0,
          orderId: p.pagbankOrderId || null,
          linkToken: p.linkToken || null,
          // O copia-e-cola do PIX NÃO é link: sem `linkToken` a cobrança antiga
          // fica sem botão de reenvio (o caminho é gerar cobrança nova).
          urlCrua: null,
          createdAt: p.createdAt,
          paidAt: p.paidAt || null,
          // Link do PagBank: vale o LINK, não o código PIX de 1h.
          expiresAt: doLink ? linkPagbankVenceEm(p.createdAt) : p.expiresAt || null,
        };
      }),
      ...links.map((g: any) => ({
        meio: 'link' as const,
        saleId: g.saleId,
        status: String(g.status || ''),
        valor: Number(g.valor) || 0,
        orderId: g.pagarmeOrderId || null,
        linkToken: g.linkToken || null,
        urlCrua: g.qrCodeText || null,
        createdAt: g.createdAt,
        paidAt: g.paidAt || null,
        expiresAt: g.expiresAt || null,
      })),
    ];
    if (!linhas.length) return [];

    /**
     * SÓ VENDA AINDA ABERTA É "AGUARDANDO". Venda finalizada já resolveu (o
     * reconciliador fechou ou a loja finalizou na mão); cancelada, idem.
     * O mesmo `saleId` também aparece em carrinho da live e baixa de crediário
     * — o JOIN com `pdv_sales` os deixa de fora naturalmente.
     */
    const sales = await (this.prisma as any).pdvSale.findMany({
      where: {
        id: { in: [...new Set(linhas.map((l) => l.saleId))] },
        status: { in: ['open', 'paused'] },
        ...(input.storeCode ? { storeCode: String(input.storeCode) } : {}),
      },
      select: {
        id: true, storeCode: true, status: true, total: true, createdAt: true,
        customerName: true, customerPhone: true, customerCpf: true,
        sellerName: true, vendedorName: true, entregaTipo: true,
        payments: { select: { valor: true } },
      },
    });
    if (!sales.length) return [];
    const saleById = new Map<string, any>(sales.map((s: any) => [s.id, s]));

    const lojas = await (this.prisma as any).store.findMany({
      where: { code: { in: [...new Set(sales.map((s: any) => s.storeCode).filter(Boolean))] } },
      select: { code: true, name: true },
    });
    const nomeDaLoja = new Map<string, string>(lojas.map((l: any) => [l.code, l.name]));

    // Uma linha por VENDA: "gerar outro código" cria cobrança nova, e mostrar
    // as 4 do mesmo atendimento vira parede sem informação.
    const porVenda = new Map<string, LinhaCobranca[]>();
    for (const l of linhas) {
      if (!saleById.has(l.saleId)) continue;
      const arr = porVenda.get(l.saleId);
      if (arr) arr.push(l);
      else porVenda.set(l.saleId, [l]);
    }

    const agora = Date.now();
    const itens: CobrancaOnline[] = [];
    for (const [saleId, cobr] of porVenda) {
      const s = saleById.get(saleId);
      const principal = this.escolherPrincipal(cobr, agora);
      const primeira = cobr.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      /**
       * O link do PagBank que a cliente TEM é o token da PRIMEIRA cobrança do
       * link (a âncora que a loja mandou). O PIX regerado na página e as
       * tentativas de cartão não têm token próprio pra reenviar — reenviar o
       * link é reenviar a âncora.
       */
      if (principal.linkPagbank) {
        const ancora = cobr
          .filter((c) => c.linkPagbank && c.linkToken)
          .reduce<LinhaCobranca | null>((a, b) => (!a || b.createdAt < a.createdAt ? b : a), null);
        if (ancora) principal.linkToken = ancora.linkToken;
      }
      itens.push({
        saleId,
        saleCode: saleId.slice(-6).toUpperCase(),
        storeCode: s.storeCode,
        storeName: nomeDaLoja.get(s.storeCode) || null,
        customerName: s.customerName || null,
        customerPhone: s.customerPhone || null,
        customerCpf: s.customerCpf || null,
        sellerName: s.sellerName || s.vendedorName || null,
        entregaTipo: s.entregaTipo || null,
        total: Number(s.total) || 0,
        restante: Math.round(restanteCentsDaVenda(s)) / 100,
        meio: principal.meio,
        gateway: principal.meio === 'pix' || principal.linkPagbank ? 'pagbank' : 'pagarme',
        situacao: this.situacaoDe(principal, agora),
        statusGateway: principal.status,
        valor: principal.valor,
        link: this.linkDaCobranca(principal),
        orderId: principal.orderId,
        createdAt: principal.createdAt,
        paidAt: principal.paidAt,
        expiresAt: principal.expiresAt,
        tentativas: cobr.length,
        saleCreatedAt: s.createdAt,
        horas: Math.max(0, Math.round((agora - new Date(primeira.createdAt).getTime()) / 3600_000)),
      });
    }

    /**
     * Ordem = ordem de ação: quem PAGOU primeiro (é só finalizar), depois quem
     * NÃO pagou há mais tempo (cobrar de novo ou cancelar), e por último o que
     * ainda está na mão da cliente.
     */
    const peso: Record<SituacaoCobranca, number> = { pago: 0, venceu: 1, aguardando: 2 };
    return itens.sort((a, b) => peso[a.situacao] - peso[b.situacao] || b.horas - a.horas);
  }

  /** Paga manda; senão a que ainda está de pé; senão a mais recente. */
  private escolherPrincipal(cobr: LinhaCobranca[], agora: number): LinhaCobranca {
    const paga = cobr.find((c) => c.status === 'paid');
    if (paga) return paga;
    const maisNova = (arr: LinhaCobranca[]) =>
      arr.reduce((a, b) => (+new Date(a.createdAt) >= +new Date(b.createdAt) ? a : b));
    const vivas = cobr.filter((c) => this.situacaoDe(c, agora) === 'aguardando');
    return maisNova(vivas.length ? vivas : cobr);
  }

  /**
   * QR VENCIDO NÃO É "AGUARDANDO" (o PIX da venda online vale 1h). O cron do
   * PagBank só carimba `expired` depois de 6h, então até lá o banco diz
   * `pending` num código que nenhum app paga mais — mostrar isso como
   * "aguardando" é a mentira que fez a venda de 20/08 esperar 5 dias.
   */
  private situacaoDe(c: LinhaCobranca, agora: number): SituacaoCobranca {
    if (c.status === 'paid') return 'pago';
    // Link do PagBank: código PIX vencido ou cartão recusado não matam o
    // link — a cliente paga de novo pela mesma página até o link vencer.
    if (c.linkPagbank) {
      return c.expiresAt && new Date(c.expiresAt).getTime() < agora ? 'venceu' : 'aguardando';
    }
    /**
     * ...MAS CARTÃO RECUSADO NÃO É LINK VENCIDO (10/09). O checkout da
     * Pagar.me aceita nova tentativa até o prazo acabar, e chamar isso de
     * "não pagou" faz a loja gerar link NOVO sem precisar — cada tentativa a
     * mais ainda piora o score do antifraude (medição de 01/08). Só vale pro
     * meio `link`: o PIX de 1h continua com a régua dura acima.
     */
    if (c.meio === 'link' && linkCheckoutAindaDePe(c, agora, 0)) return 'aguardando';
    if (c.status !== 'pending') return 'venceu';
    if (c.expiresAt && new Date(c.expiresAt).getTime() < agora) return 'venceu';
    return 'aguardando';
  }

  /**
   * O link que vai pra cliente é SEMPRE o nosso (/qr/ do PIX, /pg/ do link):
   * a URL crua da Pagar.me vira 404 assim que a cobrança fecha, e o EMV do PIX
   * no WhatsApp vira link azul que a cliente toca em vez de copiar.
   */
  private linkDaCobranca(c: LinhaCobranca): string | null {
    if (c.linkToken) {
      const rota = c.linkPagbank ? 'pague' : c.meio === 'pix' ? 'qr' : 'pg';
      return `${this.baseUrlPublica()}/${rota}/${c.linkToken}`;
    }
    if (c.linkPagbank) return null;
    return c.meio === 'link' ? c.urlCrua : null;
  }

  private baseUrlPublica(): string {
    return (process.env.FRONTEND_URL || 'https://flowops-lite.vercel.app')
      .split(',')[0]
      .trim()
      .replace(/\/+$/, '');
  }
}
