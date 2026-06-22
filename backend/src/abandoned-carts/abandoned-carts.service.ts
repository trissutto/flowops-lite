import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

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

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

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
    if (!this.isFailed(primary)) return primary;

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
    if (!this.isFailed(primary)) return primary;

    // Fallback WooCommerce — normaliza pro mesmo shape PLANO que a tela espera
    // (stats?.abandoned, stats?.total_abandoned_value, etc).
    this.logger.warn(
      `[carrinhos] plugin WP falhou nas STATS, tentando fallback WooCommerce: ${(primary as any)?.error ?? ''}`,
    );
    const fb: any = await this.statsWcPending(since);
    if (this.isFailed(fb)) return primary; // mantém o erro do plugin (mais informativo)

    const by = fb.by_status || {};
    return {
      ok: true,
      source: 'woocommerce-fallback',
      abandoned: by.abandoned?.qty ?? 0,
      recovered: by.completed?.qty ?? 0,
      lost: by.lost?.qty ?? 0,
      total_abandoned_value: by.abandoned?.total ?? 0,
      total_recovered_value: by.completed?.total ?? 0,
      recovery_rate: fb.recovery_rate ?? 0,
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

  /**
   * Detalhe HIDRATADO: pega o detail do plugin PHP + enriquece cada cart_item
   * com dados completos do produto via WC REST (name, image, sku, price).
   */
  async detailFull(id: number) {
    const base = (await this.detail(id)) as any;
    if (!base || base.ok === false || !this.wcBase) return base;
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
