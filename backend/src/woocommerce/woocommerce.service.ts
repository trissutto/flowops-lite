import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Cliente REST do WooCommerce.
 * - Autenticação: Basic Auth (consumer_key / consumer_secret).
 * - Loga toda saída em integration_logs.
 */
@Injectable()
export class WooCommerceService {
  private readonly logger = new Logger(WooCommerceService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get baseUrl() {
    return `${this.config.get('WC_URL')}/wp-json/wc/v3`;
  }
  private get auth() {
    return {
      username: this.config.get<string>('WC_CONSUMER_KEY') ?? '',
      password: this.config.get<string>('WC_CONSUMER_SECRET') ?? '',
    };
  }

  async updateOrderStatus(wcOrderId: number, status: string) {
    try {
      const res = await firstValueFrom(
        this.http.put(`${this.baseUrl}/orders/${wcOrderId}`, { status }, { auth: this.auth }),
      );
      await this.log('out', 'order.update_status', { wcOrderId, status }, res.status);
      return res.data;
    } catch (e: any) {
      await this.log('out', 'order.update_status', { wcOrderId, status }, e?.response?.status, e.message);
      throw e;
    }
  }

  /** Retorna um pedido específico do WC (detalhe completo). */
  async getOrder(wcOrderId: number) {
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/orders/${wcOrderId}`, { auth: this.auth }),
    );
    return res.data;
  }

  /**
   * Atualização genérica de pedido — permite mandar status + meta_data + nota ao cliente
   * na mesma chamada.
   */
  async updateOrder(
    wcOrderId: number,
    payload: {
      status?: string;
      trackingNumber?: string;
      trackingCarrier?: string;
      trackingUrl?: string;
      customerNote?: string;
    },
  ) {
    const meta: Array<{ key: string; value: string }> = [];
    if (payload.trackingNumber !== undefined) {
      // WooCommerce Shipment Tracking (Woo oficial)
      meta.push({ key: '_tracking_number', value: payload.trackingNumber });
      // Correios (Claudio Sanches / Magenteiro) — o plugin mais comum no BR
      meta.push({ key: '_correios_tracking_code', value: payload.trackingNumber });
      // Melhor Envio
      meta.push({ key: '_melhorenvio_tracking', value: payload.trackingNumber });
    }
    if (payload.trackingCarrier !== undefined) {
      meta.push({ key: '_tracking_carrier', value: payload.trackingCarrier });
      // Compat com plugins diversos
      meta.push({ key: '_tracking_provider', value: payload.trackingCarrier });
    }
    if (payload.trackingUrl !== undefined) {
      meta.push({ key: '_tracking_url', value: payload.trackingUrl });
    }

    // Normaliza status — tira o prefixo "wc-" se vier (WC REST aceita sem prefixo)
    const cleanStatus = payload.status ? payload.status.replace(/^wc-/, '') : undefined;

    const body: any = {};
    if (cleanStatus) body.status = cleanStatus;
    if (meta.length) body.meta_data = meta;
    if (payload.customerNote) body.customer_note = payload.customerNote;

    const doPut = async (putBody: any) =>
      firstValueFrom(
        this.http.put(`${this.baseUrl}/orders/${wcOrderId}`, putBody, { auth: this.auth }),
      );

    // --- ESTRATÉGIA RESILIENTE ---------------------------------------------
    // 1) Tenta body completo (status+meta+nota)
    // 2) Se status foi rejeitado ou ignorado, tenta com prefixo "wc-"
    // 3) Se ainda assim não aplica, salva SEM o status (só meta/nota) e
    //    devolve um warning em vez de 500 — assim tracking e nota vão pro site
    //    mesmo que o status não exista no WC.
    // ------------------------------------------------------------------------

    const bodyNoStatus: any = { ...body };
    delete bodyNoStatus.status;
    const hasOtherFields = Object.keys(bodyNoStatus).length > 0;

    this.logger.log(`[WC UPDATE] orderId=${wcOrderId} body=${JSON.stringify(body)}`);

    // Tentativa 1: body como veio
    try {
      const res = await doPut(body);
      this.logger.log(`[WC UPDATE] HTTP ${res.status} status_returned=${res.data?.status}`);

      // HTTP 200 mas status não foi aplicado → retry com prefixo wc-
      if (cleanStatus && res.data?.status !== cleanStatus) {
        this.logger.warn(
          `[WC UPDATE] status NÃO aplicado (pedido=${cleanStatus}, retornado=${res.data?.status}). Retry com "wc-${cleanStatus}"`,
        );
        try {
          const res2 = await doPut({ ...body, status: `wc-${cleanStatus}` });
          if (res2.data?.status === cleanStatus) {
            await this.log('out', 'order.update', { wcOrderId, body, note: 'retry-wc-prefix' }, res2.status);
            return res2.data;
          }
          this.logger.warn(`[WC UPDATE] retry tb não aplicou (retornado=${res2.data?.status})`);
        } catch (e2: any) {
          this.logger.warn(`[WC UPDATE][retry] falhou: ${e2.message}`);
        }
      }

      await this.log(
        'out',
        'order.update',
        { wcOrderId, body, responseStatus: res.data?.status },
        res.status,
      );
      return res.data;
    } catch (e: any) {
      const httpStatus = e?.response?.status;
      const apiErr = e?.response?.data;
      this.logger.error(`[WC UPDATE] ERRO HTTP ${httpStatus} ${JSON.stringify(apiErr ?? e.message)}`);

      // Se o erro foi causado pelo status (ex: 400 "Estado não válido"), tenta com prefixo
      const looksLikeStatusError =
        cleanStatus &&
        httpStatus === 400 &&
        (String(apiErr?.code ?? '').includes('order_status') ||
          String(apiErr?.message ?? '').toLowerCase().includes('status') ||
          String(apiErr?.message ?? '').toLowerCase().includes('estado'));

      if (looksLikeStatusError) {
        // Retry com prefixo wc-
        try {
          const res2 = await doPut({ ...body, status: `wc-${cleanStatus}` });
          if (res2.data?.status === cleanStatus) {
            this.logger.log(`[WC UPDATE][retry-prefix] aplicou com "wc-${cleanStatus}"`);
            await this.log('out', 'order.update', { wcOrderId, body, note: 'retry-wc-prefix-after-400' }, res2.status);
            return res2.data;
          }
        } catch (e2: any) {
          this.logger.warn(`[WC UPDATE][retry-prefix] também falhou: ${e2.message}`);
        }

        // Última cartada: salva SEM o status (só meta/nota) e marca a resposta
        if (hasOtherFields) {
          try {
            const res3 = await doPut(bodyNoStatus);
            this.logger.warn(`[WC UPDATE] salvou SEM o status — status "${cleanStatus}" não existe no WC`);
            await this.log(
              'out',
              'order.update',
              { wcOrderId, body: bodyNoStatus, note: 'saved-without-status', rejectedStatus: cleanStatus },
              res3.status,
            );
            // Retorna os dados SEM o status novo — o controller vai detectar
            // que `status !== requestedStatus` e avisar o usuário.
            return {
              ...res3.data,
              _flowops_statusRejected: cleanStatus,
              _flowops_apiError: apiErr?.message ?? 'Status não aceito pelo WooCommerce.',
            };
          } catch (e3: any) {
            this.logger.error(`[WC UPDATE][no-status] tb falhou: ${e3.message}`);
          }
        }
      }

      // Se chegou aqui, realmente não deu — propaga o erro formatado
      await this.log(
        'out',
        'order.update',
        { wcOrderId, body, apiErr },
        httpStatus,
        e.message,
      );
      throw new BadRequestException(
        `WooCommerce recusou a atualização (HTTP ${httpStatus}): ${apiErr?.message ?? e.message}`,
      );
    }
  }

  /**
   * Adiciona uma nota interna ou pra o cliente num pedido.
   * `customer_note: true` → envia por email pro cliente.
   */
  async addOrderNote(wcOrderId: number, note: string, customerNote = false) {
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/orders/${wcOrderId}/notes`,
          { note, customer_note: customerNote },
          { auth: this.auth },
        ),
      );
      await this.log('out', 'order.add_note', { wcOrderId, customerNote }, res.status);
      return res.data;
    } catch (e: any) {
      await this.log('out', 'order.add_note', { wcOrderId }, e?.response?.status, e.message);
      throw e;
    }
  }

  /** Compatível com WooCommerce Shipment Tracking (meta_data). */
  async setTracking(wcOrderId: number, tracking: { code: string; carrier: string }) {
    const payload = {
      meta_data: [
        { key: '_tracking_number', value: tracking.code },
        { key: '_tracking_carrier', value: tracking.carrier },
      ],
    };
    try {
      const res = await firstValueFrom(
        this.http.put(`${this.baseUrl}/orders/${wcOrderId}`, payload, { auth: this.auth }),
      );
      await this.log('out', 'order.set_tracking', { wcOrderId, tracking }, res.status);
      return res.data;
    } catch (e: any) {
      await this.log('out', 'order.set_tracking', { wcOrderId, tracking }, e?.response?.status, e.message);
      throw e;
    }
  }

  /** Reconciliação: baixa pedidos recentes. */
  async fetchRecentOrders(afterIso: string) {
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/orders`, {
        auth: this.auth,
        params: { after: afterIso, per_page: 100 },
      }),
    );
    await this.log('out', 'order.fetch_recent', { afterIso }, res.status);
    return res.data;
  }

  /**
   * Lista pedidos direto do WC (paginação). Espelha o admin do WooCommerce.
   * Retorna itens + total pro paginador.
   */
  async listOrders(params: {
    status?: string;
    page?: number;
    perPage?: number;
    search?: string;
  }): Promise<{ data: any[]; total: number; totalPages: number }> {
    const qs: any = {
      per_page: params.perPage ?? 50,
      page: params.page ?? 1,
      orderby: 'date',
      order: 'desc',
    };
    if (params.status && params.status !== 'any') qs.status = params.status;
    if (params.search) qs.search = params.search;

    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/orders`, { auth: this.auth, params: qs }),
    );
    return {
      data: res.data ?? [],
      total: Number(res.headers['x-wp-total'] ?? 0),
      totalPages: Number(res.headers['x-wp-totalpages'] ?? 0),
    };
  }

  /**
   * Contadores por status — usa endpoint nativo do WC que já traz tudo em 1 call.
   * Inclui status CUSTOM (ex: em-separacao).
   */
  async countByStatus(): Promise<Array<{ slug: string; name: string; total: number }>> {
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/reports/orders/totals`, { auth: this.auth }),
    );
    return res.data ?? [];
  }

  private async log(direction: 'in' | 'out', event: string, payload: any, status?: number, error?: string) {
    await this.prisma.integrationLog.create({
      data: {
        source: 'woocommerce',
        direction,
        event,
        payload: payload ? JSON.stringify(payload) : null,
        status,
        error,
      },
    });
  }
}
