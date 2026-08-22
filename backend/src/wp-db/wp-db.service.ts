import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import { EventLoopService } from '../health/event-loop.service';

/** Falhas seguidas de conexão antes de parar de tentar. */
const FALHAS_PRA_ABRIR = 3;
/** Primeira espera com o circuito aberto. Dobra a cada rodada que falha. */
const ESPERA_INICIAL_MS = 30_000;
/** Teto da espera — mesmo morto há horas, tenta de novo a cada 10 min. */
const ESPERA_MAXIMA_MS = 10 * 60_000;

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

  /**
   * DISJUNTOR — o servidor do WP pode sumir, e some.
   *
   * Medido em 22/08/2026: `162.215.213.154:3306` respondendo EHOSTUNREACH em
   * 100% das tentativas, e a tela de realinhamento disparando `getImagesByRefs`
   * a cada chamada. Sem disjuntor, cada uma dessas ia pro pool esperar até
   * `connectTimeout` (12s) numa fila que era ILIMITADA (`queueLimit: 0`) — o
   * mesmo desenho que o CLAUDE.md documenta como causa da queda da live de
   * 01/07, só que no pool do WordPress em vez do Giga.
   *
   * O comentário que justificava não ter disjuntor dizia "servidor dedicado e
   * aberto pra qualquer IP". Isso deixou de ser verdade. Agora: 3 falhas
   * seguidas abrem o circuito, e enquanto ele estiver aberto a consulta falha
   * NA HORA em vez de ocupar conexão e esperar 12s.
   */
  private falhasSeguidas = 0;
  private circuitoAbertoAte = 0;
  private esperaAtualMs = ESPERA_INICIAL_MS;
  /** Pra logar a abertura uma vez só, e não a cada chamada recusada. */
  private avisouCircuitoAberto = false;
  private recusadasNoCircuito = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly eventLoop: EventLoopService,
  ) {}

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
      /**
       * ⚠️ FILA FINITA. Era `0` — ilimitada — e com o host fora do ar as
       * chamadas empilhavam sem teto, cada uma segurando memória e uma promise
       * viva por até 12s. Com teto, o excedente é recusado NA HORA
       * (`ER_CON_COUNT_ERROR`), que é o que o chamador já sabe tratar: todos os
       * usos daqui caem pra "sem foto" e seguem a vida.
       */
      queueLimit: 20,
      // 12s. Mesmo servidor dedicado do Giga. 4s/5s causava ETIMEDOUT em pico
      // de latência. Hoje quem faz o "falhar rápido" é o disjuntor abaixo — o
      // timeout só vale pra PRIMEIRA tentativa depois que o circuito reabre.
      connectTimeout: 12000,
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
   *
   * Passa pelo disjuntor: com o servidor do WP fora do ar, devolve [] na hora
   * em vez de ocupar conexão e esperar o `connectTimeout`. Todo chamador daqui
   * já trata lista vazia (a foto do realinhamento cai pro ícone), então falhar
   * rápido é estritamente melhor do que falhar devagar.
   */
  async query<T = mysql.RowDataPacket>(
    sql: string,
    params: any[] = [],
  ): Promise<T[]> {
    if (!this.pool) return [];
    if (this.circuitoAberto()) return [];

    const fim = this.eventLoop.marcar('wp-mysql:query');
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      this.registrarSucesso();
      return rows as unknown as T[];
    } catch (err) {
      this.registrarFalha(err as Error);
      throw err;
    } finally {
      fim();
    }
  }

  /** true = não vale a pena tentar agora. */
  private circuitoAberto(): boolean {
    if (Date.now() >= this.circuitoAbertoAte) return false;
    this.recusadasNoCircuito++;
    return true;
  }

  private registrarSucesso() {
    if (this.avisouCircuitoAberto) {
      this.logger.log(
        `✅ WP MySQL voltou — circuito fechado (${this.recusadasNoCircuito} consulta(s) recusada(s) enquanto esteve aberto)`,
      );
    }
    this.falhasSeguidas = 0;
    this.circuitoAbertoAte = 0;
    this.esperaAtualMs = ESPERA_INICIAL_MS;
    this.avisouCircuitoAberto = false;
    this.recusadasNoCircuito = 0;
  }

  private registrarFalha(err: Error) {
    this.falhasSeguidas++;
    if (this.falhasSeguidas < FALHAS_PRA_ABRIR) return;

    this.circuitoAbertoAte = Date.now() + this.esperaAtualMs;
    // Uma linha por ABERTURA, não por falha. Era este log — repetido a cada
    // pre-fetch de imagem — que enchia o log de produção de EHOSTUNREACH.
    if (!this.avisouCircuitoAberto) {
      this.logger.warn(
        `⚠️  WP MySQL fora do ar (${err.message}) — circuito ABERTO por ${Math.round(this.esperaAtualMs / 1000)}s. ` +
          `As telas que dependem disto seguem sem a foto, sem esperar.`,
      );
      this.avisouCircuitoAberto = true;
    }
    this.esperaAtualMs = Math.min(this.esperaAtualMs * 2, ESPERA_MAXIMA_MS);
  }

  /** Estado do disjuntor — sai no GET /api/health/diagnostico. */
  estadoConexao() {
    return {
      configurado: !!this.pool,
      circuitoAberto: Date.now() < this.circuitoAbertoAte,
      reabreEmS: Math.max(0, Math.round((this.circuitoAbertoAte - Date.now()) / 1000)),
      falhasSeguidas: this.falhasSeguidas,
      recusadasNoCircuito: this.recusadasNoCircuito,
    };
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

  /**
   * TODOS os produtos do WordPress de uma REF, com a GALERIA inteira.
   *
   * Existe porque a REST do WooCommerce não serve pra isso: lá `sku=VLM-222`
   * exige igualdade exata e devolve UM produto, enquanto no WordPress o SKU é
   * "VLM-222 MARROM", "VLM-222 MUSGO"… — por isso o PDV, que sempre leu o
   * MySQL direto com `LIKE 'REF%'`, mostra foto onde a REST não achava nada.
   *
   * Traz `post_status` (inclusive rascunho) e a galeria além da capa: a
   * segunda foto costuma ser a das costas, que é o que a cliente plus size
   * mais pede.
   */
  async getProdutosPorRef(
    ref: string,
  ): Promise<Array<{ id: number; nome: string; sku: string; status: string; imagens: string[] }>> {
    if (!this.pool) return [];
    const alvo = String(ref || '').trim();
    if (!alvo) return [];

    const siteUrl = await this.getSiteUrl();

    const produtos = await this.query<{
      id: number; nome: string; sku: string; status: string;
      thumb: string | null; galeria: string | null;
    }>(
      `SELECT p.ID AS id, p.post_title AS nome, p.post_status AS status,
              pm_sku.meta_value AS sku,
              pm_thumb.meta_value AS thumb,
              pm_gal.meta_value AS galeria
         FROM wp_postmeta pm_sku
         JOIN wp_posts p ON p.ID = pm_sku.post_id AND p.post_type = 'product'
         LEFT JOIN wp_postmeta pm_thumb
                ON pm_thumb.post_id = p.ID AND pm_thumb.meta_key = '_thumbnail_id'
         LEFT JOIN wp_postmeta pm_gal
                ON pm_gal.post_id = p.ID AND pm_gal.meta_key = '_product_image_gallery'
        WHERE pm_sku.meta_key = '_sku'
          AND pm_sku.meta_value LIKE ?
          AND p.post_status IN ('publish', 'draft', 'private', 'pending')
        LIMIT 200`,
      [`${alvo}%`],
    );
    if (!produtos.length) return [];

    // Uma query só pra todos os arquivos — evita N+1 no servidor compartilhado.
    const ids = new Set<string>();
    for (const p of produtos) {
      if (p.thumb) ids.add(String(p.thumb));
      for (const g of String(p.galeria || '').split(',')) {
        const limpo = g.trim();
        if (limpo) ids.add(limpo);
      }
    }
    const arquivos = new Map<string, string>();
    if (ids.size) {
      const lista = Array.from(ids);
      const rows = await this.query<{ post_id: number; meta_value: string }>(
        `SELECT post_id, meta_value FROM wp_postmeta
          WHERE meta_key = '_wp_attached_file' AND post_id IN (${lista.map(() => '?').join(',')})`,
        lista,
      );
      for (const r of rows) arquivos.set(String(r.post_id), String(r.meta_value || ''));
    }

    const url = (idAnexo: string) => {
      const file = arquivos.get(idAnexo);
      if (!file) return null;
      return siteUrl ? `${siteUrl}/wp-content/uploads/${file}` : null;
    };

    return produtos.map((p) => {
      const ordem = [String(p.thumb || ''), ...String(p.galeria || '').split(',')]
        .map((x) => x.trim())
        .filter(Boolean);
      const imagens = Array.from(new Set(ordem))
        .map(url)
        .filter((u): u is string => !!u);
      return {
        id: Number(p.id),
        nome: String(p.nome || ''),
        sku: String(p.sku || ''),
        status: String(p.status || ''),
        imagens,
      };
    });
  }

  /**
   * TODOS os produtos do site antigo, numa query só — SKU e nome.
   *
   * É a base do "importar tudo" INVERTIDO (06/08): em vez de perguntar ao
   * WordPress por cada uma das ~21 mil REFs do catálogo (90% "não tem"), a
   * fila nasce do que o site antigo REALMENTE tem — que não chega a 10% disso.
   * A REF de cada produto é extraída depois (SKU "VLM-222 MARROM" → primeira
   * palavra; nome "… Ref VLM-222 …" quando o SKU está vazio).
   *
   * Devolve [] com o pool fora — quem chama decide se isso é erro.
   */
  async listarTodosSkus(): Promise<Array<{ sku: string; nome: string }>> {
    if (!this.pool) return [];
    const rows = await this.query<{ sku: string | null; nome: string | null }>(
      `SELECT pm_sku.meta_value AS sku, p.post_title AS nome
         FROM wp_postmeta pm_sku
         JOIN wp_posts p ON p.ID = pm_sku.post_id AND p.post_type = 'product'
        WHERE pm_sku.meta_key = '_sku'
          AND p.post_status IN ('publish', 'draft', 'private', 'pending')`,
    );
    return rows.map((r) => ({ sku: String(r.sku || ''), nome: String(r.nome || '') }));
  }

  /**
   * Só o que está NO AR no site antigo — `post_status = 'publish'`.
   *
   * Diferente de `listarTodosSkus`, que traz rascunho e privado de propósito
   * (pra importar FOTO de peça que ainda não foi publicada lá). Aqui o
   * critério é outro: o dono decidiu em 07/08 que "ativo no WooCommerce" é
   * quem entra na vitrine nova. Rascunho é peça que ELE escolheu não mostrar,
   * e essa escolha tem que atravessar a migração.
   */
  async listarSkusPublicados(): Promise<Array<{ sku: string; nome: string }>> {
    if (!this.pool) return [];
    const rows = await this.query<{ sku: string | null; nome: string | null }>(
      `SELECT pm_sku.meta_value AS sku, p.post_title AS nome
         FROM wp_postmeta pm_sku
         JOIN wp_posts p ON p.ID = pm_sku.post_id AND p.post_type = 'product'
        WHERE pm_sku.meta_key = '_sku'
          AND p.post_status = 'publish'`,
    );
    return rows.map((r) => ({ sku: String(r.sku || ''), nome: String(r.nome || '') }));
  }

  /** URL do site (cacheada) — prefixo das imagens do WordPress. */
  private async getSiteUrl(): Promise<string> {
    const now = Date.now();
    if (this.siteUrlCache && this.siteUrlCache.expiresAt > now) return this.siteUrlCache.value;
    const rows = await this.query<{ option_value: string }>(
      "SELECT option_value FROM wp_options WHERE option_name = 'siteurl' LIMIT 1",
    );
    const value = (rows[0]?.option_value || '').replace(/\/+$/, '');
    this.siteUrlCache = { value, expiresAt: now + this.CACHE_TTL_MS };
    return value;
  }

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
      /**
       * SÓ CACHEIA SE VEIO. Com o WP fora do ar a consulta volta vazia, e
       * gravar isso no cache carimbava `siteUrl = ''` por 10 minutos — tempo
       * em que TODA foto sairia como caminho relativo (`/wp-content/...`),
       * quebrando a imagem mesmo depois do servidor voltar.
       */
      if (siteUrl) {
        this.siteUrlCache = { value: siteUrl, expiresAt: now + this.CACHE_TTL_MS };
      } else {
        return result; // sem base de URL não dá pra montar foto — devolve o que veio do cache
      }
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
   * Versão SÍNCRONA — só lê do cache, NÃO consulta o WP DB.
   * Pra refs em cache, retorna URL (ou string vazia se confirmou que não tem foto).
   * Pra refs SEM cache, retorna `undefined` no map (caller pode disparar fetch BG).
   * Latência: ~0ms (lookup em Map).
   */
  getCachedImages(refs: string[]): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    const now = Date.now();
    for (const ref of refs) {
      const r = String(ref || '').trim();
      if (!r) continue;
      const cached = this.imageCache.get(r.toUpperCase());
      if (cached && cached.expiresAt > now) {
        out[r] = cached.url || ''; // string vazia = consultou e não achou
      } else {
        out[r] = undefined; // sem cache → caller dispara fetch BG
      }
    }
    return out;
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
