import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * IMPORTADOR DE CONTEÚDO (sprint 008) — WooCommerce → `site_produto`.
 *
 * NÃO é um espelho permanente. Decisão do dono (30/07): o cadastro comercial
 * passa a viver no Flow. Este serviço existe pra duas coisas:
 *
 *   1. TRAZER de uma vez o que já foi escrito no site antigo (descrição,
 *      SEO, fotos) — ninguém vai redigitar 3 mil produtos.
 *   2. Continuar atualizando SÓ o que ainda não foi assumido, enquanto o
 *      site antigo estiver no ar.
 *
 * TOMADA DE POSSE: no instante em que alguém edita a peça no Flow ela vira
 * `origemConteudo='flow'` e o importador **pula pra sempre**. É o que
 * permite migrar produto a produto sem data de corte e sem big-bang.
 *
 * O que NUNCA vem daqui: preço, estoque, grade, EAN, NCM — isso é ERP, lido
 * na hora da consulta. Se viesse pra cá, o site mentiria depois de uma venda.
 *
 * Casamento ERP ↔ WC: **SKU do WC = REF do ERP**. Produto sem SKU ou com SKU
 * que não existe no ERP é IGNORADO e registrado no log — nunca inventamos
 * vínculo.
 */
@Injectable()
export class SiteSyncService {
  private readonly logger = new Logger(SiteSyncService.name);
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get baseUrl() {
    return `${(this.config.get<string>('WC_URL') ?? '').replace(/\/$/, '')}/wp-json/wc/v3`;
  }

  private get auth() {
    return {
      username: this.config.get<string>('WC_CONSUMER_KEY') ?? '',
      password: this.config.get<string>('WC_CONSUMER_SECRET') ?? '',
    };
  }

  /** REF normalizada — a mesma regra do resto do sistema (upper, sem espaço). */
  private normRef(v?: string | null): string {
    return String(v || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  private slugify(texto: string, ref: string): string {
    const base = String(texto || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      .slice(0, 120);
    return base ? `${base}-${ref.toLowerCase()}` : `ref-${ref.toLowerCase()}`;
  }

  private stripHtml(html?: string | null): string {
    return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Roda de madrugada: conteúdo muda devagar e o WP compartilha servidor com
   * o Giga — puxar catálogo inteiro no horário de loja é pedir lentidão.
   */
  @Cron('0 35 4 * * *')
  async cronDiario() {
    if (process.env.SITE_SYNC_ENABLED === '0') return;
    await this.sincronizarConteudo('cron');
  }

  async sincronizarConteudo(disparadoPor = 'manual') {
    if (this.rodando) return { ok: false, motivo: 'sync já em andamento' };
    this.rodando = true;
    const inicio = Date.now();

    let lidos = 0, criados = 0, atualizados = 0, ignorados = 0, falhas = 0;
    const semSku: string[] = [];
    const semErp: string[] = [];
    const refsDuplicadas: string[] = [];
    const assumidas: string[] = [];
    const vistos = new Set<string>();

    try {
      // REFs que existem no ERP — o site só publica o que a empresa tem.
      const refsErp = new Set<string>(
        (await this.prisma.$queryRawUnsafe<Array<{ ref: string }>>(
          `SELECT DISTINCT UPPER(TRIM(ref)) AS ref FROM wincred_produtos WHERE ref IS NOT NULL AND TRIM(ref) <> ''`,
        )).map((r) => r.ref),
      );

      for (let page = 1; page <= 60; page++) {
        const res = await firstValueFrom(
          this.http.get(`${this.baseUrl}/products`, {
            auth: this.auth,
            params: { per_page: 100, page, status: 'publish', orderby: 'id', order: 'asc' },
          }),
        );
        const lista: any[] = res.data ?? [];
        if (!lista.length) break;
        lidos += lista.length;

        for (const p of lista) {
          try {
            const ref = this.normRef(p.sku);
            if (!ref) { ignorados++; if (semSku.length < 40) semSku.push(`#${p.id} ${p.name}`); continue; }
            if (!refsErp.has(ref)) { ignorados++; if (semErp.length < 40) semErp.push(`${ref} (#${p.id})`); continue; }
            if (vistos.has(ref)) { ignorados++; if (refsDuplicadas.length < 40) refsDuplicadas.push(`${ref} (#${p.id})`); continue; }
            vistos.add(ref);

            const imagens = (p.images ?? []).map((img: any) => ({
              src: img.src, alt: img.alt || p.name, tipo: 'imagem' as const,
            }));

            const dados = {
              slug: p.slug ? String(p.slug).slice(0, 160) : this.slugify(p.name, ref),
              nome: String(p.name || ref).slice(0, 160),
              descricaoCurta: this.stripHtml(p.short_description).slice(0, 2000) || null,
              descricaoCompleta: this.stripHtml(p.description).slice(0, 20000) || null,
              imagens: imagens.length ? imagens : undefined,
              seo: {
                metaTitle: p.yoast_head_json?.title ?? p.name ?? null,
                metaDescription:
                  p.yoast_head_json?.description ??
                  (this.stripHtml(p.short_description).slice(0, 160) || null),
                canonical: p.yoast_head_json?.canonical ?? p.permalink ?? null,
                ogImage: p.yoast_head_json?.og_image?.[0]?.url ?? imagens[0]?.src ?? null,
              },
              destaque: !!p.featured,
              // "promoção" é do WC só como sinalização editorial; o preço com
              // desconto quem manda é o ERP (ver LojaCatalogService).
              promocao: !!p.on_sale,
              lancamento: (p.tags ?? []).some((t: any) => /lanc|novidade|new/i.test(t.name || '')),
              wcId: Number(p.id) || null,
              wcSlug: p.slug ? String(p.slug).slice(0, 160) : null,
              origemConteudo: 'woocommerce',
              syncedAt: new Date(),
            };

            const existente = await (this.prisma as any).siteProduto.findUnique({ where: { ref } });
            if (existente?.origemConteudo === 'flow') {
              // Peça já assumida pelo Flow: o site antigo não manda mais nela.
              ignorados++;
              if (assumidas.length < 40) assumidas.push(ref);
              continue;
            }
            if (existente) {
              await (this.prisma as any).siteProduto.update({ where: { ref }, data: dados });
              atualizados++;
            } else {
              await (this.prisma as any).siteProduto.create({ data: { ref, publicado: true, ...dados } });
              criados++;
            }
          } catch (e) {
            falhas++;
            this.logger.warn(`[site-sync] falhou no produto #${p?.id}: ${(e as Error).message}`);
          }
        }

        const totalPaginas = Number(res.headers['x-wp-totalpages'] ?? 1);
        if (page >= totalPaginas) break;
      }

      const duracaoMs = Date.now() - inicio;
      const detalhes = {
        semSku: { qtd: semSku.length, exemplos: semSku },
        semCorrespondenciaNoErp: { qtd: semErp.length, exemplos: semErp },
        refsDuplicadasNoWc: { qtd: refsDuplicadas.length, exemplos: refsDuplicadas },
        jaAssumidasPeloFlow: { qtd: assumidas.length, exemplos: assumidas },
      };
      await (this.prisma as any).siteSyncLog.create({
        data: { tipo: 'conteudo', duracaoMs, lidos, criados, atualizados, ignorados, falhas, detalhes, disparadoPor },
      });
      this.logger.log(
        `[site-sync] ${lidos} lidos · ${criados} novos · ${atualizados} atualizados · ${ignorados} ignorados · ${falhas} falhas (${duracaoMs}ms)`,
      );
      return { ok: true, lidos, criados, atualizados, ignorados, falhas, duracaoMs, detalhes };
    } catch (e) {
      await (this.prisma as any).siteSyncLog.create({
        data: {
          tipo: 'conteudo', duracaoMs: Date.now() - inicio, lidos, criados, atualizados, ignorados,
          falhas: falhas + 1, erro: (e as Error).message, disparadoPor,
        },
      }).catch(() => {});
      this.logger.error(`[site-sync] abortado: ${(e as Error).message}`);
      return { ok: false, erro: (e as Error).message };
    } finally {
      this.rodando = false;
    }
  }

  /** Últimas rodadas — a tela de admin lê daqui. */
  historico(limite = 20) {
    return (this.prisma as any).siteSyncLog.findMany({
      orderBy: { iniciadoEm: 'desc' },
      take: Math.min(100, limite),
    });
  }
}
