import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LojaCatalogService } from '../loja-catalog/loja-catalog.service';
import { avisarVitrine } from '../common/avisar-vitrine';

/**
 * OS BLOCOS DA HOME — a ordem do site, editável sem deploy.
 *
 * A home tem duas listas, e as duas eram array chumbado no código:
 *   · ATALHOS   — a fileira de cards com foto abaixo do banner
 *                 (`ecommerce/src/data/home.ts`)
 *   · CARROSSÉIS— as vitrines de produto (`app/(public)/page.tsx`)
 *
 * Subir "Moda praia" no verão era tarefa de programador, e o dono só descobria
 * a ordem errada com a campanha no ar.
 *
 * ── AS TRÊS REDES CONTRA HOME VAZIA ──
 *
 * A home é a página mais visitada; ela não pode depender de alguém ter
 * cadastrado alguma coisa. Então:
 *   1. `semear()` — tabela nunca tocada nasce com EXATAMENTE o que está no ar
 *      hoje. Quem não abrir a tela não vê diferença nenhuma depois do deploy.
 *   2. Bloco sem peça publicada não sai no público (mesma regra da categoria
 *      vazia — carrossel vazio é pior que seção a menos).
 *   3. Falhou o backend? O site tem a mesma lista como padrão no código.
 *      Ver `ecommerce/src/services/vitrines-home.ts`.
 */

/** Tipos de vitrine. Ver o comentário do model `SiteHomeVitrine`. */
export const TIPOS = ['novidades', 'destaques', 'promocao', 'categoria', 'colecao'] as const;
export type TipoVitrine = (typeof TIPOS)[number];

export const BLOCOS = ['carrossel', 'atalho'] as const;
export type BlocoHome = (typeof BLOCOS)[number];

/** Só `categoria` e `colecao` apontam pra alguma coisa; o resto é do catálogo inteiro. */
const PRECISA_CHAVE: TipoVitrine[] = ['categoria', 'colecao'];

/**
 * O slug é canônico e vem sem acento do CRM ('calcas'); o nome que a cliente
 * lê, não. Mesmo mapa do site (`services/categorias-menu.ts`) — divergir aqui
 * faria a home escrever "Calcas" enquanto o menu escreve "Calças".
 */
const ROTULOS: Record<string, string> = {
  calcas: 'Calças',
  macacoes: 'Macacões',
  'moda-praia': 'Moda praia',
};

export interface VitrineInput {
  bloco?: string;
  tipo?: string;
  chave?: string | null;
  titulo?: string | null;
  tituloMobile?: string | null;
  eyebrow?: string | null;
  descricao?: string | null;
  ctaLabel?: string | null;
  limite?: number;
  ordem?: number;
  ativo?: boolean;
}

/**
 * O PADRÃO DE FÁBRICA — o que estava NO AR em 17/08/2026, com os mesmos
 * textos e na mesma ordem. Semeado uma única vez, pra que ligar esta tela não
 * mude a home de ninguém.
 */
const SEMENTE: Array<VitrineInput & { bloco: BlocoHome; tipo: TipoVitrine; chave: string; ordem: number }> = [
  // A fileira de cards com foto, abaixo do banner (`data/home.ts`).
  { bloco: 'atalho', tipo: 'categoria', chave: 'vestidos', titulo: 'Vestidos', ordem: 1 },
  { bloco: 'atalho', tipo: 'categoria', chave: 'blusas', titulo: 'Blusas', ordem: 2 },
  { bloco: 'atalho', tipo: 'categoria', chave: 'conjuntos', titulo: 'Conjuntos', ordem: 3 },
  { bloco: 'atalho', tipo: 'categoria', chave: 'calcas', titulo: 'Calças', ordem: 4 },
  { bloco: 'atalho', tipo: 'categoria', chave: 'macacoes', titulo: 'Macacões', ordem: 5 },
  { bloco: 'atalho', tipo: 'categoria', chave: 'lingerie', titulo: 'Lingerie', ordem: 6 },
  { bloco: 'atalho', tipo: 'categoria', chave: 'moda-praia', titulo: 'Moda praia', ordem: 7 },
  { bloco: 'atalho', tipo: 'promocao', chave: '', titulo: 'Outlet', ordem: 8 },

  // Os dois carrosséis da home nova, nesta ordem. As quatro vitrines por
  // categoria saíram em 15/08 ("evita atrasar o hero com quatro vitrines
  // repetidas") — voltam pelo botão "Adicionar vitrine", não por padrão.
  {
    bloco: 'carrossel', tipo: 'colecao', chave: 'mais-top-da-semana',
    eyebrow: 'Escolhas da semana', titulo: 'Mais Top da semana',
    ctaLabel: 'Ver seleção', limite: 12, ordem: 1,
  },
  {
    bloco: 'carrossel', tipo: 'novidades', chave: '',
    eyebrow: 'Acabou de chegar', titulo: 'Novidades da semana', tituloMobile: 'Novidades',
    ctaLabel: 'Ver todas', limite: 12, ordem: 2,
  },
];

@Injectable()
export class SiteVitrinesService {
  private readonly logger = new Logger(SiteVitrinesService.name);
  /** A semeadura roda uma vez por processo — não a cada carregamento da home. */
  private semeado = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogo: LojaCatalogService,
  ) {}

  private texto(v: unknown): string | null {
    const s = String(v ?? '').trim();
    return s || null;
  }

  private normSlug(v: unknown): string {
    return String(v ?? '').trim().toLowerCase();
  }

  private nomeDoSlug(slug: string): string {
    if (ROTULOS[slug]) return ROTULOS[slug];
    const s = slug.replace(/[-_]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug;
  }

  private avisarSite() {
    avisarVitrine(['vitrines-home', 'catalogo', 'vitrine'], this.logger, 'vitrines-home');
  }

  /**
   * A tabela vazia recebe o que já está no ar. Só quando NUNCA foi tocada: se
   * o dono apagar tudo de propósito, a home fica sem os blocos — foi escolha
   * dele, e semear de novo desfaria a escolha a cada deploy.
   */
  private async semear(): Promise<void> {
    if (this.semeado) return;
    try {
      const total = await (this.prisma as any).siteHomeVitrine.count();
      if (total === 0) {
        await (this.prisma as any).siteHomeVitrine.createMany({
          data: SEMENTE.map((s) => ({ ...s, atualizadoPor: 'padrão do sistema' })),
          skipDuplicates: true,
        });
        this.logger.log('[vitrines-home] tabela vazia — semeada com a home que está no ar');
      }
      this.semeado = true;
    } catch (e: any) {
      // Tabela ainda não existe (deploy em trânsito): o site cai no padrão dele.
      this.logger.warn(`[vitrines-home] não consegui semear: ${e?.message || e}`);
    }
  }

  /** Categorias com peça publicada, e quantas — o que pode virar bloco. */
  private async categoriasComPeca(): Promise<Map<string, number>> {
    const mapa = new Map<string, number>();
    try {
      const linhas: Array<{ categoria: string | null }> = await (this.prisma as any).siteProduto.findMany({
        where: { publicado: true },
        select: { categoria: true },
      });
      for (const l of linhas) {
        const c = this.normSlug(l.categoria);
        if (c) mapa.set(c, (mapa.get(c) || 0) + 1);
      }
    } catch (e: any) {
      this.logger.warn(`[vitrines-home] catálogo indisponível: ${e?.message || e}`);
    }
    return mapa;
  }

  /**
   * O que a tela de Categorias já configurou: nome de exibição e FOTO.
   *
   * A foto é a mesma que o card da categoria usa no site — inclusive o recorte
   * lido por IA. O atalho da home reaproveita em vez de pedir upload de novo:
   * duas telas subindo foto da mesma categoria é convite pra elas divergirem.
   */
  private async dadosDasCategorias(): Promise<Map<string, { nome: string | null; imagemUrl: string | null; alt: string | null; focoX: number | null; focoY: number | null; focoZoom: number | null }>> {
    const mapa = new Map<string, any>();
    try {
      const linhas: any[] = await (this.prisma as any).siteCategoria.findMany({
        select: { slug: true, nome: true, imagemUrl: true, alt: true, focoX: true, focoY: true, focoZoom: true },
      });
      for (const l of linhas) mapa.set(this.normSlug(l.slug), l);
    } catch {
      /* nome derivado do slug e foto do site servem */
    }
    return mapa;
  }

  private async colecoes(): Promise<Array<{ slug: string; nome: string; qtd: number }>> {
    try {
      const linhas: Array<{ slug: string; nome: string | null; refs: any }> =
        await (this.prisma as any).siteColecao.findMany();
      return linhas.map((l) => ({
        slug: l.slug,
        nome: l.nome || this.nomeDoSlug(l.slug),
        qtd: Array.isArray(l.refs) ? l.refs.length : 0,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Rótulo e destino de cada bloco — DERIVADOS, nunca digitados: link escrito
   * à mão na retaguarda é 404 esperando acontecer.
   *
   * `nome` é o longo da tela ("Outlet (só peça em promoção)") e `curto` é o
   * que sai no site ("Outlet"). `href: null` = a seção sai sem o "Ver tudo":
   * é o caso de coleção que não seja a "Mais Top da Semana", a única com
   * página no site — mandar a cliente pra rota inexistente é pior que não ter
   * link nenhum.
   */
  private rotulo(
    tipo: string, chave: string, nomes: Map<string, string>,
  ): { nome: string; curto: string; href: string | null } {
    switch (tipo) {
      case 'novidades':
        return { nome: 'Novidades (o que acabou de chegar)', curto: 'Novidades', href: '/novidades' };
      case 'destaques':
        return { nome: 'Seleção da loja (por relevância)', curto: 'Seleção da loja', href: '/categoria' };
      case 'promocao':
        return { nome: 'Outlet (só peça em promoção)', curto: 'Outlet', href: '/outlet' };
      case 'colecao': {
        const curto = nomes.get(chave) || this.nomeDoSlug(chave);
        return { nome: curto, curto, href: chave === 'mais-top-da-semana' ? '/mais-top-da-semana' : null };
      }
      default: {
        const curto = nomes.get(chave) || this.nomeDoSlug(chave);
        return { nome: curto, curto, href: `/categoria/${chave}` };
      }
    }
  }

  private validar(bloco: string, tipo: string, chave: string): { bloco: BlocoHome; tipo: TipoVitrine; chave: string } {
    const b = this.normSlug(bloco || 'carrossel') as BlocoHome;
    if (!BLOCOS.includes(b)) throw new BadRequestException(`Bloco desconhecido: ${bloco}`);
    const t = this.normSlug(tipo) as TipoVitrine;
    if (!TIPOS.includes(t)) throw new BadRequestException(`Tipo de vitrine desconhecido: ${tipo}`);
    const c = PRECISA_CHAVE.includes(t) ? this.normSlug(chave) : '';
    if (PRECISA_CHAVE.includes(t) && !c) {
      throw new BadRequestException(
        t === 'categoria' ? 'Escolha a categoria da vitrine' : 'Escolha a coleção da vitrine',
      );
    }
    // Coleção curada não vira card de atalho: o card leva a uma página, e só a
    // "Mais Top da Semana" tem página. Sem destino, o card não faz nada.
    if (b === 'atalho' && t === 'colecao' && c !== 'mais-top-da-semana') {
      throw new BadRequestException('Essa coleção não tem página no site — não dá pra virar atalho');
    }
    return { bloco: b, tipo: t, chave: c };
  }

  // ───────────────────────────── RETAGUARDA ─────────────────────────────

  /**
   * A TELA: as duas listas na ordem + o que ainda dá pra adicionar em cada uma.
   *
   * A contagem de peças vai junto porque é ela que explica o bloco que não
   * aparece no site — sem isso, "cadastrei e não saiu" vira chamado.
   */
  async listarAdmin() {
    await this.semear();
    const [linhas, catalogo, cats, colecoes] = await Promise.all([
      (this.prisma as any).siteHomeVitrine.findMany({ orderBy: [{ bloco: 'asc' }, { ordem: 'asc' }] }),
      this.categoriasComPeca(),
      this.dadosDasCategorias(),
      this.colecoes(),
    ]);

    const nomesCat = new Map<string, string>(
      Array.from(cats.entries()).filter(([, v]) => !!v.nome).map(([k, v]) => [k, v.nome as string]),
    );
    const nomesColecao = new Map(colecoes.map((c) => [c.slug, c.nome]));
    const totalCatalogo = Array.from(catalogo.values()).reduce((a, b) => a + b, 0);

    const qtdDe = (tipo: string, chave: string): number => {
      if (tipo === 'categoria') return catalogo.get(chave) ?? 0;
      if (tipo === 'colecao') return colecoes.find((c) => c.slug === chave)?.qtd ?? 0;
      return totalCatalogo;
    };

    const montar = (bloco: BlocoHome) =>
      (linhas as any[])
        .filter((v) => v.bloco === bloco)
        .map((v, i) => {
          const nomes = v.tipo === 'colecao' ? nomesColecao : nomesCat;
          const { nome, curto, href } = this.rotulo(v.tipo, v.chave, nomes as Map<string, string>);
          return {
            id: v.id,
            bloco: v.bloco,
            tipo: v.tipo,
            chave: v.chave,
            nomeFonte: nome,
            href,
            titulo: v.titulo,
            tituloMobile: v.tituloMobile,
            tituloExibido: v.titulo || curto,
            eyebrow: v.eyebrow,
            descricao: v.descricao,
            ctaLabel: v.ctaLabel,
            limite: v.limite,
            ordem: v.ordem,
            ativo: v.ativo,
            imagemUrl: v.tipo === 'categoria' ? cats.get(v.chave)?.imagemUrl ?? null : null,
            qtdPecas: qtdDe(v.tipo, v.chave),
            posicao: i + 1,
          };
        });

    /** O que ainda cabe em cada bloco — nunca campo livre: vitrine digitada à mão vira carrossel vazio. */
    const disponiveisDe = (bloco: BlocoHome) => {
      const usadas = new Set((linhas as any[]).filter((v) => v.bloco === bloco).map((v) => `${v.tipo}:${v.chave}`));
      const fixas = bloco === 'atalho' ? ['novidades', 'promocao'] : ['novidades', 'destaques', 'promocao'];
      return [
        ...fixas
          .filter((t) => !usadas.has(`${t}:`))
          .map((t) => {
            const r = this.rotulo(t, '', nomesCat);
            return { bloco, tipo: t, chave: '', nome: r.nome, qtdPecas: qtdDe(t, '') };
          }),
        ...Array.from(catalogo.entries())
          .filter(([slug]) => !usadas.has(`categoria:${slug}`))
          .map(([slug, qtd]) => ({
            bloco, tipo: 'categoria', chave: slug,
            nome: nomesCat.get(slug) || this.nomeDoSlug(slug), qtdPecas: qtd,
          }))
          .sort((a, b) => b.qtdPecas - a.qtdPecas),
        ...colecoes
          .filter((c) => !usadas.has(`colecao:${c.slug}`))
          .filter((c) => bloco === 'carrossel' || c.slug === 'mais-top-da-semana')
          .map((c) => ({ bloco, tipo: 'colecao', chave: c.slug, nome: c.nome, qtdPecas: c.qtd })),
      ];
    };

    return {
      atalhos: montar('atalho'),
      carrosseis: montar('carrossel'),
      disponiveis: { atalho: disponiveisDe('atalho'), carrossel: disponiveisDe('carrossel') },
    };
  }

  async criar(body: VitrineInput, usuario: string) {
    const { bloco, tipo, chave } = this.validar(body.bloco ?? 'carrossel', body.tipo ?? 'categoria', body.chave ?? '');
    const existe = await (this.prisma as any).siteHomeVitrine.findUnique({
      where: { bloco_tipo_chave: { bloco, tipo, chave } },
    });
    if (existe) throw new BadRequestException('Isso já está na home');

    // Entra no FIM da lista: quem adiciona escolhe a posição depois, com as
    // setas, vendo a home inteira — não num campo de número às cegas.
    const ultima = await (this.prisma as any).siteHomeVitrine.findFirst({
      where: { bloco }, orderBy: { ordem: 'desc' }, select: { ordem: true },
    });

    const criada = await (this.prisma as any).siteHomeVitrine.create({
      data: {
        bloco, tipo, chave,
        titulo: this.texto(body.titulo),
        tituloMobile: this.texto(body.tituloMobile),
        eyebrow: this.texto(body.eyebrow),
        descricao: this.texto(body.descricao),
        ctaLabel: this.texto(body.ctaLabel),
        limite: Math.min(24, Math.max(4, Number(body.limite) || 12)),
        ordem: (ultima?.ordem ?? 0) + 1,
        ativo: body.ativo ?? true,
        atualizadoPor: usuario,
      },
    });
    this.avisarSite();
    return criada;
  }

  async salvar(id: string, body: VitrineInput, usuario: string) {
    const atual = await (this.prisma as any).siteHomeVitrine.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('Vitrine não encontrada');

    const dados: any = { atualizadoPor: usuario };
    // `undefined` = campo não veio no PATCH; `null`/'' = apagar o texto e
    // voltar ao padrão. Sem essa distinção, salvar o interruptor "ativo"
    // limparia os textos junto (bug clássico de PATCH parcial).
    if (body.titulo !== undefined) dados.titulo = this.texto(body.titulo);
    if (body.tituloMobile !== undefined) dados.tituloMobile = this.texto(body.tituloMobile);
    if (body.eyebrow !== undefined) dados.eyebrow = this.texto(body.eyebrow);
    if (body.descricao !== undefined) dados.descricao = this.texto(body.descricao);
    if (body.ctaLabel !== undefined) dados.ctaLabel = this.texto(body.ctaLabel);
    if (body.limite !== undefined) dados.limite = Math.min(24, Math.max(4, Number(body.limite) || 12));
    if (body.ativo !== undefined) dados.ativo = !!body.ativo;
    if (body.ordem !== undefined) dados.ordem = Number(body.ordem) || 0;

    const salva = await (this.prisma as any).siteHomeVitrine.update({ where: { id }, data: dados });
    this.avisarSite();
    return salva;
  }

  async remover(id: string) {
    await (this.prisma as any).siteHomeVitrine.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Vitrine não encontrada');
    });
    this.avisarSite();
    return { ok: true };
  }

  /**
   * REORDENAR — a tela manda a lista inteira de ids de UM bloco, na ordem final.
   *
   * Lista inteira, e não "sobe esta uma", porque duas setas clicadas rápido
   * mandariam dois pedidos concorrentes sobre a mesma ordem e o resultado
   * dependeria de quem chegasse primeiro no banco.
   */
  async reordenar(ids: string[], usuario: string) {
    const lista = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
    if (!lista.length) throw new BadRequestException('Nenhuma vitrine na lista');
    await this.prisma.$transaction(
      lista.map((id, i) =>
        (this.prisma as any).siteHomeVitrine.update({
          where: { id },
          data: { ordem: i + 1, atualizadoPor: usuario },
        }),
      ),
    );
    this.avisarSite();
    return { ok: true, total: lista.length };
  }

  // ─────────────────────────────── SITE ───────────────────────────────

  /**
   * O QUE A HOME CONSOME — os dois blocos, na ordem, JÁ COM AS PEÇAS.
   *
   * Com produtos dentro de propósito: a home fazia uma requisição por carrossel
   * e agora faz uma só. Cada vitrine é resolvida em paralelo e uma que falhe
   * volta vazia — o `filter` tira a seção e o resto da home segue de pé.
   * Nenhuma exceção sobe daqui.
   */
  async listarPublico() {
    await this.semear();
    let linhas: any[] = [];
    try {
      linhas = await (this.prisma as any).siteHomeVitrine.findMany({
        where: { ativo: true },
        orderBy: { ordem: 'asc' },
      });
    } catch (e: any) {
      this.logger.warn(`[vitrines-home] leitura falhou: ${e?.message || e}`);
      return { atalhos: [], carrosseis: [] };
    }
    if (!linhas.length) return { atalhos: [], carrosseis: [] };

    const [cats, colecoes, catalogo] = await Promise.all([
      this.dadosDasCategorias(),
      this.colecoes(),
      this.categoriasComPeca(),
    ]);
    const nomesCat = new Map<string, string>(
      Array.from(cats.entries()).filter(([, v]) => !!v.nome).map(([k, v]) => [k, v.nome as string]),
    );
    const nomesColecao = new Map(colecoes.map((c) => [c.slug, c.nome]));
    const nomesDe = (tipo: string) => (tipo === 'colecao' ? nomesColecao : nomesCat) as Map<string, string>;

    /**
     * ATALHO — card com foto, sem produto dentro. Não sai o que leva a lugar
     * vazio: atalho de categoria sem peça publicada é clique gasto.
     */
    const atalhos = linhas
      .filter((v) => v.bloco === 'atalho')
      .map((v) => {
        const { curto, href } = this.rotulo(v.tipo, v.chave, nomesDe(v.tipo));
        const cat = v.tipo === 'categoria' ? cats.get(v.chave) : null;
        return {
          id: v.id,
          tipo: v.tipo,
          chave: v.chave,
          nome: v.titulo || curto,
          href,
          // A foto da tela de Categorias, quando existe. O site prefere a arte
          // local do mockup quando ela existir pra essa chave.
          imagemUrl: cat?.imagemUrl ?? null,
          alt: cat?.alt ?? null,
          focoX: cat?.focoX ?? null,
          focoY: cat?.focoY ?? null,
          focoZoom: cat?.focoZoom ?? null,
          vazio: v.tipo === 'categoria' && (catalogo.get(v.chave) ?? 0) === 0,
        };
      })
      .filter((a) => a.href && !a.vazio)
      .map(({ vazio, ...a }) => a);

    const carrosseis = (
      await Promise.all(
        linhas
          .filter((v) => v.bloco === 'carrossel')
          .map(async (v) => {
            const { curto, href } = this.rotulo(v.tipo, v.chave, nomesDe(v.tipo));
            const itens = await this.pecasDa(v).catch((e) => {
              this.logger.warn(`[vitrines-home] ${v.tipo}:${v.chave} falhou: ${e?.message || e}`);
              return [] as any[];
            });
            const titulo = v.titulo || curto;
            return {
              id: v.id,
              tipo: v.tipo,
              chave: v.chave,
              titulo,
              tituloMobile: v.tituloMobile || null,
              eyebrow: v.eyebrow || null,
              descricao: v.descricao || null,
              // Sem destino não há botão: rótulo sozinho vira link morto na home.
              ctaLabel: href ? v.ctaLabel || `Ver tudo em ${titulo}` : null,
              ctaHref: href,
              itens,
            };
          }),
      )
    ).filter((v) => v.itens.length > 0); // carrossel vazio não sai

    return { atalhos, carrosseis };
  }

  /** As peças de UM carrossel, conforme o tipo. */
  private async pecasDa(v: { tipo: string; chave: string; limite: number }): Promise<any[]> {
    // Piso 12 na LEITURA (dono 20/08: "no PC pelo menos 12 produtos em 4
    // colunas") — as vitrines seeded com limite 10 mostravam 10 e a grade de
    // 4 colunas fechava em 2,5 linhas. O clamp de escrita (4–24) fica como
    // está: o número salvo continua valendo quando for ≥12.
    const perPage = Math.min(24, Math.max(12, Number(v.limite) || 12));

    if (v.tipo === 'colecao') {
      const r = await this.catalogo.curadoriaProdutos(this.normSlug(v.chave));
      return (r?.itens ?? []).slice(0, perPage);
    }

    const r = await this.catalogo.listar({
      page: 1,
      perPage,
      categoria: v.tipo === 'categoria' ? v.chave : undefined,
      soPromocao: v.tipo === 'promocao' ? true : undefined,
      // `lancamento`, o mesmo filtro que a home usava direto (`novidade=1`) —
      // sem ele "Novidades" viraria só "o catálogo em outra ordem".
      soNovidade: v.tipo === 'novidades' ? true : undefined,
      ordenar: v.tipo === 'destaques' ? 'relevancia' : 'novidades',
      // A home NUNCA mostra esgotado: ali a peça é isca, e isca sem estoque
      // gasta o clique (a listagem mostra riscado, que é outro contexto).
      soDisponivel: true,
    });
    return (r as any)?.itens ?? [];
  }
}
