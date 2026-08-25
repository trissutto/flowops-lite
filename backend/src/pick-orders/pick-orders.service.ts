import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import { WooCommerceService } from '../woocommerce/woocommerce.service';
import { ErpService } from '../erp/erp.service';
import { ManychatService } from '../live-pdv/manychat.service';
import { LivePdvService } from '../live-pdv/live-pdv.service';
import { MaisEnviosService } from '../mais-envios/mais-envios.service';
import { CorreiosService } from '../correios/correios.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { PickScanService } from './pick-scan.service';
import { TrackingService } from '../tracking/tracking.service';
import { DceEmitService } from '../dce/dce-emit.service';
import { NfeTransferService } from '../nfe/nfe-transfer.service';
import { DanfePdfService } from '../nfe/danfe-pdf.service';
import { PedidoEmailService } from '../loja-orders/pedido-email.service';
import { lerComplementoBairroWc, lerRuaNumeroWc } from '../common/endereco-wc';
import { servicoPagoDoPedido } from '../common/servico-envio';
import { ehItemSemEstoque } from '../common/item-sem-estoque';
import { pedidoOnlineEmAndamento, situacaoPedidoOnline } from '../common/situacao-pedido-online';
import { JuntadaService } from './juntada.service';

// Lojas que despacham pelo MAIS ENVIOS (código Flow → sender id no Mais Envios).
// As demais vão pelo Correios (CWS). Rede: Piracicaba/Sorocaba/Limeira/Moema;
// franquias (Vinhedo/Jundiaí/Suzano/Anália Franco) entram via env sem deploy:
// MAISENVIOS_STORES_JSON = {"10": 1234, "17": 5678, ...} (código → sender id).
/**
 * O SERVIÇO QUE A FAIXA DO CARD MOSTRA — 'SEDEX' | 'PAC' | 'RETIRADA' |
 * 'MOTOBOY' (21/08).
 *
 * A loja precisa saber o que POSTAR. Retirada e motoboy não têm serviço de
 * correio (e nem geram etiqueta), então saem identificados; o resto passa
 * pelo `servicoPagoDoPedido`, a mesma régua da pré-postagem.
 *
 * A UF vem do endereço do pedido: é ela que resolve o "PROMOCIONAL" antigo
 * (SP = SEDEX, resto = PAC) quando o título não diz o serviço.
 */
function servicoDoCard(order: {
  isPickup?: boolean | null;
  shippingMethod?: string | null;
  checkoutInfo?: string | null;
  shippingAddress?: string | null;
}): 'SEDEX' | 'PAC' | 'RETIRADA' | 'MOTOBOY' {
  const semCorreio = retiradaOuMotoboy(order);
  if (semCorreio) return semCorreio;
  return servicoPagoDoPedido(order as any, ufDoPedido(order)).servico;
}

/** RETIRADA/MOTOBOY não têm serviço de correio — ou null, se a peça viaja. */
function retiradaOuMotoboy(order: {
  isPickup?: boolean | null;
  shippingMethod?: string | null;
  checkoutInfo?: string | null;
}): 'RETIRADA' | 'MOTOBOY' | null {
  if (order?.isPickup) return 'RETIRADA';
  const titulo = String(order?.shippingMethod || '').toLowerCase();
  if (titulo.includes('motoboy') || titulo.includes('moto boy')) return 'MOTOBOY';
  try {
    const ck = JSON.parse(String(order?.checkoutInfo || '{}'));
    const kind = String(ck?.shipping?.kind || '').toLowerCase();
    if (kind === 'retirada') return 'RETIRADA';
    if (kind === 'motoboy') return 'MOTOBOY';
  } catch { /* snapshot cru → segue pelo título */ }
  return null;
}

/** UF do destino — é ela que resolve o "PROMOCIONAL" e o fallback histórico. */
function ufDoPedido(order: { shippingAddress?: string | null }): string | null {
  try {
    const addr = JSON.parse(String(order?.shippingAddress || '{}'));
    return String(addr?.state || addr?.uf || '').trim().toUpperCase() || null;
  } catch {
    return null; /* endereço cru → o fallback de UF decide */
  }
}

/**
 * NINGUÉM ESCOLHEU ESSE SERVIÇO — foi a regra de UF que chutou (24/08/2026).
 *
 * Caso ON-000105: venda online paga por link, fechada pelo cron sem a forma de
 * entrega gravada. O pedido nasceu "Entrega (não informada)", a régua caiu no
 * `servicoPorUf` (MG → PAC) e a faixa do card escreveu **PAC** com todas as
 * letras. A vendedora leu aquilo como decisão do sistema e reclamou que tinha
 * marcado SEDEX — ela tinha marcado mesmo; a faixa é que afirmou uma escolha
 * que não existia.
 *
 * Aqui a faixa passa a dizer que é um palpite. Medição de 24/08: dos 51
 * pedidos ativos que geram etiqueta, **1** cai neste caso — o aviso é raro por
 * construção, então quando aparecer merece atenção de verdade.
 */
function envioIncerto(order: {
  isPickup?: boolean | null;
  shippingMethod?: string | null;
  checkoutInfo?: string | null;
  shippingAddress?: string | null;
}): boolean {
  if (retiradaOuMotoboy(order)) return false;
  return servicoPagoDoPedido(order as any, ufDoPedido(order)).origem === 'fallback-uf';
}

/** A cliente pagou R$ 0 de frete? Só pra escrever "(grátis)" ao lado. */
function freteFoiGratis(order: { shippingMethod?: string | null; checkoutInfo?: string | null }): boolean {
  try {
    const ck = JSON.parse(String(order?.checkoutInfo || '{}'));
    const preco = Number(ck?.shipping?.price ?? ck?.shippingPrice);
    if (Number.isFinite(preco)) return preco <= 0;
  } catch { /* sem snapshot → cai no título */ }
  const t = String(order?.shippingMethod || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  return t.includes('gratis') || t.includes('free');
}

const MAISENVIOS_STORES: Record<string, number> = { '05': 3605, '06': 209, '11': 213, '15': 22908 };
function maisEnviosStores(): Record<string, number> {
  const base: Record<string, number> = { ...MAISENVIOS_STORES };
  try {
    const j = JSON.parse(process.env.MAISENVIOS_STORES_JSON || '{}');
    for (const k of Object.keys(j)) { const v = Number(j[k]); if (v > 0) base[String(k)] = v; }
  } catch { /* JSON inválido → só o mapa fixo */ }
  return base;
}
import { authorizeMinLevel } from '../auth/auth-levels.util';

// Status LOGÍSTICO do pick-order (controlado pela loja):
//   new          → chegou, filial não começou
//   separating   → filial clicou "Iniciar Separação", bipagem em andamento
//   separated    → filial bipou 100% → já pode postar (rastreio liberado)
//   ready        → (legado) mantido por compatibilidade com dados antigos
//   shipped      → filial postou e adicionou rastreio
//
// APROVAÇÃO DE BAIXA (matriz) = campo debitApprovedAt no PickOrder, INDEPENDENTE.
// Loja não espera matriz pra postar. Matriz aprova em paralelo (pode ser depois de shipped).
export type PickStatus = 'new' | 'separating' | 'separated' | 'ready' | 'shipped';
const VALID_STATUSES: PickStatus[] = ['new', 'separating', 'separated', 'ready', 'shipped'];

// Transições permitidas. Agora separated pode ir direto pra shipped (sem esperar matriz).
const NEXT_ALLOWED: Record<PickStatus, PickStatus[]> = {
  new: ['separating', 'separated', 'ready', 'shipped'], // admin pode pular tudo em casos raros
  separating: ['separated', 'ready', 'shipped'],        // bipou ou marcou pronto
  separated: ['shipped', 'separating', 'ready'],        // posta direto (rastreio), ou volta pra revisar
  ready: ['shipped'],                                   // legado
  shipped: [],                                          // ponto final
};

/**
 * Mapeamento do status INTERNO do pick-order (loja) → status no WooCommerce.
 *   - separating/ready → 'separacao' (em separação no site)
 *   - shipped (quando TODOS os pick-orders siblings já foram enviados) → 'completed'
 *
 * IMPORTANTE — por que 'completed' e não 'enviado':
 * O status customizado 'enviado' (violeta) do WC NÃO dispara o hook nativo
 * `woocommerce_order_status_completed` — e é nele que o plugin de WhatsApp
 * fica pendurado pra mandar o rastreio pra cliente. Ao marcar 'completed',
 * o WC dispara o hook, o plugin pega o meta `_tracking_number` que já está
 * salvo no pedido e envia a mensagem automaticamente.
 * O status "Enviado" da listagem nativa fica inutilizado, mas é aceitável —
 * "Concluído" no WC corresponde ao "Enviado" no fluxo físico (saiu da loja).
 */
const WC_STATUS_SEPARATING = 'separacao';
const WC_STATUS_SHIPPED = 'completed';

@Injectable()
export class PickOrdersService {
  private readonly logger = new Logger(PickOrdersService.name);
  // Divisor do valor intercompany (regra do dono: VENDAUN ÷ 2,5 — NUNCA o CUSTO)
  private static readonly DIVISOR_CUSTO = 2.5;

  /**
   * Loja-canal que recebe TODA venda de site e de live (dono 30/07).
   * A peça sai da loja física e entra aqui — é o destino único do acerto
   * entre lojas, no lugar do antigo "loja que fez a live" / código 'SITE'.
   */
  private static readonly CANAL_STORE_CODE = '13';

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    @Inject(forwardRef(() => WooCommerceService))
    private readonly wc: WooCommerceService,
    private readonly erp: ErpService,
    private readonly manychat: ManychatService,
    private readonly catalog: WincredCatalogService,
    private readonly livePdv: LivePdvService,
    private readonly maisEnvios: MaisEnviosService,
    private readonly correios: CorreiosService,
    private readonly dce: DceEmitService,
    private readonly nfe: NfeTransferService,
    private readonly danfePdf: DanfePdfService,
    private readonly pedidoEmail: PedidoEmailService,
    private readonly scans: PickScanService,
    private readonly tracking: TrackingService,
    // Juntada de pedido dividido (21/08) — forwardRef porque a JuntadaService
    // também chama de volta (marcarCaixaJuntadaRecebida) quando a caixa chega.
    @Inject(forwardRef(() => JuntadaService))
    private readonly juntada: JuntadaService,
  ) {}

  /**
   * DOCUMENTOS DO ENVIO num PDF ÚNICO: etiqueta dos Correios + DANFE da NF-e
   * (quando autorizada), nessa ordem — a loja imprime um arquivo só.
   */
  async docsEnvioMerged(id: string, storeId: string) {
    const pick = await this.prisma.pickOrder.findUnique({ where: { id } });
    if (!pick) throw new NotFoundException('Pick-order não encontrado');
    if (pick.storeId !== storeId) throw new ForbiddenException('Pick-order não pertence à sua loja');
    if (!pick.correiosPrepostagemId) throw new BadRequestException('Envio ainda não gerado (sem pré-postagem).');

    // Etiqueta pelo provedor do envio: Mais Envios usa a TAG; Correios o id da
    // pré-postagem. BEST-EFFORT: se a etiqueta falhar, a DANFE sai mesmo assim
    // (antes a falha da etiqueta engolia a nota junto — 28/07).
    const pdfs: Buffer[] = [];
    let etiquetaErro: string | null = null;
    const baixarEtiqueta = async (me: boolean): Promise<any> => {
      try {
        return me
          ? await this.maisEnvios.baixarEtiqueta(String(pick.trackingCode || ''))
          : await this.correios.baixarEtiqueta(String(pick.correiosPrepostagemId));
      } catch (e: any) {
        return { ok: false, erro: String(e?.message || e) };
      }
    };
    // 1º: etiqueta GRAVADA na geração do envio (não depende de API externa)
    let et: any = (pick as any).etiquetaPdf ? { ok: true, pdfBase64: (pick as any).etiquetaPdf } : null;
    if (!et) {
      const ehME = String(pick.carrier || '').includes('Mais Envios');
      et = await baixarEtiqueta(ehME);
      if (!ehME && !(et?.ok && et.pdfBase64)) {
        // Picks antigos gravaram carrier "Correios SEDEX" mesmo sendo Mais
        // Envios — tenta o ME (1 POST rápido). O inverso NÃO: carrier "Mais
        // Envios" só é gravado pelo caminho ME, e cair no polling dos Correios
        // com id inválido pendurava o request ~1min (lentidão 28/07).
        const et2 = await baixarEtiqueta(true);
        if (et2?.ok && et2.pdfBase64) et = et2;
      }
      // Conseguiu agora? Grava pra próxima reimpressão não depender da API.
      if (et?.ok && et.pdfBase64) {
        try { await this.prisma.pickOrder.update({ where: { id }, data: { etiquetaPdf: String(et.pdfBase64) } }); } catch { /* best-effort */ }
      }
    }
    if (et?.ok && et.pdfBase64) pdfs.push(Buffer.from(String(et.pdfBase64), 'base64'));
    else {
      etiquetaErro = et?.erro || 'etiqueta indisponível';
      this.logger.warn(`[docs-envio] etiqueta indisponível pro pick ${id} (carrier=${pick.carrier}, tag=${pick.trackingCode}): ${etiquetaErro}`);
    }

    let temNota = false;
    try {
      // A AUTORIZADA mais recente — não a mais recente qualquer (uma tentativa
      // rejeitada depois da autorizada escondia a nota do PDF; 28/07)
      const doc: any = await (this.prisma as any).nfeDoc.findFirst({
        where: { shipmentId: `envio:${id}`, status: 'authorized' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (doc?.id) {
        const { buffer } = await this.danfePdf.generateForDoc(doc.id);
        pdfs.push(buffer);
        temNota = true;
      }
    } catch (e: any) {
      this.logger.warn(`[docs-envio] DANFE indisponível pro pick ${id}: ${e?.message || e}`);
    }

    if (!pdfs.length) {
      throw new BadRequestException(`Nem etiqueta nem DANFE disponíveis${etiquetaErro ? ` (etiqueta: ${etiquetaErro})` : ''} — tente de novo em alguns segundos.`);
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PDFDocument } = require('pdf-lib');
    const out = await PDFDocument.create();
    for (const b of pdfs) {
      const src = await PDFDocument.load(b, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    }
    const bytes = await out.save();
    return { ok: true, pdfBase64: Buffer.from(bytes).toString('base64'), temNota, temEtiqueta: !etiquetaErro, etiquetaErro, trackingCode: pick.trackingCode || null };
  }

  /**
   * Gera a PRÉ-POSTAGEM dos Correios pro pedido da LIVE deste pick-order e o
   * marca como ENVIADO com o rastreio gerado (mesmo caminho do "Enviar c/
   * rastreio" — dispara baixa Giga + WhatsApp). Reusa gerarEnvioCorreios do
   * carrinho da live (via Order.liveCartId). Só live por enquanto.
   */
  async gerarEnvioCorreios(id: string, storeId: string, _userId: string) {
    const pick = await this.prisma.pickOrder.findUnique({ where: { id } });
    if (!pick) throw new NotFoundException('Pick-order não encontrado');
    if (pick.storeId !== storeId) throw new ForbiddenException('Pick-order não pertence à sua loja');
    if (pick.status === 'shipped') throw new BadRequestException('Pedido já enviado.');
    /**
     * MOTOBOY NÃO GERA ETIQUETA (17/08). O botão azul do card era o único
     * caminho visível e a loja clicava nele pra "sair da tela": nascia uma
     * pré-postagem SEDEX de verdade (o serviço caía no fallback por UF) e,
     * com NFE_ENVIO_ENABLED, uma NF-e de envio — pra um pacote que ia de
     * moto. Custo real e etiqueta órfã. Mesmo guard que a retirada já tinha.
     */
    {
      const ordemDoPick = await this.prisma.order.findUnique({ where: { id: pick.orderId }, select: { checkoutInfo: true, shippingMethod: true } });
      let kind = '';
      try { kind = String(JSON.parse(ordemDoPick?.checkoutInfo || '{}')?.shipping?.kind || ''); } catch { /* sem checkoutInfo */ }
      if (kind === 'motoboy' || /motoboy/i.test(String(ordemDoPick?.shippingMethod || ''))) {
        throw new BadRequestException('Entrega por motoboy não gera etiqueta dos Correios. Use "Entregue por motoboy" quando a peça sair.');
      }
    }
    /**
     * JUNTADA DE PEDIDO DIVIDIDO (21/08):
     *  - Card FEEDER (isTransfer sem retirada) manda a caixa pra LOJA ÂNCORA,
     *    não pra cliente — etiqueta de cliente aqui seria pacote duplicado.
     *  - Card ÂNCORA só despacha quando TODAS as caixas das outras lojas
     *    chegaram (entrada dada) — senão o pacote sai incompleto.
     */
    {
      const ordemJ = await this.prisma.order.findUnique({
        where: { id: pick.orderId },
        select: { id: true, isPickup: true },
      });
      if (pick.isTransfer && ordemJ && !ordemJ.isPickup) {
        throw new BadRequestException(
          'Esta caixa é da JUNTADA: ela vai pra LOJA ÂNCORA, não pra cliente. ' +
            'Use "Documentos da caixa" no card — sai a etiqueta pra loja (ou o aviso de carro da rede), a NF de transferência e o romaneio do pedido.',
        );
      }
      if (ordemJ && !ordemJ.isPickup && !pick.isTransfer) {
        await this.travarEnvioAncoraSeFaltamCaixas(pick);
      }
    }
    // ── IDEMPOTÊNCIA (28/07: 17 pré-postagens do MESMO pedido no Mais Envios,
    // uma por clique enquanto o request anterior pendurava) ──────────────────
    // Já tem rastreio? devolve o existente — NUNCA cria outra pré-postagem.
    // Regenerar de verdade = Reabrir (limpa os campos) e gerar de novo.
    if (pick.trackingCode) {
      // Garante a NOTA mesmo no "já gerado": se o pick ficou sem NF-e
      // autorizada (falha numa tentativa anterior), emite agora — a emissão é
      // idempotente por pick+ambiente, então NUNCA duplica nota nem etiqueta.
      let nfe: any = null;
      try {
        const doc: any = await (this.prisma as any).nfeDoc.findFirst({
          where: { shipmentId: `envio:${id}`, status: 'authorized' }, select: { id: true },
        });
        if (!doc) {
          const order: any = await this.prisma.order.findUnique({ where: { id: pick.orderId }, include: { items: true } });
          const store: any = await this.prisma.store.findUnique({ where: { id: pick.storeId } });
          if (order) nfe = (await this.emitirNfeDoEnvio(id, order, pick, store)).nfe;
        }
      } catch { /* nota é best-effort aqui — o docs-envio avisa se faltar */ }
      return { ok: true, jaGerado: true, codigoRastreio: pick.trackingCode, idPrepostagem: pick.correiosPrepostagemId ?? null, servico: null, carrier: pick.carrier ?? null, etiquetaPdf: (pick as any).etiquetaPdf ?? null, dce: null, nfe };
    }
    /**
     * Trava atômica contra cliques simultâneos: só o 1º request marca
     * `correiosGeneratedAt` e gera; os demais levam aviso. Falhou? solta a
     * trava no catch.
     *
     * ⚠️ A TRAVA EXPIRA — e isso não é detalhe. O `catch` só solta se o
     * processo continuar vivo: deploy no meio da geração (o backend reinicia
     * em ~30s e mata as requisições em voo), OOM ou queda de rede deixavam o
     * campo preenchido com `trackingCode` nulo PARA SEMPRE. A loja ficava sem
     * conseguir gerar envio daquele pedido, clicando num botão que respondia
     * "aguarde uns segundos" pra sempre — aconteceu em 03/08, em dia de
     * deploys seguidos.
     *
     * Dois minutos é maior que qualquer geração normal (a chamada aos
     * Correios/Mais Envios leva segundos) e curto o bastante pra loja não
     * ficar parada.
     */
    const EXPIRA_MS = 2 * 60_000;
    const limite = new Date(Date.now() - EXPIRA_MS);
    const claim = await this.prisma.pickOrder.updateMany({
      where: {
        id,
        trackingCode: null,
        OR: [{ correiosGeneratedAt: null }, { correiosGeneratedAt: { lt: limite } }],
      },
      data: { correiosGeneratedAt: new Date() },
    });
    if (claim.count === 0) {
      throw new BadRequestException(
        'Envio já está sendo gerado — aguarde uns segundos e clique Reimprimir. ' +
          'Se continuar assim por mais de 2 minutos, clique em Reabrir e gere de novo.',
      );
    }
    try {
      return await this.gerarEnvioCorreiosInner(id, pick);
    } catch (e) {
      await this.prisma.pickOrder.updateMany({ where: { id, trackingCode: null }, data: { correiosGeneratedAt: null } }).catch(() => undefined);
      throw e;
    }
  }

  /**
   * A loja deste pick é a ÂNCORA de uma juntada? (= existe card irmão
   * `isTransfer` apontando pra ela, num pedido que NÃO é retirada.)
   */
  private async souAncoraDaJuntada(order: any, pick: any): Promise<boolean> {
    if (!order || order.isPickup) return false;
    const store = await this.prisma.store.findUnique({
      where: { id: pick.storeId },
      select: { code: true },
    });
    if (!store?.code) return false;
    const feeders = await this.prisma.pickOrder.count({
      where: {
        orderId: order.id,
        id: { not: pick.id },
        isTransfer: true,
        transferToStoreCode: store.code,
      },
    });
    return feeders > 0;
  }

  /**
   * ÂNCORA da juntada só gera o envio final quando TODAS as caixas das
   * lojas feeder chegaram (remessa `received`). Feeder que nem terminou de
   * bipar ainda não tem caixa — conta como pendente do mesmo jeito.
   */
  private async travarEnvioAncoraSeFaltamCaixas(pick: any): Promise<void> {
    const store = await this.prisma.store.findUnique({
      where: { id: pick.storeId },
      select: { code: true },
    });
    if (!store?.code) return;
    const feeders = await this.prisma.pickOrder.findMany({
      where: {
        orderId: pick.orderId,
        id: { not: pick.id },
        isTransfer: true,
        transferToStoreCode: store.code,
      },
      select: { id: true, storeId: true },
    });
    if (!feeders.length) return; // não é juntada
    const shipments: any[] = await (this.prisma as any).realignmentShipment.findMany({
      where: { pickOrderId: { in: feeders.map((f) => f.id) }, status: { not: 'cancelled' } },
      select: { pickOrderId: true, status: true, code: true, fromStoreName: true },
    });
    const porPick = new Map(shipments.map((s) => [s.pickOrderId, s]));
    const pendentes: string[] = [];
    for (const f of feeders) {
      const cx = porPick.get(f.id);
      if (!cx) {
        const loja = await this.prisma.store.findUnique({ where: { id: f.storeId }, select: { name: true } });
        pendentes.push(`${loja?.name ?? 'loja'} (ainda separando)`);
      } else if (cx.status !== 'received') {
        pendentes.push(`${cx.fromStoreName} (caixa ${cx.code} ${cx.status === 'in_transit' ? 'em trânsito' : cx.status})`);
      }
    }
    if (pendentes.length) {
      throw new BadRequestException(
        `JUNTANDO PEÇAS — ainda falta(m) ${pendentes.length} caixa(s) chegar: ${pendentes.join(' · ')}. ` +
          'Dê entrada nas caixas quando chegarem e o envio libera com o pedido completo.',
      );
    }
  }

  /**
   * NF-e do ENVIO (ANTES da etiqueta: a chave vai na pré-postagem).
   * Gated por NFE_ENVIO_ENABLED=1. CFOP/DIFAL automáticos (regra do
   * contador). Falha na NF-e NÃO trava a etiqueta — segue sem chave e o
   * front avisa. NFE_ENVIO_AMBIENTE=2 força homologação (e aí a chave de
   * teste NÃO vai pra pré-postagem). Emissão idempotente por pick+ambiente.
   */
  private async emitirNfeDoEnvio(id: string, order: any, pick: any, store: any): Promise<{ nfe: any; nfeChave?: string; nfeInfoME: any }> {
    let nfe: any = null;
    let nfeChave: string | undefined;
    let nfeInfoME: any = null;
    if (String(process.env.NFE_ENVIO_ENABLED || '').trim() === '1' && !order.isPickup) {
      try {
        const dados = await this.montarDadosNfeEnvio(order, pick, String(store?.code || ''));
        if (!dados) {
          // montarDadosNfeEnvio já logou o motivo específico. Este registro
          // fecha o rastro: a etiqueta VAI sair, mas sem nota — e antes disso
          // acontecia em silêncio absoluto (caso Limeira/Piracicaba 30/07).
          nfe = { status: 'skipped', motivo: 'dados da NF-e não puderam ser montados — ver log [nfe-envio] acima' };
        }
        if (dados) {
          const amb = process.env.NFE_ENVIO_AMBIENTE === '2' ? '2' : process.env.NFE_ENVIO_AMBIENTE === '1' ? '1' : undefined;
          // Venda do SITE = empresa do site (LURDS matriz, raiz 30), não a loja
          // separadora (regra do dono 28/07: "não temos código, seria site").
          // Envs: NFE_SITE_EMITENTE_RAIZ (8 díg) + NFE_SITE_EMITENTE_STORE
          // (loja cuja config guarda a identidade/numeração; default a própria).
          const isSite = order.source !== 'live';
          const siteRaiz = String(process.env.NFE_SITE_EMITENTE_RAIZ || '').replace(/\D/g, '');
          const siteStore = String(process.env.NFE_SITE_EMITENTE_STORE || '').trim();
          // FRANQUIAS emitem pela MDD CERQUEIRA (dono 28/07): mapa loja→raiz
          // por env, ex. NFE_EMITENTE_RAIZ_POR_LOJA = {"10":"<raizMDD>",...}.
          // Vale pra venda da LIVE da franquia; site continua LURDS.
          let lojaRaiz = '';
          try {
            const mapa = JSON.parse(process.env.NFE_EMITENTE_RAIZ_POR_LOJA || '{}');
            lojaRaiz = String(mapa[String(store?.code || '')] || '').replace(/\D/g, '');
          } catch { /* JSON inválido → sem override */ }
          const r2: any = await this.nfe.emitVendaForEnvio({
            pickOrderId: id,
            storeCode: isSite && siteRaiz.length === 8 && siteStore ? siteStore : String(store?.code || ''),
            dest: dados.dest,
            items: dados.items,
            // Frete cobrado da cliente vai no campo vFrete da nota (nunca
            // como produto). Pedido dividido: só a nota do 1º pick leva.
            vFrete: dados.vFrete,
            // Desconto (cupom/PIX) vai no campo vDesc, rateado entre os itens
            // — sem isso a nota sai pelo valor cheio (LP-000025, 15/08).
            vDesc: dados.vDesc,
            ambienteOverride: amb as any,
            emitirPorRaiz: isSite && siteRaiz.length === 8 ? siteRaiz : (lojaRaiz.length === 8 ? lojaRaiz : undefined),
          });
          nfe = { docId: r2?.doc?.id, status: r2?.ok ? 'authorized' : 'rejected', cStat: r2?.cStat, xMotivo: r2?.xMotivo, chave: r2?.doc?.chave, jaEmitida: !!r2?.jaEmitida };
          if (r2?.ok && r2?.doc?.chave && r2?.doc?.tpAmb === '1') nfeChave = String(r2.doc.chave);
          // Mais Envios: a nota vai SEMPRE (mesmo homolog) — lá o nf.nfeKey é
          // referência/unicidade da etiqueta (chave vazia COLIDE: "Etiqueta já
          // cadastrada"); não é transmissão fiscal como a chaveNFe dos Correios.
          if (r2?.ok && r2?.doc?.chave) {
            nfeInfoME = { chave: String(r2.doc.chave), numero: r2.doc.numero, serie: r2.doc.serie, valor: (Number(r2.doc.valorTotalCents) || 0) / 100 };
          }
        }
      } catch (e: any) {
        this.logger.warn(`[nfe-envio] falha pro pick ${id}: ${e?.message || e}`);
        nfe = { status: 'error', erro: String(e?.message || e).slice(0, 300) };
      }
    }
    return { nfe, nfeChave, nfeInfoME };
  }

  private async gerarEnvioCorreiosInner(id: string, pick: any) {
    const order: any = await this.prisma.order.findUnique({ where: { id: pick.orderId }, include: { items: true } });
    if (!order) throw new NotFoundException('Pedido não encontrado');

    const store: any = await this.prisma.store.findUnique({ where: { id: pick.storeId } });

    const { nfe, nfeChave, nfeInfoME } = await this.emitirNfeDoEnvio(id, order, pick, store);

    // Remetente da etiqueta = a PRÓPRIA loja do envio (endereço da config
    // fiscal). Fallback: remetente padrão (matriz Itanhaém) se a loja não
    // tiver config completa. Bug 28/07: pacote de Moema saía com remetente
    // Itanhaém na etiqueta.
    const remetenteLoja = await this.remetenteDaLoja(String(store?.code || ''));

    // Provedor da loja (vale pra LIVE **e** SITE — regra do dono 28/07):
    // lojas do Mais Envios despacham TUDO por lá quando MAISENVIOS_ROUTING=1.
    const mapped = maisEnviosStores()[String(store?.code || '')];
    const routingOn = String(process.env.MAISENVIOS_ROUTING || '').trim() === '1';
    const provider = routingOn ? (store?.shippingProvider || (mapped ? 'maisenvios' : 'correios')) : 'correios';
    const senderId = store?.maisEnviosSenderId || mapped || null;
    if (provider === 'maisenvios' && !senderId) {
      throw new BadRequestException('Loja Mais Envios sem "sender id" — configure na tela de Lojas.');
    }

    let r: any;
    if (order.source === 'live') {
      if (!order.liveCartId) throw new BadRequestException('Pedido da live sem carrinho vinculado.');
      if (provider === 'maisenvios') {
        r = await this.gerarEnvioMaisEnvios(order, order.liveCartId, senderId, nfeInfoME, `${order.wcOrderNumber || order.id}/${String(pick.id).slice(0, 8)}`, String(store?.name || ''));
      } else {
        r = await this.livePdv.gerarEnvioCorreios(order.liveCartId, nfeChave, remetenteLoja || undefined);
      }
    } else if (provider === 'maisenvios') {
      // SITE numa loja Mais Envios: pré-postagem lá, a partir do Order.
      r = await this.gerarEnvioMaisEnviosSite(order, pick, senderId, nfeInfoME, `${order.wcOrderNumber || order.id}/${String(pick.id).slice(0, 8)}`, String(store?.name || ''));
    } else {
      // SITE: Correios a partir do próprio Order (endereço + itens do pedido).
      r = await this.gerarEnvioCorreiosSite(order, pick, nfeChave, remetenteLoja || undefined);
    }
    if (!r?.codigoRastreio) throw new BadRequestException('Não foi possível gerar o rastreio.');

    // MODEL B: NÃO marca enviado. Só grava a pré-postagem no pick-order — o
    // pedido CONTINUA na lista "aguardando postagem". Quem marca enviado (baixa
    // Giga + WhatsApp) é o cron/"Já postei", quando registrar a postagem.
    await this.prisma.pickOrder.update({
      where: { id },
      data: {
        trackingCode: r.codigoRastreio,
        carrier: r.carrier || (r.servico ? `Correios ${r.servico}` : 'Correios'),
        correiosPrepostagemId: r.idPrepostagem ? String(r.idPrepostagem) : null,
        correiosGeneratedAt: new Date(),
        // Etiqueta baixada AGORA (na geração funciona) — reimpressão usa daqui
        ...(r.etiquetaPdf ? { etiquetaPdf: String(r.etiquetaPdf) } : {}),
      },
    });

    // DC-e REMOVIDA do fluxo do envio (dono 29/07: "optamos pela NF-e") —
    // a SEFAZ bloqueia contribuinte de ICMS de emitir DC-e (cStat 812) e a
    // NF-e do envio já cumpre o papel. Módulo dce/ segue dormente no código.
    const dce: any = null;

    return { ok: true, codigoRastreio: r.codigoRastreio, idPrepostagem: r.idPrepostagem ?? null, servico: r.servico ?? null, carrier: r.carrier ?? null, etiquetaPdf: r.etiquetaPdf ?? null, dce, nfe };
  }

  /**
   * Remetente da etiqueta dos Correios = a própria loja (endereço da config
   * fiscal/NfceConfig, que já é completo e validado). Null se a loja não tiver
   * config — aí o chamador cai no remetente padrão.
   */
  private async remetenteDaLoja(storeCode: string): Promise<any | null> {
    if (!storeCode) return null;
    try {
      const cfg: any = await this.prisma.nfceConfig.findUnique({ where: { storeCode } });
      if (!cfg?.endereco) return null;
      const e = JSON.parse(String(cfg.endereco));
      const cep = String(e?.cep || '').replace(/\D/g, '');
      if (!e?.logradouro || cep.length !== 8) return null;
      return {
        nome: String(cfg.fantasia || cfg.razaoSocial || 'LURDS PLUS SIZE').slice(0, 50),
        cnpjCpf: String(cfg.cnpj || '').replace(/\D/g, ''),
        endereco: String(e.logradouro),
        numero: String(e.numero || 'S/N'),
        bairro: String(e.bairro || ''),
        cidade: String(e.municipio || e.cidade || ''),
        uf: String(e.uf || 'SP'),
        cep,
      };
    } catch {
      return null;
    }
  }

  /**
   * Destinatário + itens da NF-e do envio. CEP-authoritative (ViaCEP) pra
   * UF/cidade e principalmente o código IBGE (cMun, obrigatório na NF-e).
   */
  private async montarDadosNfeEnvio(order: any, pick: any, storeCode?: string): Promise<{ dest: any; items: any[]; vFrete: number; vDesc: number } | null> {
    let nome = '';
    let cpfCnpj = '';
    let endereco = '';
    let numero = '';
    let bairro = '';
    let cidade = '';
    let uf = '';
    let cep = '';
    let items: any[] = [];
    /**
     * FRETE COBRADO DA CLIENTE → campo `vFrete` da NF-e (nunca linha de
     * produto — mod 55 tem campo pra isso; regra do dono de 31/07, a mesma
     * que a nota grande do PDV já seguia).
     *
     * Pedido DIVIDIDO em 2+ lojas: o frete inteiro vai na nota do PRIMEIRO
     * pick (o mais antigo). Repetir em cada nota cobraria o frete 2×.
     */
    let vFrete = 0;
    /**
     * DESCONTO CONCEDIDO (cupom + PIX) → campo `vDesc` da NF-e (dono 15/08),
     * nunca embutido no preço unitário. Sem isso a nota saía pelo valor CHEIO
     * das peças: o LP-000025 pagou R$ 152,30 e a NF-e 24 foi emitida com
     * R$ 159,79 — divergência fiscal em produção.
     *
     * Ao contrário do frete (inteiro na nota do 1º pick), o desconto é RATEADO
     * pelo valor das peças de cada loja: jogar tudo numa nota só poderia deixar
     * o desconto maior que a mercadoria dela.
     */
    let vDesc = 0;

    // PEDIDO DIVIDIDO em 2+ lojas (dono 29/07): a NF-e de cada envio leva SÓ
    // as peças daquela loja — filtro ESTRITO (sem fallback pro pedido inteiro;
    // se não achar item da loja, não emite e o front avisa). Pedido de loja
    // única mantém o comportamento de sempre (todos os itens).
    const qtdPicks = await this.prisma.pickOrder.count({ where: { orderId: order.id } });
    const dividido = qtdPicks > 1;
    // JUNTADA (21/08): a ÂNCORA despacha o pedido INTEIRO num pacote só — a
    // nota dela cobre TODAS as peças (as próprias + as que chegaram de caixa
    // de outra loja, que já viajaram com NF de transferência) e leva o frete
    // cheio. Feeder nunca chega aqui (o gerarEnvio bloqueia antes).
    const ancoraJuntada = dividido && (await this.souAncoraDaJuntada(order, pick));
    const normLoja = (s: any) => String(s || '').trim().toUpperCase().replace(/^LJ/, '').replace(/^0+/, '');

    if (order.source === 'live' && order.liveCartId) {
      const cart: any = await (this.prisma as any).livePdvCart.findUnique({ where: { id: order.liveCartId }, include: { items: true } });
      if (!cart) {
        this.logger.warn(`[nfe-envio] SEM NOTA: carrinho da live ${order.liveCartId} não encontrado (pedido ${order.id})`);
        return null;
      }
      const todos = (cart.items || []).filter((i: any) => i.status !== 'cancelled');
      let daLoja = storeCode ? todos.filter((i: any) => normLoja(i.originStoreCode) === normLoja(storeCode)) : [];

      /**
       * FONTE DA VERDADE DA DIVISÃO (fix 30/07 — Limeira e Piracicaba).
       *
       * Quem divide o pedido entre lojas é a migração live→site, que grava
       * `orderItem.assignedStoreId` e cria um pick por loja
       * (live-pdv.service.ts). O filtro acima usa OUTRA fonte — o
       * `originStoreCode` do item do CARRINHO — e as duas podem divergir.
       *
       * Quando divergem num pedido DIVIDIDO não havia rede: `itens` vinha
       * vazio e a nota morria em silêncio (o pedido de loja única escapava
       * porque tinha o fallback `: todos`).
       *
       * Aqui, se o filtro do carrinho não achou nada, casamos pelos itens do
       * PEDIDO atribuídos a esta loja — que é exatamente o critério que
       * gerou este pick.
       */
      if (dividido && daLoja.length === 0 && pick?.storeId) {
        const doPedido = (order.items || []).filter((i: any) => i.assignedStoreId === pick.storeId);
        if (doPedido.length) {
          this.logger.log(
            `[nfe-envio] pedido ${order.id}: filtro por originStoreCode veio vazio na loja ${storeCode}; ` +
              `usando ${doPedido.length} item(ns) do pedido com assignedStoreId desta loja.`,
          );
          // Normaliza pro mesmo formato dos itens do carrinho usado abaixo.
          daLoja = doPedido.map((i: any) => ({
            codigoBipado: i.sku,
            itemKey: i.sku,
            descricao: i.productName,
            qty: i.quantity,
            priceCents: Math.round(Number(i.unitPrice || 0) * 100),
            basePriceCents: Math.round(Number(i.baseUnitPrice ?? i.unitPrice ?? 0) * 100),
          }));
        }
      }

      const itens = ancoraJuntada ? todos : dividido ? daLoja : (daLoja.length ? daLoja : todos);
      if (!itens.length) {
        // Causa clássica: o originStoreCode dos itens não bate com o código da
        // loja do pick (pedido dividido entre lojas). Loga os dois lados
        // normalizados — sem isso a nota some sem deixar rastro.
        this.logger.warn(
          `[nfe-envio] SEM NOTA: nenhum item da loja ${storeCode} no carrinho ${order.liveCartId}. ` +
            `dividido=${dividido} · itensNoCarrinho=${todos.length} · ` +
            `originStoreCode dos itens=[${todos.map((i: any) => `${i.originStoreCode}→${normLoja(i.originStoreCode)}`).join(', ')}] · ` +
            `loja do pick=${storeCode}→${normLoja(storeCode)}`,
        );
        return null;
      }
      nome = cart.customerName || 'Cliente';
      cpfCnpj = String(cart.customerCpf || '').replace(/\D/g, '');
      endereco = cart.customerEndereco || '';
      numero = cart.customerNumero || 'S/N';
      bairro = cart.customerBairro || '';
      cidade = cart.customerCidade || '';
      uf = String(cart.customerUf || '').trim().toUpperCase();
      cep = String(cart.customerCep || '').replace(/\D/g, '');
      items = itens.map((i: any) => ({
        sku: i.sku || i.refCode || 'ITEM',
        ean: String(i.sku || '').replace(/\D/g, '').length === 13 ? String(i.sku) : undefined,
        descricao: [i.refCode, i.descricao, i.cor, i.tamanho].filter(Boolean).join(' ') || 'Vestuário',
        qty: Number(i.qty) || 1,
        vUn: (Number(i.priceCents) || 0) / 100,
      }));
    } else {
      let addr: any = {};
      try { addr = JSON.parse(order.shippingAddress || '{}'); } catch { /* cru */ }
      cep = String(order.shippingCep || addr.postcode || addr.cep || '').replace(/\D/g, '');
      ({ rua: endereco, numero } = lerRuaNumeroWc(addr));
      uf = String(addr.state || addr.uf || '').trim().toUpperCase();
      cidade = String(addr.city || addr.cidade || '').trim();
      bairro = String(addr.neighborhood || addr.bairro || '').trim();
      nome = order.customerName || 'Cliente';
      cpfCnpj = String(order.customerCpf || '').replace(/\D/g, '');
      // FRETE: valor do método de envio (checkoutInfo.shipping.price) e, como
      // rede de segurança, a linha FRETE que pedido antigo ainda tenha dentro.
      // Só na nota do primeiro pick — ver comentário na declaração.
      const primeiroPick = await this.prisma.pickOrder.findFirst({
        where: { orderId: order.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      let ck: any = {};
      try { ck = JSON.parse(order.checkoutInfo || '{}'); } catch { /* snapshot cru */ }
      if (!dividido || ancoraJuntada || primeiroPick?.id === pick.id) {
        vFrete =
          Math.round((Number(ck?.shipping?.price ?? ck?.shippingPrice ?? 0) || 0) * 100) / 100 ||
          Math.round(
            (order.items || [])
              .filter((i: any) => ehItemSemEstoque(i) && String(i.sku || '').toUpperCase() === 'FRETE')
              .reduce((s: number, i: any) => s + (Number(i.unitPrice) || 0) * (Number(i.quantity) || 1), 0) * 100,
          ) / 100;
      }
      // A linha de FRETE (pedido criado antes de 14/08) NÃO pode virar produto
      // na nota: ela não tem NCM nem estoque — vai no vFrete acima.
      const pecas = (order.items || []).filter((i: any) => !ehItemSemEstoque(i));
      const atribuidos = pecas.filter((i: any) => i.assignedStoreId === pick.storeId);
      const semDono = pecas.filter((i: any) => !i.assignedStoreId);
      // Dividido: SÓ os itens atribuídos a esta loja. Loja única: mantém o
      // comportamento antigo (atribuídos + sem dono; sem nada, o pedido todo).
      // Âncora da JUNTADA: todas as peças do pedido (o pacote leva tudo).
      const lista = ancoraJuntada
        ? pecas
        : dividido
          ? atribuidos
          : (atribuidos.length ? [...atribuidos, ...semDono] : (order.items || []));
      if (!lista.length) {
        this.logger.warn(
          `[nfe-envio] SEM NOTA: pedido ${order.id} sem itens atribuídos à loja ${storeCode} ` +
            `(dividido=${dividido} · itensNoPedido=${(order.items || []).length})`,
        );
        return null;
      }
      // Rateio do fallback pelo TOTAL DE PEÇAS DO PEDIDO (não só da lista) —
      // senão o pedido dividido inflava o unitário da loja com menos peças.
      const totalPecasPedido = (order.items || []).reduce((s: number, i: any) => s + (Number(i.quantity) || 1), 0) || 1;
      const fallbackUnit = order.totalAmount ? Number(order.totalAmount) / totalPecasPedido : 0;
      items = lista.map((i: any) => ({
        sku: i.sku || 'ITEM',
        ean: String(i.sku || '').replace(/\D/g, '').length === 13 ? String(i.sku) : undefined,
        descricao: String(i.productName || 'Vestuário'),
        qty: Number(i.quantity) || 1,
        vUn: Number(i.unitPrice ?? i.baseUnitPrice ?? fallbackUnit) || 0,
      }));

      // DESCONTO da compra (cupom + PIX), rateado pelo valor das peças DESTA
      // loja. `discount` é o campo consolidado do checkout; a soma das duas
      // partes cobre snapshot antigo que só tenha as parcelas.
      const descPedido = Math.max(0, Math.round((
        Number(ck?.discount ?? 0) ||
        (Number(ck?.descontoCupom ?? 0) + Number(ck?.descontoPix ?? 0))
      ) * 100) / 100);
      if (descPedido > 0) {
        const valorPecas = (v: any[]) => v.reduce((s: number, i: any) => s + (Number(i.vUn ?? i.unitPrice ?? 0) || 0) * (Number(i.qty ?? i.quantity) || 1), 0);
        const totalNota = valorPecas(items);
        const totalPedido = valorPecas(pecas.length ? pecas : lista);
        vDesc = totalPedido > 0
          ? Math.round(descPedido * (totalNota / totalPedido) * 100) / 100
          : descPedido;
        // Nunca maior que a mercadoria da própria nota (vNF negativo é rejeitado).
        vDesc = Math.min(vDesc, Math.round(totalNota * 100) / 100);
      }
    }

    if (cep.length !== 8) {
      this.logger.warn(
        `[nfe-envio] SEM NOTA: CEP inválido no pedido ${order.id} — recebido "${cep}" (${cep.length} dígitos, precisa 8)`,
      );
      return null;
    }
    // ViaCEP manda: UF/cidade/bairro + o código IBGE (cMun da NF-e)
    let codMun = '';
    try {
      const via: any = await this.correios.buscarCep(cep);
      if (via && !via.erro) {
        if (via.uf) uf = String(via.uf).trim().toUpperCase();
        if (via.cidade) cidade = via.cidade;
        if (!bairro && via.bairro) bairro = via.bairro;
        if (!endereco && via.logradouro) endereco = via.logradouro;
        codMun = String(via.ibge || '').replace(/\D/g, '');
      }
    } catch { /* ViaCEP fora → sem cMun, a emissão acusa */ }

    return {
      dest: { cpfCnpj, nome, endereco, numero: numero || 'S/N', bairro, cidade, uf, cep, codMun },
      items,
      vFrete,
      vDesc,
    };
  }

  /**
   * Monta destinatário + itens da DC-e a partir do MESMO dado que gerou a
   * etiqueta: carrinho da live (customer*) ou Order do site (r.destDce que o
   * gerarEnvioCorreiosSite devolve já normalizado pelo CEP).
   */
  private async montarDadosDce(order: any, pick: any, r: any): Promise<{ dest: any; itens: any[] } | null> {
    if (order.source === 'live' && order.liveCartId) {
      const cart: any = await (this.prisma as any).livePdvCart.findUnique({ where: { id: order.liveCartId }, include: { items: true } });
      if (!cart) return null;
      const itens = (cart.items || []).filter((i: any) => i.status !== 'cancelled');
      if (!itens.length) return null;
      return {
        dest: {
          nome: cart.customerName || 'Cliente',
          cpfCnpj: String(cart.customerCpf || '').replace(/\D/g, '') || undefined,
          logradouro: cart.customerEndereco || '',
          numero: cart.customerNumero || 'SN',
          complemento: cart.customerComplemento || '',
          bairro: cart.customerBairro || '',
          cidade: cart.customerCidade || '',
          uf: cart.customerUf || 'SP',
          cep: String(cart.customerCep || '').replace(/\D/g, ''),
          fone: String(cart.customerPhone || '').replace(/\D/g, ''),
        },
        itens: itens.map((i: any) => ({
          descricao: [i.refCode, i.descricao, i.cor, i.tamanho].filter(Boolean).join(' ').slice(0, 120) || 'Vestuário',
          quantidade: Number(i.qty) || 1,
          valorUnit: (Number(i.priceCents) || 0) / 100,
        })),
      };
    }
    // SITE: o gerarEnvioCorreiosSite devolve destDce (endereço já CEP-authoritative)
    if (!r?.destDce) return null;
    // Âncora da JUNTADA: o pacote leva o pedido INTEIRO (peso e declaração).
    const itensLoja = (await this.souAncoraDaJuntada(order, pick))
      ? (order.items || [])
      : (order.items || []).filter((i: any) => !i.assignedStoreId || i.assignedStoreId === pick.storeId);
    const lista = itensLoja.length ? itensLoja : (order.items || []);
    if (!lista.length) return null;
    const totalPecas = lista.reduce((s: number, i: any) => s + (Number(i.quantity) || 1), 0) || 1;
    const fallbackUnit = order.totalAmount ? Number(order.totalAmount) / totalPecas : 0;
    return {
      dest: r.destDce,
      itens: lista.map((i: any) => ({
        descricao: String(i.productName || 'Vestuário').slice(0, 120),
        quantidade: Number(i.quantity) || 1,
        valorUnit: Number(i.unitPrice ?? i.baseUnitPrice ?? fallbackUnit) || 0,
      })),
    };
  }

  /**
   * SERVIÇO DA ETIQUETA NO MAIS ENVIOS — o mesmo que a cliente pagou.
   *
   * Até 15/08 os dois caminhos do Mais Envios mandavam `'SEDEX'` chumbado. A
   * tela da loja mostrava "MODALIDADE DE ENVIO: PAC" (lido do pedido) e a
   * etiqueta saía SEDEX: 11 pedidos em 180 dias — TODOS por aqui, nenhum pelos
   * Correios, que já lê o pedido desde 12/08 (`servicoPagoDoPedido`).
   *
   * Vendemos econômico e postamos expresso: a diferença sai do nosso bolso, e
   * a loja vê a tela dizer uma coisa e a etiqueta dizer outra — que é como o
   * dono achou o problema. O Mais Envios cota os DOIS serviços (PAC 03298 ·
   * SEDEX 03220), então não havia limitação técnica, só o valor fixo.
   *
   * `MAISENVIOS_FORCA_SEDEX=1` volta o comportamento antigo (subir tudo pra
   * expresso) numa variável, se algum dia o expresso ficar mais barato que o
   * econômico na conta LURDS.
   */
  private servicoMaisEnvios(order: any, uf?: string | null): 'PAC' | 'SEDEX' {
    if (String(process.env.MAISENVIOS_FORCA_SEDEX || '').trim() === '1') return 'SEDEX';
    const escolha = servicoPagoDoPedido(order, uf);
    if (escolha.origem === 'fallback-uf') {
      this.logger.warn(
        `[envio] pedido ${order?.wcOrderNumber || order?.id} sem método de envio legível ` +
        `("${order?.shippingMethod ?? '—'}") — postando ${escolha.servico} pela regra de UF (${uf || '?'}).`,
      );
    }
    return escolha.servico;
  }

  /**
   * Gera a pré-postagem no MAIS ENVIOS a partir do carrinho da live.
   *
   * O `order` entra só pra decidir o serviço: o Order da live grava o método
   * como "LIVE · SEDEX"/"LIVE · PAC" (o mesmo que a cliente pagou pela régua
   * de região da live), então o `servicoPagoDoPedido` resolve pelo título e a
   * etiqueta do Mais Envios passa a bater com a dos Correios pro mesmo carrinho.
   */
  private async gerarEnvioMaisEnvios(order: any, cartId: string, senderId: number, nfe?: any, referencia?: string, departamento?: string) {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId }, include: { items: true } });
    if (!cart) throw new NotFoundException('Carrinho não encontrado');
    const itens = (cart.items || []).filter((i: any) => i.status !== 'cancelled');
    if (!itens.length) throw new BadRequestException('Carrinho sem itens.');
    const totalPecas = itens.reduce((s: number, i: any) => s + (Number(i.qty) || 1), 0);
    const pesoGramas = Math.max(300, totalPecas * 200);
    const servico = this.servicoMaisEnvios(order, cart.customerUf);
    const resp: any = await this.maisEnvios.criarPrepost({
      senderId,
      servico,
      destinatario: {
        nome: cart.customerName || 'Cliente',
        cpf: String(cart.customerCpf || '').replace(/\D/g, ''),
        cep: String(cart.customerCep || '').replace(/\D/g, ''),
        endereco: cart.customerEndereco || '',
        numero: cart.customerNumero || 'S/N',
        complemento: cart.customerComplemento || '',
        bairro: cart.customerBairro || '',
        cidade: cart.customerCidade || '',
        uf: cart.customerUf || '',
        telefone: String(cart.customerPhone || '').replace(/\D/g, ''),
        email: cart.customerEmail || '',
      },
      pesoGramas,
      valorDeclarado: cart.totalCents ? cart.totalCents / 100 : undefined,
      ...(nfe ? { nfe } : {}),
      ...(referencia ? { referencia } : {}),
      ...(departamento ? { departamento } : {}),
      itens: itens.map((i: any) => ({ conteudo: [i.refCode, i.descricao, i.cor, i.tamanho].filter(Boolean).join(' ').slice(0, 60) || 'Vestuário', quantidade: Number(i.qty) || 1 })),
    });
    if (!resp?.ok || !resp.tag) throw new BadRequestException(`Mais Envios recusou o envio: ${resp?.erro || 'sem tag'}`);
    let etiquetaPdf: string | null = null;
    try { const et = await this.maisEnvios.baixarEtiqueta(resp.tag); if (et?.ok && et.pdfBase64) etiquetaPdf = et.pdfBase64; } catch { /* etiqueta opcional */ }
    return { codigoRastreio: resp.tag, idPrepostagem: resp.idPrepostagem ?? null, servico, carrier: `Mais Envios ${servico}`, etiquetaPdf };
  }

  /** Pré-postagem no MAIS ENVIOS pro pedido do SITE (a partir do Order). */
  private async gerarEnvioMaisEnviosSite(order: any, pick: any, senderId: number, nfe?: any, referencia?: string, departamento?: string) {
    if (order.isPickup) throw new BadRequestException('Retirada em loja não gera envio.');
    let addr: any = {};
    try { addr = JSON.parse(order.shippingAddress || '{}'); } catch { /* endereço cru */ }
    const cep = String(order.shippingCep || addr.postcode || addr.cep || '').replace(/\D/g, '');
    if (cep.length !== 8) throw new BadRequestException('Pedido sem CEP válido pra postar.');

    // Mesmo parse do caminho Correios: rua e número sem repetir + CEP-authoritative
    let { rua: endereco, numero } = lerRuaNumeroWc(addr);
    let uf = String(addr.state || addr.uf || '').trim().toUpperCase();
    let cidade = String(addr.city || addr.cidade || '').trim();
    // Complemento e bairro saem SEPARADOS — inclusive de pedido antigo, que
    // gravou os dois juntos no `address_2` (ver common/endereco-wc.ts). Ler
    // `address_2` cru como complemento era o que punha "Apto 42 - Centro" na
    // etiqueta e deixava o bairro vazio.
    const { complemento, bairro: bairroDoPedido } = lerComplementoBairroWc(addr);
    let bairro = bairroDoPedido;
    try {
      const via: any = await this.correios.buscarCep(cep);
      if (via && !via.erro) {
        if (via.uf) uf = String(via.uf).trim().toUpperCase();
        if (via.cidade) cidade = via.cidade;
        if (!bairro && via.bairro) bairro = via.bairro;
        if (!endereco && via.logradouro) endereco = via.logradouro;
      }
    } catch { /* ViaCEP fora → usa o do pedido */ }

    // Âncora da JUNTADA: o pacote leva o pedido INTEIRO (peso e declaração).
    const itensLoja = (await this.souAncoraDaJuntada(order, pick))
      ? (order.items || [])
      : (order.items || []).filter((i: any) => !i.assignedStoreId || i.assignedStoreId === pick.storeId);
    const lista = itensLoja.length ? itensLoja : (order.items || []);
    const totalPecas = lista.reduce((s: number, i: any) => s + (Number(i.quantity) || 1), 0) || 1;
    const pesoGramas = Math.max(300, totalPecas * 200);
    // SERVIÇO = o que a cliente PAGOU (mesma leitura do caminho Correios).
    const servico = this.servicoMaisEnvios(order, uf);

    const resp: any = await this.maisEnvios.criarPrepost({
      senderId,
      servico,
      destinatario: {
        nome: order.customerName || 'Cliente',
        cpf: String(order.customerCpf || '').replace(/\D/g, ''),
        cep,
        endereco: endereco || '',
        numero: numero || 'S/N',
        complemento,
        bairro: bairro || '',
        cidade: cidade || '',
        uf: uf || '',
        telefone: String(order.customerPhone || '').replace(/\D/g, ''),
        email: String(order.customerEmail || ''),
      },
      pesoGramas,
      valorDeclarado: order.totalAmount ? Number(order.totalAmount) : undefined,
      ...(nfe ? { nfe } : {}),
      ...(referencia ? { referencia } : {}),
      ...(departamento ? { departamento } : {}),
      itens: lista.map((i: any) => ({ conteudo: String(i.productName || 'Vestuário').slice(0, 60), quantidade: Number(i.quantity) || 1 })),
    });
    if (!resp?.ok || !resp.tag) throw new BadRequestException(`Mais Envios recusou o envio: ${resp?.erro || 'sem tag'}`);
    let etiquetaPdf: string | null = null;
    try { const et = await this.maisEnvios.baixarEtiqueta(resp.tag); if (et?.ok && et.pdfBase64) etiquetaPdf = et.pdfBase64; } catch { /* etiqueta opcional */ }
    return { codigoRastreio: resp.tag, idPrepostagem: resp.idPrepostagem ?? null, servico, carrier: `Mais Envios ${servico}`, etiquetaPdf };
  }

  /** Gera a pré-postagem dos Correios pro pedido do SITE (a partir do Order). */
  private async gerarEnvioCorreiosSite(order: any, pick: any, nfeChave?: string, remetenteLoja?: any) {
    if (order.isPickup) throw new BadRequestException('Retirada em loja não gera envio.');
    let addr: any = {};
    try { addr = JSON.parse(order.shippingAddress || '{}'); } catch { /* endereço cru */ }
    const cep = String(order.shippingCep || addr.postcode || addr.cep || '').replace(/\D/g, '');
    if (cep.length !== 8) throw new BadRequestException('Pedido sem CEP válido pra postar.');

    // Endereço WooCommerce: número/bairro podem vir separados (plugin BR) ou
    // dentro de address_1 ("Rua X, 123") — e no pedido do site vêm NOS DOIS,
    // que é o que punha "Rua X, 123, 123" na etiqueta.
    let { rua: endereco, numero } = lerRuaNumeroWc(addr);
    let uf = String(addr.state || addr.uf || '').trim().toUpperCase();
    let cidade = String(addr.city || addr.cidade || '').trim();
    // Complemento e bairro saem SEPARADOS — inclusive de pedido antigo, que
    // gravou os dois juntos no `address_2` (ver common/endereco-wc.ts). Ler
    // `address_2` cru como complemento era o que punha "Apto 42 - Centro" na
    // etiqueta e deixava o bairro vazio.
    const { complemento, bairro: bairroDoPedido } = lerComplementoBairroWc(addr);
    let bairro = bairroDoPedido;

    // CEP-authoritative (evita RTL-076): UF/cidade/bairro do ViaCEP sobrepõem.
    try {
      const via: any = await this.correios.buscarCep(cep);
      if (via && !via.erro) {
        if (via.uf) uf = String(via.uf).trim().toUpperCase();
        if (via.cidade) cidade = via.cidade;
        if (!bairro && via.bairro) bairro = via.bairro;
        if (!endereco && via.logradouro) endereco = via.logradouro;
      }
    } catch { /* ViaCEP fora → usa o do pedido */ }

    // Âncora da JUNTADA: o pacote leva o pedido INTEIRO (peso e declaração).
    const itensLoja = (await this.souAncoraDaJuntada(order, pick))
      ? (order.items || [])
      : (order.items || []).filter((i: any) => !i.assignedStoreId || i.assignedStoreId === pick.storeId);
    const lista = itensLoja.length ? itensLoja : (order.items || []);
    const totalPecas = lista.reduce((s: number, i: any) => s + (Number(i.quantity) || 1), 0) || 1;
    const pesoGramas = Math.max(300, totalPecas * 200);
    // SERVIÇO = o que a cliente PAGOU no checkout. Até 12/08 isto era
    // `uf === 'SP' ? 'SEDEX' : 'PAC'`: quem morava fora de SP, escolhia SEDEX e
    // pagava o expresso recebia uma pré-postagem PAC. A regra de UF sobrou como
    // último recurso, pra pedido antigo sem método legível.
    const escolha = servicoPagoDoPedido(order, uf);
    const servico = escolha.servico;
    if (escolha.origem === 'fallback-uf') {
      this.logger.warn(
        `[envio] pedido ${order.wcOrderNumber || order.id} sem método de envio legível ` +
        `("${order.shippingMethod ?? '—'}") — postando ${servico} pela regra de UF (${uf || '?'}).`,
      );
    }
    const rem = remetenteLoja || this.correios.remetentePadrao();

    const resp: any = await this.correios.criarPrepostagem({
      servico,
      remetente: rem,
      destinatario: {
        nome: order.customerName || 'Cliente',
        cpfCnpj: String(order.customerCpf || '').replace(/\D/g, '') || undefined,
        endereco: endereco || '',
        numero: numero || 'S/N',
        complemento,
        bairro: bairro || '',
        cidade: cidade || '',
        uf: uf || '',
        cep,
        telefone: String(order.customerPhone || '').replace(/\D/g, ''),
      },
      pesoGramas,
      valorDeclarado: order.totalAmount ? Number(order.totalAmount) : undefined,
      // NF-e do envio: chave na pré-postagem (obrigatória desde 04/2026)
      ...(nfeChave ? { nfeChave } : {}),
      itensDeclaracao: lista.map((i: any) => ({ conteudo: String(i.productName || 'Vestuário').slice(0, 60), quantidade: String(i.quantity || 1) })),
    });
    if (!resp?.ok) throw new BadRequestException(`Correios recusou o envio: ${resp?.erro || 'erro'}`);
    return {
      codigoRastreio: resp.codigoRastreio, idPrepostagem: resp.idPrepostagem ?? null, servico, carrier: `Correios ${servico}`,
      // Destinatário já normalizado (CEP-authoritative) pra DC-e usar o MESMO endereço da etiqueta
      destDce: {
        nome: order.customerName || 'Cliente',
        cpfCnpj: String(order.customerCpf || '').replace(/\D/g, '') || undefined,
        logradouro: endereco || '', numero: numero || 'SN', complemento,
        bairro: bairro || '', cidade: cidade || '', uf: uf || 'SP', cep,
        fone: String(order.customerPhone || '').replace(/\D/g, ''),
      },
    };
  }

  /**
   * REABRIR: desfaz a pré-postagem gerada (ex.: modalidade errada) pra refazer.
   * Limpa o rastreio do pick-order E o envio do carrinho da live
   * (correiosPrepostagemId + trackingCode dos itens) pra o "Gerar envio" criar do
   * zero. NÃO mexe em estoque — no Model B a pré-postagem não baixou nada ainda.
   *
   * CANCELA a pré-postagem antiga nos Correios. Até 03/08 isso era manual, no
   * portal deles ("é manual" estava escrito aqui) — porque o sistema não sabia
   * cancelar. Passou a saber, então deixar a pré-postagem órfã lá seria só
   * trabalho manual mantido por inércia. Best-effort: se os Correios
   * recusarem, o refazer segue (pré-postagem não postada caduca sozinha) e o
   * motivo vai pro log.
   */
  async reabrirEnvioCorreios(id: string, storeId: string) {
    const pick = await this.prisma.pickOrder.findUnique({ where: { id } });
    if (!pick) throw new NotFoundException('Pick-order não encontrado');
    if (pick.storeId !== storeId) throw new ForbiddenException('Pick-order não pertence à sua loja');
    if (pick.status === 'shipped') {
      throw new BadRequestException('Pedido já postado/enviado — reabrir só vale antes da postagem.');
    }
    if (pick.correiosPrepostagemId) {
      const r = await this.correios.cancelarPrepostagem(pick.correiosPrepostagemId);
      if (!r?.ok) {
        this.logger.warn(
          `[reabrir-envio] Correios não cancelaram a pré-postagem ${pick.correiosPrepostagemId} ` +
          `do pick ${id}: ${r?.erro || 'motivo desconhecido'}`,
        );
      }
    }

    const order = await this.prisma.order.findUnique({ where: { id: pick.orderId } });
    if (order?.liveCartId) {
      await (this.prisma as any).livePdvCart.update({ where: { id: order.liveCartId }, data: { correiosPrepostagemId: null } });
      await (this.prisma as any).livePdvItem.updateMany({ where: { cartId: order.liveCartId }, data: { trackingCode: null } });
    }
    await this.prisma.pickOrder.update({
      where: { id },
      data: { trackingCode: null, carrier: null, correiosPrepostagemId: null, correiosGeneratedAt: null, etiquetaPdf: null },
    });
    return { ok: true };
  }

  /**
   * Cron: marca ENVIADO (Giga + WhatsApp, caminho testado) quando os Correios já
   * registraram a postagem. Idempotente — ignora quem já está shipped.
   */
  async marcarEnviadoPorPostagem(id: string) {
    const pick = await this.prisma.pickOrder.findUnique({ where: { id } });
    if (!pick || pick.status === 'shipped' || !pick.trackingCode) return;
    await this.updateStatus(id, pick.storeId, 'system-correios', {
      status: 'shipped' as PickStatus,
      trackingCode: pick.trackingCode,
      carrier: pick.carrier || 'Correios',
    });
  }

  /**
   * TROCA MANUAL DE PEÇA na separação (pedido do site/WooCommerce).
   *
   * A vendedora clica na descrição da peça e escolhe outra no espelho. Regras:
   *  - Só ANTES da baixa de estoque (status new/separating e sem debitApprovedAt).
   *    A baixa acontece no finish-separation/ship SOBRE O SKU ATUAL do item — então
   *    trocar o SKU aqui faz a baixa cair no produto novo e o antigo nunca é baixado.
   *    Já baixado/enviado → recusa e manda usar devolução/troca (não reconcilia estoque
   *    síncrono no Giga de propósito — fora do caminho crítico).
   *  - Se o PREÇO do produto novo difere do antigo (≥ R$0,01), EXIGE senha de nível
   *    GERENTE ou acima (authorizeMinLevel). Sem senha → devolve needsPassword + a
   *    diferença pra tela pedir a autorização. Registra QUEM autorizou no log.
   */
  async swapItem(
    pickOrderId: string,
    storeId: string,
    input: {
      orderItemId: string;
      codigo: string;
      ref?: string | null;
      cor?: string | null;
      tamanho?: string | null;
      descricao?: string | null;
      password?: string | null;
    },
    userId?: string,
  ): Promise<any> {
    const po = await this.prisma.pickOrder.findUnique({ where: { id: pickOrderId } });
    if (!po) throw new NotFoundException('Pedido não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pedido de outra loja');
    if (po.status !== 'new' && po.status !== 'separating') {
      throw new BadRequestException(
        'Só dá pra trocar a peça ANTES de finalizar a separação. Se já foi separado/enviado, use Devolução/Troca.',
      );
    }
    if ((po as any).debitApprovedAt) {
      throw new BadRequestException('Estoque já baixado — use Devolução/Troca em vez de trocar aqui.');
    }

    const newSku = String(input.codigo || '').trim();
    if (!newSku) throw new BadRequestException('Selecione a peça nova');

    const item = await this.prisma.orderItem.findUnique({ where: { id: input.orderItemId } });
    if (!item) throw new NotFoundException('Item não encontrado');
    if (item.orderId !== po.orderId || (item as any).assignedStoreId !== storeId) {
      throw new BadRequestException('Item não pertence a este pedido/loja');
    }
    const oldSku = item.sku;
    if (newSku === oldSku) throw new BadRequestException('É a mesma peça — nada pra trocar');

    // Preços do ESPELHO (em REAIS — não dividir por 100). Diferença ⇒ exige senha.
    const oldInfo = await this.catalog.getPdvProductInfo(oldSku).catch(() => null);
    const newInfo = await this.catalog.getPdvProductInfo(newSku).catch(() => null);
    if (!newInfo) {
      throw new BadRequestException('Peça nova não encontrada no catálogo — confira o código.');
    }
    const oldPrice = oldInfo?.preco ?? (item.unitPrice ?? 0);
    const newPrice = newInfo.preco ?? 0;
    const diff = Math.round((newPrice - oldPrice) * 100) / 100;
    const hasDiff = Math.abs(diff) >= 0.01;

    // Diferença de valor SEM senha → não aplica; devolve pra tela pedir autorização.
    let authorizedByCpf: string | null = null;
    let authorizedByNome: string | null = null;
    if (hasDiff) {
      const pwd = String(input.password || '').trim();
      if (!pwd) {
        return {
          ok: false,
          needsPassword: true,
          oldSku,
          newSku,
          oldPrice,
          newPrice,
          diff,
          newDescricao: this.buildItemName(input, newInfo),
        };
      }
      // Lança ForbiddenException (403) se senha inválida ou nível < GERENTE.
      const auth = authorizeMinLevel(pwd, 'GERENTE');
      authorizedByCpf = auth.byCpf;
      authorizedByNome = auth.byNome;
    }

    // A peça VELHA pode já ter sido bipada — e o bipe já tirou ela do estoque.
    // O OrderItem é reescrito in-place, então depois deste update não existe
    // mais quem diga que a saída foi do SKU antigo. Devolve agora; a atendente
    // bipa a peça nova e o estoque acompanha a troca.
    const estorno = await this.scans.revertScansForSku(pickOrderId, oldSku, 'swap', userId ?? null);

    const newName = this.buildItemName(input, newInfo);
    const updated = await this.prisma.orderItem.update({
      where: { id: item.id },
      data: {
        sku: newSku,
        productName: newName,
        unitPrice: newPrice,
        baseUnitPrice: newPrice,
      },
    });

    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'item.swap',
        payload: JSON.stringify({
          pickOrderId,
          orderItemId: item.id,
          storeId,
          userId: userId ?? null,
          oldSku,
          newSku,
          oldPrice,
          newPrice,
          diff,
          authorizedByCpf,
          authorizedByNome,
          pecasEstornadas: estorno.pecas,
        }),
        status: 200,
      },
    });

    return {
      ok: true,
      oldSku,
      newSku,
      oldPrice,
      newPrice,
      diff,
      pecasEstornadas: estorno.pecas,
      authorizedBy: authorizedByNome,
      item: {
        id: updated.id,
        sku: updated.sku,
        productName: updated.productName,
        quantity: updated.quantity,
        unitPrice: updated.unitPrice,
      },
    };
  }

  /** Nome de exibição da peça nova: prioriza o que a tela mandou, cai no espelho. */
  private buildItemName(
    input: { ref?: string | null; cor?: string | null; tamanho?: string | null; descricao?: string | null; codigo: string },
    info: { descricao?: string | null; ref?: string | null; cor?: string | null; tamanho?: string | null } | null,
  ): string {
    const desc = (input.descricao || info?.descricao || '').trim();
    if (desc) return desc;
    const ref = (input.ref || info?.ref || input.codigo || '').trim();
    const cor = (input.cor || info?.cor || '').trim();
    const tam = (input.tamanho || info?.tamanho || '').trim();
    return [ref, cor, tam].filter(Boolean).join(' ') || input.codigo;
  }

  /**
   * Retorna os items desse pick-order com o EAN resolvido do ERP.
   * Usado pela tela de bipagem da filial — frontend monta mapa EAN→SKU.
   *
   * Devolve TAMBÉM os bipes já registrados (`scans`). Desde 18/08 o bipe é um
   * fato do servidor — antes ele vivia no `localStorage` daquele navegador, e
   * a mesma separação aberta em outro PC começava do zero (e o estoque
   * baixaria de novo).
   */
  async getScanData(pickOrderId: string, storeId: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: { id: true, storeId: true, status: true, orderId: true },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pick-order não é da sua loja');

    // Items atribuídos a essa loja (pedido multi-loja só retorna o pedaço dela)
    const items = await this.prisma.orderItem.findMany({
      where: { orderId: po.orderId, assignedStoreId: storeId },
      select: {
        id: true,
        sku: true,
        productName: true,
        ref: true,
        cor: true,
        tamanho: true,
        quantity: true,
      },
    });

    const skus = items.map((i) => i.sku).filter(Boolean);
    const eanMap = skus.length ? await this.erp.getEansBySkus(skus) : {};
    const scans = await this.scans.listActiveScans(pickOrderId);
    // Peças que ESTA loja reportou neste card ("não achei") — a tela mostra a
    // linha apagada com "reportada", em vez de sumir com ela sem explicação.
    const reports = await this.autoResolveReports(
      await this.prisma.pickOrderItemReport.findMany({
        where: { pickOrderId, resolvedAt: null },
        orderBy: { reportedAt: 'desc' },
      }),
    );

    return {
      pickOrderId: po.id,
      status: po.status,
      reports,
      scans: scans.map((s) => ({
        scanUid: s.scanUid,
        sku: s.sku,
        ean: s.ean,
        timestamp: s.scannedAt.toISOString(),
        debitSkippedReason: s.debitSkippedReason,
      })),
      items: items.map((i) => {
        const ean = eanMap[i.sku] ?? null;
        // Variantes pra tolerar zeros à esquerda do scanner (ex: "0789..." vs "789...")
        // IMPORTANTE: o próprio SKU/CODIGO também entra como variante — muitas confecções
        // imprimem o código interno do ERP como barcode, sem EAN13 real.
        const eanVariants: string[] = [];
        const addVariant = (v: string | null | undefined) => {
          if (!v) return;
          const s = String(v).trim();
          if (s && !eanVariants.includes(s)) eanVariants.push(s);
          if (s && /^\d+$/.test(s)) {
            const stripped = s.replace(/^0+/, '');
            if (stripped && !eanVariants.includes(stripped)) eanVariants.push(stripped);
            const p13 = s.padStart(13, '0');
            const p14 = s.padStart(14, '0');
            if (!eanVariants.includes(p13)) eanVariants.push(p13);
            if (!eanVariants.includes(p14)) eanVariants.push(p14);
          }
        };
        addVariant(ean);
        addVariant(i.sku); // sku bipado direto também conta
        return {
          id: i.id,
          sku: i.sku,
          productName: i.productName,
          ref: (i as any).ref ?? null,
          cor: (i as any).cor ?? null,
          tamanho: (i as any).tamanho ?? null,
          quantity: i.quantity,
          ean, // null = sem EAN no ERP → operador precisa reportar
          eanVariants,
        };
      }),
    };
  }

  /**
   * Fallback quando o EAN bipado não bateu no mapa local da tela de bipagem.
   * Busca no ERP (todas as colunas candidatas, todas as variantes de zeros) e
   * se encontrar um CODIGO que está nos SKUs desse pick-order, retorna o SKU.
   *
   * Também devolve debug dos SKUs do pedido (EANs por coluna) pra diagnóstico
   * rápido na UI quando o EAN realmente não pertence ao pedido.
   */
  async resolveScan(pickOrderId: string, storeId: string, rawEan: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: { id: true, storeId: true, orderId: true },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pick-order não é da sua loja');

    const items = await this.prisma.orderItem.findMany({
      where: { orderId: po.orderId, assignedStoreId: storeId },
      select: { sku: true },
    });
    const pedidoSkus = new Set(items.map((i) => i.sku).filter(Boolean));

    const hit = await this.erp.findSkuByAnyEan(rawEan);
    if (hit && pedidoSkus.has(hit)) {
      return { found: true, sku: hit, ean: rawEan, source: 'erp-wide' as const };
    }

    // Não achou — devolve dump dos SKUs do pedido pra UI exibir debug
    const debug: Array<Record<string, any>> = [];
    for (const sku of pedidoSkus) {
      const d = await this.erp.debugProductEans(sku);
      if (d) debug.push(d);
    }
    return { found: false, ean: rawEan, erpHit: hit, debug };
  }

  /**
   * UMA PEÇA BIPADA — registra e baixa o estoque na mesma transação.
   * Delega pro PickScanService (que também é quem os cancelamentos chamam pra
   * estornar).
   *
   * NÃO emite socket de propósito: `pick-order:status` faz as telas
   * refetcharem, e num pedido de 11 peças seriam 11 refetches em rajada, na
   * mão da atendente. O status do card não mudou — só o contador dentro do
   * modal, que é resposta do próprio POST.
   */
  async registerScan(
    pickOrderId: string,
    storeId: string,
    userId: string,
    input: { scanUid: string; sku: string; ean?: string | null },
  ) {
    return this.scans.registerScan(pickOrderId, storeId, userId, input);
  }

  /** Desfaz UM bipe e devolve a peça pro estoque da loja. */
  async undoScan(pickOrderId: string, storeId: string, userId: string, scanUid: string) {
    return this.scans.undoScan(pickOrderId, storeId, userId, scanUid);
  }

  /**
   * Transiciona pick-order de `separating` → `separated`.
   *
   * A EXIGÊNCIA DE 100% BIPADO CONTINUA (relaxar isso é outro pedido, ainda
   * não autorizado). O que mudou em 18/08 é de ONDE vem a contagem: dos bipes
   * gravados no servidor (`pick_order_scans`), não mais do array que o
   * navegador mandava. O array do body ainda é aceito como fallback pros cards
   * que já estavam abertos quando este deploy subiu — a loja não pode perder a
   * separação no meio por causa da virada.
   *
   * A baixa de estoque agora acontece PEÇA A PEÇA no bipe; o `runAutoDebit`
   * daqui só fecha a diferença (bipe em shadow, card legado) e carimba o
   * `debitApprovedAt`.
   */
  async finishSeparation(
    pickOrderId: string,
    storeId: string,
    userId: string,
    scans: Array<{ sku: string; ean: string; timestamp: string }>,
  ) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: { id: true, storeId: true, status: true, orderId: true },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pick-order não é da sua loja');
    if (po.status !== 'separating' && po.status !== 'new') {
      throw new BadRequestException(`Status atual é "${po.status}" — só pode finalizar de "separating"/"new"`);
    }

    // Valida que bipou tudo que era esperado
    const items = await this.prisma.orderItem.findMany({
      where: { orderId: po.orderId, assignedStoreId: storeId },
      select: { sku: true, quantity: true },
    });
    const expected = new Map<string, number>();
    for (const it of items) {
      expected.set(it.sku, (expected.get(it.sku) ?? 0) + it.quantity);
    }
    const scansGravados = await this.scans.listActiveScans(pickOrderId);
    const fonteScans = scansGravados.length
      ? scansGravados.map((s) => ({ sku: s.sku, ean: s.ean ?? '', timestamp: s.scannedAt.toISOString() }))
      : scans;
    const scannedCount = new Map<string, number>();
    for (const s of fonteScans) {
      scannedCount.set(s.sku, (scannedCount.get(s.sku) ?? 0) + 1);
    }
    for (const [sku, qty] of expected.entries()) {
      const got = scannedCount.get(sku) ?? 0;
      if (got < qty) {
        throw new BadRequestException(
          `SKU ${sku}: esperado ${qty}, bipado ${got}. Bipa tudo antes de finalizar.`,
        );
      }
    }

    // VIRA O STATUS COM O CARD TRAVADO — mesma fila do bipe.
    //
    // As checagens acima leram o card ANTES de qualquer trava. Dois "Finalizar"
    // simultâneos (clique duplo na rede lenta da loja, ou os dois PCs que desde
    // 18/08 enxergam a MESMA separação) passavam os dois, viravam o status os
    // dois e chamavam o `runAutoDebit` os dois — e como nenhum via o
    // `debitApprovedAt` do outro, o que ainda faltava baixar (card aberto antes
    // deste deploy, bipe que rodou em shadow) saía do estoque DUAS vezes.
    // Justo na virada é o pior momento: card legado é exatamente o que a rede
    // inteira vai finalizar nas primeiras horas depois do deploy.
    // Quem perde a corrida leva 400 e não baixa nada.
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.scans.lockPickOrder(tx, pickOrderId);
      const atual = await tx.pickOrder.findUnique({
        where: { id: pickOrderId },
        select: { status: true },
      });
      if (!atual) throw new NotFoundException('Pick-order não encontrado');
      if (atual.status !== 'separating' && atual.status !== 'new') {
        throw new BadRequestException(
          `Status atual é "${atual.status}" — essa separação já foi finalizada.`,
        );
      }
      return tx.pickOrder.update({
        where: { id: pickOrderId },
        data: { status: 'separated' },
        include: { order: { select: { wcOrderId: true } } },
      });
    });

    // Log de auditoria — fica pra sempre no integration_logs. Depois da
    // transação de propósito: gravar antes fazia o "Finalizar" recusado
    // deixar um `separation.finished` na auditoria como se tivesse valido.
    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'separation.finished',
        payload: JSON.stringify({
          pickOrderId, userId, storeId,
          scans: fonteScans,
          fonteBipes: scansGravados.length ? 'servidor' : 'navegador-legado',
        }),
        status: 200,
      },
    });

    // Notifica matriz em tempo real — retaguarda vê a nova fila
    this.gateway.emitPickOrderStatus(storeId, {
      id: updated.id,
      status: 'separated',
    });

    // FECHA A DIFERENÇA. Com a baixa no bipe, o normal aqui é não sobrar nada
    // (runAutoDebit só carimba o debitApprovedAt). Sobra quando o bipe rodou
    // em shadow/killswitch ou quando o card vinha do fluxo antigo. Usa
    // allowNegative + skipNotFound pra não travar a separação por divergência
    // de saldo (a peça já está separada fisicamente). Erro NÃO bloqueia a
    // resposta — a separação aconteceu; a baixa é retentável.
    try {
      await this.runAutoDebit(pickOrderId, userId);
    } catch (e: any) {
      this.logger.warn(
        `Baixa automática falhou pro pick-order ${pickOrderId}: ${e?.message || e}. Pode ser retentada manualmente.`,
      );
    }

    // JUNTADA (21/08): card FEEDER terminou de bipar → a caixa pra loja
    // âncora nasce sozinha (remessa em trânsito + NF de transferência +
    // etiqueta quando o trecho é Correios). Falha aqui NÃO desfaz a
    // separação — a loja gera os documentos pelo botão do card.
    let caixaJuntada: any = null;
    try {
      caixaJuntada = await this.juntada.criarCaixaDoFeederSePreciso(pickOrderId, userId);
    } catch (e: any) {
      this.logger.warn(
        `[juntada] caixa do feeder ${pickOrderId} não nasceu no finish: ${e?.message || e} — a loja pode gerar pelos Documentos da caixa.`,
      );
    }

    return {
      id: updated.id,
      status: updated.status,
      wcOrderId: updated.order?.wcOrderId ?? null,
      itemsScanned: fonteScans.length,
      caixaJuntada: caixaJuntada
        ? {
            code: caixaJuntada.shipment?.code ?? null,
            transporte: caixaJuntada.transporte ?? null,
            trackingCode: caixaJuntada.shipment?.trackingCode ?? null,
          }
        : null,
    };
  }

  /**
   * JUNTADA — a caixa do FEEDER chegou na loja âncora (remessa `received`).
   * Fecha o ciclo do card: vira `shipped` (sem rastreio de cliente — o
   * pacote final é da âncora) e roda os efeitos do envio, que é onde nasce
   * o acerto ÷2,5 da perna feeder→âncora. Sem trackingCode, nenhum aviso de
   * "pedido enviado" chega na cliente por este card — como deve ser.
   * Idempotente: card já shipped só retorna.
   */
  async marcarCaixaJuntadaRecebida(pickOrderId: string) {
    const pick = await this.prisma.pickOrder.findUnique({ where: { id: pickOrderId } });
    if (!pick) return { ok: false as const, motivo: 'pick não existe' };
    if (pick.status === 'shipped') return { ok: true as const, jaEnviado: true };
    await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: { status: 'shipped', carrier: pick.carrier ?? 'Juntada entre lojas' },
    });
    this.afterShippedSideEffects(pickOrderId, {}).catch((e) =>
      this.logger.warn(`[juntada] afterShipped do feeder ${pickOrderId} falhou: ${e?.message || e}`),
    );
    try {
      this.gateway.emitPickOrderStatus(pick.storeId, { id: pick.id, status: 'shipped' });
    } catch { /* socket é best-effort */ }
    this.logger.log(`[juntada] card feeder ${pickOrderId} fechado — caixa recebida na âncora`);
    return { ok: true as const };
  }

  /**
   * FECHA A DIFERENÇA da baixa depois do finishSeparation.
   *
   * Antes de 18/08 ele baixava o card INTEIRO — era o único gatilho de baixa
   * que existia. Agora a peça sai do estoque no bipe, então aqui só desce o
   * que ainda NÃO saiu (`pendingDebitItems`): bipe que rodou em shadow, card
   * que já estava aberto antes deste deploy, item que ninguém bipa (linha de
   * FRETE). Baixar o card inteiro de novo tiraria a mesma peça duas vezes.
   *
   * Marca `debitApprovedAt` mesmo quando não sobrou nada — é o carimbo que
   * impede a matriz de aprovar a mesma baixa manualmente depois.
   */
  private async runAutoDebit(pickOrderId: string, userId: string): Promise<void> {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: {
        id: true,
        storeId: true,
        orderId: true,
        debitApprovedAt: true,
        store: { select: { code: true } },
      } as any,
    });
    if (!po) return;
    if ((po as any).debitApprovedAt) return; // já baixou

    const writeEnabled = this.erp.isWriteEnabled;
    if (!writeEnabled) {
      // shadow mode — só log
      await this.prisma.integrationLog.create({
        data: {
          source: 'erp',
          direction: 'out',
          event: 'debit.approved.shadow.auto',
          payload: JSON.stringify({ pickOrderId, userId, mode: 'auto' }),
          status: 200,
        },
      });
      return;
    }

    const storeCode = String(((po as any).store?.code) ?? '').trim();
    if (!storeCode) {
      this.logger.warn(`runAutoDebit ${pickOrderId}: loja sem code, pulando`);
      return;
    }

    // SÓ O QUE FALTA — o que já saiu no bipe não desce de novo.
    const items = await this.scans.pendingDebitItems(
      pickOrderId,
      (po as any).orderId,
      (po as any).storeId,
      storeCode,
    );

    if (!items.length) {
      // Caminho NORMAL desde 18/08: as 11 peças saíram uma a uma no leitor.
      await this.prisma.pickOrder.update({
        where: { id: pickOrderId },
        data: { debitApprovedAt: new Date() } as any,
      });
      await this.prisma.integrationLog.create({
        data: {
          source: 'erp',
          direction: 'out',
          event: 'debit.real.auto.applied',
          payload: JSON.stringify({
            pickOrderId, userId, storeCode, mode: 'auto', applied: [],
            note: 'nada a baixar — estoque já saiu peça a peça no bipe',
          }),
          status: 200,
        },
      });
      return;
    }

    const result = await this.erp.decreaseStockAsync(items, {
      allowNegative: true,
      skipNotFound: true,
    });

    if (!result.success) {
      await this.prisma.integrationLog.create({
        data: {
          source: 'erp',
          direction: 'out',
          event: 'debit.real.auto.failed',
          payload: JSON.stringify({
            pickOrderId,
            userId,
            storeCode,
            items,
            error: result.error,
          }),
          status: 500,
          error: (result.error || '').slice(0, 500),
        },
      });
      throw new Error(`decreaseStock falhou: ${result.error}`);
    }

    // Sucesso — marca debitApprovedAt pra não duplicar
    await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: { debitApprovedAt: new Date() } as any,
    });

    await this.prisma.integrationLog.create({
      data: {
        source: 'erp',
        direction: 'out',
        event: 'debit.real.auto.applied',
        payload: JSON.stringify({
          pickOrderId,
          userId,
          storeCode,
          mode: 'auto',
          applied: result.applied,
        }),
        status: 200,
      },
    });
  }

  /**
   * Lista os pick-orders DA loja do user logado.
   * Filtro default: status ativos (new, separating, ready). `all=true` traz shipped também.
   */
  async listMine(storeId: string, opts?: { all?: boolean; from?: string; to?: string }) {
    const where: any = { storeId };
    /**
     * ABA ENVIADOS (dono, 04/08): com `from`/`to`, traz TAMBÉM os despachados
     * no período — e é por isso que a aba existia vazia até aqui. O default
     * desta rota sempre foi "só ativos", então filtrar shipped no frontend não
     * adiantava: o registro nunca chegava.
     *
     * Recorte por `updatedAt`: não existe `shippedAt` no modelo, e o último
     * toque num pick despachado é justamente a marcação de envio. Fim do dia
     * incluído (23:59:59), senão "De 04/08 Até 04/08" devolve zero.
     */
    const de = opts?.from ? new Date(`${opts.from}T00:00:00`) : null;
    const ate = opts?.to ? new Date(`${opts.to}T23:59:59.999`) : null;

    if (de || ate) {
      where.status = 'shipped';
      where.updatedAt = {
        ...(de ? { gte: de } : {}),
        ...(ate ? { lte: ate } : {}),
      };
    } else if (!opts?.all) {
      where.status = { in: ['new', 'separating', 'separated', 'ready'] };
      // Esconde pick-orders sinalizados com problema — card sai da fila da loja
      // assim que ela reporta; matriz vê a flag em /pedidos e /separacao e reroteia.
      where.issueReason = null;
    }
    const rows = await this.prisma.pickOrder.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        order: {
          select: {
            id: true,
            wcOrderId: true,
            wcOrderNumber: true,
            // Card verde ONLINE (14/08): a loja distingue pedido da vendedora
            // online (source='pdv_online') do pedido do site pela tag.
            source: true,
            customerName: true,
            customerPhone: true,
            customerCpf: true,
            customerEmail: true,
            shippingCep: true,
            shippingAddress: true,
            totalAmount: true,
            wcDateCreated: true,
            isPickup: true,
            pickupStoreCode: true,
            shippingMethod: true,
            // A MODALIDADE REAL do card sai daqui (21/08) — ver `servicoEnvio`
            // abaixo. Sem o checkoutInfo, "Frete grátis" não diz se é SEDEX
            // ou PAC e a loja lia "TRANSPORTADORA".
            checkoutInfo: true,
          },
        },
      },
    });
    // Items atribuídos a ESSA loja (um pedido multi-loja só mostra o pedaço dessa loja)
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const items = orderIds.length
      ? await this.prisma.orderItem.findMany({
          where: { orderId: { in: orderIds }, assignedStoreId: storeId },
        })
      : [];
    const itemsByOrder = new Map<string, any[]>();
    for (const it of items) {
      const arr = itemsByOrder.get(it.orderId) ?? [];
      arr.push(it);
      itemsByOrder.set(it.orderId, arr);
    }

    // Resolve transferToStoreName para os pick-orders de transferência
    const transferStoreCodes = [
      ...new Set(
        rows
          .map((r) => r.transferToStoreCode)
          .filter((c): c is string => !!c),
      ),
    ];
    const transferStores = transferStoreCodes.length
      ? await this.prisma.store.findMany({
          where: { code: { in: transferStoreCodes } },
          select: { code: true, name: true, city: true, state: true },
        })
      : [];
    const storeByCode = new Map(transferStores.map((s) => [s.code, s]));

    // ── JUNTADA (21/08): estado das caixas pros cards ─────────────────────
    // Card FEEDER mostra a própria caixa (código/rastreio/transporte); card
    // ÂNCORA mostra quantas caixas estão vindo e quantas já chegaram.
    const minhaLoja = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { code: true },
    });
    const caixasJuntada: any[] = rows.length
      ? await (this.prisma as any).realignmentShipment.findMany({
          where: {
            status: { not: 'cancelled' },
            OR: [
              { pickOrderId: { in: rows.map((r) => r.id) } },
              { orderId: { in: orderIds }, pickOrderId: { not: null } },
            ],
          },
          select: {
            id: true, code: true, status: true, trackingCode: true, carrier: true,
            transportMode: true, orderId: true, pickOrderId: true, toStoreCode: true,
            fromStoreName: true, receivedAt: true,
          },
        })
      : [];
    const caixaDoPick = new Map(caixasJuntada.map((c) => [c.pickOrderId, c]));
    const caixasDoPedido = new Map<string, any[]>();
    for (const c of caixasJuntada) {
      if (!c.orderId) continue;
      const arr = caixasDoPedido.get(c.orderId) ?? [];
      arr.push(c);
      caixasDoPedido.set(c.orderId, arr);
    }

    /**
     * ⚠️ A ÂNCORA PRECISA SABER ANTES DA CAIXA EXISTIR (21/08).
     *
     * A faixa "JUNTANDO PEÇAS" nascia das CAIXAS — e a caixa do feeder só
     * nasce no Finalizar da bipagem dele. Enquanto a outra loja não terminava,
     * a âncora via um card comum: separava as peças dela e ia mandar sozinha,
     * que é exatamente o que a juntada existe pra impedir (o backend recusa o
     * envio, mas aí ela já embalou e não entende o erro).
     *
     * Fonte certa é o PICK-ORDER FEEDER, que existe desde a hora em que a
     * juntada foi decidida: `isTransfer` + `transferToStoreCode` = minha loja.
     * A caixa, quando nasce, só enriquece a linha com código e rastreio.
     */
    const feedersDoPedido = new Map<string, any[]>();
    if (orderIds.length && minhaLoja?.code) {
      const feeders: any[] = await this.prisma.pickOrder.findMany({
        where: {
          orderId: { in: orderIds },
          isTransfer: true,
          transferToStoreCode: minhaLoja.code,
          status: { not: 'cancelled' },
        },
        select: {
          id: true,
          orderId: true,
          status: true,
          // A loja feeder pode ter REPORTADO problema: o card sai da fila dela
          // (o `listMine` esconde `issueReason`), e a âncora ficaria vendo
          // "ainda separando" pra sempre, sem ninguém separando nada. Fila que
          // mente é pior que fila vazia — aqui a âncora vê a verdade.
          issueReason: true,
          store: { select: { id: true, name: true, code: true } },
        },
      });
      // QUANTAS PEÇAS vêm de cada loja — é o que faz a âncora entender que o
      // pedido é COMPOSTO (ela vê 4 na tela e o pedido tem 6). Também é a
      // conferência de quando a caixa chegar.
      const pecasPorLojaPedido = new Map<string, number>();
      if (feeders.length) {
        const grupos = await this.prisma.orderItem.groupBy({
          by: ['orderId', 'assignedStoreId'],
          where: {
            orderId: { in: [...new Set(feeders.map((f) => f.orderId))] },
            assignedStoreId: { in: [...new Set(feeders.map((f) => f.store?.id).filter(Boolean))] },
          },
          _sum: { quantity: true },
        });
        for (const g of grupos) {
          pecasPorLojaPedido.set(`${g.orderId}~${g.assignedStoreId}`, g._sum.quantity ?? 0);
        }
      }
      for (const f of feeders) {
        const arr = feedersDoPedido.get(f.orderId) ?? [];
        arr.push({
          ...f,
          pecas: pecasPorLojaPedido.get(`${f.orderId}~${f.store?.id}`) ?? 0,
        });
        feedersDoPedido.set(f.orderId, arr);
      }
    }

    return rows.map((r) => {
      const transferToStore = r.transferToStoreCode
        ? storeByCode.get(r.transferToStoreCode) ?? null
        : null;
      // Parse do snapshot do cliente (só existe em transferências)
      let customerSnapshotObj: any = null;
      if (r.customerSnapshot) {
        try {
          customerSnapshotObj = JSON.parse(r.customerSnapshot);
        } catch {
          customerSnapshotObj = null;
        }
      }
      // JUNTADA: feeder = isTransfer num pedido que NÃO é retirada.
      const ehFeederJuntada = r.isTransfer && !r.order?.isPickup;
      const caixa = ehFeederJuntada ? caixaDoPick.get(r.id) ?? null : null;
      /**
       * Sou ÂNCORA? Card próprio (não-transferência) de pedido que NÃO é
       * retirada — a MESMA fronteira do `ehFeederJuntada` acima. Pedido de
       * RETIRADA dividido também tem card `isTransfer` apontando pra loja de
       * retirada, e aquilo é o pickup-transfer de sempre, não juntada:
       * mostrar "esta loja junta e envia" ali seria alarme falso (a cliente
       * é que vem buscar).
       */
      const souAncora = !r.isTransfer && !r.order?.isPickup;
      // As caixas que JÁ nasceram (só existem depois do Finalizar do feeder).
      const caixasChegando = souAncora
        ? (caixasDoPedido.get(r.orderId) ?? []).filter(
            (c) => c.toStoreCode === minhaLoja?.code && c.pickOrderId !== r.id,
          )
        : [];
      const caixaPorPick = new Map(caixasChegando.map((c) => [c.pickOrderId, c]));
      /**
       * Uma linha POR FEEDER — existe desde que a juntada foi decidida, com ou
       * sem caixa. O estágio conta a história pra loja: a outra ainda está
       * separando, já fechou a caixa, ou a caixa chegou aqui.
       */
      const chegando = souAncora
        ? (feedersDoPedido.get(r.orderId) ?? []).map((f: any) => {
            const caixa = caixaPorPick.get(f.id) ?? null;
            const etapa = caixa
              ? caixa.status === 'received'
                ? 'chegou'
                : 'a_caminho'
              : f.issueReason
                ? 'problema'
                : 'separando';
            return {
              code: caixa?.code ?? null,
              status: caixa?.status ?? f.status,
              etapa,
              fromStoreName: caixa?.fromStoreName ?? f.store?.name ?? null,
              trackingCode: caixa?.trackingCode ?? null,
              pecas: f.pecas ?? 0,
            };
          })
        : [];
      return {
        id: r.id,
        status: r.status,
        trackingCode: r.trackingCode,
        carrier: r.carrier,
        correiosPrepostagemId: (r as any).correiosPrepostagemId ?? null,
        correiosGeneratedAt: (r as any).correiosGeneratedAt ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        isTransfer: r.isTransfer,
        transferToStoreCode: r.transferToStoreCode,
        transferToStoreName: transferToStore?.name ?? null,
        transferToStoreCity: transferToStore?.city ?? null,
        customerSnapshot: customerSnapshotObj,
        /**
         * A MODALIDADE QUE A LOJA LÊ NA FAIXA DO CARD (dono, 21/08).
         *
         * O card classificava pelo TÍTULO do método, e "Frete Grátis" não diz
         * serviço nenhum: caía em "TRANSPORTADORA" e a vendedora não sabia se
         * postava SEDEX ou PAC. Aqui vai o serviço DE VERDADE — o mesmo
         * `servicoPagoDoPedido` que gera a pré-postagem, então a faixa e a
         * etiqueta nunca podem discordar ([[etiqueta-servico-por-uf]]).
         *
         * `freteGratis` é só a etiqueta "(grátis)" ao lado: o que a cliente
         * pagou de frete não muda o serviço que a loja posta.
         */
        servicoEnvio: servicoDoCard(r.order as any),
        // "Ninguém informou — isto aqui é chute da regra de UF." A faixa
        // avisa em vez de afirmar um serviço que não foi escolhido.
        servicoEnvioIncerto: envioIncerto(r.order as any),
        freteGratis: freteFoiGratis(r.order as any),
        // ── JUNTADA (21/08) ──
        juntadaFeeder: ehFeederJuntada,
        caixaJuntada: caixa
          ? {
              code: caixa.code,
              status: caixa.status,
              trackingCode: caixa.trackingCode,
              carrier: caixa.carrier,
              transportMode: caixa.transportMode ?? null,
            }
          : null,
        juntadaChegando: chegando.length
          ? {
              total: chegando.length,
              // "Recebidas" conta CAIXA QUE CHEGOU — é o que libera o envio.
              // Feeder ainda separando (sem caixa) não conta, de propósito.
              recebidas: chegando.filter((c) => c.etapa === 'chegou').length,
              // Quantas peças vêm de fora: com as da própria loja, é o total
              // do pedido composto que a âncora vai despachar.
              pecasChegando: chegando.reduce((s, c) => s + (c.pecas ?? 0), 0),
              caixas: chegando.map((c) => ({
                code: c.code,
                status: c.status,
                etapa: c.etapa,
                fromStoreName: c.fromStoreName,
                trackingCode: c.trackingCode,
                pecas: c.pecas,
              })),
            }
          : null,
        order: {
          ...r.order,
          items: itemsByOrder.get(r.orderId) ?? [],
        },
      };
    });
  }

  /**
   * O QUE ESTA LOJA VENDEU ONLINE E AINDA ESTÁ RODANDO (18/08).
   *
   * `listMine` mostra o que a loja ATENDE (pick-orders atribuídos a ela). Quem
   * VENDE online e não atende — a vendedora fecha no WhatsApp e o card nasce em
   * outra loja ([[venda-online-canal-loja-que-atende]]) — não tinha tela
   * NENHUMA: via o aviso no momento da venda e depois ficava no escuro, com a
   * cliente perguntando "cadê?" e só a matriz sabendo responder.
   *
   * Aqui a chave é `Order.sellerStoreCode` (a loja que vendeu), não o
   * `storeId` do pick (a que separa).
   *
   * Janela: sem De/Até traz os ÚLTIMOS 30 DIAS **mais** tudo que ainda está em
   * aberto de qualquer data — pedido travado há 45 dias é justamente o que ela
   * não pode deixar de ver. Com De/Até, só o período (pela data do pedido).
   *
   * É tela de ACOMPANHAMENTO, não de tarefa: nada aqui entra na fila "O que
   * fazer agora" — a ação é da loja que atende, e alarme falso mata a fila.
   */
  async listVendidosOnline(storeId: string, opts?: { from?: string; to?: string }) {
    const loja = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { code: true },
    });
    if (!loja?.code) return [];

    const de = opts?.from ? new Date(`${opts.from}T00:00:00`) : null;
    const ate = opts?.to ? new Date(`${opts.to}T23:59:59.999`) : null;
    const ENCERRADOS = ['delivered', 'cancelled', 'canceled', 'refunded'];

    const where: any = { sellerStoreCode: loja.code };
    if (de || ate) {
      where.createdAt = { ...(de ? { gte: de } : {}), ...(ate ? { lte: ate } : {}) };
    } else {
      const trintaDias = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      where.OR = [
        { createdAt: { gte: trintaDias } },
        { status: { notIn: ENCERRADOS } },
      ];
    }

    const orders = await this.prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        wcOrderId: true,
        wcOrderNumber: true,
        source: true,
        status: true,
        customerName: true,
        customerPhone: true,
        totalAmount: true,
        trackingCode: true,
        isPickup: true,
        pickupStoreCode: true,
        shippingMethod: true,
        createdAt: true,
        paidAt: true,
        items: { select: { quantity: true } },
        pickOrders: {
          select: {
            status: true,
            trackingCode: true,
            store: { select: { code: true, name: true } },
          },
        },
      },
    });

    // Onde cada objeto está AGORA — do cache `rastreio_objetos`, numa consulta
    // só pra lista inteira. Perguntar pra transportadora aqui seria um request
    // por card, a cada refresh da tela.
    const codigos = orders.flatMap((o: any) => [
      o.trackingCode,
      ...(o.pickOrders || []).map((p: any) => p.trackingCode),
    ]);
    const rastreios = await this.tracking.resumoDoCache(codigos).catch(() => new Map());

    return orders.map((o: any) => {
      const picks = (o.pickOrders || []).map((p: any) => ({
        status: p.status,
        storeCode: p.store?.code ?? null,
        storeName: p.store?.name ?? null,
      }));
      // Rastreio: o do pedido, ou o da separação que despachou.
      const rastreio =
        o.trackingCode ||
        (o.pickOrders || []).map((p: any) => p.trackingCode).find((t: any) => !!t) ||
        null;
      const movimento = rastreio
        ? rastreios.get(String(rastreio).trim().toUpperCase()) ?? null
        : null;
      const situacao = situacaoPedidoOnline({
        orderStatus: o.status,
        picks,
        trackingCode: rastreio,
        isPickup: !!o.isPickup,
        rastreio: movimento,
      });
      return {
        id: o.id,
        wcOrderId: o.wcOrderId,
        wcOrderNumber: o.wcOrderNumber,
        source: o.source,
        status: o.status,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        totalAmount: o.totalAmount,
        pecas: (o.items || []).reduce((n: number, it: any) => n + (Number(it.quantity) || 0), 0),
        criadoEm: o.paidAt ?? o.createdAt,
        entrega: {
          label: o.shippingMethod ?? null,
          isPickup: !!o.isPickup,
          pickupStoreCode: o.pickupStoreCode ?? null,
        },
        trackingCode: rastreio,
        // O que a transportadora diz, cru — a tela formata a data no fuso de
        // quem está olhando (o backend roda em UTC).
        rastreio: movimento
          ? {
              status: movimento.status,
              local: movimento.local,
              eventoEm: movimento.eventoEm,
              previsaoEm: movimento.previsaoEm,
              entregue: movimento.entregue,
              entregueEm: movimento.entregueEm,
              consultadoEm: movimento.consultadoEm,
            }
          : null,
        atendendo: picks,
        situacao,
        emAndamento: pedidoOnlineEmAndamento(situacao.chave),
      };
    });
  }

  /**
   * Matriz — lista todos os pick-orders com status `separated` (aguardando aprovação).
   * Ordenação: mais antigo primeiro (FIFO — quem separou primeiro, baixa primeiro).
   */
  async listPendingApproval() {
    const rows = await this.prisma.pickOrder.findMany({
      where: {
        // Qualquer coisa já separada mas ainda sem baixa aprovada — inclui shipped
        // (loja pode postar antes da matriz aprovar baixa no novo fluxo).
        status: { in: ['separated', 'ready', 'shipped'] },
        debitApprovedAt: null,
      } as any,
      orderBy: [{ updatedAt: 'asc' }],
      include: {
        store: { select: { id: true, code: true, name: true, city: true } },
        order: {
          select: {
            id: true,
            wcOrderId: true,
            wcOrderNumber: true,
            customerName: true,
            customerCpf: true,
            customerEmail: true,
            customerPhone: true,
            shippingCep: true,
            totalAmount: true,
          },
        },
      },
    });

    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const allItems = orderIds.length
      ? await this.prisma.orderItem.findMany({
          where: { orderId: { in: orderIds } },
        })
      : [];
    const itemsByPickOrder = new Map<string, any[]>();
    for (const r of rows) {
      const its = allItems.filter(
        (it) => it.orderId === r.orderId && it.assignedStoreId === r.storeId,
      );
      itemsByPickOrder.set(r.id, its);
    }

    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      waitingMinutes: Math.round((Date.now() - r.updatedAt.getTime()) / 60000),
      store: r.store,
      order: r.order,
      items: itemsByPickOrder.get(r.id) ?? [],
    }));
  }

  /**
   * Matriz — lista compacta de todos os pick-orders com issue REPORTADO e
   * ainda não resolvido (status new|separating, issueReason != null).
   *
   * Usado pela /separacao pra pintar badge vermelho no pedido da fila que
   * tem problema reportado por alguma loja. Resposta pequena pra ficar barato
   * cross-referenciar com a lista do WC (que pode ter centenas de itens).
   */
  /**
   * Lista pick-orders com status=shipped num intervalo, agrupados por loja.
   *
   * Usado pela tela /retaguarda/enviados-hoje pra matriz ver em tempo real o que
   * cada filial despachou no dia. O "shipped at" não tem coluna dedicada — usamos
   * `updatedAt` que é tocado quando a loja muda pra shipped (updateStatus).
   *
   * Default period: HOJE em horário SP (-03:00). Retorna agrupado + total geral.
   */
  async listShippedByStore(params: { from?: string; to?: string }) {
    // Se não veio data, usa HOJE (00:00 → 23:59:59.999 no fuso SP)
    // Guarda margem de 3h pra não perder cliente que enviou perto da meia-noite.
    const now = new Date();
    // Hoje em SP → pega timestamp UTC do 00:00 SP e do 23:59:59 SP
    const spMidnightLocal = new Date(now);
    spMidnightLocal.setHours(0, 0, 0, 0);
    // spMidnight em UTC = spMidnightLocal (trust server tz) — se servidor é UTC,
    // 00:00 SP == 03:00 UTC. Fazemos overlap generoso (24h anteriores).
    const defaultFrom = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const defaultTo = new Date(Date.now() + 1 * 60 * 60 * 1000);

    const from = params.from ? new Date(params.from) : defaultFrom;
    let to = params.to ? new Date(params.to) : defaultTo;
    // Se veio só data (YYYY-MM-DD), o to fica 00:00 — empurra pro final do dia
    if (params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to)) {
      to = new Date(params.to + 'T23:59:59.999Z');
    }

    const rows = await this.prisma.pickOrder.findMany({
      where: {
        status: { in: ['shipped', 'delivered'] },
        updatedAt: { gte: from, lte: to },
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        store: { select: { code: true, name: true } },
        order: {
          select: {
            id: true,
            wcOrderId: true,
            wcOrderNumber: true,
            customerName: true,
            customerPhone: true,
            totalAmount: true,
            isPickup: true,
            shippingMethod: true,
            trackingCode: true,
            carrier: true,
            items: {
              select: { sku: true, quantity: true, productName: true },
            },
          } as any,
        },
      },
    });

    // Agrupa por storeCode
    const byStoreMap = new Map<string, {
      storeCode: string;
      storeName: string;
      count: number;
      totalItems: number;
      totalRevenue: number;
      transferCount: number;
      pickupCount: number;
      rows: Array<{
        pickOrderId: string;
        wcOrderId: number | null;
        wcOrderNumber: string | null;
        customerName: string | null;
        customerPhone: string | null;
        totalAmount: number | null;
        shippingMethod: string | null;
        // rastreio: prioriza do pick-order (que a loja preencheu no shipped),
        // senão cai pro order (WC).
        trackingCode: string | null;
        carrier: string | null;
        shippedAt: Date;
        itemsCount: number;
        isPickup: boolean;
        isTransfer: boolean;
        transferToStoreCode: string | null;
      }>;
    }>();

    for (const r of rows) {
      const code = r.store?.code ?? 'SEM_LOJA';
      const name = r.store?.name ?? 'Sem loja';
      const o: any = r.order;
      const itemsCount = Array.isArray(o?.items)
        ? o.items.reduce((acc: number, it: any) => acc + (Number(it.quantity) || 0), 0)
        : 0;
      const amount = Number(o?.totalAmount ?? 0);
      const isTransfer = (r as any).isTransfer === true;
      const isPickup = o?.isPickup === true;

      const cur = byStoreMap.get(code) ?? {
        storeCode: code,
        storeName: name,
        count: 0,
        totalItems: 0,
        totalRevenue: 0,
        transferCount: 0,
        pickupCount: 0,
        rows: [],
      };
      cur.count++;
      cur.totalItems += itemsCount;
      cur.totalRevenue += amount;
      if (isTransfer) cur.transferCount++;
      if (isPickup) cur.pickupCount++;
      cur.rows.push({
        pickOrderId: r.id,
        wcOrderId: o?.wcOrderId ?? null,
        wcOrderNumber: o?.wcOrderNumber ?? null,
        customerName: o?.customerName ?? null,
        customerPhone: o?.customerPhone ?? null,
        totalAmount: amount || null,
        shippingMethod: o?.shippingMethod ?? null,
        trackingCode: r.trackingCode ?? o?.trackingCode ?? null,
        carrier: r.carrier ?? o?.carrier ?? null,
        shippedAt: r.updatedAt,
        itemsCount,
        isPickup,
        isTransfer,
        transferToStoreCode: (r as any).transferToStoreCode ?? null,
      });
      byStoreMap.set(code, cur);
    }

    const byStore = Array.from(byStoreMap.values()).sort((a, b) => b.count - a.count);
    const grand = {
      count: rows.length,
      totalItems: byStore.reduce((acc, s) => acc + s.totalItems, 0),
      totalRevenue: byStore.reduce((acc, s) => acc + s.totalRevenue, 0),
      storesCount: byStore.length,
      transferCount: byStore.reduce((acc, s) => acc + s.transferCount, 0),
      pickupCount: byStore.reduce((acc, s) => acc + s.pickupCount, 0),
    };

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      grand,
      byStore,
    };
  }

  async listIssuesActive() {
    const rows = await this.prisma.pickOrder.findMany({
      where: {
        issueReason: { not: null },
        status: { in: ['new', 'separating'] },
      } as any,
      orderBy: { issueReportedAt: 'desc' } as any,
      include: {
        store: { select: { code: true, name: true } },
        order: { select: { wcOrderId: true, wcOrderNumber: true } },
      },
    });

    const reasonLabels: Record<string, string> = {
      out_of_stock: 'Sem estoque físico',
      defective: 'Peça com defeito',
      divergence: 'Divergência (cor/tamanho)',
      other: 'Outro',
    };

    const cards = rows.map((r) => {
      const reason = (r as any).issueReason as string;
      return {
        pickOrderId: r.id,
        wcOrderId: r.order?.wcOrderId ?? null,
        wcOrderNumber: r.order?.wcOrderNumber ?? null,
        storeCode: r.store?.code ?? null,
        storeName: r.store?.name ?? null,
        reason,
        reasonLabel: reasonLabels[reason] ?? reason,
        note: (r as any).issueNote ?? null,
        reportedAt: (r as any).issueReportedAt ?? null,
        itemLevel: false,
      };
    });

    // Reportes POR PEÇA ("não achei na bipagem") — o card seguiu com o resto,
    // mas a peça está sem loja esperando a matriz. Mesmo shape do badge.
    const abertos = await this.autoResolveReports(
      await this.prisma.pickOrderItemReport.findMany({
        where: { resolvedAt: null },
        orderBy: { reportedAt: 'desc' },
        take: 200,
      }),
    );
    if (abertos.length) {
      const orderIds = [...new Set(abertos.map((r: any) => r.orderId))];
      const orders = await this.prisma.order.findMany({
        where: { id: { in: orderIds }, status: { notIn: ['cancelled', 'refunded'] as any } },
        select: { id: true, wcOrderId: true, wcOrderNumber: true },
      });
      const orderById = new Map(orders.map((o) => [o.id, o]));
      const storeCodes = [...new Set(abertos.map((r: any) => r.storeCode))];
      const stores = await this.prisma.store.findMany({
        where: { code: { in: storeCodes } },
        select: { code: true, name: true },
      });
      const storeByCode = new Map(stores.map((s) => [s.code, s.name]));
      for (const r of abertos) {
        const o = orderById.get(r.orderId);
        if (!o) continue; // pedido cancelado/apagado — reporte não interessa mais
        const peca = [r.ref, r.cor, r.tamanho].filter(Boolean).join(' · ') || r.sku;
        cards.push({
          pickOrderId: r.pickOrderId,
          wcOrderId: o.wcOrderId ?? null,
          wcOrderNumber: o.wcOrderNumber ?? null,
          storeCode: r.storeCode,
          storeName: storeByCode.get(r.storeCode) ?? r.storeCode,
          reason: r.reason,
          reasonLabel: `Peça faltou: ${peca} (${r.qtyMissing} un) — ${r.reasonLabel}`,
          note: r.note,
          reportedAt: r.reportedAt,
          itemLevel: true,
        });
      }
    }
    return cards;
  }

  /**
   * Matriz aprova a baixa do pick-order.
   *
   * Modos (controlado por env `ERP_WRITE_ENABLED`):
   *
   *  REAL (ERP_WRITE_ENABLED=true):
   *    - Chama `erp.decreaseStock(items)` que executa UPDATE estoque em transação.
   *    - Se falhar (ex: estoque insuficiente, SKU não existe, timeout), bloqueia
   *      a aprovação e lança BadRequestException — operadora vê o erro e decide.
   *    - Sucesso → grava log `debit.real.applied` em integration_logs.
   *
   *  SHADOW (default):
   *    - Apenas grava `debit.approved.shadow` em integration_logs.
   *    - Não toca no Gigasistemas. Operadora ainda precisa passar no PDV manualmente.
   *
   * Em ambos os casos, marca `debitApprovedAt` no pick-order. O status logístico
   * (separated/shipped) fica intacto — baixa é independente do fluxo de envio.
   */
  async approveDebit(pickOrderId: string, operatorUserId: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: {
        id: true,
        status: true,
        storeId: true,
        orderId: true,
        debitApprovedAt: true,
        store: { select: { code: true, name: true } },
      } as any,
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    // Aceita aprovar em qualquer status DEPOIS que a loja bipou (separated, ready, shipped).
    // Nunca antes — não dá pra aprovar baixa sem validação de itens.
    const okStatuses: PickStatus[] = ['separated', 'ready', 'shipped'];
    if (!okStatuses.includes(po.status as PickStatus)) {
      throw new BadRequestException(
        `Status atual é "${po.status}" — só aprova depois da separação bipada`,
      );
    }
    if ((po as any).debitApprovedAt) {
      throw new BadRequestException('Baixa já foi aprovada anteriormente');
    }

    const items = await this.prisma.orderItem.findMany({
      where: { orderId: po.orderId, assignedStoreId: po.storeId },
      select: { sku: true, quantity: true, productName: true },
    });

    const storeCode = String(((po as any).store?.code) ?? '').trim();
    const writeEnabled = this.erp.isWriteEnabled;
    let realApplied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }> | null = null;

    if (writeEnabled) {
      // Validação: sem código de loja (LJ01/01) não dá pra baixar no Giga
      if (!storeCode) {
        throw new BadRequestException(
          'Loja sem código configurado (store.code vazio) — não é possível baixar no Gigasistemas',
        );
      }

      // SÓ O QUE FALTA: a peça que já saiu no bipe não desce de novo quando a
      // matriz aprova na mão. `applied: []` aqui significa "nada a fazer, o
      // estoque já está certo" — não significa que a baixa falhou.
      const pendentes = await this.scans.pendingDebitItems(
        pickOrderId,
        (po as any).orderId,
        (po as any).storeId,
        storeCode,
      );

      const result: {
        success: boolean;
        applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }>;
        error?: string;
      } = pendentes.length
        ? await this.erp.decreaseStockAsync(pendentes)
        : { success: true, applied: [] };

      if (!result.success) {
        // Log de falha pra auditoria (tabela integration_logs)
        await this.prisma.integrationLog.create({
          data: {
            source: 'erp',
            direction: 'out',
            event: 'debit.real.failed',
            payload: JSON.stringify({
              pickOrderId,
              approvedBy: operatorUserId,
              storeCode,
              items: items.map((i) => ({ sku: i.sku, qty: i.quantity, name: i.productName })),
              pendentes,
              error: result.error,
            }),
            status: 500,
            error: result.error?.slice(0, 500),
          },
        });
        throw new BadRequestException(
          `Falha ao baixar estoque no Gigasistemas: ${result.error ?? 'erro desconhecido'}`,
        );
      }

      realApplied = result.applied;

      // Log de sucesso com o antes/depois de cada SKU pra auditoria
      await this.prisma.integrationLog.create({
        data: {
          source: 'erp',
          direction: 'out',
          event: 'debit.real.applied',
          payload: JSON.stringify({
            pickOrderId,
            approvedBy: operatorUserId,
            storeCode,
            applied: result.applied,
            ...(pendentes.length ? {} : { note: 'nada a baixar — estoque já saiu peça a peça no bipe' }),
          }),
          status: 200,
        },
      });
    } else {
      // SHADOW: grava intenção de baixa pra auditoria/comparação
      await this.prisma.integrationLog.create({
        data: {
          source: 'pick-order',
          direction: 'internal',
          event: 'debit.approved.shadow',
          payload: JSON.stringify({
            pickOrderId,
            approvedBy: operatorUserId,
            storeId: po.storeId,
            storeCode,
            items: items.map((i) => ({ sku: i.sku, qty: i.quantity, name: i.productName })),
            note: 'SHADOW MODE — ERP_WRITE_ENABLED=false. Baixa manual no PDV ainda é necessária.',
          }),
          status: 200,
        },
      });
    }

    // Só seta o flag de aprovação. NÃO mexe em status logístico.
    const updated = await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: {
        debitApprovedAt: new Date(),
        debitApprovedBy: operatorUserId,
      } as any,
    });

    return {
      id: updated.id,
      status: updated.status,
      debitApprovedAt: (updated as any).debitApprovedAt,
      shadowMode: !writeEnabled,
      realApplied,
      itemsCount: items.length,
    };
  }

  /**
   * Matriz aprova baixa em LOTE — recebe array de pick-order IDs, itera e aprova
   * cada um. Não é transacional (se um falhar, os outros já aprovados continuam).
   * Retorna summary: approved/skipped/errors pra UI mostrar o que rolou.
   *
   * Usa um único integration_log "debit.bulk-approved.shadow" agregando o batch
   * inteiro (além dos logs individuais por pick-order que `approveDebit` já cria).
   */
  async bulkApproveDebit(pickOrderIds: string[], operatorUserId: string) {
    const ids = Array.from(new Set((pickOrderIds ?? []).filter(Boolean)));
    if (ids.length === 0) {
      return { approved: [], skipped: [], errors: [], total: 0 };
    }

    const approved: Array<{ id: string; itemsCount: number }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        const res = await this.approveDebit(id, operatorUserId);
        approved.push({ id: res.id, itemsCount: res.itemsCount });
      } catch (e: any) {
        const msg = String(e?.message ?? 'erro desconhecido');
        // Distingue "já aprovado" / "status inválido" (skipped) de erro real
        if (
          msg.includes('já foi aprovada') ||
          msg.includes('só aprova depois') ||
          msg.includes('não encontrado')
        ) {
          skipped.push({ id, reason: msg });
        } else {
          errors.push({ id, error: msg });
        }
      }
    }

    const writeEnabled = this.erp.isWriteEnabled;

    // Log agregado pro auditoria rápida do batch. Event reflete o modo.
    await this.prisma.integrationLog.create({
      data: {
        source: writeEnabled ? 'erp' : 'pick-order',
        direction: writeEnabled ? 'out' : 'internal',
        event: writeEnabled ? 'debit.bulk-approved.real' : 'debit.bulk-approved.shadow',
        payload: JSON.stringify({
          approvedBy: operatorUserId,
          total: ids.length,
          approvedCount: approved.length,
          skippedCount: skipped.length,
          errorCount: errors.length,
          approvedIds: approved.map((a) => a.id),
          skipped,
          errors,
        }),
        status: 200,
      },
    });

    return {
      approved,
      skipped,
      errors,
      total: ids.length,
      shadowMode: !writeEnabled,
    };
  }

  /**
   * Matriz rejeita a baixa — volta pra `separating` pra loja revisar.
   * Grava motivo no log pra loja consultar.
   */
  async rejectDebit(pickOrderId: string, operatorUserId: string, reason: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: { id: true, status: true, storeId: true, debitApprovedAt: true } as any,
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    // Só rejeita se loja ainda não postou (não faz sentido rejeitar algo que já foi).
    if (po.status === 'shipped') {
      throw new BadRequestException(
        'Pedido já foi enviado — não dá pra rejeitar. Use ajuste manual no ERP.',
      );
    }
    if (po.status !== 'separated' && po.status !== 'ready') {
      throw new BadRequestException(`Status atual é "${po.status}" — só rejeita depois da bipagem`);
    }

    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'debit.rejected',
        payload: JSON.stringify({
          pickOrderId,
          rejectedBy: operatorUserId,
          reason: reason?.trim() || '(sem motivo informado)',
        }),
        status: 200,
      },
    });

    const updated = await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: { status: 'separating' },
    });

    this.gateway.emitPickOrderStatus(po.storeId, {
      id: updated.id,
      status: 'separating',
    });

    return { id: updated.id, status: updated.status, reason };
  }

  /**
   * Reabre a baixa de um pick-order aprovado (seta debitApprovedAt=null).
   * Serve pra devolver o pick-order pra tela /baixa-estoque quando a baixa foi
   * aprovada em modo SHADOW e agora o ERP_WRITE_ENABLED foi ativado — a operadora
   * quer tentar de novo LIVE.
   *
   * PROTEÇÕES (evita baixa dupla):
   *   - Bloqueia se já existe log `debit.real.applied` pra esse pickOrderId
   *     (ERP já foi tocado de verdade — reabrir causaria estoque -2 em vez de -1)
   *   - Bloqueia se debitApprovedAt é null (já está na fila)
   *   - Bloqueia se pick-order não existe
   *
   * Grava log `debit.reopened` com motivo pra auditoria.
   */
  async reopenDebit(pickOrderId: string, operatorUserId: string, reason?: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: {
        id: true, status: true, storeId: true,
        debitApprovedAt: true,
        store: { select: { code: true, name: true } },
      } as any,
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (!(po as any).debitApprovedAt) {
      throw new BadRequestException('Baixa ainda não foi aprovada — não tem o que reabrir');
    }

    // PROTEÇÃO CRÍTICA: procura log de debit.real.applied pra esse pickOrderId.
    // Se existir, ERP já foi tocado — reabrir baixaria de novo (estoque dobrado).
    // Procuramos via `contains` no payload JSON porque event/source é comum.
    const liveLog = await this.prisma.integrationLog.findFirst({
      where: {
        source: 'erp',
        event: 'debit.real.applied',
        payload: { contains: `"pickOrderId":"${pickOrderId}"` },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
    if (liveLog) {
      throw new BadRequestException(
        `Este pick-order já foi baixado no Gigasistemas em modo LIVE (log #${liveLog.id}). ` +
        'Reabrir causaria baixa dupla. Se precisar ajustar, faça direto no ERP.',
      );
    }

    // Audit: log da reabertura
    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'debit.reopened',
        payload: JSON.stringify({
          pickOrderId,
          reopenedBy: operatorUserId,
          storeCode: (po as any).store?.code ?? null,
          storeName: (po as any).store?.name ?? null,
          previousApprovedAt: (po as any).debitApprovedAt,
          reason: reason?.trim() || null,
        }),
        status: 200,
      },
    });

    // Reseta a aprovação → volta pra fila de /baixa-estoque
    const updated = await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: {
        debitApprovedAt: null,
        debitApprovedBy: null,
      } as any,
    });

    return {
      id: updated.id,
      status: updated.status,
      debitApprovedAt: null,
      reopened: true,
    };
  }

  /**
   * Reabre baixa em LOTE. Itera sobre os IDs chamando reopenDebit.
   * Retorna summary (reopened/skipped/blocked/errors) — blocked separa os casos
   * "já foi LIVE" pra operadora entender por que alguns não voltaram.
   *
   * Grava log agregado `debit.bulk-reopened` com contadores.
   */
  async bulkReopenDebit(pickOrderIds: string[], operatorUserId: string, reason?: string) {
    const ids = Array.from(new Set((pickOrderIds ?? []).filter(Boolean)));
    if (ids.length === 0) {
      return { reopened: [], skipped: [], blocked: [], errors: [], total: 0 };
    }

    const reopened: Array<{ id: string }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const blocked: Array<{ id: string; reason: string }> = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        await this.reopenDebit(id, operatorUserId, reason);
        reopened.push({ id });
      } catch (e: any) {
        const msg = String(e?.message ?? 'erro desconhecido');
        if (msg.includes('não encontrado') || msg.includes('ainda não foi aprovada')) {
          skipped.push({ id, reason: msg });
        } else if (msg.includes('baixa dupla') || msg.includes('LIVE')) {
          blocked.push({ id, reason: msg });
        } else {
          errors.push({ id, error: msg });
        }
      }
    }

    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'debit.bulk-reopened',
        payload: JSON.stringify({
          reopenedBy: operatorUserId,
          reason: reason?.trim() || null,
          total: ids.length,
          reopenedCount: reopened.length,
          skippedCount: skipped.length,
          blockedCount: blocked.length,
          errorCount: errors.length,
          reopenedIds: reopened.map((r) => r.id),
          skipped,
          blocked,
          errors,
        }),
        status: 200,
      },
    });

    return { reopened, skipped, blocked, errors, total: ids.length };
  }

  /**
   * RETRY DA BAIXA AUTOMÁTICA que falhou (ETIMEDOUT, ECONNRESET, etc).
   *
   * Quando o pick-order foi marcado 'shipped' e o autoDebitOnShipped tentou
   * bater no Giga mas falhou (ex: rede caiu), o pick-order fica em limbo:
   *   - status = 'shipped' ✅ (pra loja, o pedido saiu)
   *   - debitApprovedAt = null ❌ (matriz não debitou de verdade)
   *   - tem log `debit.real.failed` ❌ (evidência de falha)
   *
   * Isso bagunça o estoque (venda enviada mas não baixada no ERP).
   * `reopenDebit` não resolve porque ele exige `debitApprovedAt != null`
   * (ele é pra desfazer uma baixa já aprovada — aqui é o OPOSTO).
   *
   * Esse método:
   *   1. Valida que o pick-order está em estado LIVE FALHOU (shipped + sem aprovação + tem log falhou)
   *   2. Valida anti-dupla (sem log debit.real.applied)
   *   3. Re-executa autoDebitOnShipped (que agora tem retry automático no ERP)
   *   4. Loga `debit.retry.attempted` com resultado pra auditoria
   *   5. Retorna o resultado (aplicado / ainda falhou)
   *
   * Chamado por POST /pick-orders/:id/retry-auto-debit (botão "Retry" no log de baixas).
   */
  async retryAutoDebit(pickOrderId: string, operatorUserId: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: {
        id: true,
        status: true,
        storeId: true,
        orderId: true,
        debitApprovedAt: true,
        store: { select: { code: true, name: true } },
      } as any,
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');

    // GUARD 1: já tem baixa aprovada → usar reopenDebit, não retry
    if ((po as any).debitApprovedAt) {
      throw new BadRequestException(
        'Pick-order já tem baixa aprovada. Se quer refazer, use "Reabrir" na tela /baixa-estoque.',
      );
    }

    // GUARD 2: precisa estar em estado pós-envio (shipped) pra fazer sentido retry
    // Aceita variações caso futuramente o enum mude.
    const st = String((po as any).status ?? '').toLowerCase();
    if (st !== 'shipped') {
      throw new BadRequestException(
        `Pick-order está em status "${st}" — retry de baixa automática só faz sentido após 'shipped'.`,
      );
    }

    // GUARD 3: anti-dupla — se já existe debit.real.applied, ERP já foi tocado
    const priorApplied = await this.prisma.integrationLog.findFirst({
      where: {
        source: 'erp',
        event: 'debit.real.applied',
        payload: { contains: `"pickOrderId":"${pickOrderId}"` },
      },
      select: { id: true },
    });
    if (priorApplied) {
      throw new BadRequestException(
        `Já existe log debit.real.applied #${priorApplied.id} — ERP foi baixado. ` +
        'Retry causaria baixa dupla. Veja o log ou corrija direto no Giga.',
      );
    }

    // GUARD 4: precisa ter log de falha pra justificar o retry (evita disparo aleatório)
    const priorFailed = await this.prisma.integrationLog.findFirst({
      where: {
        source: 'erp',
        event: 'debit.real.failed',
        payload: { contains: `"pickOrderId":"${pickOrderId}"` },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
    if (!priorFailed) {
      throw new BadRequestException(
        'Nenhuma falha anterior registrada pra esse pick-order. Nada pra tentar de novo.',
      );
    }

    // Auditoria — loga intenção ANTES de tentar
    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'debit.retry.attempted',
        payload: JSON.stringify({
          pickOrderId,
          retryBy: operatorUserId,
          storeCode: (po as any).store?.code ?? null,
          storeName: (po as any).store?.name ?? null,
          previousFailedLogId: priorFailed.id,
        }),
        status: 200,
      },
    });

    // Re-executa a lógica de auto-baixa. autoDebitOnShipped já cuida de
    // logar debit.real.failed/applied e atualizar debitApprovedAt em caso de sucesso.
    const result = await this.autoDebitOnShipped(pickOrderId, operatorUserId);

    return {
      pickOrderId,
      attempted: result.attempted,
      applied: result.applied,
      skipped: result.skipped,
      shadow: result.shadow,
      reason: result.reason,
    };
  }

  /**
   * Lista TODOS os pick-orders de um pedido WC (matriz-only).
   * Usado pela tela /pedidos/wc/[id] pra mostrar status de cada loja ao vivo,
   * incluindo rastreio quando enviado. Join com store pra ter nome/code.
   */
  async listByWcOrderId(wcOrderId: number) {
    const order = await this.prisma.order.findFirst({
      where: { wcOrderId },
      select: { id: true },
    });
    if (!order) return [];

    const rows = await this.prisma.pickOrder.findMany({
      where: { orderId: order.id },
      orderBy: [{ createdAt: 'asc' }],
      include: {
        store: { select: { id: true, code: true, name: true, city: true } },
      },
    });
    // ITENS de cada loja (14/07 skus p/ "Trocar loja"; 15/07 lista completa p/
    // a operadora VER quais peças cada loja separa e decidir consolidar). Item
    // vai pra loja onde foi assignado; sem assignação (pedido de loja única)
    // conta pra loja se for a única pick-order.
    const itens = await this.prisma.orderItem.findMany({
      where: { orderId: order.id },
      select: {
        sku: true,
        productName: true,
        ref: true,
        cor: true,
        tamanho: true,
        quantity: true,
        assignedStoreId: true,
      },
    });
    const soUmaLoja = rows.length === 1;
    const itensDaStore = (storeId: string) =>
      itens.filter((i) => i.assignedStoreId === storeId || (soUmaLoja && !i.assignedStoreId));
    const skusPorStore = (storeId: string): string[] =>
      Array.from(new Set(itensDaStore(storeId).map((i) => String(i.sku || '').trim()).filter(Boolean)));
    const itemsPorStore = (storeId: string) =>
      itensDaStore(storeId).map((i) => ({
        sku: String(i.sku || '').trim(),
        descricao: i.productName || null,
        ref: (i as any).ref || null,
        cor: (i as any).cor || null,
        tamanho: (i as any).tamanho || null,
        qty: Number(i.quantity) || 1,
      }));
    // JUNTADA (21/08): caixa de cada card feeder pra tela do pedido mostrar
    // o progresso ("caixa em trânsito", "chegou").
    const caixasJuntada: any[] = await (this.prisma as any).realignmentShipment.findMany({
      where: { pickOrderId: { in: rows.map((r) => r.id) }, status: { not: 'cancelled' } },
      select: {
        code: true, status: true, trackingCode: true, carrier: true,
        transportMode: true, pickOrderId: true, sentAt: true, receivedAt: true,
      },
    });
    const caixaDoPick = new Map(caixasJuntada.map((c) => [c.pickOrderId, c]));
    const reasonLabels: Record<string, string> = {
      out_of_stock: 'Sem estoque físico',
      defective: 'Peça com defeito',
      divergence: 'Divergência (cor/tamanho)',
      other: 'Outro',
    };
    return rows.map((r) => {
      const issueReason = (r as any).issueReason ?? null;
      const debitApprovedAt = (r as any).debitApprovedAt ?? null;
      // Status da baixa ERP (Gigasistemas):
      //   applied  = baixa LIVE aplicada (debitApprovedAt preenchido)
      //   pending  = ainda não é hora (pick-order não enviado)
      //   missing  = foi enviado (shipped) MAS sem baixa aprovada → auto-baixa pode ter falhado
      //             → operadora deve ir em /retaguarda/baixas-log pra diagnosticar
      let debitStatus: 'applied' | 'pending' | 'missing';
      if (debitApprovedAt) debitStatus = 'applied';
      else if (r.status === 'shipped') debitStatus = 'missing';
      else debitStatus = 'pending';

      return {
        id: r.id,
        status: r.status,
        trackingCode: r.trackingCode,
        carrier: r.carrier,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        storeId: r.storeId,
        storeCode: r.store?.code ?? null,
        storeName: r.store?.name ?? null,
        storeCity: r.store?.city ?? null,
        // SKUs desta loja (pra cobertura do "Trocar loja" — ver acima).
        skus: skusPorStore(r.storeId),
        // Peças que ESTA loja separa (descrição + qtd) — a operadora vê o que
        // foi roteado pra cada uma e decide consolidar (evitar 2 SEDEX).
        items: itemsPorStore(r.storeId),
        isTransfer: (r as any).isTransfer ?? false,
        transferToStoreCode: (r as any).transferToStoreCode ?? null,
        // ── JUNTADA (21/08): a caixa deste feeder, se existir ──
        caixaJuntada: caixaDoPick.get(r.id) ?? null,
        issueReason,
        issueReasonLabel: issueReason ? reasonLabels[issueReason] ?? issueReason : null,
        issueNote: (r as any).issueNote ?? null,
        issueReportedAt: (r as any).issueReportedAt ?? null,
        // Status de baixa no ERP (Gigasistemas)
        debitApprovedAt,
        debitStatus,
      };
    });
  }

  /**
   * Detalhe de 1 pick-order. Valida que pertence à loja do user.
   * Retorna dados completos do cliente (CPF/email/telefone/endereço) +
   * forma de envio pro cupom de impressão e tela da filial exibirem tudo
   * que é útil pra despacho, follow-up ou emissão de NF.
   */
  async getOne(id: string, storeId: string) {
    const row = await this.prisma.pickOrder.findUnique({
      where: { id },
      include: { order: { include: { items: true } }, store: true },
    });
    if (!row) throw new NotFoundException('Pick-order não encontrado');
    if (row.storeId !== storeId) {
      throw new ForbiddenException('Pick-order não pertence à sua loja');
    }
    // Filtra itens só dessa loja
    const items = row.order.items.filter(
      (i) => !i.assignedStoreId || i.assignedStoreId === storeId,
    );
    // Parse snapshot do cliente (só em transferência) pro frontend não precisar
    // parsear JSON textual de novo.
    let customerSnapshotObj: any = null;
    if ((row as any).customerSnapshot) {
      try {
        customerSnapshotObj = JSON.parse((row as any).customerSnapshot);
      } catch {
        customerSnapshotObj = null;
      }
    }
    return {
      id: row.id,
      status: row.status,
      trackingCode: row.trackingCode,
      carrier: row.carrier,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      isTransfer: (row as any).isTransfer ?? false,
      transferToStoreCode: (row as any).transferToStoreCode ?? null,
      customerSnapshot: customerSnapshotObj,
      store: {
        id: row.store.id,
        code: row.store.code,
        name: row.store.name,
      },
      order: {
        id: row.order.id,
        wcOrderId: row.order.wcOrderId,
        wcOrderNumber: row.order.wcOrderNumber,
        customerName: row.order.customerName,
        customerPhone: row.order.customerPhone,
        customerCpf: row.order.customerCpf,
        customerEmail: row.order.customerEmail,
        shippingCep: row.order.shippingCep,
        shippingAddress: row.order.shippingAddress,
        shippingMethod: (row.order as any).shippingMethod ?? null,
        isPickup: (row.order as any).isPickup ?? false,
        pickupStoreCode: (row.order as any).pickupStoreCode ?? null,
        totalAmount: row.order.totalAmount,
        wcDateCreated: row.order.wcDateCreated,
        items,
      },
    };
  }

  /**
   * TESTE: cria um pick-order forçado pra uma loja específica (ignora estoque/roteamento).
   * Se orderId não for passado, cria um Order sintético (TESTE-<timestamp>) com 2 itens.
   * Emite socket pra loja receber em tempo real na /minha-loja.
   */
  /**
   * Remove um pick-order específico (cancelamento manual da retaguarda).
   * Items dele ficam SEM atribuição (assignedStoreId=null) — retaguarda
   * resolveu fora do sistema. Outros pick-orders do mesmo Order ficam intactos.
   *
   * Bloqueia se status=shipped/delivered (envio já feito, não cancelar).
   */
  async removePickOrder(pickOrderId: string): Promise<{
    ok: boolean;
    pickOrderId: string;
    storeCode: string;
    storeName: string;
    itemsLiberados: number;
    pecasEstornadas: number;
  }> {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      include: {
        store: { select: { id: true, code: true, name: true } },
        order: { select: { id: true } },
      },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');

    // Não permite remover quem já enviou (preservar tracking/baixa Giga)
    const blocked = ['shipped', 'delivered'];
    if (blocked.includes(po.status)) {
      throw new BadRequestException(
        `Não dá pra remover pick-order com status "${po.status}". Use Trocar Loja se precisar reverter.`,
      );
    }

    const orderId = po.order.id;
    const storeId = po.store.id;
    const storeCode = po.store.code;
    const storeName = po.store.name;

    // Conta items que estavam atribuídos a essa loja (pra retornar count)
    const itemsLiberados = await this.prisma.orderItem.count({
      where: { orderId, assignedStoreId: storeId },
    });

    // ESTORNO ANTES DE APAGAR: a linha do bipe não tem FK pro card (ela é a
    // prova de que a peça saiu), mas o `assignedStoreId` dos itens é zerado
    // logo abaixo — depois disso ninguém mais sabe quantas peças a loja tinha
    // pra devolver. Ordem importa.
    const estorno = await this.scans.revertPickOrderStock(pickOrderId, {
      reason: 'remove_card',
      userId: null,
    });

    await this.prisma.$transaction(async (tx) => {
      // Libera items
      await tx.orderItem.updateMany({
        where: { orderId, assignedStoreId: storeId },
        data: { assignedStoreId: null },
      });
      // Deleta pick-order
      await tx.pickOrder.delete({ where: { id: pickOrderId } });
      // Histórico
      await tx.orderHistory.create({
        data: {
          orderId,
          fromStatus: po.status,
          toStatus: po.status,
          note:
            `Pick-order da loja ${storeCode} REMOVIDO manualmente pela retaguarda. ` +
            `${itemsLiberados} item(ns) liberado(s) (sem reatribuição). ` +
            (estorno.pecas ? `${estorno.pecas} peça(s) já bipada(s) devolvida(s) ao estoque da ${storeCode}. ` : '') +
            (po.issueReason ? `Motivo do problema reportado: ${po.issueReason}.` : ''),
        },
      });
    });

    // Notifica loja por socket pra remover o card do app /minha-loja
    try {
      this.gateway?.emitPickOrderRemoved?.(storeId, { orderId });
    } catch (e: any) {
      this.logger.warn(`Falha ao emitir socket: ${e?.message}`);
    }

    return { ok: true, pickOrderId, storeCode, storeName, itemsLiberados, pecasEstornadas: estorno.pecas };
  }

  async forceCreateForStore(storeCode: string, orderId?: string) {
    if (!storeCode?.trim()) throw new BadRequestException('storeCode obrigatório');
    const store = await this.prisma.store.findUnique({ where: { code: storeCode.trim() } });
    if (!store) throw new NotFoundException(`Loja com código "${storeCode}" não existe`);

    let order: any;
    if (orderId) {
      order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) throw new NotFoundException(`Order ${orderId} não encontrado`);
    } else {
      const stamp = Date.now();
      order = await this.prisma.order.create({
        data: {
          wcOrderId: stamp,
          wcOrderNumber: `TESTE-${stamp}`,
          customerName: 'Cliente TESTE',
          customerPhone: '(11) 99999-0000',
          shippingCep: '04077-000',
          shippingAddress: 'Av. Ibirapuera, 3103 - Moema, São Paulo - SP',
          totalAmount: 199.9,
          status: 'separating',
          items: {
            create: [
              {
                sku: 'TESTE-SKU-1',
                productName: 'Vestido Plus Size Exemplo (Tam G)',
                quantity: 2,
                assignedStoreId: store.id,
              },
              {
                sku: 'TESTE-SKU-2',
                productName: 'Blusa Manga Longa (Tam GG)',
                quantity: 1,
                assignedStoreId: store.id,
              },
            ],
          },
        },
        include: { items: true },
      });
    }

    const pickOrder = await this.prisma.pickOrder.create({
      data: { orderId: order.id, storeId: store.id, status: 'new' },
    });

    this.gateway.emitPickOrderToStore(store.id, {
      id: pickOrder.id,
      status: 'new',
      storeId: store.id,
      orderId: order.id,
      order: {
        id: order.id,
        wcOrderId: order.wcOrderId,
        wcOrderNumber: order.wcOrderNumber,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        shippingCep: order.shippingCep,
        shippingAddress: order.shippingAddress,
        totalAmount: order.totalAmount,
        wcDateCreated: order.wcDateCreated,
        items: order.items,
      },
      storeCode: store.code,
      storeName: store.name,
      strategy: 'manual-test',
    });

    return {
      ok: true,
      pickOrderId: pickOrder.id,
      store: { id: store.id, code: store.code, name: store.name },
      order: { id: order.id, wcOrderNumber: order.wcOrderNumber },
    };
  }

  /**
   * Transiciona o status. Valida que user é dono da loja.
   * Quando vai pra 'shipped', exige trackingCode + carrier.
   */
  async updateStatus(
    id: string,
    storeId: string,
    userId: string,
    input: { status: PickStatus; trackingCode?: string; carrier?: string },
  ) {
    if (!VALID_STATUSES.includes(input.status)) {
      throw new BadRequestException(`Status inválido: ${input.status}`);
    }

    const current = await this.prisma.pickOrder.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Pick-order não encontrado');
    if (current.storeId !== storeId) {
      throw new ForbiddenException('Pick-order não pertence à sua loja');
    }

    const currentStatus = current.status as PickStatus;

    // ════════════════════════════════════════════════════════════════════════
    //  GUARD CRÍTICO — BLOQUEAR RE-ENVIO DE PEDIDO JÁ ENVIADO
    //
    //  Caso real (06/06 → 10/06): mesma cliente recebeu 2 pacotes do mesmo
    //  pedido. Loja "enviou" o mesmo pedido em datas diferentes porque o
    //  check de transição abaixo permitia shipped → shipped (a condição
    //  `input.status !== currentStatus` vira false quando ambos são shipped).
    //
    //  Esse guard bloqueia explicitamente. Mostra rastreio + data do envio
    //  anterior pra operadora entender. Se precisar reenviar de verdade
    //  (cliente alega extravio etc.), tem que pedir admin pra resetar o
    //  status — não pode disparar nova etiqueta + baixa Giga + nota WC
    //  clicando "Enviar" duas vezes.
    // ════════════════════════════════════════════════════════════════════════
    if (currentStatus === 'shipped' && input.status === 'shipped') {
      const dataEnvio = current.updatedAt
        ? new Date(current.updatedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        : 'data desconhecida';
      const rastreio = current.trackingCode
        ? `${current.carrier ?? ''} ${current.trackingCode}`.trim()
        : 'sem rastreio';
      throw new BadRequestException(
        `🚫 ENVIO DUPLICADO BLOQUEADO. Este pedido JÁ FOI ENVIADO em ${dataEnvio} ` +
          `(rastreio: ${rastreio}). Se a cliente alega que não recebeu, abra um ` +
          `chamado com a transportadora — NÃO envie outro pacote sem confirmar ` +
          `com a matriz.`,
      );
    }

    const allowed = NEXT_ALLOWED[currentStatus] ?? [];
    if (!allowed.includes(input.status) && input.status !== currentStatus) {
      throw new BadRequestException(
        `Transição ${currentStatus} → ${input.status} não permitida`,
      );
    }

    if (input.status === 'shipped') {
      /**
       * ARRUMA O CÓDIGO NA ENTRADA (22/08) — a loja digita na mão e um em
       * cada dez sai com espaço ou minúscula ("AD 717 071 708 BR",
       * "ad718148023br"). Assim ele não passa no `ehCodigoValido`, o objeto
       * nunca é consultado e o pedido fica preso em "Em trânsito" até
       * envelhecer. Medido: 914 pedidos nesse estado. Mexer aqui é o que
       * impede o problema de voltar; o que já está gravado é varrido pelo
       * `normalizarCodigosTortos` do RastreioSyncCron.
       *
       * Só reescreve o que VIRA etiqueta válida — "MOTOBOY" e "retirada em
       * loja" seguem intactos e caem no `semRastreio` logo abaixo.
       */
      input.trackingCode = TrackingService.normalizarCodigo(input.trackingCode) as any;
      const code = (input.trackingCode ?? '').trim();
      const carrier = (input.carrier ?? '').trim();
      if (!carrier) throw new BadRequestException('Transportadora é obrigatória');
      /**
       * MOTOBOY E RETIRADA NÃO TÊM RASTREIO — e nem por isso deixam de ser
       * entrega concluída (17/08). Até aqui o shipped exigia código sempre,
       * então a loja que entregou de moto ou entregou na mão da cliente
       * ficava com o card preso em "PRONTO P/ POSTAR" pra sempre — ou
       * inventava um código ("MOTOBOY", "AAAAA") pra fechar, e a cliente
       * recebia e-mail com rastreio falso. Caso real: ON-000003.
       */
      const semRastreio = /^(motoboy|retirada)$/i.test(carrier);
      if (!code && !semRastreio) throw new BadRequestException('Código de rastreio é obrigatório');
    }

    const updated = await this.prisma.pickOrder.update({
      where: { id },
      data: {
        status: input.status,
        ...(input.status === 'shipped'
          ? { trackingCode: input.trackingCode?.trim(), carrier: input.carrier?.trim() }
          : {}),
      },
      include: {
        order: { select: { wcOrderNumber: true, wcOrderId: true, customerName: true, source: true, liveCartId: true } },
        store: { select: { code: true, name: true } },
      },
    });

    // Histórico no pedido
    await this.prisma.orderHistory.create({
      data: {
        orderId: current.orderId,
        userId,
        fromStatus: currentStatus,
        toStatus: input.status,
        note:
          input.status === 'shipped'
            ? `Enviado pela loja. Rastreio: ${input.trackingCode} (${input.carrier})`
            : `Mudança de status: ${currentStatus} → ${input.status}`,
      },
    });

    // Se todos os pick-orders do pedido foram shipped, marca order.status=shipped
    let allSiblings: Array<{ status: string; trackingCode: string | null; carrier: string | null; storeId: string }> = [];
    let allShipped = false;
    if (input.status === 'shipped') {
      allSiblings = await this.prisma.pickOrder.findMany({
        where: { orderId: current.orderId },
        select: { status: true, trackingCode: true, carrier: true, storeId: true },
      });
      allShipped = allSiblings.every((p) => p.status === 'shipped');
      if (allShipped) {
        await this.prisma.order.update({
          where: { id: current.orderId },
          data: { status: 'shipped', trackingCode: input.trackingCode, carrier: input.carrier },
        });
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  SYNC COM WOOCOMMERCE
    //  Faz o site refletir o que a loja mudou:
    //    separating/ready → WC status 'separacao' (Em Separação)
    //    shipped          → push rastreio no meta_data; se TODOS siblings enviados
    //                       → WC status 'enviado' (fallback 'completed' se inexistente)
    //
    //  Falha aqui NÃO derruba a ação da loja — só loga e anexa warning na resposta.
    // ════════════════════════════════════════════════════════════════════════
    /**
     * ⚠️ 06/08 — passou a cobrir o SITE NOVO também.
     *
     * A variável se chamava `isLiveOrder` e testava só `source === 'live'`.
     * Ela guarda a sincronia de status com o WooCommerce, e a razão de existir
     * é o `wcOrderId` SINTÉTICO: pedido da live (900M) não existe lá.
     *
     * O pedido do site novo (950M) tem exatamente o mesmo problema. Sem esta
     * correção, toda mudança de status de pedido do site tentaria escrever num
     * pedido inexistente no WooCommerce e voltaria 404 — não derruba a ação da
     * loja (o bloco tem catch e vira warning), mas encheria a resposta de aviso
     * falso em TODO pedido do site. Aviso que aparece sempre é aviso que
     * ninguém lê — e é assim que o dia em que ele for verdadeiro passa batido.
     */
    const origem = (updated.order as any)?.source;
    const naoExisteNoWc = origem === 'live' || origem === 'ecommerce';
    // Separado de propósito: o espelho abaixo é MESMO da live (depende do
    // carrinho), enquanto a trava do WooCommerce vale pras duas origens.
    // Manter um `isLiveOrder` valendo pelas duas era o que escondia o furo.
    const ehDaLive = origem === 'live';
    // Pedido da LIVE: espelha o status de volta no carrinho da live (console
    // da operadora/dashboards) — e NUNCA sincroniza com o WooCommerce (o
    // wcOrderId é sintético; não existe no site).
    if (ehDaLive && (updated.order as any)?.liveCartId) {
      const liveCartId = (updated.order as any).liveCartId as string;
      if (input.status === 'shipped' && allShipped) {
        await (this.prisma as any).livePdvCart
          .update({ where: { id: liveCartId }, data: { status: 'shipped' } })
          .catch(() => {});
      }
    }

    // ═══ EFEITOS DO ENVIO (best-effort — falha NUNCA desfaz o shipped) ═══
    //  1. Acerto intercompany ÷2,5: quem cedeu a peça recebe da "dona" da venda
    //     (LIVE → loja da live; SITE → REDE, decisão do dono 12/07). REDE→REDE
    //     não gera (mesmo dono).
    //  2. Cliente da LIVE recebe WhatsApp com o rastreio (o site já avisa via
    //     hook completed do WooCommerce).
    if (input.status === 'shipped') {
      this.afterShippedSideEffects(id, input).catch((e) =>
        this.logger.warn(`[shipped-effects] pick ${id}: ${e?.message || e}`),
      );
      // Primeira leitura do rastreio JÁ, sem esperar o ciclo do cron (até 30
      // min): o card da loja que vendeu mostra "Objeto postado" na hora em vez
      // de "ainda sem movimento" logo depois de ela postar. Best-effort.
      if (input.trackingCode) {
        this.tracking
          .fetchTracking(input.trackingCode, input.carrier)
          .catch((e) => this.logger.warn(`[rastreio] 1ª leitura de ${input.trackingCode}: ${e?.message || e}`));
      }
    }

    const wcOrderId =
      !naoExisteNoWc && updated.order?.wcOrderId ? Number(updated.order.wcOrderId) : null;
    const storeLabel = updated.store
      ? `${updated.store.name} (${updated.store.code})`
      : 'Loja';
    let wcSyncWarning: string | null = null;
    let wcSyncApplied: string | null = null;

    if (wcOrderId) {
      try {
        if (input.status === 'separating' || input.status === 'ready') {
          // Não sobrescreve se já tá em separação ou adiante — evita voltar de 'enviado' pra 'separacao'
          // se admin tiver adiantado manualmente. updateOrder é idempotente (WC aceita mesmo status).
          await this.wc.updateOrder(wcOrderId, { status: WC_STATUS_SEPARATING });
          await this.wc.addOrderNote(
            wcOrderId,
            `${storeLabel} iniciou a separação do pedido (FlowOps).`,
            false, // nota interna, não notifica cliente
          );
          wcSyncApplied = `site marcado como "Em Separação"`;
        } else if (input.status === 'shipped') {
          const trackCode = (input.trackingCode ?? '').trim();
          const trackCarrier = (input.carrier ?? '').trim();

          // Pega todos os rastreios (multi-loja pode ter vários)
          const allTracks = allSiblings
            .filter((p) => p.trackingCode)
            .map((p) => ({ code: p.trackingCode!, carrier: p.carrier || 'Correios' }));

          const primaryTrack = allTracks[0] ?? { code: trackCode, carrier: trackCarrier };

          // Monta payload pro WC
          const wcPayload: Parameters<typeof this.wc.updateOrder>[1] = {
            trackingNumber: primaryTrack.code,
            trackingCarrier: primaryTrack.carrier,
          };
          if (allShipped) {
            wcPayload.status = WC_STATUS_SHIPPED; // todos os siblings enviados → finaliza
          }
          await this.wc.updateOrder(wcOrderId, wcPayload);

          // Nota interna no pedido com detalhes do envio
          if (allTracks.length > 1) {
            const listing = allTracks
              .map((t) => `  • ${t.carrier}: ${t.code}`)
              .join('\n');
            await this.wc.addOrderNote(
              wcOrderId,
              `${storeLabel} enviou o pedido (FlowOps).\n` +
                `Pedido multi-loja — ${allTracks.length} envios:\n${listing}\n` +
                (allShipped
                  ? 'Todos os envios concluídos — pedido marcado como Enviado.'
                  : 'Aguardando envio das outras lojas pra finalizar.'),
              false,
            );
          } else {
            await this.wc.addOrderNote(
              wcOrderId,
              `${storeLabel} enviou o pedido (FlowOps). Rastreio: ${trackCode} (${trackCarrier}).`,
              false,
            );
          }
          wcSyncApplied = allShipped
            ? `site marcado como "Enviado" + rastreio`
            : `rastreio salvo no site (aguardando outras lojas)`;
        }
      } catch (e: any) {
        this.logger.warn(
          `Falha ao sincronizar pick-order ${id} com WC order ${wcOrderId}: ${e.message}`,
        );
        wcSyncWarning = `Não conseguiu atualizar o site: ${e.message}`;
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  AUTO-BAIXA NO ERP GIGASISTEMAS (gatilho = shipped + rastreio)
    //
    //  Assim que a filial confirma o envio com rastreio, disparamos a baixa
    //  real no `estoque` do Gigasistemas — sem esperar a matriz aprovar
    //  manualmente em /baixa-estoque. Matriz só atua como fallback quando
    //  algo falhou (cai em /retaguarda/baixas-log e pode reabrir pra re-tentar).
    //
    //  Qualquer falha aqui NÃO derruba o envio: rastreio já foi salvo, pedido
    //  já subiu pro WC, cliente já foi notificado. O erro vira log pra você
    //  tratar depois.
    // ════════════════════════════════════════════════════════════════════════
    let autoDebit: {
      attempted: boolean;
      applied: boolean;
      skipped: boolean;
      shadow: boolean;
      reason: string | null;
    } = { attempted: false, applied: false, skipped: false, shadow: false, reason: null };

    if (input.status === 'shipped') {
      autoDebit = await this.autoDebitOnShipped(id, userId);
    }

    // Emite via socket pra loja (eco) e pro admin (dashboard)
    this.gateway.emitPickOrderStatus(storeId, {
      id: updated.id,
      status: updated.status,
      trackingCode: updated.trackingCode,
      carrier: updated.carrier,
      storeId,
      orderId: current.orderId,
      order: updated.order,
    });

    return {
      id: updated.id,
      status: updated.status,
      trackingCode: updated.trackingCode,
      carrier: updated.carrier,
      updatedAt: updated.updatedAt,
      wcSyncApplied,
      wcSyncWarning,
      autoDebit,
    };
  }

  /**
   * EFEITOS DO ENVIO (best-effort, roda depois do shipped ser gravado):
   *
   * 1. ACERTO INTERCOMPANY ÷2,5 (decisão do dono 12/07 — "o site entra sim,
   *    entra como REDE"): quando a loja que despachou NÃO é a dona da venda,
   *    registra TransferOrder + InterStoreObligation por item, valor = preço
   *    CHEIO ÷ 2,5 (OrderItem.baseUnitPrice — a live grava o preço cheio;
   *    site usa o unitPrice, que já é o cheio).
   *      - dona da venda: LIVE → loja anfitriã da live · SITE → REDE (pseudo
   *        destino "SITE") · pickup-transfer → loja de retirada.
   *      - mesmo dono (REDE→REDE) ou a própria loja da live despachando =
   *        NÃO gera nada (regra do markShipped legado da live).
   * 2. WHATSAPP DE RASTREIO pra cliente da LIVE via ManyChat (o site avisa
   *    pelo hook completed do WooCommerce; a live não tem WC). Gated por
   *    MANYCHAT_RASTREIO_FLOW_NS + MANYCHAT_API_TOKEN — sem envs, pula.
   */
  private async afterShippedSideEffects(
    pickOrderId: string,
    input: { trackingCode?: string; carrier?: string },
  ) {
    const po: any = await (this.prisma as any).pickOrder.findUnique({
      where: { id: pickOrderId },
      include: {
        store: true,
        order: {
          include: {
            items: true,
            // Cards IRMÃOS deste pedido — precisa deles pra saber o que chegou
            // aqui por transferência (bloco da PERNA 2, logo abaixo).
            pickOrders: {
              select: { storeId: true, isTransfer: true, transferToStoreCode: true },
            },
          },
        },
      },
    });
    if (!po?.order) return;
    const order: any = po.order;
    const fromStore: any = po.store;

    /**
     * ACERTO EM DUAS PERNAS (17/08) — quem ENTREGA cobra o pedido TODO.
     *
     * O filtro era só `assignedStoreId === po.storeId`: cada card acertava
     * apenas os SEUS itens. Numa retirada com transferência isso deixava a
     * loja que entrega no PREJUÍZO:
     *
     *   Sorocaba manda 5 peças pra São José (cliente retira em SJC)
     *     perna 1 → SJC "paga" Sorocaba pelas 5          ✅ já funcionava
     *     perna 2 → 13 paga SJC... só pelas peças DELA   ❌ faltavam as 5
     *
     * SJC pagava a fornecedora e não recebia por aquelas peças. Quanto mais
     * ela ajudava a fechar o pedido, mais ela perdia — e o custo de ajudar
     * recaía justamente em quem fez o pedido acontecer.
     *
     * Quem entrega pra cliente entregou o pedido inteiro, então cobra da loja
     * vendedora o inteiro: itens próprios + os que chegaram por transferência
     * PRA ELA. Peça que outra loja mandou DIRETO pra cliente fica de fora — o
     * acerto daquela é da própria loja com a vendedora, e somar aqui pagaria
     * duas vezes pela mesma peça.
     *
     * A régua REDE×FRANQUIA não muda: `geraCobranca` abaixo segue exigindo
     * naturezas diferentes. Franquia→franquia e rede→rede continuam SÓ
     * REGISTRO, sem financeiro (decisão do dono, 17/08).
     */
    const meusItens: any[] = (order.items || []).filter(
      (i: any) => i.assignedStoreId === po.storeId,
    );

    // `isTransfer` = este card MANDA pra outra loja. Quem entrega é o outro.
    const idsQueMeMandaram: string[] = !po.isTransfer
      ? (order.pickOrders || [])
          .filter(
            (irmao: any) =>
              irmao.isTransfer &&
              irmao.transferToStoreCode &&
              String(irmao.transferToStoreCode) === String(fromStore?.code) &&
              irmao.storeId !== po.storeId,
          )
          .map((irmao: any) => irmao.storeId)
      : [];

    const porTransferencia: any[] = idsQueMeMandaram.length
      ? (order.items || []).filter((i: any) => idsQueMeMandaram.includes(i.assignedStoreId))
      : [];

    const itens: any[] = [...meusItens, ...porTransferencia];
    if (!itens.length) return;

    if (porTransferencia.length > 0) {
      this.logger.log(
        `[acerto-perna-2] ${order.wcOrderNumber}: ${fromStore?.code} entregou o pedido — ` +
          `cobra ${meusItens.length} peça(s) própria(s) + ` +
          `${porTransferencia.length} recebida(s) por transferência`,
      );
    }

    // ── resolve a "dona" da venda (destino do acerto) ──
    let destino: { code: string; name: string; tipo: string } | null = null;
    let liveCart: any = null;
    if (po.isTransfer && po.transferToStoreCode) {
      const st = await (this.prisma as any).store
        .findUnique({ where: { code: po.transferToStoreCode } })
        .catch(() => null);
      if (st) destino = { code: st.code, name: st.name, tipo: st.tipo === 'FILIAL' ? 'FILIAL' : 'REDE' };
    } else if (order.source === 'pdv_online' && order.sellerStoreCode) {
      // PEDIDO ONLINE (14/08): a dona da venda é a LOJA VENDEDORA do PDV
      // (Order.sellerStoreCode — Karine = loja site), não a loja-canal 13.
      // Fornecedora → vendedora entra no MESMO acerto REDE × FRANQUIA; se a
      // vendedora atendeu o próprio pedido, `mesmaLoja` abaixo anula tudo.
      const st = await (this.prisma as any).store
        .findFirst({ where: { code: order.sellerStoreCode } })
        .catch(() => null);
      if (st) {
        destino = { code: st.code, name: st.name, tipo: st.tipo === 'FILIAL' ? 'FILIAL' : 'REDE' };
      } else {
        this.logger.warn(
          `[acerto-÷2,5] pedido ${order.wcOrderNumber}: sellerStoreCode=${order.sellerStoreCode} não achado em Store — caindo no canal 13`,
        );
      }
    }
    if (!destino && !(po.isTransfer && po.transferToStoreCode)) {
      // VENDA DE CANAL (site OU live) — dono 30/07: o destino é SEMPRE a
      // loja-canal 13 (SITE). Antes a live acertava com a loja que fez a live
      // (session.liveStoreCode) e o site usava um código fantasma 'SITE' que
      // nem existe na tabela Store. Agora as duas convergem pra 13, que é a
      // loja-canal de verdade — é o acerto normal REDE × franquia.
      if (order.source === 'live' && order.liveCartId) {
        liveCart = await (this.prisma as any).livePdvCart
          .findUnique({ where: { id: order.liveCartId }, include: { session: true } })
          .catch(() => null);
      }
      const canal = await (this.prisma as any).store
        .findUnique({ where: { code: PickOrdersService.CANAL_STORE_CODE } })
        .catch(() => null);
      destino = canal
        ? { code: canal.code, name: canal.name, tipo: canal.tipo === 'FILIAL' ? 'FILIAL' : 'REDE' }
        : { code: PickOrdersService.CANAL_STORE_CODE, name: 'SITE', tipo: 'REDE' };
    }

    // ── 1) obrigação intercompany ÷2,5 ──
    try {
      const fromTipo = fromStore?.tipo === 'FILIAL' ? 'FILIAL' : 'REDE';
      const mesmaLoja = destino && fromStore?.code === destino.code;
      // Dono 30/07: a TRANSFERÊNCIA é registrada por TODA loja que atende
      // pedido de canal (é o rastro da peça saindo do estoque). Só a COBRANÇA
      // (÷2,5) é que segue a regra antiga REDE × franquia — loja própria
      // mandando pro canal não gera obrigação, mas agora deixa registro.
      // Antes as duas coisas estavam presas na mesma condição e a saída de
      // loja própria não aparecia em lugar nenhum.
      const geraCobranca = !!destino && fromTipo !== destino.tipo;
      if (destino && !mesmaLoja) {
        const mesReferencia = new Date().toISOString().slice(0, 7);
        for (const it of itens) {
          const transfer = await (this.prisma as any).transferOrder.create({
            data: {
              tipo: order.source === 'live' ? 'LIVE' : order.source === 'pdv_online' ? 'ONLINE' : 'SITE',
              refCode: String(it.sku || ''),
              codigoBipado: String(it.sku || ''),
              descricao: it.productName || null,
              qtyOrigem: Number(it.quantity || 1),
              lojaOrigemCode: fromStore?.code,
              lojaOrigemName: fromStore?.name,
              lojaDestinoCode: destino.code,
              lojaDestinoName: destino.name,
              solicitanteNome:
                order.source === 'live' ? 'LIVE COMMERCE' : order.source === 'pdv_online' ? 'VENDA ONLINE' : 'VENDA SITE',
              mensagem: `Pedido ${order.wcOrderNumber} expedido${input.trackingCode ? ` (rastreio ${input.trackingCode})` : ''}`,
            },
          });
          const baseUnit = Number(it.baseUnitPrice ?? it.unitPrice ?? 0);
          const precoTotal = baseUnit * Number(it.quantity || 1);
          // Sem cobrança (REDE → REDE): a transferência acima já registrou a
          // saída da peça; obrigação financeira seria dinheiro trocando de
          // bolso dentro da mesma empresa.
          if (!geraCobranca) continue;
          await (this.prisma as any).interStoreObligation.create({
            data: {
              transferOrderId: transfer.id,
              fromStoreCode: fromStore?.code,
              fromStoreName: fromStore?.name,
              fromStoreTipo: fromTipo,
              toStoreCode: destino.code,
              toStoreName: destino.name,
              toStoreTipo: destino.tipo,
              refCode: String(it.sku || ''),
              sku: String(it.sku || ''),
              descricao: it.productName || null,
              qty: Number(it.quantity || 1),
              precoUnitario: baseUnit,
              precoTotal,
              divisor: PickOrdersService.DIVISOR_CUSTO,
              valorObrigacao: precoTotal / PickOrdersService.DIVISOR_CUSTO,
              mesReferencia,
              status: 'pending',
            },
          });
        }
        this.logger.log(
          `[acerto-÷2,5] pedido ${order.wcOrderNumber}: ${itens.length} item(ns) ` +
            `${fromStore?.code}(${fromTipo}) → ${destino.code}(${destino.tipo}) · ` +
            `${geraCobranca ? 'COM cobrança ÷2,5' : 'só registro (mesma natureza, sem cobrança)'}`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`[acerto-÷2,5] pedido ${order.wcOrderNumber}: ${e?.message || e}`);
    }

    // ── 2b) Rastreio pra cliente do SITE NOVO (e-mail + evento n8n) ──
    // O e-mail de "Pagamento confirmado" promete o código de rastreio, e até
    // 14/08 ninguém cumpria: o ManyChat abaixo é só da LIVE e o site novo não
    // passa pelo WooCommerce que avisava o site velho. Guard atômico no
    // pedido: dividido despacha um pacote por loja, e só o PRIMEIRO com
    // rastreio avisa (updateMany com null → 1 linha = este pacote venceu).
    // 'pdv_online' entra aqui junto (14/08): a venda online do PDV nasceu muda
    // — a cliente é atendida no WhatsApp da vendedora, mas o código de
    // rastreio ninguém mandava. Mesmo trilho, mesma trava.
    // Sem código (motoboy/retirada) não há rastreio pra avisar — o aviso de
    // "saiu pra entrega" fica com a vendedora, que já fala com a cliente.
    if ((order.source === 'ecommerce' || order.source === 'pdv_online') && input.trackingCode?.trim()) {
      try {
        const venceu = await (this.prisma as any).order.updateMany({
          where: { id: order.id, rastreioAvisadoEm: null },
          data: { rastreioAvisadoEm: new Date() },
        });
        if (venceu.count === 1) {
          void this.pedidoEmail.aoEnviarPedido({
            ...order,
            trackingCode: input.trackingCode,
            carrier: input.carrier ?? order.carrier ?? 'Correios',
          });
        }
      } catch (e: any) {
        this.logger.warn(`[rastreio-site] pedido ${order.wcOrderNumber}: ${e?.message || e}`);
      }
    }

    // ── 2) WhatsApp de rastreio pra cliente da LIVE ──
    if (order.source === 'live') {
      try {
        const flowNs = (process.env.MANYCHAT_RASTREIO_FLOW_NS || '').trim();
        if (!flowNs || !this.manychat.enabled) return;
        const digits = String(order.customerPhone || '').replace(/\D/g, '');
        const phone =
          digits.length === 10 || digits.length === 11
            ? '55' + digits
            : digits.startsWith('55') && (digits.length === 12 || digits.length === 13)
              ? digits
              : null;
        if (!phone) return;
        // TRAVA DE DUPLICIDADE (14/08): a live não tinha nenhuma, enquanto o
        // ramo do site ao lado tinha. Carrinho separado por 2 lojas chamava
        // este bloco 2× e a cliente recebia 2 WhatsApps do mesmo pedido.
        // Reclamado só como "chegou repetido" — nunca como bug.
        // Reivindicação atômica ANTES do envio, depois dos guards baratos
        // (sem flow/telefone não queima o carimbo).
        const venceuWhats = await (this.prisma as any).order.updateMany({
          where: { id: order.id, rastreioAvisadoEm: null },
          data: { rastreioAvisadoEm: new Date() },
        });
        if (venceuWhats.count !== 1) {
          this.logger.log(`[rastreio-whats] pedido ${order.wcOrderNumber}: já avisado — 2º pacote não repete`);
          return;
        }
        let subId = await this.manychat.findWhatsAppSubscriber(phone);
        if (!subId) {
          const created = await this.manychat.createWhatsAppSubscriber(phone, order.customerName);
          subId = created.id;
        }
        if (!subId) return;
        const primeiroNome = String(order.customerName || '').trim().split(/\s+/)[0] || 'cliente';
        await this.manychat.setCustomFieldByName(subId, 'rastreio_nome', primeiroNome);
        await this.manychat.setCustomFieldByName(subId, 'rastreio_codigo', String(input.trackingCode || ''));
        await this.manychat.setCustomFieldByName(subId, 'rastreio_transportadora', String(input.carrier || 'Correios'));
        await this.manychat.setCustomFieldByName(subId, 'rastreio_pedido', String(order.wcOrderNumber || ''));
        const r = await this.manychat.sendFlow(subId, flowNs);
        this.logger.log(
          `[rastreio-whats] pedido ${order.wcOrderNumber}: ${r.ok ? 'enviado' : `falhou (${r.error})`}`,
        );
      } catch (e: any) {
        this.logger.warn(`[rastreio-whats] pedido ${order.wcOrderNumber}: ${e?.message || e}`);
      }
    }
  }

  /**
   * AUTO-BAIXA disparada pelo `shipped`.
   *
   * Diferente de approveDebit (que é a rota manual da matriz), esse método:
   *  - NUNCA lança exception — envio da filial não pode ser bloqueado por
   *    problema de ERP. Em falha, só loga e devolve `{ reason }` pra auditoria.
   *  - Verifica dupla-baixa por 2 caminhos: debitApprovedAt já marcado OU
   *    log `debit.real.applied` já existente pro mesmo pickOrderId.
   *  - Respeita `ERP_WRITE_ENABLED` — se SHADOW, grava log de intenção e
   *    devolve `shadow:true` sem marcar o flag de aprovação (operadora ainda
   *    tem que passar no PDV manualmente nesse modo).
   */
  private async autoDebitOnShipped(
    pickOrderId: string,
    operatorUserId: string,
  ): Promise<{
    attempted: boolean;
    applied: boolean;
    skipped: boolean;
    shadow: boolean;
    reason: string | null;
  }> {
    try {
      const po = await this.prisma.pickOrder.findUnique({
        where: { id: pickOrderId },
        select: {
          id: true,
          storeId: true,
          orderId: true,
          debitApprovedAt: true,
          store: { select: { code: true } },
        } as any,
      });
      if (!po) {
        return { attempted: false, applied: false, skipped: true, shadow: false, reason: 'pick-order não encontrado após update' };
      }

      // GUARD 1: flag local já marcado
      if ((po as any).debitApprovedAt) {
        this.logger.log(`autoDebit(${pickOrderId}): já aprovado anteriormente — skip`);
        return { attempted: false, applied: false, skipped: true, shadow: false, reason: 'baixa já aprovada' };
      }

      // GUARD 2: procura log histórico (cobre caso de flag ter sido limpo via reopen)
      const prior = await this.prisma.integrationLog.findFirst({
        where: {
          source: 'erp',
          event: 'debit.real.applied',
          payload: { contains: `"pickOrderId":"${pickOrderId}"` },
        },
        select: { id: true },
      });
      if (prior) {
        this.logger.log(`autoDebit(${pickOrderId}): já tem log debit.real.applied — skip anti-dupla`);
        return { attempted: false, applied: false, skipped: true, shadow: false, reason: 'baixa já aplicada em log anterior' };
      }

      const storeCode = String(((po as any).store?.code) ?? '').trim();
      const items = await this.prisma.orderItem.findMany({
        where: { orderId: po.orderId, assignedStoreId: po.storeId },
        select: { sku: true, quantity: true, productName: true },
      });

      if (!items.length) {
        this.logger.warn(`autoDebit(${pickOrderId}): nenhum item atribuído — skip`);
        return { attempted: false, applied: false, skipped: true, shadow: false, reason: 'sem items atribuídos' };
      }

      const writeEnabled = this.erp.isWriteEnabled;

      // SHADOW — só grava intenção
      if (!writeEnabled) {
        await this.prisma.integrationLog.create({
          data: {
            source: 'pick-order',
            direction: 'internal',
            event: 'debit.auto.shadow',
            payload: JSON.stringify({
              pickOrderId,
              trigger: 'shipped',
              approvedBy: operatorUserId,
              storeId: po.storeId,
              storeCode,
              items: items.map((i) => ({ sku: i.sku, qty: i.quantity, name: i.productName })),
              note: 'SHADOW — envio confirmado mas ERP_WRITE_ENABLED=false. Baixa manual ainda é necessária.',
            }),
            status: 200,
          },
        });
        return { attempted: true, applied: false, skipped: false, shadow: true, reason: 'shadow mode' };
      }

      // LIVE — precisa de storeCode válido pra bater no Giga
      if (!storeCode) {
        await this.prisma.integrationLog.create({
          data: {
            source: 'erp',
            direction: 'out',
            event: 'debit.real.failed',
            payload: JSON.stringify({
              pickOrderId,
              trigger: 'shipped',
              approvedBy: operatorUserId,
              error: 'store.code vazio',
            }),
            status: 500,
            error: 'store.code vazio',
          },
        });
        return { attempted: true, applied: false, skipped: false, shadow: false, reason: 'loja sem código configurado' };
      }

      // SÓ O QUE FALTA — o que já saiu no bipe não desce de novo no envio.
      const pendentes = await this.scans.pendingDebitItems(
        pickOrderId,
        (po as any).orderId,
        (po as any).storeId,
        storeCode,
      );

      const result: { success: boolean; applied: any[]; error?: string } = pendentes.length
        ? await this.erp.decreaseStockAsync(pendentes)
        : { success: true, applied: [] };

      if (!result.success) {
        await this.prisma.integrationLog.create({
          data: {
            source: 'erp',
            direction: 'out',
            event: 'debit.real.failed',
            payload: JSON.stringify({
              pickOrderId,
              trigger: 'shipped',
              approvedBy: operatorUserId,
              storeCode,
              items: items.map((i) => ({ sku: i.sku, qty: i.quantity, name: i.productName })),
              pendentes,
              error: result.error,
            }),
            status: 500,
            error: result.error?.slice(0, 500),
          },
        });
        this.logger.error(`autoDebit(${pickOrderId}) FALHOU: ${result.error}`);
        return { attempted: true, applied: false, skipped: false, shadow: false, reason: result.error ?? 'erro desconhecido no ERP' };
      }

      // SUCESSO — grava log + marca flag
      await this.prisma.integrationLog.create({
        data: {
          source: 'erp',
          direction: 'out',
          event: 'debit.real.applied',
          payload: JSON.stringify({
            pickOrderId,
            trigger: 'shipped',
            approvedBy: operatorUserId,
            storeCode,
            applied: result.applied,
            ...(pendentes.length ? {} : { note: 'nada a baixar — estoque já saiu peça a peça no bipe' }),
          }),
          status: 200,
        },
      });

      await this.prisma.pickOrder.update({
        where: { id: pickOrderId },
        data: {
          debitApprovedAt: new Date(),
          debitApprovedBy: operatorUserId,
        } as any,
      });

      this.logger.log(`autoDebit(${pickOrderId}) OK — ${result.applied.length} item(ns) baixado(s) no Giga`);
      return { attempted: true, applied: true, skipped: false, shadow: false, reason: null };
    } catch (e: any) {
      const msg = String(e?.message || e);
      this.logger.error(`autoDebit(${pickOrderId}) exception: ${msg}`);
      // Melhor esforço pra logar (sem jogar exception pra cima)
      try {
        await this.prisma.integrationLog.create({
          data: {
            source: 'erp',
            direction: 'out',
            event: 'debit.real.failed',
            payload: JSON.stringify({ pickOrderId, trigger: 'shipped', approvedBy: operatorUserId, error: msg }),
            status: 500,
            error: msg.slice(0, 500),
          },
        });
      } catch { /* ignore */ }
      return { attempted: true, applied: false, skipped: false, shadow: false, reason: msg };
    }
  }

  /**
   * Loja sinaliza PROBLEMA no pick-order (sem estoque físico, defeito, divergência).
   *
   *  - Só aceita em status ATIVOS (new, separating). Se já bipou/separou/postou,
   *    não faz sentido "reportar problema" — manda nota interna em vez disso.
   *  - Seta issueReason + issueNote + reportedAt/By. NÃO deleta o pick-order.
   *  - Card some da fila da loja (listMine filtra issueReason != null).
   *  - Matriz vê badge vermelho em /pedidos e /separacao com motivo.
   *  - Matriz clica "Recalcular" → recalculateForWc auto-exclui a loja que reportou.
   */
  async reportIssue(
    pickOrderId: string,
    storeId: string,
    userId: string,
    input: { reason: string; note?: string },
  ) {
    const validReasons = ['out_of_stock', 'defective', 'divergence', 'other'];
    const reason = String(input.reason ?? '').trim();
    if (!validReasons.includes(reason)) {
      throw new BadRequestException(
        `reason inválido. Use: ${validReasons.join(' | ')}`,
      );
    }

    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      include: {
        store: { select: { code: true, name: true } },
        order: { select: { id: true, wcOrderId: true, wcOrderNumber: true } },
      },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pick-order não é da sua loja');

    const activeStatuses: PickStatus[] = ['new', 'separating'];
    if (!activeStatuses.includes(po.status as PickStatus)) {
      throw new BadRequestException(
        `Status atual é "${po.status}" — só dá pra reportar problema em "new" ou "separating". ` +
          `Se já separou/postou, fale com a matriz direto.`,
      );
    }

    if ((po as any).issueReason) {
      throw new BadRequestException('Problema já reportado anteriormente');
    }

    const note = (input.note ?? '').toString().trim().slice(0, 500) || null;
    const now = new Date();

    // O card sai da fila da loja e a matriz vai mandar o pedido pra OUTRA loja.
    // As peças que já tinham sido bipadas voltam pro estoque daqui — senão
    // somem do sistema exatamente na hora em que a loja precisa vendê-las de
    // volta no balcão.
    const estorno = await this.scans.revertPickOrderStock(pickOrderId, {
      reason: 'issue',
      userId,
    });

    const updated = await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: {
        issueReason: reason,
        issueNote: note,
        issueReportedAt: now,
        issueReportedBy: userId,
      } as any,
    });

    await this.prisma.orderHistory.create({
      data: {
        orderId: po.orderId,
        userId,
        fromStatus: po.status,
        toStatus: po.status,
        note:
          `Loja ${po.store?.code ?? ''} reportou problema: ${reason}${note ? ' — ' + note : ''}` +
          (estorno.pecas ? ` · ${estorno.pecas} peça(s) bipada(s) devolvida(s) ao estoque da loja.` : ''),
      },
    });

    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'issue.reported',
        payload: JSON.stringify({
          pickOrderId,
          reportedBy: userId,
          storeId,
          storeCode: po.store?.code,
          reason,
          note,
          pecasEstornadas: estorno.pecas,
        }),
        status: 200,
      },
    });

    const reasonLabels: Record<string, string> = {
      out_of_stock: 'Sem estoque físico',
      defective: 'Peça com defeito',
      divergence: 'Divergência (cor/tamanho)',
      other: 'Outro',
    };

    this.gateway.emitPickOrderIssue(storeId, {
      pickOrderId,
      orderId: po.orderId,
      wcOrderId: po.order?.wcOrderId ?? null,
      storeId,
      storeCode: po.store?.code ?? null,
      storeName: po.store?.name ?? null,
      reason,
      reasonLabel: reasonLabels[reason],
      note,
      reportedAt: now.toISOString(),
    });

    // Dispara também :removed pra loja limpar o card na hora (sem refetch)
    this.gateway.emitPickOrderRemoved(storeId, {
      orderId: po.orderId,
      pickOrderId,
    });

    return {
      id: updated.id,
      issueReason: (updated as any).issueReason,
      issueNote: (updated as any).issueNote,
      reasonLabel: reasonLabels[reason],
      reportedAt: now.toISOString(),
      pecasEstornadas: estorno.pecas,
    };
  }

  /** `0` desliga a baixa da quantidade fantasma no reporte por item. */
  private get itemReportDebitEnabled(): boolean {
    return String(process.env.PICK_ITEM_REPORT_DEBIT ?? '1').trim() !== '0';
  }

  private static readonly ITEM_REPORT_REASON_LABELS: Record<string, string> = {
    out_of_stock: 'Sem estoque físico',
    defective: 'Peça com defeito',
    divergence: 'Divergência (cor/tamanho)',
    other: 'Outro',
  };

  /**
   * LOJA REPORTA UMA PEÇA na bipagem ("não achei a peça") — SEM travar o resto.
   *
   * Caso ON-000006 (21/08): 10 de 11 bipadas, a última não existia fisicamente.
   * O finish exige 100% bipado, então a separação morria na tela com o
   * "Finalizar" cinza — e a única saída era o report-issue do CARD inteiro,
   * que devolve os 10 bipes e manda TUDO pra outra loja.
   *
   * O que acontece aqui, numa transação com o card travado:
   *   1. As unidades que FALTAM do SKU saem do card: o OrderItem fica sem loja
   *      (`assignedStoreId = null`), que é o estado "matriz precisa decidir" —
   *      o mesmo da ruptura. Unidade já bipada FICA no card (se o SKU tinha 2
   *      e bipou 1, a linha é dividida e só a que falta sai).
   *   2. Com motivo "sem estoque físico", a quantidade fantasma SAI do estoque
   *      da loja — é ela que faz o site continuar vendendo peça que não
   *      existe. Defeito NÃO baixa aqui (o fluxo de Defeitos é quem dá o
   *      destino da peça); divergência/outro também não.
   *   3. A evidência vira linha em `pick_order_item_reports` (órfã de
   *      propósito, como os bipes).
   *
   * Com o item fora do card, o esperado da bipagem encolhe sozinho
   * (`getScanData`/`finishSeparation` leem por `assignedStoreId`) e o
   * "Finalizar separação" destrava com o resto bipado.
   */
  async reportItem(
    pickOrderId: string,
    storeId: string,
    userId: string,
    input: { orderItemId: string; reason: string; note?: string },
  ) {
    const reason = String(input?.reason ?? '').trim();
    const validReasons = Object.keys(PickOrdersService.ITEM_REPORT_REASON_LABELS);
    if (!validReasons.includes(reason)) {
      throw new BadRequestException(`reason inválido. Use: ${validReasons.join(' | ')}`);
    }
    const orderItemId = String(input?.orderItemId ?? '').trim();
    if (!orderItemId) throw new BadRequestException('orderItemId obrigatório');
    const note = (input?.note ?? '').toString().trim().slice(0, 500) || null;
    if (reason === 'other' && (!note || note.length < 5)) {
      throw new BadRequestException('Motivo "Outro" exige uma observação (mín. 5 letras)');
    }

    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      include: {
        store: { select: { code: true, name: true } },
        order: { select: { id: true, wcOrderId: true, wcOrderNumber: true } },
      },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pick-order não é da sua loja');
    const storeCode = String(po.store?.code ?? '').trim();
    if (!storeCode) throw new BadRequestException('Loja sem código configurado');

    // Baixa fantasma só no "sem estoque físico" — e respeitando as mesmas
    // portas da baixa do bipe (shadow/killswitch).
    const debitSkippedReason =
      reason !== 'out_of_stock'
        ? `reason:${reason}`
        : !this.itemReportDebitEnabled
          ? 'killswitch'
          : !this.erp.isWriteEnabled
            ? 'shadow'
            : null;

    const out = await this.prisma.$transaction(async (tx) => {
      await this.scans.lockPickOrder(tx, pickOrderId);

      // Reconfere DEPOIS da trava — cancelamento/issue pode ter commitado no meio.
      const atual: any = await tx.pickOrder.findUnique({
        where: { id: pickOrderId },
        select: { status: true, debitApprovedAt: true, issueReason: true } as any,
      });
      if (!atual) throw new BadRequestException('Este pedido saiu da sua fila.');
      if (atual.status !== 'new' && atual.status !== 'separating') {
        throw new BadRequestException(`Status atual é "${atual.status}" — só dá pra reportar peça em "new"/"separating"`);
      }
      if (atual.issueReason) {
        throw new BadRequestException('Este pedido já está com problema reportado — fale com a matriz.');
      }
      if (atual.debitApprovedAt) {
        throw new BadRequestException('Estoque deste pedido já foi baixado por inteiro — fale com a matriz.');
      }

      const item = await tx.orderItem.findUnique({ where: { id: orderItemId } });
      if (!item || item.orderId !== po.orderId || item.assignedStoreId !== storeId) {
        throw new BadRequestException('Esse item não está (mais) neste pedido da sua loja.');
      }
      if (ehItemSemEstoque(item)) {
        throw new BadRequestException('Esse item não é peça de estoque (frete/linha manual).');
      }
      const sku = item.sku;

      // O bipe conta por SKU, não por linha — então o reporte também trabalha
      // por SKU: soma o esperado de TODAS as linhas do SKU nesta loja e
      // desconta o que já foi bipado.
      const linhasDoSku = await tx.orderItem.findMany({
        where: { orderId: po.orderId, assignedStoreId: storeId, sku },
        orderBy: { id: 'asc' },
      });
      const esperadoSku = linhasDoSku.reduce((a, b) => a + b.quantity, 0);
      const bipadoSku = await tx.pickOrderScan.count({
        where: { pickOrderId, sku, revertedAt: null },
      });
      const faltam = esperadoSku - bipadoSku;
      if (faltam <= 0) {
        throw new BadRequestException('Todas as unidades dessa peça já foram bipadas — nada pra reportar.');
      }

      const todasLinhas = await tx.orderItem.findMany({
        where: { orderId: po.orderId, assignedStoreId: storeId },
        select: { quantity: true },
      });
      const esperadoCard = todasLinhas.reduce((a, b) => a + b.quantity, 0);
      if (esperadoCard - faltam <= 0) {
        throw new BadRequestException(
          'Essa é a única peça do pedido — use o "Reportar problema" do card, que manda o pedido inteiro pra matriz.',
        );
      }

      // Divide/desatribui as linhas do SKU: as unidades JÁ BIPADAS ficam na
      // loja, as que faltam saem do card (sem loja = matriz decide).
      let manterBipadas = bipadoSku;
      let idLinhaReportada: string | null = null;
      for (const linha of linhasDoSku) {
        const fica = Math.min(linha.quantity, manterBipadas);
        manterBipadas -= fica;
        const sai = linha.quantity - fica;
        if (sai <= 0) continue;
        if (fica === 0) {
          await tx.orderItem.update({
            where: { id: linha.id },
            data: { assignedStoreId: null },
          });
          idLinhaReportada = idLinhaReportada ?? linha.id;
        } else {
          await tx.orderItem.update({
            where: { id: linha.id },
            data: { quantity: fica },
          });
          const nova = await tx.orderItem.create({
            data: {
              orderId: linha.orderId,
              sku: linha.sku,
              productName: linha.productName,
              ref: linha.ref,
              cor: linha.cor,
              tamanho: linha.tamanho,
              quantity: sai,
              unitPrice: linha.unitPrice,
              baseUnitPrice: linha.baseUnitPrice,
              assignedStoreId: null,
            },
          });
          idLinhaReportada = idLinhaReportada ?? nova.id;
        }
      }

      if (!debitSkippedReason) {
        // allowNegative: o objetivo É corrigir o saldo que está mentindo.
        await this.erp.applyStockDeltaInTx(
          tx,
          [{ sku, qty: faltam, storeCode }],
          -1,
          { allowNegative: true, skipNotFound: true },
        );
      }

      const report = await tx.pickOrderItemReport.create({
        data: {
          pickOrderId,
          orderId: po.orderId,
          storeId,
          storeCode,
          orderItemId: idLinhaReportada,
          sku,
          productName: item.productName,
          ref: item.ref,
          cor: item.cor,
          tamanho: item.tamanho,
          qtyMissing: faltam,
          reason,
          note,
          reportedBy: userId || null,
          stockDecreasedAt: debitSkippedReason ? null : new Date(),
          debitSkippedReason,
        },
      });
      return { report, faltam, sku, esperadoRestante: esperadoCard - faltam };
    });

    const reasonLabel = PickOrdersService.ITEM_REPORT_REASON_LABELS[reason];
    const peca = [out.report.ref, out.report.cor, out.report.tamanho].filter(Boolean).join(' · ') || out.sku;

    await this.prisma.orderHistory.create({
      data: {
        orderId: po.orderId,
        userId,
        fromStatus: po.status,
        toStatus: po.status,
        note:
          `Loja ${storeCode} reportou peça na bipagem: ${peca} (${out.faltam} un) — ${reasonLabel}` +
          (note ? ` — "${note}"` : '') +
          (out.report.stockDecreasedAt
            ? '. Quantidade fantasma baixada do estoque da loja.'
            : '.') +
          ' Item aguardando decisão da matriz (mandar de outra loja ou reembolsar).',
      },
    });

    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'item.issue.reported',
        payload: JSON.stringify({
          pickOrderId,
          orderId: po.orderId,
          reportId: out.report.id,
          storeId,
          storeCode,
          sku: out.sku,
          qtyMissing: out.faltam,
          reason,
          note,
          reportedBy: userId,
          stockDecreased: !!out.report.stockDecreasedAt,
          debitSkippedReason,
        }),
        status: 200,
      },
    });

    // Mesmo evento que o report do card — /separacao e /pedidos já destacam.
    // `itemLevel` deixa o front distinguir (o card NÃO saiu da fila da loja).
    this.gateway.emitPickOrderIssue(storeId, {
      pickOrderId,
      orderId: po.orderId,
      wcOrderId: po.order?.wcOrderId ?? null,
      storeId,
      storeCode,
      storeName: po.store?.name ?? null,
      reason,
      reasonLabel: `Peça faltou na bipagem: ${peca} (${out.faltam} un) — ${reasonLabel}`,
      note,
      reportedAt: out.report.reportedAt.toISOString(),
      itemLevel: true,
      sku: out.sku,
      qtyMissing: out.faltam,
    });

    return {
      ok: true,
      reportId: out.report.id,
      sku: out.sku,
      qtyMissing: out.faltam,
      reasonLabel,
      stockDecreased: !!out.report.stockDecreasedAt,
      debitSkippedReason,
      esperadoRestante: out.esperadoRestante,
    };
  }

  /**
   * Reportes de peça AINDA SEM DESTINO de um pedido. "Resolvido" é derivado:
   * se a linha reportada sumiu (pedido apagado) ou voltou a ter loja (matriz
   * re-roteou), o reporte se resolve sozinho — e o carimbo `resolvedAt` é
   * gravado aqui mesmo, na leitura, pra lista parar de consultar o item.
   */
  private async listItemReportsForOrder(orderId: string) {
    const abertos = await this.prisma.pickOrderItemReport.findMany({
      where: { orderId, resolvedAt: null },
      orderBy: { reportedAt: 'desc' },
    });
    return this.autoResolveReports(abertos);
  }

  private async autoResolveReports(abertos: Array<any>) {
    if (!abertos.length) return [];
    const itemIds = abertos.map((r) => r.orderItemId).filter(Boolean) as string[];
    const itens = itemIds.length
      ? await this.prisma.orderItem.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, assignedStoreId: true },
        })
      : [];
    const porId = new Map(itens.map((i) => [i.id, i]));

    const vivos: any[] = [];
    for (const r of abertos) {
      const item = r.orderItemId ? porId.get(r.orderItemId) : null;
      const resolvido = r.orderItemId ? !item || item.assignedStoreId !== null : false;
      if (resolvido) {
        await this.prisma.pickOrderItemReport.updateMany({
          where: { id: r.id, resolvedAt: null },
          data: { resolvedAt: new Date(), resolvedBy: 'auto:rerouted' },
        });
        continue;
      }
      vivos.push({
        id: r.id,
        pickOrderId: r.pickOrderId,
        orderId: r.orderId,
        storeCode: r.storeCode,
        sku: r.sku,
        productName: r.productName,
        ref: r.ref,
        cor: r.cor,
        tamanho: r.tamanho,
        qtyMissing: r.qtyMissing,
        reason: r.reason,
        reasonLabel: PickOrdersService.ITEM_REPORT_REASON_LABELS[r.reason] ?? r.reason,
        note: r.note,
        reportedAt: r.reportedAt,
        stockDecreased: !!r.stockDecreasedAt,
      });
    }
    return vivos;
  }

  /**
   * Matriz: reportes de peça de um pedido WC (banner do /pedidos/wc/[id]).
   *
   * Vem com o DINHEIRO junto (`valorSugerido`) e com quem é a dona dele
   * (`cliente`): a peça sumiu depois de paga, e o desfecho — devolver ou virar
   * crédito — é uma decisão de valor. Sem isso a matriz teria que abrir o
   * pedido noutra aba pra descobrir quanto a cliente pagou por AQUELA peça.
   */
  async listItemReportsByWc(wcOrderId: number) {
    const order = await this.prisma.order.findFirst({
      where: { wcOrderId },
      select: {
        id: true,
        wcOrderNumber: true,
        customerName: true,
        customerCpf: true,
        customerPhone: true,
      },
    });
    if (!order) return [];
    const abertos = await this.listItemReportsForOrder(order.id);
    if (!abertos.length) return [];

    const itens = await this.prisma.orderItem.findMany({
      where: { orderId: order.id },
      select: { id: true, sku: true, unitPrice: true },
    });
    const porId = new Map(itens.map((i) => [i.id, i]));
    const porSku = new Map(itens.map((i) => [String(i.sku), i]));
    const cpf = String(order.customerCpf || '').replace(/\D/g, '');

    return abertos.map((r) => {
      // O item pode ter sido apagado do pedido; o SKU do snapshot é o plano B.
      const item = (r.orderItemId ? porId.get(r.orderItemId) : null) ?? porSku.get(String(r.sku));
      const unit = Number(item?.unitPrice) || 0;
      return {
        ...r,
        valorSugerido: Math.round(unit * (Number(r.qtyMissing) || 1) * 100) / 100,
        cliente: {
          nome: order.customerName || null,
          cpf: cpf.length === 11 ? cpf : null,
          telefone: order.customerPhone || null,
          pedidoNumero: order.wcOrderNumber || String(wcOrderId),
        },
      };
    });
  }

  /**
   * Matriz resolve um reporte de peça. DOIS desfechos, e a diferença entre eles
   * é dinheiro saindo ou dinheiro ficando (dono, 25/08/2026):
   *
   * · `reembolso` — o desfecho de sempre: o estorno acontece por fora (gateway,
   *   PIX de volta) e aqui só se apaga o alarme.
   * · `credito`   — a cliente PREFERE crédito. Emite um vale NOMINAL no CPF
   *   dela, **sem prazo de validade**, que vale no site e em qualquer caixa da
   *   rede.
   *
   * O vale nasce em `site_cupons` com `origem='troca'` porque é o ÚNICO formato
   * que os dois lugares onde ela vai gastar já sabem aceitar: o checkout
   * (`CupomService.aplicar`) e o PDV (`addPayment` → `resolverValeDoSite`).
   * Inventar tabela nova aqui seria entregar um código que o caixa não
   * reconhece — o erro que a tela de trocas do WC cometeu até 21/08.
   */
  async resolveItemReport(
    reportId: string,
    userId: string,
    opts?: { modo?: string; valor?: number; userName?: string },
  ) {
    const r = await this.prisma.pickOrderItemReport.findUnique({ where: { id: reportId } });
    if (!r) throw new NotFoundException('Reporte não encontrado');
    if (r.resolvedAt) return { ok: true, alreadyResolved: true };

    const modo = opts?.modo === 'credito' ? 'credito' : 'reembolso';
    if (modo === 'reembolso') {
      await this.prisma.pickOrderItemReport.update({
        where: { id: reportId },
        data: { resolvedAt: new Date(), resolvedBy: userId || 'admin' },
      });
      return { ok: true, alreadyResolved: false, modo };
    }

    // O vale nasce ANTES do carimbo: se a emissão falhar (pedido sem CPF), o
    // alarme continua na tela. Apagar o aviso e não emitir o crédito seria a
    // pior combinação possível — a cliente fica sem peça e sem dinheiro.
    const credito = await this.emitirCreditoDoReporte(r, opts?.valor, opts?.userName || userId);
    await this.prisma.pickOrderItemReport.update({
      where: { id: reportId },
      data: {
        resolvedAt: new Date(),
        // Mesma convenção do `auto:rerouted`: o prefixo diz COMO se resolveu, e
        // é por ele que `listCreditosByWc` reencontra o vale desta peça.
        resolvedBy: `credito:${credito.code}`,
      },
    });
    return { ok: true, alreadyResolved: false, modo, credito };
  }

  /**
   * Emite o vale do reporte. Regras que NÃO são negociáveis:
   *
   * · **Nominal.** Sem CPF de 11 dígitos no pedido, não emite — código sem dono
   *   circula em print de WhatsApp e vira compra de outra pessoa
   *   ([[vale-troca-so-apos-conferencia]]).
   * · **Sem prazo** (ordem do dono): `fimEm: null`. O PDV e o checkout já
   *   tratam validade nula como "não vence" — nenhum dos dois precisou mudar.
   * · **Teto no que ela pagou.** O valor default é o preço da peça que faltou;
   *   a matriz pode ajustar (frete, cortesia), mas não acima do total do
   *   pedido — digitar 8990 no lugar de 89,90 não pode virar crédito real.
   */
  private async emitirCreditoDoReporte(r: any, valorPedido: number | undefined, autor: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: r.orderId },
      select: {
        wcOrderNumber: true,
        wcOrderId: true,
        customerName: true,
        customerCpf: true,
        totalAmount: true,
      },
    });
    if (!order) throw new NotFoundException('Pedido do reporte não encontrado');

    const cpf = String(order.customerCpf || '').replace(/\D/g, '');
    if (cpf.length !== 11) {
      throw new BadRequestException(
        'Pedido sem CPF — o crédito é nominal e não pode ser emitido. Preencha o CPF da cliente no pedido e gere de novo.',
      );
    }

    let valor = Number(valorPedido);
    if (!Number.isFinite(valor) || valor <= 0) {
      const item = r.orderItemId
        ? await this.prisma.orderItem.findUnique({
            where: { id: r.orderItemId },
            select: { unitPrice: true },
          })
        : await this.prisma.orderItem.findFirst({
            where: { orderId: r.orderId, sku: String(r.sku) },
            select: { unitPrice: true },
          });
      valor = (Number(item?.unitPrice) || 0) * (Number(r.qtyMissing) || 1);
    }
    valor = Math.round(valor * 100) / 100;
    if (!(valor > 0)) {
      throw new BadRequestException(
        'Não consegui descobrir quanto essa peça custou. Digite o valor do crédito na mão.',
      );
    }
    const teto = Number(order.totalAmount) || 0;
    if (teto > 0 && valor > teto + 0.01) {
      throw new BadRequestException(
        `Crédito de R$ ${valor.toFixed(2)} é maior que o total do pedido (R$ ${teto.toFixed(2)}). Confira o valor.`,
      );
    }

    const pedido = order.wcOrderNumber || String(order.wcOrderId || '');
    // Prefixo TROCA- de propósito: é o que a vendedora reconhece na tela de
    // devolução do PDV (`/^TROCA-/i` roteia o código pro vale em vez de tentar
    // achar uma peça com esse código de barras).
    let code = '';
    for (let i = 0; i < 5 && !code; i++) {
      const tentativa = `TROCA-${randomBytes(5).toString('hex').toUpperCase()}`;
      const existe = await (this.prisma as any).siteCupom.findUnique({
        where: { code: tentativa },
        select: { code: true },
      });
      if (!existe) code = tentativa;
    }
    if (!code) throw new BadRequestException('Não consegui gerar um código de vale. Tente de novo.');

    await (this.prisma as any).siteCupom.create({
      data: {
        code,
        label: `Crédito da peça que faltou no pedido ${pedido}`.slice(0, 80),
        tipo: 'fixed',
        valor,
        usoMaximo: 1,
        ativo: true,
        fimEm: null, // SEM PRAZO — ordem do dono.
        cpf,
        origem: 'troca',
        atualizadoPor: `peça faltante · ${autor}`.slice(0, 80),
      },
    });

    this.logger.log(
      `[item-report ${String(r.id).slice(0, 8)}] crédito ${code} R$${valor.toFixed(2)} ` +
        `CPF final ${cpf.slice(-4)} pedido ${pedido} (sem prazo) — por ${autor}`,
    );

    return {
      code,
      valor,
      cpf,
      semPrazo: true,
      clienteNome: order.customerName || null,
      pedidoNumero: pedido,
    };
  }

  /**
   * Créditos JÁ emitidos por peça faltante neste pedido — o painel que
   * sobrevive ao F5.
   *
   * O reporte some da lista assim que é resolvido, e o código do vale só
   * aparecia uma vez, na resposta do clique: recarregar a página levava embora
   * o único lugar onde ele estava escrito. Aqui ele é reencontrado pelo carimbo
   * `resolvedBy = 'credito:<CODE>'`, com o estado ATUAL do vale (`usos`) — a
   * matriz enxerga se a cliente já gastou.
   */
  async listCreditosByWc(wcOrderId: number) {
    const order = await this.prisma.order.findFirst({
      where: { wcOrderId },
      select: { id: true },
    });
    if (!order) return [];
    const resolvidos = await this.prisma.pickOrderItemReport.findMany({
      where: { orderId: order.id, resolvedBy: { startsWith: 'credito:' } },
      orderBy: { resolvedAt: 'desc' },
    });
    if (!resolvidos.length) return [];

    const codes = resolvidos.map((r) => String(r.resolvedBy).slice('credito:'.length));
    let cupons: any[] = [];
    try {
      cupons = await (this.prisma as any).siteCupom.findMany({ where: { code: { in: codes } } });
    } catch {
      cupons = [];
    }
    const porCode = new Map(cupons.map((c: any) => [c.code, c]));

    return resolvidos.map((r) => {
      const code = String(r.resolvedBy).slice('credito:'.length);
      const c = porCode.get(code);
      const usos = Number(c?.usos) || 0;
      const maximo = c?.usoMaximo == null ? null : Number(c.usoMaximo);
      return {
        id: r.id,
        code,
        valor: Number(c?.valor) || 0,
        peca: [r.ref, r.cor, r.tamanho].filter(Boolean).join(' · ') || r.sku,
        qtyMissing: r.qtyMissing,
        storeCode: r.storeCode,
        emitidoEm: r.resolvedAt,
        // Vale sumido de `site_cupons` não pode virar "existe e está ativo".
        existe: !!c,
        usado: !!c && maximo != null && usos >= maximo,
        usadoAt: c?.usadoAt ?? null,
        ativo: c ? !!c.ativo : false,
        semPrazo: c ? !c.fimEm : true,
        validade: c?.fimEm ?? null,
      };
    });
  }

  /**
   * Matriz dispara impressão remota. Emite socket pra loja dona do pick-order.
   * O Electron da loja (em /minha-loja) recebe o evento e abre uma janela hidden
   * apontando pra /minha-loja/imprimir/{id}?autoprint=1 — essa página chama
   * window.electronAPI.silentPrintHTML() e se fecha.
   *
   * Falha rápido se:
   *  - pick-order não existe
   *  - loja não está online (Electron fechado / PC desligado)
   */
  async triggerRemotePrint(pickOrderId: string): Promise<{
    ok: boolean;
    sent: boolean;
    storeId: string;
    storeName: string | null;
    reason?: string;
  }> {
    const pick = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      include: { store: { select: { id: true, name: true, code: true } } },
    });
    if (!pick) throw new NotFoundException('Pick-order não encontrado');

    const storeId = pick.storeId;
    const storeName = pick.store?.name ?? null;

    if (!this.gateway.isStoreOnline(storeId)) {
      this.logger.warn(
        `[print-remote] loja ${storeName || storeId} offline — Electron não conectado`,
      );
      return {
        ok: false,
        sent: false,
        storeId,
        storeName,
        reason: 'Loja offline — Electron não está conectado. Verifique se o computador da loja está ligado e com LURDS ORDER ONE aberto.',
      };
    }

    this.gateway.emitPrintRequest(storeId, {
      pickOrderId,
      url: `/minha-loja/imprimir/${pickOrderId}?autoprint=1`,
    });

    this.logger.log(
      `[print-remote] disparado pro Electron da loja ${storeName || storeId} (pick ${pickOrderId})`,
    );

    return {
      ok: true,
      sent: true,
      storeId,
      storeName,
    };
  }
}
