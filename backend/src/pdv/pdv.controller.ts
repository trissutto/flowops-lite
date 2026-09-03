import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { validateMinLevel } from '../auth/auth-levels.util';
import { isValidTrainingPassword, isTrainingRequest } from './training.util';
import { PdvService } from './pdv.service';
import { ErpOutboxService } from './erp-outbox.service';
import { ConferenciaVendasService } from './conferencia-vendas.service';
import { ErpService } from '../erp/erp.service';
import { SombraService } from '../erp/sombra.service';
import { CrediarioCriacaoService } from '../crediario-nativo/crediario-criacao.service';
import { PrismaService } from '../prisma/prisma.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { PixService } from './pix.service';
import { NfceService } from './nfce.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { CrediariosService } from '../crediarios/crediarios.service';
import { CrediarioBaixaService } from '../crediarios/crediario-baixa.service';
import { CrediarioPrintService } from './crediario-print.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';
import { ReturnsService } from './returns.service';
import { CobrancasOnlineService } from './cobrancas-online.service';
import { LastroRedeService } from './lastro-rede.service';
import type { CobrancaOnline } from './cobrancas-online.service';

/**
 * /pdv — frente de caixa.
 * Acessível por role 'store' (vendedora) e 'admin'.
 */
@UseGuards(JwtAuthGuard)
@Controller('pdv')
export class PdvController {
  private readonly logger = new Logger(PdvController.name);

  constructor(
    private readonly svc: PdvService,
    private readonly outbox: ErpOutboxService,
    private readonly conferencia: ConferenciaVendasService,
    private readonly erp: ErpService,
    private readonly catalog: WincredCatalogService,
    private readonly pix: PixService,
    private readonly nfce: NfceService,
    private readonly pagarme: PagarmeService,
    private readonly crediarios: CrediariosService,
    private readonly crediarioBaixa: CrediarioBaixaService,
    private readonly crediarioPrint: CrediarioPrintService,
    private readonly woo: WooCommerceService,
    private readonly returns: ReturnsService,
    private readonly prisma: PrismaService,
    private readonly sombra: SombraService,
    private readonly crediarioCriacao: CrediarioCriacaoService,
    private readonly cobrancasOnlineSvc: CobrancasOnlineService,
    private readonly lastroRede: LastroRedeService,
  ) {}

  // ── LASTRO DA VENDA À DISTÂNCIA (26/08 — carrossel ON-000110/162) ────────
  // Semáforo por SKU do carrinho: verde tem, amarelo com ressalva (parcial /
  // prometida / peça em caixa em trânsito), vermelho não existe na rede.
  // Chamado pelo fluxo de venda online do PDV (entrega + finalizar) — balcão
  // com a peça na mão não passa por aqui.
  @Post('lastro-rede')
  lastroRedeChecar(@Req() req: any, @Body() body: { items?: Array<{ sku: string; qty?: number }> }) {
    this.requireRole(req);
    return this.lastroRede.checar(Array.isArray(body?.items) ? body.items : []);
  }

  /** "Vender mesmo assim" no vermelho — só assina no log, não bloqueia. */
  @Post('lastro-rede/override')
  lastroRedeOverride(
    @Req() req: any,
    @Body() body: { saleId?: string; skus?: string[] },
  ) {
    this.requireRole(req);
    return this.lastroRede.registrarOverride({
      storeId: req?.user?.storeId ?? null,
      userId: req?.user?.userId ?? req?.user?.sub ?? null,
      saleId: body?.saleId ?? null,
      skus: Array.isArray(body?.skus) ? body.skus.map(String) : [],
    });
  }

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
  }

  /** Papéis de franquia (editam ações de venda, escopados às lojas FILIAL). */
  private ehPapelFranquia(role: string | undefined): boolean {
    return role === 'master_franquia' || role === 'franquias';
  }

  /** Papel de franquia só age em venda de loja FRANQUIA (tipo=FILIAL). */
  private async assertSaleEhFranquia(saleId: string) {
    const prisma = (this.svc as any).prisma;
    const sale = await prisma.pdvSale.findUnique({
      where: { id: saleId },
      select: { storeCode: true },
    });
    const franquia = await prisma.store.findMany({
      where: { tipo: 'FILIAL', active: true },
      select: { code: true },
    });
    const codes = new Set((franquia as any[]).map((s) => s.code));
    if (!sale?.storeCode || !codes.has(sale.storeCode)) {
      throw new ForbiddenException(`Venda de loja ${sale?.storeCode || '?'} não é franquia — acesso negado`);
    }
  }

  /** Loja da VENDA — contexto pros PINs com ESCOPO de loja (franqueado MASTER
   *  só nas lojas dele; dono 29/07). Sessão de loja usa a própria; painel
   *  admin/franquia resolve pela venda. */
  private async storeCodeCtx(saleId: string, req: any): Promise<string | undefined> {
    if (req?.user?.storeCode) return String(req.user.storeCode);
    try {
      const sale = await (this.svc as any).prisma.pdvSale.findUnique({
        where: { id: saleId },
        select: { storeCode: true },
      });
      return sale?.storeCode || undefined;
    } catch {
      return undefined;
    }
  }

  // (O cache de descoberta da tabela `clientes` do Giga morava aqui —
  // removido na Onda 1: o customer-info lê só o espelho `giga_clientes`.)

  /**
   * GET /pdv/product-image?sku=XXX
   * Retorna URL da foto do produto no WooCommerce (cache 1h em memória).
   * Usado pela tabela do carrinho do PDV pra mostrar miniatura ao lado do item.
   */
  @Get('product-image')
  async getProductImage(@Req() req: any, @Query('sku') sku: string) {
    this.requireRole(req);
    if (!sku) return { url: null };
    const url = await this.woo.getProductImageBySku(String(sku).trim());
    return { url };
  }

  /**
   * GET /pdv/product-images?skus=A,B,C
   * Mesma coisa da rota acima, porém em LOTE.
   *
   * O carrinho pedia uma requisição POR PEÇA: carrinho de 12 peças abria 12
   * conexões, e em loja com internet ruim a miniatura entrava piscando uma a
   * uma. Aqui a tela pede tudo de uma vez.
   *
   * Retorna { urls: { [sku]: string | null } }. SKU que falhar vira null —
   * miniatura é enfeite, nunca pode derrubar o carrinho.
   */
  @Get('product-images')
  async getProductImages(@Req() req: any, @Query('skus') skus: string) {
    this.requireRole(req);
    const lista = String(skus || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 60); // teto de segurança — carrinho real não passa disso
    const unicos = Array.from(new Set(lista));
    const urls: Record<string, string | null> = {};
    await Promise.all(
      unicos.map(async (sku) => {
        try {
          urls[sku] = (await this.woo.getProductImageBySku(sku)) || null;
        } catch {
          urls[sku] = null;
        }
      }),
    );
    return { urls };
  }

  /**
   * POST /pdv/training/validate
   * Valida senha de treinamento. Frontend chama uma vez no clique do botão
   * "🎓 Modo Treinamento" — se ok, salva flag no sessionStorage e passa a
   * mandar header `x-training-mode: 1` em todas as requests subsequentes.
   * Senha vem do env TREINAMENTO_PASSWORD.
   */
  @Post('training/validate')
  validateTraining(@Body() body: { password: string }) {
    const ok = isValidTrainingPassword(body?.password || '');
    if (!ok) throw new ForbiddenException('Senha de treinamento inválida');
    return { ok: true, mode: 'training' };
  }

  /**
   * GET /pdv/product?sku=5358427
   * Busca produto pra pré-visualização (sem adicionar ao carrinho).
   * Lê do ESPELHO Postgres com fallback pro Giga ao vivo.
   */
  @Get('product')
  product(@Req() req: any, @Query('sku') sku: string) {
    this.requireRole(req);
    if (!sku) throw new BadRequestException('sku obrigatório');
    return this.catalog.getPdvProductInfo(sku);
  }

  /**
   * GET /pdv/pix-orfaos — PIX PagBank PAGO cujo saleId não é venda, carrinho
   * nem baixa de crediário (admin).
   *
   * É a lista do dinheiro invisível: a auditoria de 11/08 achou 11 desses em
   * 48h (R$88 a R$1.448) — pagos, na conta, e sem registro pra fechar. O guard
   * no `POST /pagbank/pix/create` estanca a origem; isto aqui é a conferência
   * do que já entrou e do que ainda escapar.
   */
  @Get('pix-orfaos')
  async pixOrfaos(@Req() req: any, @Query('dias') dias?: string) {
    const role = req?.user?.role;
    if (role !== 'admin') throw new ForbiddenException('Apenas admin');
    const janela = Math.min(90, Math.max(1, Number(dias) || 30));
    const desde = new Date(Date.now() - janela * 86_400_000);

    const pagos: any[] = await (this.svc as any).prisma.pagbankPayment.findMany({
      where: { status: 'paid', paidAt: { gte: desde } },
      orderBy: { paidAt: 'desc' },
      select: {
        saleId: true, pagbankOrderId: true, valor: true, storeCode: true,
        method: true, paidAt: true, createdAt: true,
      },
    });

    const orfaos: any[] = [];
    for (const p of pagos) {
      const [venda, cart, baixa] = await Promise.all([
        (this.svc as any).prisma.pdvSale.findUnique({ where: { id: p.saleId }, select: { id: true } }),
        (this.svc as any).prisma.livePdvCart
          .findUnique({ where: { id: p.saleId }, select: { id: true } })
          .catch(() => null),
        (this.svc as any).prisma.crediarioBaixa
          .findUnique({ where: { id: p.saleId }, select: { id: true } })
          .catch(() => null),
      ]);
      if (!venda && !cart && !baixa) orfaos.push(p);
    }
    return {
      janelaDias: janela,
      totalPagos: pagos.length,
      orfaos: orfaos.length,
      valorTotal: orfaos.reduce((s, p) => s + Number(p.valor || 0), 0),
      itens: orfaos,
    };
  }

  /**
   * GET /pdv/erp-outbox — status da fila de sync ERP (admin).
   * Mostra contagens por status, job pendente mais antigo e últimas falhas.
   */
  @Get('erp-outbox')
  erpOutboxStatus(@Req() req: any) {
    const role = req?.user?.role;
    if (role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.outbox.status();
  }

  /**
   * POST /pdv/erp-outbox/retry — re-enfileira jobs 'failed' (admin).
   */
  @Post('erp-outbox/retry')
  erpOutboxRetry(@Req() req: any) {
    const role = req?.user?.role;
    if (role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.outbox.retryFailed();
  }

  /**
   * GET /pdv/conferencia-vendas?de=YYYY-MM-DD&ate=YYYY-MM-DD — pedidos da
   * venda online do PDV com a prova de pagamento de cada um (admin).
   */
  @Get('conferencia-vendas')
  conferenciaVendas(@Req() req: any, @Query('de') de?: string, @Query('ate') ate?: string) {
    const role = req?.user?.role;
    if (role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.conferencia.listar(de, ate);
  }

  /**
   * POST /pdv/conferencia-vendas/:orderId/conferir { desfazer? } — carimbo
   * humano de "dinheiro conferido no extrato" (admin).
   */
  @Post('conferencia-vendas/:orderId/conferir')
  conferenciaConferir(
    @Req() req: any,
    @Param('orderId') orderId: string,
    @Body() body: { desfazer?: boolean },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin') throw new ForbiddenException('Apenas admin');
    const usuario = req?.user?.name || req?.user?.email || 'matriz';
    return this.conferencia.conferir(orderId, usuario, !!body?.desfazer);
  }

  /**
   * POST /pdv/sales { storeCode }
   * Abre nova venda OPEN.
   */
  @Post('sales')
  createSale(@Req() req: any, @Body() body: { storeCode: string; sellerId?: string; sellerName?: string }) {
    this.requireRole(req);
    // SEGURANÇA CRÍTICA: pra user role=store, IGNORA o storeCode do body e
    // FORÇA o storeCode do JWT. Senão um localStorage stale no PC da loja
    // X pode fazer vendedora abrir venda como loja Y por engano (e gravar
    // NFC-e no CNPJ errado, sumiço de estoque, etc).
    const userRole = req?.user?.role;
    const userStoreCode = req?.user?.storeCode;
    const effectiveStoreCode = userRole === 'store' && userStoreCode
      ? userStoreCode
      : body?.storeCode;
    return this.svc.createSale({
      storeCode: effectiveStoreCode,
      vendedorUserId: req?.user?.id || req?.user?.sub,
      vendedorName: req?.user?.name || null,
      sellerId: body?.sellerId,
      sellerName: body?.sellerName,
      isTraining: isTrainingRequest(req),
    });
  }

  /**
   * GET /pdv/cobrancas-online?storeCode=13
   *
   * "OS PEDIDOS DO LINK PIX NÃO APARECEM COMO AGUARDANDO PAGAMENTO" (dono,
   * 25/08). PIX e Link Pagar.me na MESMA lista, uma linha por venda, com a
   * situação em palavra de gente. Ver `CobrancasOnlineService` pro porquê.
   *
   * `store` só enxerga a própria loja (o storeCode do token manda, igual ao
   * `createSale`); admin da matriz vê a loja que pedir — e a rede inteira
   * quando não pede nenhuma, que é como a /separacao consome.
   */
  @Get('cobrancas-online')
  async cobrancasOnline(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
  ): Promise<CobrancaOnline[]> {
    this.requireRole(req);
    const role = req?.user?.role;
    const doToken = String(req?.user?.storeCode ?? '').trim();
    const loja = role === 'store' && doToken ? doToken : (storeCode || '').trim();
    return this.cobrancasOnlineSvc.listar({ storeCode: loja || null });
  }

  /**
   * GET /pdv/carrinhos-abandonados
   *
   * A lista de carrinhos do site NOVO, pro PDV da loja-canal.
   *
   * POR QUE NÃO USA `/abandoned-carts/ecommerce/list`: aquele controller tem
   * `AdminOnlyGuard` e as meninas do carrinho abandonado entram como
   * `role: store` — batiam em "Apenas matriz". E os PDVs não têm acesso à
   * retaguarda, então não havia caminho nenhum pra elas.
   *
   * Também não afrouxei o guard de lá: aquilo abriria a lista inteira de
   * clientes pras 14 lojas. Aqui a rota é do PDV (aceita `store`) e TRAVADA na
   * loja-canal — loja física recebe 403 mesmo tentando na mão.
   */
  @Get('carrinhos-abandonados')
  async carrinhosAbandonados(@Req() req: any, @Query('status') status?: string) {
    this.requireRole(req);
    const role = req?.user?.role;
    const storeCode = String(req?.user?.storeCode ?? '').trim();
    // Admin da matriz passa (usa o PDV em modo master); loja só se trabalhar a fila.
    PdvController.exigirLojaDeCarrinho(role, storeCode);
    return this.svc.listarCarrinhosAbandonados(status || 'abandoned');
  }

  /**
   * POST /pdv/carrinhos-abandonados/desfecho { chave, motivo, observacao?, ... }
   *
   * DÁ BAIXA: "ela não vai fechar, e este é o motivo" (dono, 25/08).
   *
   * Fica no PDV, e não só na retaguarda, porque quem ouve o motivo é quem está
   * no WhatsApp com a cliente. Deixar a baixa só pra matriz faria a linha
   * continuar na fila da loja depois de resolvida — e a próxima menina ligaria
   * pra ouvir a mesma coisa.
   */
  @Post('carrinhos-abandonados/desfecho')
  darBaixaCarrinho(@Req() req: any, @Body() body: any) {
    this.requireRole(req);
    PdvController.exigirLojaDeCarrinho(req?.user?.role, String(req?.user?.storeCode ?? '').trim());
    return this.svc.marcarCarrinhoNaoConvertido(body || {}, req?.user);
  }

  /**
   * POST /pdv/carrinhos-abandonados/atendimento { telefone }
   *
   * "EU JÁ ESTOU FALANDO COM ELA" — disparado pelo clique no botão de WhatsApp
   * do modal, igual à aba Carrinhos da retaguarda.
   *
   * Sem isto o botão novo criaria o problema que a tag existe pra evitar: a
   * loja abre a conversa, a matriz não vê nada e manda a SEGUNDA mensagem
   * cobrando o mesmo carrinho. A rota é do PDV (aceita `role: store`) porque
   * `/abandoned-carts/atendimento` tem AdminOnlyGuard.
   */
  @Post('carrinhos-abandonados/atendimento')
  assumirAtendimentoCarrinho(@Req() req: any, @Body() body: any) {
    this.requireRole(req);
    PdvController.exigirLojaDeCarrinho(req?.user?.role, String(req?.user?.storeCode ?? '').trim());
    return this.svc.assumirAtendimentoCarrinho(String(body?.telefone ?? ''), req?.user);
  }

  /** Desfaz a baixa — baixa errada tem que ter volta. */
  @Post('carrinhos-abandonados/desfecho/reabrir')
  reabrirCarrinhoBaixa(@Req() req: any, @Body() body: any) {
    this.requireRole(req);
    PdvController.exigirLojaDeCarrinho(req?.user?.role, String(req?.user?.storeCode ?? '').trim());
    return this.svc.reabrirCarrinhoBaixa(String(body?.chave ?? ''));
  }

  /** As baixas do período + a lista de motivos (o modal do PDV monta os botões). */
  @Get('carrinhos-abandonados/baixas')
  baixasCarrinho(@Req() req: any, @Query('since') since?: string) {
    this.requireRole(req);
    PdvController.exigirLojaDeCarrinho(req?.user?.role, String(req?.user?.storeCode ?? '').trim());
    return this.svc.listarBaixasCarrinho(since);
  }

  /**
   * Quem trabalha a fila de carrinho do site.
   *
   * Começou só na loja-canal SITE (13). Em 25/08 o dono abriu pra MOEMA (15) e
   * ITANHAÉM (01): são as lojas que atendem o WhatsApp do site junto com a
   * matriz. Continua sendo lista curta, e não "todas as lojas" — carrinho do
   * site não é de ninguém em particular, e loja que não trabalha essa fila só
   * veria uma tela de nomes que não conhece. Espelha o
   * `CARRINHOS_STORE_CODES` do PDV no front.
   */
  private static readonly CARRINHOS_STORE_CODES = ['13', '15', '01'];

  /** Loja-canal SITE — o default de quem importa carrinho SEM loja no token. */
  private static readonly CARRINHOS_STORE_CODE = '13';

  private static exigirLojaDeCarrinho(role: string, storeCode: string) {
    if (role === 'admin') return;
    if (PdvController.CARRINHOS_STORE_CODES.includes(storeCode)) return;
    throw new ForbiddenException(
      'Carrinhos do site são das lojas SITE, Moema e Itanhaém — sua loja não trabalha esses contatos.',
    );
  }

  /**
   * POST /pdv/sales/importar-carrinho { wcOrderId, storeCode? }
   *
   * Abre uma venda online JÁ MONTADA a partir de um carrinho abandonado —
   * peças e cliente preenchidos. A vendedora só escolhe como recebeu.
   *
   * Existe porque em 17/08 foram 7 carrinhos recuperados e só 2 viraram venda
   * no sistema: remontar 11 peças à mão depois de fechar no WhatsApp não
   * acontece. Ver `PdvService.importarCarrinho`.
   */
  @Post('sales/importar-carrinho')
  importarCarrinho(
    @Req() req: any,
    @Body() body: { wcOrderId?: number; recoveryId?: string; storeCode?: string },
  ) {
    this.requireRole(req);
    // Mesma trava do createSale: role=store não escolhe loja pelo body.
    const userRole = req?.user?.role;
    const userStoreCode = req?.user?.storeCode;
    /**
     * ADMIN DA MATRIZ CAI NA LOJA-CANAL SITE.
     *
     * O botão "Fechar esta venda no PDV" existe nos DOIS lados: no PDV da loja
     * 13 (role=store, a loja vem do token) e na retaguarda, em
     * `/separacao?tab=carrinhos` (role=admin, que **não tem loja no token**).
     * Do lado da retaguarda ninguém mandava `storeCode` e o botão morria em
     * `400 storeCode obrigatório` — a operadora fechava no WhatsApp e a venda
     * não entrava no sistema, que é exatamente o buraco que este botão foi
     * feito pra tapar (7 carrinhos recuperados, 2 viraram venda, 17/08).
     *
     * A loja certa não é uma escolha: carrinho do site é da **loja-canal SITE**
     * — a mesma regra que o guard de `carrinhos-abandonados` logo acima já usa
     * pra decidir quem pode ver a lista. Admin que quiser outra loja continua
     * mandando `storeCode` no corpo.
     */
    const effectiveStoreCode =
      userRole === 'store' && userStoreCode
        ? userStoreCode
        : body?.storeCode || PdvController.CARRINHOS_STORE_CODE;
    if (!effectiveStoreCode) throw new BadRequestException('storeCode obrigatório');
    // `recoveryId` = contato capturado no checkout (carrinho que nunca virou
    // pedido). Vem no lugar do wcOrderId — ver `PdvService.importarCarrinho`.
    const recoveryId = String(body?.recoveryId ?? '').trim() || undefined;
    return this.svc.importarCarrinho({
      wcOrderId: body?.wcOrderId ? Number(body.wcOrderId) : undefined,
      recoveryId,
      storeCode: effectiveStoreCode,
      vendedorUserId: req?.user?.id || req?.user?.sub,
      vendedorName: req?.user?.name || null,
      isTraining: isTrainingRequest(req),
    });
  }

  /**
   * PATCH /pdv/sales/:id/seller
   * Body: { sellerId: string | null }
   * Atribui ou remove a vendedora (Seller) responsável pela venda.
   */
  @Patch('sales/:id/seller')
  setSeller(@Req() req: any, @Param('id') saleId: string, @Body() body: { sellerId: string | null }) {
    this.requireRole(req);
    return this.svc.setSeller({ saleId, sellerId: body?.sellerId ?? null });
  }

  /**
   * POST /pdv/sales/:id/nfce — emite NFC-e da venda finalizada.
   * Em modo stub (sem certificado A1) retorna XML preview + chave válida.
   */
  @Post('sales/:id/nfce')
  emitNfce(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.nfce.emit(id);
  }

  /**
   * POST /pdv/sales/:id/nfce/cancel { justificativa }
   * Cancela NFC-e autorizada via evento 110111. Janela: 30min após autorização.
   * Justificativa: 15-255 chars (regra SEFAZ).
   */
  @Post('sales/:id/nfce/cancel')
  cancelNfce(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { justificativa: string },
  ) {
    this.requireRole(req);
    if (!body?.justificativa || String(body.justificativa).trim().length < 15) {
      throw new BadRequestException(
        'Justificativa do cancelamento deve ter pelo menos 15 caracteres',
      );
    }
    return this.nfce.cancel(id, body.justificativa);
  }

  /**
   * GET /pdv/nfce/config?storeCode=01 — leitura da config NFC-e da loja.
   */
  @Get('nfce/config')
  async getNfceConfig(@Req() req: any, @Query('storeCode') storeCode: string) {
    this.requireRole(req);
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.nfce.getConfig(storeCode);
  }

  /**
   * GET /pdv/nfce/status — status NFC-e de TODAS as lojas (dashboard).
   */
  @Get('nfce/status')
  async listNfceStatus(@Req() req: any) {
    this.requireRole(req);
    return this.nfce.listAllStatus();
  }

  /**
   * POST /pdv/nfce/config — salva config (admin only).
   * Body: { storeCode, ambiente, cnpj, ie, csc..., certPfxB64?, certPfxPass? }
   */
  /**
   * POST /pdv/nfce/test/:storeCode — emite NFC-e fictícia pra testar
   * config + cert + transmissão SEFAZ. Não afeta vendas reais.
   * Admin only.
   */
  @Post('nfce/test/:storeCode')
  testNfce(@Req() req: any, @Param('storeCode') storeCode: string) {
    if (req?.user?.role !== 'admin')
      throw new ForbiddenException('Apenas admin');
    return this.nfce.testEmit(storeCode);
  }

  @Post('nfce/config')
  async setNfceConfig(@Req() req: any, @Body() body: any) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode editar config NFC-e');
    }
    if (!body?.storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.nfce.setConfig(body.storeCode, body);
  }

  /**
   * GET /pdv/stats/today?storeCode=01
   * Vendas finalizadas hoje da loja, total vendido e ticket médio.
   */
  @Get('stats/today')
  statsToday(@Req() req: any, @Query('storeCode') storeCode: string) {
    this.requireRole(req);
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.svc.statsToday(storeCode);
  }

  /**
   * GET /pdv/sales?storeCode=01&status=open&limit=20
   */
  @Get('sales')
  listSales(
    @Req() req: any,
    @Query('storeCode') storeCode: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireRole(req);
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.svc.listSales({
      storeCode,
      status,
      limit: limit ? Number(limit) : 20,
    });
  }

  /**
   * GET /pdv/nfces — lista NFC-es com filtros + agregados.
   * Query: storeCode (opcional, vazio = todas as lojas / visão geral),
   *        startDate, endDate (YYYY-MM-DD, default: hoje),
   *        status (authorized|cancelled|rejected|all),
   *        q (busca: número, CPF, nome),
   *        limit (default 100, max 500)
   */
  /**
   * GET /pdv/sales/:id/nfce/xml — XML da NFC-e dessa venda (só admin).
   *
   * Existe por causa do cStat 225 ("Falha no Schema XML"): a SEFAZ diz QUE
   * falhou, nunca ONDE. O XML assinado já era gravado em `nfceXml` na
   * rejeição, mas só dava pra ler indo no log do Railway — na prática,
   * ninguém lia, e cada 225 virava adivinhação. Agora sai num clique.
   */
  @Get('sales/:id/nfce/xml')
  async nfceXml(@Req() req: any, @Param('id') id: string) {
    // Admin OU a própria loja (bug 31/07: o MODO MASTER impersona a loja —
    // o token vira role 'store' — e o botão da tela de notas devolvia 403
    // "Apenas admin" justamente pra quem mais precisa dele). A loja só
    // enxerga venda DELA; o XML é a nota fiscal que ela mesma emitiu.
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store') throw new ForbiddenException('Apenas admin ou loja');
    const sale: any = await (this.prisma as any).pdvSale.findUnique({
      where: { id },
      select: {
        id: true, storeCode: true, total: true, nfceXml: true,
        nfceStatus: true, nfceMotivo: true, nfceNumber: true,
      },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (role === 'store' && String(req?.user?.storeCode || '') !== String(sale.storeCode || '')) {
      throw new ForbiddenException('Venda de outra loja');
    }
    if (!sale.nfceXml) {
      throw new BadRequestException('Essa venda não tem XML guardado (nota nunca chegou a ser assinada).');
    }
    return {
      saleId: sale.id, loja: sale.storeCode, total: sale.total,
      status: sale.nfceStatus, motivo: sale.nfceMotivo,
      numero: sale.nfceNumber, xml: sale.nfceXml,
    };
  }

  /**
   * GET /pdv/promo-check?codigo= — "essa peça entra na promoção?"
   * Consulta pura: não cria venda, não lança item, não mexe em estoque.
   */
  @Get('promo-check')
  promoCheck(@Query('codigo') codigo?: string) {
    return this.svc.consultarPromocao(String(codigo || ''));
  }

  @Get('nfces')
  async listNfces(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    // READ-ONLY: admin/store (requireRole) + 'franquias'/'master_franquia'.
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store' && role !== 'franquias' && role !== 'master_franquia') {
      throw new ForbiddenException('Apenas admin, loja ou administrador de franquias');
    }

    // ESCOPO POR PAPEL:
    //  - store      → SÓ a própria loja (ignora storeCode da query).
    //  - franquias/master_franquia → SÓ as lojas FILIAL (franqueadas).
    //  - admin/master → todas (ou filtra pelo storeCode escolhido).
    const userStoreCode = req?.user?.storeCode;
    let effectiveStoreCode = role === 'store' && userStoreCode ? userStoreCode : storeCode;
    let storeCodes: string[] | undefined;
    if (role === 'franquias' || role === 'master_franquia') {
      const franq = await (this.svc as any).prisma.store.findMany({
        where: { tipo: 'FILIAL', active: true },
        select: { code: true },
      });
      storeCodes = (franq as any[]).map((s) => s.code);
      effectiveStoreCode = undefined; // o conjunto de franquias prevalece
    }

    return this.svc.listNfces({
      storeCode: effectiveStoreCode,
      storeCodes,
      startDate,
      endDate,
      status,
      q,
      limit: limit ? Number(limit) : 100,
    });
  }

  /**
   * GET /pdv/sales/:id
   */
  @Get('sales/:id')
  getSale(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getSale(id);
  }

  /**
   * POST /pdv/sales/:id/master/cancel-zumbi
   * Body: { motivo, password }
   * Cancela uma venda finalizada SEM payment (zumbi). NAO mexe em estoque.
   * Exige senha master (nivel MASTER+).
   */
  @Post('sales/:id/master/cancel-zumbi')
  async masterCancelZumbi(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { motivo: string; password: string },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor' && role !== 'operator' && !this.ehPapelFranquia(role)) {
      throw new ForbiddenException('Apenas admin/supervisor/operator');
    }
    if (this.ehPapelFranquia(role)) await this.assertSaleEhFranquia(id);
    const nivel = validateMinLevel(body?.password, 'MASTER', await this.storeCodeCtx(id, req));
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterCancelZumbi({
      saleId: id,
      motivo: body?.motivo || '',
      userName: `[${nivel}] ${userName}`,
    });
  }

  /**
   * POST /pdv/sales/:id/master/estornar
   * Body: { motivo, password }
   *
   * ESTORNO COMPLETO — usado pelo botão "ESTORNAR" da tela
   * /retaguarda/faturamento (drill-down). Reverte tudo automaticamente:
   *   - Cancela NFC-e na SEFAZ
   *   - Devolve estoque ao Wincred
   *   - Revoga cashback do cliente
   *   - Marca sale como cancelled
   *
   * Exige senha master + motivo (>=5 chars).
   * Retorna relatório passo-a-passo do que conseguiu reverter.
   */
  @Post('sales/:id/master/estornar')
  async masterEstornar(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { motivo: string; password: string },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor' && role !== 'operator' && !this.ehPapelFranquia(role)) {
      throw new ForbiddenException('Apenas admin/supervisor/operator');
    }
    if (this.ehPapelFranquia(role)) await this.assertSaleEhFranquia(id);
    const nivel = validateMinLevel(body?.password, 'MASTER', await this.storeCodeCtx(id, req));
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterEstornarVenda({
      saleId: id,
      motivo: body?.motivo || '',
      userName: `[${nivel}] ${userName}`,
    });
  }

  /**
   * POST /pdv/sales/:id/master/cancel-duplicada
   * Body: { motivo, password }
   * Cancela QUALQUER venda finalizada (mesmo com pagamento) — caso da Hellen:
   * mesma venda batida 2x por engano antes de imprimir cupom fiscal.
   * Marca status=cancelled + cancelReason. NAO mexe em estoque (assume que era duplicata).
   * Exige senha master.
   */
  @Post('sales/:id/master/cancel-duplicada')
  async masterCancelDuplicada(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { motivo: string; password: string },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor' && role !== 'operator' && !this.ehPapelFranquia(role)) {
      throw new ForbiddenException('Apenas admin/supervisor/operator');
    }
    if (this.ehPapelFranquia(role)) await this.assertSaleEhFranquia(id);
    const nivel = validateMinLevel(body?.password, 'MASTER', await this.storeCodeCtx(id, req));
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterCancelDuplicada({
      saleId: id,
      motivo: body?.motivo || '',
      userName: `[${nivel}] ${userName}`,
    });
  }

  /**
   * POST /pdv/sales/:id/items { skuOrEan, qty? }
   */
  @Post('sales/:id/items')
  addItem(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { skuOrEan: string; qty?: number },
  ) {
    this.requireRole(req);
    return this.svc.addItem({
      saleId: id,
      skuOrEan: body?.skuOrEan,
      qty: body?.qty,
    });
  }

  /**
   * POST /pdv/sales/:id/recalcular-precos
   * Reconsulta o preço ATUAL (promoção vigente) de cada item e atualiza.
   * Usado quando itens puxados de MARCADO vêm com o preço original congelado.
   */
  @Post('sales/:id/recalcular-precos')
  recalcularPrecos(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.recalcularPrecos({ saleId: id });
  }

  /**
   * POST /pdv/sales/:id/items/manual { descricao, valor, qty? }
   * Adiciona item MANUAL — usado quando o produto não passa pelo bipe.
   * Vendedora digita descrição + valor livres pra não travar o caixa.
   */
  @Post('sales/:id/items/manual')
  addManualItem(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { descricao: string; valor: number; qty?: number },
  ) {
    this.requireRole(req);
    return this.svc.addManualItem({
      saleId: id,
      descricao: body?.descricao,
      valor: body?.valor,
      qty: body?.qty,
    });
  }

  /**
   * POST /pdv/sales/:id/frete { valor }
   * FRETE À PARTE (venda online) — linha própria na venda; valor 0 remove.
   */
  @Post('sales/:id/frete')
  setFrete(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { valor: number },
  ) {
    this.requireRole(req);
    return this.svc.setFrete(id, Number(body?.valor));
  }

  /**
   * POST /pdv/sales/:id/entrega { tipo, retiradaStoreCode? }
   * FORMA DE ENTREGA da venda online: sedex | pac | motoboy | retirada.
   * Vira o método do pedido online. `retiradaStoreCode` = ONDE a cliente
   * retira (só com tipo=retirada); vazio = na própria loja vendedora.
   */
  /**
   * POST /pdv/sales/:id/gerar-pedido-online — ADMIN.
   * Resgate: venda finalizada que ficou sem pedido ON- (ex.: link Pagar.me
   * fechado pelo cron como 'credito' antes de 17/08). Idempotente.
   */
  @Post('sales/:id/gerar-pedido-online')
  gerarPedidoOnline(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body?: {
      nome?: string; cep?: string; endereco?: string; numero?: string; complemento?: string;
      bairro?: string; cidade?: string; uf?: string; entregaTipo?: string;
    },
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    const quem = req?.user?.name ?? req?.user?.username ?? req?.user?.sub ?? 'admin';
    return this.svc.gerarPedidoOnlineDeVendaFinalizada(id, String(quem), body || undefined);
  }

  @Post('sales/:id/entrega')
  setEntrega(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { tipo: string; entregaStoreCode?: string | null; pecasNaMao?: boolean | null },
  ) {
    this.requireRole(req);
    return this.svc.setEntrega(
      id,
      String(body?.tipo ?? ''),
      body?.entregaStoreCode ?? null,
      // AS PEÇAS JÁ ESTÃO NA LOJA (26/08) — só motoboy da própria loja; o
      // serviço zera nos outros casos.
      typeof body?.pecasNaMao === 'boolean' ? body.pecasNaMao : null,
    );
  }

  /**
   * GET /pdv/sales/:id/lojas-entrega
   * QUEM ENTREGA: cada loja com o que ela cobre das peças desta venda, em
   * ordem de utilidade (cidade da cliente primeiro — motoboy é distância).
   * A tela do PDV pergunta isto ANTES de gravar a escolha de motoboy/retirada.
   */
  @Get('sales/:id/lojas-entrega')
  lojasParaEntrega(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.lojasParaEntrega(id);
  }

  /**
   * POST /pdv/sales/:id/gift-voucher { valor, compradorNome?, presenteadoNome? }
   * VALE PRESENTE: item manual na venda + crédito (trilho do vale-troca) que
   * ativa quando a venda finaliza. Código VP- sai impresso no cupom.
   */
  @Post('sales/:id/gift-voucher')
  addGiftVoucher(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { valor: number; compradorNome?: string; presenteadoNome?: string },
  ) {
    this.requireRole(req);
    return this.svc.addGiftVoucher({
      saleId: id,
      valor: body?.valor,
      compradorNome: body?.compradorNome,
      presenteadoNome: body?.presenteadoNome,
    });
  }

  /**
   * PATCH /pdv/sales/:id/items/:itemId { qty?, desconto? }
   * Atualiza qty e/ou desconto do item.
   */
  @Patch('sales/:id/items/:itemId')
  updateItem(
    @Req() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: { qty?: number; desconto?: number; password?: string; motivo?: string; excludePromo?: boolean; forcePromo?: boolean },
  ) {
    this.requireRole(req);
    return this.svc.updateItem({
      saleId: id,
      itemId,
      qty: body?.qty,
      desconto: body?.desconto,
      password: body?.password,
      motivo: body?.motivo,
      excludePromo: body?.excludePromo,
      forcePromo: body?.forcePromo,
    });
  }

  /**
   * PATCH /pdv/sales/:id/discount { desconto }
   * Aplica desconto na venda inteira (em R$, não percentual).
   */
  @Patch('sales/:id/discount')
  setDiscount(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { desconto: number; password?: string; motivo?: string },
  ) {
    this.requireRole(req);
    return this.svc.setSaleDiscount({
      saleId: id,
      desconto: body?.desconto || 0,
      password: body?.password,
      motivo: body?.motivo,
    });
  }

  /**
   * PATCH /pdv/sales/:id/promotion { promotion }
   * Define campanha promocional ATIVA (exclusiva).
   * Valores: 'YEAR_BASED' | 'FOUR_FOR_THREE' | 'NONE' | null
   */
  @Patch('sales/:id/promotion')
  setPromotion(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { promotion: string | null },
  ) {
    this.requireRole(req);
    return this.svc.setPromotion({ saleId: id, promotion: body?.promotion ?? null });
  }

  /**
   * DELETE /pdv/sales/:id/items/:itemId
   */
  @Delete('sales/:id/items/:itemId')
  removeItem(
    @Req() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    this.requireRole(req);
    return this.svc.removeItem({ saleId: id, itemId });
  }

  /**
   * PATCH /pdv/sales/:id/customer { cpf, name, email, phone }
   */
  @Patch('sales/:id/customer')
  setCustomer(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: {
      cpf?: string;
      name?: string;
      email?: string;
      phone?: string;
      // Endereço — opcional, mas essencial pra venda online (WhatsApp/Insta)
      cep?: string;
      endereco?: string;
      numero?: string;
      complemento?: string;
      bairro?: string;
      cidade?: string;
      uf?: string;
    },
  ) {
    this.requireRole(req);
    return this.svc.setCustomer({ saleId: id, ...body });
  }

  /**
   * POST /pdv/sales/:id/finalize { paymentMethod, paymentDetails? }
   */
  @Post('sales/:id/finalize')
  finalize(
    @Req() req: any,
    @Param('id') id: string,
    @Body()
    body: {
      paymentMethod: string;
      paymentDetails?: any;
      entregaTipo?: string | null;
      entregaStoreCode?: string | null;
      entregaPecasNaMao?: boolean | null;
    },
  ) {
    this.requireRole(req);
    return this.svc.finalize({
      saleId: id,
      paymentMethod: body?.paymentMethod,
      paymentDetails: body?.paymentDetails,
      // Entrega da venda online regravada no fechamento — a escolha na tela
      // é a verdade (o POST /entrega é otimista e pode nunca ter chegado).
      entregaTipo: body?.entregaTipo ?? null,
      entregaStoreCode: body?.entregaStoreCode ?? null,
      // `undefined` (body sem o campo) preserva a resposta já gravada; só
      // um booleano de verdade sobrescreve.
      entregaPecasNaMao:
        typeof body?.entregaPecasNaMao === 'boolean' ? body.entregaPecasNaMao : undefined,
      // Passa storeCode do JWT pra reconciliação automática quando a
      // venda foi criada com loja diferente do caixa atual.
      userStoreCode: req?.user?.storeCode,
      // TRAVA DE SEGURANÇA: se a SESSÃO está em treino (header), a venda é
      // tratada como treino MESMO que tenha sido criada antes de ligar o
      // modo (venda aberta reaproveitada ficava sem isTraining e executava
      // Wincred/estoque REAIS com o banner de treino na tela).
      trainingRequest: isTrainingRequest(req),
    });
  }

  /**
   * POST /pdv/sales/:id/payments { method, valor, details? }
   * Adiciona pagamento parcial à venda (split payment).
   */
  @Post('sales/:id/payments')
  addPayment(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { method: string; valor: number; details?: any },
  ) {
    this.requireRole(req);
    return this.svc.addPayment({
      saleId: id,
      method: body?.method,
      valor: body?.valor,
      details: body?.details,
    });
  }

  /**
   * PATCH /pdv/sales/:id/payments/:paymentId
   * Ajuste de pagamento (admin/supervisor).
   * Body: { method?, valor?, details?, reason }
   */
  @Patch('sales/:id/payments/:paymentId')
  async updatePayment(
    @Req() req: any,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() body: { method?: string; valor?: number; details?: any; reason?: string },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor') {
      throw new ForbiddenException('Apenas admin ou supervisor pode ajustar pagamento');
    }
    if (!body?.reason) {
      throw new BadRequestException('Razão obrigatória');
    }
    return this.svc.updatePayment({
      saleId: id,
      paymentId,
      method: body.method,
      valor: body.valor,
      details: body.details,
      reason: body.reason,
      changedByUserId: req?.user?.sub,
      changedByUserName: req?.user?.name,
      changedByRole: role,
    });
  }

  /**
   * GET /pdv/sales/:id/payments/audits — histórico de ajustes
   */
  @Get('sales/:id/payments/audits')
  async getPaymentAudits(
    @Req() req: any,
    @Param('id') id: string,
    @Query('paymentId') paymentId?: string,
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor') {
      throw new ForbiddenException('Apenas admin ou supervisor');
    }
    return this.svc.getPaymentAudits({ saleId: id, paymentId });
  }

  /**
   * DELETE /pdv/sales/:id/payments/:paymentId
   */
  @Delete('sales/:id/payments/:paymentId')
  removePayment(
    @Req() req: any,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
  ) {
    this.requireRole(req);
    return this.svc.removePayment({ saleId: id, paymentId });
  }

  /**
   * POST /pdv/sales/:id/pix-charge
   * Gera BR Code PIX (QR Code com valor cravado) pra pagamento.
   * Não chama API de banco — gera localmente. Cai direto na conta da chave.
   * Vendedora confirma manualmente após ver o pagamento no app do banco.
   */
  /**
   * POST /pdv/sales/:id/pix-charge
   * Gera cobrança PIX dinâmica via Pagar.me (Stone) — usa a integração já
   * configurada em /config/pagarme. Retorna QR Code + BR Code real.
   */
  @Post('sales/:id/pix-charge')
  async pixCharge(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    const sale = await this.svc.getSale(id);
    if (sale.status !== 'open')
      throw new BadRequestException(`Venda já está ${sale.status}`);
    if (sale.total <= 0) throw new BadRequestException('Total da venda deve ser > 0');

    // ── MODO TREINAMENTO ──
    // União: venda criada em treino OU sessão atual em treino (header).
    // NÃO cria cobrança real no Pagar.me — retorna cobrança FAKE claramente
    // marcada (payload não é um BR Code válido, nenhum banco aceita).
    if ((sale as any).isTraining || isTrainingRequest(req)) {
      this.logger.log(
        `[pix-charge→TREINO] cobrança simulada — skip pagarme.createPixCharge · ` +
        `saleId=${id} valor=R$${Number(sale.total).toFixed(2)}`,
      );
      return {
        txid: 'TREINO',
        valor: sale.total,
        qrCodeDataUrl: null,
        payload: 'TREINO-SEM-VALOR',
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        training: true,
      };
    }

    const r = await this.pagarme.createPixCharge({
      saleId: id,
      valor: sale.total,
      storeCode: sale.storeCode,
      storeName: sale.storeName,
      customerName: sale.customerName || undefined,
      customerCpf: sale.customerCpf || undefined,
      customerEmail: sale.customerEmail || undefined,
      customerPhone: sale.customerPhone || undefined,
    });

    // Mantém os mesmos nomes de campo que o frontend já espera
    // (qrCodeDataUrl + payload), pra não quebrar o modal.
    return {
      txid: r.pagarmeOrderId,
      valor: r.valor,
      qrCodeDataUrl: r.qrCodeImageUrl,
      payload: r.qrCodeText,
      expiresAt: r.expiresAt,
    };
  }

  /**
   * POST /pdv/sales/:id/cancel { reason? }
   */
  @Post('sales/:id/cancel')
  cancel(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    this.requireRole(req);
    return this.svc.cancel({ saleId: id, reason: body?.reason });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CREDIÁRIO — busca cliente + pendências, e gera N parcelas no Giga
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * GET /pdv/customer-info?cpf=12345678900[&storeCode=05]
   * Busca cliente no Giga pelo CPF + retorna pendências (parcelas em aberto).
   * Usado pelo PaymentModal aba crediário pra mostrar banner de inadimplência.
   * Não bloqueia venda — só avisa.
   *
   * ⚠️ ESCOPO POR LOJA (incidente Piracicaba 03/07): o CODIGO de cliente do
   * Wincred se REPETE entre lojas — cada loja tem sua numeração e seu
   * crediário. Buscar sem filtrar LOJA misturava clientes: pegava cadastro
   * de outra loja (LIMIT 1 arbitrário) e listava pendências de OUTRA pessoa
   * (mesmo código em loja diferente). Toda busca aqui filtra (LOJA, CPF/CODIGO).
   *
   * Ordem de busca (loja = da vendedora logada; admin pode passar ?storeCode=):
   *   1. CRM determinístico: Customer por CPF → CustomerGigaLink (loja+codigo)
   *      da loja → lookup por (LOJA, CODIGO). Cobre cadastro do Giga com CPF
   *      vazio/errado — caso comum de cadastro rápido no balcão.
   *   2. giga_clientes WHERE cpf normalizado = X AND LOJA
   *   3. giga_clientes WHERE codigo = X AND LOJA (se digitaram código)
   *   4. LIKE do CPF + LOJA (chars invisíveis) → telefone → nome (match único)
   *   5. Nada na loja? Procura o CPF SEM loja só pra AVISAR "cadastro é da
   *      loja YY" — não usa, porque crediário é por loja.
   *
   * ⚡ FONTE (Onda 1): 100% espelho Postgres `giga_clientes`
   * (SombraService.buscarClienteCustomerInfo). A cascata de 9 consultas no
   * MySQL do Giga foi removida — o Wincred morreu em 27/08 e o desvio só
   * produzia "Giga indisponível — tente de novo" pra uma fonte que nunca mais
   * responde. Erro do espelho SOBE; "não encontrado" é resposta do espelho.
   */
  @Get('customer-info')
  async getCustomerInfo(
    @Req() req: any,
    @Query('cpf') cpf: string,
    @Query('storeCode') storeCodeQ?: string,
    @Query('nome') nomeQ?: string,
    @Query('telefone') telefoneQ?: string,
  ) {
    this.requireRole(req);
    if (!cpf) {
      throw new BadRequestException('CPF ou código do cliente obrigatório');
    }
    const cleanCpf = cpf.replace(/\D/g, '');
    if (cleanCpf.length < 3) {
      throw new BadRequestException('Mínimo 3 dígitos');
    }
    // Nome/telefone da venda — fallback quando o cadastro do Wincred está SEM
    // CPF (cadastro rápido de balcão, caso Piracicaba 03/07). Mesma estratégia
    // do lookupClienteCode que grava a caixa: CPF → telefone → nome.
    const nomeBusca = String(nomeQ || '').trim().toUpperCase().replace(/['"\\;%_]/g, '').slice(0, 80);
    const telBusca = String(telefoneQ || '').replace(/\D/g, '');

    // Loja do escopo: vendedora usa SEMPRE a própria; admin pode escolher.
    const role = req?.user?.role;
    const lojaRaw = role === 'admin'
      ? (storeCodeQ || req?.user?.storeCode)
      : (req?.user?.storeCode || storeCodeQ);
    const loja = lojaRaw
      ? String(lojaRaw).replace(/\D/g, '').padStart(2, '0').slice(0, 2)
      : null;

    // ── ESPELHO POSTGRES `giga_clientes` — ÚNICO caminho (Onda 1) ─────────
    // O MySQL do Wincred morreu em 27/08: a cascata de até 9 consultas que
    // vivia aqui só produzia "Giga indisponível — tente de novo", ensinando a
    // vendedora a insistir contra uma fonte que nunca mais responde. O
    // SombraService procura no espelho NA MESMA ORDEM do caminho antigo
    // (CRM link → CPF → código → CPF LIKE → telefone → nome), com as mesmas
    // regras de ambiguidade. Erro do espelho SOBE (500 honesto) — "não
    // encontrado" é só quando o espelho respondeu e não achou.
    const doFlow = await this.sombra.buscarClienteCustomerInfo({
      cpf: cleanCpf,
      loja,
      nome: nomeBusca,
      telefone: telBusca,
    });
    if (doFlow) {
      return await this.montarCustomerInfo({
        codCliente: doFlow.codigo,
        nome: doFlow.nome,
        lojaCliente: doFlow.loja || loja,
        viaFallback: doFlow.viaFallback,
        raw: doFlow.raw,
        cleanCpf,
        loja,
      });
    }

    // Nada NESTA loja — procura o CPF nas outras lojas do espelho só pra dar
    // a mensagem certa ("cadastro é da loja YY"). NÃO usa o cadastro de outra
    // loja: o crediário é por loja e a numeração de código também (mesma
    // Tentativa 5 do caminho antigo, agora em giga_clientes).
    const safeCpf = cleanCpf.replace(/[^0-9]/g, '').slice(0, 14);
    if (loja && safeCpf.length >= 11) {
      try {
        const cpfFmt = safeCpf.length === 11
          ? `${safeCpf.slice(0, 3)}.${safeCpf.slice(3, 6)}.${safeCpf.slice(6, 9)}-${safeCpf.slice(9)}`
          : safeCpf;
        const outras: any[] = await (this.prisma as any).gigaCliente.findMany({
          where: {
            OR: [{ personKey: `cpf:${safeCpf}` }, { cpf: safeCpf }, { cpf: cpfFmt }],
            arquivadoEm: null,
          },
          select: { loja: true, codigo: true, nome: true },
          take: 5,
        });
        if (outras.length > 0) {
          const lojas = outras
            .map((row: any) => String(row.loja || '').trim())
            .filter(Boolean);
          console.log(`[customer-info] CPF ${safeCpf} tem cadastro nas lojas [${lojas.join(',')}] mas não na ${loja}`);
          return {
            found: false as const,
            outraLoja: {
              lojas,
              codCliente: String(outras[0].codigo || ''),
              nome: outras[0].nome ? String(outras[0].nome).trim() : null,
            },
            message:
              `Cliente tem cadastro na loja ${lojas.join(', ')}, mas NÃO na sua loja (${loja}). ` +
              `Crediário é separado por loja — cadastre o cliente NESTA loja antes de fechar.`,
          };
        }
      } catch (e: any) {
        // O aviso "cadastro é da loja YY" é best-effort: falhar aqui não pode
        // derrubar o customer-info (a vendedora ainda recebe a mensagem
        // genérica). Mas SEM LOG o aviso sumia sem deixar rastro — e a
        // vendedora cadastrava de novo uma cliente que já existe em outra loja.
        this.logger.warn(
          `[customer-info] consulta de cadastro em outras lojas falhou (cpf=${safeCpf}, loja=${loja}): ${e?.message || e}`,
        );
      }
    }

    console.log(
      `[customer-info] NÃO ACHOU no espelho: cpfBusca=${safeCpf} ` +
      `nome="${nomeBusca}" tel=${telBusca || '—'} loja=${loja || 'todas'}`,
    );
    return {
      found: false as const,
      message: `Cliente não encontrado${loja ? ` (loja ${loja})` : ''} — cadastre o cliente antes de fazer crediário`,
    };
  }

  /**
   * Cauda COMPARTILHADA do customer-info: pendências + shape da resposta.
   *
   * Os DOIS caminhos (Giga ao vivo e espelho Postgres) passam por aqui de
   * propósito — o PaymentModal do PDV consome este shape e não pode existir
   * uma segunda versão dele que saia de sincronia. Quem muda entre os
   * caminhos é só DE ONDE vieram codCliente/nome/loja/raw.
   */
  private async montarCustomerInfo(input: {
    codCliente: string;
    nome: string | null;
    lojaCliente: string | null;
    viaFallback: 'telefone' | 'nome' | null;
    raw: any;
    cleanCpf: string;
    loja: string | null;
  }) {
    const { codCliente, nome, lojaCliente, viaFallback, raw, cleanCpf, loja } = input;

    // Lista pendências (parcelas em aberto) — ESCOPADAS pela loja do cadastro.
    // Sem o filtro, o mesmo código em outra loja é OUTRA pessoa e as parcelas
    // dela apareciam aqui (mistura de crediário entre lojas).
    let pendencias: any[] = [];
    let totalDevido = 0;
    let totalAtraso = 0;
    try {
      pendencias = await this.crediarioBaixa.listOpenInstallmentsByCustomer({
        busca: codCliente,
        storeCode: lojaCliente || loja || undefined,
      });
      totalDevido = pendencias.reduce((s, p) => s + (p.valorParcela || 0), 0);
      totalAtraso = pendencias.filter((p) => p.diasAtraso > 0).reduce((s, p) => s + (p.valorParcela || 0), 0);
    } catch (e: any) {
      // Se falhar a busca de pendências, ainda retorna o cliente
      console.warn('[pdv/customer-info] erro ao listar pendências:', e?.message);
    }

    return {
      // `as const`: `found` é o DISCRIMINANTE da união de retorno do endpoint —
      // sem o literal, o TS alarga pra boolean e o `if (!info.found ||
      // !info.cliente)` de quem chama internamente para de estreitar.
      found: true as const,
      cliente: {
        codCliente,
        nome,
        cpf: cleanCpf,
        loja: lojaCliente || null,
        // 'telefone' | 'nome' quando o cadastro foi achado SEM bater o CPF
        // (Wincred com CPF vazio/errado) — a tela avisa pra completar depois.
        viaFallback,
        raw,
      },
      pendencias: pendencias.map((p) => ({
        registro: p.registro,
        controle: p.controle,
        parcela: p.parcela,
        totalParcelas: p.totalParcelas,
        vencimento: p.vencimento,
        valor: p.valorParcela,
        diasAtraso: p.diasAtraso,
      })),
      totalDevido: Math.round(totalDevido * 100) / 100,
      totalAtraso: Math.round(totalAtraso * 100) / 100,
      qtdPendencias: pendencias.length,
      qtdAtrasadas: pendencias.filter((p) => p.diasAtraso > 0).length,
    };
  }

  /**
   * GET /pdv/customer-search?q=texto&limit=20
   *
   * SEARCH HÍBRIDO — busca PRIMEIRO no Customer (CRM FlowOps), depois cai
   * pro Giga se ainda houver slots livres no limit.
   *
   * Cada resultado tem `source: 'crm' | 'giga'` pra UI decidir o que mostrar.
   * Clientes CRM trazem dados ricos: tier VIP, cashback, tamanho preferido,
   * última compra. Clientes Giga trazem só o cadastro básico.
   *
   * Busca por:
   *  - CPF (se q tiver só dígitos)
   *  - codCliente (Giga)
   *  - Nome (LIKE %q%)
   *
   * Dedup: se o mesmo CPF aparece nos 2 (CRM + Giga), CRM ganha.
   */
  @Get('customer-search')
  async searchCustomers(
    @Req() req: any,
    @Query('q') q: string,
    @Query('limit') limitStr?: string,
    @Query('loja') loja?: string,
  ) {
    this.requireRole(req);
    // ESCOPO POR LOJA (23/07): cadastros do Giga são POR LOJA (RESERVAS,
    // DEFEITOS etc existem em todas) — o PDV só vê as fichas da PRÓPRIA
    // loja. Clientes do CRM (pessoas com CPF, site/live) seguem da rede.
    const lojaScope = String(loja || req?.user?.storeCode || '').replace(/\D/g, '');
    const term = String(q || '').trim();
    if (term.length < 2) {
      return { results: [] };
    }
    const limit = Math.min(Math.max(Number(limitStr) || 20, 1), 50);

    const onlyDigits = term.replace(/\D/g, '');
    const isNumeric = onlyDigits.length >= 3 && /^\d+$/.test(term.replace(/[\s.\-]/g, ''));

    // ─── 1. BUSCA NO CRM (Customer Prisma) ─────────────────────────────────
    type SearchResult = {
      source: 'crm' | 'giga';
      codCliente: string;
      nome: string;
      cpf: string;
      cidade: string;
      telefone: string;
      // Campos extras do CRM (undefined pra Giga)
      customerId?: string;
      vipTier?: string;
      cashbackBalanceCents?: number;
      orderCount?: number;
      ltvCents?: number;
      lastOrderAt?: string | null;
      sizeDefault?: string | null;
      registroGiga?: number | null;
    };
    const results: SearchResult[] = [];
    const cpfsVistos = new Set<string>(); // dedup CPF entre CRM e Giga

    try {
      const crmWhere: any = { active: true, OR: [] as any[] };
      if (isNumeric) {
        // Busca por CPF (normalizado e formatado)
        const cpfFmt = onlyDigits.length === 11
          ? `${onlyDigits.slice(0, 3)}.${onlyDigits.slice(3, 6)}.${onlyDigits.slice(6, 9)}-${onlyDigits.slice(9)}`
          : '';
        crmWhere.OR.push({ cpf: { startsWith: onlyDigits } });
        if (cpfFmt) crmWhere.OR.push({ cpf: cpfFmt });
        // Por whatsapp também (últimos dígitos)
        if (onlyDigits.length >= 8) {
          crmWhere.OR.push({ whatsapp: { endsWith: onlyDigits.slice(-8) } });
          crmWhere.OR.push({ phone: { endsWith: onlyDigits.slice(-8) } });
        }
        // Por registroGiga (codCliente)
        if (onlyDigits.length <= 10) {
          const n = Number(onlyDigits);
          if (Number.isFinite(n)) crmWhere.OR.push({ registroGiga: n });
        }
      } else {
        // Busca por nome (case-insensitive)
        crmWhere.OR.push({ name: { contains: term, mode: 'insensitive' } });
        crmWhere.OR.push({ nameSocial: { contains: term, mode: 'insensitive' } });
      }
      if (crmWhere.OR.length > 0) {
        const crmCustomers = await (this.svc as any).prisma.customer.findMany({
          where: crmWhere,
          take: limit,
          orderBy: { name: 'asc' },
          select: {
            id: true, name: true, nameSocial: true, cpf: true, whatsapp: true,
            phone: true, vipTier: true, registroGiga: true,
            orderCount: true, ltvCents: true, lastOrderAt: true,
            sizeDefault: true,
            cashbackBalance: { select: { balanceCents: true } },
            originStore: { select: { code: true, name: true } },
          },
        });

        for (const c of crmCustomers as any[]) {
          const cpfNum = String(c.cpf || '').replace(/\D/g, '');
          if (cpfNum && cpfsVistos.has(cpfNum)) continue;
          if (cpfNum) cpfsVistos.add(cpfNum);
          results.push({
            source: 'crm',
            customerId: c.id,
            codCliente: c.registroGiga ? String(c.registroGiga) : '',
            nome: c.nameSocial || c.name || '',
            cpf: cpfNum,
            cidade: c.originStore?.name || '',
            telefone: String(c.whatsapp || c.phone || '').replace(/\D/g, ''),
            vipTier: c.vipTier || 'bronze',
            cashbackBalanceCents: c.cashbackBalance?.balanceCents || 0,
            orderCount: c.orderCount || 0,
            ltvCents: Number(c.ltvCents || 0),
            lastOrderAt: c.lastOrderAt ? c.lastOrderAt.toISOString() : null,
            sizeDefault: c.sizeDefault || null,
            registroGiga: c.registroGiga,
          });
        }
      }
    } catch (e: any) {
      console.warn('[customer-search] CRM falhou:', e?.message);
    }

    /**
     * ─── 2. SE AINDA HÁ SLOTS, BUSCA NO ESPELHO (Postgres) ────────────────
     *
     * ANTES ISTO IA AO GIGA AO VIVO, E ERA A LENTIDÃO DA TELA (11/08/2026).
     *
     * O ERP legado saiu em 02/08. A chamada continuou aqui com
     * `timeoutMs: 8000` — e o pool do Giga PENDURA em vez de dar erro, então
     * cada busca de cliente esperava os 8 segundos inteiros antes de desistir
     * e mostrar o resultado que o CRM já tinha em 14ms.
     *
     * É a assinatura do problema: não era "meio lento", era rápido OU oito
     * segundos. E como a busca dispara a cada tecla (debounce), as consultas
     * empilhavam — a vendedora com a cliente na frente, olhando o campo
     * parado.
     *
     * Agora lê `giga_clientes`, o espelho que já existe no Postgres (7.492
     * cadastros) e que o resto do PDV usa desde a saída do Giga. Zero MySQL no
     * caminho de quem está vendendo.
     *
     * De quebra a busca ficou ACENTO-INSENSÍVEL: no Giga os nomes estão em
     * maiúsculas com acento ("JÉSSICA"), e digitar "jessica" não achava nada.
     * `translate()` é função nativa do Postgres — não depende da extensão
     * `unaccent`, que pode não estar instalada.
     */
    const restante = limit - results.length;
    if (restante > 0) {
      try {
        const semAcento = (v: string) =>
          String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const ALVO = `translate(lower(nome), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')`;

        const cond: string[] = [];
        const params: any[] = [];
        if (isNumeric) {
          params.push(`${onlyDigits}%`);
          cond.push(`regexp_replace(coalesce(cpf,''), '[^0-9]', '', 'g') LIKE $${params.length}`);
          params.push(onlyDigits);
          cond.push(`codigo = $${params.length}`);
        }
        params.push(`%${semAcento(term)}%`);
        cond.push(`${ALVO} LIKE $${params.length}`);

        // Escopo por loja: cadastro do Giga é POR LOJA (o mesmo CPF tem ficha
        // em várias). CAST dos dois lados porque o padding é inconsistente
        // ('1' × '01') — mesma pegadinha de sempre.
        let filtroLoja = '';
        if (lojaScope) {
          params.push(Number(lojaScope));
          filtroLoja = ` AND CAST(NULLIF(regexp_replace(coalesce(loja,''),'[^0-9]','','g'),'') AS INTEGER) = $${params.length}`;
        }
        params.push(restante * 2);

        const linhas: any[] = await (this.svc as any).prisma.$queryRawUnsafe(
          `SELECT codigo, nome, cpf, cidade, fone_cel, fone_res
             FROM giga_clientes
            WHERE (${cond.join(' OR ')})${filtroLoja}
            ORDER BY nome ASC
            LIMIT $${params.length}`,
          ...params,
        );

        for (const row of linhas) {
          const cpfNum = String(row.cpf ?? '').replace(/\D/g, '').trim();
          // Dedup: pula se esse CPF já veio do CRM
          if (cpfNum && cpfsVistos.has(cpfNum)) continue;
          if (cpfNum) cpfsVistos.add(cpfNum);
          results.push({
            source: 'giga',
            codCliente: String(row.codigo ?? '').trim(),
            nome: String(row.nome ?? '').trim(),
            cpf: cpfNum,
            cidade: String(row.cidade ?? '').trim(),
            telefone: String(row.fone_cel || row.fone_res || '').replace(/\D/g, '').trim(),
          });
          if (results.length >= limit) break;
        }
      } catch (e: any) {
        // Nunca derruba a busca: o CRM já respondeu, e meia lista é melhor
        // que nenhuma pra quem está com a cliente na frente.
        console.warn('[customer-search] espelho falhou:', e?.message);
      }
    }

    // ── RELEVÂNCIA ANTES DE ALFABETO (01/08/2026) ────────────────────────
    // A consulta ordenava por nome A-Z. Buscar "celio da silva" devolvia
    // ARACELI, Ayara, Beatriz e BIANCA antes do CELIO — quem a vendedora
    // procurava ficava em QUINTO, fora da primeira olhada. Numa tela de
    // identificação isso não é só incômodo: ela clica no primeiro e a venda
    // sai no nome de outra pessoa.
    //
    // Ordem: CPF exato > nome exato > nome que COMEÇA com o termo > contém >
    // resto. Empate desempata por quem tem CPF (dá pra fazer crediário e nota)
    // e depois por quem já comprou mais — cliente antiga é o palpite melhor
    // que uma homônima sem histórico.
    const termoNorm = term.toLowerCase().trim();
    const digitos = onlyDigits;
    const peso = (r: any): number => {
      const nome = String(r?.nome || '').toLowerCase().trim();
      const cpfR = String(r?.cpf || '').replace(/\D/g, '');
      if (digitos.length === 11 && cpfR === digitos) return 0;
      if (nome === termoNorm) return 1;
      if (nome.startsWith(termoNorm)) return 2;
      if (nome.includes(termoNorm)) return 3;
      return 4;
    };
    const ordenados = results.slice().sort((a: any, b: any) => {
      const d = peso(a) - peso(b);
      if (d !== 0) return d;
      const temCpf = (x: any) => (String(x?.cpf || '').replace(/\D/g, '').length === 11 ? 0 : 1);
      const c = temCpf(a) - temCpf(b);
      if (c !== 0) return c;
      return (Number(b?.orderCount) || 0) - (Number(a?.orderCount) || 0);
    });

    /**
     * ─── A MESMA PESSOA CINCO VEZES NA TELA (11/08/2026) ──────────────────
     *
     * Buscar "thiago de oliveira" devolvia CINCO linhas idênticas. Conferido
     * no banco: era a mesma pessoa, com uma ficha por LOJA onde tinha
     * cadastro — a importação do Giga criou todas SEM CPF, e só a do PDV
     * ficou com CPF.
     *
     * A deduplicação acima só enxerga CPF (`cpfsVistos`). Com 74% da base sem
     * CPF, ela não tinha o que comparar: quatro das cinco passavam batidas.
     *
     * Aqui, quando o MESMO nome aparece com e sem CPF, ficam só as com CPF —
     * é a mesma pessoa, e a ficha identificada é a única que serve pra
     * crediário, nota e cashback. Escolher a errada não é só confuso: é venda
     * que sai sem CPF e cliente que não acumula.
     *
     * ⚠️ O RISCO, ASSUMIDO CONSCIENTEMENTE: duas pessoas DIFERENTES com o
     * nome exatamente igual, uma com CPF e outra sem — a sem CPF some da
     * lista. A base tem 942 nomes repetidos, então isso acontece. Aceitei
     * porque a alternativa (cinco linhas iguais) faz a vendedora escolher no
     * chute todo dia, e porque some só quando existe uma homônima JÁ
     * IDENTIFICADA — caso em que a de CPF é o palpite melhor.
     *
     * Quando NENHUMA do grupo tem CPF, todas ficam: aí não há como saber, e
     * esconder seria pior.
     *
     * A correção de verdade é a base ter CPF (backfill do WooCommerce + fila
     * de revisão de identidade). Isto é o remendo que segura a tela até lá.
     */
    const chaveNome = (r: any) =>
      String(r?.nome || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const temCpfValido = (r: any) => String(r?.cpf || '').replace(/\D/g, '').length === 11;
    const nomesComCpf = new Set(ordenados.filter(temCpfValido).map(chaveNome));
    const semDuplicatas = ordenados.filter(
      (r: any) => temCpfValido(r) || !nomesComCpf.has(chaveNome(r)),
    );

    return { results: semDuplicatas.slice(0, limit) };
  }

  /**
   * POST /pdv/customer/upsert
   *
   * UPSERT inteligente do cliente capturado no PDV — verifica se CPF já
   * existe e:
   *   - JÁ EXISTE: faz MERGE não-destrutivo (só preenche campos null) e
   *                retorna o cliente existente com flag duplicated=true.
   *                Frontend mostra "Cliente já cadastrado" e identifica.
   *   - NÃO EXISTE: cria novo Customer com originSource='pdv' + storeCode
   *                 da venda. Marca created=true.
   *
   * Campos básicos capturados no PDV (todos opcionais exceto cpf):
   *   - cpf       (obrigatório — chave de dedupe)
   *   - name      (nome completo)
   *   - whatsapp  (com DDD)
   *   - email
   *   - storeCode (loja origem; vem do JWT da vendedora)
   *
   * NÃO faz nada com tier/cashback/sizeDefault — esses são preenchidos
   * depois via tela CRM completo ou comprovação de cashback no checkout.
   *
   * Body: { cpf, name?, whatsapp?, email?, storeCode? }
   */
  @Post('customer/upsert')
  async upsertCustomer(
    @Req() req: any,
    @Body() body: { cpf: string; name?: string; whatsapp?: string; email?: string; storeCode?: string },
  ) {
    this.requireRole(req);

    const cpfDigits = String(body?.cpf || '').replace(/\D/g, '');
    if (cpfDigits.length !== 11) {
      throw new BadRequestException('CPF inválido — precisa de 11 dígitos');
    }
    const cpfFmt = `${cpfDigits.slice(0, 3)}.${cpfDigits.slice(3, 6)}.${cpfDigits.slice(6, 9)}-${cpfDigits.slice(9)}`;

    const name = String(body?.name || '').trim();
    const whatsapp = String(body?.whatsapp || '').replace(/\D/g, '') || null;
    const email = String(body?.email || '').trim().toLowerCase() || null;
    // Loja: prioriza JWT da vendedora; cai pro storeCode do body se admin
    const userRole = req?.user?.role;
    const userStoreCode = req?.user?.storeCode;
    const storeCode = userRole === 'store' && userStoreCode ? userStoreCode : (body?.storeCode || userStoreCode);

    // 1) Busca cliente existente por CPF (formatado OU dígitos)
    //    Regra (jun/2026): mesma pessoa pode ter cadastro em N lojas.
    //    Prioriza Customer DA LOJA ATUAL do PDV; se não tem, qualquer um.
    const prisma = (this.svc as any).prisma;
    const storeIdResolved = userRole === 'store' ? req?.user?.storeId : null;
    let existing: any = null;
    if (storeIdResolved) {
      existing = await prisma.customer.findFirst({
        where: {
          AND: [
            { OR: [{ cpf: cpfDigits }, { cpf: cpfFmt }] },
            { originStoreId: storeIdResolved },
          ],
        },
        select: {
          id: true, name: true, whatsapp: true, phone: true, email: true,
          vipTier: true, registroGiga: true, originSource: true, originStoreId: true,
          cashbackBalance: { select: { balanceCents: true } },
        },
      });
    }
    if (!existing) {
      existing = await prisma.customer.findFirst({
        where: { OR: [{ cpf: cpfDigits }, { cpf: cpfFmt }] },
        select: {
          id: true, name: true, whatsapp: true, phone: true, email: true,
          vipTier: true, registroGiga: true, originSource: true, originStoreId: true,
          cashbackBalance: { select: { balanceCents: true } },
        },
      });
    }

    // 2) JÁ EXISTE — merge não-destrutivo
    if (existing) {
      const updates: any = {};
      if (name && !existing.name) updates.name = name.toUpperCase();
      if (whatsapp && !existing.whatsapp) updates.whatsapp = whatsapp;
      if (email && !existing.email) updates.email = email;

      if (Object.keys(updates).length > 0) {
        await prisma.customer.update({ where: { id: existing.id }, data: updates });
      }

      return {
        customerId: existing.id,
        duplicated: true,
        created: false,
        merged: Object.keys(updates).length > 0,
        mergedFields: Object.keys(updates),
        cliente: {
          id: existing.id,
          name: updates.name || existing.name,
          cpf: cpfFmt,
          whatsapp: updates.whatsapp || existing.whatsapp,
          email: updates.email || existing.email,
          vipTier: existing.vipTier,
          cashbackBalanceCents: existing.cashbackBalance?.balanceCents || 0,
        },
      };
    }

    // 3) NÃO EXISTE — cria novo com originSource='pdv'
    let originStoreId: string | null = null;
    if (storeCode) {
      const store = await prisma.store.findUnique({ where: { code: storeCode } });
      if (store) originStoreId = store.id;
    }

    const created = await prisma.customer.create({
      data: {
        cpf: cpfFmt,
        name: name ? name.toUpperCase() : null,
        whatsapp,
        email,
        originSource: 'pdv',
        originStoreId,
        vipTier: 'bronze',
        active: true,
        cashbackBalance: { create: {} },
      },
      select: {
        id: true, name: true, whatsapp: true, email: true, vipTier: true,
        cashbackBalance: { select: { balanceCents: true } },
      },
    });

    return {
      customerId: created.id,
      duplicated: false,
      created: true,
      cliente: {
        id: created.id,
        name: created.name,
        cpf: cpfFmt,
        whatsapp: created.whatsapp,
        email: created.email,
        vipTier: created.vipTier,
        cashbackBalanceCents: created.cashbackBalance?.balanceCents || 0,
      },
    };
  }

  /**
   * GET /pdv/funcionarios-search?q=texto&limit=20
   * Busca funcionária (vendedora) no ESPELHO Postgres `wincred_funcionarios`
   * (Onda 1 — o MySQL do Giga morreu em 27/08; a sondagem de tabela
   * getTableSchema + runReadOnly que vivia aqui só devolvia lista vazia).
   * Usado pelo modal de identificação no início da venda. Shape preservado:
   * { table, lojaFiltered, results: [{ codigo, nome, apelido, loja }] }.
   */
  @Get('funcionarios-search')
  async searchFuncionarios(
    @Req() req: any,
    @Query('q') q: string,
    @Query('loja') loja?: string,
    @Query('limit') limitStr?: string,
  ) {
    this.requireRole(req);
    const term = String(q || '').trim();
    const limit = Math.min(Math.max(Number(limitStr) || 20, 1), 50);
    const lojaCode = String(loja || '').trim();

    const table = 'wincred_funcionarios';
    // Tira aspas e curingas de LIKE do termo (mesma faxina do caminho antigo).
    const safeText = term.replace(/['"\\;%_]/g, '').slice(0, 80);
    const safeLoja = lojaCode.replace(/[^0-9A-Za-z]/g, '').slice(0, 10);

    // Acento-insensível SEM depender da extensão `unaccent` (mesmo padrão do
    // customer-search): translate() é função nativa do Postgres, e no espelho
    // os nomes estão em maiúsculas COM acento ("JÉSSICA") — digitar "jessica"
    // tem que achar.
    const semAcento = (v: string) =>
      String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const ALVO = `translate(lower(coalesce(nome,'')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')`;

    // Monta WHERE combinando filtro de nome + filtro de loja (parametrizado).
    // Inativa fora do popup: quem saiu não vende (FLAG_INATIVO veio no espelho).
    const wheres: string[] = ['inativo = false'];
    const params: any[] = [];
    if (safeText.length >= 2) {
      params.push(`%${semAcento(safeText)}%`);
      wheres.push(`${ALVO} LIKE $${params.length}`);
    }
    if (safeLoja) {
      // Loja com e sem zero à esquerda ('1' × '01') — o padding do Wincred é
      // inconsistente, mesma tolerância dos outros paths do espelho.
      const lojaSet = Array.from(new Set([
        safeLoja.toUpperCase(),
        ...(/^\d{1,2}$/.test(safeLoja)
          ? [safeLoja.padStart(2, '0'), safeLoja.replace(/^0+/, '') || safeLoja]
          : []),
      ]));
      const ph = lojaSet.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      wheres.push(`upper(trim(coalesce(loja,''))) IN (${ph.join(', ')})`);
    }
    params.push(limit);

    const rows: any[] = await (this.prisma as any).$queryRawUnsafe(
      `SELECT codigo, nome, apelido, loja
         FROM wincred_funcionarios
        WHERE ${wheres.join(' AND ')}
        ORDER BY nome ASC
        LIMIT $${params.length}`,
      ...params,
    );

    // APELIDO (22/07): loja SEM whitelist configurada cai neste fallback e o
    // popup não via o apelido do cadastro. Casa pelo código do Wincred e, na
    // falta dele na ficha, pelo NOME (os dois vêm da mesma tabela do Giga).
    const normCod = (s: any) => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '') || '0';
    const normNome = (s: any) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    let apelidoPorCodigo = new Map<string, string>();
    let apelidoPorNome = new Map<string, string>();
    try {
      const sellers: any[] = await (this.prisma as any).seller.findMany({
        where: { apelido: { not: null } },
        select: { wincredCodigo: true, name: true, apelido: true },
      });
      apelidoPorCodigo = new Map(
        sellers.filter((s) => s.wincredCodigo).map((s) => [normCod(s.wincredCodigo), s.apelido]),
      );
      apelidoPorNome = new Map(sellers.map((s) => [normNome(s.name), s.apelido]));
    } catch { /* segue sem apelido */ }

    return {
      table,
      lojaFiltered: !!safeLoja,
      results: rows.map((r) => {
        const codigo = String(r.codigo ?? '').trim();
        const nome = String(r.nome ?? '').trim();
        return {
          codigo,
          nome,
          // Seller curado primeiro; na falta, o APELIDO do próprio espelho
          // (mesma fonte que o caminho da whitelist já mostra).
          apelido:
            apelidoPorCodigo.get(normCod(codigo)) ||
            apelidoPorNome.get(normNome(nome)) ||
            (r.apelido ? String(r.apelido).trim() : null) ||
            null,
          loja: r.loja !== undefined ? String(r.loja ?? '').trim() : '',
        };
      }).filter((r) => r.nome),
    };
  }

  /**
   * PATCH /pdv/sales/:id/vendedora — atribui vendedora à venda.
   * Aceita codigo+nome direto do Giga (sem precisar do Seller cadastrado no Postgres).
   *
   * ACEITA VENDA JÁ FINALIZADA (10/08). A vendedora é escolhida no popup de
   * ENCERRAMENTO, então quando o reconciliador de PIX fecha a venda sozinho
   * (cron de 30s que viu o PagBank pago antes da tela confirmar) a venda
   * nasce SEM vendedora — e o popup tomava "Venda já fechada", deixando a
   * comissão órfã sem ninguém pra corrigir. Atribuir vendedora não mexe em
   * dinheiro, estoque nem fiscal: é correção de dado. Só venda CANCELADA
   * continua bloqueada (não existe comissão de venda que não aconteceu).
   */
  @Patch('sales/:id/vendedora')
  async setVendedora(
    @Req() req: any,
    @Param('id') saleId: string,
    @Body() body: { codigo?: string; nome: string },
  ) {
    this.requireRole(req);
    if (!body?.nome) throw new BadRequestException('Nome da vendedora obrigatório');
    const sale = await (this.svc as any).prisma.pdvSale.findUnique({ where: { id: saleId } });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status === 'cancelled') {
      throw new BadRequestException('Venda cancelada — não dá pra atribuir vendedora');
    }
    if (sale.status === 'finalized' && sale.sellerName) {
      /**
       * REENVIAR A MESMA VENDEDORA NÃO É TROCA (24/08/2026).
       *
       * Caso do print de 16:40: a vendedora escolheu KARINE, o pagamento caiu,
       * o reconciliador fechou a venda — e o popup de confirmação abriu de
       * novo, já pré-selecionado em KARINE. Clicar em FINALIZAR VENDA mandava
       * a MESMA pessoa e voltava "Algo deu errado: troca de vendedora é pela
       * retaguarda", com a venda perfeita por trás do erro vermelho.
       *
       * Mandar quem já está gravada é operação NENHUMA. Devolve a venda como
       * está e deixa a tela seguir pro cupom.
       */
      const mesmaPessoa =
        sale.sellerName.trim().toLowerCase() === String(body.nome || '').trim().toLowerCase();
      if (mesmaPessoa) return sale;
      // Outra pessoa: trocar a vendedora de uma venda fechada é ajuste de
      // comissão e passa pela retaguarda, não pelo popup do PDV.
      throw new BadRequestException(
        `Venda já finalizada com a vendedora ${sale.sellerName} — troca de vendedora é pela retaguarda.`,
      );
    }

    return (this.svc as any).prisma.pdvSale.update({
      where: { id: saleId },
      data: {
        sellerName: body.nome.trim(),
        // Guarda o código do Giga em sellerId (string livre — não é FK física aqui)
        sellerId: body.codigo?.trim() || null,
      },
    });
  }

  /**
   * POST /pdv/sales/:id/crediario
   * Gera N parcelas no Giga (tabela movimento) pra uma venda do PDV.
   *
   * Recebe:
   *   - parcelas: número (1-24)
   *   - primeiroVencimento: 'YYYY-MM-DD'
   *   - entrada (opcional): valor descontado do total antes de dividir
   *   - observacao (opcional): texto livre
   *
   * Pré-condições: venda OPEN com customerCpf preenchido.
   * O cliente DEVE existir no Giga (use /pdv/customer-info pra validar antes).
   */
  @Post('sales/:id/crediario')
  async createCrediario(
    @Req() req: any,
    @Param('id') saleId: string,
    @Body() body: {
      parcelas: number;
      primeiroVencimento: string; // 'YYYY-MM-DD'
      entrada?: number;
      observacao?: string;
      // Senha de supervisor pra liberar venda acima do limite de crédito
      // (só usada quando a política de limite está ligada e o cliente excede).
      overridePassword?: string;
    },
  ) {
    this.requireRole(req);
    const sale = await this.svc.getSale(saleId);

    // ── IDEMPOTÊNCIA ──
    // Se a venda JÁ teve parcelas criadas no Giga, NÃO recria. O frontend chama
    // este endpoint em 2 fluxos (split e finalize) e retry de rede / duplo-clique
    // gerava parcelas duplicadas no movimento. Retorna sucesso com o controle já
    // gravado — idempotente.
    if ((sale as any).crediarioControle) {
      this.logger.warn(
        `[crediario] IDEMPOTENTE — venda ${saleId} já tem controle=${(sale as any).crediarioControle}, ignorando recriação`,
      );
      return {
        ok: true,
        idempotent: true,
        controle: (sale as any).crediarioControle,
        criadoEm: (sale as any).crediarioCriadoEm || null,
      };
    }

    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');
    if (!sale.customerCpf) throw new BadRequestException('Cliente sem CPF — identifique antes');
    if (!body?.parcelas || body.parcelas < 1 || body.parcelas > 24) {
      throw new BadRequestException('Parcelas deve estar entre 1 e 24');
    }
    if (!body?.primeiroVencimento || !/^\d{4}-\d{2}-\d{2}$/.test(body.primeiroVencimento)) {
      throw new BadRequestException('primeiroVencimento inválido (formato YYYY-MM-DD)');
    }
    const entrada = Math.max(0, Math.round((body.entrada || 0) * 100) / 100);
    // FIX CRITICO (jun/2026): desconta TAMBEM pagamentos ja registrados na venda
    // (PIX, dinheiro, cartao). Antes: sale.total - entrada (ignorava PIX em split misto)
    // Caso real: venda 2968, PIX 1068, crediario virava 2968/6=494 ao inves de 1900/6=316
    // FIX: exclui 'crediario' do soma pra nao contar o proprio payment que o frontend criou ANTES de chamar este endpoint.
    const jaPago = Math.round((await this.svc.sumPaidValue(saleId, ['crediario'])) * 100) / 100;
    const valorFinanciado = Math.round((sale.total - entrada - jaPago) * 100) / 100;
    if (valorFinanciado <= 0) {
      throw new BadRequestException(
        'Crediario invalido: total=' + sale.total.toFixed(2) +
        ' entrada=' + entrada.toFixed(2) +
        ' jaPago=' + jaPago.toFixed(2) +
        ' financiado=' + valorFinanciado.toFixed(2) +
        '. Venda ja esta toda paga?'
      );
    }
    this.logger.log(
      '[crediario] saleId=' + saleId + ' total=' + sale.total + ' entrada=' + entrada + ' jaPago=' + jaPago + ' -> financiado=' + valorFinanciado + ' em ' + body.parcelas + 'x'
    );

    // ── MODO TREINAMENTO ──
    // União: venda criada em treino OU sessão atual em treino (header).
    // NÃO consulta/grava parcelas no Giga (movimento) — retorna sucesso
    // simulado com o mesmo shape do fluxo normal.
    if ((sale as any).isTraining || isTrainingRequest(req)) {
      this.logger.log(
        `[crediario→TREINO] parcelas simuladas — skip createCrediarioParcelas · ` +
        `saleId=${saleId} parcelas=${body.parcelas} valorFinanciado=R$${valorFinanciado.toFixed(2)}`,
      );
      return {
        ok: true,
        training: true,
        parcelas: body.parcelas,
        controle: 'TREINO',
        registroInicial: null,
        valorFinanciado,
        entrada,
      };
    }

    // Busca cliente no espelho giga_clientes pra pegar codCliente (+ pendências
    // pra checar limite).
    // ESCOPADO pela loja DA VENDA — código de cliente se repete entre lojas;
    // sem isso as parcelas caíam no cadastro de outra loja (cliente errado).
    // Nome/telefone entram como fallback (cadastro do Wincred sem CPF).
    const info = await this.getCustomerInfo(
      req,
      sale.customerCpf,
      sale.storeCode,
      sale.customerName || undefined,
      (sale as any).customerPhone || undefined,
    );
    if (!info.found || !info.cliente) {
      throw new BadRequestException(
        (info as any).message ||
        'Cliente não encontrado. Cadastre o cliente antes de fazer crediário.',
      );
    }

    // ── POLÍTICA DE LIMITE DE CRÉDITO (default OFF) ──
    // Quando ligada em CrediarioConfig, bloqueia cliente acima do limite.
    // Pode ser liberado com senha de supervisor (overridePassword).
    try {
      const cfg = await this.crediarioBaixa.getConfig();
      if (cfg.limiteEnabled) {
        const motivos: string[] = [];
        const qtdVencidas = Number((info as any).qtdAtrasadas || 0);
        const valorAberto = Number((info as any).totalDevido || 0);
        if (cfg.limiteMaxParcelasVencidas > 0 && qtdVencidas > cfg.limiteMaxParcelasVencidas) {
          motivos.push(
            `${qtdVencidas} parcelas vencidas (máx ${cfg.limiteMaxParcelasVencidas})`,
          );
        }
        if (cfg.limiteMaxValorEmAberto > 0 && valorAberto > cfg.limiteMaxValorEmAberto) {
          motivos.push(
            `R$ ${valorAberto.toFixed(2)} em aberto (máx R$ ${cfg.limiteMaxValorEmAberto.toFixed(2)})`,
          );
        }
        if (motivos.length > 0) {
          // Bloqueado — só passa com senha de supervisor válida.
          let liberado = false;
          if (body?.overridePassword) {
            try {
              const nivel = validateMinLevel(body.overridePassword, 'SUPERVISOR', req?.user?.storeCode);
              liberado = true;
              this.logger.warn(
                `[crediario] LIMITE liberado por override [${nivel}] — venda ${saleId} cliente=${info.cliente.codCliente} (${motivos.join('; ')})`,
              );
            } catch {
              throw new ForbiddenException('Senha de supervisor inválida pra liberar o limite');
            }
          }
          if (!liberado) {
            throw new ForbiddenException(
              `Cliente acima do limite de crédito: ${motivos.join('; ')}. ` +
              `Libere com senha de supervisor.`,
            );
          }
        }
      }
    } catch (e: any) {
      // Erros de bloqueio (Forbidden) sobem; falha ao LER a config não pode
      // travar a venda — segue sem limite (fail-open, comportamento legado).
      if (e instanceof ForbiddenException) throw e;
      this.logger.warn(`[crediario] checagem de limite ignorada (erro lendo config): ${e?.message}`);
    }

    // ── CAMINHO FLOW-PRIMEIRO (CREDIARIO_FLOW_FIRST, padrão ligado) ────────
    // As parcelas nascem no Postgres e o Giga recebe réplica pela fila. Esta
    // era a última escrita síncrona que impedia vender com o Giga fora.
    //
    // Repare que `detectColumns()` fica DEPOIS: ele mesmo bate no MySQL
    // (SHOW COLUMNS + SELECT + COUNT numa `movimento` de 700k linhas), então
    // deixá-lo antes gastaria justamente a espera que este caminho evita.
    if (this.crediarioCriacao.flowFirst) {
      const r = await this.crediarioCriacao.criarParcelas({
        saleId,
        codCliente: info.cliente.codCliente,
        nomeCliente: info.cliente.nome || sale.customerName || '',
        loja: sale.storeCode,
        valorTotal: valorFinanciado,
        parcelas: body.parcelas,
        primeiroVencimento: new Date(`${body.primeiroVencimento}T00:00:00.000Z`),
        dataCompra: new Date(),
        observacao: body.observacao || `PDV venda #${sale.id.slice(-6).toUpperCase()}`,
      });
      return {
        ok: true,
        parcelas: r.parcelas,
        controle: r.controle,
        registroInicial: r.registros[0],
        valorFinanciado,
        entrada,
        // A tela mostra isso pra vendedora não achar que criou duas vezes.
        jaExistia: r.jaExistia,
      };
    }

    const cols = await this.crediarios.detectColumns();
    if (!cols.registro || !cols.controle || !cols.codCliente || !cols.vencimento || !cols.valorParcela || !cols.parcela) {
      throw new BadRequestException(
        'Colunas obrigatórias da tabela movimento não detectadas — contate suporte',
      );
    }

    const result = await this.erp.createCrediarioParcelas({
      codCliente: info.cliente.codCliente,
      nomeCliente: info.cliente.nome || sale.customerName || '',
      valorTotal: valorFinanciado,
      parcelas: body.parcelas,
      primeiroVencimento: new Date(`${body.primeiroVencimento}T00:00:00.000Z`),
      dataCompra: new Date(),
      loja: sale.storeCode,
      observacao: body.observacao || `PDV venda #${sale.id.slice(-6).toUpperCase()}`,
      columns: cols,
    });

    if (!result.success) {
      throw new BadRequestException(`Erro ao criar parcelas: ${result.error}`);
    }

    // Grava o controle na venda — TRAVA de idempotência pra próximas chamadas.
    // best-effort: se falhar, a venda fica sem a trava (volta ao risco antigo),
    // mas as parcelas já foram criadas corretamente, então não desfaz nada.
    try {
      await (this.svc as any).prisma.pdvSale.update({
        where: { id: saleId },
        data: {
          crediarioControle: String(result.controleUsado ?? ''),
          crediarioCriadoEm: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.error(
        `[crediario] FALHA ao gravar controle de idempotência na venda ${saleId}: ${e?.message}`,
      );
    }

    return {
      ok: true,
      parcelas: result.parcelas,
      controle: result.controleUsado,
      registroInicial: result.registroInicial,
      valorFinanciado,
      entrada,
    };
  }

  /**
   * GET /pdv/sales/crediario-orfaos?dias=10
   * Lista vendas que TEM pagamento method='crediario' no PdvSalePayment mas
   * NAO tem parcelas correspondentes no Giga (movimento).
   * Usado pra identificar vendas perdidas pelo bug do sumPaidValue.
   */
  @Get('sales/crediario-orfaos')
  async listarCrediariosOrfaos(@Req() req: any, @Query('dias') diasQ?: string) {
    this.requireRole(req);
    const dias = Math.min(60, Math.max(1, Number(diasQ) || 10));
    const since = new Date(Date.now() - dias * 86400000);
    const vendas = await (this.svc as any).prisma.pdvSale.findMany({
      where: {
        status: 'finalized',
        createdAt: { gte: since },
        payments: { some: { method: 'crediario' } },
      },
      select: {
        id: true,
        createdAt: true,
        total: true,
        storeCode: true,
        customerName: true,
        customerCpf: true,
        payments: { select: { method: true, valor: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      ok: true,
      dias,
      total: vendas.length,
      atencao: 'cruze cada venda manualmente com o Giga (modulo movimento) — esta lista mostra vendas com crediario REGISTRADO no PDV, voce precisa conferir caso a caso se as parcelas existem no Giga.',
      vendas: vendas.map((v: any) => ({
        id: v.id,
        numero: v.id.slice(-6).toUpperCase(),
        data: v.createdAt,
        loja: v.storeCode,
        cliente: v.customerName || '-',
        cpf: v.customerCpf || '-',
        total: v.total,
        valorCrediario: v.payments.filter((p: any) => p.method === 'crediario').reduce((s: number, p: any) => s + (p.valor || 0), 0),
        valorOutros: v.payments.filter((p: any) => p.method !== 'crediario').reduce((s: number, p: any) => s + (p.valor || 0), 0),
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // IMPRESSÃO — Promissórias e Carnê pré-impressos da Lurd's
  // ═══════════════════════════════════════════════════════════════════════

  /** GET /pdv/sales/:id/promissorias-pdf — N folhas A4, 3 promissórias por folha */
  @Get('sales/:id/promissorias-pdf')
  async getPromissoriasPdf(
    @Req() req: any,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generatePromissorias(id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/promissorias-pdf] FALHA', id, '\n', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF', detail: e?.message });
    }
  }

  /**
   * GET /pdv/sales/:id/carne-pdf — 1 folha A4, 2 carnês iguais.
   * ?debug=1 → desenha grade + labels [campo] em vermelho pra calibrar.
   */
  @Get('sales/:id/carne-pdf')
  async getCarnePdf(
    @Req() req: any,
    @Param('id') id: string,
    @Query('debug') debug: string,
    @Res() res: Response,
  ) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generateCarne(id, {
        debug: debug === '1' || debug === 'true',
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/carne-pdf] FALHA', id, '\n', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF', detail: e?.message });
    }
  }

  /**
   * GET /pdv/sales/:id/credprint-pdf — combinado: promissórias + carnê na ordem
   * que a vendedora carrega na impressora (folhas brancas primeiro, azul por último).
   */
  @Get('sales/:id/credprint-pdf')
  async getCredPrintCompleto(
    @Req() req: any,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generateImpressaoCompleta(id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/credprint-pdf] FALHA', id, '\n', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF', detail: e?.message });
    }
  }

  /**
   * GET /pdv/regua-calibracao — RÉGUA pra calibrar coordenadas da promissória.
   * Imprime em folha BRANCA, sobrepõe na pré-impressa contra a janela e
   * reporta em que Y caem cada label do form.
   */
  @Get('regua-calibracao')
  async getReguaCalibracao(@Req() req: any, @Res() res: Response) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generateRegua();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/regua-calibracao] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar régua' });
    }
  }

  /**
   * GET /pdv/promissorias-teste-pdf — gera 3 promissórias com os MESMOS dados
   * do print de referência do WinCred (Thiago/2315/8.90/5.00...). Não depende
   * de venda — só pra calibrar coordenadas e fonte sobre a folha pré-impressa.
   */
  @Get('promissorias-teste-pdf')
  async getPromissoriasTeste(@Res() res: Response) {
    // Sem auth + sem cache: tem que recarregar TODA vez pra refletir o JSON
    try {
      const { buffer, filename } = await this.crediarioPrint.generatePromissoriasTeste();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/promissorias-teste-pdf] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF de teste', detail: e?.message });
    }
  }

  /**
   * GET /pdv/diag-coords — mostra as coordenadas ATIVAS da promissória,
   * o path do JSON lido (ou null se não achou) e da fonte Verdana.
   * Use pra confirmar que sua edição do JSON foi carregada pelo backend.
   *
   * SEM auth: só retorna coordenadas geométricas, zero dado sensível.
   * Pode ser acessado direto pelo navegador.
   */
  @Get('diag-coords')
  async getDiagCoords(@Res() res: Response) {
    try {
      const result = await this.crediarioPrint.diagCoords();
      res.status(200).json(result);
    } catch (e: any) {
      console.error('[pdv/diag-coords] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro no diag', detail: e?.message });
    }
  }

  /**
   * GET /pdv/diag-cliente?cpf=XXX — diagnóstico do cliente no Giga.
   * Retorna a linha crua + lista de colunas pra identificar por que
   * endereço/CEP/etc não estão vindo.
   */
  @Get('diag-cliente')
  async getDiagCliente(@Req() req: any, @Query('cpf') cpf: string, @Res() res: Response) {
    this.requireRole(req);
    try {
      const result = await this.crediarioPrint.diagCliente(cpf);
      res.status(200).json(result);
    } catch (e: any) {
      console.error('[pdv/diag-cliente] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro no diag', detail: e?.message });
    }
  }

  /**
   * GET /pdv/promissorias-teste-debug-pdf — promissória de teste COM RÉGUA
   * de fundo. Pra calibração: imprime essa folha SOZINHA, sobrepõe na
   * pré-impressa do Giga e reporta deslocamentos lendo as coordenadas Y/X.
   */
  @Get('promissorias-teste-debug-pdf')
  async getPromissoriasTesteDebug(@Req() req: any, @Res() res: Response) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generatePromissoriasTesteDebug();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/promissorias-teste-debug-pdf] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF debug', detail: e?.message });
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ADMIN — Reconciliacao retroativa de estoque PDV → Wincred
  // ═════════════════════════════════════════════════════════════════════════

  @Get('admin/reconcile-stock/preview')
  async previewReconcileStock(
    @Req() req: any,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('storeCode') storeCode?: string,
    @Query('limit') limit?: string,
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode reconciliar estoque');
    }
    return this.svc.reconcileStockBacklog({
      sinceIso: since,
      untilIso: until,
      storeCode,
      limit: limit ? Number(limit) : 100,
      dryRun: true,
    });
  }

  @Post('admin/reconcile-stock/execute')
  async executeReconcileStock(
    @Req() req: any,
    @Body() body: { since?: string; until?: string; storeCode?: string; limit?: number },
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode reconciliar estoque');
    }
    return this.svc.reconcileStockBacklog({
      sinceIso: body?.since,
      untilIso: body?.until,
      storeCode: body?.storeCode,
      limit: body?.limit || 100,
      dryRun: false,
    });
  }

  /**
   * GET /pdv/admin/reconcile-manual-stock/preview — estoque fantasma "MANUAL":
   * produto REAL vendido com desconto manual (promoTag='MANUAL' + sku/ref reais)
   * que o filtro antigo pulava na baixa. Invisível ao reconcile normal (a venda
   * marcava stockDecreasedAt). Dry-run: só conta/lista, não baixa nada.
   */
  @Get('admin/reconcile-manual-stock/preview')
  async previewReconcileManualStock(
    @Req() req: any,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('storeCode') storeCode?: string,
    @Query('limit') limit?: string,
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode reconciliar estoque');
    }
    return this.svc.reconcileManualStockBacklog({
      sinceIso: since,
      untilIso: until,
      storeCode,
      limit: limit ? Number(limit) : 1000,
      dryRun: true,
    });
  }

  /** POST /pdv/admin/reconcile-manual-stock/execute — baixa os fantasmas MANUAL. */
  @Post('admin/reconcile-manual-stock/execute')
  async executeReconcileManualStock(
    @Req() req: any,
    @Body() body: { since?: string; until?: string; storeCode?: string; limit?: number },
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode reconciliar estoque');
    }
    return this.svc.reconcileManualStockBacklog({
      sinceIso: body?.since,
      untilIso: body?.until,
      storeCode: body?.storeCode,
      limit: body?.limit || 1000,
      dryRun: false,
    });
  }

  /**
   * GET /pdv/admin/cleanup-ghost-sales/preview?olderThanMinutes=30&storeCode=01
   * Lista vendas fantasma (open + sem items + criadas ha > N min). Dry-run.
   */
  @Get('admin/cleanup-ghost-sales/preview')
  async previewCleanupGhost(
    @Req() req: any,
    @Query('olderThanMinutes') olderThanMinutes?: string,
    @Query('storeCode') storeCode?: string,
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    return this.svc.cleanupGhostSales({
      olderThanMinutes: olderThanMinutes ? Number(olderThanMinutes) : 30,
      storeCode,
      dryRun: true,
    });
  }

  /**
   * POST /pdv/admin/cleanup-ghost-sales/execute
   * Body: { olderThanMinutes?, storeCode? }
   * Cancela todas vendas fantasma (status=cancelled, reason=auto-cleanup-fantasma).
   */
  @Post('admin/cleanup-ghost-sales/execute')
  async executeCleanupGhost(
    @Req() req: any,
    @Body() body: { olderThanMinutes?: number; storeCode?: string },
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    return this.svc.cleanupGhostSales({
      olderThanMinutes: body?.olderThanMinutes || 30,
      storeCode: body?.storeCode,
      dryRun: false,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — Diagnostico + criacao de indices no Wincred
  // ═══════════════════════════════════════════════════════════════════════

  @Get('admin/erp-indexes')
  async inspectErpIndexes(
    @Req() req: any,
    @Query('table') table?: string,
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    const tables = table ? [table] : ['estoque', 'caixa', 'produtos', 'movimento'];
    const results = await Promise.all(
      tables.map((t) => this.erp.inspectTableIndexes(t)),
    );
    // Avalia se cada tabela tem indice util pra performance
    const analysis = results.map((r) => {
      const tbl = r.table;
      let recommendation: string | null = null;
      let hasCodigoLoja = false;
      let hasRef = false;
      if (r.indexes && r.indexes.length > 0) {
        for (const idx of r.indexes) {
          const cols = idx.columns.map((c) => c.toUpperCase());
          if (cols.includes('CODIGO') && cols.includes('LOJA')) hasCodigoLoja = true;
          if (cols[0] === 'REF') hasRef = true;
        }
      }
      if (tbl === 'estoque' && !hasCodigoLoja) {
        recommendation = 'CRIAR INDICE COMPOSTO (CODIGO, LOJA) — sem isso, SELECT/UPDATE de estoque varre tabela inteira';
      }
      if (tbl === 'produtos' && !hasRef) {
        recommendation = 'CRIAR INDICE em REF — usado em busca por refCode';
      }
      return { ...r, hasCodigoLoja, hasRef, recommendation };
    });
    return { results: analysis };
  }

  @Post('admin/erp-create-index')
  async createErpIndex(
    @Req() req: any,
    @Body() body: { table: string; indexName: string; columns: string[] },
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    if (!body?.table || !body?.indexName || !body?.columns?.length) {
      throw new BadRequestException('table, indexName e columns sao obrigatorios');
    }
    return this.erp.createIndexIfNotExists({
      table: body.table,
      indexName: body.indexName,
      columns: body.columns,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — Diagnostico + retry de estorno de estoque em devolucoes
  // ═══════════════════════════════════════════════════════════════════════

  @Get('admin/returns-stock-status')
  async returnsStockStatus(
    @Req() req: any,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('storeCode') storeCode?: string,
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    return this.returns.getReturnsStockStatus({ sinceIso: since, untilIso: until, storeCode });
  }

  @Post('admin/returns-stock-retry')
  async returnsStockRetry(
    @Req() req: any,
    @Body() body: { since?: string; until?: string; storeCode?: string; limit?: number; dryRun?: boolean },
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    return this.returns.retryReturnsStock({
      sinceIso: body?.since,
      untilIso: body?.until,
      storeCode: body?.storeCode,
      limit: body?.limit || 100,
      dryRun: !!body?.dryRun,
    });
  }
}
