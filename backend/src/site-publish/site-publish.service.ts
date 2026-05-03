import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { AiEnrichmentService } from './ai-enrichment.service';
import { WcCatalogService } from './wc-catalog.service';

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
    private readonly ai: AiEnrichmentService,
    private readonly wc: WcCatalogService,
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

    // FIX preço: prioriza precoPromo > preco (a prazo) > precoVista. Antes
    // pegava só `preco` que mapeava VENDAUN (à vista, BAIXO). O CEO quer o
    // praticado no PDV (a prazo) — esse veio agora em snapshot.preco via VPRAZO.
    const precoFinal =
      snapshot.precoPromo ??
      snapshot.preco ??
      snapshot.precoVista ??
      null;

    // FIX descrição: se Wincred tem campo OBSERVACAO/DETALHES preenchido, usa
    // como descrição inicial pra UI (não fica em branco esperando IA). Se for
    // criação NOVA, popular wcDescricao. Se for UPDATE, preservar o que já tem
    // (vendedora pode ter editado).
    const descLongaInicial = (snapshot.descLonga || '').trim() || null;

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
        precoSugerido: precoFinal,
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
        precoSugerido: precoFinal,
        estoqueTotal,
        tamanhos: tamanhosPayload,
        // Pré-popula campos de enriquecimento na CRIAÇÃO (só na criação, pra
        // não sobrescrever edição manual em update):
        wcDescricao: descLongaInicial,
        wcPrecoVenda: precoFinal != null ? String(precoFinal) : null,
        wcPrecoPromo: snapshot.precoPromo != null ? String(snapshot.precoPromo) : null,
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
  ): Promise<{
    added: number;
    ids: string[];
    errors: Array<{ refCode: string; cor: string; reason: string }>;
  }> {
    if (!items.length) return { added: 0, ids: [], errors: [] };
    const errors: Array<{ refCode: string; cor: string; reason: string }> = [];
    const ids: string[] = [];
    let added = 0;
    for (const it of items) {
      try {
        const row = await this.addToQueue({ refCode: it.refCode, cor: it.cor, userId });
        if (row?.id) ids.push(row.id);
        added++;
      } catch (e: any) {
        errors.push({ refCode: it.refCode, cor: it.cor, reason: e?.message ?? String(e) });
      }
    }
    return { added, ids, errors };
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

  // ============================================================
  // FASE 2 — ENRIQUECIMENTO
  // ============================================================

  /**
   * Salva edição manual do enriquecimento de UM item.
   * Aceita qualquer subconjunto dos campos — só sobrescreve os que vierem.
   * Se algum campo chave estiver preenchido, promove status de queued pra enriched.
   */
  async saveEnrichment(
    id: string,
    patch: {
      wcTitulo?: string | null;
      wcCategoryIds?: number[] | null;
      wcTags?: string[] | null;
      wcAtributos?: Array<{ nome: string; valor: string }> | null;
      wcDescricao?: string | null;
      wcDescricaoCurta?: string | null;
      wcImagens?: Array<{ id?: number; url: string; alt?: string }> | null;
      wcPesoKg?: number | null;
      wcDimensoesCm?: { comprimento?: number; largura?: number; altura?: number } | null;
      wcPrecoVenda?: number | null;
      wcPrecoPromo?: number | null;
    },
  ) {
    const existing = await this.getQueueItem(id);
    if (existing.status === 'published') {
      throw new BadRequestException('Item já publicado — não pode ser editado.');
    }

    const data: any = {};
    if (patch.wcTitulo !== undefined) data.wcTitulo = patch.wcTitulo;
    if (patch.wcCategoryIds !== undefined) data.wcCategoryIds = patch.wcCategoryIds;
    if (patch.wcTags !== undefined) data.wcTags = patch.wcTags;
    if (patch.wcAtributos !== undefined) data.wcAtributos = patch.wcAtributos;
    if (patch.wcDescricao !== undefined) data.wcDescricao = patch.wcDescricao;
    if (patch.wcDescricaoCurta !== undefined) data.wcDescricaoCurta = patch.wcDescricaoCurta;
    if (patch.wcImagens !== undefined) {
      // Filtra URLs inválidas (caminho local do PC, file://, etc.) — senão
      // acumula lixo que só vai estourar na hora de publicar.
      data.wcImagens = Array.isArray(patch.wcImagens)
        ? patch.wcImagens.filter((i) => i?.url && /^https?:\/\//i.test(String(i.url).trim()))
        : patch.wcImagens;
    }
    if (patch.wcPesoKg !== undefined) data.wcPesoKg = patch.wcPesoKg;
    if (patch.wcDimensoesCm !== undefined) data.wcDimensoesCm = patch.wcDimensoesCm;
    if (patch.wcPrecoVenda !== undefined) data.wcPrecoVenda = patch.wcPrecoVenda;
    if (patch.wcPrecoPromo !== undefined) data.wcPrecoPromo = patch.wcPrecoPromo;

    // Promove status automaticamente: se já tem título + descrição + alguma
    // categoria/imagem, considera "enriched" (pronto pra publicar).
    const hasTitulo = (data.wcTitulo ?? existing.wcTitulo) ?? null;
    const hasDesc = (data.wcDescricao ?? existing.wcDescricao) ?? null;
    const hasCat = (data.wcCategoryIds ?? existing.wcCategoryIds) as any;
    const ready = !!hasTitulo && !!hasDesc && Array.isArray(hasCat) && hasCat.length > 0;
    if (existing.status === 'queued' && ready) {
      data.status = 'enriched';
    }

    return (this.prisma as any).sitePublishQueue.update({
      where: { id },
      data,
    });
  }

  /**
   * Chama Claude pra gerar título, descrição, tags e atributos pra UM item.
   * Salva no banco automaticamente (não pisa em campos já editados manualmente
   * — só preenche o que estiver vazio).
   *
   * Parâmetro force=true sobrescreve mesmo se já houver conteúdo.
   */
  async aiGenerate(id: string, opts: { force?: boolean } = {}): Promise<any> {
    const item = await this.getQueueItem(id);

    const tamanhos = Array.isArray(item.tamanhos)
      ? (item.tamanhos as any[]).map((t) => String(t?.tamanho || '')).filter(Boolean)
      : [];

    // Busca descrição atual do Wincred (pode ter mudado desde o snapshot)
    const snap = await this.erp.getRefColorForQueue(item.refCode, item.cor);
    const descricaoWincred = (snap?.descricao || item.refCode).trim();

    const gen = await this.ai.generateForProduct({
      refCode: item.refCode,
      cor: item.cor,
      descricaoWincred,
      grupo: item.grupo,
      subgrupo: item.subgrupo,
      tamanhos,
    });

    // Monta o patch — só preenche campos vazios (a menos que force).
    const data: any = {
      aiGeneratedAt: new Date(),
      aiModel: this.ai['model'] || 'claude-sonnet-4-6',
    };
    if (opts.force || !item.wcTitulo) data.wcTitulo = gen.titulo;
    if (opts.force || !item.wcDescricao) data.wcDescricao = gen.descricaoLonga;
    if (opts.force || !item.wcDescricaoCurta) data.wcDescricaoCurta = gen.descricaoCurta;
    if (opts.force || !item.wcTags || (Array.isArray(item.wcTags) && (item.wcTags as any[]).length === 0)) {
      data.wcTags = gen.tags;
    }
    if (
      opts.force ||
      !item.wcAtributos ||
      (Array.isArray(item.wcAtributos) && (item.wcAtributos as any[]).length === 0)
    ) {
      data.wcAtributos = gen.atributos;
    }

    const updated = await (this.prisma as any).sitePublishQueue.update({
      where: { id },
      data,
    });
    this.logger.log(`AI gerou pra ${item.refCode}/${item.cor} — ${gen.titulo.slice(0, 60)}`);
    return { item: updated, generated: gen };
  }

  /** Categorias do WC (live). */
  async wcCategories() {
    return this.wc.listCategories();
  }

  /** Tags do WC (live). */
  async wcTags(search?: string) {
    return this.wc.listTags(search);
  }

  /** Status dos serviços de suporte (pra UI mostrar se IA/upload tão habilitados). */
  async integrationStatus(): Promise<{
    aiEnabled: boolean;
    mediaUploadEnabled: boolean;
  }> {
    return {
      aiEnabled: this.ai.isEnabled(),
      mediaUploadEnabled: this.wc.isMediaUploadEnabled(),
    };
  }

  /**
   * Sobe uma imagem pra o WP a partir de URL externa (ex: link efêmero do
   * frontend após o CEO arrastar o arquivo pra tela).
   *
   * O frontend é responsável por converter File → URL (ex: upload em bucket
   * temporário ou data-URL) antes de chamar este endpoint. MVP: aceita URL
   * direta.
   */
  async uploadImage(id: string, params: { sourceUrl: string; alt?: string }) {
    const item = await this.getQueueItem(id);
    const src = String(params.sourceUrl || '').trim();
    if (!/^https?:\/\//i.test(src)) {
      throw new BadRequestException(
        'URL de imagem inválida: só aceito https://… público. Caminho local do PC (C:\\…, file://, /Users/) não funciona — o WP não consegue fetchar da sua máquina.',
      );
    }
    const filename = `${item.refCode}-${item.cor}-${Date.now()}.jpg`
      .replace(/\s+/g, '-')
      .toLowerCase();
    const media = await this.wc.uploadMediaFromUrl(src, filename, params.alt);
    // Anexa na lista existente
    const existing = Array.isArray(item.wcImagens) ? (item.wcImagens as any[]) : [];
    const updated = [...existing, { id: media.id, url: media.source_url, alt: params.alt || '' }];
    await (this.prisma as any).sitePublishQueue.update({
      where: { id },
      data: { wcImagens: updated },
    });
    return { wcImagens: updated };
  }

  // ============================================================
  // FASE 3 — PUBLICAÇÃO NO WOOCOMMERCE
  // ============================================================

  /**
   * Publica UM item como rascunho (draft) no WooCommerce.
   *
   * Valida:
   *  - campos obrigatórios preenchidos
   *  - SKU não existe no WC (evita duplicata — se já existe, aborta e pede
   *    confirmação pra sobrescrever numa chamada com force=true — não
   *    implementado ainda, MVP aborta)
   *  - pelo menos 1 tamanho com estoque
   *
   * Passos:
   *  - marca status=publishing
   *  - chama WcCatalogService.createDraftVariableProduct
   *  - em sucesso: status=published, grava wcProductId + variationIds
   *  - em falha: status=failed, grava errorMessage (para CEO reexecutar)
   *
   * O produto vai como DRAFT — CEO precisa revisar no WC admin e clicar em
   * "Publish". Isso é intencional: evita que produto mal configurado vá ao
   * ar direto.
   */
  async publishToWc(id: string, opts: { force?: boolean } = {}): Promise<any> {
    const item = await this.getQueueItem(id);
    if (item.status === 'published') {
      throw new BadRequestException('Item já publicado.');
    }
    if (item.status === 'publishing') {
      throw new BadRequestException('Item já está sendo publicado (outra execução em andamento).');
    }

    // Valida campos obrigatórios
    const titulo = (item.wcTitulo || '').trim();
    const descricao = (item.wcDescricao || '').trim();
    const descricaoCurta = (item.wcDescricaoCurta || '').trim();
    const categoryIds = Array.isArray(item.wcCategoryIds) ? (item.wcCategoryIds as any[]).map(Number) : [];
    const tags = Array.isArray(item.wcTags) ? (item.wcTags as any[]).map(String) : [];
    const atributos = Array.isArray(item.wcAtributos) ? (item.wcAtributos as any[]) : [];
    const imagensBrutas = Array.isArray(item.wcImagens) ? (item.wcImagens as any[]) : [];
    // Só mantém imagens com URL pública acessível pelo WC. Caminho local do
    // CEO (C:\...) não serve porque WP fica em outro servidor — rejeitar aqui
    // pra não quebrar o createDraftVariableProduct com 400 genérico.
    const imagens = imagensBrutas.filter(
      (i) => i?.url && /^https?:\/\//i.test(String(i.url).trim()),
    );
    const imagensRejeitadas = imagensBrutas.length - imagens.length;
    const tamanhosSnapshot = Array.isArray(item.tamanhos) ? (item.tamanhos as any[]) : [];

    const missing: string[] = [];
    if (!titulo) missing.push('título');
    if (!descricao) missing.push('descrição');
    if (categoryIds.length === 0) missing.push('categoria');
    // Imagem é OPCIONAL — produto vai como draft, CEO pode anexar foto depois
    // no WC admin. Se imagens foram rejeitadas (URL local ou AVIF), loga só.
    if (imagensRejeitadas > 0) {
      this.logger.warn(
        `Publish ${item.refCode}/${item.cor}: ${imagensRejeitadas} imagem(s) ignorada(s) por URL inválida/formato não suportado.`,
      );
    }
    if (tamanhosSnapshot.length === 0) missing.push('tamanhos (snapshot Wincred vazio)');
    if (missing.length) {
      throw new BadRequestException(`Campos obrigatórios faltando: ${missing.join(', ')}.`);
    }

    // Preço: usa wcPrecoVenda se setado, senão precoSugerido
    const precoBase = Number(item.wcPrecoVenda ?? item.precoSugerido ?? 0);
    if (!precoBase || precoBase <= 0) {
      throw new BadRequestException('Preço inválido (wcPrecoVenda ou precoSugerido).');
    }
    const precoPromo = item.wcPrecoPromo ? Number(item.wcPrecoPromo) : undefined;

    // SKU do pai = só refCode (normalizado). Sem concatenar a cor — o SKU
    // do pai é o agrupador do produto variável; a cor aparece como
    // atributo + no título, não no SKU. A variação carrega o código EAN
    // como SKU próprio (bipagem encontra direto).
    const sku = String(item.refCode).replace(/\s+/g, '-').toUpperCase();

    // Checa duplicidade
    if (!opts.force) {
      const existing = await this.wc.findProductIdBySku(sku);
      if (existing) {
        throw new BadRequestException(
          `Já existe produto no WC com SKU ${sku} (id ${existing}). Revise no WC admin ou use force=true pra sobrescrever (não implementado — MVP recusa).`,
        );
      }
    }

    // Marca publishing
    await (this.prisma as any).sitePublishQueue.update({
      where: { id },
      data: { status: 'publishing', errorMessage: null },
    });

    try {
      const result = await this.wc.createDraftVariableProduct({
        sku,
        titulo,
        descricao,
        descricaoCurta,
        categoryIds,
        tags,
        imagens,
        atributos,
        tamanhos: tamanhosSnapshot.map((t: any) => ({
          tamanho: String(t.tamanho || '').trim(),
          codigo: String(t.codigo || '').trim(),
          estoque: Number(t.estoque) || 0,
          preco: precoBase,
          precoPromo,
        })),
        pesoKg: item.wcPesoKg ? Number(item.wcPesoKg) : undefined,
        dimensoesCm: item.wcDimensoesCm ? (item.wcDimensoesCm as any) : undefined,
        cor: item.cor,
      });

      const updated = await (this.prisma as any).sitePublishQueue.update({
        where: { id },
        data: {
          status: 'published',
          wcProductId: result.productId,
          wcVariationIds: result.variationIds,
          publishedAt: new Date(),
          errorMessage: null,
        },
      });

      // Log de auditoria (reutiliza integration_logs)
      await (this.prisma as any).integrationLog
        .create({
          data: {
            direction: 'out',
            type: 'site_publish.publish',
            payload: {
              queueItemId: id,
              refCode: item.refCode,
              cor: item.cor,
              wcProductId: result.productId,
              variationCount: result.variationIds.length,
            },
            httpStatus: 201,
          },
        })
        .catch(() => {}); // nunca deixa log quebrar o fluxo

      this.logger.log(
        `Publish OK: ${item.refCode}/${item.cor} → WC #${result.productId} (${result.variationIds.length} variações)`,
      );
      return updated;
    } catch (e: any) {
      const raw = e?.message || String(e);
      // Enriquece erros comuns pra orientação prática do CEO.
      let msg = raw;
      const hasAvif = imagens.some((i) => /\.(avif|heic|heif)(\?|$)/i.test(String(i?.url || '')));
      if (hasAvif && /permiss[aã]o|tipo de arquivo|file type/i.test(raw)) {
        msg =
          'WordPress rejeitou a imagem .avif/.heic. Solução: abre a imagem no WP Admin → Mídia, copia a URL da versão .jpg (ou sobe a imagem de novo como .jpg/.webp) e substitui aqui.';
      } else if (/permiss[aã]o|tipo de arquivo|file type/i.test(raw)) {
        msg = `WP rejeitou o tipo do arquivo. Use .jpg, .jpeg, .png ou .webp. Erro bruto: ${raw}`;
      }
      await (this.prisma as any).sitePublishQueue.update({
        where: { id },
        data: {
          status: 'failed',
          errorMessage: msg.slice(0, 500),
        },
      });
      this.logger.error(`Publish FAIL ${item.refCode}/${item.cor}: ${raw}`);
      throw new BadRequestException(`Falha ao publicar: ${msg}`);
    }
  }

  /**
   * Re-aplica o código Giga (EAN de etiqueta) em cada variação já criada no
   * WC. Útil pra produtos publicados antes da correção que inclui o
   * global_unique_id no payload de criação.
   *
   * Só roda em itens com status=published e wcProductId/wcVariationIds
   * preenchidos. Usa o snapshot do Wincred (tamanhos) como fonte do código.
   */
  async syncEansOnWc(id: string): Promise<{ updated: number; failed: any[] }> {
    const item = await this.getQueueItem(id);
    if (!item.wcProductId) {
      throw new BadRequestException('Item não publicado no WC (sem wcProductId).');
    }
    const variationIdsMeta = Array.isArray(item.wcVariationIds)
      ? (item.wcVariationIds as any[])
      : [];
    if (!variationIdsMeta.length) {
      throw new BadRequestException('Item sem variações registradas no WC.');
    }
    // Monta {variationId, codigo} cruzando o snapshot dos tamanhos com as
    // variações do WC — match por `tamanho` (case-insensitive).
    const snapshot = Array.isArray(item.tamanhos) ? (item.tamanhos as any[]) : [];
    const payload = variationIdsMeta
      .map((v: any) => {
        const tam = String(v?.tamanho || '').trim().toUpperCase();
        const fromSnapshot = snapshot.find(
          (s: any) => String(s?.tamanho || '').trim().toUpperCase() === tam,
        );
        const codigo = v?.codigo || fromSnapshot?.codigo || '';
        return { variationId: Number(v?.variationId), codigo: String(codigo).trim() };
      })
      .filter((p) => p.variationId && p.codigo);

    if (!payload.length) {
      throw new BadRequestException(
        'Não foi possível mapear códigos EAN — snapshot ou variationIds incompletos.',
      );
    }
    const res = await this.wc.syncVariationCodes(Number(item.wcProductId), payload);
    this.logger.log(
      `Sync EAN ${item.refCode}/${item.cor} → WC #${item.wcProductId}: ${res.updated}/${payload.length} atualizadas.`,
    );
    return res;
  }

  /**
   * Publica vários itens em sequência. Rodar em paralelo dá rate-limit no
   * WC (media upload + create product) e WP costuma morrer. Sequencial é
   * mais lento mas não quebra.
   *
   * Retorna resumo: quantos OK, quantos falharam (e por quê).
   */
  async publishBatch(
    ids: string[],
    opts: { force?: boolean } = {},
  ): Promise<{
    total: number;
    published: number;
    failed: Array<{ id: string; refCode?: string; cor?: string; reason: string }>;
  }> {
    const failed: Array<{ id: string; refCode?: string; cor?: string; reason: string }> = [];
    let published = 0;
    for (const id of ids) {
      try {
        await this.publishToWc(id, opts);
        published++;
      } catch (e: any) {
        // Lê o item pra incluir refCode/cor no retorno (ajuda o CEO a ver qual falhou).
        let refCode: string | undefined;
        let cor: string | undefined;
        try {
          const it = await (this.prisma as any).sitePublishQueue.findUnique({ where: { id } });
          refCode = it?.refCode;
          cor = it?.cor;
        } catch {}
        failed.push({ id, refCode, cor, reason: String(e?.message || e).slice(0, 300) });
      }
    }
    return { total: ids.length, published, failed };
  }

  /**
   * Edição em bloco — aplica o MESMO patch em vários itens.
   *
   * Uso típico: CEO tem 8 cores da mesma REF na fila. Monta 1 vez título
   * base, descrição, categorias, tags, atributos — salva em todas. Depois
   * ajusta particularidades de cada cor (título com "Preto", "Azul", etc.)
   * abrindo o modal individual de cada uma se quiser.
   *
   * Campos suportados (todos opcionais — só aplica o que estiver no patch):
   *   wcTitulo, wcDescricao, wcDescricaoCurta, wcCategoryIds, wcTags,
   *   wcAtributos, wcPesoKg, wcDimensoesCm, wcPrecoVenda, wcPrecoPromo.
   *
   * NÃO aplica em itens já publicados (status=published) — evita mexer em
   * produto vivo por engano.
   */
  async bulkPatchQueue(
    ids: string[],
    patch: any,
  ): Promise<{
    total: number;
    updated: number;
    skipped: Array<{ id: string; reason: string }>;
  }> {
    const skipped: Array<{ id: string; reason: string }> = [];
    let updated = 0;
    for (const id of ids) {
      try {
        const item = await (this.prisma as any).sitePublishQueue.findUnique({ where: { id } });
        if (!item) {
          skipped.push({ id, reason: 'não encontrado' });
          continue;
        }
        if (item.status === 'published') {
          skipped.push({ id, reason: 'já publicado' });
          continue;
        }
        await this.saveEnrichment(id, patch);
        updated++;
      } catch (e: any) {
        skipped.push({ id, reason: String(e?.message || e).slice(0, 200) });
      }
    }
    return { total: ids.length, updated, skipped };
  }

  /**
   * Dispara IA pra vários itens em sequência. Útil quando o CEO enfileira
   * 10 cores e quer gerar tudo de uma vez.
   *
   * Sequencial pra não estourar rate-limit do Claude (batch lá = 5 rps).
   * Retorna resumo com sucesso/falha por item.
   */
  async aiGenerateBatch(
    ids: string[],
    opts: { force?: boolean } = {},
  ): Promise<{
    total: number;
    generated: number;
    failed: Array<{ id: string; refCode?: string; cor?: string; reason: string }>;
  }> {
    const failed: Array<{ id: string; refCode?: string; cor?: string; reason: string }> = [];
    let generated = 0;
    for (const id of ids) {
      try {
        await this.aiGenerate(id, opts);
        generated++;
      } catch (e: any) {
        let refCode: string | undefined;
        let cor: string | undefined;
        try {
          const it = await (this.prisma as any).sitePublishQueue.findUnique({ where: { id } });
          refCode = it?.refCode;
          cor = it?.cor;
        } catch {}
        failed.push({ id, refCode, cor, reason: String(e?.message || e).slice(0, 300) });
      }
    }
    return { total: ids.length, generated, failed };
  }
}
