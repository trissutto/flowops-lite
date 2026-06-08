import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Catalog Service — fetcha categorias + produtos do WC e serve formatado
 * pro app cliente (PWA Lurd's).
 *
 * Foi separado do WooCommerceService porque:
 *   - Aqui é PÚBLICO (sem auth, qualquer cliente vê)
 *   - Foco em performance: cache agressivo (5 min) pra não martelar WC
 *   - Response simplificada (só campos que UI precisa)
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  // Cache em memória — invalida ao redeploy ou após TTL
  private categoriesCache: { at: number; data: any[] } | null = null;
  private productsCache = new Map<string, { at: number; data: any }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5min

  constructor(
    private readonly http: HttpService,
    private readonly cfg: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get baseUrl() {
    return `${this.cfg.get('WC_URL')}/wp-json/wc/v3`;
  }
  private get auth() {
    return {
      username: this.cfg.get<string>('WC_CONSUMER_KEY') ?? '',
      password: this.cfg.get<string>('WC_CONSUMER_SECRET') ?? '',
    };
  }

  /* ──────────────────────── CATEGORIAS ──────────────────────── */

  async getCategories(): Promise<
    Array<{ id: number; name: string; slug: string; count: number; image: string | null }>
  > {
    // Cache check
    if (this.categoriesCache && Date.now() - this.categoriesCache.at < this.CACHE_TTL) {
      return this.categoriesCache.data;
    }

    try {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}/products/categories`, {
          params: {
            per_page: 50,
            hide_empty: true,
            orderby: 'count',
            order: 'desc',
            _fields: 'id,name,slug,count,image,parent',
          },
          auth: this.auth,
          timeout: 8000,
        }),
      );

      const data = (Array.isArray(res.data) ? res.data : [])
        // Pula categoria default "Sem categoria" e subcategorias (parent != 0)
        .filter((c: any) => c.parent === 0 && c.slug !== 'sem-categoria' && c.slug !== 'uncategorized')
        .map((c: any) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          count: c.count,
          image: c.image?.src || null,
        }));

      this.categoriesCache = { at: Date.now(), data };
      return data;
    } catch (e: any) {
      this.logger.error(`getCategories WC falhou: ${e?.message || e}`);
      // Se WC tá fora, retorna array vazio (UI mostra fallback)
      return [];
    }
  }

  /* ──────────────────────── PRODUTOS ──────────────────────── */

  async getProducts(opts: {
    category?: string;       // slug
    search?: string;
    page?: number;
    perPage?: number;
    orderby?: 'date' | 'popularity' | 'price' | 'rating';
    onSale?: boolean;
  }): Promise<{
    products: Array<{
      id: number;
      name: string;
      slug: string;
      price: number;
      regularPrice: number;
      onSale: boolean;
      image: string | null;
      permalink: string;
      categories: string[];
    }>;
    total: number;
    page: number;
    perPage: number;
  }> {
    const page = opts.page || 1;
    const perPage = Math.min(opts.perPage || 12, 30);
    const cacheKey = JSON.stringify({ ...opts, page, perPage });

    const cached = this.productsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.CACHE_TTL) {
      return cached.data;
    }

    try {
      const params: any = {
        per_page: perPage,
        page,
        status: 'publish',
        stock_status: 'instock',
        orderby: opts.orderby || 'date',
        order: 'desc',
        _fields: 'id,name,slug,price,regular_price,sale_price,on_sale,images,permalink,categories',
      };
      if (opts.category) params.category = await this.resolveCategoryId(opts.category);
      if (opts.search) params.search = opts.search;
      if (opts.onSale) params.on_sale = true;

      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}/products`, {
          params,
          auth: this.auth,
          timeout: 10000,
        }),
      );

      const total = Number(res.headers?.['x-wp-total']) || 0;
      const products = (Array.isArray(res.data) ? res.data : []).map((p: any) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        price: Number(p.price) || 0,
        regularPrice: Number(p.regular_price) || Number(p.price) || 0,
        onSale: !!p.on_sale,
        image: p.images?.[0]?.src || null,
        permalink: p.permalink || `${this.cfg.get('WC_URL')}/produto/${p.slug}`,
        categories: (p.categories || []).map((c: any) => c.name),
      }));

      const result = { products, total, page, perPage };
      this.productsCache.set(cacheKey, { at: Date.now(), data: result });
      return result;
    } catch (e: any) {
      this.logger.error(`getProducts WC falhou: ${e?.message || e}`);
      return { products: [], total: 0, page, perPage };
    }
  }

  /* ──────────────────────── BUSCAR PEDIDO ──────────────────────── */
  /**
   * Busca pedido do WC pelo ID — pra página /pedido/[id] no app.
   * Inclui status, total, itens, endereço de entrega, código de rastreio,
   * e PIX QR Code/copy-paste se método for PIX e ainda não pago.
   */
  async getOrder(wcOrderId: number): Promise<any | null> {
    try {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}/orders/${wcOrderId}`, {
          auth: this.auth,
          timeout: 10000,
        }),
      );
      const wc = res.data;
      if (!wc?.id) return null;

      // Tenta extrair PIX QR Code do meta_data (plugins comuns: pagarme, pagbank)
      const meta: any[] = Array.isArray(wc.meta_data) ? wc.meta_data : [];
      const pixQrCode =
        meta.find((m) => m.key === '_pagarme_pix_qr_code')?.value ||
        meta.find((m) => m.key === '_pix_qr_code')?.value ||
        null;
      const pixCopyPaste =
        meta.find((m) => m.key === '_pagarme_pix_qr_code_url')?.value ||
        meta.find((m) => m.key === '_pix_copy_paste')?.value ||
        null;
      const pixExpiresAt =
        meta.find((m) => m.key === '_pagarme_pix_expires_at')?.value ||
        meta.find((m) => m.key === '_pix_expires_at')?.value ||
        null;

      // Tracking — primeiro tenta meta_data, depois shipping_lines/customer_note
      const trackingCode =
        meta.find((m) => m.key === '_tracking_code')?.value ||
        meta.find((m) => m.key === '_correios_tracking_code')?.value ||
        null;
      const trackingUrl = trackingCode
        ? `https://www.linkcorreios.com.br/${trackingCode}`
        : null;

      // Cashback usado
      const cashbackUsedCents = Number(
        meta.find((m) => m.key === '_app_cashback_used_cents')?.value || 0,
      );

      return {
        id: wc.id,
        number: wc.number,
        status: wc.status,
        statusLabel: this.statusLabel(wc.status),
        paymentMethod: wc.payment_method,
        paymentMethodTitle: wc.payment_method_title,
        currency: wc.currency,
        total: Number(wc.total) || 0,
        shippingTotal: Number(wc.shipping_total) || 0,
        discountTotal: Number(wc.discount_total) || 0,
        cashbackUsed: cashbackUsedCents / 100,
        dateCreated: wc.date_created,
        datePaid: wc.date_paid,
        items: (wc.line_items || []).map((li: any) => ({
          id: li.id,
          name: li.name,
          quantity: li.quantity,
          price: Number(li.price) || 0,
          subtotal: Number(li.subtotal) || 0,
          total: Number(li.total) || 0,
          image: li.image?.src || null,
          variation: (li.meta_data || [])
            .filter((m: any) => !String(m.key || '').startsWith('_'))
            .map((m: any) => `${m.display_key || m.key}: ${m.display_value || m.value}`)
            .join(' · '),
        })),
        shipping: {
          name: `${wc.shipping?.first_name || ''} ${wc.shipping?.last_name || ''}`.trim(),
          address: wc.shipping?.address_1,
          address2: wc.shipping?.address_2,
          city: wc.shipping?.city,
          state: wc.shipping?.state,
          postcode: wc.shipping?.postcode,
        },
        shippingMethod: wc.shipping_lines?.[0]?.method_title || null,
        pix: pixQrCode
          ? {
              qrCodeBase64: pixQrCode.startsWith('data:') ? pixQrCode : null,
              qrCodeUrl: pixQrCode.startsWith('http') ? pixQrCode : null,
              copyPaste: pixCopyPaste,
              expiresAt: pixExpiresAt,
            }
          : null,
        tracking: trackingCode
          ? { code: trackingCode, url: trackingUrl, carrier: 'Correios' }
          : null,
        paymentUrl:
          wc.status === 'pending'
            ? `${this.cfg.get('WC_URL')}/checkout/order-pay/${wc.id}/?pay_for_order=true&key=${wc.order_key}`
            : null,
      };
    } catch (e: any) {
      this.logger.error(`getOrder #${wcOrderId} falhou: ${e?.message || e}`);
      return null;
    }
  }

  private statusLabel(s: string): string {
    const map: Record<string, string> = {
      pending: 'Aguardando pagamento',
      processing: 'Pagamento confirmado — separando',
      'on-hold': 'Aguardando pagamento',
      completed: 'Concluído',
      cancelled: 'Cancelado',
      refunded: 'Reembolsado',
      failed: 'Pagamento falhou',
      shipped: 'Enviado',
      delivered: 'Entregue',
    };
    return map[s] || s;
  }

  /* ──────────────────────── CRIAR PEDIDO NO WC ──────────────────────── */
  /**
   * Cria pedido no WooCommerce a partir do carrinho do app.
   * Retorna order_id WC + URL de pagamento (PIX/cartão via WC checkout).
   *
   * line_items = produtos do carrinho com variation_id
   * Customer note inclui cashback aplicado pra ser registrado no histórico
   */
  async createOrder(payload: {
    customer: {
      first_name: string;
      last_name?: string;
      email: string;
      phone: string;
      cpf: string;
    };
    shipping: {
      address_1: string;
      number?: string;
      address_2?: string;
      city: string;
      state: string;
      postcode: string;
      country?: string;
    };
    lineItems: Array<{
      product_id: number;
      variation_id?: number;
      quantity: number;
    }>;
    couponCode?: string;
    paymentMethod: 'pix' | 'credit_card' | 'boleto';
    cashbackUsedCents?: number;
    shippingMethod?: string;
    shippingCost?: number;
    pickupStoreCode?: string;  // Quando frete = retirar em loja
  }) {
    try {
      const isPickup = !!payload.pickupStoreCode;
      const body: any = {
        payment_method: payload.paymentMethod === 'pix' ? 'pagarme-pix' : 'pagarme-credit-card',
        payment_method_title: payload.paymentMethod === 'pix' ? 'PIX' : 'Cartão de Crédito',
        set_paid: false,
        status: 'pending',
        billing: {
          first_name: payload.customer.first_name,
          last_name: payload.customer.last_name || '',
          address_1: payload.shipping.address_1,
          address_2: [payload.shipping.number, payload.shipping.address_2].filter(Boolean).join(' '),
          city: payload.shipping.city,
          state: payload.shipping.state,
          postcode: payload.shipping.postcode,
          country: payload.shipping.country || 'BR',
          email: payload.customer.email,
          phone: payload.customer.phone,
          cpf: payload.customer.cpf,
        },
        shipping: {
          first_name: payload.customer.first_name,
          last_name: payload.customer.last_name || '',
          address_1: payload.shipping.address_1,
          address_2: [payload.shipping.number, payload.shipping.address_2].filter(Boolean).join(' '),
          city: payload.shipping.city,
          state: payload.shipping.state,
          postcode: payload.shipping.postcode,
          country: payload.shipping.country || 'BR',
        },
        line_items: payload.lineItems,
        coupon_lines: payload.couponCode ? [{ code: payload.couponCode }] : undefined,
        shipping_lines: [{
          method_id: isPickup ? 'local_pickup' : 'flat_rate',
          method_title: payload.shippingMethod || (isPickup ? 'Retirar em loja' : 'Frete'),
          total: String((payload.shippingCost || 0).toFixed(2)),
        }],
        meta_data: [
          { key: '_app_origin', value: 'app.lurds.com.br' },
          ...(payload.cashbackUsedCents
            ? [{ key: '_app_cashback_used_cents', value: payload.cashbackUsedCents }]
            : []),
          ...(payload.pickupStoreCode
            ? [{ key: '_pickup_store_code', value: payload.pickupStoreCode }]
            : []),
        ],
        customer_note: payload.cashbackUsedCents
          ? `Cashback aplicado: R$ ${(payload.cashbackUsedCents / 100).toFixed(2)}`
          : '',
      };

      const res = await firstValueFrom(
        this.http.post(`${this.baseUrl}/orders`, body, {
          auth: this.auth,
          timeout: 15000,
        }),
      );

      const order = res.data;
      return {
        id: order.id,
        number: order.number,
        status: order.status,
        total: Number(order.total) || 0,
        paymentUrl: order.payment_url || `${this.cfg.get('WC_URL')}/checkout/order-pay/${order.id}/?pay_for_order=true&key=${order.order_key}`,
      };
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || 'Erro ao criar pedido';
      this.logger.error(`createOrder WC falhou: ${msg}`);
      throw new Error(msg);
    }
  }

  /* ──────────────────────── FRETE ──────────────────────── */
  /**
   * Retorna opções de entrega:
   *   1. PAC (Correios)        — R$ 19,90 / 7 dias
   *   2. SEDEX (Correios)      — R$ 32,00 / 3 dias
   *   3. Retirar na loja X     — SÓ se existe loja Lurd's na CIDADE do CEP (ViaCEP)
   *
   * Critério da pickup: ViaCEP → pega cidade do CEP → procura Store com
   * mesma cidade (normalizando acentos/case). Se não achar match exato, sem pickup.
   * Evita listar 15 lojas e poluir o checkout.
   */
  async calculateShipping(opts: { cep: string; weight?: number }): Promise<Array<{
    code: string; name: string; price: number; days: number;
    type: 'shipping' | 'pickup'; storeCode?: string; storeAddress?: string;
  }>> {
    // 1) Correios
    const options: Array<any> = [
      { code: 'PAC', name: 'PAC (Correios)', price: 19.90, days: 7, type: 'shipping' as const },
      { code: 'SEDEX', name: 'SEDEX (Correios)', price: 32.00, days: 3, type: 'shipping' as const },
    ];

    // 2) Lookup ViaCEP → cidade do cliente
    const cepDigits = (opts.cep || '').replace(/\D/g, '');
    if (cepDigits.length !== 8) return options;

    let customerCity: string | null = null;
    let customerState: string | null = null;
    try {
      const r = await firstValueFrom(
        this.http.get(`https://viacep.com.br/ws/${cepDigits}/json/`, { timeout: 4000 }),
      );
      if (r.data && !r.data.erro) {
        customerCity = String(r.data.localidade || '').trim();
        customerState = String(r.data.uf || '').trim();
      }
    } catch (e: any) {
      this.logger.warn(`ViaCEP falhou pra ${cepDigits}: ${e?.message}`);
    }

    if (!customerCity) return options;

    // 3) Procura A loja na MESMA cidade — SÓ UMA (a de maior priorityScore)
    try {
      const stores = await this.prisma.store.findMany({
        where: { active: true },
        select: {
          code: true, name: true, city: true, state: true, cep: true,
          whatsapp: true,
        },
        orderBy: [{ priorityScore: 'desc' }, { name: 'asc' }],
      });

      const norm = (s: string | null | undefined) =>
        (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

      const customerCityNorm = norm(customerCity);
      // Pega A loja (não todas) da cidade — a de maior priorityScore
      const nearestStore = stores.find((s) => norm(s.city) === customerCityNorm);

      if (nearestStore) {
        // Monta info da loja com o que temos:
        // nome (geralmente já contém o endereço descritivo) · cidade-UF · CEP
        const addrParts = [
          nearestStore.name,
          nearestStore.city && nearestStore.state
            ? `${nearestStore.city}-${nearestStore.state}`
            : nearestStore.city || nearestStore.state,
          nearestStore.cep ? `CEP ${nearestStore.cep}` : null,
        ].filter(Boolean);
        options.push({
          code: `PICKUP_${nearestStore.code}`,
          name: `Retirar na loja Lurd's ${nearestStore.city}`,
          price: 0,
          days: 2,
          type: 'pickup' as const,
          storeCode: nearestStore.code,
          storeAddress: addrParts.join(' · '),
        });
        this.logger.log(
          `Shipping ${cepDigits}: pickup ${nearestStore.code} (${nearestStore.city})`,
        );
      } else {
        this.logger.log(
          `Shipping ${cepDigits}: ${customerCity}/${customerState} sem loja Lurd's`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`Falha listando lojas pra pickup: ${e?.message}`);
    }

    return options;
  }

  /** Resolve slug → id da categoria pra usar em GET /products?category=ID */
  private async resolveCategoryId(slug: string): Promise<number | undefined> {
    const cats = await this.getCategories();
    return cats.find((c) => c.slug === slug)?.id;
  }

  /* ──────────────────────── PRODUTO DETALHADO ──────────────────────── */

  /**
   * Busca produto completo pelo slug com:
   *   - Galeria (todas imagens)
   *   - Descrição HTML
   *   - Atributos (Cor, Tamanho, etc)
   *   - Variações (se for variable product) com preço/estoque por variação
   */
  async getProductBySlug(slug: string): Promise<any | null> {
    if (!slug) return null;
    const cacheKey = `product:${slug}`;
    const cached = this.productsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.CACHE_TTL) return cached.data;

    try {
      // Busca o produto principal
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}/products`, {
          params: { slug, per_page: 1 },
          auth: this.auth,
          timeout: 10000,
        }),
      );
      const products = Array.isArray(res.data) ? res.data : [];
      if (products.length === 0) return null;
      const p = products[0];

      // Se for variable, busca todas as variações
      let variations: any[] = [];
      if (p.type === 'variable' && Array.isArray(p.variations) && p.variations.length > 0) {
        try {
          const vres = await firstValueFrom(
            this.http.get(`${this.baseUrl}/products/${p.id}/variations`, {
              params: { per_page: 50 },
              auth: this.auth,
              timeout: 10000,
            }),
          );
          variations = Array.isArray(vres.data) ? vres.data : [];
        } catch {
          variations = [];
        }
      }

      const out = {
        id: p.id,
        slug: p.slug,
        name: p.name,
        description: p.description || '',
        shortDescription: p.short_description || '',
        type: p.type, // 'simple' | 'variable'
        price: Number(p.price) || 0,
        regularPrice: Number(p.regular_price) || Number(p.price) || 0,
        salePrice: Number(p.sale_price) || 0,
        onSale: !!p.on_sale,
        stockStatus: p.stock_status,
        stockQuantity: p.stock_quantity,
        permalink: p.permalink,
        images: (p.images || []).map((img: any) => ({
          id: img.id,
          src: img.src,
          alt: img.alt || p.name,
        })),
        categories: (p.categories || []).map((c: any) => ({
          id: c.id, name: c.name, slug: c.slug,
        })),
        attributes: (p.attributes || []).map((a: any) => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          options: a.options || [],
          variation: !!a.variation,
        })),
        variations: variations.map((v: any) => ({
          id: v.id,
          sku: v.sku,
          price: Number(v.price) || 0,
          regularPrice: Number(v.regular_price) || 0,
          salePrice: Number(v.sale_price) || 0,
          onSale: !!v.on_sale,
          stockStatus: v.stock_status,
          stockQuantity: v.stock_quantity,
          image: v.image?.src || null,
          attributes: (v.attributes || []).map((a: any) => ({
            name: a.name,
            option: a.option,
          })),
        })),
        // Relacionados (IDs)
        relatedIds: p.related_ids || [],
      };

      this.productsCache.set(cacheKey, { at: Date.now(), data: out });
      return out;
    } catch (e: any) {
      this.logger.error(`getProductBySlug falhou: ${e?.message || e}`);
      return null;
    }
  }
}
