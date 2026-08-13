import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { GrupoRefService } from './grupo-ref.service';

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
    private readonly grupos: GrupoRefService,
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

  /**
   * CATEGORIA COMERCIAL do site. Vem das categorias do WooCommerce (que é
   * onde a taxonomia de venda existe) e, se elas não resolverem, do próprio
   * nome da peça. NÃO usa `nomeGrupo` do Giga: aquilo é grupo fiscal, quase
   * sempre vazio e com valor tipo "BLUSA FEMININA" — o menu do site nunca
   * casaria. Mesmo mapa que o front já usava.
   */
  private static readonly MAPA_CATEGORIA: Record<string, string> = {
    vestido: 'vestidos', vestidos: 'vestidos',
    blusa: 'blusas', blusas: 'blusas', camisa: 'blusas', camiseta: 'blusas',
    tshirt: 'blusas', 'tshirts': 'blusas', cropped: 'blusas', regata: 'blusas',
    body: 'blusas', bata: 'blusas',
    calca: 'calcas', calcas: 'calcas', pantalona: 'calcas', legging: 'calcas',
    conjunto: 'conjuntos', conjuntos: 'conjuntos',
    macacao: 'macacoes', macacoes: 'macacoes', macaquinho: 'macacoes',
    jaqueta: 'jaquetas', jaquetas: 'jaquetas', casaco: 'jaquetas',
    blazer: 'jaquetas', cardigan: 'jaquetas', colete: 'jaquetas',
    kimono: 'jaquetas', sobretudo: 'jaquetas',
    saia: 'saias', saias: 'saias',
    short: 'shorts', shorts: 'shorts', bermuda: 'shorts',
    praia: 'moda-praia', biquini: 'moda-praia', maio: 'moda-praia', canga: 'moda-praia',
    fitness: 'fitness', academia: 'fitness',
    /**
     * Lingerie tem categoria PRÓPRIA de propósito. Sem estas linhas, "Conjunto
     * Lingerie" só casaria em `conjunto` e cairia junto com conjunto de blusa
     * e calça. Com elas, o nome passa a casar com DUAS categorias — e a regra
     * de `detectarCategoria` recusa o chute em vez de errar (a peça fica sem
     * categoria até alguém classificar no WooCommerce, que é onde a decisão
     * deve ser tomada).
     */
    lingerie: 'lingerie', calcinha: 'lingerie', sutia: 'lingerie',
    pijama: 'pijamas', camisola: 'pijamas', robe: 'pijamas',
    /**
     * Modeladores. "Cinta Modeladora Macaquinho" aparecia em MACACÕES (achado
     * do dono, 10/08): o nome tem "macaquinho", `macaquinho` estava no mapa e
     * `cinta` não — então casava com UMA categoria e ia pra lá com confiança.
     * Com estas linhas o nome passa a casar com duas, e a peça fica esperando
     * classificação em vez de errar.
     */
    cinta: 'modeladores', modeladora: 'modeladores', modelador: 'modeladores',
    shapewear: 'modeladores',
  };

  private semAcento(v: string): string {
    return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  /**
   * A CATEGORIA CADASTRADA MANDA; O NOME SÓ PALPITA QUANDO NÃO HÁ DÚVIDA.
   *
   * ── O QUE ESTAVA ERRADO (dono, 10/08/2026) ──
   *
   * O fallback pelo nome devolvia a PRIMEIRA palavra que casasse, na ordem em
   * que ela aparece no nome. "Conjunto Lingerie Renda" bate em `conjunto`
   * antes de qualquer outra coisa e ia parar em **Conjuntos**, junto com
   * conjunto de blusa e calça — duas coisas que não têm nada a ver uma com a
   * outra, e a cliente que filtra Conjuntos esperando look de trabalho recebe
   * lingerie no meio.
   *
   * O erro não é ter fallback, é ele CHUTAR NO EMPATE. Um nome com duas
   * categorias possíveis não é informação suficiente pra decidir — e decidir
   * errado é pior que não decidir, porque some sem sintoma: a peça aparece
   * numa vitrine onde ninguém a procura, e some da que ela deveria estar.
   *
   * ── A REGRA AGORA ──
   *
   * 1. Categoria cadastrada no WooCommerce vence sempre. É lá que a taxonomia
   *    de venda é mantida à mão, por gente.
   * 2. Sem ela, o nome é lido por INTEIRO. Se todas as palavras conhecidas
   *    apontarem pra MESMA categoria, usa. Se apontarem pra categorias
   *    diferentes, devolve `null` — a peça fica sem categoria e aparece na
   *    listagem geral, esperando alguém classificar. Melhor exposta sem
   *    categoria do que escondida na categoria errada.
   */
  private categoriaDoTexto(texto: string): Set<string> {
    const achadas = new Set<string>();
    for (const palavra of this.semAcento(texto).split(/[^a-z0-9]+/).filter(Boolean)) {
      const achou = SiteSyncService.MAPA_CATEGORIA[palavra];
      if (achou) achadas.add(achou);
    }
    return achadas;
  }

  /**
   * DE-PARA manual, carregado uma vez por sync (`site_categoria_mapa`).
   *
   * Chave: nome da categoria do WooCommerce normalizado. Valor: slug do site,
   * ou string vazia pra "ignorar de propósito".
   */
  private mapaManual = new Map<string, string>();

  private async carregarMapaManual(): Promise<void> {
    this.mapaManual.clear();
    try {
      const linhas: Array<{ origem: string; destino: string | null }> =
        await (this.prisma as any).siteCategoriaMapa.findMany({
          where: { destino: { not: null } },
          select: { origem: true, destino: true },
        });
      for (const l of linhas) this.mapaManual.set(l.origem, String(l.destino ?? ''));
    } catch (e: any) {
      // Tabela ainda não criada (deploy antigo): segue com o mapa do código.
      this.logger.warn(`[site-sync] de-para de categorias indisponível: ${e?.message || e}`);
    }
  }

  /**
   * Registra que esta categoria do WooCommerce existe, e quantas peças vieram
   * com ela. É o inventário que a tela da retaguarda lê pra mostrar o que
   * está esperando destino — sem ele, categoria nova do WC faria a peça sumir
   * da vitrine sem ninguém saber por quê.
   */
  private async registrarOrigens(contagem: Map<string, { rotulo: string; pecas: number }>): Promise<void> {
    for (const [origem, { rotulo, pecas }] of contagem) {
      try {
        await (this.prisma as any).siteCategoriaMapa.upsert({
          where: { origem },
          // `destino` NUNCA é tocado aqui: a decisão é de quem cadastra, e o
          // sync sobrescrevê-la apagaria o trabalho manual toda madrugada.
          update: { pecas, vistoEm: new Date(), origemRotulo: rotulo },
          create: { origem, origemRotulo: rotulo, pecas },
        });
      } catch {
        /* uma origem que falha não pode derrubar o sync inteiro */
      }
    }
  }

  private detectarCategoria(categoriasWc: string[], nome: string): string | null {
    // 0) DE-PARA MANUAL — o que a retaguarda decidiu vence tudo.
    for (const bruta of categoriasWc) {
      const chave = this.semAcento(bruta).trim();
      const escolhido = this.mapaManual.get(chave);
      if (escolhido === undefined) continue;
      // String vazia = "ignorar esta categoria do WC" (ex: "Promoções", que
      // não é tipo de peça). Segue procurando nas outras categorias da peça.
      if (escolhido) return escolhido;
    }

    // 1) O que foi CADASTRADO. Primeira categoria do WC que resolve, vence.
    for (const bruta of categoriasWc) {
      const achadas = this.categoriaDoTexto(bruta);
      if (achadas.size === 1) return [...achadas][0];
      // Categoria cadastrada ambígua ("Conjuntos de Lingerie") tem o mesmo
      // problema do nome — não chuta, tenta a próxima do WC.
    }

    // 2) Palpite pelo nome, só quando ele não se contradiz.
    const doNome = this.categoriaDoTexto(nome);
    if (doNome.size === 1) return [...doNome][0];
    if (doNome.size > 1) {
      this.logger.warn(
        `[site-sync] "${nome}" casa com ${doNome.size} categorias (${[...doNome].join(', ')}) ` +
          `e não tem categoria no WooCommerce — fica SEM categoria até alguém classificar.`,
      );
    }
    return null;
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

    // O de-para manual da retaguarda, antes de classificar qualquer peça.
    await this.carregarMapaManual();
    /** Inventário das categorias do WC vistas nesta rodada. Ver `registrarOrigens`. */
    const origensVistas = new Map<string, { rotulo: string; pecas: number }>();

    let lidos = 0, criados = 0, atualizados = 0, ignorados = 0, falhas = 0;
    const semSku: string[] = [];
    const semErp: string[] = [];
    const refsDuplicadas: string[] = [];
    const assumidas: string[] = [];
    let nSemSku = 0, nSemErp = 0, nDup = 0, nAssumidas = 0;
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
            if (!ref) { ignorados++; nSemSku++; if (semSku.length < 40) semSku.push(`#${p.id} ${p.name}`); continue; }
            if (!refsErp.has(ref)) { ignorados++; nSemErp++; if (semErp.length < 40) semErp.push(`${ref} (#${p.id})`); continue; }
            if (vistos.has(ref)) { ignorados++; nDup++; if (refsDuplicadas.length < 40) refsDuplicadas.push(`${ref} (#${p.id})`); continue; }
            vistos.add(ref);

            const imagens = (p.images ?? []).map((img: any) => ({
              src: img.src, alt: img.alt || p.name, tipo: 'imagem' as const,
            }));

            const categoriasWc: string[] = (p.categories ?? []).map((c: any) => String(c.name || ''));
            // Anota toda categoria do WC que passou por aqui — é o que a tela
            // da retaguarda lista pra você dar destino ao que ainda não tem.
            for (const bruta of categoriasWc) {
              const chave = this.semAcento(bruta).trim();
              if (!chave) continue;
              const atual = origensVistas.get(chave);
              if (atual) atual.pecas += 1;
              else origensVistas.set(chave, { rotulo: bruta.trim(), pecas: 1 });
            }

            const dados = {
              categoria: this.detectarCategoria(categoriasWc, String(p.name || '')),
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
              // A tag "Novidade" do WC NÃO entra mais (13/08): "Novidades"
              // virou automático por `publicadoEm` (peça no ar há ≤30 dias).
              // A etiqueta editorial do site velho nunca expirava — regata de
              // meses atrás ficava novidade pra sempre.
              wcId: Number(p.id) || null,
              wcSlug: p.slug ? String(p.slug).slice(0, 160) : null,
              origemConteudo: 'woocommerce',
              syncedAt: new Date(),
            };

            const existente = await (this.prisma as any).siteProduto.findUnique({ where: { ref } });
            if (existente?.origemConteudo === 'flow') {
              // Peça já assumida pelo Flow: o site antigo não manda mais nela.
              ignorados++;
              nAssumidas++;
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

      // Grava o inventário de categorias do WC vistas nesta rodada.
      await this.registrarOrigens(origensVistas);

      /**
       * REF nova pode ter nascido agora — recalcula quais são a mesma peça em
       * cores diferentes. Nunca derruba o sync: agrupamento é apresentação, e
       * falhar aqui não pode invalidar um catálogo que já foi importado.
       */
      await this.grupos
        .recalcular()
        .catch((e: any) =>
          this.logger.warn(`[site-sync] agrupamento por REF falhou: ${e?.message || e}`),
        );
      const semDestino = [...origensVistas.keys()].filter(
        (o) => !this.mapaManual.get(o) && this.categoriaDoTexto(o).size !== 1,
      );
      if (semDestino.length) {
        this.logger.warn(
          `[site-sync] ${semDestino.length} categoria(s) do WooCommerce sem destino: ` +
            `${semDestino.slice(0, 8).join(', ')} — dar destino em /retaguarda/categorias-mapa`,
        );
      }

      const duracaoMs = Date.now() - inicio;
      const detalhes = {
        categoriasSemDestino: { qtd: semDestino.length, exemplos: semDestino.slice(0, 20) },
        semSku: { qtd: nSemSku, exemplos: semSku },
        semCorrespondenciaNoErp: { qtd: nSemErp, exemplos: semErp },
        refsDuplicadasNoWc: { qtd: nDup, exemplos: refsDuplicadas },
        jaAssumidasPeloFlow: { qtd: nAssumidas, exemplos: assumidas },
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
