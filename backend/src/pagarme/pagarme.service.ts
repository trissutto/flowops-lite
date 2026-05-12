import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';

/**
 * Gera um CPF VALIDO (passa no algoritmo de digitos verificadores) usando
 * uma seed determinstica (saleId). Mesmo saleId sempre gera mesmo CPF —
 * idempotente — mas saleIds diferentes geram CPFs diferentes.
 *
 * USADO QUANDO: Pagar.me exige customer.document mas o cliente real nao
 * informou CPF. Antes usavamos CPF fixo '11144477735' — Pagar.me dedup
 * customers por document e todas cobrancas sem CPF viravam o MESMO cliente
 * (o primeiro cadastrado com esse CPF). Resultado: nome estranho aparecia
 * em cobrancas de outras pessoas.
 */
function generateValidCpfFromSeed(seed: string): string {
  // Hash determistico → 9 digitos base
  const hash = crypto.createHash('sha256').update(`lurds-pdv-${seed}`).digest('hex');
  const digits: number[] = [];
  // Pega 9 bytes do hash, converte cada um pra digito 0-9
  for (let i = 0; i < 9; i++) {
    digits.push(parseInt(hash.slice(i * 2, i * 2 + 2), 16) % 10);
  }
  // Calcula 1o digito verificador
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += digits[i] * (10 - i);
  const r1 = soma % 11;
  digits.push(r1 < 2 ? 0 : 11 - r1);
  // Calcula 2o digito verificador
  soma = 0;
  for (let i = 0; i < 10; i++) soma += digits[i] * (11 - i);
  const r2 = soma % 11;
  digits.push(r2 < 2 ? 0 : 11 - r2);
  return digits.join('');
}

/**
 * Pagar.me — integração via API v5 (REST/JSON).
 *
 * Vantagem sobre PagBank: PIX dinâmico funciona em PRODUÇÃO sem homologação
 * prévia. API Key é gerada direto no dashboard e já vale.
 *
 * Endpoints usados:
 *   - POST /orders                     → cria order com PIX dinâmico
 *   - GET  /orders/:id                 → consulta status
 *   - webhook configurado no dashboard → POST com HMAC pra confirmação
 *
 * Auth: Basic (API Key como user, senha vazia).
 *   Authorization: Basic <base64(apiKey:)>
 *
 * Ambientes (mesmo URL base, ambiente é determinado pela API Key):
 *   - sk_test_xxx → sandbox/test
 *   - sk_xxx      → produção/live
 */
@Injectable()
export class PagarmeService {
  private readonly logger = new Logger(PagarmeService.name);
  private readonly BASE_URL = 'https://api.pagar.me/core/v5';

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
  ) {}

  // ── Config ──────────────────────────────────────────────────────────

  async getConfig() {
    let cfg = await (this.prisma as any).pagarmeConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!cfg) {
      cfg = await (this.prisma as any).pagarmeConfig.create({
        data: { id: 'singleton' },
      });
    }
    return {
      ambiente: cfg.ambiente,
      enabled: cfg.enabled,
      hasApiKey: !!cfg.apiKey,
      hasWebhookSecret: !!cfg.webhookSecret,
      recipientId: cfg.recipientId || null,
      // Detecta ambiente automaticamente pela key
      detectedFromKey: cfg.apiKey
        ? cfg.apiKey.startsWith('sk_test_')
          ? 'test'
          : 'live'
        : null,
    };
  }

  async setConfig(input: {
    ambiente?: 'test' | 'live';
    apiKey?: string;
    webhookSecret?: string;
    recipientId?: string;
    enabled?: boolean;
  }) {
    const data: any = {};
    if (input.ambiente) data.ambiente = input.ambiente;
    if (input.enabled != null) data.enabled = input.enabled;
    // Sanitiza API Key — Pagar.me prefixa com sk_test_ ou sk_
    if (input.apiKey && input.apiKey.trim()) {
      data.apiKey = input.apiKey
        .replace(/\s+/g, '')
        .replace(/^Bearer/i, '')
        .replace(/^Basic/i, '')
        .trim();
    }
    if (input.webhookSecret && input.webhookSecret.trim()) {
      data.webhookSecret = input.webhookSecret.trim();
    }
    // recipientId — formato rp_xxx ou ba_xxx (Pagar.me)
    if (input.recipientId !== undefined) {
      const v = (input.recipientId || '').trim();
      data.recipientId = v || null;
    }

    await (this.prisma as any).pagarmeConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...data },
      update: data,
    });

    return this.getConfig();
  }

  private async getConfigInternal() {
    const cfg = await (this.prisma as any).pagarmeConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!cfg) throw new BadRequestException('Pagar.me não configurado');
    if (!cfg.enabled) throw new BadRequestException('Pagar.me desabilitado');
    if (!cfg.apiKey) throw new BadRequestException('API Key Pagar.me não cadastrada');
    return cfg;
  }

  isEnabled(): Promise<boolean> {
    return (this.prisma as any).pagarmeConfig
      .findUnique({ where: { id: 'singleton' } })
      .then((c: any) => !!(c?.enabled && c?.apiKey))
      .catch(() => false);
  }

  /**
   * Header de auth: Basic com API Key + senha vazia
   */
  private authHeader(apiKey: string): string {
    const b64 = Buffer.from(`${apiKey}:`).toString('base64');
    return `Basic ${b64}`;
  }

  // ── Test connection ─────────────────────────────────────────────────

  async testConnection(): Promise<{
    ok: boolean;
    ambiente: string;
    hasApiKey: boolean;
    httpStatus?: number;
    error?: string;
    hint?: string;
  }> {
    const cfg = await (this.prisma as any).pagarmeConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!cfg) {
      return { ok: false, ambiente: 'test', hasApiKey: false, error: 'Config não criada' };
    }
    if (!cfg.apiKey) {
      return {
        ok: false,
        ambiente: cfg.ambiente,
        hasApiKey: false,
        error: 'API Key não cadastrada',
        hint: 'Cole a API Key no campo e salve',
      };
    }

    // Detecta ambiente real pela key
    const realAmbiente = cfg.apiKey.startsWith('sk_test_') ? 'test' : 'live';

    try {
      // Testa com POST /orders body vazio. 401 = key errada, 422 = key ok.
      const resp = await firstValueFrom(
        this.http.post(
          `${this.BASE_URL}/orders`,
          {},
          {
            headers: {
              Authorization: this.authHeader(cfg.apiKey),
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            timeout: 10000,
            validateStatus: () => true,
          },
        ),
      );
      const httpStatus = resp.status;
      if (httpStatus === 401 || httpStatus === 403) {
        return {
          ok: false,
          ambiente: realAmbiente,
          hasApiKey: true,
          httpStatus,
          error: 'API Key rejeitada',
          hint: 'Confira no dashboard Pagar.me se a key tá ativa e correta',
        };
      }
      // 400/422 = key autenticou, body vazio é validation
      return {
        ok: true,
        ambiente: realAmbiente,
        hasApiKey: true,
        httpStatus,
      };
    } catch (e: any) {
      return {
        ok: false,
        ambiente: realAmbiente,
        hasApiKey: true,
        error: e?.message || 'Erro desconhecido',
      };
    }
  }

  // ── Criar PIX ───────────────────────────────────────────────────────

  /**
   * Cria order com PIX dinâmico no Pagar.me. Retorna QR Code (texto + URL).
   */
  async createPixCharge(input: {
    saleId: string;
    valor: number;
    storeCode: string;
    customerName?: string;
    customerCpf?: string;
    customerEmail?: string;
    customerPhone?: string;
    expiresInMinutes?: number;
  }): Promise<{
    pagarmeOrderId: string;
    qrCodeText: string;
    qrCodeImageUrl: string;
    expiresAt: Date;
    valor: number;
  }> {
    const cfg = await this.getConfigInternal();

    if (!input.saleId) throw new BadRequestException('saleId obrigatório');
    if (!input.valor || input.valor <= 0)
      throw new BadRequestException('valor deve ser > 0');
    if (!input.storeCode) throw new BadRequestException('storeCode obrigatório');

    const valorCentavos = Math.round(input.valor * 100);
    const expiresInSec = Math.max(60, (input.expiresInMinutes || 15) * 60);
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);

    // Customer — Pagar.me exige document (CPF/CNPJ). Default fictício se não tem.
    //
    // BUG HISTORICO RESOLVIDO: Antes usava CPF ficticio FIXO '11144477735'.
    // Pagar.me identifica customer por document — todas cobrancas sem CPF
    // viravam o MESMO customer (o primeiro nome cadastrado com esse CPF).
    // Resultado: no dashboard aparecia nome errado pra cobrancas de outras pessoas.
    //
    // Agora geramos CPF ficticio VALIDO unico por cobranca (algoritmo + saleId
    // como semente) — assim cada cobranca vira um customer novo no Pagar.me e
    // o pagador real aparece corretamente.
    const customerName = (input.customerName || `Cliente PDV ${input.saleId.slice(-6).toUpperCase()}`).slice(0, 64);
    const customerEmail = input.customerEmail
      || `pdv-${input.saleId.slice(-12)}@lurds.com.br`;
    let customerDoc = (input.customerCpf || '').replace(/\D/g, '');
    if (!customerDoc || (customerDoc.length !== 11 && customerDoc.length !== 14)) {
      customerDoc = generateValidCpfFromSeed(input.saleId);
    }

    // Phone — Pagar.me EXIGE pelo menos 1 phone no customer pra charge PIX.
    // Parseia o telefone do cliente; se não veio, usa fallback da loja (13 996218277).
    const phoneRaw = (input.customerPhone || '').replace(/\D/g, '');
    let phoneAreaCode = '13';
    let phoneNumber = '996218277';
    if (phoneRaw.length === 11) {
      // 11 dígitos: DDD (2) + número (9) — celular
      phoneAreaCode = phoneRaw.slice(0, 2);
      phoneNumber = phoneRaw.slice(2);
    } else if (phoneRaw.length === 10) {
      // 10 dígitos: DDD (2) + número (8) — fixo
      phoneAreaCode = phoneRaw.slice(0, 2);
      phoneNumber = phoneRaw.slice(2);
    } else if (phoneRaw.length === 13 && phoneRaw.startsWith('55')) {
      // 13 dígitos com 55 prefixo: 55 + DDD + 9 dígitos
      phoneAreaCode = phoneRaw.slice(2, 4);
      phoneNumber = phoneRaw.slice(4);
    }

    // Split rule — obrigatório quando conta é PSP/marketplace.
    // 100% do valor vai pro recipient cadastrado, com a própria conta absorvendo
    // as taxas (liable=true, charge_processing_fee=true).
    const splitRules = cfg.recipientId
      ? [
          {
            recipient_id: cfg.recipientId,
            amount: valorCentavos,
            type: 'flat',
            options: {
              charge_processing_fee: true,
              charge_remainder_fee: true,
              liable: true,
            },
          },
        ]
      : undefined;

    const pixPayment: any = {
      payment_method: 'pix',
      pix: {
        expires_in: expiresInSec,
        additional_information: [
          { name: 'Loja', value: input.storeCode },
          { name: 'Pedido', value: input.saleId.slice(-8).toUpperCase() },
        ],
      },
    };
    if (splitRules) pixPayment.split = splitRules;

    const body: any = {
      code: `LURDS-${input.saleId.slice(-8).toUpperCase()}`,
      items: [
        {
          amount: valorCentavos,
          description: `Venda PDV ${input.storeCode}`,
          quantity: 1,
          code: input.saleId.slice(-12),
        },
      ],
      customer: {
        name: customerName,
        email: customerEmail,
        type: customerDoc.length === 14 ? 'company' : 'individual',
        document: customerDoc,
        document_type: customerDoc.length === 14 ? 'cnpj' : 'cpf',
        phones: {
          mobile_phone: {
            country_code: '55',
            area_code: phoneAreaCode,
            number: phoneNumber,
          },
        },
      },
      payments: [pixPayment],
      metadata: {
        saleId: input.saleId,
        storeCode: input.storeCode,
        source: 'lurds-pdv',
      },
    };

    let resp: any;
    try {
      resp = await firstValueFrom(
        this.http.post(`${this.BASE_URL}/orders`, body, {
          headers: {
            Authorization: this.authHeader(cfg.apiKey),
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }),
      );
    } catch (e: any) {
      const status = e?.response?.status;
      const data = e?.response?.data;
      this.logger.error(
        `[pagarme] createPixCharge HTTP ${status} sale=${input.saleId}: ${JSON.stringify(data || e?.message)}\nBODY: ${JSON.stringify(body)}`,
      );
      // Pagar.me retorna errors em formato "errors": { "field": ["msg"] }
      let msg = '';
      if (data?.errors && typeof data.errors === 'object') {
        msg = Object.entries(data.errors)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join(' | ');
      }
      throw new BadRequestException(
        `Pagar.me rejeitou: ${msg || data?.message || e?.message || 'erro desconhecido'}`,
      );
    }

    let order = resp.data;
    const orderId = order.id;

    // Helper: extrai QR de TODAS as posições conhecidas (API v5 varia)
    const extractQr = (o: any): { qrText: string; qrUrl: string } => {
      const charge = (o?.charges || [])[0];
      const lastTx = charge?.last_transaction || {};
      return {
        qrText:
          lastTx.qr_code ||
          lastTx.pix_qr_code ||
          lastTx.qrcode ||
          charge?.qr_code ||
          charge?.pix?.qr_code ||
          o?.checkouts?.[0]?.pix_qr_code ||
          '',
        qrUrl:
          lastTx.qr_code_url ||
          lastTx.pix_qr_code_url ||
          lastTx.qrcode_url ||
          charge?.qr_code_url ||
          charge?.pix?.qr_code_url ||
          o?.checkouts?.[0]?.pix_qr_code_url ||
          '',
      };
    };

    let { qrText: qrCodeText, qrUrl: qrCodeImageUrl } = extractQr(order);

    // Se o response sync não trouxe qr_code, faz polling curto.
    // Pagar.me gera o charge async — em ~1-3s o GET /orders/:id traz tudo.
    if (!qrCodeText) {
      const maxRetries = 6;        // 6 tentativas
      const delayMs = 700;         // 700ms entre cada → até ~4.2s total
      for (let i = 0; i < maxRetries; i++) {
        await new Promise((r) => setTimeout(r, delayMs));
        try {
          const refresh = await firstValueFrom(
            this.http.get(`${this.BASE_URL}/orders/${orderId}`, {
              headers: {
                Authorization: this.authHeader(cfg.apiKey),
                Accept: 'application/json',
              },
              timeout: 5000,
            }),
          );
          order = refresh.data;
          const e = extractQr(order);
          if (e.qrText) {
            qrCodeText = e.qrText;
            qrCodeImageUrl = e.qrUrl;
            this.logger.log(
              `[pagarme] qr_code disponível após ${(i + 1) * delayMs}ms (tentativa ${i + 1})`,
            );
            break;
          }
        } catch (e: any) {
          this.logger.warn(
            `[pagarme] retry ${i + 1} GET /orders/${orderId} falhou: ${e?.message || e}`,
          );
        }
      }
    }

    if (!qrCodeText) {
      // Mesmo após retries, sem qr_code. Loga estrutura completa pro Railway.
      const charge = (order?.charges || [])[0];
      const lastTx = charge?.last_transaction || {};

      // Tenta buscar detalhe full do charge específico — traz acquirer_message,
      // gateway_response_code que NÃO vêm no GET /orders.
      let chargeDetail: any = null;
      if (charge?.id) {
        try {
          const cd = await firstValueFrom(
            this.http.get(`${this.BASE_URL}/charges/${charge.id}`, {
              headers: {
                Authorization: this.authHeader(cfg.apiKey),
                Accept: 'application/json',
              },
              timeout: 5000,
            }),
          );
          chargeDetail = cd.data;
        } catch (e: any) {
          this.logger.warn(`[pagarme] GET /charges/${charge.id} falhou: ${e?.message || e}`);
        }
      }

      const detailLastTx = chargeDetail?.last_transaction || lastTx;
      const detailGatewayResp = detailLastTx?.gateway_response || {};

      this.logger.error(
        `[pagarme] order ${orderId} FALHOU. Order=${JSON.stringify(order).slice(0, 1500)} | Charge=${JSON.stringify(chargeDetail || charge).slice(0, 1500)}`,
      );

      // Monta motivo legível pro front
      const reasons: string[] = [];
      if (detailGatewayResp?.code) reasons.push(`código: ${detailGatewayResp.code}`);
      if (detailGatewayResp?.errors && Array.isArray(detailGatewayResp.errors)) {
        for (const err of detailGatewayResp.errors) {
          if (err?.message) reasons.push(err.message);
        }
      }
      if (detailLastTx?.acquirer_message) reasons.push(`acquirer: ${detailLastTx.acquirer_message}`);
      if (detailLastTx?.acquirer_return_code) reasons.push(`acq_code: ${detailLastTx.acquirer_return_code}`);
      if (detailLastTx?.status_reason) reasons.push(`reason: ${detailLastTx.status_reason}`);
      if (chargeDetail?.status_reason) reasons.push(`charge_reason: ${chargeDetail.status_reason}`);

      const reasonStr = reasons.length > 0 ? reasons.join(' · ') : 'Sem detalhes — confira logs Railway';

      throw new BadRequestException(
        `Pagar.me retornou status=${order?.status} (charge=${charge?.status}). Motivo: ${reasonStr}`,
      );
    }

    const finalCharge = (order?.charges || [])[0];
    await (this.prisma as any).pagarmePayment.create({
      data: {
        saleId: input.saleId,
        storeCode: input.storeCode,
        pagarmeOrderId: orderId,
        pagarmeChargeId: finalCharge?.id || null,
        method: 'pix',
        valor: input.valor,
        status: 'pending',
        qrCodeText,
        qrCodeImageUrl,
        expiresAt,
      },
    });

    this.logger.log(
      `[pagarme] PIX criado: order=${orderId} sale=${input.saleId} loja=${input.storeCode} R$${input.valor.toFixed(2)}`,
    );

    return {
      pagarmeOrderId: orderId,
      qrCodeText,
      qrCodeImageUrl,
      expiresAt,
      valor: input.valor,
    };
  }

  /**
   * Consulta status da order na Pagar.me (polling fallback).
   */
  async checkOrderStatus(pagarmeOrderId: string) {
    const cfg = await this.getConfigInternal();
    const resp = await firstValueFrom(
      this.http.get(`${this.BASE_URL}/orders/${pagarmeOrderId}`, {
        headers: {
          Authorization: this.authHeader(cfg.apiKey),
          Accept: 'application/json',
        },
        timeout: 10000,
      }),
    );
    const order = resp.data;
    const charge = (order.charges || [])[0];
    const chargeStatus = String(charge?.status || '').toLowerCase();

    let newStatus: string = 'pending';
    if (chargeStatus === 'paid') newStatus = 'paid';
    else if (chargeStatus === 'canceled' || chargeStatus === 'failed') {
      newStatus = chargeStatus === 'failed' ? 'failed' : 'canceled';
    }

    const local = await (this.prisma as any).pagarmePayment.findUnique({
      where: { pagarmeOrderId },
    });
    if (local && local.status !== newStatus) {
      await (this.prisma as any).pagarmePayment.update({
        where: { pagarmeOrderId },
        data: {
          status: newStatus,
          paidAt: newStatus === 'paid' ? new Date() : null,
        },
      });
    }

    return {
      pagarmeOrderId,
      status: newStatus,
      isPaid: newStatus === 'paid',
      raw: order,
    };
  }

  // ── Webhook ─────────────────────────────────────────────────────────

  /**
   * Valida HMAC do webhook Pagar.me.
   * Header: x-hub-signature: "sha256=<hex>"
   */
  validateWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
    if (!signature || !secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const normalized = signature.replace(/^sha256=/, '').toLowerCase();
    return normalized === expected;
  }

  /**
   * Processa webhook. Eventos relevantes: `order.paid`, `charge.paid`,
   * `charge.payment_failed`.
   */
  async handleWebhook(payload: any, rawBody?: string, signature?: string): Promise<{ ok: boolean; saleId?: string }> {
    try {
      const cfg = await (this.prisma as any).pagarmeConfig.findUnique({
        where: { id: 'singleton' },
      });
      if (cfg?.webhookSecret && rawBody) {
        const ok = this.validateWebhookSignature(rawBody, signature, cfg.webhookSecret);
        if (!ok) {
          this.logger.warn('[pagarme] webhook signature inválida');
          return { ok: false };
        }
      }
    } catch {}

    // Pagar.me envia 2 formatos:
    //   - order.paid:  { type, data: { id: "or_...", charges: [...] } }
    //   - charge.paid: { type, data: { id: "ch_...", order_id: "or_...", order: { id: "or_..." } } }
    // Precisa extrair sempre o ID da ORDER (or_xxx), nunca o da charge (ch_xxx),
    // porque PagarmePayment foi salvo com pagarmeOrderId = order.id.
    const eventType = payload?.type || '';
    const data = payload?.data || {};

    let orderId: string | undefined;
    if (eventType.startsWith('charge.')) {
      // Charge events: prioridade pra order_id ou data.order.id
      orderId = data?.order_id || data?.order?.id || data?.id;
    } else {
      // Order events (order.paid, order.canceled): data.id já é a order
      orderId = data?.id || data?.order_id;
    }
    // Failsafe: se ainda começa com 'ch_', tenta achar order_id em qualquer lugar
    if (orderId && String(orderId).startsWith('ch_')) {
      orderId = data?.order_id || data?.order?.id || orderId;
    }

    if (!orderId) {
      this.logger.warn(`[pagarme] webhook sem orderId: ${JSON.stringify(payload).slice(0, 300)}`);
      return { ok: false };
    }

    let newStatus: string = 'pending';
    if (eventType === 'order.paid' || eventType === 'charge.paid') newStatus = 'paid';
    else if (eventType === 'order.canceled' || eventType === 'charge.canceled') newStatus = 'canceled';
    else if (eventType.includes('failed')) newStatus = 'failed';

    const local = await (this.prisma as any).pagarmePayment.findUnique({
      where: { pagarmeOrderId: orderId },
    });
    if (!local) {
      this.logger.warn(`[pagarme] webhook pra order desconhecida: ${orderId}`);
      return { ok: false };
    }

    if (local.status !== newStatus) {
      await (this.prisma as any).pagarmePayment.update({
        where: { pagarmeOrderId: orderId },
        data: {
          status: newStatus,
          paidAt: newStatus === 'paid' ? new Date() : null,
          rawWebhook: JSON.stringify(payload).slice(0, 5000),
        },
      });
      this.logger.log(
        `[pagarme] webhook: order=${orderId} sale=${local.saleId} ${local.status} → ${newStatus}`,
      );
    }

    return { ok: true, saleId: local.saleId };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  async getPaymentBySale(saleId: string) {
    return (this.prisma as any).pagarmePayment.findFirst({
      where: { saleId, method: 'pix' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listPayments(input: { saleId?: string; status?: string; limit?: number }) {
    const where: any = {};
    if (input.saleId) where.saleId = input.saleId;
    if (input.status) where.status = input.status;
    return (this.prisma as any).pagarmePayment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, input.limit || 50),
    });
  }
}
