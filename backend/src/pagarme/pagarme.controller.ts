import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PagarmeService } from './pagarme.service';
import { CrediarioBaixaService } from '../crediarios/crediario-baixa.service';
import { LojaOrdersService } from '../loja-orders/loja-orders.service';
import { Inject, forwardRef, Logger } from '@nestjs/common';

@Controller('pagarme')
export class PagarmeController {
  private readonly logger = new Logger(PagarmeController.name);

  constructor(
    private readonly svc: PagarmeService,
    @Inject(forwardRef(() => CrediarioBaixaService))
    private readonly crediarioBaixa: CrediarioBaixaService,
    @Inject(forwardRef(() => LojaOrdersService))
    private readonly lojaOrders: LojaOrdersService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('config')
  async getConfig(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.getConfig();
  }

  @UseGuards(JwtAuthGuard)
  @Post('config')
  async setConfig(
    @Req() req: any,
    @Body()
    body: {
      ambiente?: 'test' | 'live';
      apiKey?: string;
      webhookSecret?: string;
      recipientId?: string;
      enabled?: boolean;
    },
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.setConfig(body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('test')
  async test(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.testConnection();
  }

  // ── Config por loja (cascata: loja → singleton matriz) ───────────────

  @UseGuards(JwtAuthGuard)
  @Get('store-configs')
  async listStoreConfigs(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.listStoreConfigs();
  }

  @UseGuards(JwtAuthGuard)
  @Get('store-config/:storeCode')
  async getStoreConfig(@Req() req: any, @Param('storeCode') storeCode: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.getStoreConfig(storeCode);
  }

  @UseGuards(JwtAuthGuard)
  @Post('store-config/:storeCode')
  async setStoreConfig(
    @Req() req: any,
    @Param('storeCode') storeCode: string,
    @Body()
    body: {
      ambiente?: 'test' | 'live';
      apiKey?: string;
      webhookSecret?: string;
      recipientId?: string;
      enabled?: boolean;
      contaLabel?: string;
    },
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.setStoreConfig(storeCode, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('store-config/:storeCode/remove')
  async removeStoreConfig(@Req() req: any, @Param('storeCode') storeCode: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.removeStoreConfig(storeCode);
  }

  @UseGuards(JwtAuthGuard)
  @Post('store-config/:storeCode/test')
  async testStoreConfig(@Req() req: any, @Param('storeCode') storeCode: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.testStoreConnection(storeCode);
  }

  @UseGuards(JwtAuthGuard)
  @Post('pix/create')
  async createPix(
    @Req() req: any,
    @Body()
    body: {
      saleId: string;
      valor: number;
      storeCode: string;
      customerName?: string;
      customerCpf?: string;
      customerEmail?: string;
      customerPhone?: string;
      expiresInMinutes?: number;
    },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store') {
      throw new ForbiddenException('Apenas admin ou loja');
    }
    if (!body?.saleId) throw new BadRequestException('saleId obrigatório');
    if (!body?.valor) throw new BadRequestException('valor obrigatório');
    if (!body?.storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.svc.createPixCharge(body);
  }

  /**
   * POST /pagarme/checkout/create
   * Cria Link de Pagamento Pagar.me (PIX + cartão parcelado SEM JUROS).
   * Vendedora compartilha URL via WhatsApp/Instagram. Quando cliente paga,
   * o MESMO webhook do PIX dispara order.paid e finaliza a venda.
   */
  @UseGuards(JwtAuthGuard)
  @Post('checkout/create')
  async createCheckout(
    @Req() req: any,
    @Body()
    body: {
      saleId: string;
      valor: number;
      storeCode: string;
      customerName?: string;
      customerCpf?: string;
      customerEmail?: string;
      customerPhone?: string;
      maxInstallments?: number;
      expiresInMinutes?: number;
      acceptPix?: boolean;
      acceptCreditCard?: boolean;
    },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store') {
      throw new ForbiddenException('Apenas admin ou loja');
    }
    if (!body?.saleId) throw new BadRequestException('saleId obrigatório');
    if (!body?.valor) throw new BadRequestException('valor obrigatório');
    if (!body?.storeCode) throw new BadRequestException('storeCode obrigatório');
    /**
     * COMO A PEÇA SAI ANTES DO LINK (24/08/2026) — caso ON-000105.
     *
     * O link Pagar.me do PDV só existe dentro de VENDA ONLINE, e quem fecha
     * essa venda quase sempre é o `PagarmeLinkReconcileService` (o pagamento
     * cai depois, com a vendedora já em outro atendimento). Como a forma de
     * entrega só era exigida no clique de CONFIRMAR VENDA — que nesse fluxo
     * nunca acontece —, o pedido nascia "Entrega (não informada)" e a etiqueta
     * caía na regra de UF: SP = SEDEX, resto = PAC. A vendedora jurava ter
     * marcado SEDEX e tinha razão; a escolha só não chegou ao banco.
     *
     * Mesma trava do PIX (`POST /pagbank/pix/create`): é o último momento em
     * que ela ainda está na tela. Venda que não é do PDV passa direto.
     */
    const venda = await this.svc.buscarVendaPdv(body.saleId);
    if (venda && !venda.entregaTipo) {
      throw new BadRequestException(
        'Escolha a forma de entrega (SEDEX, PAC, motoboy ou retirada) antes de gerar o link. ' +
          'Quando o pagamento cai, o sistema fecha a venda sozinho — sem essa escolha o pedido ' +
          'sai como "Entrega (não informada)" e a etiqueta vira PAC fora de São Paulo.',
      );
    }
    return this.svc.createCheckoutLink(body);
  }

  /**
   * GET /pagarme/checkout/tentativas/:saleId
   * Quantos links de cartão já rodaram nesta venda. A tela avisa ANTES de
   * gerar mais um: da 3ª tentativa em diante nenhuma passou (0 de 21 medidas
   * em 01/08) e cada reenvio ainda piora o score da próxima.
   */
  @Get('checkout/tentativas/:saleId')
  async tentativasCheckout(@Req() req: any, @Param('saleId') saleId: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store') {
      throw new ForbiddenException('Apenas admin ou loja');
    }
    return this.svc.contarTentativasCheckout(saleId);
  }

  /**
   * POST /pagarme/admin/force-link-paid
   * RESGATE: cria/atualiza um PagarmePayment manualmente quando o link
   * Pagar.me foi gerado mas NÃO foi salvo no banco (bug do storeCode
   * faltando). Admin pega o order_id do painel Pagar.me e força criação.
   * Depois consulta ao vivo pra trazer o status real (pending/paid).
   */
  @UseGuards(JwtAuthGuard)
  @Post('admin/force-link-paid')
  async forceLinkPaid(
    @Req() req: any,
    @Body() body: {
      saleId: string;
      storeCode: string;
      pagarmeOrderId: string;
      valor: number;
      forceStatus?: 'paid' | 'pending';
    },
  ) {
    if (req?.user?.role !== 'admin')
      throw new ForbiddenException('Apenas admin');
    if (!body?.saleId || !body?.storeCode || !body?.pagarmeOrderId || !body?.valor) {
      throw new BadRequestException(
        'Campos obrigatórios: saleId, storeCode, pagarmeOrderId, valor',
      );
    }
    return this.svc.forceLinkPaid(body);
  }

  /**
   * GET /pagarme/online-pending?storeCode=01
   * Lista Links Pagar.me aguardando pagamento na loja (últimas 48h).
   * Usado pelo widget global do PDV pra alertar a vendedora quando o webhook
   * bate paid — assim ela pode finalizar a venda sem ficar travada na tela
   * esperando o cliente.
   */
  @UseGuards(JwtAuthGuard)
  @Get('online-pending')
  async listOnlinePending(@Req() req: any, @Query('storeCode') storeCode: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.svc.listOnlinePending(storeCode);
  }

  @UseGuards(JwtAuthGuard)
  @Get('pix/status/:saleId')
  async getStatusBySale(@Req() req: any, @Param('saleId') saleId: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
    const p = await this.svc.getPaymentBySale(saleId);
    if (!p) return { found: false, status: 'none' };

    // SEGURANÇA: SEMPRE consulta Pagar.me ao vivo se o pagamento foi criado
    // nos últimos 30min (independente do status local).
    //
    // ANTES: confiava no banco local — webhook marcava paid, e mesmo se
    // Pagar.me revertesse depois (failed/canceled), o frontend recebia paid
    // e finalizava a venda. AGORA: live é a fonte de verdade enquanto recente.
    let currentStatus = p.status;
    let paidAt = p.paidAt;
    const ageMs = Date.now() - new Date(p.createdAt).getTime();
    const isRecent = ageMs < 30 * 60 * 1000;
    if (isRecent && p.pagarmeOrderId) {
      try {
        const live = await this.svc.checkOrderStatus(p.pagarmeOrderId);
        currentStatus = live.status;
        if (live.isPaid) paidAt = new Date();
        // Se Pagar.me reverteu (failed/canceled) mas banco tinha paid: persiste a reversão
      } catch {
        // Falha de rede com Pagar.me — mantém status local (não force paid)
      }
    }

    return {
      found: true,
      status: currentStatus,
      isPaid: currentStatus === 'paid',
      isFailed: currentStatus === 'failed' || currentStatus === 'canceled',
      pagarmeOrderId: p.pagarmeOrderId,
      paidAt,
      expiresAt: p.expiresAt,
      valor: p.valor,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('pix/check/:orderId')
  async checkOrder(@Req() req: any, @Param('orderId') orderId: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
    return this.svc.checkOrderStatus(orderId);
  }

  /**
   * Webhook PÚBLICO — sem JWT. A prova de origem é HMAC (x-hub-signature) ou
   * Basic Auth (Authorization) contra o webhookSecret cadastrado; quem decide
   * é `PagarmeService.handleWebhook`, FAIL CLOSED: sem prova ele devolve
   * `ok:false` e não grava nada. Aqui NADA pode rodar sem `result.ok`.
   */
  @Post('webhook')
  async webhook(
    @Body() body: any,
    @Req() req: any,
    @Headers('x-hub-signature') signature?: string,
    @Headers('x-hub-signature-256') signature256?: string,
    @Headers('authorization') authorization?: string,
  ) {
    /**
     * O HMAC É SOBRE OS BYTES QUE A PAGAR.ME MANDOU, não sobre
     * `JSON.stringify(body)`: reserializar o objeto já parseado muda espaços,
     * ordem de chaves e escapes, e a assinatura NUNCA bate (mesma lição do
     * webhook PagBank, 12/08). O `verify` do body-parser em main.ts guarda o
     * corpo cru em `req.rawBody`; o stringify fica só de último recurso.
     */
    const rawBody = req?.rawBody
      ? Buffer.from(req.rawBody).toString('utf8')
      : JSON.stringify(body);
    const sig = signature || signature256;
    const result = await this.svc.handleWebhook(body, rawBody, sig, authorization);
    const eventType = String(body?.type || '');
    const pagou = eventType === 'order.paid' || eventType === 'charge.paid';

    // FIX PIX-LINK: se webhook reportou paid, dispara baixa Giga automaticamente.
    // Antes desse fix, baixas via PIX-LINK ficavam pending — webhook só marcava
    // PagarmePayment=paid mas nunca chamava confirmBaixaPix → Wincred não atualizava.
    if (result.ok && result.saleId && pagou) {
      try {
        await this.crediarioBaixa.confirmBaixaPixIfExists(result.saleId);
      } catch (e: any) {
        // Não bloqueia ack do webhook — só loga
      }
    }

    // ── E-COMMERCE NOVO (sprint 011) ──────────────────────────────────
    // Pedido do site (Order source='ecommerce') confirma o pagamento por aqui:
    // grava paidAt, joga o pedido em 'processing' (= cai na tela Pedidos &
    // Separação pro roteamento) e avisa o site pro purchase server-side.
    //
    // SÓ `result.saleId`, SÓ com `result.ok` (17/08/2026). Até aqui este bloco
    // rodava com `if (pagou)` e aceitava também `body.data.metadata
    // .flowops_order_id` cru — ou seja, um POST sem assinatura com
    // `{"type":"order.paid","data":{"metadata":{"flowops_order_id":"<uuid>"}}}`
    // marcava um PIX não pago como pago, e o UUID do pedido é público pra
    // cliente (volta no POST /api/checkout e no link de confirmação). O
    // pedido caía na fila de separação, disparava e-mail/WhatsApp de
    // "pagamento confirmado", purchase no Meta/GA4 e queimava cupom — peça
    // despachada sem dinheiro. A chave do metadata era redundante: PIX
    // (createPixCharge via loja-orders) e cartão gravam PagarmePayment.saleId
    // = Order.id, e o cartão já confirma inline no próprio loja-orders. Agora
    // o gate é o mesmo do crediário logo acima: `result.ok` (origem provada +
    // `or_` nosso) e o saleId vem do PagarmePayment, nunca do corpo.
    // `confirmarPagamento` segue idempotente (updateMany paidAt:null) e ignora
    // em silêncio id que não é pedido do site (venda de PDV, live...).
    // Webhook recusado/perdido: o LojaPagamentoReconcileService (60s) confirma
    // pelo gateway — sem cobrança dupla nem pedido duplicado.
    //
    // TRY/CATCH LARGO DE PROPÓSITO: nada aqui pode impedir o ack do webhook —
    // Pagar.me reenfileira em erro e o crediário/PDV acima já rodou.
    if (pagou && result.ok && result.saleId) {
      try {
        await this.lojaOrders.confirmarPagamento(result.saleId);
      } catch (e: any) {
        this.logger.warn(
          `[pagarme] confirmação do pedido do site falhou (${result.saleId}): ${e?.message || e}`,
        );
      }
    }

    /**
     * RECUSA TARDIA DO CARTÃO DO SITE (17/08). O cartão em análise de
     * antifraude agora fica `awaiting_payment` em vez de virar recusa na hora
     * (antes o pedido era marcado `payment_failed`, a cliente pagava por PIX,
     * a análise aprovava e ela pagava DUAS vezes). O fechamento negativo desse
     * estado é este bloco: quando a Pagar.me manda que a cobrança falhou /
     * foi reprovada / o pedido foi cancelado, o pedido vira `payment_failed`
     * pra a cliente saber que precisa tentar de novo — em vez de ficar
     * "aguardando" pra sempre. Mesmo gate do bloco acima: só com origem
     * provada e saleId nosso. `registrarRecusaTardia` só toca cartão em
     * `awaiting_payment` sem paidAt (trava atômica), então PIX e pedido já
     * pago passam intocados.
     */
    const recusou =
      eventType === 'charge.payment_failed' ||
      eventType === 'charge.antifraud_reproved' ||
      eventType === 'order.payment_failed' ||
      eventType === 'order.canceled' ||
      eventType === 'charge.refused';
    if (recusou && result.ok && result.saleId) {
      try {
        await this.lojaOrders.registrarRecusaTardia(result.saleId, `webhook ${eventType}`);
      } catch (e: any) {
        this.logger.warn(
          `[pagarme] recusa tardia do pedido do site falhou (${result.saleId}): ${e?.message || e}`,
        );
      }
    }

    return { received: true, ...result };
  }

  @UseGuards(JwtAuthGuard)
  @Get('payments')
  async listPayments(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('saleId') saleId?: string,
    @Query('limit') limit?: string,
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.listPayments({
      status,
      saleId,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }
}
