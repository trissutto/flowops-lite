import { HttpService } from '@nestjs/axios';
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { extractAttributionRaw } from '../woocommerce/attribution.util';

/**
 * Service pra ler dados do plugin "Cart Abandonment Recovery for WooCommerce"
 * (CartFlows) via REST do WordPress. O plugin PHP 'flowops-abandoned-carts'
 * precisa estar instalado em wp-content/mu-plugins/ do site.
 *
 * Config no .env do backend:
 *   FLOWOPS_WP_BASE=https://www.lurds.com.br/wp-json
 *   FLOWOPS_WP_KEY=<mesma chave do plugin>
 *
 * Todas as chamadas vão via HTTPS + X-FlowOps-Key (não precisa MySQL externo).
 */
@Injectable()
export class AbandonedCartsService {
  private readonly logger = new Logger(AbandonedCartsService.name);
  private readonly captureHits = new Map<string, number[]>();

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private enforceCaptureLimit(key: string, max: number, windowMs = 60_000) {
    const now = Date.now();
    const recent = (this.captureHits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= max) {
      // O site engole o erro pra não travar o checkout, então SEM este log
      // um descarte em massa é invisível: o relatório só para de ganhar
      // linhas e ninguém sabe por quê.
      this.logger.warn(`[carrinho] captura descartada por limite: ${key} (${recent.length}/${max} em ${windowMs}ms)`);
      throw new HttpException('Muitas tentativas', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.captureHits.set(key, recent);
    if (this.captureHits.size > 5_000) {
      for (const [storedKey, hits] of this.captureHits) {
        if (!hits.some((at) => now - at < windowMs)) this.captureHits.delete(storedKey);
      }
    }
  }

  /**
   * ACEITA AS DUAS FORMAS DE NOME DE CHAVE — e é por isso que existe.
   *
   * A lista de permitidos só tinha `utm_source`, `utm_medium`… e o site manda
   * `{ source, medium, campaign, term, content, id, gclid, fbclid }` (é o que
   * `captureAttribution()` monta, e é a mesma forma que o caminho do PEDIDO
   * usa). A interseção era VAZIA: o laço nunca casava nada, a coluna
   * `attribution` nascia e morria NULL, e a tela lia `utm_campaign` de um
   * objeto inexistente — sempre null. Ou seja: NUNCA foi possível saber de
   * qual campanha veio um carrinho abandonado.
   *
   * Mesma família do bug já catalogado em [utm-podado-antes-de-gravar]:
   * lista de permitidos que não bate com quem manda poda tudo CALADA.
   *
   * Grava sempre na forma longa (`utm_*`), que é o que a tela já espera.
   */
  private sanitizeAttribution(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const v = value as Record<string, unknown>;
    const result: Record<string, string> = {};

    const por = (destino: string, ...origens: string[]) => {
      for (const o of origens) {
        const raw = v[o];
        if (typeof raw === 'string' && raw.trim()) {
          result[destino] = raw.trim().slice(0, 200);
          return;
        }
      }
    };

    por('utm_source', 'source', 'utm_source');
    por('utm_medium', 'medium', 'utm_medium');
    por('utm_campaign', 'campaign', 'utm_campaign');
    por('utm_id', 'id', 'utm_id');
    por('utm_content', 'content', 'utm_content');
    por('utm_term', 'term', 'utm_term');
    // Estes três são o que LIGA o carrinho ao clique do anúncio — sem eles
      // não há como casar gasto com abandono.
    por('gclid', 'gclid');
    por('fbclid', 'fbclid');
    por('landing_page', 'landing_page');

    return Object.keys(result).length ? result : undefined;
  }

  async captureCheckout(input: any, clientIp = 'unknown') {
    const sessionId = String(input?.sessionId ?? '').trim().slice(0, 64);
    const nome = String(input?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const telefone = String(input?.phone ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    if (sessionId.length < 8 || nome.length < 2 || !/^\d{10,11}$/.test(telefone)) {
      throw new BadRequestException('Contato inválido');
    }
    /**
     * ⚠️ O TETO DE IP NÃO É POR PESSOA. A captura vem de um fetch
     * server-side do BFF na Vercel, que não repassa `x-forwarded-for`, e o
     * Nest não liga `trust proxy` — então `clientIp` é a BORDA do Railway,
     * um valor constante. O balde era UM SÓ pro site inteiro: 30 capturas
     * por minuto no total, e a 31ª virava 429 descartado em silêncio. Num
     * pico de live ou promoção isso derruba captura legítima em massa.
     *
     * Enquanto o IP real não chega aqui, o teto sobe pra um valor que só
     * um ataque alcança. A defesa de verdade contra uma mesma pessoa em
     * flood é o balde de CONTATO logo abaixo, que não depende de rede.
     */
    this.enforceCaptureLimit(`ip:${clientIp}`, 600);
    this.enforceCaptureLimit(`contact:${sessionId}:${telefone}`, 10);
    const rawItems = Array.isArray(input?.items) ? input.items.slice(0, 50) : [];
    const items = rawItems.map((item: any) => ({
      productId: String(item?.productId ?? '').slice(0, 120),
      name: String(item?.name ?? '').slice(0, 160),
      size: String(item?.size ?? '').slice(0, 30),
      color: String(item?.color ?? '').slice(0, 60),
      quantity: Math.min(99, Math.max(1, Number(item?.quantity) || 1)),
      unitPrice: Math.max(0, Number(item?.unitPrice) || 0),
    }));
    const data = {
      anonymousId: String(input?.anonymousId ?? '').slice(0, 64) || null,
      nome, telefone,
      recoveryConsent: input?.recoveryConsent === true,
      subtotal: Math.max(0, Number(input?.subtotal) || 0), items,
      path: String(input?.path ?? '').slice(0, 200) || null,
      attribution: this.sanitizeAttribution(input?.attribution),
    };
    await (this.prisma as any).checkoutRecovery.upsert({
      where: { sessionId },
      create: { sessionId, ...data, status: 'active' },
      update: data,
    });
    return { ok: true };
  }

  /**
   * Enriquece cada carrinho com a CAMPANHA de origem (utmCampaign) quando ele
   * tem `order_id` — cruzando com o Order local (que guarda a atribuição do WC).
   * Carrinho sem pedido (só e-mail capturado antes de "Finalizar compra") não
   * tem campanha: o CartFlows não guarda UTM, e o WC ainda não gerou o pedido.
   */
  private async enrichCampaign(items: any[]): Promise<void> {
    if (!Array.isArray(items) || !items.length) return;
    const ids = Array.from(
      new Set(
        items
          .map((it) => Number(it?.order_id))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    );
    if (!ids.length) return;
    try {
      const orders = await (this.prisma as any).order.findMany({
        where: { wcOrderId: { in: ids } },
        select: { wcOrderId: true, utmCampaign: true },
      });
      const byId = new Map<number, string | null>();
      for (const o of orders) byId.set(Number(o.wcOrderId), o.utmCampaign ?? null);
      for (const it of items) {
        const oid = Number(it?.order_id);
        if (byId.has(oid)) it.utmCampaign = byId.get(oid);
      }
    } catch (e: any) {
      this.logger.warn(`[carrinhos] enrichCampaign falhou: ${e?.message ?? e}`);
    }
  }

  private get base(): string | null {
    const b = this.config.get<string>('FLOWOPS_WP_BASE');
    if (!b) return null;
    return b.replace(/\/+$/, '');
  }

  private get key(): string | null {
    return this.config.get<string>('FLOWOPS_WP_KEY') ?? null;
  }

  private async call<T extends object>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T | { ok: false; error: string; details?: any }> {
    if (!this.base || !this.key) {
      return {
        ok: false,
        error:
          'FLOWOPS_WP_BASE/FLOWOPS_WP_KEY ausentes no .env do backend. Adicione as 2 variáveis e reinicie o backend.',
      };
    }
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      params.set(k, String(v));
    }
    const url = `${this.base}${path}${
      params.toString() ? '?' + params.toString() : ''
    }`;
    try {
      const res = await firstValueFrom(
        this.http.get<T>(url, {
          headers: { 'X-FlowOps-Key': this.key },
          timeout: 30_000,
        }),
      );
      return res.data;
    } catch (e: any) {
      const status = e?.response?.status;
      const payload = e?.response?.data;
      let hint = '';
      if (status === 401) {
        hint = ' (chave inválida — confira FLOWOPS_WP_KEY no backend × constante FLOWOPS_WP_KEY no arquivo .php)';
      } else if (status === 404) {
        hint = ' (rota não existe — o plugin .php está em wp-content/mu-plugins/ e o WP tá com permalinks ativos?)';
      } else if (!status) {
        hint = ` (sem resposta do servidor — confere FLOWOPS_WP_BASE="${this.base}" e se o site tá acessível)`;
      }
      const msg = payload?.message ?? e?.message ?? 'erro desconhecido';
      this.logger.warn(
        `WP REST falhou ${status ?? 'no-status'} ${path}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`,
      );
      return {
        ok: false,
        error: `WP REST ${status ?? '???'} ${path}${hint}: ${
          typeof msg === 'string' ? msg : JSON.stringify(msg)
        }`,
        details: {
          status,
          url,
          payload,
          code: e?.code,
        },
      };
    }
  }

  /** Diagnóstico — confirma que o plugin tá instalado e conseguiu achar a tabela. */
  async schema() {
    return this.call<any>('/flowops/v1/abandoned-carts/schema');
  }

  /** Ping simples pra verificar chave. */
  async ping() {
    return this.call<any>('/flowops/v1/ping');
  }

  /** Considera "falhou" se veio null/undefined ou um envelope { ok: false }. */
  private isFailed(r: any): boolean {
    return !r || r.ok === false;
  }

  /**
   * Achata qualquer formato de stats pras chaves PLANAS que a tela lê.
   * O plugin/WC pode mandar aninhado (by_status.abandoned.qty/total) — a tela
   * lê plano (stats.abandoned). Sem isso, os cards ficavam 0 mesmo com lista cheia.
   */
  private normalizeStats(s: any): any {
    if (!s || typeof s !== 'object') return s;
    const by = s.by_status || {};
    const pick = (...vs: any[]): number => {
      for (const v of vs) if (v !== undefined && v !== null) return Number(v) || 0;
      return 0;
    };
    const ab = by.abandoned || {};
    const rec = by.completed || by.recovered || {};
    const lo = by.lost || {};
    return {
      ...s,
      abandoned: pick(s.abandoned, ab.qty, ab.count),
      recovered: pick(s.recovered, s.completed, rec.qty, rec.count),
      lost: pick(s.lost, lo.qty, lo.count),
      total_abandoned_value: pick(s.total_abandoned_value, ab.total, ab.value),
      total_recovered_value: pick(s.total_recovered_value, rec.total, rec.value),
      recovery_rate: pick(s.recovery_rate),
    };
  }

  async list(params: {
    page?: number;
    perPage?: number;
    status?: string;
    since?: string;
    until?: string;
    search?: string;
  }) {
    const primary = await this.call<any>('/flowops/v1/abandoned-carts/list', {
      page: params.page,
      per_page: params.perPage,
      status: params.status,
      since: params.since,
      until: params.until,
      search: params.search,
    });
    if (!this.isFailed(primary)) {
      // Cruza order_id → campanha (Order local com atribuição do WC).
      await this.enrichCampaign((primary as any)?.items);
      return primary;
    }

    // Plugin WP indisponível (404/401/sem env/site fora) → cai pro WooCommerce
    // REST, que não depende do plugin .php. Antes a aba ficava EM BRANCO aqui.
    this.logger.warn(
      `[carrinhos] plugin WP falhou na LISTA, tentando fallback WooCommerce: ${(primary as any)?.error ?? ''}`,
    );
    const fb: any = await this.listWcPending(params);
    if (!this.isFailed(fb)) {
      fb.pluginError = (primary as any)?.error;
      return fb;
    }
    // Os dois caminhos falharam — devolve um erro que explica ambos.
    return {
      ok: false,
      error:
        'Não foi possível buscar carrinhos nem pelo plugin do WordPress nem pelo WooCommerce.',
      pluginError: (primary as any)?.error,
      wcError: (fb as any)?.error,
    };
  }

  async detail(id: number) {
    return this.call<any>(`/flowops/v1/abandoned-carts/detail/${id}`);
  }

  async stats(since?: string) {
    const primary = await this.call<any>('/flowops/v1/abandoned-carts/stats', { since });
    // Mesmo quando o plugin responde, achata o formato pras chaves planas que a
    // tela lê — era esse o motivo dos cards ficarem 0 com a lista cheia.
    if (!this.isFailed(primary)) return this.normalizeStats(primary);

    this.logger.warn(
      `[carrinhos] plugin WP falhou nas STATS, tentando fallback WooCommerce: ${(primary as any)?.error ?? ''}`,
    );
    const fb: any = await this.statsWcPending(since);
    if (this.isFailed(fb)) return primary; // mantém o erro do plugin (mais informativo)

    return {
      ...this.normalizeStats(fb),
      source: 'woocommerce-fallback',
      warning: fb.warning,
      pluginError: (primary as any)?.error,
    };
  }

  // ==========================================================================
  // Fallback via WooCommerce REST API (não depende do plugin .php no WP).
  // Usa pedidos com status pending/failed/on-hold/checkout-draft como proxy
  // de "carrinho abandonado". É parcial — só pega quem chegou a criar pedido
  // (tipo iniciou checkout e não pagou), não os carrinhos que morreram antes.
  // Mas funciona sem upload de nada.
  // ==========================================================================

  /** URL base da REST v3 do WooCommerce. */
  private get wcBase(): string | null {
    const url = this.config.get<string>('WC_URL');
    if (!url) return null;
    return `${url.replace(/\/+$/, '')}/wp-json/wc/v3`;
  }

  /** Basic Auth pra WC (ck_/cs_). */
  private get wcAuth() {
    return {
      username: this.config.get<string>('WC_CONSUMER_KEY') ?? '',
      password: this.config.get<string>('WC_CONSUMER_SECRET') ?? '',
    };
  }

  /**
   * Lista "carrinhos abandonados" via WooCommerce REST — pedidos em pending,
   * failed, on-hold. Faz 1 request por status (a API do WC não aceita múltiplos
   * status em 1 call de forma confiável dependendo da versão), e junta tudo.
   */
  async listWcPending(params: {
    page?: number;
    perPage?: number;
    status?: string; // abandoned | recovered | lost | all
    since?: string;  // YYYY-MM-DD
    until?: string;
    search?: string;
  }) {
    if (!this.wcBase || !this.wcAuth.username || !this.wcAuth.password) {
      return {
        ok: false,
        error:
          'WC_URL/WC_CONSUMER_KEY/WC_CONSUMER_SECRET ausentes no .env. Não dá pra fazer fallback via WooCommerce.',
      };
    }

    // Mapeia o "status" do plugin pra statuses do WC:
    //   abandoned → pending, failed, on-hold (pedido iniciado, sem pagamento)
    //   recovered → processing, completed (pagou depois)
    //   lost      → cancelled
    //   all       → pending, failed, on-hold, cancelled
    let wcStatuses: string[];
    switch (params.status) {
      case 'recovered':
      case 'completed': // frontend manda 'completed' como rótulo de recuperado
        wcStatuses = ['processing', 'completed'];
        break;
      case 'lost':
        wcStatuses = ['cancelled'];
        break;
      case 'all':
      case undefined:
      case '':
        wcStatuses = ['pending', 'failed', 'on-hold', 'cancelled'];
        break;
      default:
        wcStatuses = ['pending', 'failed', 'on-hold'];
    }

    const perPage = Math.min(params.perPage ?? 50, 100);
    const page = params.page ?? 1;

    // Converte datas pra ISO que o WC entende (after/before).
    const after = params.since ? new Date(params.since + 'T00:00:00').toISOString() : undefined;
    const before = params.until ? new Date(params.until + 'T23:59:59').toISOString() : undefined;

    // Faz 1 request por status e agrega.
    const all: any[] = [];
    let totalAggregated = 0;
    for (const st of wcStatuses) {
      const qs: Record<string, any> = {
        per_page: perPage,
        page,
        orderby: 'date',
        order: 'desc',
        status: st,
      };
      if (after) qs.after = after;
      if (before) qs.before = before;
      if (params.search) qs.search = params.search;

      try {
        const res = await firstValueFrom(
          this.http.get(`${this.wcBase}/orders`, {
            auth: this.wcAuth,
            params: qs,
            timeout: 30_000,
          }),
        );
        const arr = Array.isArray(res.data) ? res.data : [];
        totalAggregated += Number(res.headers['x-wp-total'] ?? arr.length);
        for (const o of arr) all.push(o);
      } catch (e: any) {
        this.logger.warn(
          `WC fallback falhou status=${st}: ${e?.response?.status ?? ''} ${e?.message ?? ''}`,
        );
      }
    }

    // Normaliza pra mesma shape do plugin .php (/list).
    const items = all.map((o) => {
      const b = o.billing ?? {};
      const s = o.shipping ?? {};
      // Mapeia WC status → rótulo padrão "abandoned/recovered/lost"
      let order_status: string;
      if (['processing', 'completed'].includes(o.status)) order_status = 'recovered';
      else if (o.status === 'cancelled') order_status = 'lost';
      else order_status = 'abandoned';

      return {
        id: o.id,
        email: b.email ?? '',
        first_name: b.first_name ?? s.first_name ?? '',
        last_name: b.last_name ?? s.last_name ?? '',
        phone: b.phone ?? '',
        city: b.city ?? s.city ?? '',
        state: b.state ?? s.state ?? '',
        cart_total: Number(o.total ?? 0),
        items_count: Array.isArray(o.line_items)
          ? o.line_items.reduce((acc: number, li: any) => acc + Number(li.quantity ?? 0), 0)
          : 0,
        order_status,
        wc_status: o.status,
        // WC retorna algo tipo "2026-04-19T13:00:00" (sem tz). O frontend já
        // appenda 'Z' no fmtDate(), então NÃO appenda aqui (ou dava "...ZZ" → Invalid Date).
        time: o.date_created_gmt ?? o.date_created ?? null,
        order_id: o.id,
        source: 'woocommerce',
        // Campanha de origem — meta_data do próprio pedido WC já está à mão aqui.
        utmCampaign: extractAttributionRaw(o.meta_data ?? []).utmCampaign,
      };
    });

    // Ordena por data desc já que juntamos vários status.
    items.sort((a, b) => {
      const ta = a.time ? Date.parse(a.time) : 0;
      const tb = b.time ? Date.parse(b.time) : 0;
      return tb - ta;
    });

    // KPIs rápidos em cima do resultado atual (não agrega tudo do WC).
    const stats = {
      abandoned: items.filter((i) => i.order_status === 'abandoned').length,
      recovered: items.filter((i) => i.order_status === 'recovered').length,
      lost: items.filter((i) => i.order_status === 'lost').length,
      recovery_rate: 0,
      total_abandoned_value: items
        .filter((i) => i.order_status === 'abandoned')
        .reduce((acc, i) => acc + (i.cart_total || 0), 0),
      total_recovered_value: items
        .filter((i) => i.order_status === 'recovered')
        .reduce((acc, i) => acc + (i.cart_total || 0), 0),
    };
    const base = stats.abandoned + stats.recovered + stats.lost;
    stats.recovery_rate = base > 0 ? (stats.recovered / base) * 100 : 0;

    return {
      ok: true,
      source: 'woocommerce-fallback',
      warning:
        'Dados parciais via WooCommerce REST (pedidos iniciados sem pagamento). Instale o plugin flowops-abandoned-carts em wp-content/mu-plugins/ pra ver carrinhos que nem viraram pedido.',
      items,
      total: totalAggregated,
      page,
      per_page: perPage,
      total_pages: Math.ceil(totalAggregated / perPage) || 1,
      stats,
    };
  }

  /** Stats agregadas via fallback WC — conta tudo dentro do período. */
  async statsWcPending(since?: string, until?: string) {
    if (!this.wcBase || !this.wcAuth.username || !this.wcAuth.password) {
      return {
        ok: false,
        error: 'WC_URL/WC_CONSUMER_KEY/WC_CONSUMER_SECRET ausentes no .env.',
      };
    }

    const after = since ? new Date(since + 'T00:00:00').toISOString() : undefined;
    const before = until ? new Date(until + 'T23:59:59').toISOString() : undefined;

    const groups: Record<string, string[]> = {
      abandoned: ['pending', 'failed', 'on-hold'],
      recovered: ['processing', 'completed'],
      lost: ['cancelled'],
    };

    const result: any = {
      abandoned: 0,
      recovered: 0,
      lost: 0,
      recovery_rate: 0,
      total_abandoned_value: 0,
      total_recovered_value: 0,
    };

    // Dispara TODAS as chamadas em paralelo (antes era sequencial — 6 requests
    // tomando ~7-10s). Com Promise.all cai pra ~1-2s.
    const tasks: Array<Promise<void>> = [];
    for (const [group, statuses] of Object.entries(groups)) {
      for (const st of statuses) {
        tasks.push(
          (async () => {
            try {
              const res = await firstValueFrom(
                this.http.get(`${this.wcBase}/orders`, {
                  auth: this.wcAuth,
                  params: {
                    status: st,
                    per_page: 100,
                    page: 1,
                    orderby: 'date',
                    order: 'desc',
                    ...(after ? { after } : {}),
                    ...(before ? { before } : {}),
                  },
                  timeout: 30_000,
                }),
              );
              const count = Number(res.headers['x-wp-total'] ?? 0);
              result[group] += count;
              if (group === 'abandoned' || group === 'recovered') {
                const sum = (Array.isArray(res.data) ? res.data : []).reduce(
                  (acc: number, o: any) => acc + Number(o.total ?? 0),
                  0,
                );
                if (group === 'abandoned') result.total_abandoned_value += sum;
                else result.total_recovered_value += sum;
              }
            } catch (e: any) {
              this.logger.warn(
                `WC stats fallback falhou status=${st}: ${e?.response?.status ?? ''} ${e?.message ?? ''}`,
              );
            }
          })(),
        );
      }
    }
    await Promise.all(tasks);

    const base = result.abandoned + result.recovered + result.lost;
    result.recovery_rate = base > 0 ? (result.recovered / base) * 100 : 0;

    // Shape compatível com o plugin .php (by_status.<slug>.qty/total + recovery_rate)
    return {
      ok: true,
      source: 'woocommerce-fallback',
      warning:
        'KPIs parciais via WC REST — não inclui carrinhos que morreram antes de virar pedido. Instale o plugin flowops-abandoned-carts pra cobertura total.',
      since: since ?? null,
      total_all: result.abandoned + result.recovered + result.lost,
      total_value: result.total_abandoned_value + result.total_recovered_value,
      by_status: {
        abandoned: { qty: result.abandoned, total: result.total_abandoned_value },
        completed: { qty: result.recovered, total: result.total_recovered_value },
        lost: { qty: result.lost, total: 0 },
      },
      recovery_rate: result.recovery_rate,
    };
  }

  // ==========================================================================
  // E-COMMERCE NOVO (lurdsplussize.com.br) — pedidos source='ecommerce' do
  // NOSSO Postgres que começaram o checkout e não pagaram. Não depende de WP
  // nem de plugin. Sacola sem checkout NÃO entra aqui: o add_to_cart do
  // site_eventos é anônimo (só session_id) — sem nome/telefone não existe
  // recuperação possível.
  // ==========================================================================

  async listEcommercePending(params: {
    status?: string; // abandoned | recovered/completed | lost | all
    since?: string;  // YYYY-MM-DD
    until?: string;
    search?: string;
  }) {
    const where: any = { source: 'ecommerce' };
    if (params.since || params.until) {
      where.createdAt = {};
      if (params.since) where.createdAt.gte = new Date(params.since + 'T00:00:00');
      if (params.until) where.createdAt.lte = new Date(params.until + 'T23:59:59');
    }
    // Mesma semântica do fallback WC:
    //   abandoned → checkout iniciado sem pagamento (awaiting_payment/expired)
    //   recovered → pagou depois (paidAt preenchido)
    //   lost      → cancelado sem pagar
    switch (params.status) {
      case 'recovered':
      case 'completed':
        where.paidAt = { not: null };
        break;
      case 'lost':
        where.paidAt = null;
        where.status = 'cancelled';
        break;
      case 'all':
      case undefined:
      case '':
        break;
      default: // abandoned
        where.paidAt = null;
        where.status = { not: 'cancelled' };
        /**
         * IDADE MÍNIMA — sem isto o relatório cutuca quem está pagando.
         *
         * Desde 17/08 o clique no PIX JÁ CRIA o pedido em `awaiting_payment`.
         * Sem piso de idade, ele entrava na lista de "abandonados" segundos
         * depois do toque, enquanto a cliente ainda estava com o QR Code na
         * tela — e a tela (que recarrega a cada 60s) oferecia o botão de
         * WhatsApp pra cobrar alguém no meio do pagamento. Alarme falso mata
         * a confiança na lista inteira, do mesmo jeito que matou na fila de
         * tarefas da loja.
         *
         * O piso é o MESMO do `PixResgateCron` (env `PIX_RESGATE_MIN`, 30min):
         * o sistema já sabia qual era a espera certa e as duas telas
         * discordavam. Vale só no ramo "abandoned" — em `all`/`recovered` o
         * pedido recém-pago tem que continuar aparecendo.
         */
        {
          const esperaMin = Number(process.env.PIX_RESGATE_MIN) || 30;
          const teto = new Date(Date.now() - esperaMin * 60_000);
          where.createdAt = { ...(where.createdAt ?? {}), lte: teto };
        }
    }
    if (params.search) {
      where.OR = [
        { customerName: { contains: params.search, mode: 'insensitive' } },
        { customerEmail: { contains: params.search, mode: 'insensitive' } },
        { customerPhone: { contains: params.search } },
      ];
    }

    try {
      const orders = await (this.prisma as any).order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { items: true },
      });

      const items = orders.map((o: any) => {
        const nome = String(o.customerName ?? '').trim();
        const sp = nome.indexOf(' ');
        let order_status = 'abandoned';
        if (o.paidAt) order_status = 'recovered';
        else if (o.status === 'cancelled') order_status = 'lost';
        const cartItems = (o.items ?? []).map((it: any) => ({
          name: it.productName || it.sku,
          sku: it.sku,
          quantity: Number(it.quantity ?? 1),
          price: Number(it.unitPrice ?? 0),
          line_subtotal: Number(it.unitPrice ?? 0) * Number(it.quantity ?? 1),
        }));
        return {
          id: Number(o.wcOrderId),
          email: o.customerEmail ?? '',
          first_name: sp > 0 ? nome.slice(0, sp) : nome,
          last_name: sp > 0 ? nome.slice(sp + 1) : '',
          phone: o.customerPhone ?? '',
          city: '',
          state: '',
          cart_total: Number(o.totalAmount ?? 0),
          items_count: cartItems.reduce((acc: number, it: any) => acc + it.quantity, 0),
          order_status,
          time: o.createdAt ? o.createdAt.toISOString() : null,
          order_id: Number(o.wcOrderId),
          order_number: o.wcOrderNumber ?? null,
          source: 'ecommerce',
          utmCampaign: o.utmCampaign ?? null,
          cart_items: cartItems,
        };
      });

      // Contatos capturados antes de existir pedido. O status acompanha os
      // mesmos filtros da tela e evita misturar quem já concluiu com abandono.
      const recoveryWhere: any = {};
      if (params.since || params.until) {
        recoveryWhere.updatedAt = {};
        if (params.since) recoveryWhere.updatedAt.gte = new Date(params.since + 'T00:00:00');
        if (params.until) recoveryWhere.updatedAt.lte = new Date(params.until + 'T23:59:59');
      }
      if (params.status === 'recovered' || params.status === 'completed') recoveryWhere.status = 'converted';
      else if (params.status !== 'all') recoveryWhere.status = 'active';
      if (params.search) recoveryWhere.OR = [
        { nome: { contains: params.search, mode: 'insensitive' } },
        { telefone: { contains: String(params.search).replace(/\D/g, '') } },
      ];
      const recoveries = await (this.prisma as any).checkoutRecovery.findMany({
        where: recoveryWhere, orderBy: { updatedAt: 'desc' }, take: 200,
      });
      const orderSessions = new Set(orders.map((o: any) => {
        try { return JSON.parse(o.trackingInfo || '{}').session_id; } catch { return null; }
      }).filter(Boolean));
      /**
       * DEDUP TAMBÉM POR TELEFONE — a sessão não basta.
       *
       * O `session_id` do site morre com 30 min de inatividade, mas o
       * rascunho do checkout sobrevive no sessionStorage. Quem preenche o
       * contato, sai 40 minutos e volta pra tocar no PIX gera DUAS chaves:
       * a captura com a sessão velha e o pedido com a nova. As duas linhas
       * apareciam, e a loja abordava a mesma pessoa duas vezes.
       *
       * O telefone é a identidade real da cliente, e é por ele que a
       * recuperação fala com ela. Mesma normalização da captura: só dígitos.
       */
      const soDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
      const orderPhones = new Set(
        orders.map((o: any) => soDigitos(o.customerPhone)).filter((p: string) => p.length >= 10),
      );
      /**
       * O OPT-IN VIROU SELO, NÃO FILTRO (17/08).
       *
       * A linha era DESCARTADA quando a cliente não marcava a caixinha — e a
       * caixinha nasce DESMARCADA. Resultado: a etapa 1 capturava nome,
       * telefone e sacola de todo mundo, e o relatório mostrava só a fatia
       * que marcou espontaneamente. O dono perguntava "os carrinhos estão
       * chegando no relatório?" e a resposta era "uma fração deles, sem
       * nenhum aviso na tela".
       *
       * Consentimento é permissão pra CONTATAR, não pra CONTAR. Agora a
       * linha aparece com `optin: false` e a tela esconde o botão de
       * WhatsApp nela — a restrição vive no botão, onde ela significa algo,
       * e não na query, onde ela apagava a informação de gestão.
       *
       * Isso também acaba com a assimetria que a outra metade da lista já
       * tinha: pedido `awaiting_payment` nunca teve filtro de opt-in, então
       * quem não marcava ficava invisível na etapa 1 e reaparecia com
       * telefone assim que tocava no PIX.
       */
      const recoveryItems = recoveries
        .filter((r: any) => !orderSessions.has(r.sessionId) && !orderPhones.has(r.telefone))
        .map((r: any, index: number) => {
          // COR E TAMANHO NA LINHA (dono, 17/08: "os itens estão sem a cor").
          // A captura sempre gravou `color` e `size`; o mapeamento jogava fora e
          // a loja via "Blusa Manga Curta — SMILE" sem saber qual cor nem qual
          // número separar. Formato da casa: REF · COR TAM.
          const cartItems = Array.isArray(r.items) ? r.items.map((it: any) => {
            const cor = String(it.color || '').trim();
            const tam = String(it.size || '').trim();
            const variacao = [cor, tam].filter(Boolean).join(' ');
            return {
              name: (it.name || it.productId) + (variacao ? ` · ${variacao}` : ''),
              sku: it.productId, cor: cor || null, tamanho: tam || null,
              quantity: Number(it.quantity || 1),
              price: Number(it.unitPrice || 0), line_subtotal: Number(it.unitPrice || 0) * Number(it.quantity || 1),
            };
          }) : [];
          const sp = String(r.nome).indexOf(' ');
          return {
            id: 970000000 + index, recovery_id: r.id, session_id: r.sessionId,
            email: '', first_name: sp > 0 ? r.nome.slice(0, sp) : r.nome,
            last_name: sp > 0 ? r.nome.slice(sp + 1) : '', phone: r.telefone,
            city: '', state: '', cart_total: Number(r.subtotal || 0),
            items_count: cartItems.reduce((sum: number, it: any) => sum + it.quantity, 0),
            order_status: r.status === 'converted' ? 'recovered' : 'abandoned',
            time: r.updatedAt?.toISOString?.() ?? null, order_id: null, order_number: null,
            source: 'ecommerce-contact',
            // Aceita as duas formas: registros gravados ANTES do conserto do
            // sanitizeAttribution têm a coluna NULL, os novos têm `utm_*`.
            utmCampaign: (r.attribution as any)?.utm_campaign ?? (r.attribution as any)?.campaign ?? null,
            optin: r.recoveryConsent === true,
            cart_items: cartItems,
          };
        });
      items.unshift(...recoveryItems);

      const stats = {
        abandoned: items.filter((i: any) => i.order_status === 'abandoned').length,
        recovered: items.filter((i: any) => i.order_status === 'recovered').length,
        lost: items.filter((i: any) => i.order_status === 'lost').length,
        recovery_rate: 0,
        total_abandoned_value: items
          .filter((i: any) => i.order_status === 'abandoned')
          .reduce((acc: number, i: any) => acc + (i.cart_total || 0), 0),
        total_recovered_value: items
          .filter((i: any) => i.order_status === 'recovered')
          .reduce((acc: number, i: any) => acc + (i.cart_total || 0), 0),
      };
      const base = stats.abandoned + stats.recovered + stats.lost;
      stats.recovery_rate = base > 0 ? (stats.recovered / base) * 100 : 0;

      return { ok: true, source: 'ecommerce', items, total: items.length, stats };
    } catch (e: any) {
      this.logger.warn(`[carrinhos] lista ecommerce falhou: ${e?.message ?? e}`);
      return { ok: false, error: `Falha ao buscar carrinhos do e-commerce novo: ${e?.message ?? e}` };
    }
  }

  /**
   * Detalhe HIDRATADO: pega o detail do plugin PHP + enriquece cada cart_item
   * com dados completos do produto via WC REST (name, image, sku, price).
   */
  async detailFull(id: number) {
    const base = (await this.detail(id)) as any;
    if (!base || base.ok === false || !this.wcBase) return base;
    // Campanha de origem (via order_id → Order local com atribuição do WC).
    await this.enrichCampaign([base]);
    const items: any[] = Array.isArray(base?.cart_items) ? base.cart_items : [];
    if (items.length === 0) return base;

    const enriched = await Promise.all(items.map(async (it) => {
      const pid = it.variation_id || it.product_id;
      if (!pid) return it;
      try {
        const res = await firstValueFrom(
          this.http.get(`${this.wcBase}/products/${pid}`, {
            auth: this.wcAuth, timeout: 15_000,
          }),
        );
        const p: any = res.data || {};
        const img = Array.isArray(p.images) && p.images.length > 0 ? p.images[0].src : null;
        return {
          ...it,
          name: p.name || it.name || `Produto #${pid}`,
          sku: p.sku || it.sku || '',
          permalink: p.permalink || null,
          image: img,
          price: Number(p.price ?? 0),
          regular_price: Number(p.regular_price ?? 0),
          stock_status: p.stock_status || null,
          categories: Array.isArray(p.categories) ? p.categories.map((c: any) => c.name).join(', ') : '',
        };
      } catch (e: any) {
        this.logger.warn(`Falha ao hidratar produto ${pid}: ${e?.message ?? ''}`);
        return { ...it, name: it.name || `Produto #${pid}` };
      }
    }));

    return { ...base, cart_items: enriched };
  }
}
