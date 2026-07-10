import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { ProductSearchService } from '../product-search/product-search.service';

/**
 * Serviço da tela "Classificação de Produtos" (Cadastros).
 *
 * Fonte do catálogo: snapshot agregado por REF vindo do ERP ao vivo
 * (ErpService.getRefCatalogSnapshot), cacheado em memória — uma query por
 * refresh em vez de uma por tecla. Busca/filtro/paginação/contadores rodam
 * TUDO em memória cruzando com a tabela product_classification do Postgres
 * (a fonte de verdade da classificação, owned pelo Flow).
 *
 * Regra: REF sem registro em product_classification = MODA (0) + não revisado.
 */

export type QuickFilter = 'todos' | 'basicos' | 'moda' | 'nao_revisados';

export interface CatalogFilters {
  search?: string;
  quick?: QuickFilter;
  marca?: string;
  fornecedor?: string;
  categoria?: string;
  plusSize?: boolean; // true = só refs com plus size
}

interface RefRow {
  ref: string;
  descricao: string;
  // Todas as descrições da REF concatenadas (só pra BUSCA — o display usa
  // `descricao`). Corrige REF cujo produto novo não aparecia na pesquisa.
  busca?: string;
  marca: string;
  fornecedor: string;
  categoria: string;
  plusSize: boolean;
}

interface ClsRow {
  tipoProduto: number;
  classificacaoRevisada: boolean;
}

const SNAPSHOT_TTL_MS = 10 * 60 * 1000; // 10min — catálogo muda pouco intra-sessão
const UPSERT_CHUNK = 500;

// ── PROMOÇÃO DE JULHO/2026 (regra do dono, 02/07) ─────────────────────────
// Cadastro (DATAALT) até 31/12/2023 → 50% OFF, EXCETO linha BÁSICA.
// É a MESMA regra YEAR_BASED que o PDV aplica na venda (applyAutoDiscounts) —
// esta tela mostra o preço promocional pra planejamento/etiquetagem.
const PROMO_JULHO_CUTOFF = '2023-12-31';
const PROMO_JULHO_PCT = 0.5;

@Injectable()
export class ProductClassificationService {
  private readonly logger = new Logger(ProductClassificationService.name);

  private snapshot: RefRow[] | null = null;
  private snapshotAt = 0;
  private snapshotLoading: Promise<RefRow[]> | null = null;

  private clsMap: Map<string, ClsRow> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly productSearch: ProductSearchService,
  ) {}

  // ── Helpers ──────────────────────────────────────────────────────────────
  private normRef(r: string): string {
    return String(r || '').trim().toUpperCase();
  }

  // ── Caches ───────────────────────────────────────────────────────────────
  private async getSnapshot(force = false): Promise<RefRow[]> {
    const fresh = this.snapshot && Date.now() - this.snapshotAt < SNAPSHOT_TTL_MS;
    if (!force && fresh) return this.snapshot!;
    // Dedup de chamadas concorrentes (vários requests ao mesmo tempo)
    if (this.snapshotLoading) return this.snapshotLoading;

    this.snapshotLoading = (async () => {
      try {
        const rows = await this.erp.getRefCatalogSnapshot();
        // Dedup defensivo por REF normalizada (o GROUP BY já agrupa, mas garante)
        const seen = new Map<string, RefRow>();
        for (const r of rows) {
          const ref = this.normRef(r.ref);
          if (!ref || seen.has(ref)) continue;
          seen.set(ref, { ...r, ref });
        }
        this.snapshot = Array.from(seen.values());
        this.snapshotAt = Date.now();
        return this.snapshot;
      } finally {
        this.snapshotLoading = null;
      }
    })();
    return this.snapshotLoading;
  }

  private async getClsMap(): Promise<Map<string, ClsRow>> {
    if (this.clsMap) return this.clsMap;
    const rows = await (this.prisma as any).productClassification.findMany({
      select: { ref: true, tipoProduto: true, classificacaoRevisada: true },
    });
    const map = new Map<string, ClsRow>();
    for (const r of rows) {
      map.set(this.normRef(r.ref), {
        tipoProduto: r.tipoProduto,
        classificacaoRevisada: r.classificacaoRevisada,
      });
    }
    this.clsMap = map;
    return map;
  }

  private invalidateClsMap() {
    this.clsMap = null;
  }

  /**
   * ORDEM EXPLÍCITA DO DONO (10/07): a busca desta tela usa SOMENTE A
   * DESCRIÇÃO — todas as palavras digitadas, em QUALQUER ordem e QUALQUER
   * posição da DESCRICAOCOMPLETA ("VESTIDO 48", "30333", "MANGA CURTA 48
   * PRETO" acham "VESTIDO LONGO MANGA CURTA REF 30333 PRETO 48"). SEM
   * cascata código/REF, SEM fallback no Giga vivo. Produtos a mais que
   * contenham as mesmas palavras entram mesmo (decisão do dono).
   *
   * Devolve o conjunto de REFs cujas variações casaram (a tela é por REF).
   * null = sem termo, ou espelho vazio/erro → applyFilters cai no match
   * textual local (que também é descrição: GROUP_CONCAT de todas por REF).
   */
  private async resolveSearchRefs(search?: string): Promise<Set<string> | null> {
    const term = String(search || '').trim();
    if (!term) return null;
    try {
      const rows = await this.productSearch.searchDescricaoOnly(term);
      const set = new Set<string>();
      for (const r of rows) {
        // Produto sem REF entra no snapshot com chave sintética "#<codigo>".
        const ref = this.normRef(r.ref || '') || (r.codigo ? this.normRef(`#${r.codigo}`) : '');
        if (ref) set.add(ref);
      }
      if (set.size) return set;
      this.logger.log(`[classificacao] busca "${term}": espelho sem match → texto local`);
    } catch (e) {
      this.logger.warn(`[classificacao] busca no espelho falhou, usando texto local: ${(e as Error).message}`);
    }
    return null; // fallback: applyFilters cai no match textual local (descrições)
  }

  // ── Filtro em memória ────────────────────────────────────────────────────
  // searchRefs: quando presente, o match de busca é POR REF (as REFs cujas
  // variações casaram a busca POR DESCRIÇÃO). null + termo = fallback textual local.
  private applyFilters(
    rows: RefRow[],
    cls: Map<string, ClsRow>,
    f: CatalogFilters,
    searchRefs?: Set<string> | null,
  ): RefRow[] {
    const words = String(f.search || '')
      .trim()
      .toUpperCase()
      .split(/\s+/)
      .filter(Boolean);
    const marca = f.marca ? f.marca.trim().toUpperCase() : '';
    const fornecedor = f.fornecedor ? f.fornecedor.trim().toUpperCase() : '';
    const categoria = f.categoria ? f.categoria.trim().toUpperCase() : '';

    return rows.filter((r) => {
      if (f.plusSize && !r.plusSize) return false;
      if (marca && r.marca.toUpperCase() !== marca) return false;
      if (fornecedor && r.fornecedor.toUpperCase() !== fornecedor) return false;
      if (categoria && r.categoria.toUpperCase() !== categoria) return false;

      if (words.length) {
        if (searchRefs) {
          // Busca resolvida pelo Giga (rotina do Realinhamento): filtra por REF.
          if (!searchRefs.has(r.ref)) return false;
        } else {
          // Fallback local (ERP indisponível): texto em ref + descrições.
          const hay = `${r.ref} ${r.busca || r.descricao}`.toUpperCase();
          for (const w of words) if (!hay.includes(w)) return false;
        }
      }

      if (f.quick && f.quick !== 'todos') {
        const c = cls.get(r.ref);
        const tipo = c ? c.tipoProduto : 0; // sem registro = MODA
        const revisada = c ? c.classificacaoRevisada : false;
        if (f.quick === 'basicos' && tipo !== 1) return false;
        if (f.quick === 'moda' && tipo !== 0) return false;
        if (f.quick === 'nao_revisados' && revisada) return false;
      }
      return true;
    });
  }

  // ── API pública ──────────────────────────────────────────────────────────
  async list(f: CatalogFilters, page: number, perPage: number) {
    const [snap, cls, searchRefs] = await Promise.all([
      this.getSnapshot(),
      this.getClsMap(),
      this.resolveSearchRefs(f.search),
    ]);
    const filtered = this.applyFilters(snap, cls, f, searchRefs);
    const total = filtered.length;
    const p = Math.max(1, page || 1);
    const pp = Math.min(200, Math.max(1, perPage || 50));
    const start = (p - 1) * pp;
    const pageRows = filtered.slice(start, start + pp);

    // ── PREÇO + PROMO JULHO (02/07) — agregado do ESPELHO (Postgres) por REF
    // da página: preço de etiqueta (maior VENDAUN da REF) e data de cadastro
    // (DATAALT mais recente). Regra da promoção de julho: cadastro até
    // 31/12/2023 = 50% OFF, EXCETO linha BÁSICA — a MESMA regra YEAR_BASED
    // que o PDV aplica na venda.
    //
    // ── EXIBIÇÃO (10/07) — descrição/preço da REF vindos do espelho
    // giga_produto (a MESMA fonte da live). Com BUSCA ativa, mostra a família
    // QUE CASOU com a busca (caso REF 321: "KASUAL VEST" achava o VESTIDO 321
    // KASUAL mas exibia a BERMUDA YACIMA, família dominante da mesma REF);
    // sem busca, mostra a FAMÍLIA DOMINANTE (caso REF 2319: helicóptero 2016
    // × blusão atual — MAX alfabético montava linha Frankenstein).
    const searchWords = String(f.search || '').trim().split(/\s+/).filter((w) => w.length >= 2);
    const [precoByRef, displayByRef] = await Promise.all([
      this.getPrecoEDataByRefs(pageRows.map((r) => r.ref)),
      this.productSearch.displayInfoByRefs(pageRows.map((r) => r.ref), { matchWords: searchWords }),
    ]);

    const rows = pageRows.map((r) => {
      const c = cls.get(r.ref);
      const tipoProduto = c ? c.tipoProduto : 0;
      const info = precoByRef.get(r.ref) || null;
      const display = displayByRef.get(r.ref) || null;
      // Preço: família dominante (giga_produto, fonte da live) > wincred_produtos.
      const preco = display?.preco ?? info?.preco ?? null;
      const dataCadastro = info?.dataCadastro ?? null;
      const isBasico = tipoProduto === 1;
      const elegivel = !!dataCadastro && dataCadastro <= PROMO_JULHO_CUTOFF;
      const precoPromo = !isBasico && elegivel && preco != null
        ? Math.round(preco * (1 - PROMO_JULHO_PCT) * 100) / 100
        : null;
      return {
        ref: r.ref,
        descricao: display?.descricao || r.descricao,
        marca: r.marca,
        fornecedor: r.fornecedor,
        categoria: r.categoria,
        plusSize: r.plusSize,
        tipoProduto,
        revisada: c ? c.classificacaoRevisada : false,
        preco,
        dataCadastro,
        precoPromo,                                   // null = fora da promo
        promoIsento: isBasico && elegivel,            // básico antigo = isento
      };
    });
    return { rows, total, page: p, perPage: pp };
  }

  /**
   * Preço de etiqueta + data de cadastro por REF, lidos do ESPELHO
   * (wincred_produtos). Batch por página (≤200 REFs) — Postgres local, ~ms.
   * VENDAUN no espelho está em REAIS (nunca ÷100 — ver WincredCatalogService).
   * Espelho vazio/erro → mapa vazio (a tela mostra "—" sem quebrar).
   */
  private async getPrecoEDataByRefs(
    refs: string[],
  ): Promise<Map<string, { preco: number | null; dataCadastro: string | null }>> {
    const out = new Map<string, { preco: number | null; dataCadastro: string | null }>();
    const clean = Array.from(new Set(refs.map((r) => this.normRef(r)).filter(Boolean)));
    if (!clean.length) return out;
    try {
      const rows: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT UPPER(TRIM(ref)) AS ref,
                MAX("vendaUn")::float AS preco,
                MAX("dataAlt") AS data_cadastro
           FROM wincred_produtos
          WHERE ref IS NOT NULL
            AND UPPER(TRIM(ref)) = ANY($1::text[])
          GROUP BY 1`,
        clean,
      );
      for (const r of rows) {
        const preco = r.preco != null && Number(r.preco) > 0 ? Number(r.preco) : null;
        const d = r.data_cadastro ? new Date(r.data_cadastro) : null;
        out.set(String(r.ref), {
          preco,
          dataCadastro: d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null,
        });
      }
    } catch (e: any) {
      this.logger?.warn?.(`[classificacao] preço via espelho falhou: ${e?.message || e}`);
    }
    return out;
  }

  async counters() {
    const [snap, cls] = await Promise.all([this.getSnapshot(), this.getClsMap()]);
    let basicos = 0;
    let revisados = 0;
    let plusSize = 0;
    for (const r of snap) {
      if (r.plusSize) plusSize++;
      const c = cls.get(r.ref);
      if (!c) continue;
      if (c.tipoProduto === 1) basicos++;
      if (c.classificacaoRevisada) revisados++;
    }
    const total = snap.length;
    return {
      total,
      basicos,
      moda: total - basicos,
      naoRevisados: total - revisados,
      plusSize,
    };
  }

  async facets() {
    const snap = await this.getSnapshot();
    const marcas = new Set<string>();
    const fornecedores = new Set<string>();
    const categorias = new Set<string>();
    for (const r of snap) {
      if (r.marca) marcas.add(r.marca);
      if (r.fornecedor) fornecedores.add(r.fornecedor);
      if (r.categoria) categorias.add(r.categoria);
    }
    const sort = (s: Set<string>) => Array.from(s).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return { marcas: sort(marcas), fornecedores: sort(fornecedores), categorias: sort(categorias) };
  }

  async refresh() {
    const snap = await this.getSnapshot(true);
    this.invalidateClsMap();
    return { ok: true, refs: snap.length, atualizadoEm: new Date().toISOString() };
  }

  /**
   * DIAGNÓSTICO: compara banco cru × snapshot pra um termo (ex.: "2319").
   * Devolve: linhas do MySQL (com HEX da REF), estado/idade do snapshot,
   * matches no snapshot e resultado de um refresh forçado (com erro, se der).
   */
  async debugTerm(termRaw: string) {
    const term = String(termRaw || '').trim().toUpperCase();
    if (term.length < 2) return { erro: 'informe ?term= com 2+ caracteres' };

    // 1. Banco CRU (mesma fonte do snapshot)
    let gigaRows: any[] = [];
    let gigaError: string | null = null;
    try {
      gigaRows = await this.erp.debugProdutosByTerm(term);
    } catch (e: any) {
      gigaError = e?.message || String(e);
    }

    // 2. Snapshot ATUAL em memória (antes de forçar refresh)
    const snapAntes = this.snapshot || [];
    const idadeMin = this.snapshotAt ? Math.round((Date.now() - this.snapshotAt) / 60000) : null;
    const matchAntes = snapAntes
      .filter((r) => `${r.ref} ${r.busca || ''} ${r.descricao}`.toUpperCase().includes(term))
      .slice(0, 10)
      .map((r) => ({ ref: r.ref, descricao: r.descricao.slice(0, 80) }));

    // 3. Refresh FORÇADO — captura o erro que a tela engole
    let refreshError: string | null = null;
    let totalDepois: number | null = null;
    let matchDepois: any[] = [];
    try {
      const snap = await this.getSnapshot(true);
      totalDepois = snap.length;
      matchDepois = snap
        .filter((r) => `${r.ref} ${r.busca || ''} ${r.descricao}`.toUpperCase().includes(term))
        .slice(0, 10)
        .map((r) => ({ ref: r.ref, descricao: r.descricao.slice(0, 80) }));
    } catch (e: any) {
      refreshError = e?.message || String(e);
    }

    return {
      term,
      banco: {
        erro: gigaError,
        linhas: gigaRows.map((r: any) => ({
          codigo: r.CODIGO,
          ref: r.REF,
          refHex: r.ref_hex,
          refLen: r.ref_len,
          descricaoPdv: r.DESCRICAOPDV,
          descricaoCompleta: r.DESCRICAOCOMPLETA,
          plusSize: r.PLUS_SIZE,
          dataAlt: r.DATAALT,
        })),
      },
      snapshotAntes: { total: snapAntes.length, idadeMinutos: idadeMin, matches: matchAntes },
      snapshotDepois: { total: totalDepois, matches: matchDepois, refreshError },
    };
  }

  /** Salva 1 REF (toggle individual). */
  async setOne(refRaw: string, tipoProduto: number, user: string) {
    const ref = this.normRef(refRaw);
    if (!ref) return { ok: false, error: 'ref obrigatório' };
    const tipo = tipoProduto === 1 ? 1 : 0;
    await (this.prisma as any).productClassification.upsert({
      where: { ref },
      create: { ref, tipoProduto: tipo, classificacaoRevisada: true, updatedBy: user },
      update: { tipoProduto: tipo, classificacaoRevisada: true, updatedBy: user },
    });
    this.invalidateClsMap();
    return { ok: true, ref, tipoProduto: tipo };
  }

  /**
   * Alteração em LOTE. Recebe lista explícita de refs OU um filtro
   * ("marcar todos os filtrados"). Roda em transação + grava IntegrationLog.
   */
  async bulk(input: {
    tipoProduto: number;
    refs?: string[];
    filtro?: CatalogFilters;
    user: string;
  }) {
    const tipo = input.tipoProduto === 1 ? 1 : 0;

    let refs: string[];
    if (input.refs && input.refs.length) {
      refs = input.refs.map((r) => this.normRef(r)).filter(Boolean);
    } else if (input.filtro) {
      const [snap, cls, searchRefs] = await Promise.all([
        this.getSnapshot(),
        this.getClsMap(),
        this.resolveSearchRefs(input.filtro.search),
      ]);
      refs = this.applyFilters(snap, cls, input.filtro, searchRefs).map((r) => r.ref);
    } else {
      return { ok: false, error: 'informe refs[] ou filtro', alterados: 0 };
    }

    // Dedup
    refs = Array.from(new Set(refs));
    if (!refs.length) return { ok: true, alterados: 0 };

    // Upsert em chunks via INSERT ... ON CONFLICT, tudo numa transação.
    const ops: any[] = [];
    for (let i = 0; i < refs.length; i += UPSERT_CHUNK) {
      const chunk = refs.slice(i, i + UPSERT_CHUNK);
      const values: string[] = [];
      const params: any[] = [];
      let p = 1;
      for (const ref of chunk) {
        values.push(`($${p++}, $${p++}, true, $${p++}, NOW())`);
        params.push(ref, tipo, input.user);
      }
      const sql = `
        INSERT INTO product_classification (ref, tipo_produto, classificacao_revisada, updated_by, updated_at)
        VALUES ${values.join(', ')}
        ON CONFLICT (ref) DO UPDATE SET
          tipo_produto = EXCLUDED.tipo_produto,
          classificacao_revisada = true,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
      `;
      ops.push((this.prisma as any).$executeRawUnsafe(sql, ...params));
    }
    await (this.prisma as any).$transaction(ops);
    this.invalidateClsMap();

    // Auditoria — usa o IntegrationLog existente
    try {
      await (this.prisma as any).integrationLog.create({
        data: {
          source: 'crm',
          direction: 'out',
          event: 'product-classification.bulk-update',
          status: 200,
          payload: JSON.stringify({
            usuario: input.user,
            quando: new Date().toISOString(),
            quantidade: refs.length,
            para: tipo === 1 ? 'BASICO' : 'MODA',
            modo: input.refs?.length ? 'selecionados' : 'filtro',
            filtro: input.filtro || null,
          }).slice(0, 60000),
        },
      });
    } catch (e) {
      this.logger.warn(`bulk log falhou: ${(e as Error).message}`);
    }

    this.logger.log(`[classificacao] bulk ${tipo === 1 ? 'BASICO' : 'MODA'} em ${refs.length} REF(s) por ${input.user}`);
    return { ok: true, alterados: refs.length };
  }
}
