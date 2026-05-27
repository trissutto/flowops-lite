/**
 * StoneController — endpoints para webhook Stone + admin de conciliação.
 *
 *   POST /webhooks/stone           (público, validação HMAC)
 *   GET  /stone/conciliacao?date=  (admin, retorna status do dia)
 *   POST /stone/conciliar-manual   (admin, associa tx → sale manualmente)
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UnauthorizedException,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { StoneService } from './stone.service';

@Controller()
export class StoneController {
  private readonly logger = new Logger(StoneController.name);

  constructor(private readonly stone: StoneService) {}

  // ─── WEBHOOK PÚBLICO (sem JWT) ──────────────────────────────────────
  /**
   * POST /webhooks/stone
   *
   * Stone envia POST com payload da transação aqui. Validação por HMAC
   * SHA-256 no header Stone-Signature (ou X-Stone-Signature, conforme
   * docs reais — ajustar quando vier).
   *
   * Importante: precisa rawBody pra fazer HMAC. Configurar no main.ts:
   *   app.use(express.json({ verify: (req, _, buf) => { req.rawBody = buf; } }))
   */
  @Post('webhooks/stone')
  @HttpCode(200)
  async receiveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stone-signature') signatureHeader: string,
    @Headers('x-stone-signature') xSignatureHeader: string,
    @Body() body: any,
  ) {
    const signature = signatureHeader || xSignatureHeader || '';
    // O rawBody vem do middleware; fallback pra JSON.stringify do body parseado.
    const rawBody =
      (req as any).rawBody?.toString?.('utf8') ||
      (typeof (req as any).rawBody === 'string' ? (req as any).rawBody : '') ||
      JSON.stringify(body || {});

    const valid = this.stone.validateSignature(rawBody, signature);
    if (!valid) {
      this.logger.warn('[stone] webhook REJEITADO: assinatura HMAC inválida');
      throw new UnauthorizedException('Invalid signature');
    }

    try {
      const result = await this.stone.handleWebhook(body, rawBody);
      return result;
    } catch (e: any) {
      this.logger.error(`[stone] erro processando webhook: ${e?.message}`);
      // Retorna 200 mesmo em erro pra Stone não ficar reenviando infinitamente.
      // O log fica registrado pra revisão.
      return { ok: false, error: e?.message || String(e) };
    }
  }

  // ─── ADMIN (JWT) ────────────────────────────────────────────────────
  /**
   * GET /stone/conciliacao?date=YYYY-MM-DD
   *
   * Retorna vendas cartão do dia + status de conciliação + transações
   * Stone órfãs (recebidas mas sem match). Apenas admin/operator.
   */
  @Get('stone/conciliacao')
  @UseGuards(JwtAuthGuard)
  async getConciliacao(@Req() req: any, @Query('date') date?: string) {
    this.requireAdmin(req);
    const d = date ? new Date(date + 'T00:00:00') : new Date();
    if (isNaN(d.getTime())) {
      throw new BadRequestException('Data inválida (YYYY-MM-DD)');
    }
    return this.stone.getConciliacao(d);
  }


  /**
   * GET /stone/conciliacao-pix-por-loja?date=YYYY-MM-DD
   *
   * Compara PIX lançado no PDV com PIX confirmado via Stone, por loja.
   * Usado pelo super-painel-caixas pra mostrar selo de status.
   */
  @Get('stone/conciliacao-pix-por-loja')
  @UseGuards(JwtAuthGuard)
  async getPixConciliacaoPorLoja(@Req() req: any, @Query('date') date?: string) {
    this.requireAdmin(req);
    const d = date ? new Date(date + 'T00:00:00') : new Date();
    if (isNaN(d.getTime())) {
      throw new BadRequestException('Data inválida (YYYY-MM-DD)');
    }
    return this.stone.getPixConciliacaoPorLoja(d);
  }

  /**
   * POST /stone/conciliar-manual
   * Body: { stoneTxId, saleId }
   *
   * Associa manualmente uma transação Stone órfã com uma venda PDV.
   * Útil quando o timestamp diverge muito (ex: maquininha offline e
   * autorizou depois) e o match automático não pegou.
   */
  @Post('stone/conciliar-manual')
  @UseGuards(JwtAuthGuard)
  async conciliarManual(
    @Req() req: any,
    @Body() body: { stoneTxId: string; saleId: string },
  ) {
    this.requireAdmin(req);
    if (!body?.stoneTxId || !body?.saleId) {
      throw new BadRequestException('stoneTxId e saleId obrigatórios');
    }
    return this.stone.conciliarManual(body.stoneTxId, body.saleId, req?.user?.userId);
  }

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator' && role !== 'supervisor') {
      throw new ForbiddenException('Apenas admin/operator/supervisor');
    }
  }
}
