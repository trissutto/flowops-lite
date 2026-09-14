import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { exigirWordpressLegado, WP_LEGADO_APAGADO_EM } from './wp-morto';
import { wordpressLegadoLigado } from '../common/replica-giga';

/**
 * Cliente REST do WooCommerce — **do site que não existe mais**.
 * - Autenticação: Basic Auth (consumer_key / consumer_secret).
 * - Loga toda saída em integration_logs.
 *
 * ── A TRANCA (14/09/2026) ──
 *
 * Todo método público sai na PRIMEIRA LINHA por `exigirWordpressLegado`
 * enquanto `KINGHOST_WP` não estiver ligada (410 Gone com o motivo e a data).
 * Até aqui não havia guard nenhum: as chamadas saíam de verdade pela internet
 * e voltavam **HTTP 403 da Vercel** (o domínio hoje é o site novo, medido em
 * 14/09/2026), gastando até 15s de timeout cada.
 *
 * Por que o guard vai em CADA método e não só no `baseUrl`: vários deles
 * embrulham a chamada em `try/catch` que traduz o erro do axios — o
 * `updateOrder`, por exemplo, terminaria em
 * "WooCommerce recusou a atualização (HTTP undefined)", que é mentira sobre a
 * causa. Fechando a porta antes do `try`, o motivo chega inteiro em quem
 * chamou.
 *
 * ── QUEM AINDA CHAMA (e por quê não some) ──
 *
 * O PEDIDO LEGADO DO SITE VELHO (`Order.source='site'`, `wcOrderId` real,
 * abaixo da faixa 900M da live e 950M da loja) é o único assunto que sobrou
 * aqui: `orders.controller` cai nestes métodos só depois de esgotar o ramo
 * local, e `trocas`/`wc-returns` usam `getOrder` com `catch` que volta pro
 * Postgres. Pedido da live, da loja e do e-commerce novo nunca passam por
 * aqui. A `pdv.controller` saiu de vez (a miniatura do carrinho virou
 * `product_photos`), e nenhum caminho novo deve entrar.
 *
 * Antes deste PR o comportamento desses chamadores era: esperar a rede, ouvir
 * 403, e então (a) cair no fallback local, ou (b) devolver erro com texto
 * errado. Agora é o mesmo desvio, na hora, com o texto certo.
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

  // O `getProductImageBySku` (foto por SKU, com cache de 1h) saiu daqui em
  // 14/09/2026. Era a miniatura do carrinho do PDV, o último consumidor deste
  // serviço fora do pedido legado, e o mais silencioso: pegava a exceção,
  // cacheava `null` e devolvia "sem foto" — com o WordPress apagado, TODA peça
  // do carrinho virou a bolinha com a inicial da REF sem uma linha de erro em
  // lugar nenhum. A foto agora sai de `product_photos` (Postgres + R2), a
  // mesma fonte da Consulta, da Separação e do site:
  // `pdv/foto-produto.service.ts`.

  // TRÊS MÉTODOS ÓRFÃOS SAÍRAM EM 14/09/2026 — varredura por chamador em
  // `backend/src`, `frontend/src` e `ecommerce/src` não achou NENHUM:
  //   • `updateOrderStatus` — virou o `updateOrder` (status + meta + nota numa
  //     chamada só) e nunca foi retirado;
  //   • `setTracking` — o rastreio ia junto no `updateOrder` desde o suporte
  //     aos metas dos plugins de Correios/Melhor Envio;
  //   • `fetchRecentOrders` — era a reconciliação do `WcPollerService`, que
  //     saiu na Onda 2 (04/09/2026) com o resto da entrada de pedidos do WC.
  // Guardar código morto apontando pra host morto é o dobro de museu: quem lê
  // o arquivo acha que existe um caminho vivo de escrita no site velho.

  /**
   * Retorna um pedido específico do WC (detalhe completo).
   *
   * Quem chama com `catch` (trocas, wc-returns) volta pro Postgres e a cliente
   * nem percebe — o ganho aqui é não gastar 15s de timeout por tentativa no
   * portal de trocas, que faz até três.
   */
  async getOrder(wcOrderId: number) {
    exigirWordpressLegado(
      'Abrir o detalhe deste pedido no site antigo',
      'o pedido mora no Postgres do Flow — a ficha da /separacao monta a partir dele',
    );
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/orders/${wcOrderId}`, { auth: this.auth }),
    );
    return res.data;
  }

  /**
   * Atualização genérica de pedido — permite mandar status + meta_data + nota ao cliente
   * na mesma chamada.
   *
   * ⚠️ O guard vem ANTES da estratégia resiliente lá embaixo de propósito: ela
   * traduz erro do axios e, sem resposta HTTP pra ler, terminaria em
   * "WooCommerce recusou a atualização (HTTP undefined)" — texto que manda a
   * próxima pessoa investigar status de pedido em vez de ler a data do
   * enterro.
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
    exigirWordpressLegado(
      'Gravar status/rastreio deste pedido no site antigo',
      'status, código de rastreio e aviso à cliente saem do Flow (a /separacao grava no Postgres e o aviso vai pelo WhatsApp/e-mail do próprio sistema)',
    );
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
    exigirWordpressLegado(
      'Gravar esta nota no pedido do site antigo',
      'a nota vira histórico do pedido no Postgres (`order_history`), que é o que a ficha da /separacao mostra',
    );
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

  /**
   * Lista pedidos direto do WC (paginação). Espelha o admin do WooCommerce.
   * Retorna itens + total pro paginador.
   *
   * A tela de /separacao já não usa mais isto por default desde 22/08/2026
   * (`SEPARACAO_WOOCOMMERCE=0` — o arquivo do site velho enchia as abas com
   * 22.538 "concluídos" que ninguém ia trabalhar). Sobraram a busca por número
   * de pedido no portal de trocas e o sync de clientes, os dois com `catch`.
   */
  async listOrders(params: {
    status?: string;
    page?: number;
    perPage?: number;
    search?: string;
    /** ISO 8601 — pedidos com data DEPOIS desse timestamp (date_created por padrão no WC) */
    after?: string;
    /** ISO 8601 — pedidos com data ANTES desse timestamp */
    before?: string;
    /** Qual data filtrar — 'modified' (default WC) ou 'created'. Usado pra "concluidos hoje" via date_modified */
    modifiedAfter?: string;
  }): Promise<{ data: any[]; total: number; totalPages: number }> {
    exigirWordpressLegado(
      'Listar pedidos no site antigo',
      'a lista de pedidos é a do Postgres do Flow — inclusive os do site velho, que foram espelhados pra cá e continuam achando pela busca da /separacao',
    );
    const qs: any = {
      per_page: params.perPage ?? 50,
      page: params.page ?? 1,
      orderby: 'date',
      order: 'desc',
    };
    if (params.status && params.status !== 'any') qs.status = params.status;
    if (params.search) qs.search = params.search;
    if (params.after) qs.after = params.after;
    if (params.before) qs.before = params.before;
    if (params.modifiedAfter) qs.modified_after = params.modifiedAfter;

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
    exigirWordpressLegado(
      'Contar os pedidos por status no site antigo',
      'os contadores das abas da /separacao vêm do Postgres (`orders.countByStatus`) e contam só a operação viva',
    );
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/reports/orders/totals`, { auth: this.auth }),
    );
    return res.data ?? [];
  }

  /**
   * Cria cupom de desconto no WooCommerce.
   * Usado quando rola troca/credito de venda do site — o cliente pode usar
   * o mesmo codigo TROCA-XXXXX no site dentro da validade.
   *
   * Caracteristicas do cupom:
   *  - discount_type fixed_cart (desconto fixo no carrinho)
   *  - usage_limit 1 (uso unico)
   *  - individual_use true (nao acumula com outros cupons)
   *  - exclude_sale_items false (vale em qualquer produto, incluindo promocao)
   *  - free_shipping false (nao libera frete)
   *  - date_expires data validade ISO
   *
   * Retorna { ok, couponId, code, error }. Erro NAO bloqueia — caller decide.
   *
   * ── O ÚNICO MÉTODO DAQUI QUE **NÃO** LANÇA (14/09/2026) ──
   *
   * Aqui o contrato de falha já existia e já era honesto: `{ ok: false, error }`,
   * com os dois chamadores (`trocas`, `wc-returns`) lendo o `error` e gravando
   * warning. Trocar isso por exceção não melhoraria nada — os dois embrulham a
   * chamada em `try/catch` e a exceção cairia no MESMO lugar, só que sem o
   * texto do motivo chegar ao log. Então a porta fecha devolvendo o motivo
   * dentro do contrato, sem gastar os 10s de timeout.
   *
   * E o vale da cliente NÃO depende disto: o crédito vive em `site_cupons`
   * (site novo) e em `pdv_returns` (caixa), e todo lookup de vale-troca olha as
   * DUAS fontes. O cupom no WooCommerce era a terceira, do site velho.
   */
  async createDiscountCoupon(input: {
    code: string;
    amount: number;
    expiresAt: Date;
    description?: string;
    customerEmail?: string;
  }): Promise<{
    ok: boolean;
    couponId?: number;
    code?: string;
    error?: string;
  }> {
    const code = String(input.code || '').trim().toUpperCase();
    const amount = Number(input.amount) || 0;
    if (!code || amount <= 0) {
      return { ok: false, error: `code/amount invalidos (code='${code}' amount=${amount})` };
    }
    if (!wordpressLegadoLigado()) {
      return {
        ok: false,
        error:
          `cupom no WooCommerce não existe mais: o WordPress do site antigo foi apagado em ${WP_LEGADO_APAGADO_EM} ` +
          `(o endereço responde HTTP 403 pela Vercel). O vale da cliente vale por 'site_cupons' no site novo e ` +
          `por 'pdv_returns' no caixa — nada a criar manualmente em lugar nenhum.`,
      };
    }
    try {
      const body: any = {
        code,
        discount_type: 'fixed_cart',
        amount: amount.toFixed(2),
        usage_limit: 1,
        individual_use: true,
        exclude_sale_items: false,
        free_shipping: false,
        date_expires: input.expiresAt.toISOString(),
        description: input.description || `Vale-troca ${code} — gerado automaticamente`,
      };
      if (input.customerEmail) {
        body.email_restrictions = [input.customerEmail];
      }
      const res = await firstValueFrom(
        this.http.post(`${this.baseUrl}/coupons`, body, {
          auth: this.auth,
          timeout: 10000,
        }),
      );
      await this.log('out', 'coupon.create', { code, amount, expiresAt: input.expiresAt }, res.status);
      return { ok: true, couponId: res.data?.id, code: res.data?.code };
    } catch (e: any) {
      const status = e?.response?.status;
      const data = e?.response?.data;
      const msg = data?.message || e?.message || String(e);
      await this.log('out', 'coupon.create', { code, amount }, status, msg);
      this.logger.warn(`[wc.coupon] Falha ao criar cupom ${code}: ${msg}`);
      return { ok: false, error: msg };
    }
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
