import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

/**
 * Cliente direto pro MySQL do WordPress/WooCommerce.
 * SOMENTE LEITURA por enquanto — usado pra puxar dados de plugins que não
 * expõem REST (ex.: "Cart Abandonment Recovery for WooCommerce" da CartFlows).
 *
 * Pool de 5 conexões pra não pressionar o DB do WP.
 */
@Injectable()
export class WpDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WpDbService.name);
  private pool: mysql.Pool | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const host = this.config.get<string>('WP_DB_HOST');
    if (!host) {
      this.logger.warn('⚠️  WP_DB_HOST não configurado — WpDbService inativo');
      return;
    }

    this.pool = mysql.createPool({
      host,
      port: Number(this.config.get<string>('WP_DB_PORT') ?? 3306),
      user: this.config.get<string>('WP_DB_USER'),
      password: this.config.get<string>('WP_DB_PASSWORD'),
      database: this.config.get<string>('WP_DB_DATABASE'),
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 5000,
      timezone: 'Z',
    });

    // IMPORTANTE: ping em background (fire-and-forget). NÃO bloquear o boot.
    // Se o IP do Railway não estiver liberado no WP, o TCP fica pendurado
    // e trava o startup do Nest → healthcheck falha.
    this.pool
      .getConnection()
      .then((conn) => {
        conn
          .ping()
          .then(() => {
            this.logger.log('✅ WP MySQL conectado (wordpress)');
            conn.release();
          })
          .catch((e) => {
            this.logger.warn(`⚠️  WP MySQL ping falhou: ${(e as Error).message}`);
            conn.release();
          });
      })
      .catch((e) => {
        this.logger.warn(`⚠️  WP MySQL não conectou: ${(e as Error).message}`);
      });
  }

  async onModuleDestroy() {
    if (this.pool) await this.pool.end();
  }

  /**
   * Expõe o pool pra outros services que precisam rodar queries no WP.
   * Retorna null se não inicializou (env incompleto ou DB fora do ar).
   */
  getPool(): mysql.Pool | null {
    return this.pool;
  }

  /**
   * Executa uma query simples. Se o pool não estiver pronto, retorna [].
   */
  async query<T = mysql.RowDataPacket>(
    sql: string,
    params: any[] = [],
  ): Promise<T[]> {
    if (!this.pool) return [];
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
    return rows as unknown as T[];
  }

  /**
   * Busca URL da imagem principal (thumbnail) de produtos pelos SKUs/REFs.
   *
   * Como o SKU no WC muitas vezes tem variantes (ex: VLM-222EM, VLM-222EP) mas
   * a REF base (VLM-222) é o que temos, usamos LIKE 'REF%'. Se houver múltiplos
   * matches, pega o primeiro produto PUBLICADO encontrado (qualquer tamanho/cor
   * tem a mesma foto principal na maioria dos casos).
   *
   * Retorna map { REF → imageUrl } — REF não encontrada fica fora do map.
   *
   * Performance: 1 query SQL pra uma lista de REFs. Se a lista ultrapassar 50,
   * fatia em lotes pra não estourar o tamanho do statement.
   */
  // Cache em memória de imagens por REF — TTL 10 min.
  // Imagens não mudam toda hora, então é seguro cachear. Reduz drasticamente
  // o tempo de resposta da tela de Realinhamento (era 5-10s, vai pra <500ms).
  // Compartilhado entre todas as chamadas (singleton do service).
  private imageCache = new Map<string, { url: string; expiresAt: number }>();
  private siteUrlCache: { value: string; expiresAt: number } | null = null;
  private readonly CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

  async getImagesByRefs(refs: string[]): Promise<Record<string, string>> {
    if (!this.pool || !refs.length) return {};

    const uniqRefs = Array.from(new Set(refs.map((r) => String(r || '').trim()).filter(Boolean)));
    if (!uniqRefs.length) return {};

    const result: Record<string, string> = {};
    const now = Date.now();

    // Separa: refs JÁ NO CACHE (válido) vs refs NOVAS (precisam consulta SQL)
    const refsToFetch: string[] = [];
    for (const ref of uniqRefs) {
      const cached = this.imageCache.get(ref.toUpperCase());
      if (cached && cached.expiresAt > now) {
        if (cached.url) result[ref] = cached.url;
        // url vazia significa "consultou e não achou" — válido cachear
      } else {
        refsToFetch.push(ref);
      }
    }

    if (refsToFetch.length === 0) return result; // tudo veio do cache

    const BATCH = 50;

    // siteUrl também cacheado (não muda quase nunca)
    let siteUrl: string;
    if (this.siteUrlCache && this.siteUrlCache.expiresAt > now) {
      siteUrl = this.siteUrlCache.value;
    } else {
      const siteUrlRows = await this.query<{ option_value: string }>(
        "SELECT option_value FROM wp_options WHERE option_name = 'siteurl' LIMIT 1",
      );
      siteUrl = (siteUrlRows[0]?.option_value || '').replace(/\/+$/, '');
      this.siteUrlCache = { value: siteUrl, expiresAt: now + this.CACHE_TTL_MS };
    }

    for (let i = 0; i < refsToFetch.length; i += BATCH) {
      const slice = refsToFetch.slice(i, i + BATCH);

      // Constrói LIKE OR pra cada REF — precisa no where MySQL
      const likeClauses = slice.map(() => 'pm_sku.meta_value LIKE ?').join(' OR ');
      const likeParams = slice.map((r) => `${r}%`);

      // Query:
      // 1. Pega posts do tipo product (publicado ou rascunho) com SKU que bata
      // 2. Faz join com _thumbnail_id → pega ID do anexo de imagem
      // 3. Join com _wp_attached_file → caminho relativo do upload
      // 4. Prefixa com siteurl/wp-content/uploads/ pra URL absoluta
      const sql = `
        SELECT
          pm_sku.meta_value AS sku,
          pm_file.meta_value AS file_path
        FROM wp_postmeta pm_sku
        JOIN wp_posts p
          ON p.ID = pm_sku.post_id
          AND p.post_type IN ('product', 'product_variation')
        LEFT JOIN wp_posts parent
          ON parent.ID = p.post_parent
        JOIN wp_postmeta pm_thumb
          ON pm_thumb.post_id = (CASE WHEN p.post_type = 'product_variation' THEN p.post_parent ELSE p.ID END)
          AND pm_thumb.meta_key = '_thumbnail_id'
        JOIN wp_postmeta pm_file
          ON pm_file.post_id = pm_thumb.meta_value
          AND pm_file.meta_key = '_wp_attached_file'
        WHERE pm_sku.meta_key = '_sku'
          AND (${likeClauses})
      `;

      try {
        const rows = await this.query<{ sku: string; file_path: string }>(sql, likeParams);
        for (const row of rows) {
          const sku = String(row.sku || '');
          const file = String(row.file_path || '');
          if (!file) continue;

          // Match: procura qual REF da lista original esse SKU corresponde
          const matched = slice.find((r) => sku.toUpperCase().startsWith(r.toUpperCase()));
          if (!matched) continue;
          if (result[matched]) continue; // já pegou — mantém o primeiro

          const url = siteUrl
            ? `${siteUrl}/wp-content/uploads/${file}`
            : `/wp-content/uploads/${file}`;
          result[matched] = url;
        }

        // Salva no cache: ACHADOS com URL + NÃO ACHADOS com url vazia
        // (assim na próxima consulta NÃO vamos refazer SQL pra refs que já
        // sabemos que não tem foto). Cache válido por 10 min.
        const expiresAt = now + this.CACHE_TTL_MS;
        for (const ref of slice) {
          this.imageCache.set(ref.toUpperCase(), {
            url: result[ref] || '',
            expiresAt,
          });
        }
      } catch (e: any) {
        this.logger.warn(`getImagesByRefs falhou: ${e.message}`);
        // Não quebra o caller — só devolve vazio pro lote que falhou
      }
    }

    return result;
  }

  /**
   * Limpa o cache de imagens. Útil pra forçar refresh quando vendedora
   * mudou foto de produto e quer ver o novo. Chamar via endpoint admin.
   */
  clearImageCache(): { cleared: number } {
    const n = this.imageCache.size;
    this.imageCache.clear();
    this.siteUrlCache = null;
    return { cleared: n };
  }
}
