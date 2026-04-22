import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * SitePublishService — Fase 1 da integração Wincred → WooCommerce.
 *
 * Responsabilidade: gerenciar a FILA de referências que o CEO marcou pra
 * publicar no site. Cada linha da fila é uma combinação REF+COR (porque
 * no site cada cor é um produto separado, decisão de UX da loja).
 *
 * Fluxo de uso:
 *   1. CEO busca no Gigasistemas (via searchForPublish) — filtra REFs que
 *      quer subir.
 *   2. Marca as cores → chama addToQueue() que congela snapshot dos dados
 *      (descrição, custo, preço, estoque) no banco local.
 *   3. Na Fase 2 o CEO enriquece cada item (descrição, categoria, imagens).
 *   4. Na Fase 3 o sistema publica no WooCommerce via REST.
 *
 * Por que congelamos o snapshot:
 *   O Gigasistemas pode mudar o preço/estoque ENTRE o momento em que o CEO
 *   marcou e o momento em que o sistema vai publicar. Precisamos ter os
 *   dados estáveis pra mostrar no enriquecimento e pra auditoria posterior.
 *
 * Por que unique (refCode, cor):
 *   Impede o CEO de marcar a mesma REF+COR duas vezes e acabar duplicando
 *   o produto no site. Se re-marcar, faz upsert (atualiza snapshot).
 */
@Injectable()
export class SitePublishService {
  private readonly logger = new Logger(SitePublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  /**
   * Busca REFs no Gigasistemas para publicação. Aceita filtros combinados
   * (REF, descrição, grupo, subgrupo, fornecedor, dias de cadastro).
   */
  async searchGiga(filters: {
    refs?: string[];
    term?: string;
    grupo?: string;
    subgrupo?: string;
    fornecedor?: string;
    diasCadastro?: number;
    limit?: number;
  }) {
    return this.erp.searchRefsForPublish(filters);
  }

  /** Facets (grupos, subgrupos, fornecedores) pra dropdowns da tela. */
  async facets() {
    return this.erp.getGigaFacetsForPublish();
  }

  /**
   * Adiciona UMA COR de uma REF à fila de publicação.
   * Usa upsert: se já existe (refCode+cor), atualiza snapshot + mantém
   * qualquer enriquecimento já feito (não apaga descrição/imagens).
   */
  async addToQueue(params: {
    refCode: string;
    cor: string;
    userId?: string;
  }) {
    const refCode = String(params.refCode || '').trim();
    const cor = String(params.cor || '').trim();
    if (!refCode || !cor) {
      throw new BadRequestException('refCode e cor obrigatórios.');
    }

    const snapshot = await this.erp.getRefColorForQueue(refCode, cor);
    if (!snapshot) {
      throw new NotFoundException(`REF ${refCode} cor ${cor} não encontrada no Gigasistemas.`);
    }

    const tamanhosPayload = snapshot.tamanhos.map((t) => ({
      tamanho: t.tamanho,
      codigo: t.codigo,
      estoque: t.estoque,
      ean: t.ean,
    }));
    const gigaCodes = snapshot.tamanhos.map((t) => t.codigo).filter(Boolean);
    const estoqueTotal = snapshot.tamanhos.reduce((sum, t) => sum + (t.estoque || 0), 0);

    // Upsert idempotente. UpdateData só atualiza o snapshot (campos Giga),
    // nunca toca nos campos de enriquecimento (Fase 2) ou publicação (Fase 3).
    const result = await (this.prisma as any).sitePublishQueue.upsert({
      where: { uniq_ref_cor: { refCode, cor } },
      update: {
        gigaCodes,
        fornecedor: snapshot.fornecedor,
        grupo: snapshot.grupo,
        subgrupo: snapshot.subgrupo,
        ncm: snapshot.ncm,
        cfop: snapshot.cfop,
        custoMedio: snapshot.custo != null ? snapshot.custo : null,
        precoSugerido: snapshot.preco != null ? snapshot.preco : null,
        estoqueTotal,
        tamanhos: tamanhosPayload,
      },
      create: {
        refCode,
        cor,
        gigaCodes,
        fornecedor: snapshot.fornecedor,
        grupo: snapshot.grupo,
        subgrupo: snapshot.subgrupo,
        ncm: snapshot.ncm,
        cfop: snapshot.cfop,
        custoMedio: snapshot.custo != null ? snapshot.custo : null,
        precoSugerido: snapshot.preco != null ? snapshot.preco : null,
        estoqueTotal,
        tamanhos: tamanhosPayload,
        status: 'queued',
        createdByUserId: params.userId ?? null,
      },
    });
    this.logger.log(
      `Queue: ${refCode}/${cor} → ${result.status} (${gigaCodes.length} tamanhos, estoque ${estoqueTotal})`,
    );
    return result;
  }

  /**
   * Adiciona em batch (várias cores de uma REF, ou várias REFs).
   * Retorna quantos foram criados/atualizados/ignorados (erros).
   */
  async addToQueueBatch(
    items: Array<{ refCode: string; cor: string }>,
    userId?: string,
  ): Promise<{ added: number; errors: Array<{ refCode: string; cor: string; reason: string }> }> {
    if (!items.length) return { added: 0, errors: [] };
    const errors: Array<{ refCode: string; cor: string; reason: string }> = [];
    let added = 0;
    for (const it of items) {
      try {
        await this.addToQueue({ refCode: it.refCode, cor: it.cor, userId });
        added++;
      } catch (e: any) {
        errors.push({ refCode: it.refCode, cor: it.cor, reason: e?.message ?? String(e) });
      }
    }
    return { added, errors };
  }

  /** Lista a fila com filtro opcional por status. */
  async listQueue(filter: { status?: string }) {
    const where: any = {};
    if (filter.status) {
      where.status = filter.status;
    }
    const rows = await (this.prisma as any).sitePublishQueue.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    // Resumo por status pro badge na UI
    const counts = await (this.prisma as any).sitePublishQueue.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const summary: Record<string, number> = {};
    for (const c of counts) summary[c.status] = c._count._all;
    return { rows, summary };
  }

  /** Retorna um item da fila (pra enriquecimento). */
  async getQueueItem(id: string) {
    const row = await (this.prisma as any).sitePublishQueue.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Item não encontrado na fila.');
    return row;
  }

  /** Remove da fila (só se ainda não publicou). */
  async removeFromQueue(id: string) {
    const row = await (this.prisma as any).sitePublishQueue.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Item não encontrado na fila.');
    if (row.status === 'published') {
      throw new BadRequestException('Item já publicado no WC — não pode ser removido da fila.');
    }
    await (this.prisma as any).sitePublishQueue.delete({ where: { id } });
    return { ok: true };
  }
}
