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

  // ═══════════════════════════════════════════════════════════════════════
  // HELPERS DE NORMALIZAÇÃO DE SKU
  //
  // O Giga armazena CODIGO com zeros à esquerda (ex: "0005383498"). Outros
  // sistemas (WC, scanner, frontend) enviam sem padding (ex: "5383498").
  // Esses helpers expandem variantes pra que queries casem em qualquer formato.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Gera todas as variantes de um SKU (com padding zero de 3 a 14 dígitos
   * + versão sem zeros à esquerda + original).
   */
  private skuVariants(sku: string): string[] {
    const trimmed = String(sku || '').trim();
    if (!trimmed) return [];
    const out = new Set<string>([trimmed]);
    const stripped = trimmed.replace(/^0+/, '');
    if (stripped) out.add(stripped);
    if (/^\d+$/.test(trimmed)) {
      for (let len = 3; len <= 14; len++) {
        if (trimmed.length < len) out.add(trimmed.padStart(len, '0'));
      }
    }
    return Array.from(out);
  }

  /**
   * Pra uma lista de SKUs, gera o set de variantes + um mapa
   * variante→original (pra mapear retorno do Giga de volta pro
   * formato que o caller passou).
   */
  private expandSkus(skus: string[]): {
    allVariants: string[];
    variantToOriginal: Map<string, string>;
  } {
    const variantToOriginal = new Map<string, string>();
    const allVariants = new Set<string>();
    for (const original of skus) {
      const orig = String(original || '').trim();
      if (!orig) continue;
      for (const v of this.skuVariants(orig)) {
        allVariants.add(v);
        if (!variantToOriginal.has(v)) variantToOriginal.set(v, orig);
      }
    }
    return { allVariants: Array.from(allVariants), variantToOriginal };
  }

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
      // 15s pra conectar — Giga roda atrás do NAT da loja, latência varia MUITO.
      // 5s era curto e causava ETIMEDOUT em pico de uso / rede instável.
      connectTimeout: 15000,
      // Keep-alive evita que o NAT derrube conexão ociosa do pool.
      enableKeepAlive: true,
      keepAliveInitialDelay: 30000,
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
   * Retorna true se o env var PDV_ERP_WRITE_ENABLED='true'. Controla a
   * gravação de vendas do PDV flowops na tabela `caixa` do Wincred.
   * Independente de ERP_WRITE_ENABLED (decreaseStock) — pode-se baixar
   * estoque sem gravar venda, ou vice-versa.
   */
  get isPdvWriteEnabled(): boolean {
    const v = String(this.config.get('PDV_ERP_WRITE_ENABLED') ?? '').trim().toLowerCase();
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
    opts?: { allowNegative?: boolean; skipNotFound?: boolean },
  ): Promise<{
    success: boolean;
    applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }>;
    error?: string;
    attempts?: number;
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

    // RETRY em erros transientes (timeout de rede/conexão). Até 3 tentativas
    // com backoff 0 / 1s / 3s. Erros de regra de negócio (estoque insuficiente,
    // SKU não encontrado, etc.) NÃO são retry — falha na hora.
    const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ER_LOCK_WAIT_TIMEOUT']);
    const TRANSIENT_MSG_PATTERNS = [/read ETIMEDOUT/i, /connect ETIMEDOUT/i, /Connection lost/i, /closed state/i];
    const isTransient = (err: any): boolean => {
      const code = String(err?.code ?? '').toUpperCase();
      if (TRANSIENT_CODES.has(code)) return true;
      const msg = String(err?.message ?? err ?? '');
      return TRANSIENT_MSG_PATTERNS.some((rx) => rx.test(msg));
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const BACKOFF_MS = [0, 1000, 3000];

    let lastError: any = null;
    for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt++) {
      if (BACKOFF_MS[attempt - 1] > 0) await sleep(BACKOFF_MS[attempt - 1]);
      const result = await this.decreaseStockOnce(items, opts);
      if (result.success) {
        return { ...result, attempts: attempt };
      }
      lastError = result.error;
      // Só faz retry se for transiente. Erro de regra de negócio → sai na hora.
      if (!isTransient({ message: lastError })) {
        return { ...result, attempts: attempt };
      }
      this.logger.warn(`ERP baixa tentativa ${attempt}/${BACKOFF_MS.length} falhou (transient): ${lastError}`);
    }
    return { success: false, applied: [], error: `${lastError} (${BACKOFF_MS.length} tentativas)`, attempts: BACKOFF_MS.length };
  }

  /**
   * Execução ÚNICA da baixa (sem retry) — extraída pra poder ser chamada N vezes
   * pelo wrapper de retry acima. Toda a lógica ACID fica aqui.
   *
   * opts.allowNegative: se true, deixa o estoque ficar negativo em vez de
   * abortar a transação. Usado em realinhamento/triagem onde a peça já
   * está fisicamente em mãos (ignoramos divergência com Giga).
   */
  private async decreaseStockOnce(
    items: Array<{ sku: string; qty: number; storeCode: string }>,
    opts?: { allowNegative?: boolean; skipNotFound?: boolean },
  ): Promise<{
    success: boolean;
    applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }>;
    error?: string;
  }> {
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
        const skuOriginal = String(it.sku || '').trim();
        const storeCode = normalizeStoreCode(it.storeCode);
        const qty = Math.max(1, Number(it.qty) || 1);

        if (!skuOriginal || !storeCode) {
          throw new Error(`Item inválido: sku='${skuOriginal}' storeCode='${storeCode}'`);
        }

        // Tolerância a zeros à esquerda: se o sistema pediu baixa de "5383498"
        // mas no Giga está "0005383498", precisamos achar o CODIGO real antes
        // de dar UPDATE — caso contrário a baixa some silenciosa.
        const variants = this.skuVariants(skuOriginal);

        // SELECT FOR UPDATE — trava a linha durante a transação pra evitar
        // que outra conexão (ex: PDV do Giga) leia valor desatualizado.
        // Tras o CODIGO real do Giga pra usar no UPDATE.
        const [beforeRows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, ESTOQUE FROM estoque
            WHERE CODIGO IN (?) AND LOJA = ?
            ORDER BY ESTOQUE DESC
            LIMIT 1 FOR UPDATE`,
          [variants, storeCode],
        );

        if (!beforeRows.length) {
          if (opts?.skipNotFound) {
            this.logger.warn(
              `Item sem registro em estoque — PULADO (skipNotFound): SKU=${skuOriginal} LOJA=${storeCode} qty=${qty}`,
            );
            continue; // Pula esse item, segue pro próximo
          }
          throw new Error(`Registro não encontrado em estoque: SKU=${skuOriginal} LOJA=${storeCode}`);
        }

        const codigoGiga = String(beforeRows[0].CODIGO).trim();
        const previousStock = Number(beforeRows[0].ESTOQUE) || 0;
        const newStock = previousStock - qty;

        // BLOQUEIO DURO: não deixar estoque negativo. Se acontecer, abortar a
        // transação inteira — operadora vê o erro e investiga (provavelmente
        // divergência com o físico).
        //
        // EXCEÇÃO: opts.allowNegative=true (usado em realinhamento/triagem),
        // a peça já está em mãos fisicamente, então deixamos o Giga ficar
        // negativo. Logamos warning pra ficar rastro.
        if (newStock < 0) {
          if (opts?.allowNegative) {
            this.logger.warn(
              `Estoque negativo aceito (allowNegative): SKU=${skuOriginal} (giga=${codigoGiga}) LOJA=${storeCode} tem ${previousStock}, pediu ${qty} → newStock=${newStock}`,
            );
          } else {
            throw new Error(
              `Estoque insuficiente: SKU=${skuOriginal} (giga=${codigoGiga}) LOJA=${storeCode} tem ${previousStock}, pediu ${qty}`,
            );
          }
        }

        const [result]: any = await conn.query(
          `UPDATE estoque SET ESTOQUE = ? WHERE CODIGO = ? AND LOJA = ?`,
          [newStock, codigoGiga, storeCode],
        );

        if (!result || result.affectedRows !== 1) {
          throw new Error(
            `UPDATE não afetou linha esperada: SKU=${codigoGiga} LOJA=${storeCode} affected=${result?.affectedRows ?? 0}`,
          );
        }

        // Mantém o sku ORIGINAL no log pra rastreabilidade (caller passou).
        applied.push({ sku: skuOriginal, storeCode, qty, previousStock, newStock });
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
   * INCREASE estoque no Gigasistemas — usado pela loja DESTINO ao "Dar Entrada"
   * em uma remessa de realinhamento recebida.
   *
   * Espelho exato de `decreaseStock`:
   *  - Mesmo kill-switch ERP_WRITE_ENABLED
   *  - Mesma transação ACID com rollback
   *  - Mesmo retry/backoff em erro transiente
   *  - SELECT FOR UPDATE → soma → UPDATE
   *
   * Diferenças do decrease:
   *  - SOMA em vez de subtrair
   *  - Não tem checagem de "estoque negativo" (sempre é seguro aumentar)
   *  - Se SKU não existir na tabela `estoque` da loja destino, o registro é
   *    INSERIDO (peça que nunca passou por essa loja antes — comum em
   *    realinhamento. Só o INSERT, sem mexer em produtos.)
   */
  async increaseStock(
    items: Array<{ sku: string; qty: number; storeCode: string }>,
  ): Promise<{
    success: boolean;
    applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }>;
    error?: string;
    attempts?: number;
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

    const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ER_LOCK_WAIT_TIMEOUT']);
    const TRANSIENT_MSG_PATTERNS = [/read ETIMEDOUT/i, /connect ETIMEDOUT/i, /Connection lost/i, /closed state/i];
    const isTransient = (err: any): boolean => {
      const code = String(err?.code ?? '').toUpperCase();
      if (TRANSIENT_CODES.has(code)) return true;
      const msg = String(err?.message ?? err ?? '');
      return TRANSIENT_MSG_PATTERNS.some((rx) => rx.test(msg));
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const BACKOFF_MS = [0, 1000, 3000];

    let lastError: any = null;
    for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt++) {
      if (BACKOFF_MS[attempt - 1] > 0) await sleep(BACKOFF_MS[attempt - 1]);
      const result = await this.increaseStockOnce(items);
      if (result.success) {
        return { ...result, attempts: attempt };
      }
      lastError = result.error;
      if (!isTransient({ message: lastError })) {
        return { ...result, attempts: attempt };
      }
      this.logger.warn(`ERP entrada tentativa ${attempt}/${BACKOFF_MS.length} falhou (transient): ${lastError}`);
    }
    return { success: false, applied: [], error: `${lastError} (${BACKOFF_MS.length} tentativas)`, attempts: BACKOFF_MS.length };
  }

  /** Execução única do INCREASE — extraída pra retry. */
  private async increaseStockOnce(
    items: Array<{ sku: string; qty: number; storeCode: string }>,
  ): Promise<{
    success: boolean;
    applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }>;
    error?: string;
  }> {
    const normalizeStoreCode = (raw: string): string => {
      const s = String(raw || '').trim().toUpperCase().replace(/^LJ/i, '');
      const n = parseInt(s, 10);
      if (Number.isNaN(n) || n < 1 || n > 99) return s;
      return String(n).padStart(2, '0');
    };

    const conn = await this.pool.getConnection();
    const applied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }> = [];

    try {
      await conn.beginTransaction();

      for (const it of items) {
        const skuOriginal = String(it.sku || '').trim();
        const qty = Number(it.qty);
        const storeCode = normalizeStoreCode(it.storeCode);

        if (!skuOriginal || !storeCode || !qty || qty <= 0) {
          throw new Error(`Item inválido: sku=${skuOriginal} loja=${storeCode} qty=${qty}`);
        }

        // Tolerância a zeros à esquerda: tenta achar o CODIGO real do Giga
        // (pode estar como "0005383498" mesmo recebendo "5383498").
        const variants = this.skuVariants(skuOriginal);

        // SELECT FOR UPDATE — trava a linha (se houver)
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, ESTOQUE FROM estoque
            WHERE CODIGO IN (?) AND LOJA = ?
            ORDER BY ESTOQUE DESC
            LIMIT 1 FOR UPDATE`,
          [variants, storeCode],
        );

        let previousStock = 0;
        let newStock = qty;
        let codigoGiga = skuOriginal;

        if (!rows.length) {
          // Nenhuma variante existe pra essa loja — INSERT novo.
          // Pra manter consistência com o cadastro, tenta usar o CODIGO
          // do `produtos` (que pode ter padding diferente do que veio).
          let codigoCadastro = skuOriginal;
          try {
            const [prodRows] = await conn.query<mysql.RowDataPacket[]>(
              `SELECT CODIGO FROM produtos WHERE CODIGO IN (?) LIMIT 1`,
              [variants],
            );
            if ((prodRows as any[]).length) {
              codigoCadastro = String((prodRows as any[])[0].CODIGO).trim();
            }
          } catch { /* ignore — usa skuOriginal */ }

          await conn.query(
            `INSERT INTO estoque (CODIGO, LOJA, ESTOQUE) VALUES (?, ?, ?)`,
            [codigoCadastro, storeCode, qty],
          );
          codigoGiga = codigoCadastro;
          previousStock = 0;
          newStock = qty;
        } else {
          codigoGiga = String(rows[0].CODIGO).trim();
          previousStock = Number(rows[0].ESTOQUE);
          newStock = previousStock + qty;
          const [result] = await conn.query<mysql.ResultSetHeader>(
            `UPDATE estoque SET ESTOQUE = ? WHERE CODIGO = ? AND LOJA = ?`,
            [newStock, codigoGiga, storeCode],
          );
          if (!result || result.affectedRows !== 1) {
            throw new Error(
              `UPDATE não afetou linha esperada: SKU=${codigoGiga} LOJA=${storeCode} affected=${result?.affectedRows ?? 0}`,
            );
          }
        }

        // Mantém o sku ORIGINAL no log pra rastreabilidade (caller passou).
        applied.push({ sku: skuOriginal, storeCode, qty, previousStock, newStock });
      }

      await conn.commit();
      this.logger.log(
        `ERP entrada OK: ${applied.length} item(ns) entrada(s). ` +
          applied.map((a) => `${a.sku}/${a.storeCode}: ${a.previousStock}→${a.newStock}`).join(', '),
      );
      return { success: true, applied };
    } catch (e: any) {
      try { await conn.rollback(); } catch { /* ignore */ }
      const msg = String(e?.message || e);
      this.logger.error(`ERP entrada FALHOU (rollback): ${msg}`);
      return { success: false, applied: [], error: msg };
    } finally {
      conn.release();
    }
  }

  /**
   * CREATE INDEX em uma tabela do Giga (DDL admin).
   * Usado pra criar índice composto que acelera lookup de parcelas em aberto.
   *
   * Idempotente: verifica via SHOW INDEX antes — se já existe, retorna ok.
   * Em MySQL 5.6+ o CREATE INDEX é ONLINE (não bloqueia escrita).
   * Timeout estendido pra 10min (operação lenta em tabelas grandes).
   */
  async createIndexIfNotExists(input: {
    table: string;
    indexName: string;
    columns: string[];
  }): Promise<{
    ok: boolean;
    alreadyExists?: boolean;
    durationMs?: number;
    error?: string;
    table: string;
    indexName: string;
    columns: string[];
  }> {
    if (!this.isWriteEnabled) {
      return {
        ok: false,
        error: 'ERP_WRITE_ENABLED precisa estar ligado',
        table: input.table,
        indexName: input.indexName,
        columns: input.columns,
      };
    }
    if (!this.pool) {
      return {
        ok: false,
        error: 'Pool ERP não inicializado',
        table: input.table,
        indexName: input.indexName,
        columns: input.columns,
      };
    }

    // Sanitiza nomes (apenas letras/números/_ permitidos pra evitar injection)
    const safeRx = /^[a-zA-Z0-9_]+$/;
    if (!safeRx.test(input.table) || !safeRx.test(input.indexName)) {
      return {
        ok: false,
        error: 'Nome de tabela/índice inválido',
        table: input.table,
        indexName: input.indexName,
        columns: input.columns,
      };
    }
    for (const c of input.columns) {
      if (!safeRx.test(c)) {
        return {
          ok: false,
          error: `Nome de coluna inválido: ${c}`,
          table: input.table,
          indexName: input.indexName,
          columns: input.columns,
        };
      }
    }

    const conn = await this.pool.getConnection();
    try {
      // 1. Verifica se já existe
      const checkSql = `SHOW INDEX FROM \`${input.table}\` WHERE Key_name = ?`;
      const [rows]: any = await conn.execute(checkSql, [input.indexName]);
      if (rows && rows.length > 0) {
        this.logger.log(
          `[createIndex] ${input.table}.${input.indexName} JÁ EXISTE (${rows.length} colunas)`,
        );
        return {
          ok: true,
          alreadyExists: true,
          table: input.table,
          indexName: input.indexName,
          columns: input.columns,
        };
      }

      // 2. Cria
      const colList = input.columns.map((c) => `\`${c}\``).join(', ');
      const createSql = `CREATE INDEX \`${input.indexName}\` ON \`${input.table}\` (${colList})`;
      this.logger.log(`[createIndex] Executando: ${createSql}`);
      const t0 = Date.now();
      await conn.execute(createSql);
      const durationMs = Date.now() - t0;
      this.logger.log(
        `[createIndex] ${input.table}.${input.indexName} CRIADO em ${durationMs}ms`,
      );
      return {
        ok: true,
        alreadyExists: false,
        durationMs,
        table: input.table,
        indexName: input.indexName,
        columns: input.columns,
      };
    } catch (e: any) {
      const msg = String(e?.message || e);
      this.logger.error(`[createIndex] FALHOU: ${msg}`);
      return {
        ok: false,
        error: msg,
        table: input.table,
        indexName: input.indexName,
        columns: input.columns,
      };
    } finally {
      conn.release();
    }
  }

  /**
   * CRIA PARCELAS DE CREDIÁRIO no Giga — INSERT direto na tabela `movimento`.
   *
   * Pega o último REGISTRO existente, incrementa pra cada nova parcela.
   * CONTROLE compartilhado entre as parcelas da mesma compra (= número de
   * compra). Cria N linhas com vencimentos mensais a partir do primeiro.
   *
   * Padrão Wincred:
   *   - REGISTRO  = sequencial único por linha
   *   - CONTROLE  = mesmo pra todas as parcelas da compra (numero da compra)
   *   - PARCELA   = 1, 2, 3, ..., N
   *   - VENCIMENTO = primeiro + (parcela − 1) × 30 dias (calendário mensal)
   *   - VALORPARCELA = ajustado pra fechar exato (última absorve diferença)
   *   - PAGO       = 'N'
   *
   * Retorna { success, registroInicial, controleUsado, parcelas[] } ou erro.
   */
  async createCrediarioParcelas(input: {
    codCliente: string;
    nomeCliente: string;
    valorTotal: number;          // valor financiado (já descontada entrada)
    parcelas: number;             // qtd N
    primeiroVencimento: Date;
    dataCompra: Date;
    loja: string;                 // código da loja onde foi feita a venda
    observacao?: string;
    columns: {
      registro: string | null;
      controle: string | null;
      numeroCompra: string | null;
      loja: string | null;
      codCliente: string | null;
      nome: string | null;
      dataCompra: string | null;
      valorCompra: string | null;
      parcela: string | null;
      totalParcelas: string | null;
      vencimento: string | null;
      valorParcela: string | null;
      pago: string | null;
      obs: string | null;
    };
  }): Promise<{
    success: boolean;
    error?: string;
    registroInicial?: number;
    controleUsado?: number;
    parcelas?: Array<{ parcela: number; vencimento: string; valor: number; registro: number }>;
  }> {
    if (!this.isWriteEnabled) {
      return { success: false, error: 'ERP_WRITE_ENABLED não habilitado' };
    }
    if (!this.pool) return { success: false, error: 'Pool ERP não inicializado' };

    const c = input.columns;
    if (!c.registro || !c.controle || !c.codCliente || !c.vencimento || !c.valorParcela || !c.parcela) {
      return {
        success: false,
        error: 'Colunas obrigatórias não detectadas (registro/controle/codCliente/vencimento/valorParcela/parcela)',
      };
    }
    if (input.parcelas < 1 || input.parcelas > 24) {
      return { success: false, error: 'Parcelas deve estar entre 1 e 24' };
    }
    if (input.valorTotal <= 0) {
      return { success: false, error: 'Valor total deve ser maior que zero' };
    }

    // Cálculo das parcelas: iguais com ajuste na última pra bater o total
    const valorIgual = Math.round((input.valorTotal / input.parcelas) * 100) / 100;
    const valorUltima = Math.round((input.valorTotal - valorIgual * (input.parcelas - 1)) * 100) / 100;

    const conn = await this.pool.getConnection();
    try {
      // Pega último REGISTRO + último CONTROLE pra incrementar
      const [maxRows]: any = await conn.execute(
        `SELECT COALESCE(MAX(\`${c.registro}\`), 0) AS maxReg, COALESCE(MAX(\`${c.controle}\`), 0) AS maxCtl FROM \`movimento\``,
      );
      const startRegistro = Number(maxRows[0]?.maxReg || 0) + 1;
      const novoControle = Number(maxRows[0]?.maxCtl || 0) + 1;

      const parcelasDetalhe: Array<{ parcela: number; vencimento: string; valor: number; registro: number }> = [];

      // Insere cada parcela
      for (let i = 0; i < input.parcelas; i++) {
        const numeroParcela = i + 1;
        const isUltima = numeroParcela === input.parcelas;
        const valor = isUltima ? valorUltima : valorIgual;
        const registro = startRegistro + i;

        // Vencimento: primeiro + N meses (preserva o dia)
        const venc = new Date(input.primeiroVencimento);
        venc.setMonth(venc.getMonth() + i);

        // Monta INSERT dinâmico (só inclui colunas detectadas)
        const fields: string[] = [];
        const placeholders: string[] = [];
        const values: any[] = [];

        const add = (col: string | null, val: any) => {
          if (col == null) return;
          fields.push(`\`${col}\``);
          placeholders.push('?');
          values.push(val);
        };

        add(c.registro, registro);
        add(c.controle, novoControle);
        if (c.numeroCompra) add(c.numeroCompra, novoControle); // numeroCompra = controle (mesma sequência)
        add(c.codCliente, input.codCliente);
        if (c.nome) add(c.nome, input.nomeCliente);
        if (c.loja) add(c.loja, input.loja);
        if (c.dataCompra) add(c.dataCompra, input.dataCompra);
        if (c.valorCompra) add(c.valorCompra, input.valorTotal);
        add(c.parcela, numeroParcela);
        if (c.totalParcelas) add(c.totalParcelas, input.parcelas);
        add(c.vencimento, venc);
        add(c.valorParcela, valor);
        if (c.pago) add(c.pago, 'N');
        if (c.obs && input.observacao) add(c.obs, input.observacao.slice(0, 200));

        const sql = `INSERT INTO \`movimento\` (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`;
        await conn.execute(sql, values);

        parcelasDetalhe.push({
          parcela: numeroParcela,
          vencimento: venc.toISOString().slice(0, 10),
          valor,
          registro,
        });
      }

      this.logger.log(
        `[crediario] Criou ${input.parcelas} parcelas no Giga: cliente=${input.codCliente} controle=${novoControle} total=R$${input.valorTotal.toFixed(2)}`,
      );

      return {
        success: true,
        registroInicial: startRegistro,
        controleUsado: novoControle,
        parcelas: parcelasDetalhe,
      };
    } catch (e: any) {
      const msg = String(e?.message || e);
      this.logger.error(`[crediario] INSERT em movimento FALHOU: ${msg}`);
      return { success: false, error: msg };
    } finally {
      conn.release();
    }
  }

  /**
   * BAIXA PARCELA DE CREDIÁRIO — UPDATE direto na tabela `movimento` do Giga.
   *
   * Marca a parcela como paga (PAGO='S' + DATA_PAGAMENTO=hoje + VALOR_PAGO=valorRecebido).
   * Os nomes reais das colunas variam por instalação — recebemos via parâmetro
   * (CrediariosService já detectou via `detectColumns`).
   *
   * Identificação da parcela: chave composta (REGISTRO + CONTROLE).
   *
   * Retorna { success, error? } — sem retry, sem transação multi-row,
   * pra simplicidade. A baixa local (Postgres) é a fonte da verdade pro
   * recibo; este UPDATE é "espelho" pro Giga.
   */
  /**
   * INSERT múltiplas linhas em `caixa` com MARCADO='SIM'.
   * Usado pelo sistema MARCADOS quando vendedora cria marcado pelo PDV.
   *
   * Cada item vira 1 linha em `caixa`. Todas compartilham o mesmo CONTROLE
   * (gerado pegando MAX(CONTROLE)+1) — assim agrupa o marcado pra o cliente
   * conseguir ver junto na consulta.
   *
   * Retorna { success, controle, error? } — caller pode logar o controle
   * e mostrar pra vendedora como comprovante.
   */
  async insertCaixaMarcado(input: {
    items: Array<{
      codigo: string;
      descricao: string;
      quantidade: number;
      valor: number;
      valorTotal: number;
      vendedor?: number;
      operador?: number;
    }>;
    cliente: number;
    loja: string;
  }): Promise<{ success: boolean; controle?: number; error?: string }> {
    if (!this.isWriteEnabled) {
      return { success: false, error: 'ERP_WRITE_ENABLED não habilitado' };
    }
    if (!this.pool) {
      return { success: false, error: 'Pool ERP não inicializado' };
    }
    if (!input.items?.length) {
      return { success: false, error: 'Sem items pra marcar' };
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // Próximo CONTROLE — agrupa todos os items desse marcado
      const [maxRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT COALESCE(MAX(NUMERO), 0) + 1 AS proxNumero FROM caixa`,
      );
      const proxNumero = Number((maxRows[0] as any).proxNumero) || 1;

      const lojaCode = String(input.loja || '').trim().toUpperCase().replace(/^LJ/i, '').padStart(2, '0');
      const today = new Date();
      const dataStr = today.toISOString().slice(0, 10); // YYYY-MM-DD
      const horaStr = today.toTimeString().slice(0, 8); // HH:MM:SS

      // INSERT cada item
      for (const it of input.items) {
        await conn.query(
          `INSERT INTO caixa
            (NUMERO, CODIGO, DATA, CLIENTE, DESCRICAO, QUANTIDADE, VALOR, VALORTOTAL,
             OPERADOR, VENDEDOR, MARCADO, LOJA, HORA)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SIM', ?, ?)`,
          [
            proxNumero,
            it.codigo,
            dataStr,
            input.cliente,
            it.descricao,
            it.quantidade,
            it.valor,
            it.valorTotal,
            it.operador || 0,
            it.vendedor || 0,
            lojaCode,
            horaStr,
          ],
        );
      }

      await conn.commit();
      this.logger.log(
        `[caixa-marcado] INSERT OK: cliente=${input.cliente} ` +
        `controle=${proxNumero} items=${input.items.length} loja=${lojaCode}`,
      );
      return { success: true, controle: proxNumero };
    } catch (e: any) {
      try { await conn.rollback(); } catch { /* ignore */ }
      const msg = String(e?.message || e);
      this.logger.error(`[caixa-marcado] INSERT FALHOU: ${msg}`);
      return { success: false, error: msg };
    } finally {
      conn.release();
    }
  }

  async markCrediarioParcelaPaid(input: {
    registro: string | number;
    controle: string | number;
    valorPago: number;
    dataPagamento?: Date;
    /** Opcional: valor de juros calculado (vai pra coluna JUROS se detectada) */
    juros?: number;
    /** Opcional: valor de multa calculado (vai pra coluna MULTA se detectada) */
    multa?: number;
    columns: {
      registro: string | null;
      controle: string | null;
      pago: string | null;
      dataPagamento: string | null;
      valorPago: string | null;
      juros?: string | null;
      multa?: string | null;
    };
  }): Promise<{ success: boolean; error?: string; affectedRows?: number }> {
    if (!this.isWriteEnabled) {
      return { success: false, error: 'ERP_WRITE_ENABLED não habilitado' };
    }
    if (!this.pool) {
      return { success: false, error: 'Pool ERP não inicializado' };
    }
    const { columns } = input;
    if (!columns.registro || !columns.controle) {
      return { success: false, error: 'Colunas REGISTRO/CONTROLE não detectadas' };
    }

    // Monta SET dinamicamente — só inclui colunas que existem no Giga local.
    const sets: string[] = [];
    const params: any[] = [];

    // CRÍTICO: PAGO é o campo que o WinCred consulta pra exibir no relatório
    // de recebidos. Se ficar nulo, a baixa não aparece NA UI do WinCred mesmo
    // com data preenchida. Sempre tentamos atualizar — usa nome detectado se
    // existir, senão tenta literal "PAGO" como fallback (WinCred padrão).
    //
    // VALOR: Lurd's confirmou que WinCred grava "S" (não "SIM" como pensei).
    // O REAL problema era a coluna PAGAMENTO ficar em branco — corrigido em
    // detectColumns. Override por env var ERP_PAGO_VALOR_SIM se outra loja
    // precisar de outro valor.
    const pagoCol = columns.pago || 'PAGO';
    const pagoValor = String(this.config.get('ERP_PAGO_VALOR_SIM') ?? 'S').trim();
    sets.push(`\`${pagoCol}\` = ?`);
    params.push(pagoValor);
    if (!columns.pago) {
      this.logger.warn(
        `[crediario] coluna PAGO não detectada — usando fallback hardcoded "PAGO". ` +
        `Se a tabela tem outro nome, ajuste detectColumns() ou o UPDATE pode falhar.`,
      );
    }

    if (columns.dataPagamento) {
      sets.push(`\`${columns.dataPagamento}\` = ?`);
      params.push(input.dataPagamento || new Date());
    }
    if (columns.valorPago) {
      sets.push(`\`${columns.valorPago}\` = ?`);
      params.push(input.valorPago);
    }
    // Juros e multa: só atualiza se a coluna foi detectada E o valor foi passado.
    // Sem isso, na baixa retroativa o WinCred mostra "Juros: vazio".
    if (columns.juros && input.juros !== undefined) {
      sets.push(`\`${columns.juros}\` = ?`);
      params.push(Math.round(input.juros * 100) / 100);
    }
    if (columns.multa && input.multa !== undefined) {
      sets.push(`\`${columns.multa}\` = ?`);
      params.push(Math.round(input.multa * 100) / 100);
    }

    if (sets.length === 0) {
      return { success: false, error: 'Nenhuma coluna pra atualizar' };
    }

    // WHERE chave composta
    const sql = `UPDATE \`movimento\` SET ${sets.join(', ')} WHERE \`${columns.registro}\` = ? AND \`${columns.controle}\` = ? LIMIT 1`;
    params.push(input.registro, input.controle);

    const conn = await this.pool.getConnection();
    try {
      const [result]: any = await conn.execute(sql, params);
      const affected = result?.affectedRows ?? 0;
      if (affected === 0) {
        return {
          success: false,
          error: `UPDATE não afetou linha (REGISTRO=${input.registro} CONTROLE=${input.controle}). Já paga ou inexistente.`,
          affectedRows: 0,
        };
      }
      this.logger.log(
        `[crediario] baixa Giga OK: REGISTRO=${input.registro} CONTROLE=${input.controle} valor=R$${input.valorPago.toFixed(2)}`,
      );
      return { success: true, affectedRows: affected };
    } catch (e: any) {
      const msg = String(e?.message || e);
      this.logger.error(`[crediario] UPDATE movimento FALHOU: ${msg}`);
      return { success: false, error: msg };
    } finally {
      conn.release();
    }
  }

  /**
   * Consulta estoque por SKU × loja na tabela `estoque` do WinCred.
   * Retorna só registros com ESTOQUE > 0.
   *
   * TOLERANTE A ZEROS À ESQUERDA: o WooCommerce pode enviar SKU "5383498"
   * mas no Giga o CODIGO está cadastrado como "0005383498". Sem essa
   * tolerância, o roteamento não acha estoque e divide pedidos errado.
   *
   * Estratégia:
   *   1. Pra cada SKU recebido, gera variantes com padding 3-14 dígitos
   *   2. Consulta no Giga com a união de todas as variantes
   *   3. No retorno, mapeia o CODIGO do Giga DE VOLTA pro SKU original
   *      do caller (pra que o resto do sistema continue trabalhando com
   *      o formato que enviou)
   */
  async getStock(skus: string[], storeCodes: string[]): Promise<StockEntry[]> {
    if (!skus.length || !storeCodes.length || !this.pool) return [];

    // Normaliza SKUs originais (sem duplicatas, sem strings vazias)
    const uniqueOriginals = Array.from(
      new Set(skus.map((s) => String(s || '').trim()).filter(Boolean)),
    );
    if (!uniqueOriginals.length) return [];

    // PASSO 1 — Resolve CODIGO REAL de cada SKU consultando o cadastro `produtos`.
    //
    // Por que NÃO basta expandir e buscar direto em `estoque`:
    //   - SKU "5383498" pode existir no Giga como peça A (CODIGO="5383498")
    //     E peça B totalmente diferente (CODIGO="0005383498").
    //   - Se buscamos `WHERE CODIGO IN (variantes)` direto em estoque,
    //     misturamos peças e o roteamento envia pedido pra loja que tem
    //     o produto ERRADO. Bug observado em prod: pedido roteado pra Pira
    //     porque "5383498" sem zeros existe lá como outra peça.
    //
    // Solução: descobrir, no cadastro, qual CODIGO específico é o "5383498"
    // que o caller passou. Ele só pode ser UM (cadastro tem PK em CODIGO).
    // Aí buscamos estoque SÓ desse CODIGO real.

    const { allVariants, variantToOriginal } = this.expandSkus(uniqueOriginals);
    if (!allVariants.length) return [];

    // codigoGiga → sku original do caller
    const codigoGigaToOriginal = new Map<string, string>();
    try {
      const [prodRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO FROM produtos WHERE CODIGO IN (?)`,
        [allVariants],
      );
      for (const r of prodRows as any[]) {
        const codigoGiga = String(r.CODIGO).trim();
        const originalSku = variantToOriginal.get(codigoGiga);
        if (!originalSku) continue;
        // Se 2+ variantes do mesmo SKU original existem como produtos diferentes
        // (caso patológico), prioriza a versão MAIS LONGA (com mais zeros à
        // esquerda), que é o padrão real do Giga (CODIGO sempre tem padding).
        const existing = codigoGigaToOriginal.get(originalSku);
        if (!existing) {
          // Primeira ocorrência: mapeia 1:1 (sku original → codigoGiga)
          codigoGigaToOriginal.set(codigoGiga, originalSku);
        } else {
          // Já tem um codigoGiga mapeado pra esse original.
          // Decisão: se o NOVO codigoGiga é mais longo (mais padding),
          // troca; senão mantém o anterior.
          const previous = Array.from(codigoGigaToOriginal.entries()).find(
            ([, orig]) => orig === originalSku,
          )?.[0];
          if (previous && codigoGiga.length > previous.length) {
            codigoGigaToOriginal.delete(previous);
            codigoGigaToOriginal.set(codigoGiga, originalSku);
          }
        }
      }
    } catch (e) {
      this.logger.warn(
        `getStock: lookup em produtos falhou, caindo no modo legado (sujeito a colisão): ${(e as Error).message}`,
      );
      // Fallback degradado: usa todas variantes (comportamento antigo).
      // Pelo menos a chamada não morre — operação continua, ainda que
      // possa rotear errado em casos de colisão.
      for (const v of allVariants) {
        const original = variantToOriginal.get(v);
        if (original) codigoGigaToOriginal.set(v, original);
      }
    }

    if (!codigoGigaToOriginal.size) {
      // Nenhum SKU foi achado no cadastro → não tem estoque pra rotear
      return [];
    }

    // PASSO 2 — Estoque dos CODIGOs reais resolvidos.
    //
    // BUG anterior: buscava só pelo CODIGO literal encontrado em `produtos`.
    // Mas a tabela `estoque` pode armazenar o MESMO produto com padding de
    // zeros DIFERENTE (ex: produtos="5383641", estoque="00005383641"). Como o
    // IN da query é literal, perdia essas linhas → routing dizia ruptura
    // mesmo com 1 un físico real (caso real do pedido WC #191547 da Lurd's).
    //
    // Solução: pra cada codigoGiga resolvido em produtos, expandir TODAS as
    // variantes de padding e procurar em estoque pelo set inteiro. Mantém o
    // mapeamento variant → originalSku pra agregar de volta corretamente.
    const codigosVariants: string[] = [];
    const codigoVariantToOriginal = new Map<string, string>();
    for (const [codigoGiga, originalSku] of codigoGigaToOriginal.entries()) {
      for (const v of this.skuVariants(codigoGiga)) {
        codigosVariants.push(v);
        if (!codigoVariantToOriginal.has(v)) {
          codigoVariantToOriginal.set(v, originalSku);
        }
      }
    }
    if (codigosVariants.length === 0) return [];

    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO AS sku,
                LOJA   AS storeCode,
                ESTOQUE AS availableQty
           FROM estoque
          WHERE CODIGO IN (?)
            AND LOJA IN (?)
            AND ESTOQUE > 0`,
        [codigosVariants, storeCodes],
      );
      // Agrega por (originalSku, storeCode). Múltiplas variantes de padding
      // podem casar — somamos tudo, mas logamos pra detectar caso patológico.
      const agg = new Map<string, number>();
      for (const r of rows as any[]) {
        const codigoEstoque = String(r.sku).trim();
        const storeCode = String(r.storeCode).trim();
        const originalSku = codigoVariantToOriginal.get(codigoEstoque);
        if (!originalSku) continue;
        const key = `${storeCode}::${originalSku}`;
        agg.set(key, (agg.get(key) || 0) + (Number(r.availableQty) || 0));
      }
      const out: StockEntry[] = [];
      for (const [key, qty] of agg.entries()) {
        const [storeCode, originalSku] = key.split('::');
        out.push({ storeCode, sku: originalSku, availableQty: qty });
      }
      return out;
    } catch (e) {
      this.logger.error(`Falha ao consultar estoque ERP: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Lista REFs únicas cadastradas no intervalo de datas (formato YYYY-MM-DD),
   * filtrando opcionalmente por substring na descrição.
   *
   * Uso: "puxa REFs PLUS SIZE cadastradas em janeiro/2026" → vendedora insere
   * no buscador de realinhamento.
   *
   * Detecta automaticamente a coluna de data cadastro. Se nenhuma existir,
   * retorna [] e loga o problema.
   *
   * Retorna até 500 REFs distintas com descrição + contagem de variações.
   *
   * NOTA: usa strings YYYY-MM-DD direto (não Date object) pra evitar
   * confusão de timezone — driver mysql2 às vezes converte Date pra
   * timestamp UTC e a coluna do Giga geralmente tá em horário local.
   */
  async searchRefsByDateRange(input: {
    inicio: string; // YYYY-MM-DD
    fim: string;    // YYYY-MM-DD (exclusive — passe o dia SEGUINTE ao último dia desejado)
    descricaoContains?: string;
  }): Promise<Array<{ ref: string; descricao: string; variantCount: number; dataCadastro: string | null }>> {
    if (!this.pool) return [];

    const candidatas = [
      'DATAALT', 'DATA_ALT', 'DT_ALT', 'DATAALTERACAO', 'DATA_ALTERACAO',
      'DATACADASTRO', 'DATA_CADASTRO', 'DT_CADASTRO',
      'DATACRIACAO', 'DT_CRIACAO',
      'DATA_INC', 'DATAINC', 'DT_INC', 'DATA_INCLUSAO', 'DATAINCLUSAO', 'DT_INCLUSAO',
      'DATA_ENT', 'DATAENT', 'DT_ENT', 'DATA_ENTRADA', 'DATAENTRADA', 'DT_ENTRADA',
      'CREATED_AT', 'CRIADO_EM', 'DATA',
    ];
    const dataCol = await this.pickCol(candidatas);
    if (!dataCol) {
      this.logger.warn(
        `[erp] searchRefsByDateRange: nenhuma coluna de data detectada. Tentei: ${candidatas.join(', ')}`,
      );
      return [];
    }

    const conds: string[] = [
      `\`${dataCol}\` >= ?`,
      `\`${dataCol}\` <  ?`,
      `REF IS NOT NULL`,
      `REF <> ''`,
    ];
    const vals: any[] = [input.inicio, input.fim];

    if (input.descricaoContains?.trim()) {
      conds.push('UPPER(DESCRICAOCOMPLETA) LIKE ?');
      vals.push(`%${input.descricaoContains.trim().toUpperCase()}%`);
    }

    try {
      const sql = `
        SELECT REF                            AS ref,
               MAX(DESCRICAOCOMPLETA)         AS descricao,
               MAX(\`${dataCol}\`)            AS dataCadastro,
               COUNT(*)                       AS variantCount
          FROM produtos
         WHERE ${conds.join(' AND ')}
         GROUP BY REF
         ORDER BY MAX(\`${dataCol}\`) DESC
         LIMIT 500
      `;
      this.logger.log(`[erp] searchRefsByDateRange col=${dataCol} from=${input.inicio} to=${input.fim} desc=${input.descricaoContains || '(none)'}`);
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, vals);
      this.logger.log(`[erp] searchRefsByDateRange retornou ${rows.length} REF(s)`);
      return (rows as any[]).map((r) => ({
        ref: String(r.ref).trim(),
        descricao: String(r.descricao || '').trim(),
        variantCount: Number(r.variantCount) || 0,
        dataCadastro: r.dataCadastro ? String(r.dataCadastro) : null,
      }));
    } catch (e) {
      this.logger.error(`searchRefsByDateRange falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * DIAGNÓSTICO de searchRefsByDateRange — usado pra debugar quando "0 resultados".
   * Retorna:
   *   - qual coluna de data foi detectada
   *   - todas as colunas DATE/DATETIME existentes na tabela produtos
   *   - contagens em diferentes cenários (com/sem filtro de data, com/sem PLUS SIZE)
   *   - sample de DESCRICAOCOMPLETA pra ver o formato real
   *   - min/max da coluna de data (pra ver se tem dado nesse range)
   */
  async diagnoseRefsByDate(input: {
    inicio: string;
    fim: string;
    descricaoContains?: string;
  }): Promise<any> {
    if (!this.pool) return { error: 'pool não inicializado' };

    const candidatas = [
      'DATAALT', 'DATA_ALT', 'DT_ALT', 'DATAALTERACAO', 'DATA_ALTERACAO',
      'DATACADASTRO', 'DATA_CADASTRO', 'DT_CADASTRO',
      'DATACRIACAO', 'DT_CRIACAO',
      'DATA_INC', 'DATAINC', 'DT_INC', 'DATA_INCLUSAO', 'DATAINCLUSAO', 'DT_INCLUSAO',
      'DATA_ENT', 'DATAENT', 'DT_ENT', 'DATA_ENTRADA', 'DATAENTRADA', 'DT_ENTRADA',
      'CREATED_AT', 'CRIADO_EM', 'DATA',
    ];
    const dataCol = await this.pickCol(candidatas);

    // Lista TODAS as colunas da tabela produtos pra ele ver
    const cols = await this.getProductsColumns();
    const colsList = Array.from(cols).sort();
    const dateCols = colsList.filter((c) => /DATA|DT|TIME|CREATED|UPDATED|INC/i.test(c));

    const result: any = {
      colunaDataDetectada: dataCol,
      colunasComDataNoNome: dateCols,
      todasAsColunasProdutos: colsList,
      candidatasTentadas: candidatas,
      filtros: {
        inicio: input.inicio,
        fim: input.fim,
        descricao: input.descricaoContains,
      },
    };

    if (!dataCol) {
      result.problema = 'Nenhuma coluna de data foi detectada. Veja "colunasComDataNoNome" pra ver opções.';
      return result;
    }

    try {
      // Range total da coluna
      const [minMaxRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT MIN(\`${dataCol}\`) AS minDate, MAX(\`${dataCol}\`) AS maxDate, COUNT(*) AS total FROM produtos WHERE \`${dataCol}\` IS NOT NULL`,
      );
      result.colunaStats = {
        minDate: minMaxRows[0]?.minDate ? String(minMaxRows[0].minDate) : null,
        maxDate: minMaxRows[0]?.maxDate ? String(minMaxRows[0].maxDate) : null,
        totalComData: Number(minMaxRows[0]?.total) || 0,
      };

      // Total no range (sem filtro descrição)
      const [rangeRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(DISTINCT REF) AS uniqueRefs, COUNT(*) AS totalRows
           FROM produtos
          WHERE \`${dataCol}\` >= ? AND \`${dataCol}\` < ? AND REF IS NOT NULL AND REF <> ''`,
        [input.inicio, input.fim],
      );
      result.semFiltroDescricao = {
        uniqueRefs: Number(rangeRows[0]?.uniqueRefs) || 0,
        totalRows: Number(rangeRows[0]?.totalRows) || 0,
      };

      // Total no range COM filtro descrição
      if (input.descricaoContains?.trim()) {
        const [filterRows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(DISTINCT REF) AS uniqueRefs, COUNT(*) AS totalRows
             FROM produtos
            WHERE \`${dataCol}\` >= ? AND \`${dataCol}\` < ?
              AND REF IS NOT NULL AND REF <> ''
              AND UPPER(DESCRICAOCOMPLETA) LIKE ?`,
          [input.inicio, input.fim, `%${input.descricaoContains.trim().toUpperCase()}%`],
        );
        result.comFiltroDescricao = {
          uniqueRefs: Number(filterRows[0]?.uniqueRefs) || 0,
          totalRows: Number(filterRows[0]?.totalRows) || 0,
        };

        // Quantos produtos TEM essa descrição no banco inteiro (sem filtro de data)
        const [descCountRows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(*) AS total FROM produtos WHERE UPPER(DESCRICAOCOMPLETA) LIKE ?`,
          [`%${input.descricaoContains.trim().toUpperCase()}%`],
        );
        result.descricaoTotalNoBanco = Number(descCountRows[0]?.total) || 0;
      }

      // Sample de 5 produtos no range (descrições reais)
      const [sampleRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT REF, DESCRICAOCOMPLETA, \`${dataCol}\` AS dataCadastro
           FROM produtos
          WHERE \`${dataCol}\` >= ? AND \`${dataCol}\` < ? AND REF IS NOT NULL
          LIMIT 10`,
        [input.inicio, input.fim],
      );
      result.sampleNoRange = (sampleRows as any[]).map((r) => ({
        ref: r.REF,
        descricao: r.DESCRICAOCOMPLETA,
        dataCadastro: String(r.dataCadastro),
      }));

      return result;
    } catch (e) {
      result.error = (e as Error).message;
      return result;
    }
  }

  /**
   * Busca preço cheio por SKU em batch na tabela `produtos` do Giga.
   *
   * Detecta automaticamente qual coluna tem o preço (VENDAUN, PRECO,
   * PRECOVENDA, PRECO_VENDA — varia entre instalações Giga).
   *
   * Usado pelo realinhamento pra capturar o snapshot do preço no momento
   * da transferência (mesma lógica do `seedAndApply` em #194).
   *
   * Retorna Map<sku, preco>. SKUs sem preço (ou sem coluna de preço
   * detectada) NÃO aparecem no map → caller deve tratar como 0.
   */
  async getProductPricesBySkus(skus: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!skus.length || !this.pool) return out;

    // Descobre qual coluna tem o preço (cache no método pickCol)
    const precoCol = await this.pickCol([
      'VENDAUN',
      'PRECO',
      'PRECOVENDA',
      'PRECO_VENDA',
      'VENDA',
    ]);
    if (!precoCol) {
      this.logger.warn(
        '[erp] getProductPricesBySkus: nenhuma coluna de preço detectada na tabela produtos',
      );
      return out;
    }

    // Dedup + limpa SKUs + EXPANDE variantes (zeros à esquerda)
    const unique = Array.from(new Set(skus.map((s) => String(s).trim()).filter(Boolean)));
    if (!unique.length) return out;
    const { allVariants, variantToOriginal } = this.expandSkus(unique);
    if (!allVariants.length) return out;

    try {
      const sql = `
        SELECT CODIGO AS sku, \`${precoCol}\` AS preco
          FROM produtos
         WHERE CODIGO IN (?)
      `;
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [allVariants]);
      for (const r of rows) {
        const codigoGiga = String(r.sku).trim();
        // Mapeia de volta pro SKU original que o caller passou
        const originalSku = variantToOriginal.get(codigoGiga) || codigoGiga;
        const preco = Number(r.preco);
        if (!Number.isNaN(preco) && preco > 0) {
          // VENDAUN é em centavos — divide por 100 (consistente com getPdvProductInfo)
          const precoFinal = (precoCol || '').toUpperCase() === 'VENDAUN' ? preco / 100 : preco;
          // Se já tem o SKU no map, mantém o maior preço (defensivo contra duplicatas)
          const existing = out.get(originalSku);
          if (!existing || precoFinal > existing) {
            out.set(originalSku, precoFinal);
          }
        }
      }
      return out;
    } catch (e) {
      this.logger.error(
        `[erp] getProductPricesBySkus falhou: ${(e as Error).message}`,
      );
      return out;
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

    // Expande variantes de zero-padding (Giga grava "0005383498", outros sistemas
    // podem mandar "5383498"). Mantém map variantToOriginal pra retornar
    // o resultado agrupado pelo SKU original que o caller passou.
    const { allVariants, variantToOriginal } = this.expandSkus(unique);
    if (!allVariants.length) return {};

    // PASSO 1: verifica quais SKUs ORIGINAIS existem no CADASTRO (tabela `produtos`).
    // Produto pode existir em `produtos` mas NÃO em `estoque` se ele está zerado
    // em todas as lojas (gigasistemas só cria linha em `estoque` quando há movimento).
    // Se confundirmos "sem linha em estoque" com "não existe", as 698 variações
    // não atualizam pra zero quando deveriam.
    const existsInProducts = new Set<string>();
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        'SELECT CODIGO FROM produtos WHERE CODIGO IN (?)',
        [allVariants],
      );
      for (const r of rows) {
        const codigoGiga = String(r.CODIGO).trim();
        const original = variantToOriginal.get(codigoGiga) || codigoGiga;
        existsInProducts.add(original);
      }
    } catch (e) {
      this.logger.error(`Falha ao verificar cadastro ERP: ${(e as Error).message}`);
      // Em erro, segue pro passo 2 sem distinção (comportamento antigo)
    }

    // PASSO 2: busca estoque consolidado dos que têm movimento em pelo menos uma loja.
    // Soma todas as variantes de cada SKU original (caso o Giga tenha as duas formas).
    const stockMap: Record<string, number> = {};
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO AS sku, SUM(ESTOQUE) AS totalQty
           FROM estoque
          WHERE CODIGO IN (?)
          GROUP BY CODIGO`,
        [allVariants],
      );
      for (const r of rows) {
        const codigoGiga = String(r.sku).trim();
        const original = variantToOriginal.get(codigoGiga) || codigoGiga;
        const qty = Number(r.totalQty) || 0;
        stockMap[original] = (stockMap[original] || 0) + qty;
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

    // Tolerância a zeros à esquerda: expande cada SKU pra suas variantes 3-14 dígitos
    // e mapeia o resultado de volta pro SKU original que o caller passou.
    const { allVariants, variantToOriginal } = this.expandSkus(unique);
    if (!allVariants.length) return {};

    const sql = `
      SELECT CODIGO AS sku,
             LOJA   AS storeCode,
             SUM(ESTOQUE) AS qty
        FROM estoque
       WHERE CODIGO IN (?)
         AND ESTOQUE > 0
       GROUP BY CODIGO, LOJA
       ORDER BY CODIGO, LOJA
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [allVariants]);
      // Agrega por (sku original, storeCode) somando variantes que apareçam separadas.
      const agg = new Map<string, Map<string, number>>();
      for (const r of rows) {
        const codigoGiga = String(r.sku).trim();
        const original = variantToOriginal.get(codigoGiga) || codigoGiga;
        const storeCode = String(r.storeCode).trim();
        const qty = Number(r.qty) || 0;
        if (qty <= 0) continue;
        if (!agg.has(original)) agg.set(original, new Map());
        const lojaMap = agg.get(original)!;
        lojaMap.set(storeCode, (lojaMap.get(storeCode) || 0) + qty);
      }
      const map: Record<string, Array<{ storeCode: string; qty: number }>> = {};
      for (const [sku, lojaMap] of agg.entries()) {
        map[sku] = Array.from(lojaMap.entries()).map(([storeCode, qty]) => ({ storeCode, qty }));
      }
      return map;
    } catch (e) {
      this.logger.error(`Falha ao consultar estoque detalhado ERP: ${(e as Error).message}`);
      return {};
    }
  }

  /**
   * TRACE: executa getStock passo-a-passo e retorna cada etapa pra debug.
   * Usado pelo endpoint /intelligence/sku-trace/:sku quando routing diz ruptura
   * mas tela /produtos diz que tem estoque — identifica em qual passo o estoque
   * "some".
   */
  async traceSkuStock(sku: string, storeCodes: string[]): Promise<{
    input: { sku: string; storeCodes: string[] };
    step1_skuVariants: string[];
    step2_produtosFound: Array<{ codigoGiga: string }>;
    step3_codigoMapping: Array<{ codigoGiga: string; originalSku: string }>;
    step4_codigoVariantsForEstoque: string[];
    step5_estoqueRows: Array<{ codigoEstoque: string; loja: string; qty: number }>;
    step6_finalAggregated: Array<{ storeCode: string; sku: string; qty: number }>;
    rawTable: Array<{ sku: string; storeCode: string; qty: number }>;
    notes: string[];
  }> {
    const notes: string[] = [];
    const cleanSku = String(sku || '').trim();

    // STEP 1 — variantes do SKU (paddings)
    const skuVariantsList = this.skuVariants(cleanSku);
    notes.push(`SKU "${cleanSku}" expandido em ${skuVariantsList.length} variante(s)`);

    if (!this.pool) {
      notes.push('⚠️ Pool MySQL não inicializado');
      return {
        input: { sku: cleanSku, storeCodes },
        step1_skuVariants: skuVariantsList,
        step2_produtosFound: [],
        step3_codigoMapping: [],
        step4_codigoVariantsForEstoque: [],
        step5_estoqueRows: [],
        step6_finalAggregated: [],
        rawTable: [],
        notes,
      };
    }

    // STEP 2 — busca em produtos
    const { allVariants, variantToOriginal } = this.expandSkus([cleanSku]);
    let produtosFound: Array<{ codigoGiga: string }> = [];
    try {
      const [prodRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO FROM produtos WHERE CODIGO IN (?)`,
        [allVariants],
      );
      produtosFound = (prodRows as any[]).map((r) => ({ codigoGiga: String(r.CODIGO).trim() }));
      notes.push(`PASSO 1: ${produtosFound.length} produto(s) encontrado(s) em produtos`);
    } catch (e) {
      notes.push(`⚠️ Falha PASSO 1 (produtos): ${(e as Error).message}`);
    }

    // STEP 3 — mapeamento codigoGiga → originalSku
    const codigoGigaToOriginal = new Map<string, string>();
    for (const p of produtosFound) {
      const original = variantToOriginal.get(p.codigoGiga);
      if (original) codigoGigaToOriginal.set(p.codigoGiga, original);
    }

    // STEP 4 — expansão dos codigosGiga em variantes (NOVO FIX)
    const codigoVariantsForEstoque: string[] = [];
    const codigoVariantToOriginal = new Map<string, string>();
    for (const [codigoGiga, originalSku] of codigoGigaToOriginal.entries()) {
      for (const v of this.skuVariants(codigoGiga)) {
        if (!codigoVariantToOriginal.has(v)) {
          codigoVariantToOriginal.set(v, originalSku);
          codigoVariantsForEstoque.push(v);
        }
      }
    }
    notes.push(`PASSO 2: expandido em ${codigoVariantsForEstoque.length} variantes pra buscar em estoque`);

    // STEP 5 — query em estoque
    let estoqueRows: Array<{ codigoEstoque: string; loja: string; qty: number }> = [];
    if (codigoVariantsForEstoque.length > 0 && storeCodes.length > 0) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO AS sku, LOJA AS storeCode, ESTOQUE AS qty
             FROM estoque
            WHERE CODIGO IN (?) AND LOJA IN (?) AND ESTOQUE > 0`,
          [codigoVariantsForEstoque, storeCodes],
        );
        estoqueRows = (rows as any[]).map((r) => ({
          codigoEstoque: String(r.sku).trim(),
          loja: String(r.storeCode).trim(),
          qty: Number(r.qty) || 0,
        }));
        notes.push(`PASSO 3: ${estoqueRows.length} linha(s) em estoque com ESTOQUE>0 nas lojas filtradas`);
      } catch (e) {
        notes.push(`⚠️ Falha PASSO 3 (estoque): ${(e as Error).message}`);
      }
    }

    // STEP 6 — agregação final
    const agg = new Map<string, number>();
    for (const r of estoqueRows) {
      const original = codigoVariantToOriginal.get(r.codigoEstoque);
      if (!original) continue;
      const key = `${r.loja}::${original}`;
      agg.set(key, (agg.get(key) || 0) + r.qty);
    }
    const finalAggregated = Array.from(agg.entries()).map(([k, qty]) => {
      const [storeCode, sku] = k.split('::');
      return { storeCode, sku, qty };
    });

    // RAW (sem filtros) pra comparação
    const raw = await this.getStockRawBySku(cleanSku);

    return {
      input: { sku: cleanSku, storeCodes },
      step1_skuVariants: skuVariantsList,
      step2_produtosFound: produtosFound,
      step3_codigoMapping: Array.from(codigoGigaToOriginal.entries()).map(([codigoGiga, originalSku]) => ({
        codigoGiga,
        originalSku,
      })),
      step4_codigoVariantsForEstoque: codigoVariantsForEstoque,
      step5_estoqueRows: estoqueRows,
      step6_finalAggregated: finalAggregated,
      rawTable: raw,
      notes,
    };
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
    const variants = this.skuVariants(sku);
    if (!variants.length) return [];
    try {
      // Diagnóstico: mostra TUDO (não filtra ESTOQUE>0 e mantém o CODIGO real
      // do Giga pra ajudar a identificar problemas de zero-padding).
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO AS sku, LOJA AS storeCode, ESTOQUE AS qty
           FROM estoque
          WHERE CODIGO IN (?)
          ORDER BY LOJA, CODIGO`,
        [variants],
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
   * VENDA BRUTA por loja num intervalo de datas (em R$).
   *
   * Soma VALORTOTAL da tabela `caixa` entre [inicio, fim) — fim é EXCLUSIVO.
   * Ignora linhas MARCADO='SIM' (estornadas/canceladas no PDV).
   *
   * Usado pra calcular royalties (8%) + marketing (4%) das filiais por mês.
   *
   * Retorna Map<storeCode, vendaBrutaR$>. Lojas sem venda no período NÃO
   * aparecem no map (caller deve tratar como 0).
   */
  async getSalesGrossByStores(
    storeCodes: string[],
    inicio: Date,
    fim: Date,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.pool || !storeCodes.length) return out;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT c.LOJA AS storeCode,
                SUM(c.VALORTOTAL) AS bruto
           FROM caixa c
          WHERE c.LOJA IN (?)
            AND c.DATA >= ?
            AND c.DATA <  ?
            AND (c.MARCADO IS NULL OR c.MARCADO <> 'SIM')
          GROUP BY c.LOJA`,
        [storeCodes, inicio, fim],
      );
      for (const r of rows as any[]) {
        const code = String(r.storeCode).trim();
        const bruto = Number(r.bruto) || 0;
        if (bruto > 0) out.set(code, bruto);
      }
      return out;
    } catch (e) {
      this.logger.error(`getSalesGrossByStores falhou: ${(e as Error).message}`);
      return out;
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
   * Busca por REF base. Retorna TODAS as variações de cor/tamanho.
   *
   * O Lurd's tem 3 convenções de cor coexistindo no Giga:
   *   1. REF exata (13015 = cor base, geralmente PRETO)
   *   2. Sufixo de letra direto sem separador (13015M = MARINHO, 13015V = VINHO)
   *   3. Sufixo com espaço + nome cor (VMS-223 PRETO, VMS-223 VERDE)
   *   4. Sufixo com hífen (alguns cadastros legados: BMM-100-A)
   *
   * Estratégia: SQL traz tudo que COMEÇA com a REF base (LIKE 'X%'), depois
   * filtramos em JS pelo padrão de sufixo válido pra excluir falsos positivos
   * (ex: pedir "9002" não pode trazer "900271" que é outra REF inteira).
   *
   * Padrões aceitos como variação de cor da mesma REF base:
   *   - exata
   *   - base + " ALGO"          (espaço + texto)
   *   - base + "-ALGO"          (hífen + texto)
   *   - base + "LETRA(S)"       (sufixo só letras maiúsculas/lowercase, sem dígito)
   * Padrões REJEITADOS (provavelmente outra REF):
   *   - base + dígito (ex: "9002" + "71" = "900271")
   */
  async searchByRef(ref: string): Promise<any[]> {
    if (!this.pool || !ref) return [];
    const clean = String(ref).trim();
    if (!clean) return [];
    try {
      // Busca tudo que começa com a REF base — cada cor pode estar com sufixo
      // diferente no Giga. Filtramos os falsos positivos no JS abaixo.
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, REF, DESCRICAOCOMPLETA, COR, TAMANHO, ESTOQUE, ID
           FROM produtos
          WHERE REF = ? OR REF LIKE ?
          ORDER BY COR, TAMANHO
          LIMIT 1000`,
        [clean, `${clean}%`],
      );
      const all = rows as any[];

      const isVariationOf = (foundRef: string, baseRef: string): boolean => {
        if (!foundRef) return false;
        if (foundRef === baseRef) return true;
        if (!foundRef.startsWith(baseRef)) return false;
        const suffix = foundRef.slice(baseRef.length);
        // Sufixos VÁLIDOS (variação de cor da mesma REF base):
        //   " ALGO" (espaço + texto), "-ALGO" (hífen + texto),
        //   "LETRAS" (só letras direto, sem dígitos)
        // Sufixos REJEITADOS:
        //   começa com dígito → outra REF (ex: 9002 + 71 = 900271)
        if (suffix.startsWith(' ') || suffix.startsWith('-')) return true;
        // Sufixo direto sem separador: aceita SE não começar com dígito
        if (/^[A-Za-z]/.test(suffix)) return true;
        return false;
      };

      const filtered = all.filter((r: any) => isVariationOf(String(r.REF || ''), clean));
      this.logger.log(
        `[erp] searchByRef("${clean}"): SQL retornou ${all.length}, filtrado pra ${filtered.length} variações.`,
      );
      return filtered;
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
    const trimmed = String(term).trim();
    if (!trimmed) return [];

    // ─── Detecção de REF: quando o termo é uma única palavra "REF-like" ───
    // (só dígitos ex: "9002", ou padrão com hífen ex: "VMS-223"), busca
    // EXATA pela coluna REF. Isso evita "9002" trazer "900246", "900201"
    // (que contêm "9002" mas são REFs totalmente diferentes).
    const isRefLike = /^[A-Z0-9]+(-[A-Z0-9]+)*$/i.test(trimmed) && !trimmed.includes(' ');
    if (isRefLike) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT REF,
                  MAX(DESCRICAOCOMPLETA) AS DESCRICAOCOMPLETA,
                  COUNT(*) AS VARIANT_COUNT
             FROM produtos
            WHERE REF = ?
            GROUP BY REF
            LIMIT 10`,
          [trimmed],
        );
        if (rows.length > 0) return rows as any[];
        // Fallback: se não bateu exato, tenta prefixo (ex: usuário digitou
        // só parte da REF). Evita o LIKE %term% que confunde "9002"/"900246".
        const [prefRows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT REF,
                  MAX(DESCRICAOCOMPLETA) AS DESCRICAOCOMPLETA,
                  COUNT(*) AS VARIANT_COUNT
             FROM produtos
            WHERE REF LIKE ?
              AND REF IS NOT NULL
              AND REF <> ''
            GROUP BY REF
            ORDER BY REF ASC
            LIMIT 50`,
          [`${trimmed}%`],
        );
        return prefRows as any[];
      } catch (e) {
        this.logger.error(`searchByDescriptionGrouped (ref) falhou: ${(e as Error).message}`);
        return [];
      }
    }

    // ─── Busca por descrição (texto livre): LIKE %palavra% por palavra ───
    const words = trimmed
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

  /**
   * DIAGNÓSTICO: lista tabelas do Gigasistemas que batem com um LIKE.
   * Uso: `listTablesLike('%credi%')` → retorna nomes de tabelas com "credi".
   * Se a tabela existir, também devolve schema (colunas) e 3 linhas de amostra.
   *
   * Endpoint pensado pra eu (Claude) descobrir estrutura de tabelas sem precisar
   * subir dump — útil pra investigar integrações (ex: crediarios do WinCred).
   */
  async listTablesLike(
    pattern: string,
  ): Promise<{
    pattern: string;
    tables: string[];
    details: Array<{ table: string; columns: Array<{ field: string; type: string }>; sample: any[]; rowCount?: number }>;
  }> {
    if (!this.pool) return { pattern, tables: [], details: [] };

    const p = String(pattern || '').trim() || '%';
    const safe = p.includes('%') ? p : `%${p}%`;

    try {
      const [tRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SHOW TABLES LIKE ?`,
        [safe],
      );
      // SHOW TABLES retorna colunas tipo "Tables_in_gigasistemas21"
      const tables: string[] = (tRows as any[]).map((r) => {
        const keys = Object.keys(r);
        return String(r[keys[0]]);
      });

      const details: Array<{
        table: string;
        columns: Array<{ field: string; type: string }>;
        sample: any[];
        rowCount?: number;
      }> = [];

      for (const t of tables.slice(0, 10)) {
        // Só inspeciona as 10 primeiras — evitar payload gigante
        try {
          const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
            // Nome de tabela não pode ser parametrizado — usamos regex pra sanitizar
            `SHOW COLUMNS FROM \`${t.replace(/[^a-zA-Z0-9_]/g, '')}\``,
          );
          const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
            `SELECT * FROM \`${t.replace(/[^a-zA-Z0-9_]/g, '')}\` LIMIT 3`,
          );
          const [countRows] = await this.pool.query<mysql.RowDataPacket[]>(
            `SELECT COUNT(*) AS c FROM \`${t.replace(/[^a-zA-Z0-9_]/g, '')}\``,
          );
          details.push({
            table: t,
            columns: (cols as any[]).map((c) => ({ field: c.Field, type: c.Type })),
            sample: rows as any[],
            rowCount: Number((countRows as any[])[0]?.c ?? 0),
          });
        } catch (e: any) {
          details.push({ table: t, columns: [], sample: [], rowCount: undefined });
          this.logger.warn(`listTablesLike(describe ${t}) falhou: ${e.message}`);
        }
      }

      return { pattern: safe, tables, details };
    } catch (e: any) {
      this.logger.error(`listTablesLike falhou: ${e.message}`);
      return { pattern: safe, tables: [], details: [] };
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
      descLonga: string | null;
      grupo: string | null;
      subgrupo: string | null;
      fornecedor: string | null;
      ncm: string | null;
      cfop: string | null;
      custo: number | null;
      preco: number | null;          // preço PRINCIPAL (a prazo, geralmente)
      precoVista: number | null;     // preço à vista (se diferente)
      precoPromo: number | null;     // preço promo (se houver)
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
    // FIX: Wincred tem MÚLTIPLAS colunas de preço (à vista, a prazo, promo, etc).
    // VENDAUN normalmente é PREÇO À VISTA (mais BAIXO). Pra publicação no site, o
    // CEO geralmente quer o PREÇO A PRAZO (VPRAZO/PRECOPRAZO), que é o praticado
    // no PDV. Buscamos todos e expomos no payload pra UI escolher.
    const precoCol      = (await this.pickCol(['VPRAZO', 'PRECOPRAZO', 'PRECO_PRAZO', 'VENDAPRAZO', 'PRECOVENDA', 'PRECO_VENDA', 'PRECO', 'VENDAUN'])) as string | null;
    const precoVistaCol = (await this.pickCol(['VAVISTA', 'PRECOVISTA', 'PRECO_VISTA', 'VENDAVISTA', 'VENDAUN'])) as string | null;
    const precoPromoCol = (await this.pickCol(['PRECOPROMO', 'PRECO_PROMO', 'VPROMO', 'VENDAPROMO'])) as string | null;
    // Descrição estendida — Wincred às vezes tem campos extras (OBSERVACAO, DETALHES,
    // INFORMACOES). Pegamos pra usar como base de descrição se houver.
    const descLongaCol  = (await this.pickCol(['OBSERVACAO', 'OBSERVACOES', 'DETALHES', 'INFORMACOES', 'DESCRICAOPROD', 'DESCRICAO_PROD', 'DESCRICAO'])) as string | null;
    const dataCol = (await this.pickCol(['DATAALT', 'DATA_ALT', 'DT_ALT', 'DATACADASTRO', 'DATA_CADASTRO', 'DT_CADASTRO', 'DATACRIACAO', 'DT_CRIACAO', 'CREATED_AT'])) as string | null;
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
    if (precoVistaCol && precoVistaCol !== precoCol) selects.push(`p.\`${precoVistaCol}\` AS precoVista`);
    if (precoPromoCol) selects.push(`p.\`${precoPromoCol}\` AS precoPromo`);
    if (descLongaCol)  selects.push(`p.\`${descLongaCol}\` AS descLonga`);
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
          descLonga: r.descLonga != null ? String(r.descLonga).trim() : null,
          grupo: r.grupo != null ? String(r.grupo).trim() : null,
          subgrupo: r.subgrupo != null ? String(r.subgrupo).trim() : null,
          fornecedor: r.fornecedor != null ? String(r.fornecedor).trim() : null,
          ncm: r.ncm != null ? String(r.ncm).trim() : null,
          cfop: r.cfop != null ? String(r.cfop).trim() : null,
          custo: r.custo != null ? Number(r.custo) : null,
          preco: r.preco != null ? Number(r.preco) : null,
          precoVista: r.precoVista != null ? Number(r.precoVista) : null,
          precoPromo: r.precoPromo != null ? Number(r.precoPromo) : null,
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
      descLonga: (r.descLonga ?? null) as string | null,
      grupo: (r.grupo ?? null) as string | null,
      subgrupo: (r.subgrupo ?? null) as string | null,
      fornecedor: (r.fornecedor ?? null) as string | null,
      ncm: (r.ncm ?? null) as string | null,
      cfop: (r.cfop ?? null) as string | null,
      custo: (r.custo ?? null) as number | null,
      preco: (r.preco ?? null) as number | null,
      precoVista: (r.precoVista ?? null) as number | null,
      precoPromo: (r.precoPromo ?? null) as number | null,
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
    descLonga: string | null;
    grupo: string | null;
    subgrupo: string | null;
    fornecedor: string | null;
    ncm: string | null;
    cfop: string | null;
    custo: number | null;
    preco: number | null;
    precoVista: number | null;
    precoPromo: number | null;
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
      descLonga: ref.descLonga,
      grupo: ref.grupo,
      subgrupo: ref.subgrupo,
      fornecedor: ref.fornecedor,
      ncm: ref.ncm,
      cfop: ref.cfop,
      custo: ref.custo,
      preco: ref.preco,
      precoVista: ref.precoVista,
      precoPromo: ref.precoPromo,
      tamanhos: corEntry.tamanhos,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXPLORER GENÉRICO DO ERP — list/schema/run read-only
  //
  // Usado pela tela /relatorios/giga (matriz). Permite ao admin executar
  // queries SELECT arbitrárias contra o banco do Gigasistemas pra extrair
  // dados em tempo real (relatórios ad-hoc, exports CSV/XLSX, dashboards).
  //
  // Segurança (defesa em camadas):
  //  1. Controller exige role admin/operator
  //  2. runReadOnly bloqueia comandos de escrita (regex blacklist)
  //  3. runReadOnly força LIMIT global (default 1000, max 50000)
  //  4. Pool dedicado de leitura — usa o mesmo pool, mas o user MySQL
  //     do Gigasistemas idealmente só tem GRANT SELECT
  //  5. Timeout de 30s na query
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Health check do pool MySQL — devolve diagnóstico em formato amigável.
   *
   * Não engole erro: retorna o `error.message` real pra UI mostrar o motivo
   * (timeout, ECONNREFUSED, access denied, etc.). Também expõe se as envs
   * obrigatórias estão setadas (sem vazar senha).
   */
  async pingHealth(): Promise<{
    ok: boolean;
    error?: string;
    host?: string;
    port?: number;
    database?: string;
    hasUser: boolean;
    hasPassword: boolean;
    pingMs?: number;
  }> {
    const host = this.config.get<string>('ERP_HOST');
    const port = Number(this.config.get<string>('ERP_PORT') ?? 3306);
    const database = this.config.get<string>('ERP_DATABASE');
    const hasUser = !!this.config.get<string>('ERP_USER');
    const hasPassword = !!this.config.get<string>('ERP_PASSWORD');

    if (!this.pool) {
      return { ok: false, error: 'Pool ERP não inicializado', host, port, database, hasUser, hasPassword };
    }
    const t0 = Date.now();
    try {
      const conn = await this.pool.getConnection();
      try {
        await conn.ping();
      } finally {
        conn.release();
      }
      return { ok: true, host, port, database, hasUser, hasPassword, pingMs: Date.now() - t0 };
    } catch (e: any) {
      return {
        ok: false,
        error: e?.message ?? 'ping falhou',
        host, port, database, hasUser, hasPassword,
      };
    }
  }

  /**
   * Lista TODAS as tabelas do banco. Estratégia robusta:
   *   1. Tenta information_schema.TABLES (com TABLE_SCHEMA = ?). Traz rows+size.
   *   2. Se vier vazio, fallback pra SHOW TABLES (não tem metadados, mas
   *      funciona em user MySQL com GRANT mínimo). Tenta enriquecer com
   *      information_schema.STATISTICS.TABLE_ROWS por tabela.
   *
   * Por que dois caminhos? O Gigasistemas usa MySQL antigo onde nem todo user
   * tem permissão pra ler information_schema completa. SHOW TABLES funciona
   * com qualquer SELECT, mesmo restrito.
   */
  async listAllTables(): Promise<Array<{ name: string; rows: number; sizeMb: number; engine: string | null }>> {
    if (!this.pool) return [];

    const dbName = this.config.get<string>('ERP_DATABASE') ?? '';

    // Tentativa 1: information_schema (com schema explícito + DATABASE() como fallback)
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT
            TABLE_NAME    AS name,
            TABLE_ROWS    AS rows,
            ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS sizeMb,
            ENGINE        AS engine
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
            AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
          ORDER BY TABLE_NAME ASC`,
        [dbName || null],
      );
      const arr = (rows as any[]).map((r) => ({
        name: String(r.name),
        rows: Number(r.rows ?? 0),
        sizeMb: Number(r.sizeMb ?? 0),
        engine: r.engine ? String(r.engine) : null,
      }));
      if (arr.length > 0) return arr;
      this.logger.warn('listAllTables: information_schema retornou 0 — caindo pro SHOW TABLES');
    } catch (e: any) {
      this.logger.warn(`listAllTables information_schema falhou: ${e.message} — caindo pro SHOW TABLES`);
    }

    // Tentativa 2: SHOW TABLES (mais robusto, mas sem metadados de tamanho)
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(`SHOW TABLES`);
      // SHOW TABLES retorna 1 coluna chamada Tables_in_<dbname>
      const arr = (rows as any[]).map((r) => {
        const name = String(Object.values(r)[0] ?? '');
        return { name, rows: 0, sizeMb: 0, engine: null as string | null };
      }).filter((x) => x.name);
      this.logger.log(`listAllTables: SHOW TABLES retornou ${arr.length} tabelas`);
      return arr;
    } catch (e: any) {
      this.logger.error(`listAllTables SHOW TABLES também falhou: ${e.message}`);
      return [];
    }
  }

  /** Retorna schema (colunas + tipos + key) e amostra de N rows pra uma tabela. */
  async getTableSchema(
    tableName: string,
    sampleLimit = 5,
  ): Promise<{
    table: string;
    columns: Array<{ field: string; type: string; null: string; key: string; default: string | null }>;
    sample: any[];
    rowCount: number;
  } | null> {
    if (!this.pool) return null;
    // Sanitiza o nome da tabela: só alfanum/underscore (mysql identifier)
    const safe = String(tableName || '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!safe) return null;
    const lim = Math.max(1, Math.min(50, Number(sampleLimit) || 5));

    try {
      const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
        `SHOW COLUMNS FROM \`${safe}\``,
      );
      const [sample] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT * FROM \`${safe}\` LIMIT ${lim}`,
      );
      const [cnt] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM \`${safe}\``,
      );

      return {
        table: safe,
        columns: (cols as any[]).map((c) => ({
          field: String(c.Field),
          type: String(c.Type),
          null: String(c.Null),
          key: String(c.Key ?? ''),
          default: c.Default == null ? null : String(c.Default),
        })),
        sample: this.serializeRows(sample as any[]),
        rowCount: Number((cnt as any[])[0]?.c ?? 0),
      };
    } catch (e: any) {
      this.logger.warn(`getTableSchema(${safe}) falhou: ${e.message}`);
      return null;
    }
  }

  /**
   * Executa uma query READ-ONLY (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH).
   * Bloqueia comandos de escrita por regex e força LIMIT.
   *
   * Retorna columns + rows + meta (executionMs, truncated).
   */
  async runReadOnly(
    sqlRaw: string,
    opts: { maxRows?: number; timeoutMs?: number } = {},
  ): Promise<{
    columns: string[];
    rows: any[];
    executionMs: number;
    rowCount: number;
    truncated: boolean;
    appliedLimit: number;
  }> {
    if (!this.pool) {
      throw new Error('Pool ERP não inicializado');
    }
    const sql = String(sqlRaw || '').trim();
    if (!sql) throw new Error('SQL vazio');

    // Tira comentários simples e ponto-e-vírgula final pra checar a 1ª palavra
    const cleaned = sql
      .replace(/^\s*--[^\n]*\n?/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
      .replace(/;+\s*$/, '');

    // 1. WHITELIST — só comandos read-only
    const firstWord = cleaned.split(/\s+/)[0]?.toUpperCase() ?? '';
    const allowedFirst = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'];
    if (!allowedFirst.includes(firstWord)) {
      throw new Error(`Apenas comandos de leitura: ${allowedFirst.join(', ')}. Recebido: ${firstWord || '(vazio)'}`);
    }

    // 2. BLACKLIST — não pode ter comandos de escrita em qualquer lugar
    // (ex: SELECT 1; DELETE FROM produtos — rejeita pelo ;)
    if (/;[\s\S]+\S/.test(cleaned)) {
      throw new Error('Múltiplos statements separados por ";" não são permitidos');
    }
    // BUG FIX: REPLACE foi removido da blacklist porque colidia com a função
    // de string REPLACE() usada pra normalizar CPF na busca de cliente do Giga.
    // O comando perigoso "REPLACE INTO" (escrita) já é bloqueado pela WHITELIST
    // acima — que só aceita SELECT/SHOW/DESCRIBE/DESC/EXPLAIN/WITH como 1ª palavra.
    const blacklist = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|RENAME|GRANT|REVOKE|LOAD\s+DATA|INTO\s+OUTFILE|INTO\s+DUMPFILE|HANDLER|LOCK\s+TABLES|UNLOCK|CALL|DO\s+SLEEP|BENCHMARK\s*\()\b/i;
    const m = blacklist.exec(cleaned);
    if (m) {
      throw new Error(`Comando bloqueado: "${m[0].toUpperCase()}". Apenas leitura é permitida.`);
    }

    // 3. LIMIT automático (só pra SELECT/WITH; SHOW/DESCRIBE não precisa)
    const maxRows = Math.max(1, Math.min(50000, opts.maxRows ?? 1000));
    let finalSql = cleaned;
    let appliedLimit = maxRows;
    if (firstWord === 'SELECT' || firstWord === 'WITH') {
      // Detecta LIMIT já existente (case-insensitive, no fim)
      const limitMatch = cleaned.match(/\bLIMIT\s+(\d+)(\s*,\s*\d+)?\s*$/i);
      if (limitMatch) {
        const userLimit = Number(limitMatch[1]);
        if (userLimit > maxRows) {
          // Usuário pediu acima do teto — sobrescreve
          finalSql = cleaned.replace(/\bLIMIT\s+\d+(\s*,\s*\d+)?\s*$/i, `LIMIT ${maxRows}`);
        } else {
          appliedLimit = userLimit;
        }
      } else {
        finalSql = `${cleaned}\nLIMIT ${maxRows}`;
      }
    }

    // 4. Timeout
    const timeoutMs = Math.max(1000, Math.min(120_000, opts.timeoutMs ?? 30_000));

    const t0 = Date.now();
    try {
      const conn = await this.pool.getConnection();
      try {
        // SET SESSION pra timeout — precisa ser ms (mysql usa MAX_EXECUTION_TIME hint OU SESSION var)
        // Forma compatível com MySQL 5.7+: hint /*+ MAX_EXECUTION_TIME(N) */
        // Mas hint não funciona em SHOW/DESCRIBE — então usa SET SESSION quando dá.
        try {
          await conn.query(`SET SESSION MAX_EXECUTION_TIME=${timeoutMs}`);
        } catch {
          // MariaDB / versões antigas não suportam — segue sem timeout server-side
        }
        const [rows, fields] = await conn.query<mysql.RowDataPacket[]>(finalSql);
        const ms = Date.now() - t0;
        const arr = Array.isArray(rows) ? (rows as any[]) : [];
        const cols = Array.isArray(fields)
          ? (fields as any[]).map((f) => String(f.name))
          : arr.length
          ? Object.keys(arr[0])
          : [];
        return {
          columns: cols,
          rows: this.serializeRows(arr),
          executionMs: ms,
          rowCount: arr.length,
          truncated: arr.length >= appliedLimit,
          appliedLimit,
        };
      } finally {
        conn.release();
      }
    } catch (e: any) {
      throw new Error(`MySQL: ${e.message}`);
    }
  }

  /** Serializa rows pra JSON: Buffer→string, Date→ISO, BigInt→number. */
  private serializeRows(rows: any[]): any[] {
    return rows.map((r) => {
      const out: any = {};
      for (const k of Object.keys(r)) {
        const v = r[k];
        if (v == null) out[k] = null;
        else if (Buffer.isBuffer(v)) out[k] = v.toString('utf8');
        else if (v instanceof Date) out[k] = v.toISOString();
        else if (typeof v === 'bigint') out[k] = Number(v);
        else out[k] = v;
      }
      return out;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTELIGÊNCIA DE ESTOQUE — métodos pra dashboard /retaguarda/inteligencia-estoque
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Detecta a coluna de DATA CADASTRO da tabela `produtos` (varia por versão
   * Giga: DATACADASTRO, DATA_INC, DT_CADASTRO, CREATED_AT, etc). Cachê em
   * memória pra evitar repetir DESCRIBE em cada query.
   */
  private _cadCol: string | null | undefined = undefined;
  async getCadastroDateCol(): Promise<string | null> {
    if (this._cadCol !== undefined) return this._cadCol;
    const candidatas = [
      'DATACADASTRO', 'DATA_CADASTRO', 'DT_CADASTRO',
      'DATA_INC', 'DATAINC', 'DT_INC', 'DATA_INCLUSAO', 'DATAINCLUSAO', 'DT_INCLUSAO',
      'DATACRIACAO', 'DT_CRIACAO',
      'DATA_ENT', 'DATAENT', 'DT_ENT', 'DATA_ENTRADA', 'DATAENTRADA', 'DT_ENTRADA',
      'CREATED_AT', 'CRIADO_EM',
    ];
    this._cadCol = (await this.pickCol(candidatas)) || null;
    if (this._cadCol) {
      this.logger.log(`[erp] coluna de data cadastro detectada: ${this._cadCol}`);
    }
    return this._cadCol;
  }

  /**
   * Converte filtro de ano (`pre2020`, `2021`, `2022`...) em condição SQL
   * + bind params. Retorna `{ cond: '', params: [] }` se não tiver coluna
   * de data ou filtro vazio.
   */
  private async buildYearFilter(
    year: string | undefined,
    pAlias: string,
  ): Promise<{ cond: string; params: any[] }> {
    if (!year) return { cond: '', params: [] };
    const dataCol = await this.getCadastroDateCol();
    if (!dataCol) return { cond: '', params: [] };
    const colRef = `${pAlias}.\`${dataCol}\``;
    if (year === 'pre2020') {
      return { cond: `${colRef} < ?`, params: ['2021-01-01'] };
    }
    const y = parseInt(year, 10);
    if (isNaN(y) || y < 2000 || y > 2100) return { cond: '', params: [] };
    return {
      cond: `${colRef} >= ? AND ${colRef} < ?`,
      params: [`${y}-01-01`, `${y + 1}-01-01`],
    };
  }

  /**
   * Estoque atual em PEÇAS por loja (somatório de ESTOQUE > 0).
   * Filtra opcionalmente só PLUS SIZE e/ou por ANO DE CADASTRO da peça.
   *
   * Retorna Map<storeCode, totalPecas>. Lojas sem estoque NÃO aparecem (caller trata como 0).
   */
  async getStockTotalByStores(
    plusSize = false,
    year?: string,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.pool) return out;
    try {
      const yf = await this.buildYearFilter(year, 'p');
      const needsJoin = plusSize || yf.cond;
      const conds: string[] = ['e.ESTOQUE > 0'];
      if (plusSize) conds.push(`UPPER(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAO, '')) LIKE '%PLUS SIZE%'`);
      if (yf.cond) conds.push(yf.cond);

      const sql = needsJoin
        ? `SELECT e.LOJA AS storeCode, SUM(e.ESTOQUE) AS pecas
             FROM estoque e
             INNER JOIN produtos p ON p.CODIGO = e.CODIGO
            WHERE ${conds.join(' AND ')}
            GROUP BY e.LOJA`
        : `SELECT LOJA AS storeCode, SUM(ESTOQUE) AS pecas
             FROM estoque
            WHERE ESTOQUE > 0
            GROUP BY LOJA`;
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, yf.params);
      for (const r of rows as any[]) {
        const code = String(r.storeCode || '').trim();
        const pecas = Number(r.pecas) || 0;
        if (code && pecas > 0) out.set(code, pecas);
      }
      return out;
    } catch (e) {
      this.logger.error(`getStockTotalByStores falhou: ${(e as Error).message}`);
      return out;
    }
  }

  /**
   * Vendas por loja num período (data inicio/fim half-open: >= inicio, < fim).
   * Retorna peças vendidas + valor bruto. Ignora MARCADO='SIM'.
   * Filtros opcionais: PLUS SIZE + ANO DE CADASTRO da peça.
   * Quando há filtro de plusSize ou year, faz JOIN com `produtos`.
   */
  async getSalesByStoresInRange(
    inicio: Date,
    fim: Date,
    plusSize = false,
    year?: string,
  ): Promise<Map<string, { pecas: number; valor: number }>> {
    const out = new Map<string, { pecas: number; valor: number }>();
    if (!this.pool) return out;
    try {
      const yf = await this.buildYearFilter(year, 'p');
      const needsJoin = plusSize || yf.cond;
      const conds: string[] = [
        'c.DATA >= ?',
        'c.DATA < ?',
        "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
      ];
      const params: any[] = [inicio, fim];
      if (plusSize) conds.push(`UPPER(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAO, '')) LIKE '%PLUS SIZE%'`);
      if (yf.cond) {
        conds.push(yf.cond);
        params.push(...yf.params);
      }

      // BUG FIX padding: ignora zeros à esquerda no JOIN caixa×produtos
      const sql = needsJoin
        ? `SELECT c.LOJA AS storeCode,
                  SUM(c.QUANTIDADE) AS pecas,
                  SUM(c.VALORTOTAL) AS valor
             FROM caixa c
             INNER JOIN produtos p ON CAST(p.CODIGO AS UNSIGNED) = CAST(c.CODIGO AS UNSIGNED)
            WHERE ${conds.join(' AND ')}
            GROUP BY c.LOJA`
        : `SELECT c.LOJA AS storeCode,
                  SUM(c.QUANTIDADE) AS pecas,
                  SUM(c.VALORTOTAL) AS valor
             FROM caixa c
            WHERE ${conds.join(' AND ')}
            GROUP BY c.LOJA`;
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      for (const r of rows as any[]) {
        const code = String(r.storeCode || '').trim();
        if (!code) continue;
        out.set(code, {
          pecas: Number(r.pecas) || 0,
          valor: Number(r.valor) || 0,
        });
      }
      return out;
    } catch (e) {
      this.logger.error(`getSalesByStoresInRange falhou: ${(e as Error).message}`);
      return out;
    }
  }

  /**
   * TOP REFs vendidas no período. Pode ser:
   *   - Toda a rede (storeCode null) ou loja específica
   *   - Ordenadas por peças OU por valor
   *   - Filtro PLUS SIZE
   *
   * Junta `caixa` com `produtos` pra resolver REF (CODIGO no caixa = SKU).
   * Retorna até `limit` linhas.
   */
  async getTopRefsBySales(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
    plusSize?: boolean;
    orderBy?: 'pecas' | 'valor';
    limit?: number;
  }): Promise<Array<{ refCode: string; descricao: string | null; pecas: number; valor: number }>> {
    if (!this.pool) return [];
    const orderBy = input.orderBy === 'valor' ? 'valor' : 'pecas';
    const limit = Math.max(1, Math.min(100, input.limit || 10));

    // Otimização: agrega `caixa` por CODIGO PRIMEIRO (subquery filtrada),
    // depois faz JOIN com produtos. Reduz drasticamente o tamanho do JOIN.
    const caixaConds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const caixaParams: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      caixaConds.push('c.LOJA = ?');
      caixaParams.push(input.storeCode);
    }

    const prodConds: string[] = ['p.REF IS NOT NULL', "p.REF <> ''"];
    if (input.plusSize) {
      prodConds.push("UPPER(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAO, '')) LIKE '%PLUS SIZE%'");
    }

    // BUG FIX padding: caixa.CODIGO e produtos.CODIGO podem ter padding
    // diferente (ex: "5358458" vs "0005358458"). Compara como UNSIGNED INT
    // pra ignorar zeros à esquerda. Mesmo problema do getStock.
    const sql = `
      SELECT p.REF AS refCode,
             MAX(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAO)) AS descricao,
             SUM(agg.pecas) AS pecas,
             SUM(agg.valor) AS valor
        FROM (
          SELECT c.CODIGO AS codigo,
                 SUM(c.QUANTIDADE) AS pecas,
                 SUM(c.VALORTOTAL) AS valor
            FROM caixa c
           WHERE ${caixaConds.join(' AND ')}
           GROUP BY c.CODIGO
        ) agg
        INNER JOIN produtos p ON CAST(p.CODIGO AS UNSIGNED) = CAST(agg.codigo AS UNSIGNED)
       WHERE ${prodConds.join(' AND ')}
       GROUP BY p.REF
       ORDER BY ${orderBy} DESC
       LIMIT ${limit}
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, caixaParams);
      return (rows as any[]).map((r) => ({
        refCode: String(r.refCode).trim(),
        descricao: r.descricao ? String(r.descricao).trim() : null,
        pecas: Number(r.pecas) || 0,
        valor: Number(r.valor) || 0,
      }));
    } catch (e) {
      this.logger.error(`getTopRefsBySales falhou: ${(e as Error).message}`);
      return []; // não throw — não quebra o Promise.all do getStoreDetail
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RELATÓRIO DE VENDAS — usado pela /retaguarda/inteligencia-vendas
  // ═══════════════════════════════════════════════════════════════════════

  /** Cache do mapeamento dinâmico de colunas das tabelas caixa/produtos */
  private salesColMap: {
    vendedor: string | null;
    marca: string | null;
    numCupom: string | null;
  } | null = null;

  /**
   * Detecta colunas dinâmicas relevantes pra relatório de vendas:
   *  - VENDEDOR na tabela `caixa` (ou `funcionario`, `vendedor_codigo`)
   *  - MARCA na tabela `produtos` (ou `fabricante`, `griffe`)
   *  - NUMCUPOM/CUPOM/NUMVENDA na tabela caixa pra contar quantas vendas
   * Cache em memória — detecta 1× e reaproveita.
   */
  private async detectSalesColumns(): Promise<{
    vendedor: string | null;
    marca: string | null;
    numCupom: string | null;
  }> {
    if (this.salesColMap) return this.salesColMap;
    let vendedor: string | null = null;
    let marca: string | null = null;
    let numCupom: string | null = null;
    try {
      const caixaSchema = await this.getTableSchema('caixa', 1);
      if (caixaSchema) {
        const cols = caixaSchema.columns.map((c: any) => c.field);
        vendedor = cols.find((c: string) =>
          /^vendedor$/i.test(c) || /^vendedora$/i.test(c) ||
          /^cod_?vendedor$/i.test(c) || /^funcionario$/i.test(c) ||
          /^cod_?func/i.test(c)
        ) || null;
        numCupom = cols.find((c: string) =>
          /^num_?cupom$/i.test(c) || /^cupom$/i.test(c) ||
          /^num_?venda$/i.test(c) || /^numero?_?venda$/i.test(c) ||
          /^numero?_?cupom$/i.test(c) || /^cupom_?fiscal$/i.test(c)
        ) || null;
      }
      const prodSchema = await this.getTableSchema('produtos', 1);
      if (prodSchema) {
        const cols = prodSchema.columns.map((c: any) => c.field);
        marca = cols.find((c: string) =>
          /^marca$/i.test(c) || /^fabricante$/i.test(c) ||
          /^griffe$/i.test(c) || /^grife$/i.test(c)
        ) || null;
      }
    } catch (e: any) {
      this.logger.warn(`detectSalesColumns falhou: ${e?.message}`);
    }
    this.salesColMap = { vendedor, marca, numCupom };
    this.logger.log(`detectSalesColumns: ${JSON.stringify(this.salesColMap)}`);
    return this.salesColMap;
  }

  /**
   * SUMMARY — totais agregados do período. Retorna peças, valor, número
   * de cupons distintos (vendas), ticket médio.
   */
  async getSalesSummary(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
  }): Promise<{ pecas: number; valor: number; vendas: number; ticketMedio: number }> {
    if (!this.pool) return { pecas: 0, valor: 0, vendas: 0, ticketMedio: 0 };
    const { numCupom } = await this.detectSalesColumns();
    const conds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const params: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const cupomSelect = numCupom
      ? `COUNT(DISTINCT CONCAT(c.LOJA, '-', c.\`${numCupom}\`)) AS vendas`
      : `COUNT(DISTINCT CONCAT(c.LOJA, '-', DATE(c.DATA), '-', COALESCE(c.CODCLIENTE, 0))) AS vendas`;
    const sql = `
      SELECT SUM(c.QUANTIDADE) AS pecas,
             SUM(c.VALORTOTAL) AS valor,
             ${cupomSelect}
        FROM caixa c
       WHERE ${conds.join(' AND ')}
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      const r: any = (rows as any[])[0] || {};
      const pecas = Number(r.pecas) || 0;
      const valor = Number(r.valor) || 0;
      const vendas = Number(r.vendas) || 0;
      return {
        pecas,
        valor,
        vendas,
        ticketMedio: vendas > 0 ? valor / vendas : 0,
      };
    } catch (e) {
      this.logger.error(`getSalesSummary falhou: ${(e as Error).message}`);
      return { pecas: 0, valor: 0, vendas: 0, ticketMedio: 0 };
    }
  }

  /** Vendas agrupadas POR DIA — pra gráfico de linha/barra. */
  async getSalesByDay(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
  }): Promise<Array<{ date: string; pecas: number; valor: number }>> {
    if (!this.pool) return [];
    const conds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const params: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const sql = `
      SELECT DATE(c.DATA) AS d,
             SUM(c.QUANTIDADE) AS pecas,
             SUM(c.VALORTOTAL) AS valor
        FROM caixa c
       WHERE ${conds.join(' AND ')}
       GROUP BY DATE(c.DATA)
       ORDER BY d ASC
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      return (rows as any[]).map((r) => ({
        date: r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10),
        pecas: Number(r.pecas) || 0,
        valor: Number(r.valor) || 0,
      }));
    } catch (e) {
      this.logger.error(`getSalesByDay falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * TOP VENDEDORAS — agrupado por código (e nome se a tabela funcionarios
   * existir e tiver coluna nome). Calcula valor + qtd peças + número de
   * vendas distintas.
   */
  async getTopVendedoras(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
    limit?: number;
  }): Promise<Array<{ codigo: string; nome: string; pecas: number; valor: number; vendas: number }>> {
    if (!this.pool) return [];
    const { vendedor: vendedorCol, numCupom } = await this.detectSalesColumns();
    if (!vendedorCol) {
      this.logger.warn('getTopVendedoras: coluna VENDEDOR não detectada na caixa');
      return [];
    }
    const limit = Math.max(1, Math.min(100, input.limit || 20));
    const conds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
      `c.\`${vendedorCol}\` IS NOT NULL`,
    ];
    const params: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const cupomCount = numCupom
      ? `COUNT(DISTINCT CONCAT(c.LOJA, '-', c.\`${numCupom}\`))`
      : `COUNT(DISTINCT CONCAT(c.LOJA, '-', DATE(c.DATA), '-', COALESCE(c.CODCLIENTE, 0)))`;

    // Tenta JOIN com `funcionarios` pra trazer nome — se a tabela não existir
    // ou não tiver coluna nome, faz só agregação por código.
    let sqlWithJoin: string | null = null;
    try {
      const funcSchema = await this.getTableSchema('funcionarios', 1);
      if (funcSchema) {
        const cols = funcSchema.columns.map((c: any) => c.field);
        const codCol = cols.find((c: string) => /^codigo$/i.test(c) || /^cod/i.test(c) || /^id$/i.test(c));
        const nomeCol = cols.find((c: string) => /^nome$/i.test(c));
        if (codCol && nomeCol) {
          sqlWithJoin = `
            SELECT CONCAT('', c.\`${vendedorCol}\`) AS codigo,
                   MAX(f.\`${nomeCol}\`) AS nome,
                   SUM(c.QUANTIDADE) AS pecas,
                   SUM(c.VALORTOTAL) AS valor,
                   ${cupomCount} AS vendas
              FROM caixa c
              LEFT JOIN funcionarios f ON CONCAT('', f.\`${codCol}\`) = CONCAT('', c.\`${vendedorCol}\`)
             WHERE ${conds.join(' AND ')}
             GROUP BY CONCAT('', c.\`${vendedorCol}\`)
             ORDER BY valor DESC
             LIMIT ${limit}
          `;
        }
      }
    } catch {/* funcionarios não existe — sem JOIN */}

    const sql = sqlWithJoin || `
      SELECT CONCAT('', c.\`${vendedorCol}\`) AS codigo,
             '' AS nome,
             SUM(c.QUANTIDADE) AS pecas,
             SUM(c.VALORTOTAL) AS valor,
             ${cupomCount} AS vendas
        FROM caixa c
       WHERE ${conds.join(' AND ')}
       GROUP BY CONCAT('', c.\`${vendedorCol}\`)
       ORDER BY valor DESC
       LIMIT ${limit}
    `;

    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      return (rows as any[]).map((r) => ({
        codigo: String(r.codigo || '').trim(),
        nome: String(r.nome || '').trim(),
        pecas: Number(r.pecas) || 0,
        valor: Number(r.valor) || 0,
        vendas: Number(r.vendas) || 0,
      }));
    } catch (e) {
      this.logger.error(`getTopVendedoras falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Total faturado em UM MÊS específico de UM ANO específico.
   * Usado pra montar gráfico "últimos N anos no mesmo mês".
   */
  async getMonthSalesByYear(input: {
    year: number;
    month: number; // 1-12
    storeCode?: string | null;
  }): Promise<{ pecas: number; valor: number }> {
    if (!this.pool) return { pecas: 0, valor: 0 };
    const inicio = new Date(input.year, input.month - 1, 1);
    const fim = new Date(input.year, input.month, 1);
    const conds: string[] = [
      'c.DATA >= ?', 'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const params: any[] = [inicio, fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const sql = `SELECT SUM(c.QUANTIDADE) AS pecas, SUM(c.VALORTOTAL) AS valor FROM caixa c WHERE ${conds.join(' AND ')}`;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      const r: any = (rows as any[])[0] || {};
      return { pecas: Number(r.pecas) || 0, valor: Number(r.valor) || 0 };
    } catch (e) {
      this.logger.warn(`getMonthSalesByYear ${input.year}/${input.month} falhou`);
      return { pecas: 0, valor: 0 };
    }
  }

  /**
   * Vendas por MÊS nos últimos N meses. Pra gráfico de linha
   * "evolução mensal últimos 12 meses".
   */
  async getSalesByMonth(input: {
    months: number;
    storeCode?: string | null;
  }): Promise<Array<{ year: number; month: number; pecas: number; valor: number }>> {
    if (!this.pool) return [];
    const months = Math.max(1, Math.min(36, input.months));
    const out: Array<{ year: number; month: number; pecas: number; valor: number }> = [];
    const now = new Date();

    // Promise.all com N queries seria mais rápido mas pode estourar conexão.
    // Uma só query com agregação por YEAR/MONTH é melhor.
    const inicio = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
    const fim = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const conds: string[] = [
      'c.DATA >= ?', 'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const params: any[] = [inicio, fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const sql = `
      SELECT YEAR(c.DATA) AS y, MONTH(c.DATA) AS m,
             SUM(c.QUANTIDADE) AS pecas,
             SUM(c.VALORTOTAL) AS valor
        FROM caixa c
       WHERE ${conds.join(' AND ')}
       GROUP BY YEAR(c.DATA), MONTH(c.DATA)
       ORDER BY y ASC, m ASC
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      // Preenche todos os meses (mesmo zero) pra gráfico ficar contínuo
      const map = new Map<string, any>();
      for (const r of rows as any[]) {
        map.set(`${r.y}-${r.m}`, { pecas: Number(r.pecas) || 0, valor: Number(r.valor) || 0 });
      }
      for (let i = months - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const k = `${d.getFullYear()}-${d.getMonth() + 1}`;
        const v = map.get(k) || { pecas: 0, valor: 0 };
        out.push({ year: d.getFullYear(), month: d.getMonth() + 1, pecas: v.pecas, valor: v.valor });
      }
      return out;
    } catch (e) {
      this.logger.warn(`getSalesByMonth falhou: ${(e as Error).message}`);
      return out;
    }
  }

  /**
   * Quantidade de clientes únicos no período (CODCLIENTE distinct).
   */
  async getUniqueClientesCount(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
  }): Promise<number> {
    if (!this.pool) return 0;
    const conds: string[] = [
      'c.DATA >= ?', 'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
      'c.CODCLIENTE IS NOT NULL',
      'c.CODCLIENTE > 0',
    ];
    const params: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      conds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    const sql = `SELECT COUNT(DISTINCT c.CODCLIENTE) AS clientes FROM caixa c WHERE ${conds.join(' AND ')}`;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      return Number((rows as any[])[0]?.clientes) || 0;
    } catch {
      return 0;
    }
  }

  /** TOP MARCAS — agrupa por coluna MARCA da tabela produtos. */
  async getTopMarcas(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
    limit?: number;
  }): Promise<Array<{ marca: string; pecas: number; valor: number }>> {
    if (!this.pool) return [];
    const { marca: marcaCol } = await this.detectSalesColumns();
    if (!marcaCol) {
      this.logger.warn('getTopMarcas: coluna MARCA não detectada em produtos');
      return [];
    }
    const limit = Math.max(1, Math.min(100, input.limit || 15));
    const caixaConds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const params: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      caixaConds.push('c.LOJA = ?');
      params.push(input.storeCode);
    }
    // BUG FIX padding: ignora zeros à esquerda no JOIN caixa×produtos
    const sql = `
      SELECT UPPER(TRIM(p.\`${marcaCol}\`)) AS marca,
             SUM(agg.pecas) AS pecas,
             SUM(agg.valor) AS valor
        FROM (
          SELECT c.CODIGO,
                 SUM(c.QUANTIDADE) AS pecas,
                 SUM(c.VALORTOTAL) AS valor
            FROM caixa c
           WHERE ${caixaConds.join(' AND ')}
           GROUP BY c.CODIGO
        ) agg
        INNER JOIN produtos p ON CAST(p.CODIGO AS UNSIGNED) = CAST(agg.CODIGO AS UNSIGNED)
       WHERE p.\`${marcaCol}\` IS NOT NULL AND TRIM(p.\`${marcaCol}\`) <> ''
       GROUP BY UPPER(TRIM(p.\`${marcaCol}\`))
       ORDER BY valor DESC
       LIMIT ${limit}
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      return (rows as any[]).map((r) => ({
        marca: String(r.marca || '').trim(),
        pecas: Number(r.pecas) || 0,
        valor: Number(r.valor) || 0,
      }));
    } catch (e) {
      this.logger.error(`getTopMarcas falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * RUPTURAS — REFs que VENDERAM no período mas estão com estoque ZERO HOJE.
   * Sinaliza necessidade de reposição urgente.
   *
   * Pode ser global (storeCode null) ou por loja. Retorna até `limit`.
   *
   * Lógica: agrega vendas por REF no período, faz LEFT JOIN com estoque
   * (somando todas as lojas se global, só a loja se específico) e filtra
   * onde estoque atual = 0.
   */
  async getRupturas(input: {
    inicio: Date;
    fim: Date;
    storeCode?: string | null;
    plusSize?: boolean;
    limit?: number;
  }): Promise<Array<{ refCode: string; descricao: string | null; pecasVendidas: number; estoqueAtual: number }>> {
    if (!this.pool) return [];
    const limit = Math.max(1, Math.min(100, input.limit || 10));
    // Otimização igual getTopRefsBySales: agrega caixa por CODIGO antes do JOIN.
    const caixaConds: string[] = [
      'c.DATA >= ?',
      'c.DATA < ?',
      "(c.MARCADO IS NULL OR c.MARCADO <> 'SIM')",
    ];
    const caixaParams: any[] = [input.inicio, input.fim];
    if (input.storeCode) {
      caixaConds.push('c.LOJA = ?');
      caixaParams.push(input.storeCode);
    }
    const prodConds: string[] = ['p.REF IS NOT NULL', "p.REF <> ''"];
    if (input.plusSize) {
      prodConds.push("UPPER(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAO, '')) LIKE '%PLUS SIZE%'");
    }

    // Subquery de estoque atual por REF
    const stockJoin = input.storeCode
      ? `LEFT JOIN (
            SELECT pr.REF AS ref, COALESCE(SUM(e.ESTOQUE), 0) AS qtd
              FROM estoque e
              INNER JOIN produtos pr ON pr.CODIGO = e.CODIGO
             WHERE e.LOJA = ?
             GROUP BY pr.REF
          ) est ON est.ref = p.REF`
      : `LEFT JOIN (
            SELECT pr.REF AS ref, COALESCE(SUM(e.ESTOQUE), 0) AS qtd
              FROM estoque e
              INNER JOIN produtos pr ON pr.CODIGO = e.CODIGO
             GROUP BY pr.REF
          ) est ON est.ref = p.REF`;
    const stockParams = input.storeCode ? [input.storeCode] : [];

    // BUG FIX padding: ignora zeros à esquerda no JOIN caixa×produtos
    const sql = `
      SELECT p.REF AS refCode,
             MAX(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAO)) AS descricao,
             SUM(agg.pecas) AS pecasVendidas,
             COALESCE(MAX(est.qtd), 0) AS estoqueAtual
        FROM (
          SELECT c.CODIGO AS codigo, SUM(c.QUANTIDADE) AS pecas
            FROM caixa c
           WHERE ${caixaConds.join(' AND ')}
           GROUP BY c.CODIGO
        ) agg
        INNER JOIN produtos p ON CAST(p.CODIGO AS UNSIGNED) = CAST(agg.codigo AS UNSIGNED)
        ${stockJoin}
       WHERE ${prodConds.join(' AND ')}
       GROUP BY p.REF
      HAVING estoqueAtual = 0 AND pecasVendidas > 0
       ORDER BY pecasVendidas DESC
       LIMIT ${limit}
    `;
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [...stockParams, ...caixaParams]);
      return (rows as any[]).map((r) => ({
        refCode: String(r.refCode).trim(),
        descricao: r.descricao ? String(r.descricao).trim() : null,
        pecasVendidas: Number(r.pecasVendidas) || 0,
        estoqueAtual: Number(r.estoqueAtual) || 0,
      }));
    } catch (e) {
      this.logger.error(`getRupturas falhou: ${(e as Error).message}`);
      return []; // não throw — não quebra o Promise.all
    }
  }

  /**
   * PARADOS — REFs com estoque alto mas SEM venda há N dias (default 30).
   * Candidatos a realinhamento (mandar pra loja que vende mais essa REF).
   *
   * Lógica:
   *   1. Pega REFs com SUM(estoque) >= minStock (default 5)
   *   2. Exclui as que tiveram venda nos últimos N dias
   *   3. Ordena por estoque desc
   */
  async getParados(input: {
    storeCode?: string | null;
    daysSemVenda?: number;
    minStock?: number;
    plusSize?: boolean;
    limit?: number;
  }): Promise<Array<{ refCode: string; descricao: string | null; estoqueAtual: number; ultimaVenda: string | null }>> {
    if (!this.pool) return [];
    const days = Math.max(1, Math.min(365, input.daysSemVenda || 30));
    const minStock = Math.max(1, input.minStock || 5);
    const limit = Math.max(1, Math.min(100, input.limit || 10));
    const stockConds: string[] = ['e.ESTOQUE > 0'];
    const stockParams: any[] = [];
    if (input.storeCode) {
      stockConds.push('e.LOJA = ?');
      stockParams.push(input.storeCode);
    }
    if (input.plusSize) {
      stockConds.push("UPPER(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAO, '')) LIKE '%PLUS SIZE%'");
    }
    const salesJoinFilter = input.storeCode ? 'AND c2.LOJA = ?' : '';
    const salesParams = input.storeCode ? [input.storeCode] : [];

    // BUG FIX padding: ignora zeros à esquerda nos JOINs caixa/estoque×produtos
    const sql = `
      SELECT p.REF AS refCode,
             MAX(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAO)) AS descricao,
             SUM(e.ESTOQUE) AS estoqueAtual,
             (SELECT MAX(c2.DATA) FROM caixa c2
                INNER JOIN produtos p2 ON CAST(p2.CODIGO AS UNSIGNED) = CAST(c2.CODIGO AS UNSIGNED)
               WHERE p2.REF = p.REF
                 AND (c2.MARCADO IS NULL OR c2.MARCADO <> 'SIM')
                 ${salesJoinFilter}
             ) AS ultimaVenda
        FROM estoque e
        INNER JOIN produtos p ON CAST(p.CODIGO AS UNSIGNED) = CAST(e.CODIGO AS UNSIGNED)
       WHERE ${stockConds.join(' AND ')}
       GROUP BY p.REF
      HAVING estoqueAtual >= ?
         AND (ultimaVenda IS NULL OR ultimaVenda < DATE_SUB(CURDATE(), INTERVAL ? DAY))
       ORDER BY estoqueAtual DESC
       LIMIT ?
    `;
    try {
      const params = [...stockParams, ...salesParams, minStock, days, limit];
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
      return (rows as any[]).map((r) => ({
        refCode: String(r.refCode).trim(),
        descricao: r.descricao ? String(r.descricao).trim() : null,
        estoqueAtual: Number(r.estoqueAtual) || 0,
        ultimaVenda: r.ultimaVenda
          ? r.ultimaVenda instanceof Date
            ? r.ultimaVenda.toISOString().slice(0, 10)
            : String(r.ultimaVenda).slice(0, 10)
          : null,
      }));
    } catch (e) {
      this.logger.error(`getParados falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * HEATMAP REF × LOJA — matriz de estoque pra visualização cruzada.
   * Pega top N REFs com maior estoque total (rede) e mostra distribuição
   * por loja. Útil pra decidir realinhamento manualmente.
   *
   * Retorna `{ refs: [{refCode, descricao, totalRede}], lojas: [storeCode],
   *   matrix: { [refCode]: { [storeCode]: qtd } } }`
   */
  async getHeatmap(input: {
    plusSize?: boolean;
    limitRefs?: number;
  }): Promise<{
    refs: Array<{ refCode: string; descricao: string | null; totalRede: number }>;
    lojas: string[];
    matrix: Record<string, Record<string, number>>;
  }> {
    const empty = { refs: [], lojas: [], matrix: {} };
    if (!this.pool) return empty;
    const limit = Math.max(1, Math.min(50, input.limitRefs || 20));

    // 1. Pega top REFs por estoque total
    const topConds: string[] = ['e.ESTOQUE > 0'];
    if (input.plusSize) {
      topConds.push("UPPER(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAO, '')) LIKE '%PLUS SIZE%'");
    }
    const topSql = `
      SELECT p.REF AS refCode,
             MAX(COALESCE(p.DESCRICAOCOMPLETA, p.DESCRICAO)) AS descricao,
             SUM(e.ESTOQUE) AS totalRede
        FROM estoque e
        INNER JOIN produtos p ON p.CODIGO = e.CODIGO
       WHERE ${topConds.join(' AND ')}
         AND p.REF IS NOT NULL AND p.REF <> ''
       GROUP BY p.REF
       ORDER BY totalRede DESC
       LIMIT ?
    `;
    try {
      const [topRows] = await this.pool.query<mysql.RowDataPacket[]>(topSql, [limit]);
      const refs = (topRows as any[]).map((r) => ({
        refCode: String(r.refCode).trim(),
        descricao: r.descricao ? String(r.descricao).trim() : null,
        totalRede: Number(r.totalRede) || 0,
      }));
      if (!refs.length) return empty;

      const refCodes = refs.map((r) => r.refCode);

      // 2. Distribuição por loja dessas REFs
      const distSql = `
        SELECT p.REF AS refCode,
               e.LOJA AS storeCode,
               SUM(e.ESTOQUE) AS qtd
          FROM estoque e
          INNER JOIN produtos p ON p.CODIGO = e.CODIGO
         WHERE p.REF IN (?)
           AND e.ESTOQUE > 0
         GROUP BY p.REF, e.LOJA
      `;
      const [distRows] = await this.pool.query<mysql.RowDataPacket[]>(distSql, [refCodes]);

      const matrix: Record<string, Record<string, number>> = {};
      const lojasSet = new Set<string>();
      for (const ref of refs) matrix[ref.refCode] = {};
      for (const r of distRows as any[]) {
        const ref = String(r.refCode).trim();
        const code = String(r.storeCode).trim();
        const qtd = Number(r.qtd) || 0;
        if (!matrix[ref]) matrix[ref] = {};
        matrix[ref][code] = qtd;
        lojasSet.add(code);
      }
      const lojas = Array.from(lojasSet).sort();
      return { refs, lojas, matrix };
    } catch (e) {
      this.logger.error(`getHeatmap falhou: ${(e as Error).message}`);
      return empty;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TRIAGEM DO PROVADOR — auxiliares
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resolve um SKU (CODIGO Giga) pra dados completos do produto.
   *
   * Tolerante a zeros à esquerda e EANs:
   *   1. Tenta CODIGO exato
   *   2. Se não achar, tenta variantes com padding zero (5, 6, 7, 8, 13, 14 dígitos)
   *   3. Se não achar, delega pra findSkuByAnyEan (procura em EAN13, EAN, CODBARRAS, etc)
   *
   * Retorna null se nada bater.
   */
  async resolveSkuInfo(sku: string): Promise<{
    codigo: string;
    ref: string | null;
    cor: string | null;
    tamanho: string | null;
    descricao: string | null;
  } | null> {
    // Wrapper bulletproof — NUNCA propaga erro pra cima.
    // Qualquer erro de conexão / timeout / SQL → loga + retorna null.
    // Caller (triage, etc) trata null como "produto não cadastrado" e mostra
    // mensagem amigável em vez de 500.
    try {
      return await this._resolveSkuInfoInner(sku);
    } catch (e: any) {
      this.logger.error(`[resolveSkuInfo] erro fatal não tratado pra "${sku}": ${e?.message || e}`);
      return null;
    }
  }

  private async _resolveSkuInfoInner(sku: string): Promise<{
    codigo: string;
    ref: string | null;
    cor: string | null;
    tamanho: string | null;
    descricao: string | null;
  } | null> {
    if (!this.pool) return null;
    const s = String(sku || '').trim();
    if (!s) return null;

    // Helper: query produtos por CODIGO exato (com lista de candidatos).
    // Usa só DESCRICAOCOMPLETA (DESCRICAO não existe no Giga).
    // Captura erro pra não derrubar a chain inteira (erros transitórios de MySQL
    // viravam 500 no /triage/suggest quando bipava EAN13).
    const tryCodigos = async (candidates: string[]): Promise<any | null> => {
      if (!candidates.length) return null;
      try {
        const [rows] = await this.pool!.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO AS codigo,
                  REF AS ref,
                  COR AS cor,
                  TAMANHO AS tamanho,
                  DESCRICAOCOMPLETA AS descricao
             FROM produtos
            WHERE CODIGO IN (?)
            LIMIT 1`,
          [candidates],
        );
        return (rows as any[])[0] || null;
      } catch (e: any) {
        this.logger.warn(`resolveSkuInfo tryCodigos falhou: ${e?.message || e}`);
        return null;
      }
    };

    // 1. Tenta exato + variantes com zero-padding comuns
    const variants = new Set<string>([s]);
    const stripped = s.replace(/^0+/, '');
    if (stripped) variants.add(stripped);
    if (/^\d+$/.test(s)) {
      // Padding completo de 3 até 14 dígitos (cobre qualquer formato Giga)
      for (let len = 3; len <= 14; len++) {
        if (s.length < len) variants.add(s.padStart(len, '0'));
      }
    }
    const list = Array.from(variants);

    let row = await tryCodigos(list);

    // 2. Fallback: tenta achar via colunas de EAN/barcode
    if (!row) {
      try {
        const codigoEncontrado = await this.findSkuByAnyEan(s);
        if (codigoEncontrado) {
          row = await tryCodigos([codigoEncontrado]);
        }
      } catch (e) {
        this.logger.warn(`resolveSkuInfo fallback EAN: ${(e as Error).message}`);
      }
    }

    if (!row) {
      this.logger.warn(`resolveSkuInfo: SKU "${s}" não bateu nem com variantes nem com EANs`);
      return null;
    }
    return {
      codigo: String(row.codigo).trim(),
      ref: row.ref ? String(row.ref).trim() : null,
      cor: row.cor ? String(row.cor).trim() : null,
      tamanho: row.tamanho ? String(row.tamanho).trim() : null,
      descricao: row.descricao ? String(row.descricao).trim() : null,
    };
  }

  /**
   * Diagnóstico de SKU bipado quando resolveSkuInfo retorna null.
   * Retorna sample de produtos com CODIGO/REF/DESCRICAO contendo o termo,
   * pra identificar como o "17" realmente aparece no Giga.
   */
  async diagnoseSku(sku: string): Promise<{
    sku: string;
    variantsTried: string[];
    matchesByCodigo: Array<{ codigo: string; ref: string | null; descricao: string | null }>;
    matchesByRef: Array<{ codigo: string; ref: string | null; descricao: string | null }>;
    matchesByEan: Array<{ codigo: string; ref: string | null; descricao: string | null; matchedColumn?: string }>;
    matchesByDescricao: Array<{ codigo: string; ref: string | null; descricao: string | null }>;
  }> {
    const empty = {
      sku,
      variantsTried: [],
      matchesByCodigo: [],
      matchesByRef: [],
      matchesByEan: [],
      matchesByDescricao: [],
    };
    if (!this.pool) return empty;
    const s = String(sku || '').trim();
    if (!s) return empty;

    // Variantes que seriam testadas pelo resolveSkuInfo
    const variants = new Set<string>([s]);
    const stripped = s.replace(/^0+/, '');
    if (stripped) variants.add(stripped);
    if (/^\d+$/.test(s)) {
      for (let len = 3; len <= 14; len++) {
        if (s.length < len) variants.add(s.padStart(len, '0'));
      }
    }
    const variantsTried = Array.from(variants);

    // Busca LIKE %sku% em CODIGO
    let matchesByCodigo: any[] = [];
    let matchesByRef: any[] = [];
    let matchesByDescricao: any[] = [];
    let matchesByEan: any[] = [];

    try {
      const [r1] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, REF, DESCRICAOCOMPLETA AS descricao
           FROM produtos WHERE CODIGO LIKE ? LIMIT 10`,
        [`%${s}%`],
      );
      matchesByCodigo = (r1 as any[]).map((r) => ({
        codigo: String(r.CODIGO).trim(),
        ref: r.REF ? String(r.REF).trim() : null,
        descricao: r.descricao ? String(r.descricao).trim() : null,
      }));
    } catch (e) {
      this.logger.warn(`diagnoseSku CODIGO LIKE: ${(e as Error).message}`);
    }

    try {
      const [r2] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO, REF, DESCRICAOCOMPLETA AS descricao
           FROM produtos WHERE REF LIKE ? LIMIT 10`,
        [`%${s}%`],
      );
      matchesByRef = (r2 as any[]).map((r) => ({
        codigo: String(r.CODIGO).trim(),
        ref: r.REF ? String(r.REF).trim() : null,
        descricao: r.descricao ? String(r.descricao).trim() : null,
      }));
    } catch (e) {
      this.logger.warn(`diagnoseSku REF LIKE: ${(e as Error).message}`);
    }

    // Procura nas colunas de EAN (exato com variantes)
    const eanColumns = ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS'];
    for (const col of eanColumns) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, REF, DESCRICAOCOMPLETA AS descricao
             FROM produtos WHERE \`${col}\` IN (?) LIMIT 5`,
          [variantsTried],
        );
        for (const r of rows as any[]) {
          matchesByEan.push({
            codigo: String(r.CODIGO).trim(),
            ref: r.REF ? String(r.REF).trim() : null,
            descricao: r.descricao ? String(r.descricao).trim() : null,
            matchedColumn: col,
          });
        }
      } catch {
        // coluna não existe — ignora
      }
    }

    // Busca por descrição parcial (último recurso)
    if (s.length >= 3) {
      try {
        const [r4] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO, REF, DESCRICAOCOMPLETA AS descricao
             FROM produtos WHERE COALESCE(DESCRICAOCOMPLETA, DESCRICAO) LIKE ? LIMIT 5`,
          [`%${s}%`],
        );
        matchesByDescricao = (r4 as any[]).map((r) => ({
          codigo: String(r.CODIGO).trim(),
          ref: r.REF ? String(r.REF).trim() : null,
          descricao: r.descricao ? String(r.descricao).trim() : null,
        }));
      } catch {
        /* noop */
      }
    }

    return {
      sku: s,
      variantsTried,
      matchesByCodigo,
      matchesByRef,
      matchesByEan,
      matchesByDescricao,
    };
  }

  /**
   * Busca direta no Giga pelo CODIGO de uma combinação REF + cor + tamanho.
   * Tolerante a TRIM, case e variações de espaço.
   *
   * Uso: na hora de fechar uma remessa de realinhamento, pegamos
   * REF/COR/TAM do TransferOrder e precisamos do CODIGO pra dar baixa
   * em estoque. Esse método resolve isso direto sem depender de searchByRef.
   *
   * Tenta em ordem:
   *   1. Match exato (case-insensitive + trim)
   *   2. Match com LIKE (cobre variações tipo "BEGE" vs "XADREZ BEGE")
   *   3. Match só por REF + tamanho (ignora cor — fallback)
   */
  async findCodigoByRefCorTam(
    refCode: string,
    cor: string | null,
    tamanho: string | null,
  ): Promise<string | null> {
    if (!this.pool || !refCode) return null;
    const ref = String(refCode).trim();
    const corClean = (cor || '').trim();
    const tamClean = (tamanho || '').trim();

    // 1. Match exato com TRIM e UPPER
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO FROM produtos
          WHERE TRIM(UPPER(REF)) = TRIM(UPPER(?))
            AND TRIM(UPPER(COALESCE(COR, ''))) = TRIM(UPPER(?))
            AND TRIM(UPPER(COALESCE(TAMANHO, ''))) = TRIM(UPPER(?))
          LIMIT 1`,
        [ref, corClean, tamClean],
      );
      if ((rows as any[]).length) {
        return String((rows as any[])[0].CODIGO).trim();
      }
    } catch (e) {
      this.logger.warn(`findCodigoByRefCorTam exato falhou: ${(e as Error).message}`);
    }

    // 2. Tenta com cor LIKE (pra casos "BEGE" vs "XADREZ BEGE")
    if (corClean) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM produtos
            WHERE TRIM(UPPER(REF)) = TRIM(UPPER(?))
              AND UPPER(COR) LIKE UPPER(?)
              AND TRIM(UPPER(COALESCE(TAMANHO, ''))) = TRIM(UPPER(?))
            LIMIT 1`,
          [ref, `%${corClean}%`, tamClean],
        );
        if ((rows as any[]).length) {
          return String((rows as any[])[0].CODIGO).trim();
        }
        // Tenta o reverso (cor cadastrada está dentro da bipada)
        const [rows2] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM produtos
            WHERE TRIM(UPPER(REF)) = TRIM(UPPER(?))
              AND ? LIKE CONCAT('%', UPPER(COR), '%')
              AND TRIM(UPPER(COALESCE(TAMANHO, ''))) = TRIM(UPPER(?))
            LIMIT 1`,
          [ref, corClean.toUpperCase(), tamClean],
        );
        if ((rows2 as any[]).length) {
          return String((rows2 as any[])[0].CODIGO).trim();
        }
      } catch (e) {
        this.logger.warn(`findCodigoByRefCorTam LIKE falhou: ${(e as Error).message}`);
      }
    }

    // 3. Último fallback: só REF + tamanho (ignora cor)
    if (tamClean) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM produtos
            WHERE TRIM(UPPER(REF)) = TRIM(UPPER(?))
              AND TRIM(UPPER(COALESCE(TAMANHO, ''))) = TRIM(UPPER(?))
            LIMIT 1`,
          [ref, tamClean],
        );
        if ((rows as any[]).length) {
          this.logger.warn(
            `findCodigoByRefCorTam: usando fallback REF+TAM (cor "${corClean}" ignorada) pra ${ref}/${tamClean}`,
          );
          return String((rows as any[])[0].CODIGO).trim();
        }
      } catch (e) {
        this.logger.warn(`findCodigoByRefCorTam fallback falhou: ${(e as Error).message}`);
      }
    }

    this.logger.warn(`findCodigoByRefCorTam: NADA encontrado pra REF=${ref} COR=${corClean} TAM=${tamClean}`);
    return null;
  }

  /**
   * Soma estoque de TODOS os SKUs cadastrados como mesma REF+COR+TAM em UMA loja.
   *
   * Por que isso existe: o Giga frequentemente tem múltiplos cadastros pra
   * exatamente a mesma peça (mesma REF+COR+TAM) com CODIGOs diferentes — porque
   * cada peça física entrou com etiqueta única (legado de cadastros manuais).
   *
   * `findCodigoByRefCorTam` retorna só UM SKU (LIMIT 1). Se esse SKU está zerado
   * em estoque mas OUTRO SKU da mesma peça tem estoque, a peça FÍSICA existe na
   * loja mas o sistema acha que não tem. Esse método resolve isso somando todos.
   *
   * Caso real (Lurd's): "13015 MARINHO 50" tem CODIGOs 5383672 e 5383665 cadastrados;
   * o precheck pegava o zerado e bloqueava a remessa mesmo tendo a peça física.
   */
  async getStockByRefCorTamInStore(
    refCode: string,
    cor: string | null,
    tamanho: string | null,
    storeCode: string,
  ): Promise<{ totalQty: number; codigos: string[] }> {
    if (!this.pool || !refCode || !storeCode) return { totalQty: 0, codigos: [] };
    const ref = String(refCode).trim();
    const corClean = (cor || '').trim();
    const tamClean = (tamanho || '').trim();

    try {
      // 1) Pega TODOS os CODIGOs cadastrados com essa REF+COR+TAM em produtos
      const [prodRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO FROM produtos
          WHERE TRIM(UPPER(REF)) = TRIM(UPPER(?))
            AND TRIM(UPPER(COALESCE(COR, ''))) = TRIM(UPPER(?))
            AND TRIM(UPPER(COALESCE(TAMANHO, ''))) = TRIM(UPPER(?))`,
        [ref, corClean, tamClean],
      );
      const codigosGiga = Array.from(
        new Set((prodRows as any[]).map((r) => String(r.CODIGO).trim()).filter(Boolean)),
      );
      if (!codigosGiga.length) return { totalQty: 0, codigos: [] };

      // 2) Expande padding (estoque pode ter outras formas: 5383672 e 0005383672)
      const allVariants = new Set<string>();
      for (const c of codigosGiga) {
        for (const v of this.skuVariants(c)) allVariants.add(v);
      }
      const variantsArr = Array.from(allVariants);

      // 3) SUM(ESTOQUE) com filtro >0 — mesmo padrão de getStockBySkusDetailed
      const [stockRows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT SUM(ESTOQUE) AS qty FROM estoque
          WHERE CODIGO IN (?)
            AND LOJA = ?
            AND ESTOQUE > 0`,
        [variantsArr, storeCode],
      );
      const totalQty = Math.max(0, Number((stockRows as any[])[0]?.qty ?? 0) || 0);
      return { totalQty, codigos: codigosGiga };
    } catch (e) {
      this.logger.warn(`getStockByRefCorTamInStore falhou: ${(e as Error).message}`);
      return { totalQty: 0, codigos: [] };
    }
  }

  /**
   * Estoque atual de UM SKU específico em N lojas. Retorna Map<storeCode, qty>.
   * Lojas sem o SKU (ou com 0) NÃO aparecem no map.
   */
  async getStockBySkuAndStores(sku: string, storeCodes: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.pool || !sku || !storeCodes.length) return out;
    const variants = this.skuVariants(sku);
    if (!variants.length) return out;
    try {
      // Soma tudo do SKU (todas as variantes de zero-padding) por loja.
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT LOJA AS storeCode, SUM(ESTOQUE) AS qty
           FROM estoque
          WHERE CODIGO IN (?)
            AND LOJA IN (?)
            AND ESTOQUE > 0
          GROUP BY LOJA`,
        [variants, storeCodes],
      );
      for (const r of rows as any[]) {
        const code = String(r.storeCode).trim();
        const qty = Number(r.qty) || 0;
        if (qty > 0) out.set(code, qty);
      }
      return out;
    } catch (e) {
      this.logger.error(`getStockBySkuAndStores falhou: ${(e as Error).message}`);
      return out;
    }
  }

  /**
   * PDV — busca info COMPLETA de produto pra venda (SKU/EAN bipado).
   *
   * Retorna tudo necessário pro carrinho + futuro NFC-e:
   *   sku, ean, ref, cor, tamanho, descricao, preco, ncm, cfop, custo
   *
   * Usa as MESMAS variantes de zero-padding + fallback EAN do resolveSkuInfo.
   * Detecta colunas dinamicamente (PRECO/PRECOVENDA/VALORVENDA, NCM, CFOP, etc).
   */
  async getPdvProductInfo(skuOrEan: string): Promise<{
    sku: string;
    ean: string | null;
    ref: string | null;
    cor: string | null;
    tamanho: string | null;
    descricao: string;
    preco: number;
    ncm: string | null;
    cfop: string | null;
    custo: number | null;
    dataCadastro: string | null;
  } | null> {
    if (!this.pool) return null;
    const s = String(skuOrEan || '').trim();
    if (!s) return null;

    // 1. Resolve SKU (já trata zero-padding + EAN fallback)
    const info = await this.resolveSkuInfo(s);
    if (!info) return null;

    // 2. Descobre colunas disponíveis na tabela produtos
    let priceCols: string[] = [];
    let costCol: string | null = null;
    let ncmCol: string | null = null;
    let cfopCol: string | null = null;
    let eanCol: string | null = null;
    let dataCol: string | null = null;
    let allColumnNames: string[] = [];
    try {
      const [cols] = await this.pool.query<mysql.RowDataPacket[]>('SHOW COLUMNS FROM produtos');
      allColumnNames = (cols as any[]).map((c) => String(c.Field));
      const names = new Set(allColumnNames.map((n) => n.toUpperCase()));

      // PREÇO — lista ampla de candidatos comuns + fallback dinâmico.
      // ORDEM IMPORTA: VENDAUN (Gigasistemas) é o oficial — fica primeiro.
      const priceCandidates = [
        'VENDAUN', 'VENDA_UN', 'VENDAUNIT',
        'PRECOVAREJO', 'PRECO_VAREJO', 'VALORVAREJO', 'VALOR_VAREJO',
        'PRECOVENDA', 'PRECO_VENDA', 'VALORVENDA', 'VALOR_VENDA',
        'PRECO1', 'PVENDA', 'PRECO', 'VALOR', 'PRC_VENDA', 'PRECOUNIT',
        'VALOR_UNITARIO', 'PRECOATUAL', 'PRECO_ATUAL',
      ];
      for (const c of priceCandidates) {
        if (names.has(c)) priceCols.push(c);
      }
      // Fallback: qualquer coluna com PREC ou VALOR no nome (que ainda não tá na lista)
      for (const n of allColumnNames) {
        const upper = n.toUpperCase();
        if (priceCols.includes(upper)) continue;
        if (upper.startsWith('CUSTO') || upper.includes('CUSTO')) continue;
        if (/^(PREC|PRC|VALOR|VL_|VLR_|VEN|VAR)/.test(upper)) {
          priceCols.push(n);
        }
      }
      // Custo
      for (const c of ['CUSTO', 'PRECOCUSTO', 'VALORCUSTO', 'CUSTO_MEDIO', 'CUSTOMEDIO']) {
        if (names.has(c)) { costCol = c; break; }
      }
      // NCM
      for (const c of ['NCM', 'CODIGONCM', 'COD_NCM']) {
        if (names.has(c)) { ncmCol = c; break; }
      }
      // CFOP
      for (const c of ['CFOP', 'CODCFOP', 'CFOP_PADRAO']) {
        if (names.has(c)) { cfopCol = c; break; }
      }
      // EAN
      for (const c of ['EAN13', 'EAN', 'CODBARRAS', 'CODIGOBARRAS', 'COD_BARRAS', 'CODIGO_BARRAS']) {
        if (names.has(c)) { eanCol = c; break; }
      }
      // Data de cadastro (usado pra promoções por ano)
      for (const c of ['DATAALT', 'DATACAD', 'DATA_CAD', 'DATACADASTRO', 'DATA_CADASTRO']) {
        if (names.has(c)) { dataCol = c; break; }
      }
      this.logger.log(
        `[pdv] Cols detectadas: preco=[${priceCols.join('|')}] custo=${costCol} ncm=${ncmCol} cfop=${cfopCol} ean=${eanCol} data=${dataCol}`,
      );
    } catch (e) {
      this.logger.warn(`getPdvProductInfo SHOW COLUMNS: ${(e as Error).message}`);
    }

    // 3. Monta SELECT dinâmico — traz TODAS as colunas de preço candidatas
    const selects = ['CODIGO AS codigo'];
    priceCols.forEach((c, i) => selects.push(`\`${c}\` AS preco_${i}`));
    if (costCol) selects.push(`\`${costCol}\` AS custo`);
    if (ncmCol) selects.push(`\`${ncmCol}\` AS ncm`);
    if (cfopCol) selects.push(`\`${cfopCol}\` AS cfop`);
    if (eanCol) selects.push(`\`${eanCol}\` AS ean`);
    if (dataCol) selects.push(`\`${dataCol}\` AS dataCadastro`);

    let extra: any = {};
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT ${selects.join(', ')} FROM produtos WHERE CODIGO = ? LIMIT 1`,
        [info.codigo],
      );
      const r = (rows as any[])[0];
      if (r) extra = r;
    } catch (e) {
      this.logger.warn(`getPdvProductInfo extra: ${(e as Error).message}`);
    }

    // Helper: parseia preço (string com vírgula vira número)
    const parsePrice = (v: any): number => {
      if (v == null) return 0;
      if (typeof v === 'number') return v;
      const s = String(v).trim().replace(/\./g, '').replace(',', '.');
      const n = Number(s);
      return isNaN(n) ? 0 : n;
    };

    // Colunas conhecidas que armazenam preço em CENTAVOS (precisa dividir por 100)
    // No Giga (Lurd's), VENDAUN é centavos: 25990 = R$ 259,90
    const isCentavos = (col: string): boolean => {
      const u = col.toUpperCase();
      return u === 'VENDAUN' || u === 'VENDA_UN' || u === 'VENDAUNIT';
    };

    // Pega o primeiro preço > 0 entre os candidatos
    let preco = 0;
    let precoFonte: string | null = null;
    for (let i = 0; i < priceCols.length; i++) {
      let v = parsePrice(extra[`preco_${i}`]);
      if (v > 0) {
        // Se a coluna armazena em centavos, divide por 100
        if (isCentavos(priceCols[i])) v = v / 100;
        preco = v;
        precoFonte = priceCols[i];
        break;
      }
    }

    // PLANO B: se não achou preço em produtos, busca último preço da tabela `caixa`
    // (último valor unitário praticado pra esse SKU em qualquer loja)
    if (preco <= 0) {
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT VALORTOTAL / NULLIF(QUANTIDADE, 0) AS unitario
             FROM caixa
            WHERE CODIGO = ?
              AND VALORTOTAL > 0
              AND QUANTIDADE > 0
              AND (MARCADO IS NULL OR MARCADO <> 'SIM')
            ORDER BY DATA DESC
            LIMIT 1`,
          [info.codigo],
        );
        const u = parsePrice((rows as any[])[0]?.unitario);
        if (u > 0) {
          preco = u;
          precoFonte = 'caixa.último_unitário';
          this.logger.log(`[pdv] Preço de ${info.codigo} via fallback caixa: R$${u.toFixed(2)}`);
        }
      } catch (e) {
        this.logger.warn(`getPdvProductInfo fallback caixa: ${(e as Error).message}`);
      }
    }

    if (preco > 0) {
      this.logger.log(`[pdv] Preço de ${info.codigo}: R$${preco.toFixed(2)} (fonte: ${precoFonte})`);
    }

    // Normaliza dataCadastro pra YYYY-MM-DD
    let dataCadastro: string | null = null;
    if (extra.dataCadastro) {
      try {
        const d = extra.dataCadastro instanceof Date
          ? extra.dataCadastro
          : new Date(String(extra.dataCadastro));
        if (!isNaN(d.getTime())) {
          dataCadastro = d.toISOString().slice(0, 10);
        }
      } catch { /* noop */ }
    }

    return {
      sku: info.codigo,
      ean: extra.ean ? String(extra.ean).trim() : null,
      ref: info.ref,
      cor: info.cor,
      tamanho: info.tamanho,
      descricao: info.descricao || `${info.ref || info.codigo} ${info.cor || ''} ${info.tamanho || ''}`.trim(),
      preco,
      ncm: extra.ncm ? String(extra.ncm).trim() : null,
      cfop: extra.cfop ? String(extra.cfop).trim() : null,
      custo: extra.custo != null ? parsePrice(extra.custo) : null,
      dataCadastro,
    };
  }

  /**
   * Vendas de uma REF (qualquer cor/tamanho) por loja nos últimos N dias.
   * Usado pra priorizar destino que mais vende essa REF.
   */
  async getRecentSalesByRefAndStores(
    refCode: string,
    storeCodes: string[],
    days = 30,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.pool || !refCode || !storeCodes.length) return out;
    const n = Math.max(1, Math.min(365, days || 30));
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT c.LOJA AS storeCode, SUM(c.QUANTIDADE) AS qty
           FROM caixa c
           INNER JOIN produtos p ON p.CODIGO = c.CODIGO
          WHERE p.REF = ?
            AND c.LOJA IN (?)
            AND c.DATA >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            AND (c.MARCADO IS NULL OR c.MARCADO <> 'SIM')
          GROUP BY c.LOJA`,
        [refCode, storeCodes, n],
      );
      for (const r of rows as any[]) {
        const code = String(r.storeCode).trim();
        const qty = Number(r.qty) || 0;
        if (qty > 0) out.set(code, qty);
      }
      return out;
    } catch (e) {
      this.logger.error(`getRecentSalesByRefAndStores falhou: ${(e as Error).message}`);
      return out;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CADASTRO DINÂMICO DE PRODUTOS (Cadastro Dinâmico → Wincred)
  //
  // Usado por /retaguarda/cadastro-produtos. Permite listar grupos,
  // subgrupos, cores, tamanhos, fornecedores existentes e inserir novos
  // produtos na tabela `produtos` (uma linha por combinação cor×tamanho).
  // INSERT controlado por ERP_WRITE_ENABLED — mesma flag do decreaseStock.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lista todos os grupos cadastrados no Wincred.
   * Tabela `grupos` (CODIGO PK + GRUPO nome).
   */
  async listarGrupos(): Promise<Array<{ codigo: number; nome: string }>> {
    if (!this.pool) return [];
    try {
      const [rows] = await this.pool.query(
        `SELECT CODIGO AS codigo, GRUPO AS nome
           FROM grupos
          WHERE CODIGO IS NOT NULL
          ORDER BY GRUPO`,
      );
      return (rows as any[]).map((r) => ({
        codigo: Number(r.codigo),
        nome: String(r.nome || '').trim() || `GRUPO-${r.codigo}`,
      })).filter((g) => g.codigo);
    } catch (e) {
      this.logger.error(`listarGrupos falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Lista subgrupos de um grupo específico.
   * Tabela `subgrupos` (CODIGO PK + SUBGRUPO nome + GRUPO FK).
   */
  async listarSubgrupos(grupoCodigo: number): Promise<Array<{ codigo: number; nome: string }>> {
    if (!this.pool) return [];
    try {
      const [rows] = await this.pool.query(
        `SELECT CODIGO AS codigo, SUBGRUPO AS nome
           FROM subgrupos
          WHERE GRUPO = ?
          ORDER BY SUBGRUPO`,
        [grupoCodigo],
      );
      return (rows as any[]).map((r) => ({
        codigo: Number(r.codigo),
        nome: String(r.nome || '').trim() || `SUBGRUPO-${r.codigo}`,
      })).filter((s) => s.codigo);
    } catch (e) {
      this.logger.error(`listarSubgrupos falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Cria um novo grupo no Wincred (tabela grupos).
   * Reserva próximo CODIGO via MAX+1 dentro de uma transação.
   */
  async inserirGrupo(nome: string): Promise<{ codigo: number; nome: string }> {
    if (!this.isWriteEnabled) {
      throw new Error('ERP_WRITE_ENABLED=false. Setar env=true pra criar grupo no Wincred.');
    }
    if (!this.pool) throw new Error('ERP MySQL não está conectado');
    const nomeNormalizado = String(nome || '').trim().toUpperCase().slice(0, 30);
    if (!nomeNormalizado) throw new Error('Nome do grupo vazio');

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [maxRows]: any = await conn.query(
        `SELECT COALESCE(MAX(CODIGO), 0) + 1 AS prox FROM grupos FOR UPDATE`,
      );
      const codigo = Number(maxRows[0]?.prox) || 1;
      await conn.query(
        `INSERT INTO grupos (CODIGO, GRUPO) VALUES (?, ?)`,
        [codigo, nomeNormalizado],
      );
      await conn.commit();
      return { codigo, nome: nomeNormalizado };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * Cria um novo subgrupo dentro de um grupo existente (tabela subgrupos).
   */
  async inserirSubgrupo(grupoCodigo: number, nome: string): Promise<{ codigo: number; nome: string; grupo: number }> {
    if (!this.isWriteEnabled) {
      throw new Error('ERP_WRITE_ENABLED=false. Setar env=true pra criar subgrupo no Wincred.');
    }
    if (!this.pool) throw new Error('ERP MySQL não está conectado');
    if (!grupoCodigo) throw new Error('grupoCodigo é obrigatório');
    const nomeNormalizado = String(nome || '').trim().toUpperCase().slice(0, 30);
    if (!nomeNormalizado) throw new Error('Nome do subgrupo vazio');

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [maxRows]: any = await conn.query(
        `SELECT COALESCE(MAX(CODIGO), 0) + 1 AS prox FROM subgrupos FOR UPDATE`,
      );
      const codigo = Number(maxRows[0]?.prox) || 1;
      await conn.query(
        `INSERT INTO subgrupos (CODIGO, SUBGRUPO, GRUPO) VALUES (?, ?, ?)`,
        [codigo, nomeNormalizado, grupoCodigo],
      );
      await conn.commit();
      return { codigo, nome: nomeNormalizado, grupo: grupoCodigo };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * Lista cores distintas usadas nos produtos. Útil pra preencher o modal
   * de cores com sugestões + permitir digitar nova.
   */
  async listarCoresDistintas(limit = 200): Promise<string[]> {
    if (!this.pool) return [];
    try {
      const [rows] = await this.pool.query(
        `SELECT COR, COUNT(*) AS qtd
           FROM produtos
          WHERE COR IS NOT NULL AND COR <> ''
          GROUP BY COR
          ORDER BY qtd DESC
          LIMIT ?`,
        [limit],
      );
      return (rows as any[]).map((r) => String(r.COR || '').trim()).filter(Boolean);
    } catch (e) {
      this.logger.error(`listarCoresDistintas falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Lista tamanhos distintos usados nos produtos. Útil pra preencher o modal
   * de tamanhos com sugestões.
   */
  async listarTamanhosDistintos(limit = 200): Promise<string[]> {
    if (!this.pool) return [];
    try {
      const [rows] = await this.pool.query(
        `SELECT TAMANHO, COUNT(*) AS qtd
           FROM produtos
          WHERE TAMANHO IS NOT NULL AND TAMANHO <> ''
          GROUP BY TAMANHO
          ORDER BY qtd DESC
          LIMIT ?`,
        [limit],
      );
      return (rows as any[]).map((r) => String(r.TAMANHO || '').trim()).filter(Boolean);
    } catch (e) {
      this.logger.error(`listarTamanhosDistintos falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Lista fornecedores cadastrados em produtos (CNPJ + nome se disponível).
   */
  async listarFornecedores(limit = 500): Promise<Array<{ cnpj: string; nome: string }>> {
    if (!this.pool) return [];
    try {
      // Tenta tabela fornecedores primeiro; se falhar, vai pra produtos
      try {
        const [rows] = await this.pool.query(
          `SELECT CGC AS cnpj, NOME AS nome
             FROM fornecedores
            WHERE NOME IS NOT NULL AND NOME <> ''
            ORDER BY NOME
            LIMIT ?`,
          [limit],
        );
        const result = (rows as any[]).map((r) => ({
          cnpj: String(r.cnpj || '').trim(),
          nome: String(r.nome || '').trim(),
        })).filter((f) => f.nome);
        if (result.length) return result;
      } catch {
        // ignora — vai pro fallback
      }
      const [rows] = await this.pool.query(
        `SELECT DISTINCT FORNECEDOR AS cnpj
           FROM produtos
          WHERE FORNECEDOR IS NOT NULL AND FORNECEDOR <> ''
          ORDER BY FORNECEDOR
          LIMIT ?`,
        [limit],
      );
      return (rows as any[]).map((r) => ({
        cnpj: String(r.cnpj || '').trim(),
        nome: String(r.cnpj || '').trim(),
      })).filter((f) => f.cnpj);
    } catch (e) {
      this.logger.error(`listarFornecedores falhou: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Pega o próximo CODIGO de grupo livre na tabela `grupos` (MAX+1).
   */
  async proximoGrupoCodigo(): Promise<number> {
    if (!this.pool) throw new Error('ERP MySQL não está conectado');
    const [rows] = await this.pool.query(
      `SELECT COALESCE(MAX(CODIGO), 0) + 1 AS proximo FROM grupos`,
    );
    return Number((rows as any[])[0]?.proximo) || 1;
  }

  /**
   * Verifica se um CODIGO já existe na tabela produtos.
   */
  async produtoExiste(codigo: string): Promise<boolean> {
    if (!this.pool) return false;
    const [rows] = await this.pool.query(
      `SELECT 1 FROM produtos WHERE CODIGO = ? LIMIT 1`,
      [codigo],
    );
    return (rows as any[]).length > 0;
  }

  /**
   * Insere N produtos na tabela `produtos` do Wincred em uma única
   * transação (ACID). Todos caem ou nada cai. Idempotência: se o CODIGO
   * já existir, ignora (insert ignore).
   *
   * Requer ERP_WRITE_ENABLED='true'. Senão lança erro sem tocar no banco.
   */
  async inserirProdutosBatch(produtos: Array<{
    codigo: string;
    grupo: number;
    nomeGrupo: string;
    subgrupo?: number;
    descricaoCompleta: string;
    descricaoPdv?: string;
    custo: number;
    precoVenda: number;
    margem: number;
    fornecedor: string;
    cor: string;
    tamanho: string;
    ref: string;
    plusSize: boolean;
    ncm?: string;
    cfop?: number;
    tributo?: string;
    marca?: string;
    estoqueInicial?: number;
  }>): Promise<{ inseridos: number; ignorados: number }> {
    if (!this.isWriteEnabled) {
      throw new Error('ERP_WRITE_ENABLED=false. Setar env=true pra liberar inserção em produtos.');
    }
    if (!this.pool) throw new Error('ERP MySQL não está conectado');
    if (!produtos.length) return { inseridos: 0, ignorados: 0 };

    const conn = await this.pool.getConnection();
    let inseridos = 0;
    let ignorados = 0;
    try {
      await conn.beginTransaction();
      for (const p of produtos) {
        // INSERT IGNORE: se CODIGO já existe (PK collision), ignora a linha
        // sem dar rollback do batch inteiro.
        const [result]: any = await conn.query(
          `INSERT IGNORE INTO produtos (
             CODIGO, GRUPO, NOMEGRUPO, DESCRICAOPDV, DESCRICAOCOMPLETA,
             CUSTO, VENDAUN, MARGEM, FORNECEDOR, UNIDADE, ESTOQUE,
             SUBGRUPO, COR, TAMANHO, MARCA, REF,
             TRIBUTO, NCM, PLUS_SIZE, CFOP, DATAALT, OPERADOR
           ) VALUES (
             ?, ?, ?, ?, ?,
             ?, ?, ?, ?, 'UN', ?,
             ?, ?, ?, ?, ?,
             ?, ?, ?, ?, CURDATE(), 'FLOWOPS'
           )`,
          [
            p.codigo,
            p.grupo,
            (p.nomeGrupo || '').slice(0, 30),
            (p.descricaoPdv || p.descricaoCompleta).slice(0, 50),
            p.descricaoCompleta.slice(0, 100),
            p.custo,
            p.precoVenda,
            p.margem,
            (p.fornecedor || '').slice(0, 18),
            p.estoqueInicial ?? 0,
            p.subgrupo ?? null,
            (p.cor || '').slice(0, 15),
            (p.tamanho || '').slice(0, 20),
            (p.marca || '').slice(0, 30),
            (p.ref || '').slice(0, 10),
            (p.tributo || '').slice(0, 4),
            (p.ncm || '').slice(0, 8),
            p.plusSize ? 1 : 0,
            p.cfop ?? null,
          ],
        );
        if (result.affectedRows && result.affectedRows > 0) inseridos++;
        else ignorados++;
      }
      await conn.commit();
      this.logger.log(`inserirProdutosBatch: ${inseridos} inseridos, ${ignorados} ignorados (já existiam)`);
      return { inseridos, ignorados };
    } catch (e) {
      await conn.rollback();
      this.logger.error(`inserirProdutosBatch falhou — rollback: ${(e as Error).message}`);
      throw e;
    } finally {
      conn.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PDV — Gravação de venda na tabela `caixa` do Wincred (gigasistemas21)
  //
  // Replica o que o PDV antigo do Wincred faz: 1 linha por ITEM da venda.
  // O número da venda (NUMERO) é compartilhado com o PDV antigo — usamos
  // MAX(NUMERO)+1 com FOR UPDATE pra evitar colisão.
  //
  // Modo SHADOW (PDV_ERP_WRITE_ENABLED=false, default): só LOGA os SQLs
  // que SERIAM executados, sem tocar no banco. Permite validar geração
  // de SQL antes de ligar real.
  //
  // Modo REAL (PDV_ERP_WRITE_ENABLED=true): executa em transação ACID.
  // Se qualquer item falhar → rollback total → retorna erro.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Busca o CODIGO de um funcionário no Wincred pelo nome (ou apelido)
   * filtrando pela loja. Usado pra preencher VENDEDOR/OPERADOR na tabela
   * `caixa` quando flowops PDV finaliza venda.
   *
   * Estratégia (em ordem de prioridade):
   * 1. APELIDO exato (case-insensitive) + LOJA
   * 2. NOME exato (case-insensitive) + LOJA
   * 3. Primeiro nome (até primeiro espaço) + LOJA
   * 4. APELIDO sem filtro de loja (fallback)
   *
   * Retorna 0 se não achou (caller deve aceitar 0 como "sem mapeamento").
   */
  async lookupFuncionarioCode(nome: string, lojaCode?: string): Promise<number> {
    if (!this.pool || !nome) return 0;
    const nomeNormalizado = String(nome).trim().toUpperCase();
    if (!nomeNormalizado) return 0;
    const loja = lojaCode ? String(lojaCode).padStart(2, '0').slice(-2) : null;
    const primeiroNome = nomeNormalizado.split(/\s+/)[0];

    try {
      // 1. Tenta APELIDO exato + LOJA
      if (loja) {
        const [r1] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM funcionarios WHERE UPPER(APELIDO) = ? AND LOJA = ? LIMIT 1`,
          [nomeNormalizado, loja],
        );
        if (r1.length) return Number(r1[0].CODIGO) || 0;
      }
      // 2. Tenta NOME exato + LOJA
      if (loja) {
        const [r2] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM funcionarios WHERE UPPER(NOME) = ? AND LOJA = ? LIMIT 1`,
          [nomeNormalizado, loja],
        );
        if (r2.length) return Number(r2[0].CODIGO) || 0;
      }
      // 3. Primeiro nome + LOJA (NOME ou APELIDO começa com)
      if (loja && primeiroNome.length >= 3) {
        const [r3] = await this.pool.query<mysql.RowDataPacket[]>(
          `SELECT CODIGO FROM funcionarios
            WHERE LOJA = ?
              AND (UPPER(APELIDO) = ? OR UPPER(NOME) LIKE ?)
            LIMIT 1`,
          [loja, primeiroNome, primeiroNome + '%'],
        );
        if (r3.length) return Number(r3[0].CODIGO) || 0;
      }
      // 4. Fallback: APELIDO sem filtro de loja
      const [r4] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CODIGO FROM funcionarios WHERE UPPER(APELIDO) = ? LIMIT 1`,
        [nomeNormalizado],
      );
      if (r4.length) return Number(r4[0].CODIGO) || 0;
      return 0;
    } catch (e) {
      this.logger.warn(`lookupFuncionarioCode("${nome}", "${loja}") falhou: ${(e as Error).message}`);
      return 0;
    }
  }

  /**
   * Mapeia método de pagamento do flowops pro par (FORMA, coluna_específica)
   * da tabela `fechamento` do Wincred. PIX não tem coluna específica.
   *
   * Retorna {forma: string, coluna: string|null}. Coluna null = só FORMA+VALOR.
   */
  private mapPagamentoFechamento(metodo: string): { forma: string; coluna: string | null } {
    const m = String(metodo || '').toUpperCase().trim();
    // Mapeamento real do flowops (cliente confirmou em 07/05/2026):
    // - Aceitas todas as variações comuns do nome (lowercase, com/sem acento, com/sem espaço)
    // - Removidas: CIELODEBITO, CHEQUE_VISTA, CHEQUE_PRE, SOROCRED, CREDSYSTEM, DEBITO, MARCADO (não existem mais no PDV)
    // Mapeamento real do flowops (cliente confirmou em 07/05/2026):
    // - Aceitas todas as variações comuns do nome (lowercase, com/sem acento, com/sem espaço)
    // - Removidas: CIELODEBITO, CHEQUE_VISTA, CHEQUE_PRE, SOROCRED, CREDSYSTEM, DEBITO, MARCADO (não existem mais no PDV)
    const map: Record<string, { forma: string; coluna: string | null }> = {
      // DINHEIRO
      'DINHEIRO': { forma: 'DINHEIRO', coluna: 'DINHEIRO' },
      'CASH': { forma: 'DINHEIRO', coluna: 'DINHEIRO' },
      // PIX (sem coluna específica em fechamento — só FORMA + VALOR)
      'PIX': { forma: 'PIX', coluna: null },
      // CIELO (cartão crédito Cielo)
      'CIELO': { forma: 'CIELO', coluna: 'CIELO' },
      'CIELO_CREDITO': { forma: 'CIELO', coluna: 'CIELO' },
      // MASTERCARD
      'MASTERCARD': { forma: 'MASTERCARD', coluna: 'MASTERCARD' },
      // VISA → VISANET (Visa crédito)
      'VISA': { forma: 'VISANET', coluna: 'VISANET' },
      'VISANET': { forma: 'VISANET', coluna: 'VISANET' },
      // VISA ELECTRON (Visa débito)
      'VISA ELECTRON': { forma: 'VISA_ELECTRON', coluna: 'VISA_ELECTRON' },
      'VISA_ELECTRON': { forma: 'VISA_ELECTRON', coluna: 'VISA_ELECTRON' },
      'VISAELECTRON': { forma: 'VISA_ELECTRON', coluna: 'VISA_ELECTRON' },
      // ELO
      'ELO': { forma: 'ELO', coluna: 'ELO' },
      // AMERICAN EXPRESS → AMEX
      'AMERICAN EXPRESS': { forma: 'AMEX', coluna: 'AMEX' },
      'AMEX': { forma: 'AMEX', coluna: 'AMEX' },
      // HIPERCARD
      'HIPERCARD': { forma: 'HIPERCARD', coluna: 'HIPERCARD' },
      // CREDIÁRIO (também gera parcelas em movimento)
      'CREDIARIO': { forma: 'CREDIARIO', coluna: 'CREDIARIO' },
      'CREDIÁRIO': { forma: 'CREDIARIO', coluna: 'CREDIARIO' },
      // REDE SHOP
      'REDE SHOP': { forma: 'REDE_SHOP', coluna: 'REDE_SHOP' },
      'REDESHOP': { forma: 'REDE_SHOP', coluna: 'REDE_SHOP' },
      'REDE_SHOP': { forma: 'REDE_SHOP', coluna: 'REDE_SHOP' },
    };
    return map[m] || { forma: m || 'OUTROS', coluna: null };
  }

  /**
   * Grava uma venda do PDV flowops na tabela `caixa` do Wincred.
   * Também grava 1 linha em `fechamento` por pagamento (com FORMA+VALOR).
   * Idempotente por venda? NÃO — cada chamada gera novo NUMERO.
   */
  async gravarVendaPdv(input: {
    storeCode: string;          // ex: '01' (ITANHAEM, char(2))
    items: Array<{
      sku: string;              // CODIGO Giga (ou EAN — resolveSkuInfo na ponta)
      qty: number;
      valorUnit: number;        // valor unitário sem desconto
      desconto: number;         // valor R$ do desconto (não percentual)
      descricao: string;
      grupo?: number;
      subgrupo?: number;
      fornecedor?: string;      // CNPJ
      tributo?: string;
    }>;
    pagamentos?: Array<{        // pagamentos da venda — 1 linha por método
      metodo: string;           // 'PIX', 'DINHEIRO', 'MASTERCARD', etc.
      valor: number;
    }>;
    operadorCode?: number;      // 0 se sem mapeamento
    operadorName?: string;      // nome do operador — faz lookup automático se code não vier
    vendedorCode?: number;      // codigo do funcionário vendedor
    vendedorName?: string;      // nome da vendedora — faz lookup automático se code não vier
    clienteCode?: number;       // 0 se sem cadastro
    nomeCliente?: string;       // vai pra coluna NOMECLIENTE em caixa
    obsPedido?: string;
  }): Promise<{
    ok: boolean;
    mode: 'shadow' | 'real';
    numero?: number;
    registros?: number[];
    sqlExecuted: string[];
    error?: string;
  }> {
    const sqlExecuted: string[] = [];
    const mode: 'shadow' | 'real' = this.isPdvWriteEnabled ? 'real' : 'shadow';

    if (!this.pool) {
      return { ok: false, mode, sqlExecuted, error: 'Pool ERP não inicializado' };
    }
    if (!input.items?.length) {
      return { ok: false, mode, sqlExecuted, error: 'Sem itens pra gravar' };
    }
    if (!input.storeCode) {
      return { ok: false, mode, sqlExecuted, error: 'storeCode obrigatório' };
    }

    // Normaliza storeCode pra char(2)
    const lojaCode = String(input.storeCode).padStart(2, '0').slice(-2);

    // ─── MODO SHADOW: só monta SQL e loga, sem executar ───
    if (mode === 'shadow') {
      sqlExecuted.push(`SELECT @numero := COALESCE(MAX(NUMERO), 0) + 1 FROM caixa FOR UPDATE`);
      for (const it of input.items) {
        const valorTotal = (it.valorUnit * it.qty) - (it.desconto || 0);
        sqlExecuted.push(
          `INSERT INTO caixa (NUMERO, CODIGO, DATA, DATAFEC, CLIENTE, DESCRICAO, ` +
          `GRUPO, QUANTIDADE, VALOR, DESCONTO, VALORTOTAL, VALORDESCONTO, ` +
          `OPERADOR, VENDEDOR, FORNECEDOR, SUBGRUPO, HORA, TRIBUTO, ` +
          `NOMECLIENTE, OBS_PEDIDO, LOJA) VALUES (` +
          `@numero, '${it.sku}', CURDATE(), CURDATE(), ${input.clienteCode || 0}, ` +
          `'${(it.descricao || '').replace(/'/g, "''").slice(0, 100)}', ` +
          `${it.grupo || 0}, ${it.qty}, ${it.valorUnit}, ${it.desconto || 0}, ` +
          `${valorTotal}, ${valorTotal}, ${input.operadorCode || 0}, ` +
          `${input.vendedorCode || 0}, '${(it.fornecedor || '').slice(0, 18)}', ` +
          `${it.subgrupo || 0}, CURTIME(), '${(it.tributo || '').slice(0, 4)}', ` +
          `'${(input.nomeCliente || '').replace(/'/g, "''").slice(0, 50)}', ` +
          `'${(input.obsPedido || '').replace(/'/g, "''").slice(0, 50)}', '${lojaCode}')`
        );
      }
      // Adiciona SQLs de fechamento (1 por pagamento) também em SHADOW
      const pagamentos = input.pagamentos || [];
      for (const p of pagamentos) {
        const map = this.mapPagamentoFechamento(p.metodo);
        const valor = Number(p.valor) || 0;
        if (valor <= 0) continue;
        const colExtra = map.coluna ? `, ${map.coluna}` : '';
        const valExtra = map.coluna ? `, ${valor}` : '';
        sqlExecuted.push(
          `INSERT INTO fechamento (VENDA, DATA, FORMA, VALOR${colExtra}, LOJA) ` +
          `VALUES (@numero, CURDATE(), '${map.forma}', ${valor}${valExtra}, '${lojaCode}')`
        );
      }
      this.logger.warn(
        `[gravarVendaPdv SHADOW] LOJA=${lojaCode} items=${input.items.length} pagamentos=${pagamentos.length} | ` +
        `total=R$${input.items.reduce((s, i) => s + (i.valorUnit * i.qty - (i.desconto || 0)), 0).toFixed(2)} | ` +
        `SQLs gerados: ${sqlExecuted.length}`,
      );
      // Loga SQL de fechamento (mais útil pra debug que o INSERT em caixa)
      const sqlFechamento = sqlExecuted.find((s) => s.includes('INTO fechamento'));
      this.logger.warn(`[gravarVendaPdv SHADOW] sample fechamento: ${sqlFechamento || sqlExecuted[1] || sqlExecuted[0]}`);
      return { ok: true, mode, sqlExecuted };
    }

    // ─── MODO REAL: executa em transação ACID ───
    // Lookup automático de VENDEDOR/OPERADOR se só veio o nome
    let vendedorCodeFinal = input.vendedorCode || 0;
    let operadorCodeFinal = input.operadorCode || 0;
    if (!vendedorCodeFinal && input.vendedorName) {
      vendedorCodeFinal = await this.lookupFuncionarioCode(input.vendedorName, lojaCode);
      if (vendedorCodeFinal) {
        this.logger.log(`[gravarVendaPdv] vendedor "${input.vendedorName}" → CODIGO=${vendedorCodeFinal} (loja ${lojaCode})`);
      } else {
        this.logger.warn(`[gravarVendaPdv] vendedor "${input.vendedorName}" não encontrado em funcionarios`);
      }
    }
    if (!operadorCodeFinal && input.operadorName) {
      operadorCodeFinal = await this.lookupFuncionarioCode(input.operadorName, lojaCode);
    }

    const conn = await this.pool.getConnection();
    const registros: number[] = [];
    let numero: number = 0;
    try {
      await conn.beginTransaction();

      // 1. Pega próximo NUMERO global com FOR UPDATE pra evitar race
      const [maxRows]: any = await conn.query(
        `SELECT COALESCE(MAX(NUMERO), 0) + 1 AS prox FROM caixa FOR UPDATE`,
      );
      numero = Number(maxRows[0]?.prox) || 1;

      // 2. INSERT cada item
      for (const it of input.items) {
        const valorTotal = (it.valorUnit * it.qty) - (it.desconto || 0);
        const [result]: any = await conn.query(
          `INSERT INTO caixa (
            NUMERO, CODIGO, DATA, DATAFEC, CLIENTE, DESCRICAO,
            GRUPO, QUANTIDADE, VALOR, DESCONTO, VALORTOTAL, VALORDESCONTO,
            OPERADOR, VENDEDOR, FORNECEDOR, SUBGRUPO, HORA, TRIBUTO,
            NOMECLIENTE, OBS_PEDIDO, LOJA
          ) VALUES (
            ?, ?, CURDATE(), CURDATE(), ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, CURTIME(), ?,
            ?, ?, ?
          )`,
          [
            numero,
            String(it.sku || '').slice(0, 13),
            input.clienteCode || 0,
            String(it.descricao || '').slice(0, 100),
            it.grupo || 0,
            it.qty,
            it.valorUnit,
            it.desconto || 0,
            valorTotal,
            valorTotal,
            operadorCodeFinal,
            vendedorCodeFinal,
            String(it.fornecedor || '').slice(0, 18),
            it.subgrupo || 0,
            String(it.tributo || '').slice(0, 4),
            String(input.nomeCliente || '').slice(0, 50),
            String(input.obsPedido || '').slice(0, 50),
            lojaCode,
          ],
        );
        registros.push(Number(result.insertId));
        sqlExecuted.push(`INSERT caixa NUMERO=${numero} CODIGO=${it.sku} → REGISTRO=${result.insertId}`);
      }

      // INSERT em `fechamento` (1 linha por pagamento) — registra forma de pgto
      // por venda. Sem isso, "Movimento Diário de Caixa" do Wincred mostra 0
      // em DINHEIRO/PIX/etc.
      const pagamentos = input.pagamentos || [];
      for (const p of pagamentos) {
        const map = this.mapPagamentoFechamento(p.metodo);
        const valor = Number(p.valor) || 0;
        if (valor <= 0) continue;
        // Monta INSERT dinamicamente: sempre seta FORMA e VALOR, e se houver
        // coluna específica (DINHEIRO, MASTERCARD, etc.) seta ela tambem.
        const cols = ['VENDA', 'DATA', 'FORMA', 'VALOR', 'LOJA'];
        const vals: any[] = [numero, new Date(), map.forma, valor, lojaCode];
        const placeholders = ['?', '?', '?', '?', '?'];
        if (map.coluna) {
          cols.splice(4, 0, map.coluna); // antes de LOJA
          vals.splice(4, 0, valor);
          placeholders.splice(4, 0, '?');
        }
        await conn.query(
          `INSERT INTO fechamento (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
          vals,
        );
        sqlExecuted.push(`INSERT fechamento VENDA=${numero} FORMA=${map.forma} VALOR=${valor}`);
        // Nota: NÃO fazemos UPDATE em caixa_diario — o "Processa Movimento" do
        // Wincred lê de fechamento (DINHEIRO/PIX/CREDIARIO funcionam) e de outra
        // fonte interna (cartões — ainda não rastreada). Qualquer UPDATE direto
        // em caixa_diario é sobrescrito pelo Processa.
      }

      await conn.commit();
      this.logger.log(
        `[gravarVendaPdv REAL OK] LOJA=${lojaCode} NUMERO=${numero} ` +
        `items=${input.items.length} registros=${registros.length} pagamentos=${pagamentos.length}`,
      );
      return { ok: true, mode, numero, registros, sqlExecuted };
    } catch (e: any) {
      try { await conn.rollback(); } catch { /* ignore */ }
      const msg = String(e?.message || e);
      this.logger.error(`[gravarVendaPdv REAL FALHOU rollback] ${msg}`);
      return { ok: false, mode, sqlExecuted, error: msg };
    } finally {
      conn.release();
    }
  }

}
