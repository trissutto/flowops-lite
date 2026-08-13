import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { avisarVitrine } from '../common/avisar-vitrine';
import { LojaCatalogService } from './loja-catalog.service';

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
export interface FiltroClassificacao {
  publicado?: boolean;
  semSubcategoria?: boolean;
  semCategoria?: boolean;
  /** Palavras que a peça PRECISA ter no nome ou na REF. */
  busca?: string;
  /** Palavras que DESCLASSIFICAM a peça — ver `refsPorTexto`. */
  excluir?: string;
  categoria?: string;
  subcategoria?: string;
}

/** Sentinela de "a busca não casou com nada" — ver `montarWhere`. */
const VAZIO = Symbol('sem resultado');

@Injectable()
export class ClassificacaoService {
  private readonly logger = new Logger(ClassificacaoService.name);

  /** Teto do "marcar todas do filtro" e da varredura por texto. */
  private static readonly TETO_SELECAO = 2000;
  /** Pares do `translate()` do Postgres — a busca ignora acento. */
  private static readonly COM_ACENTO = 'áàâãäéèêëíìîïóòôõöúùûüçñ';
  private static readonly SEM_ACENTO = 'aaaaaeeeeiiiiooooouuuucn';

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogo: LojaCatalogService,
  ) {}

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

  /**
   * Cria uma CATEGORIA nova (nível de cima) — "Linha Conforto" pra campanha.
   *
   * Nasce ATIVA e no fim da ordem, igual à subcategoria. Aparecer no menu do
   * site continua dependendo de ter peça publicada dentro — categoria vazia
   * não vira vitrine, e é assim que o resto do sistema já pensa.
   */
  async criarCategoria(input: { nome: string; quem: string }) {
    const nome = String(input.nome || '').trim();
    if (!nome) return { ok: false, erro: 'Nome é obrigatório' };
    const slug = this.slugify(nome);
    if (!slug) return { ok: false, erro: 'Nome inválido' };

    // Se o slug já vive como SUBcategoria, virar categoria aqui deixaria a
    // árvore com o mesmo nó nos dois níveis — melhor recusar com explicação.
    const existente = await (this.prisma as any).siteCategoria.findUnique({
      where: { slug },
      select: { paiSlug: true },
    });
    if (existente?.paiSlug) {
      return { ok: false, erro: `"${nome}" já existe como subcategoria de "${existente.paiSlug}"` };
    }

    const ultima = await (this.prisma as any).siteCategoria.findFirst({
      where: { paiSlug: null },
      orderBy: { ordem: 'desc' },
      select: { ordem: true },
    });

    await (this.prisma as any).siteCategoria.upsert({
      where: { slug },
      update: { nome, atualizadoPor: input.quem },
      create: {
        slug, nome, paiSlug: null, ativo: true,
        ordem: (ultima?.ordem ?? 0) + 1,
        atualizadoPor: input.quem,
      },
    });
    return { ok: true, slug, nome };
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
  async listar(params: FiltroClassificacao & { page?: number; perPage?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const perPage = Math.min(200, Math.max(10, Number(params.perPage) || 50));

    const where = await this.montarWhere(params);
    if (where === VAZIO) {
      return { total: 0, page, perPage, totalPages: 0, itens: [] };
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

  /**
   * TODAS as REFs do filtro — o "marcar as 138 do filtro" da tela.
   *
   * A página mostra 60 e o filtro tem 138: sem isto, marcar tudo seria marcar,
   * aplicar, virar a página e repetir — três vezes o trabalho, e com o risco
   * de perder a conta de onde parou. Como a listagem é ordenada por nome e a
   * classificação MUDA o filtro (a peça sai de "sem categoria"), paginar à mão
   * durante o mutirão é justamente onde peça passa batida.
   *
   * `TETO` existe pra "marcar todas" nunca virar um clique que classifica o
   * catálogo inteiro por engano. Batendo no teto a tela avisa em vez de fingir
   * que marcou tudo.
   */
  async refs(params: FiltroClassificacao) {
    const where = await this.montarWhere(params);
    if (where === VAZIO) return { refs: [], total: 0, limitado: false };

    const total = await (this.prisma as any).siteProduto.count({ where });
    const linhas = await (this.prisma as any).siteProduto.findMany({
      where,
      select: { ref: true },
      orderBy: { nome: 'asc' },
      take: ClassificacaoService.TETO_SELECAO,
    });
    return {
      refs: (linhas as any[]).map((l) => l.ref),
      total,
      limitado: total > ClassificacaoService.TETO_SELECAO,
    };
  }

  /** Classifica VÁRIAS de uma vez — a operação que faz a tela valer a pena. */
  async classificar(input: {
    refs: string[];
    categoria: string | null;
    subcategoria: string | null;
    /** Só mexe na subcategoria — a categoria de cada peça fica como está. */
    manterCategoria?: boolean;
    quem: string;
  }) {
    const refs = (input.refs || []).map((r) => String(r).trim().toUpperCase()).filter(Boolean);
    if (!refs.length) return { ok: false, erro: 'Nenhuma peça selecionada' };

    /**
     * `manterCategoria` NÃO é preciosismo: a mesma busca ("manga curta") traz
     * blusa, vestido e macacão. Quem quer só carimbar a manga precisa poder
     * fazer isso sem que a categoria de cada peça vire a do lote — senão um
     * clique manda vestido pra Blusas, e o estrago só aparece na vitrine.
     */
    const data: any = {
      subcategoria: input.subcategoria,
      classificadoPor: input.quem,
      classificadoEm: new Date(),
    };
    if (!input.manterCategoria) data.categoria = input.categoria;

    const r = await (this.prisma as any).siteProduto.updateMany({
      where: { ref: { in: refs } },
      data,
    });
    const destino = input.manterCategoria ? '(categoria mantida)' : input.categoria;
    this.logger.log(`[classificacao] ${r.count} peça(s) → ${destino}/${input.subcategoria ?? '-'} por ${input.quem}`);

    /**
     * Sem isto o mutirão parece quebrado: a peça muda no banco, o site continua
     * servindo a página de até 1 hora atrás, e quem classificou conclui que a
     * ferramenta não funcionou — foi exatamente o que aconteceu com os chips de
     * subcategoria de Moda praia em 10/08/2026, com o dado JÁ correto na API.
     *
     * `categorias`/`filtros` derrubam o menu e a lista de subcategorias;
     * `catalogo` e `categoria:<slug>`, a grade da página da categoria.
     */
    const tags = ['categorias', 'filtros', 'catalogo'];
    if (input.categoria) tags.push(`categoria:${input.categoria}`);
    avisarVitrine(tags, this.logger, 'classificacao');
    // Derrubar o cache do site não adianta se o backend responder do dele: a
    // página revalidaria e receberia a MESMA classificação velha.
    this.catalogo.invalidarCache();

    return { ok: true, atualizadas: r.count };
  }

  /**
   * O `where` do Prisma a partir dos filtros da tela.
   *
   * Devolve `VAZIO` quando a busca não casou com nada — assim quem chama
   * responde lista vazia em vez de rodar um `IN ()` que o Prisma recusa.
   */
  private async montarWhere(params: FiltroClassificacao): Promise<any> {
    const where: any = {};
    if (params.publicado !== undefined) where.publicado = params.publicado;
    if (params.semSubcategoria) where.subcategoria = null;
    if (params.semCategoria) where.categoria = null;
    if (params.categoria) where.categoria = params.categoria;
    if (params.subcategoria) where.subcategoria = params.subcategoria;

    const porTexto = await this.refsPorTexto(params.busca, params.excluir);
    if (porTexto) {
      if (!porTexto.length) return VAZIO;
      where.ref = { in: porTexto };
    }
    return where;
  }

  /**
   * BUSCA POR TEXTO — sem acento, por palavra, e com termos NEGATIVOS.
   *
   * ── por que não dava pra usar o `contains` do Prisma ──
   *
   * 1. ACENTO. O `contains ... insensitive` do Prisma vira `ILIKE`, que ignora
   *    caixa mas NÃO ignora acento. Quem digita "saida" não achava "Saída de
   *    Praia" e concluía que a peça não existe (ela existe: são 3, publicadas).
   *    Idem "maio" x "Maiô". `translate()` é função nativa do Postgres — não
   *    depende da extensão `unaccent`, que pode não estar instalada.
   *
   * 2. ORDEM DAS PALAVRAS. `contains` compara a frase inteira: "curta manga"
   *    não achava "Manga Curta". Aqui cada palavra é uma condição.
   *
   * 3. TERMO NEGATIVO. "Manga 3/4" existe em blusa, vestido E macacão; e
   *    "Conjunto Blusa Manga Curta + Calça" não é blusa (decisão do dono,
   *    10/08/2026). Sem poder EXCLUIR palavra, todo filtro de manga viria
   *    contaminado e a seleção em bloco perderia a graça.
   *
   * A varredura é sequencial, mas a tabela é o catálogo do site (~3 mil
   * linhas) e a tela é de retaguarda, usada por uma pessoa por vez.
   */
  private async refsPorTexto(busca?: string, excluir?: string): Promise<string[] | null> {
    const positivos = this.termos(busca);
    const negativos = this.termos(excluir);
    if (!positivos.length && !negativos.length) return null;

    // Constantes minhas, não entrada do usuário — os TERMOS vão parametrizados.
    const alvo = `translate(lower(nome || ' ' || ref), '${ClassificacaoService.COM_ACENTO}', '${ClassificacaoService.SEM_ACENTO}')`;
    const cond: string[] = [];
    const valores: string[] = [];
    for (const t of positivos) {
      valores.push(`%${t}%`);
      cond.push(`${alvo} LIKE $${valores.length}`);
    }
    for (const t of negativos) {
      valores.push(`%${t}%`);
      cond.push(`${alvo} NOT LIKE $${valores.length}`);
    }

    const linhas: Array<{ ref: string }> = await (this.prisma as any).$queryRawUnsafe(
      `SELECT ref FROM site_produto WHERE ${cond.join(' AND ')} LIMIT ${ClassificacaoService.TETO_SELECAO}`,
      ...valores,
    );
    return linhas.map((l) => l.ref);
  }

  /**
   * "Manga Curta, conjunto" → ["manga", "curta", "conjunto"].
   *
   * `%` e `_` são curinga do LIKE: escapados, senão quem digitasse "50%" viria
   * com o catálogo inteiro sem entender por quê.
   */
  private termos(v?: string): string[] {
    return this.semAcento(v || '')
      .split(/[,;\s]+/)
      .map((t) => t.trim().replace(/([%_\\])/g, '\\$1'))
      .filter((t) => t.length >= 2);
  }

  private semAcento(v: string): string {
    return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
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
