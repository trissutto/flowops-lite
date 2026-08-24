import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  forwardRef,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PagbankService } from './pagbank.service';
import { CrediarioBaixaService } from '../crediarios/crediario-baixa.service';
import { conferirCobrancaCobreVendaOnline } from '../common/cobranca-venda-online';
import type { Request } from 'express';

@Controller('pagbank')
export class PagbankController {
  constructor(
    private readonly svc: PagbankService,
    @Inject(forwardRef(() => CrediarioBaixaService))
    private readonly crediarioBaixa: CrediarioBaixaService,
  ) {}

  // ── Config (admin only) ────────────────────────────────────────────

  /**
   * GET /pagbank/config — status (sem expor token).
   * Com ?reveal=1, retorna token+secret em texto puro (admin only).
   * Util pra admin copiar/colar tokens em outros sistemas.
   */
  @UseGuards(JwtAuthGuard)
  @Get('config')
  async getConfig(@Req() req: any, @Query('reveal') reveal?: string) {
    const role = req?.user?.role;
    if (role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.getConfig(reveal === '1' || reveal === 'true');
  }

  /** POST /pagbank/test — testa conexão com o token salvo */
  @UseGuards(JwtAuthGuard)
  @Post('test')
  async testConnection(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.testConnection();
  }

  /** POST /pagbank/diagnose — testa o token em vários endpoints PagBank */
  @UseGuards(JwtAuthGuard)
  @Post('diagnose')
  async diagnose(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.deepDiagnose();
  }

  /**
   * POST /pagbank/pix/test-sandbox
   *
   * Cria um PIX REAL em sandbox (R$ 1,00) e retorna request + response
   * completos pra enviar à Nathalia (Chamado 1360753759) como evidência
   * de homologação. Só funciona se ambiente=sandbox.
   */
  @UseGuards(JwtAuthGuard)
  @Post('pix/test-sandbox')
  async testPixSandbox(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.createTestPixSandbox();
  }

  /**
   * GET /pagbank/store-configs — lista config por loja (sem expor tokens)
   * Retorna array com 1 entry por loja que tem config cadastrada.
   */
  @UseGuards(JwtAuthGuard)
  @Get('store-configs')
  async listStoreConfigs(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.listStoreConfigs();
  }

  /**
   * GET /pagbank/store-config/:storeCode — config especifica de uma loja.
   * Com ?reveal=1, retorna token+secret em texto puro (admin only).
   */
  @UseGuards(JwtAuthGuard)
  @Get('store-config/:storeCode')
  async getStoreConfig(
    @Req() req: any,
    @Param('storeCode') storeCode: string,
    @Query('reveal') reveal?: string,
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.getStoreConfig(storeCode, reveal === '1' || reveal === 'true');
  }

  /** POST /pagbank/store-config/:storeCode — admin salva config de uma loja especifica */
  @UseGuards(JwtAuthGuard)
  @Post('store-config/:storeCode')
  async setStoreConfig(
    @Req() req: any,
    @Param('storeCode') storeCode: string,
    @Body()
    body: {
      ambiente?: 'sandbox' | 'production';
      email?: string;
      bearerToken?: string;
      webhookSecret?: string;
      enabled?: boolean;
      contaLabel?: string;
    },
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.setStoreConfig(storeCode, body);
  }

  /** DELETE /pagbank/store-config/:storeCode — remove config da loja (volta a usar singleton) */
  @UseGuards(JwtAuthGuard)
  @Post('store-config/:storeCode/remove')
  async removeStoreConfig(@Req() req: any, @Param('storeCode') storeCode: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.removeStoreConfig(storeCode);
  }

  /** POST /pagbank/store-config/:storeCode/test — testa as credenciais da loja */
  @UseGuards(JwtAuthGuard)
  @Post('store-config/:storeCode/test')
  async testStoreConfig(@Req() req: any, @Param('storeCode') storeCode: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.testStoreConnection(storeCode);
  }

  /** POST /pagbank/config — admin salva token + ambiente */
  @UseGuards(JwtAuthGuard)
  @Post('config')
  async setConfig(
    @Req() req: any,
    @Body()
    body: {
      ambiente?: 'sandbox' | 'production';
      bearerToken?: string;
      webhookSecret?: string;
      enabled?: boolean;
    },
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.setConfig(body);
  }

  // ── PIX (loja/admin) ───────────────────────────────────────────────

  /** POST /pagbank/pix/create — gera order PIX pra uma venda do PDV */
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
      expiresInMinutes?: number;
      /** 'venda_online' quando o PIX nasce no painel Venda Online do PDV. */
      origem?: string;
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
     * A VENDA TEM QUE EXISTIR ANTES DO QR (11/08/2026).
     *
     * Auditoria achou 11 pagamentos PIX PAGOS em 48h cujo `saleId` não existe
     * em NENHUMA tabela — R$88 a R$1.448, dinheiro real na conta e venda
     * nenhuma pra fechar. O QR era gerado aceitando qualquer `saleId`; se a
     * venda da tela não estava mais no servidor (aba velha, venda recriada,
     * estado local), a cobrança nascia órfã: a cliente pagava, o webhook
     * confirmava, o reconciliador ignorava ("não é venda de PDV") e a
     * vendedora ficava presa numa tela que nunca confirma.
     *
     * Validar AQUI (na rota do PDV, não no service) é de propósito: a live usa
     * o mesmo `createPixCharge` com id de CARRINHO, que não é pdv_sale — a
     * validação no service quebraria a live inteira.
     */
    const venda = await this.svc.buscarVendaPdv(body.saleId);
    if (!venda) {
      throw new BadRequestException(
        'Esta venda não existe mais no servidor. Recarregue o PDV (F5) e monte a venda de novo — NÃO envie o QR antigo pra cliente.',
      );
    }
    if (venda.status !== 'open') {
      throw new BadRequestException(
        `Esta venda já está ${venda.status === 'finalized' ? 'finalizada' : venda.status}. Abra uma venda nova antes de gerar o PIX.`,
      );
    }
    /**
     * COMO A PEÇA SAI ANTES DA COBRANÇA (24/08/2026) — caso ON-000105.
     *
     * A forma de entrega só era exigida no clique de CONFIRMAR VENDA. Só que
     * na venda online quem fecha quase sempre é o SERVIDOR (o PIX/link cai
     * depois, com a vendedora já atendendo outra cliente) — esse clique nunca
     * acontece, e o pedido nasce "Entrega (não informada)". Aí a etiqueta cai
     * na regra histórica de UF (SP = SEDEX, resto = PAC): a cliente de
     * Contagem/MG pagou R$ 28,85 e ia receber PAC, com a vendedora jurando ter
     * marcado SEDEX — e ela tinha razão, a escolha nunca chegou ao banco.
     *
     * Medição do dia: 5 dos 105 pedidos ON- nasceram sem forma de entrega, e
     * os 5 eram cobrança gerada aqui (link/PIX da venda online).
     *
     * A trava é na COBRANÇA porque é o último momento em que a vendedora ainda
     * está na tela. Depois que o QR sai pro WhatsApp, ninguém mais volta.
     */
    if (String(body?.origem || '') === 'venda_online' && !venda.entregaTipo) {
      throw new BadRequestException(
        'Escolha a forma de entrega (SEDEX, PAC, motoboy ou retirada) antes de mandar o PIX. ' +
          'Quando o pagamento cai, o sistema fecha a venda sozinho — sem essa escolha o pedido ' +
          'sai como "Entrega (não informada)" e a etiqueta vira PAC fora de São Paulo.',
      );
    }
    // O QR NÃO PODE SAIR MAIS BARATO QUE A VENDA (24/08) — ver o arquivo da
    // regra. Vale só pra venda online: no balcão o split parcial é legítimo.
    if (String(body?.origem || '') === 'venda_online') {
      conferirCobrancaCobreVendaOnline(venda, Number(body.valor));
    }
    return this.svc.createPixCharge({
      ...body,
      origem: body.origem === 'venda_online' ? 'venda_online' : null,
    });
  }

  /** GET /pagbank/pix/status/:saleId — frontend faz polling rápido */
  @UseGuards(JwtAuthGuard)
  @Get('pix/status/:saleId')
  async getStatusBySale(@Req() req: any, @Param('saleId') saleId: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
    const p = await this.svc.getPaymentBySale(saleId);
    if (!p) return { found: false, status: 'none' };
    return {
      found: true,
      status: p.status,
      pagbankOrderId: p.pagbankOrderId,
      paidAt: p.paidAt,
      expiresAt: p.expiresAt,
      valor: p.valor,
    };
  }

  /** POST /pagbank/pix/check/:orderId — força consulta na PagBank (fallback) */
  @UseGuards(JwtAuthGuard)
  @Post('pix/check/:orderId')
  async checkOrder(@Req() req: any, @Param('orderId') orderId: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
    return this.svc.checkOrderStatus(orderId);
  }

  // ── Webhook (público, sem JWT — autenticado por HMAC) ──────────────

  /**
   * POST /pagbank/webhook — endpoint que PagBank chama quando status muda.
   *
   * IMPORTANTE: rota PÚBLICA (sem JwtAuthGuard) — autenticação é via
   * header `x-authenticity-token` (HMAC SHA256 com webhookSecret).
   */
  @Post('webhook')
  async webhook(
    @Body() body: any,
    @Req() req: Request,
    @Headers('x-authenticity-token') signature?: string,
  ) {
    /**
     * O HASH É SOBRE OS BYTES QUE O PAGBANK MANDOU (12/08/2026).
     *
     * `JSON.stringify(body)` reserializa o objeto já parseado: espaços, ordem
     * de chaves e escapes mudam, e o hash NUNCA bate com o do remetente. O
     * `verify` do body-parser (main.ts) guarda o corpo cru em `req.rawBody` —
     * é ele que vale. O stringify fica só de último recurso.
     */
    const rawBody = (req as any).rawBody
      ? Buffer.from((req as any).rawBody).toString('utf8')
      : JSON.stringify(body);
    const result = await this.svc.handleWebhook(body, rawBody, signature);

    // FIX PIX-LINK CREDIÁRIO (16/06/2026):
    // Quando webhook PagBank reporta paid PELA PRIMEIRA VEZ (statusChanged=true),
    // dispara baixa Giga automaticamente — mesmo padrão do Pagar.me.
    // Sem isso, parcela ficava em aberto + recibo não emitia.
    if (
      result.ok &&
      result.saleId &&
      result.status === 'paid' &&
      result.statusChanged
    ) {
      try {
        await this.crediarioBaixa.confirmBaixaPixIfExists(result.saleId);
      } catch (e: any) {
        // Não bloqueia ack do webhook — só loga. PagBank reenvia em falha.
      }
    }
    // PagBank espera 200 OK pra não retentar
    return { received: true, ...result };
  }

  // ── Lista (admin) ──────────────────────────────────────────────────

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
