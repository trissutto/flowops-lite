import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

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

  /** Resolve slug → id da categoria pra usar em GET /products?category=ID */
  private async resolveCategoryId(slug: string): Promise<number | undefined> {
    const cats = await this.getCategories();
    return cats.find((c) => c.slug === slug)?.id;
  }
}
