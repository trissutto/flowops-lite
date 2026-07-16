import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { ProductSearchService } from '../product-search/product-search.service';

/**
 * EDITOR DE PRODUTOS (/retaguarda/editor-produtos) — padronizar REF, corrigir
 * descrição/marca/cor/tamanho e alterar preço, linha a linha ou em bloco.
 *
 * REGRA DE OURO: o Flow é ESPELHO do Giga. Toda edição é gravada NO GIGA
 * (UPDATE produtos, com DATAALT=hoje pro sync incremental enxergar) e os
 * espelhos (giga_produto + wincred_produtos) são atualizados na sequência —
 * PDV/live/consulta refletem na hora, e o próximo sync full confirma.
 *
 * Shadow mode: EDITOR_PRODUTOS_WRITE=0 → loga a intenção na auditoria
 * (applied=false) SEM tocar o Giga. Auditoria sempre: cada campo alterado
 * vira uma linha ANTES→DEPOIS agrupada por batchId.
 */

export type EditChanges = {
  ref?: string;
  descricao?: string;
  marca?: string;
  cor?: string;
  tamanho?: string;
  preco?: number;
};

// Limites reais das colunas do Giga (ver inserirProdutosBatch).
const LIMITS: Record<string, number> = {
  ref: 10,
  descricao: 100,
  marca: 30,
  cor: 15,
  tamanho: 20,
};

@Injectable()
export class ProductsEditorService {
  private readonly logger = new Logger(ProductsEditorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly search: ProductSearchService,
  ) {}

  private get shadowMode(): boolean {
    return String(process.env.EDITOR_PRODUTOS_WRITE ?? '').trim() === '0';
  }

  /**
   * P3 da migração de produtos: PRODUCT_NATIVE_WRITES=1 → o FLOW vira a fonte
   * da verdade do cadastro. A edição grava PRIMEIRO na tabela nativa `product`
   * (com flowIsSource=true — o sync do espelho nunca mais sobrescreve a linha)
   * e REPLICA pro Giga na sequência (dual-write: o Wincred continua enxergando
   * tudo). Se a replicação falhar, a edição VALE (fonte é o Flow) e a falha
   * fica auditada (field=REPLICA_GIGA_ERRO) pra retry manual.
   * Rollback: tirar a env → volta ao modo atual (Giga primeiro, e o Giga está
   * em dia porque toda escrita nativa replicou).
   */
  private get nativeWrites(): boolean {
    return String(process.env.PRODUCT_NATIVE_WRITES ?? '').trim() === '1';
  }

  /** Mesma normalização do espelho Wincred: só dígitos perdem zeros à esquerda. */
  private normalizeCodigo(raw: any): string | null {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    if (!/^\d+$/.test(s)) return s;
    return s.replace(/^0+/, '') || '0';
  }

  /**
   * Busca pela rotina ÚNICA (diretriz 10/07) e enriquece com MARCA/preço:
   * 1º tenta o Giga ao vivo (tem MARCA, que o espelho giga_produto não tem);
   * se o Giga falhar/demorar, cai pro espelho Wincred (tem marca, mas só
   * produtos plus) e por fim segue sem marca — a tela nunca trava.
   */
  async searchProdutos(q: string) {
    const term = String(q || '').trim();
    if (!term) throw new BadRequestException('Informe o termo de busca');

    // Teto 5.000 variações (pedido do dono 13/07: "deixar livre" — o teto é só
    // proteção pro navegador; nenhuma família real chega perto disso).
    // PERF (13/07, caso ROVITEX): com a tabela nativa ativa, marca/preço saem
    // DELA (1 query no Postgres) — nada de enriquecer via Giga ao vivo em
    // lotes sequenciais (17 idas à KingHost deixavam a busca em dezenas de
    // segundos pra marcas grandes).
    const nativeReads = String(process.env.PRODUCT_NATIVE_READS ?? '').trim() === '1';

    const base = await this.search.resolveRows(term, { fallbackTake: 5000 });
    if (!base.length) return { rows: [], fonte: 'espelho', warnings: { legendaAtiva: [], classificacao: [] } };

    const codigos = Array.from(
      new Set(base.map((r: any) => String(r.codigo || '').trim()).filter(Boolean)),
    ).slice(0, 5000);

    // ── Enriquecimento (MARCA + preço + descrição frescos) ──
    let fonte: 'giga' | 'espelho' | 'flow' = 'espelho';
    const extra = new Map<string, { marca: string | null; vendaUn: number | null; descricao: string | null; ref: string | null; cor: string | null; tamanho: string | null }>();
    if (nativeReads) {
      // Tabela nativa é a fonte: 1 query no Postgres resolve tudo.
      const prows: any[] = await (this.prisma as any).product.findMany({
        where: { codigo: { in: codigos } },
        select: { codigo: true, marca: true, vendaUn: true, descricaoCompleta: true, ref: true, cor: true, tamanho: true },
      });
      for (const r of prows) {
        extra.set(String(r.codigo).trim(), {
          marca: r.marca != null ? String(r.marca).trim() : null,
          vendaUn: r.vendaUn != null ? Number(r.vendaUn) : null,
          descricao: r.descricaoCompleta != null ? String(r.descricaoCompleta) : null,
          ref: r.ref != null ? String(r.ref).trim() : null,
          cor: r.cor != null ? String(r.cor).trim() : null,
          tamanho: r.tamanho != null ? String(r.tamanho).trim() : null,
        });
      }
      fonte = 'flow';
    } else {
    try {
      for (let i = 0; i < codigos.length; i += 300) {
        const chunk = codigos.slice(i, i + 300);
        const placeholders = chunk.map(() => '?').join(',');
        const res = await this.erp.runReadOnly(
          `SELECT CODIGO, REF, DESCRICAOCOMPLETA, MARCA, COR, TAMANHO, VENDAUN
             FROM produtos WHERE CODIGO IN (${placeholders})`,
          { maxRows: 1000, timeoutMs: 8000 },
          chunk,
        );
        for (const r of res.rows as any[]) {
          extra.set(String(r.CODIGO).trim(), {
            marca: r.MARCA != null ? String(r.MARCA).trim() : null,
            vendaUn: r.VENDAUN != null ? Number(r.VENDAUN) : null,
            descricao: r.DESCRICAOCOMPLETA != null ? String(r.DESCRICAOCOMPLETA) : null,
            ref: r.REF != null ? String(r.REF).trim() : null,
            cor: r.COR != null ? String(r.COR).trim() : null,
            tamanho: r.TAMANHO != null ? String(r.TAMANHO).trim() : null,
          });
        }
      }
      fonte = 'giga';
    } catch (e) {
      this.logger.warn(`searchProdutos: Giga ao vivo falhou (${(e as Error).message}) — marca via espelho Wincred`);
      try {
        const norm = codigos.map((c) => this.normalizeCodigo(c)!).filter(Boolean);
        const wrows: any[] = await (this.prisma as any).wincredProduto.findMany({
          where: { codigo: { in: norm } },
          select: { codigo: true, marca: true, vendaUn: true },
        });
        const byNorm = new Map(wrows.map((w) => [w.codigo, w]));
        for (const c of codigos) {
          const w = byNorm.get(this.normalizeCodigo(c)!);
          if (w) extra.set(c, { marca: w.marca ?? null, vendaUn: w.vendaUn != null ? Number(w.vendaUn) : null, descricao: null, ref: null, cor: null, tamanho: null });
        }
      } catch { /* segue sem marca */ }
    }
    }

    // ── Estoque (espelho = fonte desde 14/07): total + POR LOJA ──
    const estoquePorCodigo = new Map<string, number>();
    const estoqueLojasPorCodigo = new Map<string, Record<string, number>>();
    try {
      const est: any[] = await (this.prisma as any).gigaEstoque.findMany({
        where: { codigo: { in: codigos } },
        select: { codigo: true, loja: true, estoque: true },
      });
      for (const e of est) {
        const qtd = Number(e.estoque) || 0;
        estoquePorCodigo.set(e.codigo, (estoquePorCodigo.get(e.codigo) || 0) + qtd);
        const loja = String(e.loja || '').trim().padStart(2, '0');
        const m = estoqueLojasPorCodigo.get(e.codigo) || {};
        m[loja] = (m[loja] || 0) + qtd;
        estoqueLojasPorCodigo.set(e.codigo, m);
      }
    } catch { /* informativo */ }

    // ── Monta linhas: Giga fresco > espelho ──
    const rows = base
      .filter((r: any) => String(r.codigo || '').trim() && codigos.includes(String(r.codigo).trim()))
      .map((r: any) => {
        const codigo = String(r.codigo).trim();
        const ex = extra.get(codigo);
        return {
          codigo,
          ref: (ex?.ref ?? (r.ref != null ? String(r.ref).trim() : '')) || '',
          descricao: ex?.descricao ?? (r.descricao != null ? String(r.descricao) : ''),
          marca: ex?.marca ?? null,
          cor: ex?.cor ?? (r.cor != null ? String(r.cor).trim() : ''),
          tamanho: ex?.tamanho ?? (r.tamanho != null ? String(r.tamanho).trim() : ''),
          preco: ex?.vendaUn ?? (r as any).vendaUn ?? null,
          estoque: estoquePorCodigo.get(codigo) ?? null,
          estoqueLojas: estoqueLojasPorCodigo.get(codigo) ?? {},
        };
      })
      .sort((a, b) =>
        (a.ref || '').localeCompare(b.ref || '') ||
        (a.descricao || '').localeCompare(b.descricao || '') ||
        (a.cor || '').localeCompare(b.cor || '') ||
        (a.tamanho || '').localeCompare(b.tamanho || ''),
      );

    // ── Avisos: REF em legenda de live ATIVA + classificação existente ──
    const refs = Array.from(new Set(rows.map((r) => r.ref).filter(Boolean)));
    let legendaAtiva: Array<{ refCode: string; atalho: string }> = [];
    let classificacao: Array<{ ref: string; tipoProduto: number }> = [];
    if (refs.length) {
      try {
        legendaAtiva = await (this.prisma as any).livePdvAtalho.findMany({
          where: { refCode: { in: refs }, session: { NOT: { status: 'ended' } } },
          select: { refCode: true, atalho: true },
        });
      } catch { /* aviso opcional */ }
      try {
        classificacao = await (this.prisma as any).productClassification.findMany({
          where: { ref: { in: refs } },
          select: { ref: true, tipoProduto: true },
        });
      } catch { /* aviso opcional */ }
    }

    return { rows, fonte, shadowMode: this.shadowMode, warnings: { legendaAtiva, classificacao } };
  }

  /**
   * Colisão de REF: quantas variações JÁ usam a REF destino (fora as que estão
   * sendo renomeadas). >0 = a renomeação vai FUNDIR com outro produto.
   */
  async refInfo(ref: string, excludeCodigos: string[]) {
    const target = String(ref || '').trim().toUpperCase();
    if (!target) throw new BadRequestException('Informe a REF');
    const where: any = { ref: target };
    if (excludeCodigos.length) where.codigo = { notIn: excludeCodigos };
    const [count, sample] = await Promise.all([
      (this.prisma as any).gigaProduto.count({ where }),
      (this.prisma as any).gigaProduto.findFirst({ where, select: { descricao: true } }),
    ]);
    return { ref: target, existentes: count, exemploDescricao: sample?.descricao ?? null };
  }

  /**
   * HISTÓRICO DE UMA VARIAÇÃO (código/SKU) — quando vendeu, pra quem, quem
   * vendeu, e se voltou (devolução/troca). Pedido do dono (16/07).
   *
   * Fontes:
   *  - VENDAS/MARCADOS: `caixa` do Giga (histórico completo, TODAS as lojas).
   *    MARCADO='SIM' = "provar em casa"; linha negativa = devolução legada.
   *  - DEVOLUÇÕES/TROCAS: `PdvReturn` do Flow (da era FlowOps pra cá) que
   *    tocaram este SKU. Troca antiga só-no-Giga não tem registro estruturado.
   *  - Nome da vendedora: espelho `wincred_funcionarios` (VENDEDOR = código).
   */
  async historicoProduto(codigoRaw: string) {
    const codigo = String(codigoRaw || '').replace(/\D/g, '');
    if (!codigo) throw new BadRequestException('Informe o código da variação');
    const codNum = Number(codigo);
    const skuNorm = codigo.replace(/^0+/, '') || codigo;

    // 1) Vendas/marcados no Giga (caixa) — read-only, todas as lojas.
    let caixaRows: any[] = [];
    try {
      const res = await this.erp.runReadOnly(
        `SELECT REGISTRO, DATA, HORA, LOJA, NOMECLIENTE, VENDEDOR,
                QUANTIDADE, VALORTOTAL, MARCADO
           FROM caixa
          WHERE CAST(CODIGO AS UNSIGNED) = ?
          ORDER BY DATA DESC, HORA DESC`,
        { maxRows: 500, timeoutMs: 20000 },
        [codNum],
      );
      caixaRows = res.rows || [];
    } catch (e: any) {
      this.logger.warn(`[historico] caixa falhou p/ ${codigo}: ${e?.message || e}`);
    }

    // 2) Nome da vendedora (espelho) + nome da loja.
    const vendCodes = Array.from(
      new Set(caixaRows.map((r) => String(r.VENDEDOR ?? '').trim()).filter(Boolean)),
    );
    const nomeVend = new Map<string, string>();
    if (vendCodes.length) {
      const funcs = await (this.prisma as any).wincredFuncionario
        .findMany({ where: { codigo: { in: vendCodes } }, select: { codigo: true, nome: true } })
        .catch(() => []);
      for (const f of funcs as any[]) nomeVend.set(String(f.codigo).trim(), f.nome || '');
    }
    const stores = await (this.prisma as any).store
      .findMany({ select: { code: true, name: true } })
      .catch(() => []);
    const storeName = new Map<string, string>(
      (stores as any[]).map((s) => [String(s.code).trim().replace(/^0+/, ''), s.name]),
    );
    const lojaNome = (loja: any) => {
      const c = String(loja ?? '').trim().replace(/^0+/, '');
      return storeName.get(c) || (loja ? `Loja ${loja}` : '—');
    };

    const vendas = caixaRows.map((r) => {
      const marcado = String(r.MARCADO ?? '').toUpperCase() === 'SIM';
      const valor = Number(r.VALORTOTAL) || 0;
      const qty = Number(r.QUANTIDADE) || 1;
      const devolucaoLegada = valor < 0 || qty < 0;
      return {
        tipo: marcado ? 'marcado' : devolucaoLegada ? 'devolucao' : 'venda',
        data: r.DATA ? new Date(r.DATA).toISOString() : null,
        hora: r.HORA ? String(r.HORA) : null,
        loja: lojaNome(r.LOJA),
        cliente: (String(r.NOMECLIENTE || '').trim()) || null,
        vendedora:
          nomeVend.get(String(r.VENDEDOR ?? '').trim()) ||
          (r.VENDEDOR ? `Cód ${r.VENDEDOR}` : null),
        qty: Math.abs(qty),
        valor: Math.abs(valor),
        fonte: 'giga',
      };
    });

    // 3) Devoluções/trocas no Flow (PdvReturn) que tocaram este SKU.
    let devolucoes: any[] = [];
    try {
      const items = await (this.prisma as any).pdvReturnItem.findMany({
        where: { sku: { in: Array.from(new Set([codigo, skuNorm])) } },
        select: {
          qty: true,
          total: true,
          return: {
            select: {
              storeCode: true, storeName: true, modo: true, valorTotal: true,
              customerName: true, motivo: true, createdAt: true, status: true,
            },
          },
        },
        take: 300,
      });
      devolucoes = (items as any[])
        .filter((it) => it.return && it.return.status !== 'cancelled')
        .map((it) => ({
          tipo: it.return.modo === 'troca' ? 'troca' : 'devolucao',
          data: it.return.createdAt ? new Date(it.return.createdAt).toISOString() : null,
          hora: null,
          loja: it.return.storeName || lojaNome(it.return.storeCode),
          cliente: it.return.customerName || null,
          vendedora: null,
          qty: it.qty || 1,
          valor: Math.abs(Number(it.total) || 0),
          modo: it.return.modo,
          motivo: it.return.motivo || null,
          fonte: 'flow',
        }));
    } catch (e: any) {
      this.logger.warn(`[historico] returns falhou p/ ${codigo}: ${e?.message || e}`);
    }

    const movimentos = [...vendas, ...devolucoes].sort((a, b) =>
      String(b.data || '').localeCompare(String(a.data || '')),
    );

    return {
      codigo,
      resumo: {
        vendas: vendas.filter((v) => v.tipo === 'venda').length,
        devolucoes:
          devolucoes.filter((d) => d.tipo === 'devolucao').length +
          vendas.filter((v) => v.tipo === 'devolucao').length,
        trocas: devolucoes.filter((d) => d.tipo === 'troca').length,
        marcados: vendas.filter((v) => v.tipo === 'marcado').length,
      },
      movimentos,
    };
  }

  /**
   * Aplica um lote de edições. Cada item: { codigo, changes }.
   * Valida limites → grava no GIGA (transação única) → atualiza espelhos →
   * audita campo a campo. Em shadow mode só audita (applied=false).
   */
  async apply(input: {
    edits: Array<{ codigo: string; changes: EditChanges }>;
    userName?: string | null;
  }) {
    const edits = (input.edits || []).filter((e) => e && e.codigo && e.changes);
    if (!edits.length) throw new BadRequestException('Nenhuma edição informada');
    if (edits.length > 5000) throw new BadRequestException('Máximo 5.000 variações por lote');

    // ── Validação de campos/limites ──
    for (const e of edits) {
      const c = e.changes;
      for (const [field, max] of Object.entries(LIMITS)) {
        const v = (c as any)[field];
        if (v !== undefined && String(v).trim().length > max) {
          throw new BadRequestException(
            `${field.toUpperCase()} "${String(v).trim().slice(0, 30)}…" passa do limite do Giga (${max} caracteres)`,
          );
        }
      }
      if (c.ref !== undefined && !String(c.ref).trim()) {
        throw new BadRequestException(`REF não pode ficar vazia (código ${e.codigo})`);
      }
      if (c.descricao !== undefined && !String(c.descricao).trim()) {
        throw new BadRequestException(`Descrição não pode ficar vazia (código ${e.codigo})`);
      }
      if (c.preco !== undefined) {
        const n = Number(c.preco);
        if (!isFinite(n) || n <= 0) {
          throw new BadRequestException(`Preço inválido no código ${e.codigo} — informe em REAIS (ex: 129.90)`);
        }
        // Guard-rail do bug ÷100: preço de roupa não é centavos nem milhões.
        if (n > 100000) throw new BadRequestException(`Preço R$ ${n} no código ${e.codigo} parece errado (limite 100.000)`);
      }
    }

    // ── Valores atuais (espelho) pra auditoria ANTES→DEPOIS ──
    const codigos = edits.map((e) => e.codigo);
    const atuais: any[] = await (this.prisma as any).gigaProduto.findMany({
      where: { codigo: { in: codigos } },
    });
    const atualPorCodigo = new Map(atuais.map((a) => [String(a.codigo).trim(), a]));

    const batchId = randomUUID();
    const auditRows: any[] = [];
    const erpRows: Array<{ codigo: string; set: any }> = [];

    for (const e of edits) {
      const atual = atualPorCodigo.get(e.codigo);
      const c = e.changes;
      const set: any = {};
      const push = (field: string, oldV: any, newV: any) => {
        auditRows.push({
          batchId,
          codigo: e.codigo,
          ref: atual?.ref ?? null,
          field,
          oldValue: oldV != null ? String(oldV).slice(0, 200) : null,
          newValue: newV != null ? String(newV).slice(0, 200) : null,
          userName: input.userName || null,
          applied: !this.shadowMode,
        });
      };
      if (c.ref !== undefined) { const v = String(c.ref).trim().toUpperCase(); set.ref = v; push('REF', atual?.ref, v); }
      if (c.descricao !== undefined) { const v = String(c.descricao).trim().toUpperCase(); set.descricaoCompleta = v; push('DESCRICAO', atual?.descricao, v); }
      if (c.marca !== undefined) { const v = String(c.marca).trim().toUpperCase(); set.marca = v; push('MARCA', null, v); }
      if (c.cor !== undefined) { const v = String(c.cor).trim().toUpperCase(); set.cor = v; push('COR', atual?.cor, v); }
      if (c.tamanho !== undefined) { const v = String(c.tamanho).trim().toUpperCase(); set.tamanho = v; push('TAMANHO', atual?.tamanho, v); }
      if (c.preco !== undefined) { const v = Math.round(Number(c.preco) * 100) / 100; set.vendaUn = v; push('PRECO', atual?.vendaUn, v); }
      if (Object.keys(set).length) erpRows.push({ codigo: e.codigo, set });
    }

    if (!erpRows.length) throw new BadRequestException('Nenhum campo alterado');

    // ── SHADOW MODE: só audita, não grava ──
    if (this.shadowMode) {
      await (this.prisma as any).productEditAudit.createMany({ data: auditRows });
      this.logger.warn(`[editor-produtos] SHADOW MODE: ${erpRows.length} updates NÃO gravados (EDITOR_PRODUTOS_WRITE=0), batch ${batchId}`);
      return { ok: true, shadow: true, batchId, atualizados: 0, planejados: erpRows.length };
    }

    // ── GRAVAÇÃO ──
    // PERF (13/07): agrupa por payload IGUAL — ação em bloco (marca/preço
    // igual em N variações) vira UMA query por tabela em vez de N (era o
    // "preenchimento lento" na troca de marcas).
    const buildData = (set: any) => {
      const data: any = {};
      if (set.ref !== undefined) data.ref = set.ref;
      if (set.descricaoCompleta !== undefined) {
        data.descricaoCompleta = set.descricaoCompleta;
        data.descricaoPdv = String(set.descricaoCompleta).slice(0, 50);
      }
      if (set.marca !== undefined) data.marca = set.marca;
      if (set.cor !== undefined) data.cor = set.cor;
      if (set.tamanho !== undefined) data.tamanho = set.tamanho;
      if (set.vendaUn !== undefined) data.vendaUn = set.vendaUn;
      return data;
    };
    const grupos = new Map<string, { set: any; codigos: string[] }>();
    for (const r of erpRows) {
      const key = JSON.stringify(r.set);
      const g = grupos.get(key);
      if (g) g.codigos.push(r.codigo);
      else grupos.set(key, { set: r.set, codigos: [r.codigo] });
    }
    const comNormalizados = (codigos: string[]) =>
      Array.from(new Set(codigos.flatMap((c) => [c, this.normalizeCodigo(c)!].filter(Boolean))));

    // Modo NATIVO (P3): Flow primeiro (fonte da verdade) + réplica pro Giga.
    // Modo padrão: Giga primeiro (fonte da verdade) — comportamento original.
    let atualizados = 0;
    if (this.nativeWrites) {
      const now = new Date();
      for (const g of grupos.values()) {
        const res = await (this.prisma as any).product.updateMany({
          where: { codigo: { in: comNormalizados(g.codigos) } },
          data: { ...buildData(g.set), flowIsSource: true, editedAt: now },
        });
        atualizados += Number(res.count) || 0;
      }
      // Réplica pro Giga (dual-write). Falha NÃO desfaz a edição — audita.
      try {
        await this.erp.updateProdutosCampos(erpRows);
      } catch (eGiga) {
        const msg = (eGiga as Error).message?.slice(0, 180) || 'erro';
        this.logger.error(`[editor-produtos] réplica pro Giga FALHOU (${msg}) — edição vale no Flow, batch ${batchId}`);
        auditRows.push({
          batchId,
          codigo: 'BATCH',
          ref: null,
          field: 'REPLICA_GIGA_ERRO',
          oldValue: null,
          newValue: msg,
          userName: input.userName || null,
          applied: true,
        });
      }
    } else {
      // ── GRAVA NO GIGA (fonte da verdade no modo padrão) ──
      const r = await this.erp.updateProdutosCampos(erpRows);
      atualizados = r.atualizados;
      // Mantém a tabela nativa fresca (sem flowIsSource — Giga segue como fonte).
      for (const g of grupos.values()) {
        await (this.prisma as any).product
          .updateMany({
            where: { codigo: { in: comNormalizados(g.codigos) } },
            data: buildData(g.set),
          })
          .catch(() => null);
      }
    }

    // ── ESPELHOS: reflete na hora (o sync incremental confirma depois) ──
    for (const g of grupos.values()) {
      try {
        const gp: any = {};
        if (g.set.ref !== undefined) gp.ref = g.set.ref;
        if (g.set.descricaoCompleta !== undefined) gp.descricao = g.set.descricaoCompleta;
        if (g.set.cor !== undefined) gp.cor = g.set.cor;
        if (g.set.tamanho !== undefined) gp.tamanho = g.set.tamanho;
        if (g.set.vendaUn !== undefined) gp.vendaUn = g.set.vendaUn;
        if (Object.keys(gp).length) {
          await (this.prisma as any).gigaProduto.updateMany({
            where: { codigo: { in: g.codigos } },
            data: gp,
          });
        }
        const w = buildData(g.set);
        if (Object.keys(w).length) {
          // ⚠️ NÃO tocar dataAlt (incidente 14/07): é a data de CADASTRO que
          // a promoção Liquida Antigos usa. Edição não muda idade da peça.
          await (this.prisma as any).wincredProduto.updateMany({
            where: { codigo: { in: g.codigos.map((c) => this.normalizeCodigo(c)!).filter(Boolean) } },
            data: w,
          });
        }
      } catch (e2) {
        // Espelho desatualizado não é fatal: o sync incremental corrige (DATAALT foi tocada no Giga).
        this.logger.warn(`[editor-produtos] espelho não atualizou (grupo de ${g.codigos.length}): ${(e2 as Error).message}`);
      }
    }

    await (this.prisma as any).productEditAudit.createMany({ data: auditRows });
    this.logger.log(`[editor-produtos] batch ${batchId}: ${atualizados} produtos gravados no Giga por ${input.userName || '?'}`);
    return { ok: true, shadow: false, batchId, atualizados, planejados: erpRows.length };
  }

  /**
   * MARCA EM MASSA NO SERVIDOR (13/07): aplica a marca em TODOS os resultados
   * da busca, SEM o teto de 5.000 da tela (marcas com dezenas de milhares de
   * variações não cabem no navegador). Mesma ordem de gravação do apply():
   * nativo-primeiro com réplica quando PRODUCT_NATIVE_WRITES=1; senão
   * Giga-primeiro. Auditoria em UMA linha-resumo por lote (o detalhe linha a
   * linha de 20k+ variações não agrega — o resumo diz busca, marca e volume).
   */
  async applyMarcaBySearch(input: { q: string; marca: string; userName?: string | null }) {
    const q = String(input.q || '').trim();
    const marca = String(input.marca || '').trim().toUpperCase();
    if (!q) throw new BadRequestException('Informe o termo de busca');
    if (!marca) throw new BadRequestException('Informe a marca');
    if (marca.length > LIMITS.marca) {
      throw new BadRequestException(`MARCA passa do limite do Giga (${LIMITS.marca} caracteres)`);
    }

    const rows = await this.search.resolveRows(q, { fallbackTake: 200000 });
    const codigos = Array.from(
      new Set(rows.map((r: any) => String(r.codigo || '').trim()).filter(Boolean)),
    );
    if (!codigos.length) throw new BadRequestException(`Busca "${q}" não encontrou nada`);

    const batchId = randomUUID();
    const auditResumo = {
      batchId,
      codigo: 'MASSA',
      ref: null,
      field: 'MARCA_EM_MASSA',
      oldValue: `busca "${q.slice(0, 80)}" → ${codigos.length} variações`,
      newValue: marca,
      userName: input.userName || null,
      applied: !this.shadowMode,
    };

    if (this.shadowMode) {
      await (this.prisma as any).productEditAudit.createMany({ data: [auditResumo] });
      return { ok: true, shadow: true, batchId, atualizados: 0, planejados: codigos.length };
    }

    const erpRows = codigos.map((c) => ({ codigo: c, set: { marca } }));
    let atualizados = 0;
    let replicaErro: string | null = null;

    if (this.nativeWrites) {
      const now = new Date();
      for (let i = 0; i < codigos.length; i += 10000) {
        const chunk = codigos.slice(i, i + 10000);
        const res = await (this.prisma as any).product.updateMany({
          where: { codigo: { in: Array.from(new Set(chunk.flatMap((c) => [c, this.normalizeCodigo(c)!].filter(Boolean)))) } },
          data: { marca, flowIsSource: true, editedAt: now },
        });
        atualizados += Number(res.count) || 0;
      }
      try {
        await this.erp.updateProdutosCampos(erpRows);
      } catch (eGiga) {
        replicaErro = (eGiga as Error).message?.slice(0, 180) || 'erro';
        this.logger.error(`[editor-produtos] réplica em massa pro Giga FALHOU (${replicaErro}), batch ${batchId}`);
      }
    } else {
      const r = await this.erp.updateProdutosCampos(erpRows);
      atualizados = r.atualizados;
      for (let i = 0; i < codigos.length; i += 10000) {
        const chunk = codigos.slice(i, i + 10000);
        await (this.prisma as any).product
          .updateMany({
            where: { codigo: { in: Array.from(new Set(chunk.flatMap((c) => [c, this.normalizeCodigo(c)!].filter(Boolean)))) } },
            data: { marca },
          })
          .catch(() => null);
      }
    }

    // Espelho Wincred (o giga_produto não tem coluna de marca).
    for (let i = 0; i < codigos.length; i += 10000) {
      const chunk = codigos.slice(i, i + 10000);
      await (this.prisma as any).wincredProduto
        .updateMany({
          where: { codigo: { in: chunk.map((c) => this.normalizeCodigo(c)!).filter(Boolean) } },
          data: { marca }, // ⚠️ sem dataAlt (incidente 14/07 — data de cadastro/promo)
        })
        .catch(() => null);
    }

    const audits: any[] = [auditResumo];
    if (replicaErro) {
      audits.push({
        batchId, codigo: 'BATCH', ref: null, field: 'REPLICA_GIGA_ERRO',
        oldValue: null, newValue: replicaErro, userName: input.userName || null, applied: true,
      });
    }
    await (this.prisma as any).productEditAudit.createMany({ data: audits });
    this.logger.log(`[editor-produtos] MARCA EM MASSA "${marca}" em ${codigos.length} variações (busca "${q}") por ${input.userName || '?'}`);
    return { ok: true, shadow: false, batchId, atualizados: atualizados || codigos.length, planejados: codigos.length };
  }

  // ── INCIDENTE 14/07 — DATAALT carimbada pelo editor (quebrou a promo) ────

  /** Raio-X do estrago: quantas linhas do nativo têm dataAlt nos dias das
   *  edições (13-14/07), separadas por flowIsSource (congeladas = fonte limpa). */
  async dataAltDiagnostico() {
    const p: any = this.prisma;
    const sujoDesde = new Date('2026-07-13T00:00:00Z');
    const [nativoSujo, nativoFrozenLimpo, nativoFrozenSujo, gigaEditados] = await Promise.all([
      p.product.count({ where: { dataAlt: { gte: sujoDesde }, flowIsSource: false } }),
      p.product.count({ where: { dataAlt: { lt: sujoDesde }, flowIsSource: true } }),
      p.product.count({ where: { dataAlt: { gte: sujoDesde }, flowIsSource: true } }),
      p.productEditAudit.findMany({
        where: { applied: true, codigo: { notIn: ['MASSA', 'BATCH'] } },
        select: { codigo: true },
        distinct: ['codigo'],
      }),
    ]);
    return {
      explicacao: 'frozenLimpo = flowIsSource com data antiga (restauráveis já); frozenSujo + auditados pré-flag precisam do backup',
      nativoComDataSuja_naoCongelado: nativoSujo,
      congeladosComDataLimpa_restauraveis: nativoFrozenLimpo,
      congeladosComDataSuja_precisamBackup: nativoFrozenSujo,
      codigosDistintosNaAuditoria: gigaEditados.length,
    };
  }

  /**
   * Restaura DATAALT no Giga + espelho Wincred.
   * - { source: 'native' } → usa a data CONGELADA da tabela nativa (linhas
   *   flowIsSource=true com dataAlt anterior a 13/07 — o sync nunca as
   *   sobrescreveu, então guardam a data de antes da edição).
   * - { pairs: [{codigo, dataAlt:'YYYY-MM-DD'}] } → lista explícita (extraída
   *   do backup do Postgres) pros casos que o nativo não cobre.
   */
  /** Progresso em memória da restauração em background. */
  private restauracao: {
    rodando: boolean; fonte: string; total: number; feitos: number;
    inicio: string | null; fim: string | null; erro: string | null;
  } = { rodando: false, fonte: '', total: 0, feitos: 0, inicio: null, fim: null, erro: null };

  restauracaoProgresso() {
    return this.restauracao;
  }

  async restaurarDataAlt(input: {
    source?: 'native' | 'ref';
    pairs?: Array<{ codigo: string; dataAlt: string }>;
    userName?: string | null;
  }) {
    if (this.restauracao.rodando) {
      return { ok: false, jaRodando: true, progresso: this.restauracao };
    }
    let pairs: Array<{ codigo: string; dataAlt: string }> = [];

    if (input.source === 'native') {
      const rows: any[] = await (this.prisma as any).product.findMany({
        where: { flowIsSource: true, dataAlt: { lt: new Date('2026-07-13T00:00:00Z') } },
        select: { codigo: true, dataAlt: true },
      });
      pairs = rows
        .filter((r) => r.dataAlt)
        .map((r) => ({ codigo: String(r.codigo), dataAlt: new Date(r.dataAlt).toISOString().slice(0, 10) }));
    } else if (input.source === 'ref') {
      // INFERÊNCIA POR REF: variações da mesma referência compartilham a data
      // de cadastro. Pra cada REF com linhas sujas, usa a DATA MAIS FREQUENTE
      // entre as irmãs LIMPAS. REF sem irmã limpa fica de fora (vai pro backup).
      const limpas: any[] = await (this.prisma as any).$queryRawUnsafe(
        `SELECT ref, "dataAlt"::date AS d, COUNT(*)::int AS n
           FROM product
          WHERE "dataAlt" < '2026-07-13' AND ref IS NOT NULL AND ref <> ''
          GROUP BY ref, "dataAlt"::date`,
      );
      const modaPorRef = new Map<string, { d: string; n: number }>();
      for (const r of limpas) {
        const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
        const cur = modaPorRef.get(r.ref);
        if (!cur || Number(r.n) > cur.n) modaPorRef.set(r.ref, { d, n: Number(r.n) });
      }
      const sujas: any[] = await (this.prisma as any).product.findMany({
        where: { dataAlt: { gte: new Date('2026-07-13T00:00:00Z') }, ref: { not: null } },
        select: { codigo: true, ref: true },
      });
      for (const s of sujas) {
        const moda = modaPorRef.get(s.ref);
        if (moda) pairs.push({ codigo: String(s.codigo), dataAlt: moda.d });
      }
    } else if (Array.isArray(input.pairs)) {
      pairs = input.pairs
        .filter((p) => p?.codigo && /^\d{4}-\d{2}-\d{2}$/.test(String(p.dataAlt || '')))
        .map((p) => ({ codigo: String(p.codigo).trim(), dataAlt: String(p.dataAlt) }));
    }
    if (!pairs.length) throw new BadRequestException('Nada pra restaurar com essa fonte');

    // Pequeno (até 2k) → processa inline. Grande → BACKGROUND com commit por
    // lote (o gateway cortava a chamada de 88k e a transação única sumia com
    // o progresso — incidente da manhã de 14/07).
    if (pairs.length <= 2000) {
      const n = await this.executarRestauracao(pairs, input.source || 'pairs', input.userName || null);
      return { ok: true, restaurados: n, pares: pairs.length, background: false };
    }
    this.restauracao = {
      rodando: true, fonte: input.source || 'pairs', total: pairs.length, feitos: 0,
      inicio: new Date().toISOString(), fim: null, erro: null,
    };
    void this.executarRestauracao(pairs, input.source || 'pairs', input.userName || null)
      .catch((e) => {
        this.restauracao.erro = (e as Error).message?.slice(0, 200) || 'erro';
      })
      .finally(() => {
        this.restauracao.rodando = false;
        this.restauracao.fim = new Date().toISOString();
      });
    return { ok: true, background: true, pares: pairs.length, acompanhe: 'GET /products-editor/restaurar-dataalt/progresso' };
  }

  /** Executa em lotes de 2.000 pares: Giga (autocommit) + espelho + nativa. */
  private async executarRestauracao(
    pairs: Array<{ codigo: string; dataAlt: string }>,
    fonte: string,
    userName: string | null,
  ): Promise<number> {
    let restaurados = 0;
    for (let i = 0; i < pairs.length; i += 2000) {
      const lote = pairs.slice(i, i + 2000);
      const { atualizados } = await this.erp.restoreDataAlt(lote);
      restaurados += atualizados;
      // Espelho + nativa, agrupado por data dentro do lote
      const porData = new Map<string, string[]>();
      for (const p of lote) {
        const list = porData.get(p.dataAlt) || [];
        list.push(this.normalizeCodigo(p.codigo)!);
        porData.set(p.dataAlt, list);
      }
      for (const [dataAlt, codigos] of porData.entries()) {
        const d = new Date(`${dataAlt}T00:00:00Z`);
        await (this.prisma as any).wincredProduto
          .updateMany({ where: { codigo: { in: codigos } }, data: { dataAlt: d } })
          .catch(() => null);
        await (this.prisma as any).product
          .updateMany({ where: { codigo: { in: codigos } }, data: { dataAlt: d } })
          .catch(() => null);
      }
      this.restauracao.feitos = Math.min(pairs.length, i + lote.length);
      this.logger.log(`[dataalt] restauração ${fonte}: ${this.restauracao.feitos}/${pairs.length}`);
    }
    await (this.prisma as any).productEditAudit.create({
      data: {
        batchId: randomUUID(),
        codigo: 'RESTAURACAO',
        ref: null,
        field: 'DATAALT_RESTAURADA',
        oldValue: `fonte=${fonte}`,
        newValue: `${pairs.length} pares processados, ${restaurados} linhas no Giga`,
        userName,
        applied: true,
      },
    }).catch(() => null);
    this.logger.log(`[dataalt] RESTAURAÇÃO CONCLUÍDA (${fonte}): ${restaurados} linhas no Giga`);
    return restaurados;
  }

  /**
   * FASE BACKUP (incidente DATAALT): conecta num Postgres TEMPORÁRIO
   * (restaurado do backup de mês passado), lê codigo→dataAlt original de
   * wincred_produtos, cruza com os códigos AINDA sujos no Giga e alimenta o
   * restaurador em background. O banco de produção não é tocado como fonte.
   */
  async restaurarDataAltDeBackup(input: { url: string; userName?: string | null }) {
    const url = String(input.url || '').trim();
    // 'self' = lê o PRÓPRIO banco de produção (usado no swap de volume: o
    // volume do backup de mês passado é montado temporariamente em produção,
    // extraímos as datas daqui mesmo e depois o volume atual volta).
    const useSelf = url === 'self';
    // 'peer://host[:porta]' = mesmo usuário/senha/banco do env DATABASE_URL,
    // trocando só o host (Postgres temporário na rede interna do Railway,
    // montado com o volume do backup — a senha nunca sai do servidor).
    let effectiveUrl = url;
    if (url.startsWith('peer://')) {
      const peer = url.slice('peer://'.length).replace(/\/+$/, '');
      const base = process.env.DATABASE_URL || '';
      const m = base.match(/^(postgres(?:ql)?:\/\/[^@]+@)([^/?]+)(.*)$/);
      if (!m || !peer) throw new BadRequestException('peer:// inválido ou DATABASE_URL ausente');
      effectiveUrl = `${m[1]}${peer.includes(':') ? peer : peer + ':5432'}${m[3]}`;
    } else if (!useSelf && !/^postgres(ql)?:\/\//.test(url)) {
      throw new BadRequestException('URL do Postgres temporário inválida (ou use "self"/"peer://host")');
    }
    if (this.restauracao.rodando) return { ok: false, jaRodando: true, progresso: this.restauracao };

    // 1) Códigos ainda sujos no Giga — paginado (são ~74k e o runReadOnly
    //    limita 50k por query)
    const sujos = new Set<string>();
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const res = await this.erp.runReadOnly(
        `SELECT CODIGO FROM produtos
          WHERE DATAALT >= '2026-07-13' AND CODIGO > '${cursor.replace(/'/g, '')}'
          ORDER BY CODIGO LIMIT 40000`,
        { maxRows: 40000, timeoutMs: 60_000 },
      );
      const rows = res.rows as any[];
      if (!rows.length) break;
      for (const r of rows) {
        const c = this.normalizeCodigo(String(r.CODIGO));
        if (c) sujos.add(c);
      }
      cursor = String(rows[rows.length - 1].CODIGO);
      if (rows.length < 40000) break;
    }
    if (!sujos.size) return { ok: true, mensagem: 'Nenhum produto sujo restante' };

    // 2) Fonte das datas: banco do backup (URL) ou o próprio banco ('self')
    const backupSql = `SELECT codigo, to_char("dataAlt", 'YYYY-MM-DD') AS d
           FROM wincred_produtos
          WHERE "dataAlt" IS NOT NULL`;
    let backupRows: any[] = [];
    if (useSelf) {
      backupRows = await (this.prisma as any).$queryRawUnsafe(backupSql);
    } else {
      const { PrismaClient } = require('@prisma/client');
      const temp = new PrismaClient({ datasources: { db: { url: effectiveUrl } } });
      try {
        backupRows = await temp.$queryRawUnsafe(backupSql);
      } finally {
        await temp.$disconnect().catch(() => null);
      }
    }

    // 3) Interseção: só restaura quem está sujo E existia no backup
    const pairs: Array<{ codigo: string; dataAlt: string }> = [];
    for (const r of backupRows) {
      const cod = this.normalizeCodigo(String(r.codigo));
      if (cod && sujos.has(cod) && r.d) pairs.push({ codigo: cod, dataAlt: String(r.d) });
    }
    if (!pairs.length) {
      return { ok: true, mensagem: 'Backup lido, mas nenhum código sujo consta nele (todos são cadastros novos?)', backupLinhas: backupRows.length, sujos: sujos.size };
    }

    this.restauracao = {
      rodando: true, fonte: 'backup', total: pairs.length, feitos: 0,
      inicio: new Date().toISOString(), fim: null, erro: null,
    };
    void this.executarRestauracao(pairs, 'backup', input.userName || null)
      .catch((e) => { this.restauracao.erro = (e as Error).message?.slice(0, 200) || 'erro'; })
      .finally(() => { this.restauracao.rodando = false; this.restauracao.fim = new Date().toISOString(); });

    return {
      ok: true, background: true,
      backupLinhas: backupRows.length, sujosNoGiga: sujos.size, paresARestaurar: pairs.length,
      acompanhe: 'GET /products-editor/restaurar-dataalt/progresso',
    };
  }

  /**
   * LEVA 4 (incidente DATAALT): prova de idade pela PRIMEIRA VENDA no caixa.
   * Código ainda sujo cuja primeira venda foi ANTES de 2026 é obviamente
   * antigo → DATAALT vira a data da 1ª venda (aproximação suficiente pra
   * promo YEAR_BASED; a data real de cadastro é anterior, nunca posterior).
   * Fontes: espelho giga_caixa_mov (rápido) + caixa do Giga ao vivo em chunks
   * pequenos read-only (só se CODIGO for indexado). Roda em background.
   */
  async restaurarDataAltPorCaixa(input: { userName?: string | null }) {
    if (this.restauracao.rodando) return { ok: false, jaRodando: true, progresso: this.restauracao };
    this.restauracao = {
      rodando: true, fonte: 'caixa', total: 0, feitos: 0,
      inicio: new Date().toISOString(), fim: null, erro: null,
    };
    void this.executarLevaCaixa(input.userName || null)
      .catch((e) => { this.restauracao.erro = (e as Error).message?.slice(0, 200) || 'erro'; })
      .finally(() => { this.restauracao.rodando = false; this.restauracao.fim = new Date().toISOString(); });
    return { ok: true, background: true, acompanhe: 'GET /products-editor/restaurar-dataalt/progresso' };
  }

  private async executarLevaCaixa(userName: string | null) {
    const prog = this.restauracao as any;

    // 1) Códigos ainda sujos no Giga (paginado)
    prog.etapa = 'lendo códigos sujos no Giga';
    const sujos: string[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const res = await this.erp.runReadOnly(
        `SELECT CODIGO FROM produtos
          WHERE DATAALT >= '2026-07-13' AND CODIGO > '${cursor.replace(/'/g, '')}'
          ORDER BY CODIGO LIMIT 40000`,
        { maxRows: 40000, timeoutMs: 60_000 },
      );
      const rows = res.rows as any[];
      if (!rows.length) break;
      for (const r of rows) {
        const c = this.normalizeCodigo(String(r.CODIGO));
        if (c) sujos.push(c);
      }
      cursor = String(rows[rows.length - 1].CODIGO);
      if (rows.length < 40000) break;
    }
    if (!sujos.length) return 0;

    // 2) Espelho giga_caixa_mov: 1ª venda por código (só PROVA idade se < 2026)
    prog.etapa = 'primeira venda no espelho';
    const first = new Map<string, string>();
    try {
      const mirror: Array<{ cod: string; d: string }> = await (this.prisma as any).$queryRawUnsafe(
        `SELECT regexp_replace(codigo, '^0+', '') AS cod, to_char(MIN(data), 'YYYY-MM-DD') AS d
           FROM giga_caixa_mov
          WHERE codigo IS NOT NULL AND data IS NOT NULL
          GROUP BY 1`,
      );
      for (const r of mirror) {
        if (r.cod && r.d) first.set(r.cod, String(r.d));
      }
    } catch (e) {
      this.logger.warn(`[dataalt] leva caixa: espelho falhou (${(e as Error).message}), seguindo só com Giga`);
    }

    // 3) Giga ao vivo pros sujos ainda sem prova de idade (espelho cobre só a
    //    janela recente — 1ª venda 2026 no espelho NÃO prova que é novo)
    const semProva = sujos.filter((c) => !(first.get(c) && first.get(c)! < '2026-01-01'));
    const indexado = await this.erp.caixaCodigoIndexed();
    if (indexado) {
      const CHUNK = 300;
      for (let i = 0; i < semProva.length; i += CHUNK) {
        prog.etapa = `varrendo caixa do Giga ${i}/${semProva.length}`;
        try {
          const m = await this.erp.getFirstSaleDatesChunk(semProva.slice(i, i + CHUNK));
          for (const [cod, d] of m.entries()) {
            const prev = first.get(cod);
            if (!prev || d < prev) first.set(cod, d);
          }
        } catch (e) {
          this.logger.warn(`[dataalt] leva caixa: chunk ${i} falhou: ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 200)); // respiro pro Giga
      }
    } else {
      this.logger.warn('[dataalt] leva caixa: caixa.CODIGO SEM índice — pulando varredura ao vivo');
    }

    // 4) Pares: só quem tem 1ª venda ANTES de 2026 (prova de idade)
    const pairs: Array<{ codigo: string; dataAlt: string }> = [];
    for (const c of sujos) {
      const d = first.get(c);
      if (d && d < '2026-01-01') pairs.push({ codigo: c, dataAlt: d });
    }
    this.logger.log(`[dataalt] leva caixa: ${sujos.length} sujos, ${pairs.length} com prova de idade pela caixa`);
    if (!pairs.length) return 0;

    prog.etapa = 'gravando no Giga';
    this.restauracao.total = pairs.length;
    return this.executarRestauracao(pairs, 'caixa', userName);
  }

  // ── AUDITORIA COMPLETA por arquivo (backup Giga 12/07) ────────────────────
  // O dono exportou CODIGO+DATAALT do backup de 12/07 (véspera do incidente).
  // Fluxo em 2 passos: (1) carregar o arquivo em memória (SEM escrita) e
  // (2) executar — compara o catálogo INTEIRO do Giga com o arquivo e corrige
  // TODA divergência (confere inclusive as levas 1-3).
  private arquivoPairs: Map<string, string> | null = null;

  carregarArquivoDataAlt(
    pairsIn: Array<{ codigo: string; dataAlt: string }>,
    opts: { zerar?: boolean } = {},
  ) {
    if (opts.zerar || !this.arquivoPairs) this.arquivoPairs = new Map();
    let invalidos = 0;
    let datasInvalidas = 0;
    let datasSuspeitas = 0;
    let colisoes = 0;
    for (const p of pairsIn || []) {
      const cod = this.normalizeCodigo(String(p?.codigo ?? ''));
      let d = String(p?.dataAlt ?? '').trim().slice(0, 10);
      const br = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (br) d = `${br[3]}-${br[2]}-${br[1]}`;
      if (!cod) { invalidos++; continue; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d.startsWith('0000')) { datasInvalidas++; continue; }
      // backup é de 12/07 — data igual/depois de 13/07 nele é lixo
      if (d >= '2026-07-13') { datasSuspeitas++; continue; }
      const prev = this.arquivoPairs.get(cod);
      if (prev !== undefined) {
        colisoes++;
        if (d < prev) this.arquivoPairs.set(cod, d); // colisão: fica a mais antiga
      } else {
        this.arquivoPairs.set(cod, d);
      }
    }
    return {
      ok: true,
      carregados: this.arquivoPairs.size,
      descartados: { codigoInvalido: invalidos, dataInvalida: datasInvalidas, dataSuspeita: datasSuspeitas },
      colisoesDeCodigo: colisoes,
    };
  }

  async executarAuditoriaArquivo(userName: string | null) {
    if (!this.arquivoPairs?.size) {
      throw new BadRequestException('Arquivo ainda não carregado (POST restaurar-dataalt-arquivo primeiro)');
    }
    if (this.restauracao.rodando) return { ok: false, jaRodando: true, progresso: this.restauracao };
    const mapa = this.arquivoPairs;
    this.restauracao = {
      rodando: true, fonte: 'arquivo', total: 0, feitos: 0,
      inicio: new Date().toISOString(), fim: null, erro: null,
    };
    const prog = this.restauracao as any;
    void (async () => {
      // 1) Catálogo INTEIRO do Giga, paginado
      prog.etapa = 'lendo catálogo do Giga';
      const divergentes: Array<{ codigo: string; dataAlt: string }> = [];
      let iguais = 0;
      let foraDoArquivo = 0;
      let catalogo = 0;
      let cursor = '';
      for (let page = 0; page < 15; page++) {
        const res = await this.erp.runReadOnly(
          `SELECT CODIGO, DATE_FORMAT(DATAALT, '%Y-%m-%d') AS d FROM produtos
            WHERE CODIGO > '${cursor.replace(/'/g, '')}'
            ORDER BY CODIGO LIMIT 40000`,
          { maxRows: 40000, timeoutMs: 90_000 },
        );
        const rows = res.rows as any[];
        if (!rows.length) break;
        catalogo += rows.length;
        prog.etapa = `lendo catálogo do Giga (${catalogo})`;
        for (const r of rows) {
          const cod = this.normalizeCodigo(String(r.CODIGO));
          if (!cod) continue;
          const alvo = mapa.get(cod);
          if (alvo === undefined) { foraDoArquivo++; continue; }
          const atual = String(r.d || '');
          if (atual === alvo) iguais++;
          else divergentes.push({ codigo: cod, dataAlt: alvo });
        }
        cursor = String(rows[rows.length - 1].CODIGO);
        if (rows.length < 40000) break;
      }
      prog.resumo = { catalogoGiga: catalogo, iguais, foraDoArquivo, divergentes: divergentes.length };
      this.logger.log(`[dataalt] auditoria arquivo: catálogo=${catalogo} iguais=${iguais} fora=${foraDoArquivo} divergentes=${divergentes.length}`);
      if (!divergentes.length) return;
      // 2) Corrige TODA divergência com a verdade de 12/07
      this.restauracao.total = divergentes.length;
      prog.etapa = 'corrigindo divergências';
      await this.executarRestauracao(divergentes, 'arquivo', userName);
    })()
      .catch((e) => { this.restauracao.erro = (e as Error).message?.slice(0, 200) || 'erro'; })
      .finally(() => { this.restauracao.rodando = false; this.restauracao.fim = new Date().toISOString(); });
    return { ok: true, background: true, pares: mapa.size, acompanhe: 'GET /products-editor/restaurar-dataalt/progresso' };
  }

  /**
   * EXCLUSÃO de produtos (tela do editor). Trava de segurança: código com
   * ESTOQUE > 0 em qualquer loja só sai com forcar=true. Apaga do Flow
   * (product, wincred_produtos, espelhos de estoque) na hora e replica a
   * exclusão pro Giga inline — Giga fora → outbox kind produto_exclusao.
   * Tudo auditado (ANTES da exclusão) em product_edit_audit.
   */
  async excluirProdutos(input: { codigos: string[]; forcar?: boolean; userName?: string | null }) {
    const codigos = Array.from(
      new Set(
        (input.codigos || [])
          .map((c) => this.normalizeCodigo(String(c || '')))
          .filter((c): c is string => !!c),
      ),
    );
    if (!codigos.length) throw new BadRequestException('Nenhum código informado');
    if (codigos.length > 500) throw new BadRequestException('Máximo de 500 produtos por exclusão');

    // Trava: estoque > 0 em alguma loja (espelho)
    if (!input.forcar) {
      const rows: any[] = await (this.prisma as any).wincredEstoque.findMany({
        where: { codigo: { in: codigos }, estoque: { gt: 0 } },
        select: { codigo: true, loja: true, estoque: true },
      });
      if (rows.length) {
        const bloqueados = Array.from(new Set(rows.map((r) => String(r.codigo))));
        return {
          ok: false,
          bloqueados,
          mensagem: `${bloqueados.length} código(s) com ESTOQUE > 0 — confirme com "forçar" pra excluir mesmo assim`,
        };
      }
    }

    // Auditoria ANTES de apagar (registra o que era)
    const antes: any[] = await (this.prisma as any).product.findMany({
      where: { codigo: { in: codigos } },
      select: { codigo: true, ref: true, descricaoCompleta: true },
    });
    const infoPorCodigo = new Map(antes.map((p) => [String(p.codigo), p]));
    const batchId = randomUUID();
    await (this.prisma as any).productEditAudit.createMany({
      data: codigos.map((c) => ({
        batchId,
        codigo: c,
        ref: infoPorCodigo.get(c)?.ref || null,
        field: 'EXCLUIDO',
        oldValue: (infoPorCodigo.get(c)?.descricaoCompleta || '').slice(0, 100) || null,
        newValue: input.forcar ? 'excluído (forçado, com estoque)' : 'excluído',
        userName: input.userName || null,
        applied: true,
      })),
    }).catch(() => null);

    // Flow primeiro (efeito imediato em busca/bipe/grade)
    await (this.prisma as any).product.deleteMany({ where: { codigo: { in: codigos } } }).catch(() => null);
    await (this.prisma as any).wincredProduto.deleteMany({ where: { codigo: { in: codigos } } }).catch(() => null);
    await (this.prisma as any).wincredEstoque.deleteMany({ where: { codigo: { in: codigos } } }).catch(() => null);
    await (this.prisma as any).gigaEstoque.deleteMany({ where: { codigo: { in: codigos } } }).catch(() => null);

    // Réplica no Giga: inline com fallback pro outbox
    let excluidosGiga = 0;
    let gigaEnfileirado = false;
    try {
      const r = await this.erp.deleteProdutos(codigos);
      excluidosGiga = r.excluidos;
    } catch (e) {
      gigaEnfileirado = true;
      await (this.prisma as any).erpOutbox.create({
        data: {
          kind: 'produto_exclusao',
          saleId: `del-${batchId}`,
          payload: { codigos },
          status: 'pending',
        },
      }).catch(() => null);
      this.logger.warn(`[editor] exclusão: Giga indisponível (${(e as Error).message}) — enfileirada no outbox`);
    }
    this.logger.log(
      `[editor] EXCLUSÃO: ${codigos.length} código(s) no Flow` +
        (gigaEnfileirado ? ' + Giga via outbox' : ` + ${excluidosGiga} no Giga`) +
        ` (por ${input.userName || '?'})`,
    );
    return { ok: true, excluidos: codigos.length, excluidosGiga, gigaEnfileirado, batchId };
  }

  /**
   * INCIDENTE DATAALT — passo final (14/07): a tabela NATIVA `product` guarda
   * cópia PRÓPRIA da data de cadastro, e o bipe do PDV lê DELA quando
   * PRODUCT_NATIVE_READS=1 — por isso a promo "Liquida antigos" continuava
   * mostrando "Sem promo · 2026" mesmo com Giga e espelho já restaurados.
   *
   * Copia a data DO ESPELHO wincred_produtos (ressincronizado do Giga já
   * corrigido pelo backup 12/07) pra nativa, SÓ nas linhas sujas:
   *   nativa >= 13/07 (carimbo do incidente)  E  espelho < 13/07 (data real).
   * NUNCA toca: o Giga, datas já corretas na nativa (< 13/07), e produtos
   * genuinamente novos (espelho também >= 13/07 → fora do WHERE).
   * Dry-run por padrão: devolve contagem + amostra SEM escrever nada.
   */
  async restaurarDataAltNativoDoEspelho(executar: boolean) {
    const whereSujo = `
      FROM product p
      JOIN wincred_produtos w ON w.codigo = p.codigo
     WHERE p."dataAlt" IS NOT NULL
       AND p."dataAlt" >= DATE '2026-07-13'
       AND w."dataAlt" IS NOT NULL
       AND w."dataAlt" < DATE '2026-07-13'`;
    const cand: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c ${whereSujo}`,
    );
    const candidatos = Number(cand?.[0]?.c || 0);
    const amostra: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT p.codigo, p.ref, p."dataAlt"::text AS nativa_suja, w."dataAlt"::text AS espelho_correto
       ${whereSujo}
       ORDER BY p.codigo
       LIMIT 10`,
    );
    if (!executar) return { dryRun: true, candidatos, amostra };
    const atualizados: number = await this.prisma.$executeRawUnsafe(
      `UPDATE product p
          SET "dataAlt" = w."dataAlt"
         FROM wincred_produtos w
        WHERE w.codigo = p.codigo
          AND p."dataAlt" IS NOT NULL
          AND p."dataAlt" >= DATE '2026-07-13'
          AND w."dataAlt" IS NOT NULL
          AND w."dataAlt" < DATE '2026-07-13'`,
    );
    this.logger.log(`[dataalt] nativa ← espelho: ${atualizados} linhas corrigidas`);
    return { dryRun: false, atualizados };
  }

  /**
   * MOVIMENTAÇÃO MANUAL de estoque (tela do editor, 15/07): entrada/saída com
   * loja + quantidade + MOTIVO obrigatório. Flow é a fonte (erp.increase/
   * decreaseStock já aplicam o delta no espelho primeiro e replicam pro Giga
   * inline/outbox). Tudo auditado em product_edit_audit.
   */
  async movimentarEstoque(input: {
    movimentos: Array<{ codigo: string; loja: string; qtd: number; tipo: 'entrada' | 'saida'; motivo: string }>;
    userName?: string | null;
  }) {
    const movs = (input.movimentos || [])
      .map((m) => ({
        codigo: this.normalizeCodigo(String(m?.codigo || '')) || '',
        loja: String(m?.loja || '').trim().padStart(2, '0'),
        qtd: Math.floor(Math.abs(Number(m?.qtd) || 0)),
        tipo: m?.tipo === 'saida' ? 'saida' as const : 'entrada' as const,
        motivo: String(m?.motivo || '').trim().slice(0, 60),
      }))
      .filter((m) => m.codigo && m.loja && m.qtd > 0);
    if (!movs.length) throw new BadRequestException('Nenhum movimento válido');
    if (movs.length > 200) throw new BadRequestException('Máximo de 200 movimentos por vez');
    if (movs.some((m) => !m.motivo)) throw new BadRequestException('Motivo é obrigatório em todo movimento');

    const batchId = randomUUID();
    const resultados: Array<{ codigo: string; loja: string; tipo: string; qtd: number; antes: number | null; depois: number | null; ok: boolean; erro?: string }> = [];

    const entradas = movs.filter((m) => m.tipo === 'entrada').map((m) => ({ sku: m.codigo, qty: m.qtd, storeCode: m.loja }));
    const saidas = movs.filter((m) => m.tipo === 'saida').map((m) => ({ sku: m.codigo, qty: m.qtd, storeCode: m.loja }));

    const aplicadoPorChave = new Map<string, { previousStock: number; newStock: number }>();
    let erroGeral: string | null = null;
    try {
      if (entradas.length) {
        const r = await this.erp.increaseStock(entradas);
        for (const a of r.applied || []) aplicadoPorChave.set(`entrada|${this.normalizeCodigo(a.sku)}|${String(a.storeCode).padStart(2, '0')}`, a);
        if (!r.success) erroGeral = r.error || 'falha na entrada';
      }
      if (saidas.length) {
        const r = await this.erp.decreaseStock(saidas, { allowNegative: false });
        for (const a of r.applied || []) aplicadoPorChave.set(`saida|${this.normalizeCodigo(a.sku)}|${String(a.storeCode).padStart(2, '0')}`, a);
        if (!r.success) erroGeral = erroGeral || r.error || 'falha na saída';
      }
    } catch (e) {
      erroGeral = (e as Error).message;
    }

    for (const m of movs) {
      const ap = aplicadoPorChave.get(`${m.tipo}|${m.codigo}|${m.loja}`);
      resultados.push({
        codigo: m.codigo, loja: m.loja, tipo: m.tipo, qtd: m.qtd,
        antes: ap ? ap.previousStock : null,
        depois: ap ? ap.newStock : null,
        ok: !!ap,
        erro: ap ? undefined : (erroGeral || 'não aplicado'),
      });
    }

    await (this.prisma as any).productEditAudit.createMany({
      data: movs.map((m) => {
        const ap = aplicadoPorChave.get(`${m.tipo}|${m.codigo}|${m.loja}`);
        return {
          batchId,
          codigo: m.codigo,
          ref: null,
          field: m.tipo === 'entrada' ? 'ESTOQUE_ENTRADA' : 'ESTOQUE_SAIDA',
          oldValue: ap ? `loja ${m.loja}: ${ap.previousStock}` : `loja ${m.loja}`,
          newValue: `${ap ? ap.newStock : '?'} (${m.tipo} ${m.qtd} — ${m.motivo})`,
          userName: input.userName || null,
          applied: !!ap,
        };
      }),
    }).catch(() => null);

    const aplicados = resultados.filter((r) => r.ok).length;
    this.logger.log(`[editor] movimentação: ${aplicados}/${movs.length} aplicado(s) (por ${input.userName || '?'})`);
    return { ok: aplicados > 0, aplicados, total: movs.length, resultados, batchId };
  }

  /** Últimos lotes de auditoria (tela mostra o histórico recente). */
  async auditRecent(limit = 200) {
    return (this.prisma as any).productEditAudit.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(500, Math.max(1, limit)),
    });
  }
}
