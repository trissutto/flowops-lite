import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CLASSIFICAÇÃO EM LOTE — pôr 773 peças na árvore do site sem enlouquecer.
 *
 * ── O QUE MOTIVOU ──
 *
 * Medição de 10/08/2026 sobre as 797 peças publicadas:
 *   · 773 (96%) sem classificação fina
 *   · 345 (43%) sem categoria NENHUMA — publicadas e fora de todo menu,
 *     achaveis só pela busca. Quase metade da loja invisível pra quem navega.
 *
 * O dono decidiu que a vitrine tem árvore PRÓPRIA — Blusas → Manga curta —
 * e que ele classifica à mão ("esquece Giga"). Uma a uma seriam 773 telas; o trabalho não aconteceria.
 * Aqui a unidade é o LOTE: filtra, marca várias, aplica de uma vez.
 *
 * ── POR QUE O FILTRO IMPORTA MAIS QUE A TELA ──
 *
 * Sem filtro, "classificar 773 peças" é uma lista infinita e desanimadora.
 * Com filtro por nome, vira: buscar "VESTIDO" → marcar todas → VESTIDO LONGO.
 * Dezenas por vez, em minutos. O filtro é o recurso, não enfeite — e o
 * primeiro que o dono pediu foi PUBLICADOS, porque peça não publicada não
 * urge: ela não está na loja.
 */
@Injectable()
export class ClassificacaoService {
  private readonly logger = new Logger(ClassificacaoService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A ÁRVORE DO SITE, pronta pros dois seletores da tela.
   *
   * Categoria (`paiSlug` nulo) e subcategoria (com pai). É a taxonomia da
   * VITRINE — "Blusas" → "Manga curta" —, não o grupo/subgrupo fiscal do Giga
   * ("BLUSA FEMININA"), que o dono mandou esquecer em 10/08/2026.
   */
  async arvore() {
    const linhas: any[] = await (this.prisma as any).siteCategoria.findMany({
      select: { slug: true, nome: true, paiSlug: true, ordem: true, ativo: true },
      orderBy: [{ ordem: 'asc' }, { slug: 'asc' }],
    });
    const bonito = (c: any) => c.nome || this.doSlug(c.slug);
    return {
      categorias: linhas
        .filter((c) => !c.paiSlug)
        .map((c) => ({ slug: c.slug, nome: bonito(c), ativo: c.ativo })),
      subcategorias: linhas
        .filter((c) => c.paiSlug)
        .map((c) => ({ slug: c.slug, nome: bonito(c), pai: c.paiSlug, ativo: c.ativo })),
    };
  }

  /** "manga-curta" → "Manga curta". Categoria sem nome cadastrado não fica feia. */
  private doSlug(slug: string): string {
    const s = String(slug || '').replace(/[-_]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  /**
   * Cria uma subcategoria dentro de uma categoria — "Manga curta" em "Blusas".
   *
   * Nasce ATIVA e no fim da ordem: quem está classificando quer usá-la já, e
   * arrumar a ordem é decisão de vitrine, feita depois na tela de categorias.
   */
  async criarSubcategoria(input: { pai: string; nome: string; quem: string }) {
    const pai = String(input.pai || '').trim().toLowerCase();
    const nome = String(input.nome || '').trim();
    if (!pai || !nome) return { ok: false, erro: 'Categoria e nome são obrigatórios' };
    const slug = this.slugify(nome);
    if (!slug) return { ok: false, erro: 'Nome inválido' };

    const ultima = await (this.prisma as any).siteCategoria.findFirst({
      where: { paiSlug: pai },
      orderBy: { ordem: 'desc' },
      select: { ordem: true },
    });

    await (this.prisma as any).siteCategoria.upsert({
      where: { slug },
      update: { paiSlug: pai, nome, atualizadoPor: input.quem },
      create: {
        slug, nome, paiSlug: pai, ativo: true,
        ordem: (ultima?.ordem ?? 0) + 1,
        atualizadoPor: input.quem,
      },
    });
    return { ok: true, slug, nome, pai };
  }

  private slugify(texto: string): string {
    return String(texto || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      .slice(0, 40);
  }

  /**
   * As peças pra classificar, com os filtros da tela.
   *
   * `publicado` é o primeiro filtro de propósito (pedido do dono): peça fora
   * do ar não está custando venda, então não disputa a fila.
   */
  async listar(params: {
    publicado?: boolean;
    semSubcategoria?: boolean;
    semCategoria?: boolean;
    busca?: string;
    categoria?: string;
    subcategoria?: string;
    page?: number;
    perPage?: number;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const perPage = Math.min(200, Math.max(10, Number(params.perPage) || 50));

    const where: any = {};
    if (params.publicado !== undefined) where.publicado = params.publicado;
    if (params.semSubcategoria) where.subcategoria = null;
    if (params.semCategoria) where.categoria = null;
    if (params.categoria) where.categoria = params.categoria;
    if (params.subcategoria) where.subcategoria = params.subcategoria;
    if (params.busca && params.busca.trim().length >= 2) {
      const t = params.busca.trim();
      // REF e nome na mesma busca: quem classifica pensa pelos dois.
      where.OR = [
        { nome: { contains: t, mode: 'insensitive' } },
        { ref: { contains: t.toUpperCase() } },
      ];
    }

    const [total, itens] = await Promise.all([
      (this.prisma as any).siteProduto.count({ where }),
      (this.prisma as any).siteProduto.findMany({
        where,
        select: {
          ref: true, nome: true, categoria: true, subcategoria: true,
          publicado: true, imagens: true,
        },
        orderBy: { nome: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);

    return {
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      itens: (itens as any[]).map((p) => ({
        ref: p.ref,
        nome: p.nome,
        categoria: p.categoria,
        subcategoria: p.subcategoria,
        publicado: p.publicado,
        // Só a capa: a tela mostra miniatura pra reconhecer a peça de relance,
        // e mandar a galeria inteira de 200 peças pesaria a resposta à toa.
        capa: this.primeiraImagem(p.imagens),
      })),
    };
  }

  /** Classifica VÁRIAS de uma vez — a operação que faz a tela valer a pena. */
  async classificar(input: {
    refs: string[];
    categoria: string | null;
    subcategoria: string | null;
    quem: string;
  }) {
    const refs = (input.refs || []).map((r) => String(r).trim().toUpperCase()).filter(Boolean);
    if (!refs.length) return { ok: false, erro: 'Nenhuma peça selecionada' };

    const r = await (this.prisma as any).siteProduto.updateMany({
      where: { ref: { in: refs } },
      data: {
        categoria: input.categoria,
        subcategoria: input.subcategoria,
        classificadoPor: input.quem,
        classificadoEm: new Date(),
      },
    });
    this.logger.log(`[classificacao] ${r.count} peça(s) → ${input.categoria}/${input.subcategoria ?? '-'} por ${input.quem}`);
    return { ok: true, atualizadas: r.count };
  }

  /** Quanto falta — o número que diz se o mutirão está andando. */
  async progresso() {
    const [publicadas, semCategoria, semSubcategoria] = await Promise.all([
      (this.prisma as any).siteProduto.count({ where: { publicado: true } }),
      (this.prisma as any).siteProduto.count({ where: { publicado: true, categoria: null } }),
      (this.prisma as any).siteProduto.count({ where: { publicado: true, subcategoria: null } }),
    ]);
    return {
      publicadas,
      semCategoria,
      semSubcategoria,
      comCategoria: publicadas - semCategoria,
    };
  }

  private primeiraImagem(imagens: any): string | null {
    try {
      const arr = typeof imagens === 'string' ? JSON.parse(imagens) : imagens;
      if (!Array.isArray(arr) || !arr.length) return null;
      return String(arr[0]?.src || '') || null;
    } catch {
      return null;
    }
  }
}
