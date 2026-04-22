import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import { StockEntry } from '../routing/types';

/**
 * Cliente para o MySQL do ERP gigasistemas21 (WinCred).
 *
 * LEITURA: sempre habilitada.
 * ESCRITA (baixa de estoque): controlada pelo env var ERP_WRITE_ENABLED='true'.
 *   Quando OFF (default), qualquer chamada a `decreaseStock` retorna erro
 *   sem tocar no MySQL — sistema fica em SHADOW MODE.
 *   Quando ON, o UPDATE acontece em transação ACID com rollback em falha.
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

  // ═══════════════════════════════════════════════════════════════════════
  // BAIXA DE ESTOQUE (WRITE) — controlado por env var ERP_WRITE_ENABLED.
  //
  // Kill-switch rápido: setar ERP_WRITE_ENABLED=false no Railway e dar
  // redeploy (ou restart) volta o sistema pro shadow mode sem mudar código.
  // ═══════════════════════════════════════════════════════════════════════

  /** Retorna true se o env var ERP_WRITE_ENABLED='true' (case-insensitive). */
  get isWriteEnabled(): boolean {
    const v = String(this.config.get('ERP_WRITE_ENABLED') ?? '').trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }

  /**
   * Baixa estoque no Gigasistemas — executa UPDATE em `estoque` dentro de
   * uma transação MySQL. Todos os itens caem ou nada cai (ACID).
   *
   * Regras:
   *  - ERP_WRITE_ENABLED precisa ser 'true'. Senão retorna erro sem tocar no DB.
   *  - Cada item: SELECT FOR UPDATE (pra travar linha durante a transação)
   *    → checa se existe → checa se não fica negativo → UPDATE.
   *  - Se qualquer item falhar, rollback da transação inteira.
   *  - Sempre retorna { success, applied, error? } — nunca lança exception
   *    (pra quem chama poder logar e decidir sem try/catch).
   *
   * O `storeCode` deve estar padronizado no formato Giga: 2 dígitos (01..20).
   * A função normaliza strings tipo "LJ01" → "01" automaticamente.
   */
  async decreaseStock(
    items: Array<{ sku: string; qty: number; storeCode: string }>,
  ): Promise<{
    success: boolean;
    applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }>;
    error?: string;
  }> {
    if (!this.isWriteEnabled) {
      return { success: false, applied: [], error: 'ERP_WRITE_ENABLED não habilitado' };
    }
    if (!this.pool) {
      return { success: false, applied: [], error: 'Pool ERP não inicializado' };
    }
    if (!items.length) {
      return { success: true, applied: [] };
    }

    // Normaliza storeCode: "LJ01" ou "1" → "01"
    const normalizeStoreCode = (raw: string): string => {
      const s = String(raw || '').trim().toUpperCase().replace(/^LJ/i, '');
      const n = parseInt(s, 10);
      if (Number.isNaN(n) || n < 1 || n > 99) return s; // devolve cru se não for número
      return String(n).padStart(2, '0');
    };

    const conn = await this.pool.getConnection();
    const applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }> = [];

    try {
      await conn.beginTransaction();

      for (const it of items) {
        const sku = String(it.sku || '').trim();
        const storeCode = normalizeStoreCode(it.storeCode);
        const qty = Math.max(1, Number(it.qty) || 1);

        if (!sku || !storeCode) {
          throw new Error(`Item inválido: sku='${sku}' storeCode='${storeCode}'`);
        }

        // SELECT FOR UPDATE — trava a linha durante a transação pra evitar
        // que outra conexão (ex: PDV do Giga) leia valor desatualizado.
        const [beforeRows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT ESTOQUE FROM estoque WHERE CODIGO = ? AND LOJA = ? LIMIT 1 FOR UPDATE`,
          [sku, storeCode],
        );

        if (!beforeRows.length) {
          throw new Error(`Registro não encontrado em estoque: SKU=${sku} LOJA=${storeCode}`);
        }

        const previousStock = Number(beforeRows[0].ESTOQUE) || 0;
        const newStock = previousStock - qty;

        // BLOQUEIO DURO: não deixar estoque negativo. Se acontecer, abortar a
        // transação inteira — operadora vê o erro e investiga (provavelmente
        // divergência com o físico).
        if (newStock < 0) {
          throw new Error(
            `Estoque insuficiente: SKU=${sku} LOJA=${storeCode} tem ${previousStock}, pediu ${qty}`,
          );
        }

        const [result]: any = await conn.query(
          `UPDATE estoque SET ESTOQUE = ? WHERE CODIGO = ? AND LOJA = ?`,
          [newStock, sku, storeCode],
        );

        if (!result || result.affectedRows !== 1) {
          throw new Error(
            `UPDATE não afetou linha esperada: SKU=${sku} LOJA=${storeCode} affected=${result?.affectedRows ?? 0}`,
          );
        }

        applied.push({ sku, storeCode, qty, previousStock, newStock });
      }

      await conn.commit();
      this.logger.log(
        `ERP baixa OK: ${applied.length} item(ns) baixado(s). ` +
          applied.map((a) => `${a.sku}/${a.storeCode}: ${a.previousStock}→${a.newStock}`).join(', '),
      );
      return { success: true, applied };
    } catch (e: any) {
      try { await conn.rollback(); } catch { /* ignore */ }
      const msg = String(e?.message || e);
      this.logger.error(`ERP baixa FALHOU (rollback): ${msg}`);
      return { success: false, applied: [], error: msg };
    } finally {
      conn.release();
    }
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
   * Diagnóstico: descreve a tabela `caixa` do Gigasistemas.
   * Tabela `caixa` é o registro linha-a-linha de tudo que passa pelo PDV —
   * usada tanto pra proporcionalidade (vendas por loja × últimos 30d) quanto
   * pra auto-baixa de VENDA CERTA (match SKU+LOJA+DATA).
   *
   * Schema real (confirmado via LURDS ANÁLISES em 21/04/26):
   *   DATA         — data da venda
   *   LOJA         — código da loja (FK → lojas.CODIGO)
   *   NUMERO       — número do cupom (DISTINCT = pedido)
   *   CODIGO       — SKU do produto
   *   DESCRICAO    — nome do produto
   *   QUANTIDADE   — qty vendida
   *   VALOR        — preço unitário
   *   VALORTOTAL   — total da linha
   *   VENDEDOR     — vendedor
   *   MARCADO      — se ='SIM' → linha inválida (já validada pelo WinCred)
   */
  async describeSalesTable(): Promise<{
    columns: Array<{ field: string; type: string }>;
    sample: any[];
  }> {
    if (!this.pool) return { columns: [], sample: [] };
    try {
      const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
        'SHOW COLUMNS FROM caixa',
      );
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT * FROM caixa
           WHERE (MARCADO IS NULL OR MARCADO <> 'SIM')
           ORDER BY DATA DESC
           LIMIT 3`,
      );
      return {
        columns: cols.map((c: any) => ({ field: c.Field, type: c.Type })),
        sample: rows as any[],
      };
    } catch (e) {
      this.logger.error(`describeSalesTable falhou: ${(e as Error).message}`);
      return { columns: [], sample: [] };
    }
  }

  /**
   * VENDAS POR LOJA — últimos N dias (default 30), em UNIDADES.
   * Usado pra calcular a proporcionalidade inversa no routing:
   *   loja que vendeu MAIS tem meta de cessão MENOR.
   *
   * Ignora linhas com MARCADO='SIM' (já liquidadas no WinCred).
   * Retorna sempre todas as lojas que tiveram VENDA no período — quem não
   * aparece no array é porque não vendeu nada (share=0).
   */
  async getSalesByStoreLastDays(
    days: number = 30,
  ): Promise<Array<{ storeCode: string; units: number; orders: number }>> {
    if (!this.pool) return [];
    const n = Math.max(1, Math.min(365, Number(days) || 30));
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT c.LOJA       AS storeCode,
                SUM(c.QUANTIDADE) AS units,
                COUNT(DISTINCT c.NUMERO) AS orders
           FROM caixa c
          WHERE c.DATA >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            AND (c.MARCADO IS NULL OR c.MARCADO <> 'SIM')
          GROUP BY c.LOJA`,
        [n],
      );
      return (rows as any[]).map((r) => ({
        storeCode: String(r.storeCode).trim(),
        units: Number(r.units) || 0,
        orders: Number(r.orders) || 0,
      }));
    } catch (e) {
      this.logger.error(`getSalesByStoreLastDays falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * AUTO-MATCH VENDA CERTA — procura na tabela `caixa` se a peça enviada
   * pra uma loja destino JÁ foi vendida no PDV de lá.
   *
   * A engine recebe um array de "candidatos" (cada VENDA CERTA pending tem
   * refCode + cor + tamanho + lojaDestino + dataEnvio). Como a `caixa` indexa
   * pelo CODIGO (SKU) do Gigasistemas e não pela REF, faço JOIN com `produtos`
   * pra resolver REF+COR+TAMANHO → CODIGO.
   *
   * Retorna um mapa `{ [indiceDoCandidato]: { numero, data, codigo, quantidade } }`
   * — só preenche quando bateu. Se não bateu, não tem entrada no mapa.
   *
   * Processamento em batch (LOOP de queries pequenas) — o volume é baixo
   * (dezenas a centenas de VENDA CERTA pending no máximo), então não vale
   * a pena montar uma query gigante com UNION.
   */
  async findVendaCertaMatches(
    candidates: Array<{
      lojaDestinoCode: string;
      refCode: string;
      cor: string | null;
      tamanho: string | null;
      dataEnvio: Date;
    }>,
  ): Promise<Record<number, { numero: string; data: Date; codigo: string; quantidade: number }>> {
    if (!this.pool || !candidates.length) return {};

    const out: Record<number, { numero: string; data: Date; codigo: string; quantidade: number }> = {};

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!c.lojaDestinoCode || !c.refCode) continue;

      // SQL dinâmico — cor/tamanho podem ser null no nosso lado (pedido veio
      // sem variação especificada). Nesse caso não filtra por esses campos.
      const conds: string[] = [
        'c.LOJA = ?',
        'p.REF = ?',
        'c.DATA >= ?',
        "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
      ];
      const vals: any[] = [
        c.lojaDestinoCode.trim(),
        c.refCode.trim().toUpperCase(),
        c.dataEnvio,
      ];
      if (c.cor && c.cor.trim()) {
        conds.push('p.COR = ?');
        vals.push(c.cor.trim());
      }
      if (c.tamanho && c.tamanho.trim()) {
        conds.push('p.TAMANHO = ?');
        vals.push(c.tamanho.trim());
      }

      const sql = `
        SELECT c.NUMERO     AS numero,
               c.DATA       AS data,
               c.CODIGO     AS codigo,
               c.QUANTIDADE AS quantidade
          FROM caixa c
          JOIN produtos p ON p.CODIGO = c.CODIGO
         WHERE ${conds.join(' AND ')}
         ORDER BY c.DATA ASC
         LIMIT 1
      `;

      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, vals);
        const row = (rows as any[])[0];
        if (row) {
          out[i] = {
            numero: String(row.numero),
            data: new Date(row.data),
            codigo: String(row.codigo).trim(),
            quantidade: Number(row.quantidade) || 1,
          };
        }
      } catch (e) {
        this.logger.warn(
          `findVendaCertaMatches(#${i}) falhou (loja=${c.lojaDestinoCode} ref=${c.refCode}): ${(e as Error).message}`,
        );
      }
    }

    return out;
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

  // ═══════════════════════════════════════════════════════════════════════
  // Consulta de loja — métodos específicos por tipo de busca.
  // Cada método assume uma intenção diferente da vendedora, sem o LIMIT
  // agressivo do searchProductsLike (que perdia "vestido azul 48" porque
  // o ERP tem milhares de "vestido azul").
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Busca EXATA por REF. Retorna TODAS as variações da mesma referência —
   * pouco volume (10 a 40 linhas) porque cada REF tem N tamanhos × cores.
   * LIKE só pra cobrir diferença de maiúscula/espaço (não wildcard %).
   */
  async searchByRef(ref: string): Promise<any[]> {
    if (!this.pool || !ref) return [];
    const clean = String(ref).trim();
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, REF, DESCRICAOCOMPLETA, COR, TAMANHO, ESTOQUE, ID
           FROM produtos
          WHERE REF = ? OR REF LIKE ?
          ORDER BY COR, TAMANHO
          LIMIT 500`,
        [clean, `${clean}%`], // exata + começando com (ex: "123" pega "123A")
      );
      return rows as any[];
    } catch (e) {
      this.logger.error(`searchByRef falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Busca por SKU ou EAN (código da etiqueta). PRIMEIRO acha UMA linha que bate,
   * pega a REF dela, e DEPOIS retorna TODAS as variações dessa REF — pra vendedora
   * ver os outros tamanhos/cores sem precisar buscar de novo.
   */
  async searchByCodeAndExpandRef(code: string): Promise<any[]> {
    if (!this.pool || !code) return [];
    const clean = String(code).trim();
    try {
      // 1) Tenta achar em CODIGO direto (SKU bipado)
      let [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT REF FROM produtos WHERE CODIGO = ? LIMIT 1`,
        [clean],
      );
      let ref: string | null = (rows as any[])[0]?.REF ?? null;

      // 2) Se não achou, tenta colunas de EAN/código de barras
      if (!ref && /^\d{6,}$/.test(clean)) {
        const eanCols = ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS'];
        for (const col of eanCols) {
          try {
            const [r] = await this.pool.query<mysql.RowDataPacket[]>(
              `SELECT REF FROM produtos WHERE \`${col}\` = ? LIMIT 1`,
              [clean],
            );
            const found = (r as any[])[0]?.REF;
            if (found) { ref = String(found); break; }
          } catch {
            // coluna não existe nesse schema — ignora
          }
        }
      }

      if (!ref) return [];

      // 3) Agora retorna TUDO da REF
      return this.searchByRef(ref);
    } catch (e) {
      this.logger.error(`searchByCodeAndExpandRef falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Busca por descrição. Aqui o volume é grande — "vestido" pode retornar
   * milhares de linhas. Estratégia:
   *  - Quebra o termo em PALAVRAS (cada uma vira um LIKE que precisa bater — AND).
   *    Ex: "vestido azul 48" → WHERE DESCRICAOCOMPLETA LIKE '%vestido%' AND ... '%azul%' AND ... '%48%'
   *  - Agrupa por REF (DISTINCT) e traz uma amostra da descrição.
   *  - Limite generoso (200 REFs) porque são só REFs únicas, não linhas.
   */
  async searchByDescriptionGrouped(
    term: string,
  ): Promise<Array<{ REF: string; DESCRICAOCOMPLETA: string; VARIANT_COUNT: number }>> {
    if (!this.pool || !term) return [];
    const words = String(term)
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 6); // limite de palavras pra não explodir SQL
    if (!words.length) return [];

    const whereClauses = words.map(() => 'DESCRICAOCOMPLETA LIKE ?').join(' AND ');
    const params = words.map((w) => `%${w}%`);

    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT REF,
                MAX(DESCRICAOCOMPLETA) AS DESCRICAOCOMPLETA,
                COUNT(*) AS VARIANT_COUNT
           FROM produtos
          WHERE ${whereClauses}
            AND REF IS NOT NULL
            AND REF <> ''
          GROUP BY REF
          ORDER BY VARIANT_COUNT DESC
          LIMIT 200`,
        params,
      );
      return rows as any[];
    } catch (e) {
      this.logger.error(`searchByDescriptionGrouped falhou: ${(e as Error).message}`);
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

    // IMPORTANTE: busca por CODIGO primeiro — muitas confecções imprimem o código
    // interno do ERP como barcode (não usam EAN13 internacional). Só depois
    // tenta as colunas de EAN propriamente ditas.
    const columns = ['CODIGO', 'EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS'];

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

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLICAÇÃO NO SITE — busca de referências pra enfileirar no LURDS ORDER ONE
  //
  // Este bloco existe pra alimentar a tela /retaguarda/publicar-site (Fase 1
  // da integração Wincred→WooCommerce). A estratégia é DEFENSIVA: nem todo
  // Gigasistemas tem as mesmas colunas (GRUPO, SUBGRUPO, FORNECEDOR, NCM,
  // CFOP, DATACADASTRO variam por versão/customização). Então detectamos o
  // schema em tempo de execução via `SHOW COLUMNS` e montamos as queries
  // só com as colunas que existem.
  // ═══════════════════════════════════════════════════════════════════════

  // Cache do schema da tabela `produtos` (conjunto de colunas em UPPER).
  // Evita rodar SHOW COLUMNS a cada request da tela.
  private _productsColsCache: Set<string> | null = null;
  private async getProductsColumns(): Promise<Set<string>> {
    if (this._productsColsCache) return this._productsColsCache;
    if (!this.pool) return new Set();
    try {
      const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
        'SHOW COLUMNS FROM produtos',
      );
      const set = new Set<string>(
        (cols as any[]).map((c) => String(c.Field).toUpperCase()),
      );
      this._productsColsCache = set;
      return set;
    } catch (e) {
      this.logger.warn(`getProductsColumns falhou: ${(e as Error).message}`);
      return new Set();
    }
  }

  /**
   * Resolve o nome REAL da coluna no schema, dado um conjunto de candidatos
   * comuns. Retorna o primeiro que existe, ou null. Útil pra campos que
   * variam entre versões do Gigasistemas (ex: CUSTOUN / CUSTO / CUSTOMEDIO).
   */
  private async pickCol(candidates: string[]): Promise<string | null> {
    const cols = await this.getProductsColumns();
    for (const cand of candidates) {
      if (cols.has(cand.toUpperCase())) return cand;
    }
    return null;
  }

  /**
   * FACETS — valores distintos de GRUPO, SUBGRUPO, FORNECEDOR pra popular
   * dropdowns no frontend. Cada um só é retornado se a coluna existir no
   * schema. Limita 500 valores por facet (o CEO tem poucos por natureza).
   */
  async getGigaFacetsForPublish(): Promise<{
    grupos: string[];
    subgrupos: string[];
    fornecedores: string[];
    hasGrupo: boolean;
    hasSubgrupo: boolean;
    hasFornecedor: boolean;
  }> {
    const emptyResult = {
      grupos: [] as string[],
      subgrupos: [] as string[],
      fornecedores: [] as string[],
      hasGrupo: false,
      hasSubgrupo: false,
      hasFornecedor: false,
    };
    if (!this.pool) return emptyResult;

    const grupoCol = await this.pickCol(['GRUPO', 'GRUPODESC', 'GRUPO_DESC', 'NOMEGRUPO']);
    const subgrupoCol = await this.pickCol(['SUBGRUPO', 'SUB_GRUPO', 'SUBGRUPODESC', 'NOMESUBGRUPO']);
    const fornecedorCol = await this.pickCol(['FORNECEDOR', 'NOMEFORNECEDOR', 'FORNECEDORNOME', 'FORN']);

    const result = { ...emptyResult };
    result.hasGrupo = !!grupoCol;
    result.hasSubgrupo = !!subgrupoCol;
    result.hasFornecedor = !!fornecedorCol;

    // Faz as 3 queries em paralelo, tolerando erro em cada uma.
    const tasks: Promise<void>[] = [];
    if (grupoCol) {
      tasks.push(
        this.pool
          .query<mysql.RowDataPacket[]>(
            `SELECT DISTINCT \`${grupoCol}\` AS v
               FROM produtos
              WHERE \`${grupoCol}\` IS NOT NULL AND \`${grupoCol}\` <> ''
              ORDER BY v
              LIMIT 500`,
          )
          .then(([rows]) => {
            result.grupos = (rows as any[]).map((r) => String(r.v).trim()).filter(Boolean);
          })
          .catch((e) => this.logger.warn(`facet grupo falhou: ${e?.message ?? e}`)),
      );
    }
    if (subgrupoCol) {
      tasks.push(
        this.pool
          .query<mysql.RowDataPacket[]>(
            `SELECT DISTINCT \`${subgrupoCol}\` AS v
               FROM produtos
              WHERE \`${subgrupoCol}\` IS NOT NULL AND \`${subgrupoCol}\` <> ''
              ORDER BY v
              LIMIT 500`,
          )
          .then(([rows]) => {
            result.subgrupos = (rows as any[]).map((r) => String(r.v).trim()).filter(Boolean);
          })
          .catch((e) => this.logger.warn(`facet subgrupo falhou: ${e?.message ?? e}`)),
      );
    }
    if (fornecedorCol) {
      tasks.push(
        this.pool
          .query<mysql.RowDataPacket[]>(
            `SELECT DISTINCT \`${fornecedorCol}\` AS v
               FROM produtos
              WHERE \`${fornecedorCol}\` IS NOT NULL AND \`${fornecedorCol}\` <> ''
              ORDER BY v
              LIMIT 500`,
          )
          .then(([rows]) => {
            result.fornecedores = (rows as any[]).map((r) => String(r.v).trim()).filter(Boolean);
          })
          .catch((e) => this.logger.warn(`facet fornecedor falhou: ${e?.message ?? e}`)),
      );
    }
    await Promise.all(tasks);
    return result;
  }

  /**
   * BUSCA PARA PUBLICAÇÃO — retorna referências agrupadas por REF+COR.
   *
   * Filtros (todos opcionais, combinam com AND):
   *   - refs:         lista de REFs exatas (fast-path, usa IN). Máx 200.
   *   - term:         busca LIKE em DESCRICAOCOMPLETA (múltiplas palavras = AND).
   *   - grupo/subgrupo/fornecedor: exatos. Só aplicam se a coluna existir.
   *   - diasCadastro: últimos N dias (usa DATACADASTRO/DATA_CADASTRO/DT_CADASTRO
   *                   se existir; caso contrário ignora).
   *
   * Formato de retorno: array de REFs, cada uma com array de cores, cada cor
   * com array de tamanhos (CODIGO+TAMANHO+ESTOQUE). Tudo que o frontend precisa
   * pra mostrar o card e deixar o CEO marcar as cores que quer subir.
   *
   * Limite: 200 REFs distintas por chamada (pra não travar a tela).
   */
  async searchRefsForPublish(filters: {
    refs?: string[];
    term?: string;
    grupo?: string;
    subgrupo?: string;
    fornecedor?: string;
    diasCadastro?: number;
    limit?: number;
  }): Promise<{
    refs: Array<{
      refCode: string;
      descricao: string;
      grupo: string | null;
      subgrupo: string | null;
      fornecedor: string | null;
      ncm: string | null;
      cfop: string | null;
      custo: number | null;
      preco: number | null;
      cores: Array<{
        cor: string;
        tamanhos: Array<{
          tamanho: string | null;
          codigo: string;
          estoque: number;
          ean: string | null;
        }>;
        estoqueTotal: number;
      }>;
      totalVariations: number;
      estoqueTotal: number;
    }>;
    truncated: boolean;
    schema: {
      hasGrupo: boolean;
      hasSubgrupo: boolean;
      hasFornecedor: boolean;
      hasDataCadastro: boolean;
    };
  }> {
    const empty = {
      refs: [] as any[],
      truncated: false,
      schema: { hasGrupo: false, hasSubgrupo: false, hasFornecedor: false, hasDataCadastro: false },
    };
    if (!this.pool) return empty as any;

    // Descobre colunas reais
    const cols = await this.getProductsColumns();
    const grupoCol = (await this.pickCol(['GRUPO', 'GRUPODESC', 'GRUPO_DESC', 'NOMEGRUPO'])) as string | null;
    const subgrupoCol = (await this.pickCol(['SUBGRUPO', 'SUB_GRUPO', 'SUBGRUPODESC', 'NOMESUBGRUPO'])) as string | null;
    const fornecedorCol = (await this.pickCol(['FORNECEDOR', 'NOMEFORNECEDOR', 'FORNECEDORNOME', 'FORN'])) as string | null;
    const ncmCol = (await this.pickCol(['NCM', 'CODNCM', 'CODIGONCM', 'COD_NCM'])) as string | null;
    const cfopCol = (await this.pickCol(['CFOP', 'CODCFOP'])) as string | null;
    const custoCol = (await this.pickCol(['CUSTOUN', 'CUSTO', 'CUSTO_UN', 'CUSTOMEDIO', 'CUSTO_MEDIO'])) as string | null;
    const precoCol = (await this.pickCol(['VENDAUN', 'PRECO', 'PRECOVENDA', 'PRECO_VENDA'])) as string | null;
    const dataCol = (await this.pickCol(['DATACADASTRO', 'DATA_CADASTRO', 'DT_CADASTRO', 'DATACRIACAO', 'DT_CRIACAO', 'CREATED_AT'])) as string | null;
    const eanCol = (await this.pickCol(['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS'])) as string | null;

    // Monta SELECT dinâmico
    const selects = [
      'p.CODIGO AS codigo',
      'p.REF AS ref',
      'p.DESCRICAOCOMPLETA AS descricao',
      'p.COR AS cor',
      'p.TAMANHO AS tamanho',
      'p.ESTOQUE AS estoqueLinha',
    ];
    if (grupoCol) selects.push(`p.\`${grupoCol}\` AS grupo`);
    if (subgrupoCol) selects.push(`p.\`${subgrupoCol}\` AS subgrupo`);
    if (fornecedorCol) selects.push(`p.\`${fornecedorCol}\` AS fornecedor`);
    if (ncmCol) selects.push(`p.\`${ncmCol}\` AS ncm`);
    if (cfopCol) selects.push(`p.\`${cfopCol}\` AS cfop`);
    if (custoCol) selects.push(`p.\`${custoCol}\` AS custo`);
    if (precoCol) selects.push(`p.\`${precoCol}\` AS preco`);
    if (eanCol) selects.push(`p.\`${eanCol}\` AS ean`);
    if (dataCol) selects.push(`p.\`${dataCol}\` AS dataCadastro`);

    // WHERE
    const wheres: string[] = ["p.REF IS NOT NULL", "p.REF <> ''"];
    const params: any[] = [];

    if (filters.refs && filters.refs.length) {
      const clean = filters.refs
        .map((r) => String(r).trim())
        .filter((r) => r.length > 0)
        .slice(0, 200);
      if (clean.length) {
        // Wincred às vezes cadastra cada cor como uma REF separada com sufixo
        // de espaço + letras (ex: "VMS-223" vira "VMS-223 P", "VMS-223 A",
        // "VMS-223 V", "VMS-223 N"). Pra o CEO não precisar conhecer esse
        // detalhe de cadastro, a busca por "VMS-223" precisa pegar também
        // "VMS-223 X". Mesma lógica já usada em products.service (task #107).
        const orParts: string[] = [];
        for (const r of clean) {
          orParts.push('p.REF = ?');
          params.push(r);
          orParts.push('p.REF LIKE ?');
          params.push(`${r} %`); // espaço + qualquer sufixo de cor
        }
        wheres.push(`(${orParts.join(' OR ')})`);
      }
    }
    if (filters.term) {
      const words = String(filters.term)
        .trim()
        .split(/\s+/)
        .filter((w) => w.length >= 2);
      for (const w of words) {
        wheres.push('p.DESCRICAOCOMPLETA LIKE ?');
        params.push(`%${w}%`);
      }
    }
    if (filters.grupo && grupoCol) {
      wheres.push(`p.\`${grupoCol}\` = ?`);
      params.push(filters.grupo);
    }
    if (filters.subgrupo && subgrupoCol) {
      wheres.push(`p.\`${subgrupoCol}\` = ?`);
      params.push(filters.subgrupo);
    }
    if (filters.fornecedor && fornecedorCol) {
      wheres.push(`p.\`${fornecedorCol}\` = ?`);
      params.push(filters.fornecedor);
    }
    if (filters.diasCadastro && dataCol) {
      const n = Math.max(1, Math.min(3650, Number(filters.diasCadastro) || 30));
      wheres.push(`p.\`${dataCol}\` >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`);
      params.push(n);
    }

    const limitRefs = Math.max(1, Math.min(500, Number(filters.limit) || 200));
    // Primeiro descobre quais REFs batem (pra limitar); depois busca TODAS
    // as linhas dessas REFs (pra mostrar as cores/tamanhos completos).
    // IMPORTANTE: usamos limite inflado (x5) pra compensar sub-REFs — o limit
    // final vira pelo nº de REFs BASE únicas após normalização.
    const sqlRefs = `
      SELECT DISTINCT p.REF AS ref
        FROM produtos p
       WHERE ${wheres.join(' AND ')}
       ORDER BY p.REF
       LIMIT ${limitRefs * 5 + 1}
    `;

    let refList: string[] = [];
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sqlRefs, params);
      refList = (rows as any[]).map((r) => String(r.ref).trim()).filter(Boolean);
    } catch (e) {
      this.logger.error(`searchRefsForPublish (refs step) falhou: ${(e as Error).message}`);
      return empty as any;
    }
    if (!refList.length) {
      return {
        refs: [],
        truncated: false,
        schema: {
          hasGrupo: !!grupoCol,
          hasSubgrupo: !!subgrupoCol,
          hasFornecedor: !!fornecedorCol,
          hasDataCadastro: !!dataCol,
        },
      };
    }
    // Deduplica pela REF base pra contar corretamente quantos produtos únicos
    // existem. Mantém TODOS os sub-REFs na refList (passados pro IN), mas o
    // truncate fica baseado no nº de bases únicas.
    const uniqBaseRefs = new Set<string>();
    for (const r of refList) {
      const base = r.replace(/\s[A-Za-z]{1,3}$/, '').trim() || r;
      uniqBaseRefs.add(base);
    }
    const truncated = uniqBaseRefs.size > limitRefs;

    // Agora busca TODAS as linhas dessas REFs pra montar cor/tamanho.
    const sqlDetails = `
      SELECT ${selects.join(', ')}
        FROM produtos p
       WHERE p.REF IN (?)
       ORDER BY p.REF, p.COR, p.TAMANHO
    `;
    let detailRows: any[] = [];
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sqlDetails, [refList]);
      detailRows = rows as any[];
    } catch (e) {
      this.logger.error(`searchRefsForPublish (details) falhou: ${(e as Error).message}`);
      return empty as any;
    }

    // Normaliza REF pra base — Wincred cadastra cada cor como sub-REF com
    // sufixo (ex: "VMS-223 P", "VMS-223 A"). O CEO pensa "VMS-223" e espera
    // ver todas as 4 cores embaixo dessa referência única. Mesma regex usada
    // em products.service (task #107) pra manter consistência.
    const normalizeBaseRef = (ref: string): string => {
      const s = String(ref).trim();
      return s.replace(/\s[A-Za-z]{1,3}$/, '').trim() || s;
    };

    // Agrupa por REF BASE → COR → tamanhos.
    const byRef = new Map<string, any>();
    for (const r of detailRows) {
      const rawRef = String(r.ref).trim();
      if (!rawRef) continue;
      const refCode = normalizeBaseRef(rawRef);
      let refEntry = byRef.get(refCode);
      if (!refEntry) {
        refEntry = {
          refCode,
          descricao: String(r.descricao ?? '').trim(),
          grupo: r.grupo != null ? String(r.grupo).trim() : null,
          subgrupo: r.subgrupo != null ? String(r.subgrupo).trim() : null,
          fornecedor: r.fornecedor != null ? String(r.fornecedor).trim() : null,
          ncm: r.ncm != null ? String(r.ncm).trim() : null,
          cfop: r.cfop != null ? String(r.cfop).trim() : null,
          custo: r.custo != null ? Number(r.custo) : null,
          preco: r.preco != null ? Number(r.preco) : null,
          coresMap: new Map<string, any>(),
          totalVariations: 0,
          estoqueTotal: 0,
        };
        byRef.set(refCode, refEntry);
      }
      const corKey = (r.cor == null ? '' : String(r.cor).trim()).toUpperCase() || 'SEM_COR';
      let corEntry = refEntry.coresMap.get(corKey);
      if (!corEntry) {
        corEntry = {
          cor: r.cor != null ? String(r.cor).trim() : '',
          tamanhos: [] as any[],
          estoqueTotal: 0,
        };
        refEntry.coresMap.set(corKey, corEntry);
      }
      const est = Number(r.estoqueLinha) || 0;
      corEntry.tamanhos.push({
        tamanho: r.tamanho != null ? String(r.tamanho).trim() : null,
        codigo: String(r.codigo).trim(),
        estoque: est,
        ean: r.ean != null ? String(r.ean).trim() : null,
      });
      corEntry.estoqueTotal += est;
      refEntry.totalVariations += 1;
      refEntry.estoqueTotal += est;
    }

    // Transforma Map → Array
    const refs = Array.from(byRef.values()).map((r: any) => ({
      refCode: r.refCode as string,
      descricao: r.descricao as string,
      grupo: (r.grupo ?? null) as string | null,
      subgrupo: (r.subgrupo ?? null) as string | null,
      fornecedor: (r.fornecedor ?? null) as string | null,
      ncm: (r.ncm ?? null) as string | null,
      cfop: (r.cfop ?? null) as string | null,
      custo: (r.custo ?? null) as number | null,
      preco: (r.preco ?? null) as number | null,
      cores: (Array.from(r.coresMap.values()) as any[]).map((c: any) => ({
        cor: c.cor as string,
        tamanhos: c.tamanhos as Array<{ tamanho: string | null; codigo: string; estoque: number; ean: string | null }>,
        estoqueTotal: c.estoqueTotal as number,
      })),
      totalVariations: r.totalVariations as number,
      estoqueTotal: r.estoqueTotal as number,
    }));

    return {
      refs,
      truncated,
      schema: {
        hasGrupo: !!grupoCol,
        hasSubgrupo: !!subgrupoCol,
        hasFornecedor: !!fornecedorCol,
        hasDataCadastro: !!dataCol,
      },
    };
  }

  /**
   * Retorna os dados crus de UMA REF+COR (todos os tamanhos) — usado no
   * momento de enfileirar pra congelar o snapshot no banco local.
   */
  async getRefColorForQueue(refCode: string, cor: string): Promise<{
    descricao: string;
    grupo: string | null;
    subgrupo: string | null;
    fornecedor: string | null;
    ncm: string | null;
    cfop: string | null;
    custo: number | null;
    preco: number | null;
    tamanhos: Array<{ tamanho: string | null; codigo: string; estoque: number; ean: string | null }>;
  } | null> {
    // Normaliza caso o caller mande sub-REF ("VMS-223 P") — a busca expande
    // sozinha, mas o matching na Map é sempre pela base.
    const baseRef = String(refCode).trim().replace(/\s[A-Za-z]{1,3}$/, '').trim() || String(refCode).trim();
    const res = await this.searchRefsForPublish({ refs: [baseRef] });
    const ref = res.refs.find((r) => r.refCode === baseRef);
    if (!ref) return null;
    const corUpper = String(cor).trim().toUpperCase();
    const corEntry =
      ref.cores.find((c) => String(c.cor).trim().toUpperCase() === corUpper) ??
      (corUpper === 'SEM_COR' ? ref.cores.find((c) => !c.cor) : undefined);
    if (!corEntry) return null;
    return {
      descricao: ref.descricao,
      grupo: ref.grupo,
      subgrupo: ref.subgrupo,
      fornecedor: ref.fornecedor,
      ncm: ref.ncm,
      cfop: ref.cfop,
      custo: ref.custo,
      preco: ref.preco,
      tamanhos: corEntry.tamanhos,
    };
  }
}
