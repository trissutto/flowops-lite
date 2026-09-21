import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';
import { SELECT_VENDA_COBRANCA, restanteCentsDaVenda } from '../common/cobranca-venda-online';
import { cpfValido } from '../common/dados-cliente-online';
import {
  EstadoLinkPagbank,
  ORIGEM_LINK_PAGBANK,
  estadoDoLinkPagbank,
  linkPagbankVenceEm,
  maxParcelasLink,
  maxTentativasCartaoLink,
  mensagemRecusaCartaoLink,
  referenciaCartaoLink,
} from '../common/link-pagamento-pagbank';
import {
  CartaoPagbankLido,
  erroHttpEhDadoDoCartao,
  lerCartaoPagbank,
  resumirErrosPagbank,
} from '../common/pagbank-cartao';

/**
 * O que uma cobrança do PagBank virou — avisado a quem se inscreveu com
 * `registrarOuvinte`. Nasceu pro pedido do SITE (`origem='site'`): o
 * `LojaOrdersService` se inscreve no boot e confirma/recusa o pedido sem
 * este módulo precisar conhecê-lo (a seta continua de mão única —
 * loja-orders → pagbank — e não nasce ciclo de módulo, que já derrubou o
 * backend em 07/08).
 */
export interface PagbankEventoCobranca {
  saleId: string;
  storeCode: string;
  pagbankOrderId: string;
  method: string;
  origem: string | null;
  status: 'paid' | 'cancelled' | 'expired';
  /** De onde veio a mudança — só pra log. */
  fonte: 'webhook' | 'consulta';
  detalhe?: string;
}

/** Endereço de entrega no formato que a Orders API pede (`shipping.address`). */
export interface PagbankEndereco {
  street: string;
  number: string;
  complement?: string;
  neighborhood: string;
  city: string;
  uf: string;
  cep: string;
}

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
  /** Um aviso por processo — o alerta de "sem webhook" não pode virar ruído. */
  private avisouSemWebhook = false;

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
    /** Celular real da cliente (site). Sem ele vai o placeholder do PDV. */
    customerPhone?: string;
    /** Nome do item na fatura/painel. Sem ele: `Venda PDV <id>`. */
    descricao?: string;
    expiresInMinutes?: number;
    /**
     * 'venda_online' = PIX do painel Venda Online do PDV; 'site' = PIX do
     * checkout de lurds.com.br; 'venda_online_link' = PIX do link de
     * pagamento do PDV (`/pague/<token>`) (ver coluna `origem`).
     */
    origem?: string | null;
  }): Promise<{
    pagbankOrderId: string;
    qrCodeText: string;
    qrCodeImageB64: string;
    expiresAt: Date;
    valor: number;
    /** Token da cobrança (`/qr/<token>` e, no link do PDV, `/pague/<token>`). */
    linkToken: string;
    /**
     * Link público /qr/<token> — é ELE que vai no WhatsApp, não o
     * copia-e-cola cru. O EMV da PagBank tem uma URL no meio
     * (api.pagseguro.com/pix/v2/...) que o WhatsApp pinta de azul; a
     * cliente toca no azul em vez de copiar o código inteiro e não paga.
     * No link curto, tocar é justamente o caminho certo. (/pix/<token>
     * já era do crediário — por isso /qr/.)
     */
    shortUrl: string;
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
          this.telefonePagbank(input.customerPhone) || {
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
          name: (input.descricao || `Venda PDV ${input.saleId.slice(-6).toUpperCase()}`).slice(0, 64),
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
    } else if (!this.avisouSemWebhook) {
      /**
       * SEM URL PÚBLICA, A COBRANÇA NASCE SEM AVISO DE PAGAMENTO.
       *
       * `BACKEND_PUBLIC_URL`/`RAILWAY_PUBLIC_DOMAIN` faltando significa que
       * NENHUMA order tem `notification_urls`: o PagBank não tem pra onde
       * avisar e o pagamento nunca chega sozinho. Isso passava em silêncio
       * absoluto. Hoje o reconciliador cobre (ele pergunta), mas a loja espera
       * até 1 minuto à toa — e é bom saber que a variável sumiu.
       */
      this.avisouSemWebhook = true;
      this.logger.warn(
        '[pagbank] ⚠️ sem BACKEND_PUBLIC_URL/RAILWAY_PUBLIC_DOMAIN — as cobranças ' +
          'estão indo SEM notification_urls (nenhum webhook de pagamento). ' +
          'Quem está confirmando é o reconciliador (PagbankPixReconcileService).',
      );
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

    // Token do link público /pix/<token> — 10 chars sorteados (não dá pra
    // enumerar), mesmo padrão do linkToken do Pagar.me.
    const linkToken = crypto.randomBytes(8).toString('base64url').slice(0, 10);

    // Persiste registro
    await (this.prisma as any).pagbankPayment.create({
      data: {
        saleId: input.saleId,
        storeCode: input.storeCode,
        pagbankOrderId: orderId,
        method: 'pix',
        valor: input.valor,
        status: 'pending',
        // Só o valor conhecido entra; qualquer outra coisa vira null (balcão).
        origem:
          input.origem === 'venda_online' || input.origem === 'site' || input.origem === ORIGEM_LINK_PAGBANK
            ? input.origem
            : null,
        qrCodeText,
        qrCodeImageB64,
        linkToken,
        expiresAt,
      },
    });

    this.logger.log(
      `[pagbank] PIX criado: order=${orderId} sale=${input.saleId} loja=${input.storeCode} R$${input.valor.toFixed(2)}` +
        (input.origem === 'venda_online' ? ' (venda online)' : '') +
        (input.origem === ORIGEM_LINK_PAGBANK ? ' (link de pagamento)' : ''),
    );

    return {
      pagbankOrderId: orderId,
      qrCodeText,
      qrCodeImageB64,
      expiresAt,
      valor: input.valor,
      linkToken,
      shortUrl: `${this.baseUrlPublica()}/qr/${linkToken}`,
    };
  }

  /** Domínio das páginas públicas (o mesmo do /pg/<token> do Pagar.me). */
  private baseUrlPublica(): string {
    return (process.env.FRONTEND_URL || 'https://flowops-lite.vercel.app')
      .split(',')[0]
      .trim()
      .replace(/\/$/, '');
  }

  /**
   * ESTADO DO LINK PÚBLICO /qr/<token> — o que a página aberta pela cliente
   * mostra e o que ela consulta no polling.
   *
   * LÊ SÓ DO NOSSO POSTGRES, nunca da PagBank ao vivo. Quem mantém o status
   * fresco é o webhook + o PagbankPixReconcileService (backoff por idade).
   * Página pública com polling por navegador batendo no gateway foi
   * exatamente o flood que derrubou a live de 01/07 — não reabrir essa porta.
   *
   * Só expõe o que a cliente precisa: valor, QR, copia-e-cola, nome/WhatsApp
   * da loja. Nada de CPF, telefone da cliente ou itens.
   */
  async estadoDoPix(token: string): Promise<{
    estado: 'aguardando' | 'pago' | 'vencido' | 'cancelado' | 'inexistente';
    /**
     * Só no estado `vencido`: true quando o reconciliador JÁ confirmou com a
     * PagBank que não houve pagamento (`status='expired'`). Vencido só pelo
     * relógio (`pending` + expiresAt passado) NÃO é definitivo — a cliente
     * pode ter pago na boca do vencimento e o webhook ainda estar a caminho.
     * A página usa isto pra decidir se para o polling e se pode afirmar
     * "nada foi cobrado".
     */
    definitivo?: boolean;
    valor?: number;
    qrCodeText?: string;
    qrCodeImageB64?: string;
    lojaNome?: string;
    lojaWhatsapp?: string | null;
    expiraEm?: Date | null;
    pagoEm?: Date | null;
  }> {
    const t = String(token || '').trim();
    if (!t) return { estado: 'inexistente' };

    const p: any = await (this.prisma as any).pagbankPayment.findUnique({
      where: { linkToken: t },
    });
    if (!p) return { estado: 'inexistente' };

    const loja = await this.dadosDaLoja(p.storeCode);
    const base = {
      valor: Number(p.valor) || 0,
      lojaNome: loja.nome,
      lojaWhatsapp: loja.whatsapp,
      expiraEm: p.expiresAt ?? null,
      pagoEm: p.paidAt ?? null,
    };

    const status = String(p.status || 'pending');
    if (status === 'paid') return { estado: 'pago', ...base };
    if (status === 'cancelled' || status === 'failed') return { estado: 'cancelado', ...base };
    // `expired` = o reconciliador confirmou com a PagBank que não foi pago.
    if (status === 'expired') return { estado: 'vencido', definitivo: true, ...base };
    // Vencido só pelo relógio: `pending` com expiresAt passado. Pagamento na
    // boca do vencimento ainda pode virar `paid` (webhook/reconciliador a
    // caminho) — a página segue no polling e não afirma "nada foi cobrado".
    if (p.expiresAt && new Date(p.expiresAt).getTime() < Date.now()) {
      return { estado: 'vencido', definitivo: false, ...base };
    }
    return {
      estado: 'aguardando',
      ...base,
      qrCodeText: String(p.qrCodeText || ''),
      qrCodeImageB64: String(p.qrCodeImageB64 || ''),
    };
  }

  /** Nome e WhatsApp da loja — a página pública precisa dar pra quem falar. */
  private async dadosDaLoja(storeCode: string): Promise<{ nome: string; whatsapp: string | null }> {
    try {
      const s: any = await this.prisma.store.findFirst({
        where: { code: String(storeCode) },
        select: { name: true, whatsapp: true } as any,
      });
      return {
        nome: String(s?.name || 'Lurd’s Plus Size'),
        // Já vem em E.164 sem "+" (ex: 5511999999999) — é o que o wa.me quer.
        whatsapp: String(s?.whatsapp || '').replace(/\D/g, '') || null,
      };
    } catch {
      return { nome: 'Lurd’s Plus Size', whatsapp: null };
    }
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

    /**
     * LER **TODAS** AS CHARGES, NÃO SÓ A PRIMEIRA (12/08/2026).
     *
     * `charges[0]` assume que a order tem no máximo uma cobrança. Não tem: uma
     * tentativa recusada/cancelada antes da boa deixa a paga em `charges[1]` —
     * e a consulta respondia "pending" com o dinheiro na conta. Ninguém nota,
     * porque o erro se disfarça de "cliente ainda não pagou".
     *
     * Cancelado só vale quando NÃO existe nenhuma paga: pago vence empate.
     */
    const charges: any[] = Array.isArray(order.charges) ? order.charges : [];
    const st = (x: any) => String(x?.status || '').toUpperCase();
    const chargePaga = charges.find((c) => st(c) === 'PAID');
    // Alguns retornos marcam o pagamento no próprio qr_code, sem charge ainda.
    const qrPago = (order.qr_codes || []).some((q: any) => st(q) === 'PAID');
    const isPaid = !!chargePaga || qrPago;
    const isCancelled =
      !isPaid && charges.some((c) => st(c) === 'CANCELED' || st(c) === 'DECLINED');

    let newStatus: string = 'pending';
    if (isPaid) newStatus = 'paid';
    else if (isCancelled) newStatus = 'cancelled';

    // Atualiza local
    const local = await (this.prisma as any).pagbankPayment.findUnique({
      where: { pagbankOrderId },
    });
    /**
     * PAGO NÃO VOLTA ATRÁS. Uma resposta instável do PagBank (ou uma consulta
     * concorrente) não pode reescrever `paid` → `pending` e apagar o `paidAt`:
     * o reconciliador do PDV procura por `status='paid'`, então rebaixar a
     * linha faz a venda paga sumir da fila de fechamento.
     */
    if (local && local.status !== newStatus && local.status !== 'paid') {
      await (this.prisma as any).pagbankPayment.update({
        where: { pagbankOrderId },
        data: {
          status: newStatus,
          ...(isPaid ? { paidAt: local.paidAt || new Date() } : {}),
          ...(chargePaga?.id ? { pagbankChargeId: chargePaga.id } : {}),
        },
      });
      // Mesmo aviso que o webhook dá: quem se inscreveu (pedido do site)
      // fecha ou recusa o pedido sem esperar o próximo ciclo de ninguém.
      if (newStatus === 'paid' || newStatus === 'cancelled') {
        await this.avisarOuvintes({
          saleId: local.saleId,
          storeCode: local.storeCode,
          pagbankOrderId,
          method: local.method,
          origem: local.origem ?? null,
          status: newStatus,
          fonte: 'consulta',
          detalhe: charges.map((c) => st(c)).join(',') || undefined,
        });
      }
    }

    return {
      pagbankOrderId,
      status: local?.status === 'paid' ? 'paid' : newStatus,
      isPaid: isPaid || local?.status === 'paid',
      raw: order,
    };
  }

  /**
   * Marca uma cobrança como expirada — some da fila do reconciliador.
   *
   * Só o reconciliador chama, e só depois do QR ter vencido há horas COM
   * resposta ao vivo do PagBank dizendo que não foi pago. Sem isto, todo QR
   * abandonado (a cliente desistiu, a vendedora trocou pra cartão) fica
   * `pending` pra sempre e o cron consulta o PagBank por eles até o fim dos
   * tempos.
   */
  async marcarExpirado(pagbankOrderId: string): Promise<void> {
    await (this.prisma as any).pagbankPayment
      .updateMany({
        where: { pagbankOrderId, status: 'pending' },
        data: { status: 'expired' },
      })
      .catch(() => null);
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
   * O `x-authenticity-token` do PagBank NÃO é o HMAC que a gente calculava.
   *
   * A documentação do PagBank define o hash como SHA-256 puro da string
   * `<token da conta>-<corpo cru da notificação>` — sem HMAC, e usando o
   * BEARER TOKEN da conta, não um "webhook secret" separado. Com a fórmula
   * errada, toda notificação assinada era recusada e o pagamento nunca virava
   * `paid` no nosso banco: o dinheiro caía e a venda ficava aberta.
   *
   * Aceita qualquer um dos esquemas conhecidos porque a conta da loja e a da
   * matriz podem assinar com credenciais diferentes, e ainda existem contas
   * antigas com `webhookSecret` cadastrado. O nome do esquema que bateu vai no
   * log — é assim que se descobre, em produção, qual deles a conta usa.
   */
  private conferirAutenticidade(
    rawBody: string,
    header: string | undefined,
    candidatos: Array<{ nome: string; token?: string | null; secret?: string | null }>,
  ): { ok: boolean; esquema?: string } {
    if (!header || !rawBody) return { ok: false };
    const recebido = header.replace(/^sha256=/i, '').trim().toLowerCase();
    const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
    for (const c of candidatos) {
      if (c.token) {
        // Formato documentado pelo PagBank
        if (sha256(`${c.token}-${rawBody}`) === recebido) {
          return { ok: true, esquema: `${c.nome}:sha256(token-body)` };
        }
      }
      if (c.secret) {
        // Legado: como estava implementado aqui até 12/08
        if (sha256(`${c.secret}-${rawBody}`) === recebido) {
          return { ok: true, esquema: `${c.nome}:sha256(secret-body)` };
        }
        if (this.validateWebhookSignature(rawBody, header, c.secret)) {
          return { ok: true, esquema: `${c.nome}:hmac(secret)` };
        }
      }
    }
    return { ok: false };
  }

  /**
   * Processa o payload do webhook. Idempotente: se já foi processado,
   * ignora.
   */
  async handleWebhook(payload: any, rawBody?: string, signature?: string): Promise<{ ok: boolean; saleId?: string; status?: string; statusChanged?: boolean }> {
    // Estrutura típica: { id, reference_id, charges: [{id, status, ...}] }
    const orderId = payload?.id;
    if (!orderId) {
      this.logger.warn(`[pagbank] webhook sem orderId: ${JSON.stringify(payload).slice(0, 300)}`);
      return { ok: false };
    }

    const local = await (this.prisma as any).pagbankPayment.findUnique({
      where: { pagbankOrderId: orderId },
    });

    if (!local) {
      this.logger.warn(`[pagbank] webhook pra order desconhecida: ${orderId}`);
      return { ok: false };
    }

    /**
     * ASSINATURA QUE NÃO BATE VIRA CONSULTA, NÃO LIXO (12/08/2026).
     *
     * O comportamento antigo era `return { ok: false }` — a notificação de
     * pagamento ia pro ralo com um warn, o status ficava `pending` e a venda
     * paga não fechava. Um erro de credencial (conta da loja assinando com
     * token próprio, secret trocado, fórmula errada) virava venda perdida.
     *
     * Agora, quando a conferência falha, a gente NÃO acredita no corpo do
     * webhook: pergunta o status direto pra API do PagBank, que é a única
     * fonte da verdade. Notificação forjada não consegue mentir — no máximo
     * gasta uma consulta. Notificação legítima com assinatura torta continua
     * fechando a venda.
     */
    const cfgLoja = local.storeCode
      ? await (this.prisma as any).pagbankStoreConfig
          .findUnique({ where: { storeCode: local.storeCode } })
          .catch(() => null)
      : null;
    const cfgMatriz = await (this.prisma as any).pagbankConfig
      .findUnique({ where: { id: 'singleton' } })
      .catch(() => null);
    const temAlgoPraConferir = !!(
      cfgLoja?.bearerToken || cfgLoja?.webhookSecret || cfgMatriz?.bearerToken || cfgMatriz?.webhookSecret
    );
    if (temAlgoPraConferir && rawBody) {
      const conf = this.conferirAutenticidade(rawBody, signature, [
        { nome: `loja ${local.storeCode}`, token: cfgLoja?.bearerToken, secret: cfgLoja?.webhookSecret },
        { nome: 'matriz', token: cfgMatriz?.bearerToken, secret: cfgMatriz?.webhookSecret },
      ]);
      if (!conf.ok) {
        this.logger.warn(
          `[pagbank] webhook ${orderId} com assinatura que não confere — ` +
            `confirmando na API do PagBank em vez de descartar`,
        );
        try {
          const live = await this.checkOrderStatus(orderId);
          const virouPago = live.isPaid && local.status !== 'paid';
          return {
            ok: true,
            saleId: local.saleId,
            status: live.status,
            statusChanged: virouPago,
          };
        } catch (e: any) {
          // Sem resposta do gateway: o reconciliador tenta de novo em segundos.
          this.logger.error(
            `[pagbank] webhook ${orderId}: consulta ao vivo falhou (${e?.message || e}) — ` +
              `o reconciliador pega no próximo ciclo`,
          );
          return { ok: false };
        }
      }
      this.logger.debug?.(`[pagbank] webhook ${orderId} autenticado por ${conf.esquema}`);
    }

    const charges: any[] = Array.isArray(payload.charges) ? payload.charges : [];
    const st = (x: any) => String(x?.status || '').toUpperCase();
    // Mesma regra da consulta: qualquer charge paga vale, pago vence empate.
    const charge = charges.find((c) => st(c) === 'PAID') || charges[0];
    const status = st(charge);

    let newStatus: string = 'pending';
    if (charges.some((c) => st(c) === 'PAID')) newStatus = 'paid';
    else if (status === 'CANCELED' || status === 'DECLINED') newStatus = 'cancelled';
    else if (status === 'EXPIRED') newStatus = 'expired';

    // Pago não volta atrás (ver checkOrderStatus): notificação atrasada de
    // status antigo não pode reabrir uma cobrança já confirmada.
    if (local.status === 'paid' && newStatus !== 'paid') {
      await (this.prisma as any).pagbankPayment.update({
        where: { pagbankOrderId: orderId },
        data: { rawWebhook: JSON.stringify(payload).slice(0, 5000) },
      });
      return { ok: true, saleId: local.saleId, status: 'paid', statusChanged: false };
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
        ...(newStatus === 'paid' ? { paidAt: local.paidAt || new Date() } : {}),
        ...(charge?.id ? { pagbankChargeId: charge.id } : {}),
        rawWebhook: JSON.stringify(payload).slice(0, 5000),
      },
    });

    this.logger.log(
      `[pagbank] webhook: order=${orderId} sale=${local.saleId} ${local.status} → ${newStatus}`,
    );

    if (newStatus === 'paid' || newStatus === 'cancelled') {
      await this.avisarOuvintes({
        saleId: local.saleId,
        storeCode: local.storeCode,
        pagbankOrderId: orderId,
        method: local.method,
        origem: local.origem ?? null,
        status: newStatus,
        fonte: 'webhook',
        detalhe: status || undefined,
      });
    }

    // statusChanged=true → controller deve disparar confirmBaixaPixIfExists (1ª vez que virou paid)
    return { ok: true, saleId: local.saleId, status: newStatus, statusChanged: true };
  }

  // ── Ouvintes (pedido do site) ──────────────────────────────────────

  private readonly ouvintes: Array<(ev: PagbankEventoCobranca) => Promise<void> | void> = [];

  /**
   * Inscreve quem precisa saber que uma cobrança virou paga/recusada. Hoje:
   * o `LojaOrdersService`, que confirma (`confirmarPagamento`) ou recusa
   * (`registrarRecusaTardia`) o pedido do site. Um ouvinte que estoura não
   * derruba o webhook nem os outros ouvintes — o reconcile do site (60s)
   * cobre a falha lendo o `status` que já ficou gravado aqui.
   */
  registrarOuvinte(fn: (ev: PagbankEventoCobranca) => Promise<void> | void): void {
    this.ouvintes.push(fn);
  }

  private async avisarOuvintes(ev: PagbankEventoCobranca): Promise<void> {
    for (const fn of this.ouvintes) {
      try {
        await fn(ev);
      } catch (e: any) {
        this.logger.warn(
          `[pagbank] ouvinte falhou (order=${ev.pagbankOrderId} sale=${ev.saleId} ${ev.status}): ${e?.message || e}`,
        );
      }
    }
  }

  // ── CARTÃO (site lurds.com.br) ─────────────────────────────────────

  /**
   * CHAVE PÚBLICA DE CARTÃO da conta — a que o site usa pra criptografar o
   * cartão no navegador (`PagSeguro.encryptCard`). Sem ela não existe cartão
   * pelo PagBank: o número NUNCA pode chegar ao nosso servidor (PCI), então
   * a criptografia acontece antes de sair do navegador, e só o blob viaja.
   *
   * Gerada UMA vez com o token da conta (`POST /public-keys {type:'card'}`)
   * e guardada na config — não é o mesmo token da Reservas Ita que revoga
   * (chave pública não revoga nada; ver memória "PagBank: token único por
   * conta"). `GET /public-keys/card` primeiro: se a conta já tem, reaproveita.
   * Persistida na config de onde saiu o token (loja ou matriz), porque a
   * chave é DA CONTA — trocar o token da loja SITE por outra conta exige
   * `forcar=true` pra buscar a chave nova.
   */
  async chavePublicaCartao(
    storeCode: string,
    forcar = false,
  ): Promise<{ publicKey: string; source: 'store' | 'singleton'; ambiente: string; criadaAgora: boolean }> {
    const cfg = await this.getConfigInternalForStore(storeCode);
    if (cfg.cardPublicKey && !forcar) {
      return { publicKey: cfg.cardPublicKey, source: cfg.source, ambiente: cfg.ambiente, criadaAgora: false };
    }

    const baseUrl = this.getBaseUrl(cfg.ambiente);
    const headers = {
      Authorization: `Bearer ${String(cfg.bearerToken || '').trim()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    let publicKey = '';
    let criadaAgora = false;
    // 1) já existe na conta?
    try {
      const r = await firstValueFrom(
        this.http.get(`${baseUrl}/public-keys/card`, { headers, timeout: 10000, validateStatus: () => true }),
      );
      if (r.status >= 200 && r.status < 300 && r.data?.public_key) publicKey = String(r.data.public_key);
      else if (r.status === 401 || r.status === 403) {
        throw new BadRequestException(`PagBank recusou o token ao consultar a chave pública (HTTP ${r.status})`);
      }
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(`[pagbank] GET /public-keys/card falhou (${e?.message || e}) — tentando criar`);
    }
    // 2) não existe: cria.
    if (!publicKey) {
      const r = await firstValueFrom(
        this.http.post(`${baseUrl}/public-keys`, { type: 'card' }, { headers, timeout: 10000, validateStatus: () => true }),
      );
      if (!(r.status >= 200 && r.status < 300) || !r.data?.public_key) {
        throw new BadRequestException(
          `PagBank não devolveu chave pública (HTTP ${r.status}): ${resumirErrosPagbank(r.data, JSON.stringify(r.data || {}).slice(0, 200))}`,
        );
      }
      publicKey = String(r.data.public_key);
      criadaAgora = true;
    }

    if (cfg.source === 'store') {
      await (this.prisma as any).pagbankStoreConfig.update({
        where: { storeCode: cfg.storeCode },
        data: { cardPublicKey: publicKey },
      });
    } else {
      await (this.prisma as any).pagbankConfig.update({
        where: { id: 'singleton' },
        data: { cardPublicKey: publicKey },
      });
    }
    this.logger.log(
      `[pagbank] chave pública de cartão ${criadaAgora ? 'CRIADA' : 'lida'} pra loja ${storeCode} (${cfg.source}, ${cfg.ambiente})`,
    );
    return { publicKey, source: cfg.source, ambiente: cfg.ambiente, criadaAgora };
  }

  /**
   * COBRANÇA DE CARTÃO (Orders API, `charges[].payment_method.CREDIT_CARD`).
   *
   * Recebe o cartão JÁ CRIPTOGRAFADO pelo navegador (`cardEncrypted`) — o
   * PAN/CVV nunca passam por aqui. Captura na hora (`capture:true`), até
   * 12x sem juros pra cliente (a loja absorve a taxa da parcela — decisão do
   * dono, 16/09).
   *
   * Três saídas, iguais às do cartão da Pagar.me em `loja-orders`:
   *   ok:true  status 'paid'    → aprovado, confirma na hora
   *   ok:true  status 'pending' → em análise; webhook/reconcile fecham
   *   ok:false kind 'recusa'    → a operadora disse não (cliente pode trocar o cartão)
   *   ok:false kind 'integracao'→ falha nossa/do PagBank — a cliente NÃO deve
   *                               trocar de cartão por causa disso
   *
   * Timeout/5xx é resposta AMBÍGUA (o PagBank pode ter cobrado): antes de
   * declarar falha, procura a order pelo `reference_id` — achou, segue com
   * ela. É a mesma rede do `procurarOrderPagarmePorCode`.
   */
  async createCardCharge(input: {
    saleId: string;
    storeCode: string;
    /** Em REAIS. */
    valor: number;
    /** `reference_id` da order — único por tentativa (LP, LP-T2, …). */
    referencia: string;
    descricao: string;
    installments: number;
    cardEncrypted: string;
    holderName: string;
    holderTaxId: string;
    customer: { name: string; email: string; cpf: string; phone: string };
    shippingAddress?: PagbankEndereco | null;
    /** 'site' = checkout de lurds.com.br; 'venda_online_link' = página do link do PDV. */
    origem: 'site' | typeof ORIGEM_LINK_PAGBANK;
  }): Promise<
    | { ok: true; status: 'paid' | 'pending'; pagbankOrderId: string; pagbankChargeId: string | null; lido: CartaoPagbankLido }
    | { ok: false; kind: 'recusa' | 'integracao'; detalhe: string; lido?: CartaoPagbankLido; pagbankOrderId?: string | null; pagbankChargeId?: string | null }
  > {
    const cfg = await this.getConfigInternalForStore(input.storeCode);
    const baseUrl = this.getBaseUrl(cfg.ambiente);
    const headers = {
      Authorization: `Bearer ${String(cfg.bearerToken || '').trim()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const valorCentavos = Math.round(input.valor * 100);
    const parcelas = Math.max(1, Math.min(12, Math.floor(Number(input.installments) || 1)));
    const cpf = String(input.customer.cpf || '').replace(/\D/g, '');
    const telefone = this.telefonePagbank(input.customer.phone);
    if (!telefone) {
      // O checkout já exige celular com DDD — chegar aqui sem ele é bug de
      // quem chamou, e o PagBank recusaria com 400 de qualquer jeito.
      return { ok: false, kind: 'integracao', detalhe: `telefone inválido pra cobrança: "${input.customer.phone}"` };
    }

    const end = input.shippingAddress;
    const body: any = {
      reference_id: String(input.referencia).slice(0, 64),
      customer: {
        name: String(input.customer.name || '').trim().slice(0, 64),
        email: String(input.customer.email || '').trim().slice(0, 254),
        tax_id: cpf,
        phones: [telefone],
      },
      items: [
        {
          reference_id: input.saleId.slice(-12),
          name: String(input.descricao || 'Pedido').slice(0, 64),
          quantity: 1,
          unit_amount: valorCentavos,
        },
      ],
      ...(end
        ? {
            shipping: {
              address: {
                street: String(end.street || '').slice(0, 160),
                number: String(end.number || 'S/N').slice(0, 20),
                ...(end.complement ? { complement: String(end.complement).slice(0, 40) } : {}),
                locality: String(end.neighborhood || '').slice(0, 60),
                city: String(end.city || '').slice(0, 90),
                region_code: String(end.uf || '').toUpperCase().slice(0, 2),
                country: 'BRA',
                postal_code: String(end.cep || '').replace(/\D/g, '').slice(0, 8),
              },
            },
          }
        : {}),
      charges: [
        {
          reference_id: String(input.referencia).slice(0, 64),
          description: String(input.descricao || 'Pedido').slice(0, 64),
          amount: { value: valorCentavos, currency: 'BRL' },
          payment_method: {
            type: 'CREDIT_CARD',
            installments: parcelas,
            capture: true,
            soft_descriptor: 'LURDS',
            card: { encrypted: String(input.cardEncrypted), store: false },
            holder: { name: String(input.holderName || input.customer.name).trim().slice(0, 64), tax_id: String(input.holderTaxId || cpf).replace(/\D/g, '') },
          },
        },
      ],
    };
    const webhook = this.getWebhookUrl();
    if (webhook) body.notification_urls = [webhook];

    let order: any = null;
    try {
      const resp = await firstValueFrom(
        this.http.post(`${baseUrl}/orders`, body, { headers, timeout: 10000 }),
      );
      order = resp?.data ?? null;
    } catch (e: any) {
      const httpStatus: number | undefined = e?.response?.status;
      const data = e?.response?.data;
      const resumo = resumirErrosPagbank(data, e?.message || String(e));

      // Sem resposta / 5xx: o PagBank PODE ter cobrado. Pergunta antes de desistir.
      const ambigua = !e?.response || (typeof httpStatus === 'number' && httpStatus >= 500);
      if (ambigua) {
        order = await this.procurarOrderPorReferencia(cfg, body.reference_id);
        if (order) {
          this.logger.warn(
            `[pagbank] cartão ${input.referencia}: POST sem resposta (HTTP ${httpStatus ?? 'timeout/rede'}) ` +
              `mas a order ${order.id} EXISTE — seguindo com ela`,
          );
        }
      }

      if (!order) {
        if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500 && erroHttpEhDadoDoCartao(data)) {
          // Cartão criptografado/titular inválido: é dado que a cliente pode corrigir.
          this.logger.warn(`[pagbank] cartão ${input.referencia}: dado do cartão recusado pelo PagBank (HTTP ${httpStatus}): ${resumo}`);
          return { ok: false, kind: 'recusa', detalhe: `HTTP ${httpStatus}: ${resumo}` };
        }
        // ERROR com marcador fixo — é o que se filtra no Railway pra ver que o
        // cartão caiu por NOSSA causa, não por recusa.
        this.logger.error(
          `[pagbank][ALERTA] cartão: erro de integração HTTP ${httpStatus ?? 'sem resposta (timeout/rede)'} ` +
            `ref=${input.referencia}: ${resumo}`,
        );
        return { ok: false, kind: 'integracao', detalhe: `HTTP ${httpStatus ?? 'timeout/rede'}: ${resumo}` };
      }
    }

    if (!order?.id) {
      this.logger.error(`[pagbank][ALERTA] cartão: resposta sem id de order ref=${input.referencia}: ${JSON.stringify(order).slice(0, 400)}`);
      return { ok: false, kind: 'integracao', detalhe: `resposta sem id de order: ${JSON.stringify(order).slice(0, 300)}` };
    }

    const lido = lerCartaoPagbank(order);
    const status = lido.classe === 'paid' ? 'paid' : lido.classe === 'pending' ? 'pending' : 'cancelled';

    // A MESMA tabela do PIX do PDV/live: conciliação, painel e webhook
    // enxergam a venda do site por aqui. `origem='site'` é o que o
    // `LojaOrdersService` usa pra saber que o evento é dele; o link do PDV
    // grava a origem dele, que é o que os reconciliadores do PDV leem.
    try {
      await (this.prisma as any).pagbankPayment.create({
        data: {
          saleId: input.saleId,
          storeCode: input.storeCode,
          pagbankOrderId: order.id,
          pagbankChargeId: lido.chargeId,
          method: 'credit_card',
          valor: input.valor,
          status,
          origem: input.origem === ORIGEM_LINK_PAGBANK ? ORIGEM_LINK_PAGBANK : 'site',
          ...(status === 'paid' ? { paidAt: new Date() } : {}),
          rawWebhook: JSON.stringify(order).slice(0, 5000),
        },
      });
    } catch (e: any) {
      this.logger.warn(`[pagbank] PagbankPayment do cartão não gravado (cobrança seguiu): ${e?.message || e}`);
    }

    if (lido.classe === 'recusa') {
      this.logger.warn(
        `[pagbank] cartão recusado ref=${input.referencia} order=${order.id} charge=${lido.chargeStatus} ${lido.codigo || ''} ${lido.mensagem || ''}`,
      );
      return {
        ok: false,
        kind: 'recusa',
        detalhe: `recusa: charge=${lido.chargeStatus} code=${lido.codigo || '?'} ${lido.mensagem || ''}`.trim().slice(0, 300),
        lido,
        pagbankOrderId: order.id,
        pagbankChargeId: lido.chargeId,
      };
    }
    if (lido.classe === 'pending') {
      this.logger.warn(
        `[pagbank] cartão EM ANÁLISE ref=${input.referencia} order=${order.id} charge=${lido.chargeStatus} — pedido fica aguardando; webhook/reconcile fecham`,
      );
    } else {
      this.logger.log(`[pagbank] cartão APROVADO ref=${input.referencia} order=${order.id} ${parcelas}x R$${input.valor.toFixed(2)}`);
    }
    return { ok: true, status: lido.classe === 'paid' ? 'paid' : 'pending', pagbankOrderId: order.id, pagbankChargeId: lido.chargeId, lido };
  }

  /**
   * A ORDER QUE A GENTE NÃO VIU NASCER: `GET /orders?reference_id=`. Confere o
   * `reference_id` de novo no resultado — se o filtro for ignorado um dia,
   * isto não pode pegar a order de outra cliente.
   */
  private async procurarOrderPorReferencia(cfg: any, referenceId: string): Promise<any | null> {
    try {
      const r = await firstValueFrom(
        this.http.get(`${this.getBaseUrl(cfg.ambiente)}/orders`, {
          params: { reference_id: referenceId },
          headers: { Authorization: `Bearer ${String(cfg.bearerToken || '').trim()}`, Accept: 'application/json' },
          timeout: 3000,
          validateStatus: () => true,
        }),
      );
      const lista: any[] = Array.isArray(r.data?.orders) ? r.data.orders : Array.isArray(r.data) ? r.data : r.data?.id ? [r.data] : [];
      return lista.find((o) => String(o?.reference_id || '') === referenceId) || null;
    } catch (e: any) {
      this.logger.warn(`[pagbank] busca da order por reference_id=${referenceId} também falhou: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * DIAGNÓSTICO DO CARTÃO VIA API — responde "a conta aceita cartão?" antes
   * de ligar o site: consulta/cria a chave pública e pede ao PagBank a
   * simulação de parcelas (`GET /charges/fees/calculate`). Conta sem cartão
   * habilitado falha num dos dois, com o motivo. Não cobra nada.
   */
  async diagnosticarCartao(storeCode: string): Promise<{
    ok: boolean;
    storeCode: string;
    source: string;
    ambiente: string;
    chavePublica: { ok: boolean; tamanho?: number; criadaAgora?: boolean; erro?: string };
    taxas: { ok: boolean; httpStatus?: number; planos?: Array<{ bandeira: string; parcelas: number; valorParcela: number; semJuros: boolean; total: number }>; taxaPix?: number | null; erro?: string };
    siteGateway: string;
  }> {
    const cfg = await this.getConfigInternalForStore(storeCode);
    const out: any = {
      ok: false,
      storeCode,
      source: cfg.source,
      ambiente: cfg.ambiente,
      chavePublica: { ok: false },
      taxas: { ok: false },
      siteGateway: process.env.SITE_GATEWAY === 'pagbank' ? 'pagbank' : 'pagarme',
    };
    try {
      const k = await this.chavePublicaCartao(storeCode);
      out.chavePublica = { ok: true, tamanho: k.publicKey.length, criadaAgora: k.criadaAgora };
    } catch (e: any) {
      out.chavePublica = { ok: false, erro: e?.message || String(e) };
    }
    try {
      const r = await firstValueFrom(
        this.http.get(`${this.getBaseUrl(cfg.ambiente)}/charges/fees/calculate`, {
          params: {
            payment_methods: 'CREDIT_CARD,PIX',
            value: 10000,
            max_installments: 12,
            max_installments_no_interest: 12,
            show_seller_fees: true,
          },
          headers: { Authorization: `Bearer ${String(cfg.bearerToken || '').trim()}`, Accept: 'application/json' },
          timeout: 10000,
          validateStatus: () => true,
        }),
      );
      if (r.status >= 200 && r.status < 300) {
        const cc = r.data?.payment_methods?.credit_card || {};
        const planos: any[] = [];
        for (const [bandeira, v] of Object.entries<any>(cc)) {
          for (const p of v?.installment_plans || []) {
            planos.push({
              bandeira,
              parcelas: Number(p.installments),
              valorParcela: Number(p.installment_value) / 100,
              semJuros: !!p.interest_free,
              total: Number(p.amount?.value ?? 0) / 100,
            });
          }
        }
        const pixFee = r.data?.payment_methods?.pix?.amount?.fees?.seller?.total;
        out.taxas = { ok: true, httpStatus: r.status, planos, taxaPix: pixFee != null ? Number(pixFee) / 100 : null };
      } else {
        out.taxas = { ok: false, httpStatus: r.status, erro: resumirErrosPagbank(r.data, JSON.stringify(r.data || {}).slice(0, 200)) };
      }
    } catch (e: any) {
      out.taxas = { ok: false, erro: e?.message || String(e) };
    }
    out.ok = out.chavePublica.ok && out.taxas.ok;
    return out;
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
    /**
     * O QR PAGO GANHA DO QR MAIS NOVO (12/08/2026).
     *
     * A tela regenera o QR sozinha quando o valor a cobrar muda — a mesma
     * venda acumula várias linhas aqui. Pegando só a mais recente, o caso
     * clássico ficava invisível: a vendedora manda o código pela conversa, o
     * valor muda na tela, nasce um QR novo, e a cliente paga o código ANTIGO
     * que já está no celular dela. O pagamento entra, mas a tela pergunta pelo
     * QR errado e responde "pending" pra sempre — a vendedora fica presa em
     * "Aguardando pagamento PIX" com o dinheiro já na conta.
     *
     * Qualquer linha paga desta venda fecha a tela.
     */
    const pago = await (this.prisma as any).pagbankPayment.findFirst({
      where: { saleId, method: 'pix', status: 'paid' },
      orderBy: { paidAt: 'desc' },
    });
    if (pago) return pago;
    return (this.prisma as any).pagbankPayment.findFirst({
      where: { saleId, method: 'pix' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * A venda de PDV por trás de um saleId — ou null.
   *
   * Existe pro guard do `POST /pagbank/pix/create`: QR só nasce pra venda que
   * EXISTE e está aberta (ver o comentário na rota — 11 cobranças órfãs pagas
   * em 48h motivaram isto). Método próprio em vez de expor o prisma do
   * controller, e SEM validar aqui dentro do `createPixCharge`: a live chama o
   * mesmo create com id de CARRINHO, que nunca é pdv_sale.
   */
  async buscarVendaPdv(saleId: string): Promise<any | null> {
    return (this.prisma as any).pdvSale.findUnique({
      where: { id: String(saleId || '') },
      // `total` + `payments` entraram em 24/08 pro guard da cobrança curta
      // (`conferirCobrancaCobreVendaOnline`) — a mesma leitura serve às duas
      // travas, e assim a rota não faz dois SELECT na mesma venda.
      select: SELECT_VENDA_COBRANCA,
    });
  }

  // ── LINK DE PAGAMENTO DO PDV (21/09/2026) ───────────────────────────
  //
  // A história e a régua moram em `common/link-pagamento-pagbank.ts`. Em uma
  // linha: a Pagar.me desligou o checkout da conta e o link pronto do PagBank
  // pede allowlist, então o link é NOSSO (`/pague/<token>`) e cobra pela
  // Orders API — PIX, ou cartão criptografado no navegador (o caminho do site).
  //
  // Quem fecha a venda NÃO é este bloco: tudo nasce em `pagbank_payments` com
  // a origem do link, e os reconciliadores que já existem (gateway → `paid`;
  // PDV → registra `venda_online` e finaliza) fazem o resto, com a vendedora
  // em outro atendimento ou com o PDV desligado.

  /** Última conferência ao vivo por venda — o botão "Conferir" não martela o PagBank. */
  private readonly ultimaConferenciaLink = new Map<string, number>();
  /** Venda com cartão EM VOO — dois toques no "Pagar" não viram duas cobranças. */
  private readonly cartaoLinkEmVoo = new Set<string>();
  /** Loja cuja chave pública falhou há pouco — o polling da página não martela o PagBank. */
  private readonly chaveCartaoFalhouEm = new Map<string, number>();

  private static readonly RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  /**
   * GERA O LINK: um PIX de venda online com a origem do link — a "âncora". O
   * token dele é o da página. A rota do PDV já conferiu venda aberta, forma de
   * entrega e valor cheio antes de chegar aqui.
   */
  async criarLinkPagamento(input: {
    saleId: string;
    valor: number;
    storeCode: string;
    customerName?: string;
    customerCpf?: string;
    customerEmail?: string;
    customerPhone?: string;
  }): Promise<{
    gateway: 'pagbank';
    pagbankOrderId: string;
    paymentUrl: string;
    shortUrl: string;
    expiresAt: Date;
    valor: number;
    tentativasCartao: number;
  }> {
    // O e-mail/celular que a vendedora digitou no painel é o que o cartão vai
    // usar lá na página (e é o que o antifraude pontua). Só preenche o que a
    // venda NÃO tem — cadastro existente não é reescrito.
    await this.completarContatoDaVenda(input.saleId, input.customerEmail, input.customerPhone);

    const pix = await this.createPixCharge({
      saleId: input.saleId,
      valor: input.valor,
      storeCode: input.storeCode,
      customerName: input.customerName,
      customerCpf: input.customerCpf,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      descricao: `Venda Online ${input.storeCode}`,
      // O CÓDIGO PIX vale 1h (igual ao "Gerar PIX"); o LINK vale
      // `PAGBANK_LINK_HORAS`. Código vencido, a página gera outro.
      expiresInMinutes: 60,
      origem: ORIGEM_LINK_PAGBANK,
    });
    const url = `${this.baseUrlPublica()}/pague/${pix.linkToken}`;
    const tentativasCartao = await this.contarCartoesDaVenda(input.saleId);
    this.logger.log(
      `[pagbank-link] link gerado: sale=${input.saleId} loja=${input.storeCode} ` +
        `R$${Number(input.valor).toFixed(2)} → /pague/${pix.linkToken}`,
    );
    return {
      gateway: 'pagbank',
      pagbankOrderId: pix.pagbankOrderId,
      paymentUrl: url,
      shortUrl: url,
      expiresAt: linkPagbankVenceEm(new Date()),
      valor: input.valor,
      tentativasCartao,
    };
  }

  /**
   * O QUE A PÁGINA `/pague/<token>` MOSTRA — e o que ela consulta no polling.
   *
   * Lê só do nosso Postgres (quem mantém o status fresco é o webhook + o
   * reconciliador); a única ida ao PagBank é a chave pública do cartão, que
   * fica guardada na config depois da primeira vez. Não expõe CPF, telefone,
   * e-mail nem itens — só valor, loja e o que a cliente precisa pra pagar.
   */
  async estadoDoLinkPublico(token: string): Promise<{
    estado: EstadoLinkPagbank | 'inexistente';
    motivo?: string;
    mensagem?: string;
    valor?: number;
    lojaNome?: string;
    lojaWhatsapp?: string | null;
    venceEm?: Date;
    pagoEm?: Date | null;
    formaPaga?: 'pix' | 'cartao';
    pix?: { qrCodeText: string; qrCodeImageB64: string; expiraEm: Date | null } | null;
    cartao?: {
      habilitado: boolean;
      publicKey: string | null;
      maxParcelas: number;
      tentativasRestantes: number;
      emAnalise: boolean;
      precisaEmail: boolean;
      precisaCelular: boolean;
      motivo?: string;
    };
  }> {
    const p = await this.linhaDoLink(token);
    if (!p) return { estado: 'inexistente' };
    const [venda, cobr, loja] = await Promise.all([
      this.vendaDoLink(p.saleId),
      this.cobrancasDaVendaDoLink(p.saleId),
      this.dadosDaLoja(p.storeCode),
    ]);
    const sit = this.situacaoDoLink(p, venda, cobr);
    const base = {
      valor: Number(p.valor) || 0,
      lojaNome: loja.nome,
      lojaWhatsapp: loja.whatsapp,
      venceEm: sit.venceEm,
    };

    if (sit.estado === 'pago') {
      const paga = cobr.find((c) => c.status === 'paid');
      return {
        estado: 'pago',
        ...base,
        pagoEm: paga?.paidAt ?? null,
        formaPaga: paga?.method === 'credit_card' ? 'cartao' : 'pix',
      };
    }
    if (sit.estado !== 'aberto') {
      return { estado: sit.estado, motivo: sit.motivo, mensagem: this.fraseDoLink(sit), ...base };
    }

    const vivo = this.pixVivoDoLink(cobr);
    const [pix, cartao] = await Promise.all([
      vivo ? this.qrDaCobranca(vivo.pagbankOrderId) : Promise.resolve(null),
      this.cartaoDoLinkInfo(p.storeCode, venda, cobr),
    ]);
    return { estado: 'aberto', ...base, pix, cartao };
  }

  /** O QR de UMA cobrança — as listas não carregam imagem (o polling é de 10s). */
  private async qrDaCobranca(
    pagbankOrderId: string,
  ): Promise<{ qrCodeText: string; qrCodeImageB64: string; expiraEm: Date | null } | null> {
    const q: any = await (this.prisma as any).pagbankPayment.findUnique({
      where: { pagbankOrderId },
      select: { qrCodeText: true, qrCodeImageB64: true, expiresAt: true },
    });
    if (!q?.qrCodeText) return null;
    return {
      qrCodeText: String(q.qrCodeText),
      qrCodeImageB64: String(q.qrCodeImageB64 || ''),
      expiraEm: q.expiresAt ?? null,
    };
  }

  /**
   * PIX PELA PÁGINA: devolve o código que ainda está de pé ou gera outro (o
   * código vale 1h; o link, dias). Idempotente enquanto o código vive —
   * tocar duas vezes não cria duas cobranças.
   */
  async pixDoLinkPublico(token: string): Promise<{ qrCodeText: string; qrCodeImageB64: string; expiraEm: Date | null }> {
    const p = await this.linhaDoLink(token);
    if (!p) throw new NotFoundException('Link não encontrado');
    const [venda, cobr] = await Promise.all([this.vendaDoLink(p.saleId), this.cobrancasDaVendaDoLink(p.saleId)]);
    const sit = this.situacaoDoLink(p, venda, cobr);
    if (sit.estado !== 'aberto') throw new BadRequestException(this.fraseDoLink(sit));

    const vivo = this.pixVivoDoLink(cobr);
    if (vivo) {
      const qr = await this.qrDaCobranca(vivo.pagbankOrderId);
      if (qr) return qr;
    }
    const gerados = cobr.filter((c) => c.origem === ORIGEM_LINK_PAGBANK && c.method === 'pix').length;
    if (gerados >= 20) {
      throw new HttpException('Muitos códigos PIX gerados pra este pedido. Fale com a loja 💜', 429);
    }
    // O código novo não pode passar da validade do LINK.
    const minutosDoLink = Math.floor((sit.venceEm.getTime() - Date.now()) / 60_000);
    const novo = await this.createPixCharge({
      saleId: p.saleId,
      valor: Number(p.valor),
      storeCode: p.storeCode,
      customerName: venda?.customerName || undefined,
      customerCpf: venda?.customerCpf || undefined,
      customerEmail: venda?.customerEmail || undefined,
      customerPhone: venda?.customerPhone || undefined,
      descricao: `Venda Online ${p.storeCode}`,
      expiresInMinutes: Math.max(5, Math.min(60, minutosDoLink)),
      origem: ORIGEM_LINK_PAGBANK,
    });
    return { qrCodeText: novo.qrCodeText, qrCodeImageB64: novo.qrCodeImageB64, expiraEm: novo.expiresAt };
  }

  /**
   * CARTÃO PELA PÁGINA. O cartão chega CRIPTOGRAFADO pelo SDK do PagBank no
   * navegador da cliente — número e CVV nunca passam por aqui (PCI).
   *
   * Defesas de página aberta (o ataque de 28/08 no site testou ~650 cartões):
   * token sorteado, teto de tentativas POR VENDA, uma cobrança em voo por
   * venda, e o rate limit por IP no controller.
   */
  async cartaoDoLinkPublico(
    token: string,
    input: {
      cardEncrypted?: string;
      holderName?: string;
      holderCpf?: string;
      installments?: number;
      email?: string;
      phone?: string;
    },
  ): Promise<{ resultado: 'pago' | 'analise' | 'recusado' | 'erro'; mensagem: string; tentativasRestantes: number }> {
    const p = await this.linhaDoLink(token);
    if (!p) throw new NotFoundException('Link não encontrado');

    const enc = String(input?.cardEncrypted || '').trim();
    if (enc.length < 50 || enc.length > 8000) {
      throw new BadRequestException('Não conseguimos ler o cartão. Confira os dados e tente de novo.');
    }
    const holderName = String(input?.holderName || '').trim().replace(/\s+/g, ' ').slice(0, 64);
    if (holderName.length < 3) throw new BadRequestException('Digite o nome como está impresso no cartão.');
    const holderCpf = String(input?.holderCpf || '').replace(/\D/g, '');
    if (!cpfValido(holderCpf)) throw new BadRequestException('Confira o CPF do titular do cartão.');
    const parcelas = Math.floor(Number(input?.installments) || 1);
    if (parcelas < 1 || parcelas > maxParcelasLink()) throw new BadRequestException('Parcelamento inválido.');

    if (this.cartaoLinkEmVoo.has(p.saleId)) {
      throw new HttpException('Já estamos processando o seu pagamento — aguarde um instante 💜', 409);
    }
    this.cartaoLinkEmVoo.add(p.saleId);
    try {
      const [venda, cobr] = await Promise.all([this.vendaDoLink(p.saleId), this.cobrancasDaVendaDoLink(p.saleId)]);
      const sit = this.situacaoDoLink(p, venda, cobr);
      if (sit.estado !== 'aberto') throw new BadRequestException(this.fraseDoLink(sit));

      const max = maxTentativasCartaoLink();
      const usadas = cobr.filter((c) => c.method === 'credit_card').length;
      if (cobr.some((c) => c.method === 'credit_card' && c.status === 'pending')) {
        throw new BadRequestException(
          'Seu pagamento com cartão está em análise no banco. Assim que ele responder, esta página confirma sozinha 💜',
        );
      }
      if (usadas >= max) {
        throw new HttpException(
          'Este pedido já teve muitas tentativas no cartão. Pague com PIX ou fale com a loja 💜',
          429,
        );
      }

      const emailVenda = String(venda?.customerEmail || '').trim();
      const email = PagbankService.RE_EMAIL.test(emailVenda) ? emailVenda : String(input?.email || '').trim();
      if (!PagbankService.RE_EMAIL.test(email)) {
        throw new BadRequestException('Digite um e-mail válido pra receber a confirmação.');
      }
      const fone = this.telefonePagbank(venda?.customerPhone) ? String(venda.customerPhone) : String(input?.phone || '');
      if (!this.telefonePagbank(fone)) throw new BadRequestException('Digite um celular com DDD.');
      const cpfCliente = cpfValido(venda?.customerCpf) ? String(venda.customerCpf).replace(/\D/g, '') : holderCpf;
      const nomeVenda = String(venda?.customerName || '').trim();
      const nome = nomeVenda.split(/\s+/).filter(Boolean).length >= 2 ? nomeVenda : holderName;

      const r = await this.createCardCharge({
        saleId: p.saleId,
        storeCode: p.storeCode,
        valor: Number(p.valor),
        referencia: referenciaCartaoLink(p.saleId, p.storeCode, usadas + 1),
        descricao: `Venda Online ${p.storeCode}`,
        installments: parcelas,
        cardEncrypted: enc,
        holderName,
        holderTaxId: holderCpf,
        customer: { name: nome, email, cpf: cpfCliente, phone: fone },
        shippingAddress: this.enderecoDaVenda(venda),
        origem: ORIGEM_LINK_PAGBANK,
      });

      if (r.ok) {
        await this.completarContatoDaVenda(p.saleId, email, fone);
        this.logger.log(
          `[pagbank-link] cartão ${r.status === 'paid' ? 'APROVADO' : 'EM ANÁLISE'}: sale=${p.saleId} ` +
            `loja=${p.storeCode} ${parcelas}x R$${Number(p.valor).toFixed(2)} order=${r.pagbankOrderId}`,
        );
        return r.status === 'paid'
          ? { resultado: 'pago', mensagem: 'Pagamento aprovado! 💜', tentativasRestantes: Math.max(0, max - usadas - 1) }
          : {
              resultado: 'analise',
              mensagem: 'Seu pagamento está em análise no banco. Assim que ele confirmar, esta página avisa sozinha 💜',
              tentativasRestantes: Math.max(0, max - usadas - 1),
            };
      }
      // Recusa com order criada gasta tentativa; falha nossa (sem order) não.
      const gastou = !!r.pagbankOrderId;
      const restantes = Math.max(0, max - usadas - (gastou ? 1 : 0));
      if (r.kind === 'recusa') {
        return { resultado: 'recusado', mensagem: mensagemRecusaCartaoLink(r.lido?.mensagem || r.detalhe), tentativasRestantes: restantes };
      }
      return {
        resultado: 'erro',
        mensagem:
          'Não conseguimos falar com a operadora agora — o problema não é o seu cartão. ' +
          'Tente de novo em instantes ou pague com PIX. 💜',
        tentativasRestantes: restantes,
      };
    } finally {
      this.cartaoLinkEmVoo.delete(p.saleId);
    }
  }

  /**
   * O PDV PERGUNTA: o link desta venda foi pago? Qualquer cobrança do link
   * paga (PIX ou cartão) responde `paid` com o id da order — é ele que vai no
   * `details` do pagamento e que a prova de pagamento confere.
   */
  async statusDoLinkPorVenda(saleId: string): Promise<{
    found: boolean;
    status: 'paid' | 'pending' | 'none';
    isPaid: boolean;
    pagbankOrderId?: string;
    forma?: 'pix' | 'credito';
    paidAt?: Date | null;
    valor?: number;
    emAnalise?: boolean;
    tentativasCartao: number;
  }> {
    const cobr = (await this.cobrancasDaVendaDoLink(saleId)).filter((c) => c.origem === ORIGEM_LINK_PAGBANK);
    const tentativasCartao = cobr.filter((c) => c.method === 'credit_card').length;
    if (!cobr.length) return { found: false, status: 'none', isPaid: false, tentativasCartao };
    const paga = cobr.find((c) => c.status === 'paid');
    if (paga) {
      return {
        found: true,
        status: 'paid',
        isPaid: true,
        pagbankOrderId: paga.pagbankOrderId,
        forma: paga.method === 'credit_card' ? 'credito' : 'pix',
        paidAt: paga.paidAt ?? null,
        valor: Number(paga.valor) || 0,
        tentativasCartao,
      };
    }
    return {
      found: true,
      status: 'pending',
      isPaid: false,
      emAnalise: cobr.some((c) => c.method === 'credit_card' && c.status === 'pending'),
      tentativasCartao,
    };
  }

  /**
   * Botão "Conferir" do PDV: pergunta AO VIVO pelas cobranças ainda pendentes
   * do link (webhook atrasado). No máximo uma vez a cada 15s por venda.
   */
  async conferirLinkPorVenda(saleId: string) {
    const agora = Date.now();
    const ultima = this.ultimaConferenciaLink.get(saleId) || 0;
    if (agora - ultima >= 15_000) {
      this.ultimaConferenciaLink.set(saleId, agora);
      if (this.ultimaConferenciaLink.size > 2000) this.ultimaConferenciaLink.clear();
      const cobr = (await this.cobrancasDaVendaDoLink(saleId)).filter(
        (c) =>
          c.origem === ORIGEM_LINK_PAGBANK &&
          c.status === 'pending' &&
          (c.method === 'credit_card' || !c.expiresAt || new Date(c.expiresAt).getTime() > agora - 6 * 3600_000),
      );
      for (const c of cobr.slice(0, 5)) {
        try {
          await this.checkOrderStatus(c.pagbankOrderId);
        } catch (e: any) {
          this.logger.warn(`[pagbank-link] conferir ${c.pagbankOrderId} falhou: ${e?.message || e}`);
        }
      }
    }
    return this.statusDoLinkPorVenda(saleId);
  }

  /** Quantas tentativas de cartão pelo PagBank esta venda já teve. */
  private async contarCartoesDaVenda(saleId: string): Promise<number> {
    return (this.prisma as any).pagbankPayment
      .count({ where: { saleId, method: 'credit_card' } })
      .catch(() => 0);
  }

  /** A linha do token — só cobrança nascida do link abre a página de pagamento. */
  private async linhaDoLink(token: string): Promise<any | null> {
    const t = String(token || '').trim();
    if (!t || t.length > 40) return null;
    const p: any = await (this.prisma as any).pagbankPayment.findUnique({ where: { linkToken: t } });
    if (!p || p.origem !== ORIGEM_LINK_PAGBANK) return null;
    return p;
  }

  /**
   * TODAS as cobranças PagBank da venda — não só as do link: um PIX de balcão
   * ou um "Gerar PIX" pago na mesma venda também encerra o link (senão a
   * cliente paga duas vezes).
   */
  private async cobrancasDaVendaDoLink(saleId: string): Promise<any[]> {
    return (this.prisma as any).pagbankPayment.findMany({
      where: { saleId },
      orderBy: { createdAt: 'desc' },
      take: 60,
      // Sem o QR (a imagem pesa): quem precisa dele busca UMA linha em `qrDaCobranca`.
      select: {
        pagbankOrderId: true,
        method: true,
        status: true,
        origem: true,
        valor: true,
        expiresAt: true,
        createdAt: true,
        paidAt: true,
      },
    });
  }

  private async vendaDoLink(saleId: string): Promise<any | null> {
    return (this.prisma as any).pdvSale.findUnique({
      where: { id: String(saleId || '') },
      select: {
        ...SELECT_VENDA_COBRANCA,
        storeCode: true,
        customerName: true,
        customerCpf: true,
        customerEmail: true,
        customerPhone: true,
        customerCep: true,
        customerEndereco: true,
        customerNumero: true,
        customerComplemento: true,
        customerBairro: true,
        customerCidade: true,
        customerUf: true,
      },
    });
  }

  /**
   * Estado do link + a trava do VALOR: o link cobra exatamente o que a venda
   * deve. Se a loja mexeu na venda depois de mandar o link (peça a mais, a
   * menos), pagar o valor velho deixaria a venda sem fechar ou paga a mais —
   * a página recusa e manda pedir um link novo.
   */
  private situacaoDoLink(
    p: any,
    venda: any,
    cobr: any[],
  ): { estado: EstadoLinkPagbank; motivo?: 'valor' | 'quitada'; venceEm: Date } {
    const venceEm = linkPagbankVenceEm(p.createdAt);
    const estado = estadoDoLinkPagbank({
      statusDasCobrancas: cobr.map((c) => String(c.status || '')),
      statusDaVenda: venda?.status ?? null,
      venceEm,
    });
    if (estado !== 'aberto') return { estado, venceEm };
    const restante = restanteCentsDaVenda(venda);
    if (restante <= 0) return { estado: 'encerrado', motivo: 'quitada', venceEm };
    if (Math.abs(Math.round(Number(p.valor || 0) * 100) - restante) > 1) {
      return { estado: 'encerrado', motivo: 'valor', venceEm };
    }
    return { estado: 'aberto', venceEm };
  }

  private fraseDoLink(sit: { estado: string; motivo?: string }): string {
    if (sit.estado === 'pago') return 'Este pedido já está pago 💜';
    if (sit.estado === 'vencido') {
      return 'Este link venceu — nada foi cobrado. Fale com a loja pra receber um link novo 💜';
    }
    if (sit.motivo === 'valor') {
      return 'O valor do seu pedido mudou depois que o link foi gerado — nada foi cobrado. Fale com a loja pra receber um link novo 💜';
    }
    return 'Este link não está mais ativo — nada foi cobrado. Fale com a loja 💜';
  }

  /** O código PIX do link que ainda dá tempo de pagar (margem de 2 min). */
  private pixVivoDoLink(cobr: any[]): any | null {
    const limite = Date.now() + 2 * 60_000;
    return (
      cobr.find(
        (c) =>
          c.origem === ORIGEM_LINK_PAGBANK &&
          c.method === 'pix' &&
          c.status === 'pending' &&
          c.expiresAt &&
          new Date(c.expiresAt).getTime() > limite,
      ) || null
    );
  }

  private async cartaoDoLinkInfo(storeCode: string, venda: any, cobr: any[]) {
    const max = maxTentativasCartaoLink();
    const usadas = cobr.filter((c) => c.method === 'credit_card').length;
    const emAnalise = cobr.some((c) => c.method === 'credit_card' && c.status === 'pending');
    let motivo: string | undefined;
    let publicKey: string | null = null;
    if (emAnalise) motivo = 'analise';
    else if (usadas >= max) motivo = 'tentativas';
    else {
      const falhou = this.chaveCartaoFalhouEm.get(storeCode) || 0;
      if (Date.now() - falhou < 60_000) motivo = 'indisponivel';
      else {
        try {
          publicKey = (await this.chavePublicaCartao(storeCode)).publicKey;
        } catch (e: any) {
          this.chaveCartaoFalhouEm.set(storeCode, Date.now());
          this.logger.warn(`[pagbank-link] chave pública da loja ${storeCode} indisponível: ${e?.message || e}`);
          motivo = 'indisponivel';
        }
      }
    }
    return {
      habilitado: !!publicKey && !motivo,
      publicKey,
      maxParcelas: maxParcelasLink(),
      tentativasRestantes: Math.max(0, max - usadas),
      emAnalise,
      precisaEmail: !PagbankService.RE_EMAIL.test(String(venda?.customerEmail || '').trim()),
      precisaCelular: !this.telefonePagbank(venda?.customerPhone),
      ...(motivo ? { motivo } : {}),
    };
  }

  /** Endereço de entrega da venda online no formato do PagBank — só se estiver completo. */
  private enderecoDaVenda(venda: any): PagbankEndereco | null {
    const cep = String(venda?.customerCep || '').replace(/\D/g, '');
    const street = String(venda?.customerEndereco || '').trim();
    const city = String(venda?.customerCidade || '').trim();
    const uf = String(venda?.customerUf || '').trim().toUpperCase();
    if (cep.length !== 8 || !street || !city || uf.length !== 2) return null;
    return {
      street,
      number: String(venda?.customerNumero || '').trim() || 'S/N',
      complement: String(venda?.customerComplemento || '').trim() || undefined,
      neighborhood: String(venda?.customerBairro || '').trim() || 'Centro',
      city,
      uf,
      cep,
    };
  }

  /** Grava e-mail/celular na venda SÓ onde ela não tem — nunca reescreve cadastro. */
  private async completarContatoDaVenda(saleId: string, email?: string | null, phone?: string | null): Promise<void> {
    const e = String(email || '').trim().slice(0, 254);
    let f = String(phone || '').replace(/\D/g, '');
    if ((f.length === 12 || f.length === 13) && f.startsWith('55')) f = f.slice(2);
    try {
      if (PagbankService.RE_EMAIL.test(e)) {
        await (this.prisma as any).pdvSale.updateMany({
          where: { id: saleId, OR: [{ customerEmail: null }, { customerEmail: '' }] },
          data: { customerEmail: e },
        });
      }
      if (f.length === 10 || f.length === 11) {
        await (this.prisma as any).pdvSale.updateMany({
          where: { id: saleId, OR: [{ customerPhone: null }, { customerPhone: '' }] },
          data: { customerPhone: f },
        });
      }
    } catch (err: any) {
      // Contato é bônus pra cobrança — nunca derruba o link.
      this.logger.warn(`[pagbank-link] contato não gravado na venda ${saleId}: ${err?.message || err}`);
    }
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

    return this.runTokenTest(cfg);
  }

  /**
   * Testa as credenciais PagBank de UMA loja (config propria; se nao tiver,
   * cai pro singleton matriz). Usado pelo painel de cobranca por loja.
   */
  async testStoreConnection(storeCode: string): Promise<any> {
    let cfg: any = null;
    let source = 'singleton';
    try {
      const sc = await (this.prisma as any).pagbankStoreConfig.findUnique({ where: { storeCode } });
      if (sc && sc.bearerToken) { cfg = sc; source = 'store'; }
    } catch { /* tabela pode nao existir — segue */ }
    if (!cfg) {
      cfg = await (this.prisma as any).pagbankConfig.findUnique({ where: { id: 'singleton' } });
    }
    if (!cfg || !cfg.bearerToken) {
      return {
        ok: false, source, ambiente: cfg?.ambiente || 'production',
        enabled: !!cfg?.enabled, hasToken: false,
        error: 'Sem token (nem na loja nem na matriz)',
      };
    }
    const r = await this.runTokenTest(cfg);
    return { ...r, source };
  }

  /** Core do teste de token PagBank (POST /orders vazio). */
  private async runTokenTest(cfg: { ambiente: string; bearerToken?: string; enabled?: boolean }): Promise<{
    ok: boolean;
    ambiente: string;
    enabled: boolean;
    hasToken: boolean;
    httpStatus?: number;
    error?: string;
    hint?: string;
  }> {
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

  /**
   * Celular no formato do PagBank (`{country, area, number, type}`), ou null
   * quando não dá pra montar — o chamador decide entre placeholder (PDV, que
   * pode não ter o número) e erro (site, que exige o número real).
   */
  private telefonePagbank(raw?: string | null): { country: string; area: string; number: string; type: 'MOBILE' } | null {
    let d = String(raw ?? '').replace(/\D/g, '').replace(/^0+/, '');
    if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
    if (d.length !== 10 && d.length !== 11) return null;
    return { country: '55', area: d.slice(0, 2), number: d.slice(2), type: 'MOBILE' };
  }

  /**
   * A URL DE AVISO ESTAVA APONTANDO PRO VAZIO (12/08/2026).
   *
   * O backend inteiro roda atrás do prefixo global `/api` (main.ts). Esta
   * função montava `.../pagbank/webhook` SEM o prefixo — endereço que não
   * existe. Medido em produção:
   *
   *   POST /pagbank/webhook      → 404
   *   POST /api/pagbank/webhook  → 201
   *
   * Ou seja: TODA cobrança PIX nascia mandando o PagBank avisar num lugar
   * onde ninguém atende. O pagamento caía na conta e o aviso morria num 404,
   * sem erro em lugar nenhum — nem no nosso log (a requisição nem chegava a
   * um controller), nem pra loja, que só via a venda não fechar. É a origem
   * dos chamados de "PIX PagBank sem comunicação".
   *
   * ⚠️ Mexer aqui exige conferir o painel do PagBank também: a URL cadastrada
   * lá (fora do `notification_urls` por pedido) precisa do mesmo `/api`.
   */
  private getWebhookUrl(): string {
    const base =
      process.env.BACKEND_PUBLIC_URL ||
      process.env.RAILWAY_PUBLIC_DOMAIN ||
      ''; // Pode estar vazio em dev — daí roda sem webhook
    if (!base) return '';
    const cleanBase = base.replace(/\/+$/, '');
    const comProtocolo = cleanBase.startsWith('http') ? cleanBase : `https://${cleanBase}`;
    // Se alguém já tiver posto o /api na env, não duplica.
    const raiz = comProtocolo.replace(/\/api$/, '');
    return `${raiz}/api/pagbank/webhook`;
  }
}
