import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

/**
 * NcmAuditService — auditoria e correção de NCMs no ERP Gigasistemas.
 *
 * Responsabilidades:
 *  • Detecta produtos com NCM problemático (vazio, formato inválido,
 *    fora de vestuário/acessórios 61xx-62xx e relacionados).
 *  • Sugere NCM correto baseado em palavras-chave do GRUPO/SUBGRUPO/DESCRIÇÃO.
 *  • Aplica fixes via UPDATE controlado por env var ERP_WRITE_ENABLED.
 *
 * Schema esperado (detectado dinamicamente):
 *  - tabela `produtos`
 *  - colunas: CODIGO, REF, COR, TAMANHO, DESCRICAOCOMPLETA, GRUPO, SUBGRUPO,
 *    NCM (ou CODNCM/CODIGONCM/COD_NCM)
 *
 * Estratégia de mapeamento NCM (vestuário plus size feminino):
 *  Categoria          → NCM correto (8 dígitos)
 *  Vestido            → 62044200 (vestidos fem algodão tecido)
 *  Blusa / Camisa     → 62063000 (blusas fem algodão tecido)
 *  Camiseta / T-shirt → 61091000 (T-shirts malha algodão)
 *  Calça / Jeans      → 62046200 (calças fem algodão)
 *  Short / Bermuda    → 62046200
 *  Saia               → 62045200 (saias fem algodão)
 *  Macacão            → 62114200
 *  Conjunto           → 62042200
 *  Casaco / Blazer    → 62043200
 *  Pijama             → 62083100
 *  Lingerie / Sutiã   → 62121000
 *  Calcinha           → 62083100
 *  Maiô / Biquíni     → 61124100
 *  Meia / Hosiery     → 61152100
 *  Bolsa              → 42022200
 *  Sapato / Sandália  → 64035100
 *  FALLBACK (genérico)→ 62114300 (outras roupas femininas tecido)
 */
@Injectable()
export class NcmAuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NcmAuditService.name);
  private pool: mysql.Pool | null = null;
  private ncmColCache: string | null = null;
  private grupoColCache: string | null = null;
  private subgrupoColCache: string | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const host = this.config.get<string>('ERP_HOST');
    if (!host) {
      this.logger.warn('ERP_HOST não configurado — NcmAuditService inativo');
      return;
    }
    try {
      this.pool = mysql.createPool({
        host,
        port: Number(this.config.get<string>('ERP_PORT') ?? 3306),
        user: this.config.get<string>('ERP_USER'),
        password: this.config.get<string>('ERP_PASSWORD'),
        database: this.config.get<string>('ERP_DATABASE'),
        waitForConnections: true,
        connectionLimit: 3,
        queueLimit: 0,
        connectTimeout: 8000,
      });
      this.logger.log(`NcmAuditService pool inicializado (host=${host})`);
    } catch (e) {
      this.logger.error(`Falha ao iniciar pool: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy() {
    if (this.pool) {
      try {
        await this.pool.end();
      } catch {}
    }
  }

  get isWriteEnabled(): boolean {
    const v = String(this.config.get('ERP_WRITE_ENABLED') ?? '').trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }

  /* ─── Detecção de colunas (cache) ─── */
  private async detectCols(): Promise<{
    ncm: string;
    grupo: string | null;
    subgrupo: string | null;
  }> {
    if (this.ncmColCache !== null) {
      return {
        ncm: this.ncmColCache,
        grupo: this.grupoColCache,
        subgrupo: this.subgrupoColCache,
      };
    }
    if (!this.pool) throw new Error('Pool ERP não inicializado');

    const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
      'SHOW COLUMNS FROM produtos',
    );
    const colsSet = new Set<string>(
      (cols as any[]).map((c) => String(c.Field).toUpperCase()),
    );

    const pick = (candidates: string[]): string | null => {
      for (const c of candidates) if (colsSet.has(c)) return c;
      return null;
    };

    const ncm = pick(['NCM', 'CODNCM', 'CODIGONCM', 'COD_NCM']);
    const grupo = pick(['GRUPO', 'GRUPODESC', 'GRUPO_DESC', 'NOMEGRUPO']);
    const subgrupo = pick(['SUBGRUPO', 'SUB_GRUPO', 'SUBGRUPODESC', 'NOMESUBGRUPO']);

    if (!ncm) throw new Error('Coluna NCM não encontrada na tabela produtos');

    this.ncmColCache = ncm;
    this.grupoColCache = grupo;
    this.subgrupoColCache = subgrupo;

    return { ncm, grupo, subgrupo };
  }

  /* ─── Regras de mapeamento NCM ─── */
  private static readonly NCM_RULES: Array<{
    match: RegExp;
    ncm: string;
    desc: string;
  }> = [
    // ORDEM IMPORTA — específicos antes de genéricos
    { match: /\b(sutia|sutiã|sutian)\b/i, ncm: '62121000', desc: 'Sutiãs' },
    { match: /\b(calcinha)\b/i, ncm: '62083100', desc: 'Calcinhas algodão' },
    { match: /\b(body)\b/i, ncm: '61082100', desc: 'Body feminino (malha algodão)' },
    { match: /\b(lingerie)\b/i, ncm: '62121000', desc: 'Lingerie' },
    { match: /\b(roupao|roupão|robe|hobby)\b/i, ncm: '62083100', desc: 'Roupões femininos' },
    { match: /\b(pijama)\b/i, ncm: '62083100', desc: 'Pijamas femininos' },
    { match: /\b(camisola)\b/i, ncm: '62083100', desc: 'Camisolas' },
    { match: /\b(maio|maiô|biquini|biquíni)\b/i, ncm: '61124100', desc: 'Maiôs e biquínis' },
    { match: /\b(meia|meias)\b/i, ncm: '61152100', desc: 'Meias-calças' },

    { match: /\b(camiseta|t-?shirt|baby look)\b/i, ncm: '61091000', desc: 'T-shirts malha algodão' },
    { match: /\b(regata|tank)\b/i, ncm: '61091000', desc: 'Regatas/tank tops' },
    { match: /\b(cropped)\b/i, ncm: '61091000', desc: 'Cropped malha' },

    { match: /\b(vestido)\b/i, ncm: '62044200', desc: 'Vestidos femininos tecido' },
    { match: /\b(blusa|camisa)\b/i, ncm: '62063000', desc: 'Blusas/camisas femininas' },
    { match: /\b(saia)\b/i, ncm: '62045200', desc: 'Saias femininas' },
    { match: /\b(calca|calça|jeans)\b/i, ncm: '62046200', desc: 'Calças femininas' },
    { match: /\b(short|bermuda)\b/i, ncm: '62046200', desc: 'Shorts/bermudas' },
    { match: /\b(macacao|macacão|jumpsuit)\b/i, ncm: '62114200', desc: 'Macacões' },
    { match: /\b(conjunto)\b/i, ncm: '62042200', desc: 'Conjuntos femininos' },
    { match: /\b(casaco|jaqueta|blazer|cardigan|colete)\b/i, ncm: '62043200', desc: 'Casacos/blazers' },
    { match: /\b(kimono)\b/i, ncm: '62114300', desc: 'Kimonos' },

    { match: /\b(mochila|backpack)\b/i, ncm: '42029200', desc: 'Mochilas (matéria têxtil)' },
    { match: /\b(necessaire|nec[ée]ssaire)\b/i, ncm: '42029200', desc: 'Necessaires' },
    { match: /\b(bolsa|carteira|pochete)\b/i, ncm: '42022200', desc: 'Bolsas e carteiras' },
    { match: /\b(boia|b[oó]ia|inflavel|inflável)\b/i, ncm: '95069900', desc: 'Artigos de praia/inflados' },
    { match: /\b(sapato|sandalia|sandália|tenis|tênis|rasteira|chinelo)\b/i, ncm: '64035100', desc: 'Calçados' },
    { match: /\b(cinto)\b/i, ncm: '42033000', desc: 'Cintos' },
    { match: /\b(brinco|colar|anel|pulseira|bijuteria)\b/i, ncm: '71171900', desc: 'Bijuterias' },
    { match: /\b(lenco|lenço|echarpe|cachecol)\b/i, ncm: '62141000', desc: 'Lenços/echarpes' },
    { match: /\b(chapeu|chapéu|boné|bone)\b/i, ncm: '65050000', desc: 'Chapéus/bonés' },
  ];

  private static readonly FALLBACK_NCM = '62114300'; // outras roupas femininas tecido
  private static readonly FALLBACK_DESC = 'Outras roupas femininas (fallback)';

  /** NCMs aceitos como "vestuário válido" — começam com esses prefixos */
  private static readonly VALID_PREFIXES = ['61', '62', '42', '64', '65', '71'];

  /** Sugere NCM correto baseado em descrição/grupo/subgrupo */
  private suggestNcm(text: string): { ncm: string; ruleDesc: string } {
    const normalized = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const rule of NcmAuditService.NCM_RULES) {
      if (rule.match.test(normalized)) {
        return { ncm: rule.ncm, ruleDesc: rule.desc };
      }
    }
    return {
      ncm: NcmAuditService.FALLBACK_NCM,
      ruleDesc: NcmAuditService.FALLBACK_DESC,
    };
  }

  /** Classifica problema do NCM atual */
  private classifyIssue(
    rawNcm: string | null | undefined,
  ): 'empty' | 'invalid_format' | 'wrong_category' | 'ok' {
    if (!rawNcm) return 'empty';
    const cleaned = String(rawNcm).replace(/\D/g, '');
    if (!cleaned) return 'empty';
    if (cleaned.length !== 8) return 'invalid_format';
    const prefix = cleaned.slice(0, 2);
    if (!NcmAuditService.VALID_PREFIXES.includes(prefix)) return 'wrong_category';
    return 'ok';
  }

  /**
   * Audita NCMs no catálogo Giga. Read-only.
   * Retorna apenas produtos COM problema + NCM sugerido.
   * Usa REF (não CODIGO) pra agregar — produtos têm 1 NCM por REF, não por SKU.
   */
  async auditCatalog(opts?: {
    limit?: number;
    includeOk?: boolean;
    onlyIssue?: 'empty' | 'invalid_format' | 'wrong_category';
  }): Promise<NcmAuditResult> {
    if (!this.pool) {
      return { items: [], summary: zeroSummary(), schema: { ncmCol: null, hasGrupo: false, hasSubgrupo: false } };
    }

    const { ncm: ncmCol, grupo: grupoCol, subgrupo: subgrupoCol } = await this.detectCols();
    // Aumentado pra 200k: catálogos plus-size grandes podem ter 30-50k REFs.
    // Como agregamos por REF (não por SKU), 200k cobre praticamente qualquer cenário.
    const limit = Math.max(1, Math.min(200000, opts?.limit || 200000));

    // Agrega por REF (1 NCM por modelo, não por SKU)
    const selects = [
      'MIN(p.CODIGO) AS sampleCodigo',
      'p.REF AS ref',
      'MAX(p.DESCRICAOCOMPLETA) AS descricao',
      `MAX(p.\`${ncmCol}\`) AS ncm`,
    ];
    if (grupoCol) selects.push(`MAX(p.\`${grupoCol}\`) AS grupo`);
    if (subgrupoCol) selects.push(`MAX(p.\`${subgrupoCol}\`) AS subgrupo`);

    const sql = `
      SELECT ${selects.join(', ')}, COUNT(*) AS skuCount
        FROM produtos p
       WHERE p.REF IS NOT NULL AND p.REF <> ''
       GROUP BY p.REF
       LIMIT ?
    `;

    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [limit]);

    const items: NcmAuditItem[] = [];
    const summary = zeroSummary();

    for (const r of rows as any[]) {
      const ref = String(r.ref || '').trim();
      const currentNcm = r.ncm != null ? String(r.ncm).trim() : null;
      const descricao = r.descricao ? String(r.descricao).trim() : '';
      const grupo = r.grupo ? String(r.grupo).trim() : '';
      const subgrupo = r.subgrupo ? String(r.subgrupo).trim() : '';

      const issue = this.classifyIssue(currentNcm);
      summary.total++;
      summary[issue]++;

      if (opts?.onlyIssue && issue !== opts.onlyIssue) continue;
      if (issue === 'ok' && !opts?.includeOk) continue;

      const matchText = `${grupo} ${subgrupo} ${descricao}`;
      const suggestion = this.suggestNcm(matchText);

      items.push({
        ref,
        sampleCodigo: String(r.sampleCodigo || ''),
        descricao,
        grupo,
        subgrupo,
        currentNcm,
        currentNcmCleaned: currentNcm ? String(currentNcm).replace(/\D/g, '') : '',
        issue,
        suggestedNcm: suggestion.ncm,
        suggestedRule: suggestion.ruleDesc,
        skuCount: Number(r.skuCount) || 1,
      });
    }

    return {
      items,
      summary,
      schema: {
        ncmCol,
        hasGrupo: !!grupoCol,
        hasSubgrupo: !!subgrupoCol,
      },
    };
  }

  /**
   * Aplica fixes em lote (UPDATE individual por REF, autocommit).
   * Cada item: { ref, ncm } — atualiza TODOS os produtos daquela REF.
   * Respeita ERP_WRITE_ENABLED.
   *
   * ESTRATÉGIA SEM TRANSAÇÃO:
   *  • Cada UPDATE é autocommit individual
   *  • Se uma linha estiver lockada por PDV/outro processo, falha SÓ esse REF
   *    (não invalida os demais)
   *  • Lock timeout reduzido pra 5s na sessão (default é 50s) — fail-fast
   *  • Retry automático até 3x com backoff de 500ms pra locks transitórios
   *
   * Isso resolve "Lock wait timeout exceeded" que acontece quando o PDV
   * das lojas tá com transação aberta em algum produto.
   */
  async applyFixes(items: Array<{ ref: string; ncm: string }>): Promise<NcmApplyResult> {
    if (!this.isWriteEnabled) {
      return {
        applied: 0,
        skipped: items.length,
        errors: [],
        message: 'ERP_WRITE_ENABLED=false. Defina como true no Railway pra aplicar.',
      };
    }
    if (!this.pool) {
      return { applied: 0, skipped: 0, errors: [{ ref: '*', error: 'Pool inativo' }] };
    }

    const { ncm: ncmCol } = await this.detectCols();
    const errors: Array<{ ref: string; error: string }> = [];
    let applied = 0;
    let processed = 0;

    this.logger.log(`applyFixes: ${items.length} itens (autocommit, sem transação)`);

    const conn = await this.pool.getConnection();
    try {
      // Lock timeout curto — falha em 5s se a linha tá lockada por outro
      // (default do MySQL é 50s, o que trava o batch inteiro).
      try {
        await conn.query('SET SESSION innodb_lock_wait_timeout = 5');
      } catch {}
      // Garante autocommit (não estamos em transação manual).
      try {
        await conn.query('SET autocommit = 1');
      } catch {}

      for (const it of items) {
        const ncmClean = String(it.ncm || '').replace(/\D/g, '');
        if (ncmClean.length !== 8) {
          errors.push({ ref: it.ref, error: `NCM "${it.ncm}" não tem 8 dígitos` });
          continue;
        }
        if (!it.ref || !it.ref.trim()) {
          errors.push({ ref: it.ref, error: 'REF vazia' });
          continue;
        }

        // Retry até 3x pra locks transitórios
        let lastError: string | null = null;
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const [result] = await conn.query<mysql.ResultSetHeader>(
              `UPDATE produtos SET \`${ncmCol}\` = ? WHERE REF = ?`,
              [ncmClean, it.ref.trim()],
            );
            applied += result.affectedRows || 0;
            success = true;
            break;
          } catch (e: any) {
            lastError = e.message || String(e);
            // Lock timeout — retry com delay; outros erros — desiste
            if (lastError && lastError.includes('Lock wait timeout')) {
              await new Promise((r) => setTimeout(r, 500 * attempt));
              continue;
            }
            break;
          }
        }
        if (!success && lastError) {
          errors.push({ ref: it.ref, error: lastError });
        }
        processed++;
        if (processed % 100 === 0) {
          this.logger.log(
            `progress: ${processed}/${items.length} · applied=${applied} · errors=${errors.length}`,
          );
        }
      }
    } finally {
      conn.release();
    }

    this.logger.log(
      `applyFixes done: applied=${applied}, errors=${errors.length}, total=${items.length}`,
    );

    return {
      applied,
      skipped: items.length - applied - errors.length,
      errors,
      message: `Processado ${processed}/${items.length} · ${errors.length} bloqueado(s) por lock`,
    };
  }
}

/* ─── Types ─── */

export interface NcmAuditItem {
  ref: string;
  sampleCodigo: string;
  descricao: string;
  grupo: string;
  subgrupo: string;
  currentNcm: string | null;
  currentNcmCleaned: string;
  issue: 'empty' | 'invalid_format' | 'wrong_category' | 'ok';
  suggestedNcm: string;
  suggestedRule: string;
  skuCount: number;
}

export interface NcmAuditSummary {
  total: number;
  ok: number;
  empty: number;
  invalid_format: number;
  wrong_category: number;
}

export interface NcmAuditResult {
  items: NcmAuditItem[];
  summary: NcmAuditSummary;
  schema: {
    ncmCol: string | null;
    hasGrupo: boolean;
    hasSubgrupo: boolean;
  };
}

export interface NcmApplyResult {
  applied: number;
  skipped: number;
  errors: Array<{ ref: string; error: string }>;
  message?: string;
}

function zeroSummary(): NcmAuditSummary {
  return { total: 0, ok: 0, empty: 0, invalid_format: 0, wrong_category: 0 };
}
