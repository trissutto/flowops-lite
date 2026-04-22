import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/**
 * WcCatalogService — interação com o WooCommerce pra Fase 2 e Fase 3:
 *
 *  Fase 2 (leitura):
 *    - listar categorias (árvore)
 *    - listar tags (usadas + sugeridas)
 *    - listar atributos globais (pa_tamanho, pa_cor, etc)
 *
 *  Fase 3 (escrita):
 *    - upload de mídia via /wp-json/wp/v2/media (opcional, usa App Password)
 *    - criar produto variable + variações via /wp-json/wc/v3/products
 *    - checar duplicidade por SKU antes de criar
 *
 * Auth:
 *   WC REST usa basic auth (consumer key/secret) — já configurado no env.
 *   Upload de mídia usa WP REST que exige Application Password (usuário
 *   administrador WP com App Password gerado). Se WP_APP_USER / WP_APP_PASSWORD
 *   não estiver setado, upload fica desabilitado e o CEO precisa colar URL
 *   de imagem externa (por ex: já hospedada no WP antigo).
 */
@Injectable()
export class WcCatalogService {
  private readonly logger = new Logger(WcCatalogService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  private get wcBase(): string {
    const url = this.config.get<string>('WC_URL');
    if (!url) throw new BadRequestException('WC_URL não configurada no .env.');
    return `${url.replace(/\/+$/, '')}/wp-json/wc/v3`;
  }

  private get wpBase(): string {
    const url = this.config.get<string>('WC_URL');
    if (!url) throw new BadRequestException('WC_URL não configurada no .env.');
    return `${url.replace(/\/+$/, '')}/wp-json/wp/v2`;
  }

  private get wcAuth() {
    return {
      username: this.config.get<string>('WC_CONSUMER_KEY') || '',
      password: this.config.get<string>('WC_CONSUMER_SECRET') || '',
    };
  }

  private get wpAuth(): { username: string; password: string } | null {
    const u = this.config.get<string>('WP_APP_USER');
    const p = this.config.get<string>('WP_APP_PASSWORD');
    if (!u || !p) return null;
    return { username: u, password: p };
  }

  isMediaUploadEnabled(): boolean {
    return !!this.wpAuth;
  }

  /** Lista todas as categorias (paginadas) — retorna árvore achatada com parentId. */
  async listCategories(): Promise<Array<{
    id: number;
    name: string;
    slug: string;
    parent: number;
    count: number;
  }>> {
    const all: any[] = [];
    let page = 1;
    while (page < 20) { // segurança — WC raramente passa de 2-3k cats
      try {
        const res = await firstValueFrom(
          this.http.get(`${this.wcBase}/products/categories`, {
            auth: this.wcAuth,
            params: { per_page: 100, page, hide_empty: false, orderby: 'name', order: 'asc' },
            timeout: 30000,
          }),
        );
        const chunk = res.data as any[];
        if (!Array.isArray(chunk) || chunk.length === 0) break;
        all.push(...chunk);
        if (chunk.length < 100) break;
        page++;
      } catch (e: any) {
        this.logger.error(`WC listCategories falhou: ${e?.response?.status} ${e?.message}`);
        break;
      }
    }
    return all.map((c: any) => ({
      id: Number(c.id),
      name: String(c.name || ''),
      slug: String(c.slug || ''),
      parent: Number(c.parent || 0),
      count: Number(c.count || 0),
    }));
  }

  /** Lista tags existentes no WC (pra autocomplete). */
  async listTags(search?: string): Promise<Array<{ id: number; name: string; slug: string; count: number }>> {
    const all: any[] = [];
    let page = 1;
    while (page < 10) {
      try {
        const params: any = { per_page: 100, page, orderby: 'count', order: 'desc' };
        if (search) params.search = search;
        const res = await firstValueFrom(
          this.http.get(`${this.wcBase}/products/tags`, {
            auth: this.wcAuth,
            params,
            timeout: 30000,
          }),
        );
        const chunk = res.data as any[];
        if (!Array.isArray(chunk) || chunk.length === 0) break;
        all.push(...chunk);
        if (chunk.length < 100) break;
        page++;
      } catch (e: any) {
        this.logger.error(`WC listTags falhou: ${e?.response?.status} ${e?.message}`);
        break;
      }
    }
    return all.map((t: any) => ({
      id: Number(t.id),
      name: String(t.name || ''),
      slug: String(t.slug || ''),
      count: Number(t.count || 0),
    }));
  }

  /** Procura produto pelo SKU. Retorna id se existir, null se não. */
  async findProductIdBySku(sku: string): Promise<number | null> {
    try {
      const res = await firstValueFrom(
        this.http.get(`${this.wcBase}/products`, {
          auth: this.wcAuth,
          params: { sku, per_page: 1 },
          timeout: 20000,
        }),
      );
      const arr = res.data as any[];
      if (Array.isArray(arr) && arr.length && arr[0]?.id) return Number(arr[0].id);
      return null;
    } catch (e: any) {
      this.logger.warn(`findProductIdBySku(${sku}) falhou: ${e?.message}`);
      return null;
    }
  }

  /**
   * Upload de imagem a partir de uma URL pública (ex: link temp de S3, Drive,
   * WhatsApp). Baixa o binário no backend e faz POST no /wp/v2/media.
   *
   * Por que não mandar URL direto pro WC?
   *   O endpoint /products aceita images:[{src}], mas o Woo baixa a URL ele
   *   mesmo. Problema: URLs efêmeras (Drive compartilhado, S3 signed) podem
   *   expirar ou ser bloqueadas pelo servidor WP (outbound firewall).
   *   Fazer upload pro /media garante que a imagem vira mídia permanente.
   *
   * Retorna { id, source_url } da mídia criada.
   */
  async uploadMediaFromUrl(
    sourceUrl: string,
    filename: string,
    alt?: string,
  ): Promise<{ id: number; source_url: string }> {
    if (!this.wpAuth) {
      throw new BadRequestException(
        'Upload de mídia desabilitado. Configure WP_APP_USER e WP_APP_PASSWORD (Application Password do WP) no .env, ou use URLs de imagens que já estejam no mesmo domínio do WP.',
      );
    }

    // 1) baixa o binário
    let buf: Buffer;
    let contentType = 'image/jpeg';
    try {
      const r = await firstValueFrom(
        this.http.get(sourceUrl, { responseType: 'arraybuffer', timeout: 60000 }),
      );
      buf = Buffer.from(r.data as ArrayBuffer);
      const ct = r.headers?.['content-type'];
      if (typeof ct === 'string') contentType = ct.split(';')[0].trim();
    } catch (e: any) {
      throw new BadRequestException(`Falha ao baixar imagem: ${e?.message}`);
    }

    // 2) faz upload pro /wp/v2/media
    const safeName = filename.replace(/[^\w.-]/g, '_').slice(0, 100);
    try {
      const res = await firstValueFrom(
        this.http.post(`${this.wpBase}/media`, buf, {
          auth: this.wpAuth,
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${safeName}"`,
          },
          timeout: 120000,
          maxBodyLength: Infinity,
        }),
      );
      const id = Number(res.data?.id);
      const source_url = String(res.data?.source_url || '');
      if (!id) throw new Error('resposta sem id');

      // Seta alt se fornecido (PATCH no media)
      if (alt && alt.trim()) {
        try {
          await firstValueFrom(
            this.http.post(
              `${this.wpBase}/media/${id}`,
              { alt_text: alt.trim() },
              { auth: this.wpAuth!, timeout: 20000 },
            ),
          );
        } catch {
          // silencioso — alt é nice-to-have
        }
      }
      return { id, source_url };
    } catch (e: any) {
      const status = e?.response?.status;
      const data = e?.response?.data;
      this.logger.error(`WP media upload falhou ${status}: ${JSON.stringify(data).slice(0, 300)}`);
      throw new BadRequestException(`Upload falhou (${status || 'network'}). ${e?.message}`);
    }
  }

  /**
   * Cria produto variable no WC como DRAFT.
   *
   * Estratégia:
   *   1) Cria o produto pai (type=variable) com nome, descrição, categorias,
   *      tags, imagens, atributos e "used_for_variations" nos atributos.
   *   2) Cria cada variação (POST /products/{id}/variations) com SKU,
   *      código da variação como EAN (meta_data _alg_ean), estoque e preço.
   *
   * SKU do pai = refCode + cor (ex: "VMS-223-PRETO")
   * SKU da variação = código EAN da etiqueta Giga (ex: "11499497")
   *   → mesmo valor do global_unique_id. Retail bipa o código de barras
   *     e já acha o produto direto pelo SKU.
   *
   * Se a Giga não enviar codigo, cai pro fallback refCode-cor-tamanho
   * (nunca deve acontecer em produção, mas previne crash).
   */
  async createDraftVariableProduct(input: {
    sku: string; // normalmente refCode + cor (ex: VMS-223-PRETO)
    titulo: string;
    descricao: string;
    descricaoCurta: string;
    categoryIds: number[];
    tags: string[]; // nomes (WC cria se não existir)
    imagens: Array<{ id?: number; url?: string; alt?: string }>;
    atributos: Array<{ nome: string; valor: string }>;
    tamanhos: Array<{
      tamanho: string;
      codigo: string; // vira EAN
      estoque: number;
      preco: number; // preço de venda
      precoPromo?: number;
    }>;
    pesoKg?: number;
    dimensoesCm?: { comprimento?: number; largura?: number; altura?: number };
    cor: string;
  }): Promise<{
    productId: number;
    variationIds: Array<{ tamanho: string; codigo: string; variationId: number; sku: string }>;
  }> {
    // Monta os atributos. O atributo "Tamanho" é OBRIGATÓRIO variation=true
    // porque vamos criar variações por tamanho.
    const attributes: any[] = [
      {
        name: 'Tamanho',
        position: 0,
        visible: true,
        variation: true,
        options: input.tamanhos.map((t) => t.tamanho).filter(Boolean),
      },
      {
        name: 'Cor',
        position: 1,
        visible: true,
        variation: false, // não variamos por cor (cada cor é 1 produto)
        options: [input.cor],
      },
    ];
    for (const a of input.atributos) {
      attributes.push({
        name: a.nome,
        position: attributes.length,
        visible: true,
        variation: false,
        options: [a.valor],
      });
    }

    // Monta images: prioriza id (já uploadado), fallback src
    const images = input.imagens
      .map((img) => {
        if (img.id) return { id: img.id, alt: img.alt || '' };
        if (img.url) return { src: img.url, alt: img.alt || '' };
        return null;
      })
      .filter(Boolean);

    const payload: any = {
      name: input.titulo,
      type: 'variable',
      status: 'draft', // RASCUNHO — CEO revisa no WC admin antes de publicar
      description: input.descricao,
      short_description: input.descricaoCurta,
      sku: input.sku,
      categories: input.categoryIds.map((id) => ({ id })),
      tags: input.tags.map((name) => ({ name })),
      images,
      attributes,
      manage_stock: false, // estoque gerenciado nas variações
    };
    if (input.pesoKg) payload.weight = String(input.pesoKg);
    if (input.dimensoesCm) {
      payload.dimensions = {
        length: input.dimensoesCm.comprimento ? String(input.dimensoesCm.comprimento) : '',
        width: input.dimensoesCm.largura ? String(input.dimensoesCm.largura) : '',
        height: input.dimensoesCm.altura ? String(input.dimensoesCm.altura) : '',
      };
    }

    // 1) Cria o pai
    let productId: number;
    try {
      const res = await firstValueFrom(
        this.http.post(`${this.wcBase}/products`, payload, {
          auth: this.wcAuth,
          timeout: 120000,
        }),
      );
      productId = Number(res.data?.id);
      if (!productId) throw new Error('WC retornou sem id');
    } catch (e: any) {
      const status = e?.response?.status;
      const data = e?.response?.data;
      this.logger.error(
        `WC createProduct falhou ${status}: ${JSON.stringify(data).slice(0, 500)}`,
      );
      throw new BadRequestException(`Falha ao criar produto no WC (${status}). ${data?.message || e?.message}`);
    }

    // 2) Cria cada variação
    const variationIds: Array<{ tamanho: string; codigo: string; variationId: number; sku: string }> = [];
    for (const tam of input.tamanhos) {
      // SKU da variação = código EAN da Giga (bipa o código de barras → acha o produto).
      // Fallback pro padrão antigo se por algum motivo o codigo vier vazio.
      const varSku = tam.codigo ? String(tam.codigo).trim() : `${input.sku}-${tam.tamanho}`;
      const varPayload: any = {
        sku: varSku,
        // Campo nativo WC 8.3+ — aparece na UI como "GTIN, UPC, EAN ou ISBN"
        // (é o campo da etiqueta de código de barras). Mesmo valor do SKU.
        global_unique_id: tam.codigo,
        regular_price: String(tam.preco),
        manage_stock: true,
        stock_quantity: tam.estoque,
        stock_status: tam.estoque > 0 ? 'instock' : 'outofstock',
        attributes: [{ name: 'Tamanho', option: tam.tamanho }],
        meta_data: [
          // Plugin WooCommerce EAN (compat com instalações antigas)
          { key: '_alg_ean', value: tam.codigo },
          // Plugin Barcode for WC
          { key: '_barcode', value: tam.codigo },
          // Lurds — rastro pra auditoria
          { key: '_lurds_giga_codigo', value: tam.codigo },
        ],
      };
      if (tam.precoPromo && tam.precoPromo > 0) {
        varPayload.sale_price = String(tam.precoPromo);
      }
      try {
        const res = await firstValueFrom(
          this.http.post(`${this.wcBase}/products/${productId}/variations`, varPayload, {
            auth: this.wcAuth,
            timeout: 60000,
          }),
        );
        const vid = Number(res.data?.id);
        if (vid) {
          variationIds.push({
            tamanho: tam.tamanho,
            codigo: tam.codigo,
            variationId: vid,
            sku: varSku,
          });
        }
      } catch (e: any) {
        this.logger.error(
          `WC variation ${varSku} falhou: ${e?.response?.status} ${JSON.stringify(e?.response?.data).slice(0, 300)}`,
        );
        // continua pras próximas variações — não aborta tudo por 1 erro
      }
    }

    return { productId, variationIds };
  }

  /**
   * Atualiza o EAN/código de barras + SKU de variações já existentes no WC.
   * Útil pra corrigir produtos publicados antes de a gente setar o
   * global_unique_id/sku=codigo no payload de criação.
   *
   * Atualiza 4 campos pra cobrir todos os casos:
   *  - sku (SKU nativo do WC = código EAN da etiqueta Giga)
   *  - global_unique_id (WC nativo 8.3+, aparece como GTIN/UPC/EAN/ISBN)
   *  - meta_data _alg_ean (plugin WooCommerce EAN)
   *  - meta_data _barcode (plugin Barcode for WC)
   *
   * Atenção: se já existe variação com mesmo SKU (de outro produto) o WC
   * retorna 400 e a variação entra em `failed`. Normal — retail não repete EAN.
   */
  async syncVariationCodes(
    productId: number,
    variations: Array<{ variationId: number; codigo: string }>,
  ): Promise<{ updated: number; failed: Array<{ variationId: number; reason: string }> }> {
    let updated = 0;
    const failed: Array<{ variationId: number; reason: string }> = [];
    for (const v of variations) {
      if (!v.variationId || !v.codigo) continue;
      const payload = {
        sku: v.codigo,
        global_unique_id: v.codigo,
        meta_data: [
          { key: '_alg_ean', value: v.codigo },
          { key: '_barcode', value: v.codigo },
          { key: '_lurds_giga_codigo', value: v.codigo },
        ],
      };
      try {
        await firstValueFrom(
          this.http.put(
            `${this.wcBase}/products/${productId}/variations/${v.variationId}`,
            payload,
            { auth: this.wcAuth, timeout: 30000 },
          ),
        );
        updated++;
      } catch (e: any) {
        const reason = `${e?.response?.status || ''} ${JSON.stringify(e?.response?.data || {}).slice(0, 200)}`;
        failed.push({ variationId: v.variationId, reason });
        this.logger.error(`Sync EAN variation #${v.variationId} falhou: ${reason}`);
      }
    }
    return { updated, failed };
  }
}
