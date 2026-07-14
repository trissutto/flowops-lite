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

    const base = await this.search.resolveRows(term, { fallbackTake: 400 });
    if (!base.length) return { rows: [], fonte: 'espelho', warnings: { legendaAtiva: [], classificacao: [] } };

    const codigos = Array.from(
      new Set(base.map((r: any) => String(r.codigo || '').trim()).filter(Boolean)),
    ).slice(0, 600);

    // ── Enriquecimento (MARCA + preço + descrição frescos) ──
    let fonte: 'giga' | 'espelho' = 'espelho';
    const extra = new Map<string, { marca: string | null; vendaUn: number | null; descricao: string | null; ref: string | null; cor: string | null; tamanho: string | null }>();
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

    // ── Estoque total (espelho, informativo) ──
    const estoquePorCodigo = new Map<string, number>();
    try {
      const est: any[] = await (this.prisma as any).gigaEstoque.findMany({
        where: { codigo: { in: codigos } },
        select: { codigo: true, estoque: true },
      });
      for (const e of est) {
        estoquePorCodigo.set(e.codigo, (estoquePorCodigo.get(e.codigo) || 0) + (Number(e.estoque) || 0));
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
    if (edits.length > 500) throw new BadRequestException('Máximo 500 variações por lote');

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

    // ── GRAVA NO GIGA (fonte da verdade) ──
    const { atualizados } = await this.erp.updateProdutosCampos(erpRows);

    // ── ESPELHOS: reflete na hora (o sync incremental confirma depois) ──
    for (const r of erpRows) {
      const g: any = {};
      if (r.set.ref !== undefined) g.ref = r.set.ref;
      if (r.set.descricaoCompleta !== undefined) g.descricao = r.set.descricaoCompleta;
      if (r.set.cor !== undefined) g.cor = r.set.cor;
      if (r.set.tamanho !== undefined) g.tamanho = r.set.tamanho;
      if (r.set.vendaUn !== undefined) g.vendaUn = r.set.vendaUn;
      try {
        if (Object.keys(g).length) {
          await (this.prisma as any).gigaProduto.updateMany({ where: { codigo: r.codigo }, data: g });
        }
        const w: any = {};
        if (r.set.ref !== undefined) w.ref = r.set.ref;
        if (r.set.descricaoCompleta !== undefined) {
          w.descricaoCompleta = r.set.descricaoCompleta;
          w.descricaoPdv = String(r.set.descricaoCompleta).slice(0, 50);
        }
        if (r.set.marca !== undefined) w.marca = r.set.marca;
        if (r.set.cor !== undefined) w.cor = r.set.cor;
        if (r.set.tamanho !== undefined) w.tamanho = r.set.tamanho;
        if (r.set.vendaUn !== undefined) w.vendaUn = r.set.vendaUn;
        if (Object.keys(w).length) {
          w.dataAlt = new Date();
          await (this.prisma as any).wincredProduto.updateMany({
            where: { codigo: this.normalizeCodigo(r.codigo)! },
            data: w,
          });
        }
      } catch (e2) {
        // Espelho desatualizado não é fatal: o sync incremental corrige (DATAALT foi tocada no Giga).
        this.logger.warn(`[editor-produtos] espelho não atualizou pro código ${r.codigo}: ${(e2 as Error).message}`);
      }
    }

    await (this.prisma as any).productEditAudit.createMany({ data: auditRows });
    this.logger.log(`[editor-produtos] batch ${batchId}: ${atualizados} produtos gravados no Giga por ${input.userName || '?'}`);
    return { ok: true, shadow: false, batchId, atualizados, planejados: erpRows.length };
  }

  /** Últimos lotes de auditoria (tela mostra o histórico recente). */
  async auditRecent(limit = 200) {
    return (this.prisma as any).productEditAudit.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(500, Math.max(1, limit)),
    });
  }
}
