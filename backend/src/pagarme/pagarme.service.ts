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

  // Cache em memória de storeCode → storeName (24h).
  // Usado pra construir nome da cobranca no Pagar.me ("VENDA LOJA ITANHAEM_18:52")
  // mesmo quando o caller esquece de passar storeName.
  private storeNameCache = new Map<string, { at: number; name: string }>();
  private readonly STORE_NAME_CACHE_TTL = 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
  ) {}

  /**
   * Resolve nome da loja por storeCode com cache 24h.
   * Fallback: storeCode se loja nao for encontrada.
   * Garante que nome da cobranca sempre tem nome legivel da loja.
   */
  private async resolveStoreName(storeCode: string, hint?: string): Promise<string> {
    if (hint && hint.trim()) return hint.trim();
    const cached = this.storeNameCache.get(storeCode);
    if (cached && Date.now() - cached.at < this.STORE_NAME_CACHE_TTL) {
      return cached.name;
    }
    try {
      const store = await (this.prisma as any).store.findUnique({
        where: { code: storeCode },
        select: { name: true },
      });
      const name = store?.name?.trim() || storeCode;
      this.storeNameCache.set(storeCode, { at: Date.now(), name });
      return name;
    } catch {
      return storeCode;
    }
  }

  /** Horario atual em HH:MM Brasilia (24h). Pra anexar no nome da cobranca. */
  private getHorarioBr(): string {
    return new Date().toLocaleTimeString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

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
    storeName?: string; // pra fallback do nome do cliente (conciliação)
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
    //
    // FALLBACK PRA CONCILIACAO: se nao tem nome do cliente, usa nome da loja
    // + horario (HH:MM Brasilia). Ex: "VENDA LOJA ITANHAEM_18:52" em vez de
    // "Cliente PDV ABC123". Facilita conciliacao do extrato Pagar.me com o
    // caixa da loja: vendedora vê venda do PIX e bate exato com horario.
    // Sempre busca nome da loja no banco (cache 24h) — independente do caller
    // ter passado storeName ou nao.
    const storeName = await this.resolveStoreName(input.storeCode, input.storeName);
    const customerName = (
      input.customerName || `VENDA LOJA ${storeName.toUpperCase()}_${this.getHorarioBr()}`
    ).slice(0, 64);
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
   * Cria CHECKOUT (Link de Pagamento) na Pagar.me.
   *
   * Diferença pra createPixCharge:
   *   - payment_method = 'checkout' (vs 'pix')
   *   - Pagar.me retorna `checkouts[0].payment_url` em vez de QR Code
   *   - Cliente abre a URL e escolhe PIX ou cartão (parcelado)
   *   - Quando paga, o MESMO webhook dispara `order.paid` / `charge.paid`
   *
   * Use case Lurd's: venda online WhatsApp/Instagram. Vendedora gera link,
   * manda pra cliente, ela paga com qualquer método. Sistema detecta pago
   * via webhook e finaliza a venda automaticamente (mesma lógica do PIX).
   */
  async createCheckoutLink(input: {
    saleId: string;
    valor: number;
    storeCode: string;
    storeName?: string; // pra fallback do nome do cliente (conciliação)
    customerName?: string;
    customerCpf?: string;
    customerEmail?: string;
    customerPhone?: string;
    /** Máximo de parcelas SEM JUROS no cartão. Default 6. */
    maxInstallments?: number;
    /** Validade do link em minutos. Default 24h (1440). Máx 7d (10080). */
    expiresInMinutes?: number;
    /** Aceitar PIX no link? Default true. */
    acceptPix?: boolean;
    /** Aceitar cartão de crédito? Default true. */
    acceptCreditCard?: boolean;
  }): Promise<{
    pagarmeOrderId: string;
    paymentUrl: string;
    expiresAt: Date;
    valor: number;
  }> {
    const cfg = await this.getConfigInternal();

    if (!input.saleId) throw new BadRequestException('saleId obrigatório');
    if (!input.valor || input.valor <= 0)
      throw new BadRequestException('valor deve ser > 0');
    if (!input.storeCode) throw new BadRequestException('storeCode obrigatório');

    const valorCentavos = Math.round(input.valor * 100);
    const expiresInMin = Math.max(15, Math.min(10080, input.expiresInMinutes || 1440));
    const expiresAt = new Date(Date.now() + expiresInMin * 60 * 1000);
    const maxInst = Math.max(1, Math.min(12, input.maxInstallments || 6));
    const acceptPix = input.acceptPix !== false;
    const acceptCard = input.acceptCreditCard !== false;
    if (!acceptPix && !acceptCard) {
      throw new BadRequestException('Pelo menos 1 método de pagamento aceito');
    }

    // Customer — mesma lógica do PIX (CPF fictício único por venda se não tem)
    // Fallback "VENDA LOJA <NOME>_HH:MM" pra facilitar conciliação.
    // Sempre busca nome da loja no banco (cache 24h) — caller pode ou nao
    // passar storeName, o resultado eh o mesmo.
    const storeNameLink = await this.resolveStoreName(input.storeCode, input.storeName);
    const customerName = (
      input.customerName || `VENDA LOJA ${storeNameLink.toUpperCase()}_${this.getHorarioBr()}`
    ).slice(0, 64);
    const customerEmail = input.customerEmail
      || `pdv-${input.saleId.slice(-12)}@lurds.com.br`;
    let customerDoc = (input.customerCpf || '').replace(/\D/g, '');
    if (!customerDoc || (customerDoc.length !== 11 && customerDoc.length !== 14)) {
      customerDoc = generateValidCpfFromSeed(input.saleId);
    }

    // Phone — fallback igual ao PIX
    const phoneRaw = (input.customerPhone || '').replace(/\D/g, '');
    let phoneAreaCode = '13';
    let phoneNumber = '996218277';
    if (phoneRaw.length === 11) {
      phoneAreaCode = phoneRaw.slice(0, 2);
      phoneNumber = phoneRaw.slice(2);
    } else if (phoneRaw.length === 10) {
      phoneAreaCode = phoneRaw.slice(0, 2);
      phoneNumber = phoneRaw.slice(2);
    } else if (phoneRaw.length === 13 && phoneRaw.startsWith('55')) {
      phoneAreaCode = phoneRaw.slice(2, 4);
      phoneNumber = phoneRaw.slice(4);
    }

    // Métodos aceitos pelo checkout
    const acceptedMethods: string[] = [];
    if (acceptCard) acceptedMethods.push('credit_card');
    if (acceptPix) acceptedMethods.push('pix');

    // Parcelamento SEM JUROS — gera 1..maxInst parcelas todas valendo o total
    const installments = acceptCard
      ? Array.from({ length: maxInst }, (_, i) => ({
          number: i + 1,
          total: valorCentavos,
        }))
      : undefined;

    // Split rule — mesma estrutura do PIX
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

    const checkoutPayment: any = {
      payment_method: 'checkout',
      checkout: {
        expires_in: expiresInMin,
        default_payment_method: acceptCard ? 'credit_card' : 'pix',
        accepted_payment_methods: acceptedMethods,
        skip_checkout_success_page: false,
        customer_editable: false, // cliente NÃO pode mudar dados (CPF, etc)
        billing_address_editable: false,
        ...(acceptCard
          ? {
              credit_card: {
                installments,
                statement_descriptor: 'LURDS',
                capture: true,
              },
            }
          : {}),
        ...(acceptPix
          ? {
              pix: {
                expires_in: 3600, // 1h pra cliente concluir após escolher PIX
              },
            }
          : {}),
      },
    };
    if (splitRules) checkoutPayment.split = splitRules;

    const body: any = {
      code: `LURDS-LINK-${input.saleId.slice(-8).toUpperCase()}`,
      items: [
        {
          amount: valorCentavos,
          description: `Venda Online ${input.storeCode}`,
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
      payments: [checkoutPayment],
      metadata: {
        saleId: input.saleId,
        storeCode: input.storeCode,
        source: 'lurds-pdv-online',
        kind: 'checkout-link',
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
          timeout: 20000,
        }),
      );
    } catch (e: any) {
      const status = e?.response?.status;
      const data = e?.response?.data;
      this.logger.error(
        `[pagarme] createCheckoutLink HTTP ${status} sale=${input.saleId}: ${JSON.stringify(data || e?.message)}\nBODY: ${JSON.stringify(body)}`,
      );
      let msg = '';
      if (data?.errors && typeof data.errors === 'object') {
        msg = Object.entries(data.errors)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join(' | ');
      }
      throw new BadRequestException(
        `Pagar.me rejeitou link: ${msg || data?.message || e?.message || 'erro desconhecido'}`,
      );
    }

    const order = resp.data;
    const orderId = order.id;
    const checkout = (order.checkouts || [])[0];
    const paymentUrl = checkout?.payment_url || '';

    if (!paymentUrl) {
      this.logger.error(
        `[pagarme] order ${orderId} criada mas SEM payment_url. Order=${JSON.stringify(order).slice(0, 1500)}`,
      );
      throw new BadRequestException(
        'Pagar.me criou pedido mas não retornou URL de pagamento. Tente novamente.',
      );
    }

    this.logger.log(
      `[pagarme] checkout link criado: sale=${input.saleId} order=${orderId} url=${paymentUrl}`,
    );

    // Persiste igual ao PIX (mesma tabela pagarmePayment pra rastrear webhook depois)
    // BUG FIX: schema do PagarmePayment exige storeCode e valor — sem isso o
    // create falhava silenciosamente e o webhook depois não achava a order
    // ("webhook pra order desconhecida"). Agora salva todos os campos required.
    try {
      await (this.prisma as any).pagarmePayment.create({
        data: {
          saleId: input.saleId,
          storeCode: input.storeCode,
          pagarmeOrderId: orderId,
          method: 'checkout',
          valor: input.valor,
          status: 'pending',
          qrCodeText: paymentUrl, // reusa campo pra guardar URL
          expiresAt,
        },
      });
    } catch (e: any) {
      // Se modelo falhar, loga erro REAL — não silencia
      this.logger.error(
        `[pagarme] FALHA AO PERSISTIR pagarmePayment (sale=${input.saleId} order=${orderId}): ${e?.message || e}`,
      );
      // Re-lança — sem persistência o webhook nunca vai conseguir vincular
      throw new BadRequestException(
        `Link gerado na Pagar.me mas falhou ao salvar no banco. Cancele esse link no painel Pagar.me e tente de novo. Detalhe: ${e?.message || 'erro desconhecido'}`,
      );
    }

    return {
      pagarmeOrderId: orderId,
      paymentUrl,
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
    // BUG FIX: antes filtrava só method='pix' — assim polling do Link Pagar.me
    // (method='checkout') não detectava pagamento. Agora pega o mais recente
    // independente do método. Usado pelo endpoint /pagarme/pix/status/:saleId.
    return (this.prisma as any).pagarmePayment.findFirst({
      where: { saleId },
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

  /**
   * RESGATE manual de Link Pagar.me que não foi salvo no banco.
   * Cria/atualiza PagarmePayment + consulta status real ao vivo.
   * Usado pra recuperar vendas travadas pelo bug do storeCode faltando.
   */
  async forceLinkPaid(input: {
    saleId: string;
    storeCode: string;
    pagarmeOrderId: string;
    valor: number;
    forceStatus?: 'paid' | 'pending';
  }) {
    // 1) Cria ou atualiza PagarmePayment
    const existing = await (this.prisma as any).pagarmePayment.findUnique({
      where: { pagarmeOrderId: input.pagarmeOrderId },
    });
    let payment: any;
    if (existing) {
      payment = existing;
      this.logger.log(
        `[pagarme] forceLinkPaid: order ${input.pagarmeOrderId} já existia no banco (status=${existing.status})`,
      );
    } else {
      payment = await (this.prisma as any).pagarmePayment.create({
        data: {
          saleId: input.saleId,
          storeCode: input.storeCode,
          pagarmeOrderId: input.pagarmeOrderId,
          method: 'checkout',
          valor: input.valor,
          status: 'pending',
        },
      });
      this.logger.log(
        `[pagarme] forceLinkPaid: criado PagarmePayment pra order ${input.pagarmeOrderId} (sale=${input.saleId})`,
      );
    }

    // 2) Consulta status ao vivo na Pagar.me (fonte da verdade)
    let liveStatus: string = 'unknown';
    let isPaid = false;
    try {
      const live = await this.checkOrderStatus(input.pagarmeOrderId);
      liveStatus = live.status;
      isPaid = live.isPaid;
    } catch (e: any) {
      this.logger.warn(
        `[pagarme] forceLinkPaid: falha ao consultar status ao vivo: ${e?.message || e}`,
      );
    }

    // 3) Decide status final: se admin forçou paid, vale; senão, usa status ao vivo
    const finalStatus = input.forceStatus === 'paid'
      ? 'paid'
      : (isPaid ? 'paid' : (liveStatus === 'unknown' ? payment.status : liveStatus));

    if (finalStatus !== payment.status) {
      await (this.prisma as any).pagarmePayment.update({
        where: { pagarmeOrderId: input.pagarmeOrderId },
        data: {
          status: finalStatus,
          paidAt: finalStatus === 'paid' ? new Date() : null,
        },
      });
      this.logger.log(
        `[pagarme] forceLinkPaid: status atualizado ${payment.status} → ${finalStatus}`,
      );
    }

    return {
      ok: true,
      saleId: input.saleId,
      pagarmeOrderId: input.pagarmeOrderId,
      statusBefore: payment.status,
      statusAfter: finalStatus,
      liveStatus,
      isPaid: finalStatus === 'paid',
    };
  }

  /**
   * Lista Links Pagar.me PENDENTES de uma loja (vendas pausadas/abertas
   * aguardando o cliente pagar). Usado pelo widget global do PDV pra alertar
   * a vendedora quando o webhook bate paid e tem venda pronta pra finalizar.
   *
   * Retorna pra cada item:
   *   - dados da venda (cliente, total, código curto)
   *   - URL do link Pagar.me
   *   - status (pending/paid/failed) — vem do PagarmePayment atualizado via webhook
   *
   * Filtra:
   *   - method = 'checkout' (só links, não PIX presencial)
   *   - venda status open ou paused (não finalizada nem cancelada)
   *   - PagarmePayment criado nas últimas 48h (evita lista infinita)
   */
  async listOnlinePending(storeCode: string) {
    if (!storeCode) return [];
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const items = await (this.prisma as any).pagarmePayment.findMany({
      where: {
        method: 'checkout',
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    if (!items.length) return [];
    const saleIds = items.map((i: any) => i.saleId);
    const sales = await (this.prisma as any).pdvSale.findMany({
      where: {
        id: { in: saleIds },
        storeCode,
        status: { in: ['open', 'paused'] },
      },
      select: {
        id: true,
        total: true,
        status: true,
        storeCode: true,
        customerName: true,
        customerCpf: true,
        customerPhone: true,
        sellerName: true,
        vendedorName: true,
        createdAt: true,
      },
    });
    const saleById = new Map<string, any>(sales.map((s: any) => [s.id, s]));
    return items
      .filter((it: any) => saleById.has(it.saleId))
      .map((it: any) => {
        const s = saleById.get(it.saleId);
        return {
          saleId: s.id,
          saleCode: s.id.slice(-6).toUpperCase(),
          saleStatus: s.status,
          customerName: s.customerName,
          customerCpf: s.customerCpf,
          customerPhone: s.customerPhone,
          sellerName: s.sellerName || s.vendedorName || null,
          total: Number(s.total) || 0,
          pagarmeOrderId: it.pagarmeOrderId,
          paymentUrl: it.qrCodeText || null, // URL salvo no campo qrCodeText
          status: it.status, // pending | paid | failed | canceled
          paidAt: it.paidAt,
          createdAt: it.createdAt,
        };
      });
  }
}
