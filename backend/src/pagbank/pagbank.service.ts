import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';

/**
 * PagBank — integração via Order API moderna (REST/JSON com Bearer Token).
 *
 * Conta ÚNICA Lurd's (CNPJ matriz) → todo PIX cai na mesma conta.
 * Diferenciação por loja é feita via `reference_id` da Order que carrega
 * `storeCode` (pra conciliar depois quem vendeu o quê).
 *
 * Endpoints PagBank usados:
 *   - POST /orders                        → cria order com PIX
 *   - GET  /orders/:id                    → consulta status
 *   - POST <webhook url cadastrado>       → recebe notificação assíncrona
 *
 * Ambientes:
 *   - sandbox:    https://sandbox.api.pagseguro.com
 *   - production: https://api.pagseguro.com
 *
 * Webhook security: PagBank envia header `x-authenticity-token` com HMAC
 * SHA-256 do body usando o webhookSecret cadastrado.
 */
@Injectable()
export class PagbankService {
  private readonly logger = new Logger(PagbankService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
  ) {}

  // ── Config ──────────────────────────────────────────────────────────

  /**
   * GET config. Se reveal=true, retorna token+secret em texto puro
   * (usado pelo admin pra copiar/colar — ex: replicar pra outro sistema).
   * Sem reveal, retorna apenas flags `hasToken`/`hasWebhookSecret`.
   */
  async getConfig(reveal: boolean = false) {
    let cfg = await (this.prisma as any).pagbankConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!cfg) {
      // Cria registro singleton vazio na primeira leitura
      cfg = await (this.prisma as any).pagbankConfig.create({
        data: { id: 'singleton' },
      });
    }
    const base = {
      ambiente: cfg.ambiente,
      enabled: cfg.enabled,
      email: cfg.email || null,
      hasToken: !!cfg.bearerToken,
      hasWebhookSecret: !!cfg.webhookSecret,
    };
    if (reveal) {
      return {
        ...base,
        bearerToken: cfg.bearerToken || null,
        webhookSecret: cfg.webhookSecret || null,
      };
    }
    return base;
  }

  async setConfig(input: {
    ambiente?: 'sandbox' | 'production';
    email?: string;
    bearerToken?: string;
    webhookSecret?: string;
    enabled?: boolean;
  }) {
    const data: any = {};
    if (input.ambiente) data.ambiente = input.ambiente;
    if (input.email != null) data.email = input.email.trim() || null;
    if (input.enabled != null) data.enabled = input.enabled;
    // Sensíveis: só sobrescreve se vier valor preenchido
    if (input.bearerToken && input.bearerToken.trim()) {
      // Remove espaços, quebras de linha, tabs e prefixo "Bearer " (caso colem com)
      data.bearerToken = input.bearerToken
        .replace(/\s+/g, '')
        .replace(/^Bearer/i, '')
        .trim();
    }
    if (input.webhookSecret && input.webhookSecret.trim()) {
      data.webhookSecret = input.webhookSecret.trim();
    }

    await (this.prisma as any).pagbankConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...data },
      update: data,
    });

    return this.getConfig();
  }

  /**
   * Lê config interna (com token e secret) — uso INTERNO do service.
   */
  private async getConfigInternal() {
    const cfg = await (this.prisma as any).pagbankConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!cfg) throw new BadRequestException('PagBank não configurado');
    if (!cfg.enabled) throw new BadRequestException('PagBank desabilitado');
    if (!cfg.bearerToken) throw new BadRequestException('Bearer Token PagBank não cadastrado');
    return cfg;
  }

  /**
   * Resolve config PagBank pra uma loja. Prioridade:
   *  1. PagbankStoreConfig com storeCode = X e enabled=true → conta PROPRIA
   *  2. Fallback: singleton PagbankConfig (matriz)
   *
   * Retorna config completa (com token+secret) pra uso interno.
   * Identifica fonte via campo `source` ('store' | 'singleton') pra log.
   */
  private async getConfigInternalForStore(storeCode: string): Promise<any> {
    if (storeCode) {
      try {
        const storeCfg = await (this.prisma as any).pagbankStoreConfig.findUnique({
          where: { storeCode },
        });
        if (storeCfg && storeCfg.enabled && storeCfg.bearerToken) {
          this.logger.log(`[pagbank] usando config da loja ${storeCode} (conta: ${storeCfg.contaLabel || 'sem label'})`);
          return { ...storeCfg, source: 'store' };
        }
      } catch (e) {
        // tabela pode nao existir ainda em dev — segue pro singleton
        this.logger.warn(`[pagbank] PagbankStoreConfig nao acessivel: ${(e as Error).message}`);
      }
    }
    const singleton = await this.getConfigInternal();
    this.logger.log(`[pagbank] usando config singleton (matriz) — loja ${storeCode} sem config propria`);
    return { ...singleton, source: 'singleton' };
  }

  isEnabled(): Promise<boolean> {
    return (this.prisma as any).pagbankConfig
      .findUnique({ where: { id: 'singleton' } })
      .then((c: any) => !!(c?.enabled && c?.bearerToken))
      .catch(() => false);
  }

  // ── Config por loja ────────────────────────────────────────────────

  /**
   * Lista configs por loja (sem expor tokens/secrets) + info da matriz.
   * Usado pela tela admin pra mostrar status de cada loja.
   */
  async listStoreConfigs(): Promise<Array<{
    storeCode: string;
    ambiente: string;
    email: string | null;
    enabled: boolean;
    hasToken: boolean;
    hasWebhookSecret: boolean;
    contaLabel: string | null;
  }>> {
    const rows: any[] = await (this.prisma as any).pagbankStoreConfig.findMany({
      orderBy: { storeCode: 'asc' },
    });
    return rows.map((r) => ({
      storeCode: r.storeCode,
      ambiente: r.ambiente,
      email: r.email || null,
      enabled: r.enabled,
      hasToken: !!r.bearerToken,
      hasWebhookSecret: !!r.webhookSecret,
      contaLabel: r.contaLabel || null,
    }));
  }

  async getStoreConfig(storeCode: string, reveal: boolean = false): Promise<any> {
    const r: any = await (this.prisma as any).pagbankStoreConfig.findUnique({
      where: { storeCode },
    });
    if (!r) return null;
    const base = {
      storeCode: r.storeCode,
      ambiente: r.ambiente,
      email: r.email || null,
      enabled: r.enabled,
      hasToken: !!r.bearerToken,
      hasWebhookSecret: !!r.webhookSecret,
      contaLabel: r.contaLabel || null,
    };
    if (reveal) {
      return {
        ...base,
        bearerToken: r.bearerToken || null,
        webhookSecret: r.webhookSecret || null,
      };
    }
    return base;
  }

  async setStoreConfig(storeCode: string, input: {
    ambiente?: 'sandbox' | 'production';
    email?: string;
    bearerToken?: string;
    webhookSecret?: string;
    enabled?: boolean;
    contaLabel?: string;
  }): Promise<any> {
    if (!storeCode) throw new BadRequestException('storeCode obrigatorio');
    const data: any = {};
    if (input.ambiente) data.ambiente = input.ambiente;
    if (input.email != null) data.email = input.email.trim() || null;
    if (input.enabled != null) data.enabled = input.enabled;
    if (input.contaLabel != null) data.contaLabel = input.contaLabel.trim().slice(0, 80) || null;
    // Sensiveis: so sobrescreve se vier valor preenchido
    if (input.bearerToken && input.bearerToken.trim()) {
      data.bearerToken = input.bearerToken
        .replace(/\s+/g, '')
        .replace(/^Bearer/i, '')
        .trim();
    }
    if (input.webhookSecret && input.webhookSecret.trim()) {
      data.webhookSecret = input.webhookSecret.trim();
    }
    await (this.prisma as any).pagbankStoreConfig.upsert({
      where: { storeCode },
      create: { storeCode, ...data },
      update: data,
    });
    return this.getStoreConfig(storeCode);
  }

  async removeStoreConfig(storeCode: string): Promise<{ ok: boolean }> {
    try {
      await (this.prisma as any).pagbankStoreConfig.delete({ where: { storeCode } });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  // ── PIX — criar order ──────────────────────────────────────────────

  /**
   * Cria uma order PIX no PagBank pra UMA venda do PDV.
   *
   * Recebe valor em REAIS (ex: 153.10) — converte pra centavos no body.
   * Reference_id = `<saleId>:<storeCode>` pra conciliação posterior.
   *
   * Retorna QR Code (text + image base64) + dados pra frontend exibir.
   */
  async createPixCharge(input: {
    saleId: string;
    valor: number;
    storeCode: string;
    customerName?: string;
    customerCpf?: string;
    customerEmail?: string;
    expiresInMinutes?: number;
  }): Promise<{
    pagbankOrderId: string;
    qrCodeText: string;
    qrCodeImageB64: string;
    expiresAt: Date;
    valor: number;
  }> {
    if (!input.saleId) throw new BadRequestException('saleId obrigatório');
    if (!input.valor || input.valor <= 0)
      throw new BadRequestException('Valor deve ser > 0');
    if (!input.storeCode) throw new BadRequestException('storeCode obrigatório');

    // CRITICO: resolve config da LOJA (com fallback pra singleton matriz).
    // Cada loja tem seu CNPJ + conta PagBank propria. Dinheiro cai direto
    // na conta correta sem depender de transfer manual depois.
    const cfg = await this.getConfigInternalForStore(input.storeCode);

    // Centavos (PagBank espera amount.value em centavos)
    const valorCentavos = Math.round(input.valor * 100);
    const expiresInSec = Math.max(60, (input.expiresInMinutes || 15) * 60);
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);

    const baseUrl = this.getBaseUrl(cfg.ambiente);
    const url = `${baseUrl}/orders`;

    // Customer COMPLETO — PagBank exige nome+email+tax_id+phones senão rejeita.
    // Quando vendedora não identificou cliente, usamos defaults seguros.
    const customerName = (input.customerName || 'Consumidor Final').slice(0, 60);
    const customerEmail = input.customerEmail || 'consumidor@lurds.com.br';
    let customerCpf = (input.customerCpf || '').replace(/\D/g, '');
    // PagBank EXIGE tax_id valido (sandbox e producao). Quando cliente nao
    // informou CPF, mandamos um CPF valido generico que representa "consumidor
    // nao identificado". 11144477735 e valido pelos digitos verificadores e
    // nao pertence a ninguem real — equivalente ao "CPF 000.000.000-00" do PDV
    // (mas sem trigger fiscal). Esse e o padrao aceito pra venda anonima.
    if (!customerCpf || customerCpf.length !== 11) {
      customerCpf = '11144477735';
    }

    const body: any = {
      reference_id: `${input.saleId}:${input.storeCode}`.slice(0, 64),
      customer: {
        name: customerName,
        email: customerEmail,
        ...(customerCpf && customerCpf.length === 11 ? { tax_id: customerCpf } : {}),
        // PagBank exige phones em alguns casos. Manda default
        // se não foi informado pra evitar rejection.
        phones: [
          {
            country: '55',
            area: '13',
            number: '999999999',
            type: 'MOBILE',
          },
        ],
      },
      items: [
        {
          reference_id: input.saleId.slice(-12),
          name: `Venda PDV ${input.saleId.slice(-6).toUpperCase()}`,
          quantity: 1,
          unit_amount: valorCentavos,
        },
      ],
      qr_codes: [
        {
          amount: { value: valorCentavos },
          // ISO sem milissegundos, com offset BR (-03:00) — formato que
          // PagBank parece aceitar melhor
          expiration_date: this.formatPagbankDate(expiresAt),
        },
      ],
    };

    // notification_urls é onde PagBank manda webhook quando o status mudar.
    // Só anexa se temos URL pública configurada (em dev pode não ter).
    const webhook = this.getWebhookUrl();
    if (webhook) {
      body.notification_urls = [webhook];
    }

    let resp: any;
    try {
      // NÃO mandar x-api-version — esse header força modo OAuth JWT.
      // Sem ele, a API aceita o token UUID clássico (PagSeguro Classic).
      resp = await firstValueFrom(
        this.http.post(url, body, {
          headers: {
            Authorization: `Bearer ${cfg.bearerToken}`,
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
        `[pagbank] createPixCharge HTTP ${status} pra sale=${input.saleId}: ${JSON.stringify(data || e?.message)}\nBODY ENVIADO: ${JSON.stringify(body)}`,
      );
      // Concatena TODOS os erros do PagBank, não só o primeiro
      const errMsgs = Array.isArray(data?.error_messages)
        ? data.error_messages
            .map((em: any) => `${em.parameter_name || em.code}: ${em.description}`)
            .join(' | ')
        : null;
      throw new BadRequestException(
        `PagBank rejeitou: ${errMsgs || data?.message || e?.message || 'erro desconhecido'}`,
      );
    }

    const order = resp.data;
    const orderId = order.id;
    const qr = order.qr_codes?.[0];
    if (!qr) {
      this.logger.error(`[pagbank] order criada mas sem qr_code: ${JSON.stringify(order)}`);
      throw new BadRequestException('PagBank não retornou QR Code');
    }

    // Texto copia-e-cola (BR Code EMV)
    const qrCodeText = qr.text || qr.payload || '';
    // Imagem PNG: pode vir em links[].href com rel='QRCODE.PNG' ou direto em qr.image
    let qrCodeImageB64 = '';
    const pngLink = (qr.links || []).find(
      (l: any) =>
        l.rel === 'QRCODE.PNG' || l.rel === 'qr_code.png' || /png/i.test(l.media || ''),
    );
    if (pngLink?.href) {
      // Faz download da imagem e converte pra base64 pro frontend exibir
      try {
        const imgResp = await firstValueFrom(
          this.http.get(pngLink.href, {
            responseType: 'arraybuffer',
            timeout: 10000,
          }),
        );
        qrCodeImageB64 = Buffer.from(imgResp.data).toString('base64');
      } catch (e: any) {
        this.logger.warn(`[pagbank] falha ao baixar imagem QR: ${e?.message || e}`);
      }
    }

    // Persiste registro
    await (this.prisma as any).pagbankPayment.create({
      data: {
        saleId: input.saleId,
        storeCode: input.storeCode,
        pagbankOrderId: orderId,
        method: 'pix',
        valor: input.valor,
        status: 'pending',
        qrCodeText,
        qrCodeImageB64,
        expiresAt,
      },
    });

    this.logger.log(
      `[pagbank] PIX criado: order=${orderId} sale=${input.saleId} loja=${input.storeCode} R$${input.valor.toFixed(2)}`,
    );

    return {
      pagbankOrderId: orderId,
      qrCodeText,
      qrCodeImageB64,
      expiresAt,
      valor: input.valor,
    };
  }

  /**
   * Consulta status atual da order (polling fallback se webhook atrasar).
   * Busca PagbankPayment pra descobrir QUAL loja criou — assim usa o
   * token CORRETO daquela loja pra consultar.
   */
  async checkOrderStatus(pagbankOrderId: string) {
    // Descobre loja que originou a order pra usar o token correto.
    let storeCode = '';
    try {
      const p: any = await (this.prisma as any).pagbankPayment.findUnique({
        where: { pagbankOrderId },
        select: { storeCode: true },
      });
      storeCode = p?.storeCode || '';
    } catch {
      // continua sem storeCode — vai pro singleton
    }
    const cfg = storeCode
      ? await this.getConfigInternalForStore(storeCode)
      : await this.getConfigInternal();
    const url = `${this.getBaseUrl(cfg.ambiente)}/orders/${pagbankOrderId}`;

    const resp = await firstValueFrom(
      this.http.get(url, {
        headers: {
          Authorization: `Bearer ${cfg.bearerToken}`,
          Accept: 'application/json',
        },
        timeout: 10000,
      }),
    );

    const order = resp.data;
    const charge = (order.charges || [])[0];
    const isPaid = charge?.status === 'PAID';
    const isCancelled = charge?.status === 'CANCELED' || charge?.status === 'DECLINED';

    let newStatus: string = 'pending';
    if (isPaid) newStatus = 'paid';
    else if (isCancelled) newStatus = 'cancelled';

    // Atualiza local
    const local = await (this.prisma as any).pagbankPayment.findUnique({
      where: { pagbankOrderId },
    });
    if (local && local.status !== newStatus) {
      await (this.prisma as any).pagbankPayment.update({
        where: { pagbankOrderId },
        data: {
          status: newStatus,
          paidAt: isPaid ? new Date() : null,
        },
      });
    }

    return {
      pagbankOrderId,
      status: newStatus,
      isPaid,
      raw: order,
    };
  }

  // ── Webhook handler ────────────────────────────────────────────────

  /**
   * Valida assinatura HMAC do webhook (header x-authenticity-token).
   */
  validateWebhookSignature(rawBody: string, headerSignature: string | undefined, secret: string): boolean {
    if (!headerSignature || !secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    // PagBank pode enviar com prefix "sha256=" ou puro
    const normalized = headerSignature.replace(/^sha256=/, '').toLowerCase();
    return normalized === expected;
  }

  /**
   * Processa o payload do webhook. Idempotente: se já foi processado,
   * ignora.
   */
  async handleWebhook(payload: any, rawBody?: string, signature?: string): Promise<{ ok: boolean; saleId?: string; status?: string; statusChanged?: boolean }> {
    // Tenta validar assinatura (não bloqueia em sandbox se config sem secret)
    try {
      const cfg = await (this.prisma as any).pagbankConfig.findUnique({
        where: { id: 'singleton' },
      });
      if (cfg?.webhookSecret && rawBody) {
        const ok = this.validateWebhookSignature(rawBody, signature, cfg.webhookSecret);
        if (!ok) {
          this.logger.warn('[pagbank] webhook signature inválida — ignorando');
          return { ok: false };
        }
      }
    } catch (e: any) {
      this.logger.warn(`[pagbank] webhook signature check falhou: ${e?.message}`);
    }

    // Estrutura típica: { id, reference_id, charges: [{id, status, ...}] }
    const orderId = payload?.id;
    if (!orderId) {
      this.logger.warn(`[pagbank] webhook sem orderId: ${JSON.stringify(payload).slice(0, 300)}`);
      return { ok: false };
    }

    const charge = (payload.charges || [])[0];
    const status = String(charge?.status || '').toUpperCase();

    let newStatus: string = 'pending';
    if (status === 'PAID') newStatus = 'paid';
    else if (status === 'CANCELED' || status === 'DECLINED') newStatus = 'cancelled';
    else if (status === 'EXPIRED') newStatus = 'expired';

    const local = await (this.prisma as any).pagbankPayment.findUnique({
      where: { pagbankOrderId: orderId },
    });

    if (!local) {
      this.logger.warn(`[pagbank] webhook pra order desconhecida: ${orderId}`);
      return { ok: false };
    }

    // Idempotência: se já tá no mesmo status, só atualiza raw
    if (local.status === newStatus) {
      await (this.prisma as any).pagbankPayment.update({
        where: { pagbankOrderId: orderId },
        data: { rawWebhook: JSON.stringify(payload).slice(0, 5000) },
      });
      // statusChanged=false → controller não deve disparar baixa (já disparou antes)
      return { ok: true, saleId: local.saleId, status: newStatus, statusChanged: false };
    }

    await (this.prisma as any).pagbankPayment.update({
      where: { pagbankOrderId: orderId },
      data: {
        status: newStatus,
        paidAt: newStatus === 'paid' ? new Date() : null,
        pagbankChargeId: charge?.id || null,
        rawWebhook: JSON.stringify(payload).slice(0, 5000),
      },
    });

    this.logger.log(
      `[pagbank] webhook: order=${orderId} sale=${local.saleId} ${local.status} → ${newStatus}`,
    );

    // statusChanged=true → controller deve disparar confirmBaixaPixIfExists (1ª vez que virou paid)
    return { ok: true, saleId: local.saleId, status: newStatus, statusChanged: true };
  }

  // ── Listagem (pra dashboard de PIX) ────────────────────────────────

  async listPayments(input: { saleId?: string; status?: string; limit?: number }) {
    const where: any = {};
    if (input.saleId) where.saleId = input.saleId;
    if (input.status) where.status = input.status;
    return (this.prisma as any).pagbankPayment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, input.limit || 50),
    });
  }

  /**
   * Consulta o status PIX de uma venda específica (frontend chama em loop
   * curto enquanto modal de PIX está aberto, só pra UX rápida — webhook
   * é o caminho oficial).
   */
  async getPaymentBySale(saleId: string) {
    return (this.prisma as any).pagbankPayment.findFirst({
      where: { saleId, method: 'pix' },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Diagnóstico ─────────────────────────────────────────────────────

  /**
   * DIAGNÓSTICO AMPLO: testa o token contra vários endpoints PagBank
   * pra descobrir QUAL API ele atende. Útil quando token é UUID legacy
   * mas as APIs novas (Orders/Charges) podem não aceitá-lo.
   */
  async deepDiagnose(): Promise<{
    ambiente: string;
    token: { length: number; format: string };
    email: string | null;
    endpoints: Array<{
      name: string;
      method: string;
      url: string;
      status: number | string;
      ok: boolean;
      response?: any;
    }>;
    recommendation: string;
  }> {
    const cfg = await (this.prisma as any).pagbankConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!cfg?.bearerToken) throw new BadRequestException('Token não cadastrado');

    const token = (cfg.bearerToken || '').trim();
    const ambiente = cfg.ambiente || 'sandbox';
    const baseModern = ambiente === 'production' ? 'https://api.pagseguro.com' : 'https://sandbox.api.pagseguro.com';
    const baseClassic = ambiente === 'production' ? 'https://ws.pagseguro.uol.com.br' : 'https://ws.sandbox.pagseguro.uol.com.br';

    // Detecta formato do token
    const isUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(token);
    const isJwt = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(token);
    const tokenFormat = isUuid ? 'UUID legacy (v2/v3)' : isJwt ? 'JWT (OAuth)' : `Outro (${token.length} chars)`;

    const tests = [
      // 1. API Moderna - Orders
      { name: 'Orders API moderna', method: 'POST', url: `${baseModern}/orders`, body: {}, useBearer: true },
      // 2. API Moderna - Charges
      { name: 'Charges API moderna', method: 'POST', url: `${baseModern}/charges`, body: {}, useBearer: true },
      // 3. API Moderna - PIX QR Codes diretos
      { name: 'PIX QR-Codes', method: 'POST', url: `${baseModern}/pix/qr-codes`, body: {}, useBearer: true },
      // 4. API Classic v2 — sessão (XML, com email+token query)
      {
        name: 'Classic v2 (sessions)',
        method: 'POST',
        url: `${baseClassic}/v2/sessions?email=${encodeURIComponent(cfg.email || '')}&token=${token}`,
        body: '',
        useBearer: false,
      },
      // 5. API Classic v3 — pre-approvals
      {
        name: 'Classic v3 (info)',
        method: 'GET',
        url: `${baseClassic}/v3/transactions?email=${encodeURIComponent(cfg.email || '')}&token=${token}&initialDate=2026-01-01T00:00&finalDate=2026-12-31T23:59`,
        body: null,
        useBearer: false,
      },
    ];

    const results: any[] = [];
    for (const t of tests) {
      try {
        const headers: any = {
          Accept: 'application/json',
        };
        if (t.method === 'POST' && t.body !== '' && t.body !== null) {
          headers['Content-Type'] = 'application/json';
        } else if (t.body === '') {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        if (t.useBearer) {
          headers.Authorization = `Bearer ${token}`;
        }

        const resp = await firstValueFrom(
          (t.method === 'GET'
            ? this.http.get(t.url, { headers, timeout: 8000, validateStatus: () => true })
            : this.http.post(t.url, t.body, {
                headers,
                timeout: 8000,
                validateStatus: () => true,
              })) as any,
        );
        const status = (resp as any).status;
        // 2xx, 4xx (validation) = autenticou. 401/403 = NÃO autenticou.
        const ok = status < 401 || (status >= 422 && status < 500);
        const data = (resp as any).data;
        results.push({
          name: t.name,
          method: t.method,
          url: t.url.replace(token, 'TOKEN_REDACTED').slice(0, 100),
          status,
          ok,
          response:
            typeof data === 'string'
              ? data.slice(0, 200)
              : JSON.stringify(data || {}).slice(0, 200),
        });
      } catch (e: any) {
        results.push({
          name: t.name,
          method: t.method,
          url: t.url.replace(token, 'TOKEN_REDACTED').slice(0, 100),
          status: 'ERRO',
          ok: false,
          response: e?.message || String(e),
        });
      }
    }

    // Determina recomendação baseada nos resultados
    const okEndpoint = results.find((r) => r.ok);
    const recommendation = okEndpoint
      ? `Token aceito por: ${okEndpoint.name} (HTTP ${okEndpoint.status}). Vou plugar a integração nesse endpoint.`
      : 'Nenhum endpoint aceitou o token. Pode ser problema de credencial OU a app PagBank não tem permissão pra essas APIs. Confira em portaldev.pagbank.com.br ou abre chamado no suporte PagBank.';

    return {
      ambiente,
      token: { length: token.length, format: tokenFormat },
      email: cfg.email || null,
      endpoints: results,
      recommendation,
    };
  }

  /**
   * CRIA UM PIX REAL EM SANDBOX e retorna request + response completos.
   * Evidência exigida pela PagBank (Nathalia, Chamado 1360753759) pra
   * homologar a integração e liberar production.
   *
   * Bloqueado em production por segurança — só roda se ambiente=sandbox.
   * Valor R$ 1,00 (centavos = 100). Sale fake com prefixo "test-sandbox-".
   */
  async createTestPixSandbox(): Promise<{
    ok: boolean;
    status: number;
    request: { url: string; method: string; headers: any; body: any };
    response: any;
    qrCodeText?: string;
    qrCodeImageUrl?: string;
    pagbankOrderId?: string;
    error?: string;
    hint?: string;
  }> {
    const cfg = await this.getConfigInternal();
    if (cfg.ambiente !== 'sandbox') {
      throw new BadRequestException(
        'Mude o ambiente pra SANDBOX antes de gerar evidência. ' +
        'Production só depois da homologação aprovada pela Nathalia.',
      );
    }

    const fakeSaleId = `test-sandbox-${Date.now()}`;
    const valorCentavos = 100; // R$ 1,00
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const baseUrl = this.getBaseUrl(cfg.ambiente);
    const url = `${baseUrl}/orders`;

    // Body exatamente no formato da doc PagBank (Criar pedido com QR Code)
    const body: any = {
      reference_id: fakeSaleId.slice(0, 64),
      customer: {
        name: 'Jose da Silva',
        email: 'email@test.com',
        tax_id: '12345678909',
        phones: [
          { country: '55', area: '11', number: '999999999', type: 'MOBILE' },
        ],
      },
      items: [
        {
          reference_id: 'TEST-SANDBOX',
          name: 'Teste sandbox PagBank QR Code',
          quantity: 1,
          unit_amount: valorCentavos,
        },
      ],
      qr_codes: [
        {
          amount: { value: valorCentavos },
          expiration_date: this.formatPagbankDate(expiresAt),
        },
      ],
      notification_urls: [this.getWebhookUrl() || 'https://meusite.com/notificacoes'],
    };

    // Headers que vão na request (Authorization redacted no retorno)
    const requestHeaders = {
      Authorization: `Bearer ${cfg.bearerToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const safeHeaders = { ...requestHeaders, Authorization: 'Bearer <REDACTED>' };

    let httpStatus = 0;
    let respBody: any = null;
    try {
      const resp = await firstValueFrom(
        this.http.post(url, body, {
          headers: requestHeaders,
          timeout: 15000,
          validateStatus: () => true,
        }),
      );
      httpStatus = (resp as any).status;
      respBody = (resp as any).data;
    } catch (e: any) {
      this.logger.error(`[pagbank] testPixSandbox falhou: ${e?.message || e}`);
      return {
        ok: false,
        status: 0,
        request: { url, method: 'POST', headers: safeHeaders, body },
        response: null,
        error: e?.message || String(e),
        hint: 'Sem resposta HTTP — possivelmente DNS/rede. Verifique se backend tem acesso a sandbox.api.pagseguro.com',
      };
    }

    const ok = httpStatus >= 200 && httpStatus < 300;
    const qr = respBody?.qr_codes?.[0];
    const pngLink = (qr?.links || []).find(
      (l: any) => l.rel === 'QRCODE.PNG' || l.rel === 'qr_code.png' || /png/i.test(l.media || ''),
    );

    return {
      ok,
      status: httpStatus,
      request: { url, method: 'POST', headers: safeHeaders, body },
      response: respBody,
      qrCodeText: qr?.text || qr?.payload,
      qrCodeImageUrl: pngLink?.href,
      pagbankOrderId: respBody?.id,
      hint: ok
        ? 'Evidência pronta. Copie o JSON acima e envie pra Nathalia (Chamado 1360753759) no email matriz@lurds.com.br'
        : `HTTP ${httpStatus} — confira mensagem em response.error_messages. Token sandbox correto?`,
    };
  }

  /**
   * Testa conexão com o PagBank usando o token salvo.
   * Faz uma chamada barata (GET /public-keys) só pra validar autenticação.
   */
  async testConnection(): Promise<{
    ok: boolean;
    ambiente: string;
    enabled: boolean;
    hasToken: boolean;
    httpStatus?: number;
    error?: string;
    hint?: string;
  }> {
    const cfg = await (this.prisma as any).pagbankConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!cfg) {
      return {
        ok: false,
        ambiente: 'sandbox',
        enabled: false,
        hasToken: false,
        error: 'Config não criada — abra a tela e salve uma vez',
      };
    }
    if (!cfg.bearerToken) {
      return {
        ok: false,
        ambiente: cfg.ambiente,
        enabled: !!cfg.enabled,
        hasToken: false,
        error: 'Bearer Token não cadastrado',
        hint: 'Cole o Bearer Token na tela e salve',
      };
    }

    const baseUrl = this.getBaseUrl(cfg.ambiente);
    // Testa com POST /orders payload vazio. Se token tá OK → 400 (validation).
    // Se token tá errado → 401 ou 403. Bem mais conclusivo que GET /public-keys.
    const url = `${baseUrl}/orders`;
    try {
      const resp = await firstValueFrom(
        this.http.post(
          url,
          {},
          {
            headers: {
              Authorization: `Bearer ${(cfg.bearerToken || '').trim()}`,
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            timeout: 10000,
            validateStatus: (s) => s < 600,
          },
        ),
      );
      const httpStatus = resp.status;
      // 400/422 = token OK mas payload inválido (era esperado)
      // 401/403 = token rejeitado
      if (httpStatus === 400 || httpStatus === 422) {
        return {
          ok: true,
          ambiente: cfg.ambiente,
          enabled: !!cfg.enabled,
          hasToken: true,
          httpStatus,
        };
      }
      if (httpStatus === 401 || httpStatus === 403) {
        const data = resp.data;
        return {
          ok: false,
          ambiente: cfg.ambiente,
          enabled: !!cfg.enabled,
          hasToken: true,
          httpStatus,
          error:
            data?.error_messages?.[0]?.description ||
            data?.error_messages?.[0]?.code ||
            data?.message ||
            `Token rejeitado pela PagBank (${httpStatus})`,
          hint:
            cfg.ambiente === 'sandbox'
              ? 'Token deve ser gerado em portaldev.pagbank.com.br → Tokens (NÃO em dev.pagbank.uol.com.br). Cuidado com espaços ao colar.'
              : 'Confirme que é token de produção e que a app tem permissões orders.create/pix.create',
        };
      }
      // Status inesperado — devolve pra debug
      return {
        ok: false,
        ambiente: cfg.ambiente,
        enabled: !!cfg.enabled,
        hasToken: true,
        httpStatus,
        error: `HTTP ${httpStatus} inesperado: ${JSON.stringify(resp.data || {}).slice(0, 200)}`,
      };
    } catch (e: any) {
      const httpStatus = e?.response?.status;
      const data = e?.response?.data;
      this.logger.error(`[pagbank] testConnection falhou: ${JSON.stringify(data || e?.message)}`);
      return {
        ok: false,
        ambiente: cfg.ambiente,
        enabled: !!cfg.enabled,
        hasToken: true,
        httpStatus,
        error:
          data?.error_messages?.[0]?.description ||
          data?.error_messages?.[0]?.code ||
          e?.message ||
          'Erro desconhecido',
        hint: httpStatus === 401 || httpStatus === 403
          ? 'Token inválido ou expirado — gera novo no Portal Dev PagBank'
          : 'Verifica se o backend tem internet pra api.pagseguro.com',
      };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Formata data ISO 8601 com offset BR (-03:00) sem milissegundos.
   * Formato exigido pelo PagBank em campos como expiration_date.
   */
  private formatPagbankDate(d: Date): string {
    // Cria string ISO sem ms e adiciona offset BR fixo -03:00
    // (sandbox/prod do PagBank esperam timezone BR explícito)
    const offsetMin = -180; // -3h em minutos
    const local = new Date(d.getTime() + offsetMin * 60 * 1000);
    const iso = local.toISOString().replace(/\.\d+Z$/, '');
    return `${iso}-03:00`;
  }

  private getBaseUrl(ambiente: string): string {
    return ambiente === 'production'
      ? 'https://api.pagseguro.com'
      : 'https://sandbox.api.pagseguro.com';
  }

  private getWebhookUrl(): string {
    const base =
      process.env.BACKEND_PUBLIC_URL ||
      process.env.RAILWAY_PUBLIC_DOMAIN ||
      ''; // Pode estar vazio em dev — daí roda sem webhook
    if (!base) return '';
    const cleanBase = base.replace(/\/+$/, '');
    return cleanBase.startsWith('http')
      ? `${cleanBase}/pagbank/webhook`
      : `https://${cleanBase}/pagbank/webhook`;
  }
}
