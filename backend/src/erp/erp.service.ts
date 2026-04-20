import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import { StockEntry } from '../routing/types';

/**
 * Cliente para o MySQL do ERP gigasistemas21 (WinCred).
 * SOMENTE LEITURA. Usa pool de 5 conexões para proteger o banco do ERP.
 *
 * Schema real (confirmado via inspect-erp):
 *   tabela `estoque`  (266k registros — estoque consolidado)
 *     CODIGO   varchar(14)   SKU do produto
 *     ESTOQUE  int(11)       quantidade disponível
 *     LOJA     char(2)       código da loja (01..20)
 */
@Injectable()
export class ErpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ErpService.name);
  private pool: mysql.Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.pool = mysql.createPool({
      host: this.config.get<string>('ERP_HOST'),
      port: Number(this.config.get<string>('ERP_PORT') ?? 3306),
      user: this.config.get<string>('ERP_USER'),
      password: this.config.get<string>('ERP_PASSWORD'),
      database: this.config.get<string>('ERP_DATABASE'),
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 5000,
    });

    // IMPORTANTE: ping em background. NÃO bloquear o boot do Nest.
    // Se ERP_HOST não estiver acessível do Railway, o TCP fica pendurado
    // e trava o startup → healthcheck falha.
    this.pool
      .getConnection()
      .then((conn) => {
        conn
          .ping()
          .then(() => {
            this.logger.log('✅ ERP MySQL conectado (gigasistemas21)');
            conn.release();
          })
          .catch((e) => {
            this.logger.warn(`⚠️  ERP MySQL ping falhou: ${(e as Error).message}`);
            conn.release();
          });
      })
      .catch((e) => {
        this.logger.warn(`⚠️  ERP MySQL não conectou: ${(e as Error).message}`);
      });
  }

  async onModuleDestroy() {
    if (this.pool) await this.pool.end();
  }

  /**
   * Consulta estoque por SKU × loja na tabela `estoque` do WinCred.
   * Retorna só registros com ESTOQUE > 0.
   */
  async getStock(skus: string[], storeCodes: string[]): Promise<StockEntry[]> {
    if (!skus.length || !storeCodes.length || !this.pool) return [];

    const sql = `
      SELECT CODIGO AS sku,
             LOJA   AS storeCode,
             ESTOQUE AS availableQty
        FROM estoque
       WHERE CODIGO IN (?)
         AND LOJA IN (?)
         AND ESTOQUE > 0
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [skus, storeCodes]);
      return rows.map((r) => ({
        storeCode: String(r.storeCode).trim(),
        sku: String(r.sku).trim(),
        availableQty: Number(r.availableQty),
      }));
    } catch (e) {
      this.logger.error(`Falha ao consultar estoque ERP: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Estoque TOTAL consolidado por SKU (soma de todas as lojas).
   * Retorna um mapa { [sku]: totalQty }.
   * SKUs que não existem no ERP não aparecem no mapa (não ficam 0).
   *
   * Usado pela tela /produtos pra comparar estoque WooCommerce x ERP físico.
   */
  async getStockTotalBySkus(skus: string[]): Promise<Record<string, number>> {
    if (!skus.length || !this.pool) return {};

    // Normaliza: tira duplicados e strings vazias
    const unique = Array.from(new Set(skus.filter((s) => s && s.trim()))).map((s) => s.trim());
    if (!unique.length) return {};

    // PASSO 1: verifica quais SKUs existem no CADASTRO (tabela `produtos`).
    // Produto pode existir em `produtos` mas NÃO em `estoque` se ele está zerado
    // em todas as lojas (gigasistemas só cria linha em `estoque` quando há movimento).
    // Se confundirmos "sem linha em estoque" com "não existe", as 698 variações
    // não atualizam pra zero quando deveriam.
    const existsInProducts = new Set<string>();
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        'SELECT CODIGO FROM produtos WHERE CODIGO IN (?)',
        [unique],
      );
      for (const r of rows) {
        existsInProducts.add(String(r.CODIGO).trim());
      }
    } catch (e) {
      this.logger.error(`Falha ao verificar cadastro ERP: ${(e as Error).message}`);
      // Em erro, segue pro passo 2 sem distinção (comportamento antigo)
    }

    // PASSO 2: busca estoque consolidado dos que têm movimento em pelo menos uma loja.
    const stockMap: Record<string, number> = {};
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO AS sku, SUM(ESTOQUE) AS totalQty
           FROM estoque
          WHERE CODIGO IN (?)
          GROUP BY CODIGO`,
        [unique],
      );
      for (const r of rows) {
        stockMap[String(r.sku).trim()] = Number(r.totalQty) || 0;
      }
    } catch (e) {
      this.logger.error(`Falha ao consultar estoque total ERP: ${(e as Error).message}`);
      return {};
    }

    // PASSO 3: para cada SKU que EXISTE no cadastro mas NÃO tem linha em estoque,
    // assume estoque = 0. Pra SKU que não existe no cadastro, omite do mapa
    // (fica como "não encontrado" — produto descatalogado, não mexer no WC).
    const result: Record<string, number> = { ...stockMap };
    for (const sku of existsInProducts) {
      if (!(sku in result)) {
        result[sku] = 0;
      }
    }
    return result;
  }

  /**
   * Estoque por SKU detalhado por loja — retorna mapa {[sku]: [{storeCode, qty}, ...]}.
   * Útil pra detalhamento por filial na tela de produto.
   */
  async getStockBySkusDetailed(skus: string[]): Promise<Record<string, Array<{ storeCode: string; qty: number }>>> {
    if (!skus.length || !this.pool) return {};
    const unique = Array.from(new Set(skus.filter((s) => s && s.trim()))).map((s) => s.trim());
    if (!unique.length) return {};

    const sql = `
      SELECT CODIGO AS sku,
             LOJA   AS storeCode,
             ESTOQUE AS qty
        FROM estoque
       WHERE CODIGO IN (?)
         AND ESTOQUE > 0
       ORDER BY CODIGO, LOJA
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [unique]);
      const map: Record<string, Array<{ storeCode: string; qty: number }>> = {};
      for (const r of rows) {
        const sku = String(r.sku).trim();
        if (!map[sku]) map[sku] = [];
        map[sku].push({ storeCode: String(r.storeCode).trim(), qty: Number(r.qty) || 0 });
      }
      return map;
    } catch (e) {
      this.logger.error(`Falha ao consultar estoque detalhado ERP: ${(e as Error).message}`);
      return {};
    }
  }

  /**
   * DIAGNÓSTICO RAW: busca TODAS as linhas da tabela `estoque` para um SKU,
   * sem filtrar ESTOQUE > 0 e sem agregar. Revela:
   *   - duplicatas (mesma CODIGO+LOJA com linhas múltiplas)
   *   - linhas negativas (devoluções pendentes)
   *   - distribuição por loja COMPLETA (inclusive zeros)
   * Usado pra investigar por que routing escolheu uma loja que ERP "diz" não ter peça.
   */
  async getStockRawBySku(sku: string): Promise<Array<{ sku: string; storeCode: string; qty: number }>> {
    if (!sku || !this.pool) return [];
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO AS sku, LOJA AS storeCode, ESTOQUE AS qty
           FROM estoque
          WHERE CODIGO = ?
          ORDER BY LOJA`,
        [sku.trim()],
      );
      return (rows as any[]).map((r) => ({
        sku: String(r.sku).trim(),
        storeCode: String(r.storeCode).trim(),
        qty: Number(r.qty) || 0,
      }));
    } catch (e) {
      this.logger.error(`getStockRawBySku falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Diagnóstico: lista colunas da tabela `produtos` do Gigasistemas.
   * Usado pra descobrir qual coluna guarda o EAN13 (código de barras).
   * Retorna também 3 registros de amostra (com TODOS os campos preenchidos)
   * pra facilitar a identificação visual do campo certo.
   */
  async describeProductsTable(): Promise<{
    columns: Array<{ field: string; type: string }>;
    sample: any[];
  }> {
    if (!this.pool) return { columns: [], sample: [] };
    try {
      const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
        'SHOW COLUMNS FROM produtos',
      );
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        'SELECT * FROM produtos LIMIT 3',
      );
      return {
        columns: cols.map((c: any) => ({ field: c.Field, type: c.Type })),
        sample: rows as any[],
      };
    } catch (e) {
      this.logger.error(`describeProductsTable falhou: ${(e as Error).message}`);
      return { columns: [], sample: [] };
    }
  }

  /**
   * Busca produtos no Gigasistemas por uma lista de códigos que podem estar
   * em QUALQUER campo (CODIGO, EAN13, CODBARRAS, etc). Retorna um mapa
   * codigo-procurado → CODIGO oficial do Gigasistemas.
   *
   * Só é usada quando algum SKU não bateu em getStockTotalBySkus (padrão),
   * pra evitar query cara no fluxo normal.
   */
  async findCodigosByAny(
    candidates: string[],
    column: string,
  ): Promise<Record<string, string>> {
    if (!candidates.length || !this.pool) return {};
    // Whitelist de colunas pra proteger contra injeção — expandir conforme schema
    const allowed = new Set([
      'CODIGO',
      'EAN',
      'EAN13',
      'CODBARRAS',
      'CODIGOBARRAS',
      'COD_BARRAS',
      'CODIGO_BARRAS',
      'COD_EAN',
      'REFERENCIA',
      'REF',
    ]);
    if (!allowed.has(column)) {
      throw new Error(`Coluna não permitida: ${column}`);
    }
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, \`${column}\` AS found FROM produtos WHERE \`${column}\` IN (?)`,
        [candidates],
      );
      const map: Record<string, string> = {};
      for (const r of rows as any[]) {
        if (r.found) map[String(r.found)] = String(r.CODIGO);
      }
      return map;
    } catch (e) {
      this.logger.error(
        `findCodigosByAny(${column}) falhou: ${(e as Error).message}`,
      );
      return {};
    }
  }

  /**
   * DIAGNÓSTICO: busca produtos no ERP por trecho (LIKE) em CODIGO, REF ou DESCRICAOCOMPLETA.
   * Limita a 20 resultados. Retorna os campos relevantes pra entender o match.
   */
  async searchProductsLike(term: string): Promise<any[]> {
    if (!this.pool || !term) return [];
    const like = `%${term}%`;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, REF, DESCRICAOCOMPLETA, COR, TAMANHO, ESTOQUE, ID
           FROM produtos
          WHERE CODIGO LIKE ? OR REF LIKE ? OR DESCRICAOCOMPLETA LIKE ?
          LIMIT 20`,
        [like, like, like],
      );
      return rows as any[];
    } catch (e) {
      this.logger.error(`searchProductsLike falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Resolve EAN13 (código de barras) para uma lista de SKUs do Gigasistemas.
   *
   * Tenta várias colunas conhecidas (EAN13, EAN, CODBARRAS, CODIGOBARRAS,
   * COD_BARRAS, CODIGO_BARRAS) — a primeira que retornar dados válidos ganha.
   *
   * Retorna mapa sku → ean. SKUs sem EAN ficam fora do mapa (operador vai
   * ter que bipar manualmente ou reportar).
   *
   * Usado pela tela de bipagem da filial — operador bipa EAN, sistema resolve
   * qual SKU é via esse mapa invertido.
   */
  async getEansBySkus(skus: string[]): Promise<Record<string, string>> {
    if (!skus.length || !this.pool) return {};

    const candidates = ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS'];

    // MERGE de TODAS as colunas (não para no primeiro hit — uma coluna pode ter 1 SKU
    // preenchido e outra ter o resto). Primeira a preencher ganha a prioridade.
    const map: Record<string, string> = {};
    const totalSet = new Set<string>();

    for (const column of candidates) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, \`${column}\` AS ean FROM produtos WHERE CODIGO IN (?)`,
          [skus],
        );
        let hits = 0;
        for (const r of rows as any[]) {
          const codigo = String(r.CODIGO).trim();
          const ean = r.ean ? String(r.ean).trim() : '';
          if (ean && ean.length >= 8 && !map[codigo]) {
            map[codigo] = ean;
            totalSet.add(codigo);
            hits++;
          }
        }
        if (hits > 0) {
          this.logger.log(`getEansBySkus: coluna ${column} adicionou ${hits} SKUs (total ${totalSet.size}/${skus.length})`);
        }
      } catch (e: any) {
        // Coluna não existe nessa tabela → tenta a próxima
        if (!/Unknown column/i.test(e?.message ?? '')) {
          this.logger.warn(`getEansBySkus(${column}) erro: ${e.message}`);
        }
      }
    }

    if (totalSet.size === 0) {
      this.logger.warn(`getEansBySkus: nenhuma coluna resolveu EANs pros SKUs ${skus.slice(0, 3).join(',')}...`);
    }
    return map;
  }

  /**
   * Fallback pra bipagem: dado um EAN bipado, procura em TODAS as colunas candidatas
   * da tabela produtos (EAN13, EAN, CODBARRAS, etc) + tenta com e sem zeros à esquerda.
   * Retorna o CODIGO (SKU oficial do Gigasistemas) ou null.
   *
   * Usado quando o frontend bipa um EAN que não bateu no mapa local (eventualmente
   * o SKU do WC não existe exatamente como CODIGO no Gigasistemas, ou tem padding
   * diferente de zeros).
   */
  async findSkuByAnyEan(ean: string): Promise<string | null> {
    if (!this.pool || !ean) return null;
    const raw = ean.trim();
    if (!raw) return null;

    // Gera variantes: cru, sem zeros à esquerda, padded pra 13/14 dígitos
    const stripped = raw.replace(/^0+/, '');
    const variants = new Set<string>([raw, stripped]);
    if (/^\d+$/.test(raw)) {
      variants.add(raw.padStart(13, '0'));
      variants.add(raw.padStart(14, '0'));
    }
    const list = Array.from(variants).filter(Boolean);
    if (!list.length) return null;

    const columns = ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS'];

    for (const col of columns) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM produtos WHERE \`${col}\` IN (?) LIMIT 5`,
          [list],
        );
        if ((rows as any[]).length) {
          const codigo = String((rows as any[])[0].CODIGO).trim();
          this.logger.log(`findSkuByAnyEan: EAN ${raw} encontrado em ${col} → ${codigo}`);
          return codigo;
        }
      } catch (e: any) {
        if (!/Unknown column/i.test(e?.message ?? '')) {
          this.logger.warn(`findSkuByAnyEan(${col}) erro: ${e.message}`);
        }
      }
    }
    return null;
  }

  /**
   * DIAGNÓSTICO: dump completo de um SKU na tabela produtos — todas as colunas
   * candidatas de EAN. Usado pra debugar quando um bip não casa.
   */
  async debugProductEans(sku: string): Promise<Record<string, any> | null> {
    if (!this.pool || !sku) return null;
    const columns = ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS', 'REF', 'REFERENCIA'];
    const existing: string[] = [];
    // Descobre quais colunas existem
    try {
      const [cols] = await this.pool.query<mysql.RowDataPacket[]>('SHOW COLUMNS FROM produtos');
      const names = new Set((cols as any[]).map((c) => String(c.Field).toUpperCase()));
      for (const c of columns) {
        if (names.has(c)) existing.push(c);
      }
    } catch {
      return null;
    }
    if (!existing.length) return { sku, columns: [], row: null };
    const selectList = ['CODIGO', ...existing].map((c) => `\`${c}\``).join(', ');
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT ${selectList} FROM produtos WHERE CODIGO = ? LIMIT 1`,
        [sku.trim()],
      );
      return {
        sku,
        columnsChecked: existing,
        row: (rows as any[])[0] ?? null,
      };
    } catch (e: any) {
      return { sku, error: e.message, columnsChecked: existing, row: null };
    }
  }

  /** Retorna metadados de um produto (nome, preço) direto da tabela produtos. */
  async getProduct(sku: string): Promise<{ name: string; price: number } | null> {
    if (!this.pool) return null;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT DESCRICAOCOMPLETA AS name, VENDAUN AS price
           FROM produtos
          WHERE CODIGO = ?
          LIMIT 1`,
        [sku],
      );
      if (!rows.length) return null;
      return { name: String(rows[0].name), price: Number(rows[0].price) };
    } catch {
      return null;
    }
  }
}
