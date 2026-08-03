import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CATÁLOGO DO E-COMMERCE (sprint 008) — ERP é a fonte da verdade.
 *
 * Uma "peça" do site = uma REF. As variações (cor × tamanho) são as linhas
 * do ERP com aquela REF. Nada é duplicado:
 *
 *   preço, grade, cor, EAN, NCM, marca  → wincred_produtos  (espelho do ERP)
 *   estoque por loja                    → wincred_estoque   (espelho, hora em hora)
 *   nome, descrição, SEO, coleção       → site_produto      (CADASTRO do Flow)
 *   fotos                               → product_photos    (R2 da Lurd's) e,
 *                                         enquanto a migração de imagem não
 *                                         roda, o que veio do WC no import
 *   modelagem, elastano, caimento       → fit_product       (camada Lurd's)
 *
 * O site NUNCA consulta WooCommerce nem Giga ao vivo: tudo sai do Postgres
 * local, então a página aguenta ISR/prefetch sem risco pra operação.
 *
 * CURADORIA: só sai no site REF com linha em `site_produto` e `publicado`.
 * Sem isso o site listaria o catálogo inteiro do ERP (milhares de itens de
 * loja física que nunca foram pensados pra venda online).
 */

export interface ListarParams {
  page?: number;
  perPage?: number;
  busca?: string;
  categoria?: string;
  marca?: string;
  cor?: string;
  tamanho?: string;
  precoMin?: number;
  precoMax?: number;
  modelagem?: string;
  soPromocao?: boolean;
  soNovidade?: boolean;
  soDisponivel?: boolean;
  ordenar?: 'relevancia' | 'novidades' | 'preco-asc' | 'preco-desc' | 'nome';
}

type LinhaErp = {
  ref: string;
  codigo: string;
  cor: string | null;
  tamanho: string | null;
  marca: string | null;
  categoria: string | null;
  descricao: string | null;
  preco: number;
  custo: number | null;
  ean: string | null;
  ncm: string | null;
  cst: string | null;
  estoque: number;
  dataAlt: Date | null;
};

@Injectable()
export class LojaCatalogService {
  private readonly logger = new Logger(LojaCatalogService.name);

  /** Facetas custam um scan do catálogo — 10 min de cache resolve. */
  private cacheFiltros: { at: number; data: any } | null = null;
  private readonly TTL_FILTROS = 10 * 60_000;

  constructor(private readonly prisma: PrismaService) {}

  private normRef(v?: string | null) {
    return String(v || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  /**
   * SQL base das variações publicadas. Junta ERP + estoque somado + curadoria.
   * Estoque: SOMA de todas as lojas (o site vende do consolidado; a reserva
   * por loja entra na fase 2 junto com retirada em loja).
   */
  private readonly SQL_VARIACOES = `
    SELECT
      UPPER(TRIM(p.ref))                          AS ref,
      p.codigo                                    AS codigo,
      NULLIF(TRIM(p.cor), '')                     AS cor,
      NULLIF(TRIM(p.tamanho), '')                 AS tamanho,
      NULLIF(TRIM(p.marca), '')                   AS marca,
      NULLIF(TRIM(p."nomeGrupo"), '')              AS categoria,
      NULLIF(TRIM(p."descricaoCompleta"), '')      AS descricao,
      COALESCE(p."vendaUn", 0)::float8             AS preco,
      p.custo::float8                             AS custo,
      NULLIF(TRIM(p.ean), '')                     AS ean,
      NULLIF(TRIM(p.ncm), '')                     AS ncm,
      NULLIF(TRIM(p.cst), '')                     AS cst,
      COALESCE(e.total, 0)::int                   AS estoque,
      p."dataAlt"                                 AS "dataAlt"
    FROM wincred_produtos p
    LEFT JOIN (
      SELECT codigo, SUM(COALESCE(estoque, 0)) AS total
        FROM wincred_estoque GROUP BY codigo
    ) e ON e.codigo = p.codigo
    WHERE p.ref IS NOT NULL AND TRIM(p.ref) <> ''
  `;

  /**
   * Peça montada a partir das variações de uma REF.
   *
   * A PÁGINA DO SITE É UMA SÓ POR REF (decisão do dono, 03/08): a cliente
   * escolhe a COR numa bolinha e só depois o tamanho. Por isso `cores` não é
   * mais uma lista de nomes — cada cor carrega o que muda ao ser escolhida:
   * fotos, grade de tamanhos com estoque, preço e a bolinha.
   */
  private montarPeca(
    ref: string, linhas: LinhaErp[], site: any, fit: any, fotos: any[] = [], ficha?: any,
  ) {
    /* ── DEDUPE: a mesma cor+tamanho não pode aparecer duas vezes ──────────
     * O catálogo tem REF cadastrada mais de uma vez (códigos diferentes pra
     * MESMO cor+tamanho). Sem tratar, a cliente via "44 46 46 48 48 50 50".
     *
     * Regra do dono (03/08): NUNCA duplicar; entre os cadastros duplicados
     * fica o de MAIOR QUANTIDADE — e a duplicidade é REPORTADA. Somar os dois
     * seria pior: inflaria o estoque de um erro de cadastro e o site venderia
     * peça que não existe.
     */
    const chaveVar = (l: LinhaErp) =>
      `${(l.cor || '').trim().toUpperCase()}|${(l.tamanho || '').trim().toUpperCase()}`;

    const melhorPorVariacao = new Map<string, LinhaErp>();
    const duplicadas: Array<{ cor: string | null; tamanho: string | null; codigos: string[] }> = [];
    for (const l of linhas) {
      const k = chaveVar(l);
      const atual = melhorPorVariacao.get(k);
      if (!atual) {
        melhorPorVariacao.set(k, l);
        continue;
      }
      // Empate de estoque: fica o de código menor, só pra ser determinístico
      // (duas respostas diferentes pra mesma peça confundem mais que o erro).
      const vence =
        (l.estoque || 0) > (atual.estoque || 0) ||
        ((l.estoque || 0) === (atual.estoque || 0) && String(l.codigo) < String(atual.codigo));
      if (vence) melhorPorVariacao.set(k, l);

      const registro = duplicadas.find(
        (d) => (d.cor || '') === (l.cor || '') && (d.tamanho || '') === (l.tamanho || ''),
      );
      if (registro) {
        if (!registro.codigos.includes(l.codigo)) registro.codigos.push(l.codigo);
      } else {
        duplicadas.push({ cor: l.cor, tamanho: l.tamanho, codigos: [atual.codigo, l.codigo] });
      }
    }
    if (duplicadas.length) {
      this.logger.warn(
        `[catalogo] REF ${ref} tem ${duplicadas.length} variação(ões) duplicada(s) — ` +
          `vale a de maior estoque: ${duplicadas
            .map((d) => `${d.cor ?? '?'}/${d.tamanho ?? '?'} [${d.codigos.join(', ')}]`)
            .join(' · ')}`,
      );
    }
    const unicas = Array.from(melhorPorVariacao.values());

    // Preço e estoque saem das ÚNICAS: somar cadastro duplicado inflaria o
    // estoque do site e faria vender peça que não existe na arara.
    const precos = unicas.map((l) => l.preco).filter((p) => p > 0);
    const preco = precos.length ? Math.min(...precos) : 0;
    const estoqueTotal = unicas.reduce((s, l) => s + (l.estoque || 0), 0);

    // Grade: tamanho na ordem da numeração plus, com estoque somado por tamanho
    const porTamanho = new Map<string, number>();
    const cores = new Map<string, { nome: string; estoque: number }>();
    for (const l of unicas) {
      if (l.tamanho) porTamanho.set(l.tamanho, (porTamanho.get(l.tamanho) || 0) + (l.estoque || 0));
      if (l.cor) {
        const c = cores.get(l.cor) || { nome: l.cor, estoque: 0 };
        c.estoque += l.estoque || 0;
        cores.set(l.cor, c);
      }
    }
    const ordemTam = (t: string) => {
      const n = parseInt(String(t).replace(/\D/g, ''), 10);
      return Number.isFinite(n) ? n : 999;
    };
    const tamanhos = Array.from(porTamanho.entries())
      .sort((a, b) => ordemTam(a[0]) - ordemTam(b[0]))
      .map(([label, est]) => ({ label, estoque: est, disponivel: est > 0 }));

    /* ── CORES como VARIAÇÃO ESCOLHÍVEL ─────────────────────────────────
     * Cada cor devolve tudo que muda quando a cliente clica na bolinha:
     * suas fotos, sua grade (só os tamanhos daquela cor) e seu preço.
     *
     * Cor SEM FOTO não vai pro site (decisão do dono, 03/08): bolinha que
     * abre galeria vazia é pior que cor a menos. A ficha (`produto_ficha_cor`)
     * traz a bolinha — hex do conta-gotas ou recorte da foto pra estampa.
     */
    const fichaPorCor = new Map<string, any>(
      ((ficha?.cores ?? []) as any[]).map((c) => [String(c.cor || '').toUpperCase(), c]),
    );
    const fotosPorCor = new Map<string, any[]>();
    for (const f of fotos) {
      const k = String(f.cor || '').toUpperCase();
      if (!fotosPorCor.has(k)) fotosPorCor.set(k, []);
      fotosPorCor.get(k)!.push(f);
    }

    const coresDetalhadas = Array.from(cores.keys())
      .sort((a, b) => a.localeCompare(b, 'pt-BR'))
      .map((nomeCor) => {
        const chave = nomeCor.toUpperCase();
        const daCor = unicas.filter((l) => (l.cor || '').toUpperCase() === chave);
        const suasFotos = fotosPorCor.get(chave) ?? [];
        const f = fichaPorCor.get(chave);
        const precosCor = daCor.map((l) => l.preco).filter((p) => p > 0);
        const capa = suasFotos[0]?.url ?? null;

        return {
          nome: nomeCor,
          estoque: daCor.reduce((s, l) => s + (l.estoque || 0), 0),
          preco: precosCor.length ? Math.min(...precosCor) : 0,
          // Bolinha: 'cor' = hex tirado da foto; 'foto' = recorte da estampa,
          // enquadrado pelo ponto que a retaguarda clicou.
          swatch: {
            tipo: f?.swatchTipo === 'foto' ? 'foto' : 'cor',
            hex: f?.corHex ?? null,
            focoX: f?.swatchFocoX ?? null,
            focoY: f?.swatchFocoY ?? null,
            imagem: capa,
          },
          fotos: suasFotos.map((x: any) => ({
            src: x.url,
            alt: `${site?.nome || ref} ${nomeCor}`,
          })),
          titulo: f?.tituloComercial ?? null,
          youtubeUrl: f?.youtubeUrl ?? null,
          tamanhos: daCor
            .filter((l) => l.tamanho)
            .sort((a, b) => ordemTam(a.tamanho!) - ordemTam(b.tamanho!))
            .map((l) => ({
              label: l.tamanho!,
              sku: l.codigo,
              ean: l.ean,
              preco: l.preco,
              estoque: l.estoque || 0,
              disponivel: (l.estoque || 0) > 0,
            })),
        };
      })
      // TRANSIÇÃO: enquanto a REF não tiver NENHUMA foto própria (o acervo
      // ainda está vindo do WooCommerce, sem cor associada), mostra todas as
      // cores. A partir da primeira foto no R2, vale a regra: cor sem foto
      // não aparece.
      .filter((c) => c.fotos.length > 0 || fotos.length === 0);

    const dataAlt = linhas.map((l) => l.dataAlt).filter(Boolean).sort()
      .slice(-1)[0] as Date | undefined;

    return {
      ref,
      slug: site?.slug || `ref-${ref.toLowerCase()}`,
      nome: site?.nome || linhas[0]?.descricao || ref,
      descricaoCurta: site?.descricaoCurta ?? null,
      descricaoCompleta: site?.descricaoCompleta ?? null,
      marca: linhas.find((l) => l.marca)?.marca ?? null,
      // Categoria COMERCIAL (do cadastro do site). O grupo do Giga vai
      // separado: é classificação fiscal, não serve pro menu da loja.
      categoria: site?.categoria ?? null,
      grupoErp: linhas.find((l) => l.categoria)?.categoria ?? null,

      preco,
      // Pix e parcelamento são convenção da marca (5% / 12x), não dado do ERP.
      precoPix: preco > 0 ? Number((preco * 0.95).toFixed(2)) : null,
      parcelamento: preco > 0 ? { vezes: 12, valor: Number((preco / 12).toFixed(2)) } : null,

      cores: coresDetalhadas,
      tamanhos,
      estoqueTotal,
      disponivel: estoqueTotal > 0,

      // FOTO PRÓPRIA VENCE (decisão 30/07): o R2 é da Lurd's; o que veio do
      // WC é só o resto do acervo até a migração de imagem terminar.
      imagens: fotos.length
        ? fotos.map((f) => ({ src: f.url, alt: `${site?.nome || ref}${f.cor ? ` ${f.cor}` : ''}`, tipo: 'imagem', cor: f.cor ?? null, origem: 'flow' }))
        : ((site?.imagens as any[]) ?? []).map((i) => ({ ...i, origem: 'wc' })),
      seo: site?.seo ?? null,

      // Ficha de caimento (Lurd's Fit AI) — alimenta filtro e recomendação
      modelagem: fit?.modelagem ?? null,
      elastano: fit?.elastano ?? null,
      caimento: fit?.caimento ?? null,
      composicao: fit?.composicao ?? null,
      medidas: fit?.medidas ?? null,

      destaque: !!site?.destaque,
      lancamento: !!site?.lancamento,
      promocao: !!site?.promocao,
      atualizadoEm: dataAlt ?? null,

      // Fiscal (pro checkout futuro) — do ERP, nunca digitado
      fiscal: { ncm: linhas.find((l) => l.ncm)?.ncm ?? null, cst: linhas.find((l) => l.cst)?.cst ?? null },

      // Cadastro duplicado (mesma cor+tamanho em códigos diferentes). Vai no
      // payload pra retaguarda REPORTAR — o site ignora, mas alguém tem que
      // limpar o cadastro: código duplicado é etiqueta ambígua no bipe.
      duplicidades: duplicadas,

      // Só as variações que sobreviveram ao dedupe — é o que o carrinho e a
      // separação enxergam.
      variacoes: unicas.map((l) => ({
        sku: l.codigo,
        cor: l.cor,
        tamanho: l.tamanho,
        ean: l.ean,
        preco: l.preco,
        estoque: l.estoque,
        disponivel: (l.estoque || 0) > 0,
      })),
    };
  }

  /** Carrega curadoria + ficha de caimento de um conjunto de REFs. */
  private async complementos(refs: string[]) {
    const [sites, fits, fotos, fichas] = await Promise.all([
      (this.prisma as any).siteProduto.findMany({ where: { ref: { in: refs } } }),
      (this.prisma as any).fitProduct.findMany({ where: { ref: { in: refs } } }),
      // Fotos próprias (R2) — o mesmo acervo que a Live já usa.
      // `ordem` primeiro: é ela que define a capa da cor (a galeria da tela
      // master é ordenável). `createdAt` só desempata.
      (this.prisma as any).productPhoto.findMany({
        where: { ref: { in: refs } },
        orderBy: [{ cor: 'asc' }, { ordem: 'asc' }, { createdAt: 'asc' }],
      }),
      // Ficha do CRM: é de lá que vem a bolinha de cada cor.
      (this.prisma as any).produtoFicha.findMany({
        where: { ref: { in: refs } },
        include: { cores: true },
      }),
    ]);
    const porRefFotos = new Map<string, any[]>();
    for (const f of fotos as any[]) {
      const k = String(f.ref || '').toUpperCase();
      if (!porRefFotos.has(k)) porRefFotos.set(k, []);
      porRefFotos.get(k)!.push(f);
    }
    const porRefFichas = new Map<string, any[]>();
    for (const f of fichas as any[]) {
      const k = String(f.ref || '').toUpperCase();
      if (!porRefFichas.has(k)) porRefFichas.set(k, []);
      porRefFichas.get(k)!.push(f);
    }
    return {
      site: new Map<string, any>((sites as any[]).map((s) => [s.ref, s])),
      fit: new Map<string, any>((fits as any[]).map((f) => [f.ref, f])),
      fotos: porRefFotos,
      fichas: porRefFichas,
    };
  }

  /**
   * Ficha da peça. A chave é REF + MARCA, nunca REF sozinha: REF numérica é
   * reciclada entre fornecedores e pegar a ficha errada colocaria a bolinha
   * (e a descrição) de outra peça na página. Ver [[giga-ref-reciclada]].
   * Com uma única ficha na REF, aceita sem marca — o cadastro antigo não
   * tinha esse cuidado e travar aqui esconderia a ficha certa.
   */
  private escolherFicha(fichas: any[] | undefined, marca?: string | null) {
    if (!fichas?.length) return undefined;
    const m = String(marca || '').trim().toUpperCase();
    if (m) {
      const exata = fichas.find((f) => String(f.marca || '').toUpperCase() === m);
      if (exata) return exata;
    }
    return fichas.length === 1 ? fichas[0] : undefined;
  }

  /** Listagem paginada — o que a página de categoria e a busca consomem. */
  async listar(params: ListarParams) {
    const page = Math.max(1, Number(params.page) || 1);
    const perPage = Math.min(60, Math.max(1, Number(params.perPage) || 24));

    // 1) REFs publicadas (curadoria) — a lista de saída nunca é maior que isso
    const wherePub: any = { publicado: true };
    if (params.categoria) wherePub.categoria = String(params.categoria).trim().toLowerCase();
    if (params.soPromocao) wherePub.promocao = true;
    if (params.soNovidade) wherePub.lancamento = true;
    const publicadas: any[] = await (this.prisma as any).siteProduto.findMany({
      where: wherePub, select: { ref: true },
    });
    if (!publicadas.length) {
      return { itens: [], total: 0, page, perPage, totalPages: 0, fonte: 'erp', aviso: 'nenhuma REF publicada — rode o sync de conteúdo' };
    }
    const refsPub = publicadas.map((p) => p.ref);

    // 2) Variações do ERP dessas REFs
    const linhas: LinhaErp[] = await this.prisma.$queryRawUnsafe(
      `${this.SQL_VARIACOES} AND UPPER(TRIM(p.ref)) = ANY($1)`, refsPub,
    );

    const porRef = new Map<string, LinhaErp[]>();
    for (const l of linhas) {
      if (!porRef.has(l.ref)) porRef.set(l.ref, []);
      porRef.get(l.ref)!.push(l);
    }
    const { site, fit, fotos } = await this.complementos(Array.from(porRef.keys()));

    let pecas = Array.from(porRef.entries()).map(([ref, ls]) =>
      this.montarPeca(ref, ls, site.get(ref), fit.get(ref), fotos.get(ref) ?? []),
    );

    // 3) Filtros (em memória: o universo é o publicado, não o catálogo todo)
    const norm = (v: any) => String(v ?? '').trim().toUpperCase();
    if (params.busca) {
      const termos = norm(params.busca).split(/\s+/).filter(Boolean);
      pecas = pecas.filter((p) => {
        const alvo = norm(`${p.nome} ${p.marca} ${p.categoria} ${p.ref} ${p.descricaoCurta ?? ''}`);
        return termos.every((t) => alvo.includes(t));
      });
    }
    if (params.marca) pecas = pecas.filter((p) => norm(p.marca) === norm(params.marca));
    if (params.cor) pecas = pecas.filter((p) => p.cores.some((c) => norm(c.nome) === norm(params.cor)));
    if (params.tamanho) pecas = pecas.filter((p) => p.tamanhos.some((t) => norm(t.label) === norm(params.tamanho) && t.disponivel));
    if (params.modelagem) pecas = pecas.filter((p) => norm(p.modelagem) === norm(params.modelagem));
    if (params.precoMin != null) pecas = pecas.filter((p) => p.preco >= Number(params.precoMin));
    if (params.precoMax != null) pecas = pecas.filter((p) => p.preco <= Number(params.precoMax));
    if (params.soDisponivel !== false) pecas = pecas.filter((p) => p.disponivel);

    // 4) Ordenação
    const ord = params.ordenar || 'relevancia';
    pecas.sort((a, b) => {
      switch (ord) {
        case 'preco-asc': return a.preco - b.preco;
        case 'preco-desc': return b.preco - a.preco;
        case 'nome': return a.nome.localeCompare(b.nome, 'pt-BR');
        case 'novidades':
          return new Date(b.atualizadoEm ?? 0).getTime() - new Date(a.atualizadoEm ?? 0).getTime();
        default:
          // Relevância: destaque > lançamento > estoque saudável
          if (a.destaque !== b.destaque) return a.destaque ? -1 : 1;
          if (a.lancamento !== b.lancamento) return a.lancamento ? -1 : 1;
          return b.estoqueTotal - a.estoqueTotal;
      }
    });

    const total = pecas.length;
    const inicio = (page - 1) * perPage;
    return {
      itens: pecas.slice(inicio, inicio + perPage),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      fonte: 'erp',
    };
  }

  /** Detalhe da peça — por slug (site) ou pela própria REF. */
  async porSlug(slug: string) {
    const chave = String(slug || '').trim();
    if (!chave) return null;

    let registro = await (this.prisma as any).siteProduto.findUnique({ where: { slug: chave } });
    if (!registro) {
      const ref = this.normRef(chave.replace(/^ref-/i, ''));
      registro = await (this.prisma as any).siteProduto.findUnique({ where: { ref } });
      if (!registro) {
        // Sem curadoria ainda: deixa abrir pela REF se o ERP tiver a peça —
        // é o que permite testar o site antes do primeiro sync de conteúdo.
        const linhasSoltas: LinhaErp[] = await this.prisma.$queryRawUnsafe(
          `${this.SQL_VARIACOES} AND UPPER(TRIM(p.ref)) = $1`, ref,
        );
        if (!linhasSoltas.length) return null;
        const c = await this.complementos([ref]);
        return this.montarPeca(
          ref, linhasSoltas, null, c.fit.get(ref), c.fotos.get(ref) ?? [],
          this.escolherFicha(c.fichas.get(ref), linhasSoltas.find((l) => l.marca)?.marca),
        );
      }
    }

    const linhas: LinhaErp[] = await this.prisma.$queryRawUnsafe(
      `${this.SQL_VARIACOES} AND UPPER(TRIM(p.ref)) = $1`, registro.ref,
    );
    if (!linhas.length) return null;
    const c = await this.complementos([registro.ref]);
    return this.montarPeca(
      registro.ref, linhas, registro, c.fit.get(registro.ref), c.fotos.get(registro.ref) ?? [],
      this.escolherFicha(c.fichas.get(registro.ref), linhas.find((l) => l.marca)?.marca),
    );
  }

  /** Peças da mesma categoria — o "você também pode gostar". */
  async relacionados(slug: string, limite = 8) {
    const peca = await this.porSlug(slug);
    if (!peca) return [];
    const lista = await this.listar({ categoria: peca.categoria ?? undefined, perPage: limite + 1 });
    return lista.itens.filter((p: any) => p.ref !== peca.ref).slice(0, limite);
  }

  /**
   * FACETAS geradas do catálogo real — nada de lista fixa no front.
   * Só conta o que está publicado E com estoque (filtro que leva a zero
   * resultado é pior que filtro que não existe).
   */
  async filtros() {
    if (this.cacheFiltros && Date.now() - this.cacheFiltros.at < this.TTL_FILTROS) {
      return { ...this.cacheFiltros.data, cache: true };
    }
    const publicadas: any[] = await (this.prisma as any).siteProduto.findMany({
      where: { publicado: true }, select: { ref: true },
    });
    const refs = publicadas.map((p) => p.ref);
    const linhas: LinhaErp[] = refs.length
      ? await this.prisma.$queryRawUnsafe(`${this.SQL_VARIACOES} AND UPPER(TRIM(p.ref)) = ANY($1)`, refs)
      : [];

    const conta = (mapa: Map<string, number>, chave?: string | null) => {
      const k = String(chave || '').trim();
      if (!k) return;
      mapa.set(k, (mapa.get(k) || 0) + 1);
    };
    const categorias = new Map<string, number>();
    const marcas = new Map<string, number>();
    const cores = new Map<string, number>();
    const tamanhos = new Map<string, number>();
    let precoMin = Infinity, precoMax = 0;

    const refsVistas = new Set<string>();
    for (const l of linhas) {
      if ((l.estoque || 0) <= 0) continue;
      conta(cores, l.cor);
      conta(tamanhos, l.tamanho);
      if (!refsVistas.has(l.ref)) {
        refsVistas.add(l.ref);
        conta(marcas, l.marca);
      }
      if (l.preco > 0) {
        precoMin = Math.min(precoMin, l.preco);
        precoMax = Math.max(precoMax, l.preco);
      }
    }

    // Categoria vem do cadastro comercial, não do grupo fiscal do Giga
    const cadastros: any[] = await (this.prisma as any).siteProduto.findMany({
      where: { ref: { in: Array.from(refsVistas) } },
      select: { categoria: true },
    });
    for (const c of cadastros) conta(categorias, c.categoria);

    const fits: any[] = await (this.prisma as any).fitProduct.findMany({
      where: { ref: { in: Array.from(refsVistas) } },
      select: { modelagem: true },
    });
    const modelagens = new Map<string, number>();
    for (const f of fits) conta(modelagens, f.modelagem);

    const paraLista = (m: Map<string, number>, ordemNumerica = false) =>
      Array.from(m.entries())
        .map(([valor, qtd]) => ({ valor, qtd }))
        .sort((a, b) => (ordemNumerica
          ? (parseInt(a.valor.replace(/\D/g, ''), 10) || 999) - (parseInt(b.valor.replace(/\D/g, ''), 10) || 999)
          : b.qtd - a.qtd));

    const data = {
      categorias: paraLista(categorias),
      marcas: paraLista(marcas),
      cores: paraLista(cores),
      tamanhos: paraLista(tamanhos, true),
      modelagens: paraLista(modelagens),
      preco: {
        min: Number.isFinite(precoMin) ? Math.floor(precoMin) : 0,
        max: Math.ceil(precoMax),
      },
      pecasPublicadas: refsVistas.size,
      cache: false,
    };
    this.cacheFiltros = { at: Date.now(), data };
    return data;
  }

  /**
   * EDITA o cadastro comercial da peça — e o Flow TOMA POSSE dela.
   *
   * A partir daqui `origemConteudo='flow'` e o importador do site antigo
   * nunca mais sobrescreve essa peça (ver SiteSyncService). É assim que a
   * migração acontece produto a produto, sem data de corte.
   */
  async editar(ref: string, dados: any, usuario?: string) {
    const chave = this.normRef(ref);
    if (!chave) throw new Error('ref obrigatória');

    const texto = (v: any, max: number) =>
      v === undefined ? undefined : (String(v ?? '').trim().slice(0, max) || null);

    const data: any = {
      nome: dados.nome !== undefined ? String(dados.nome).trim().slice(0, 160) : undefined,
      descricaoCurta: texto(dados.descricaoCurta, 2000),
      descricaoCompleta: texto(dados.descricaoCompleta, 20000),
      colecao: texto(dados.colecao, 60),
      linha: texto(dados.linha, 60),
      seo: dados.seo !== undefined ? dados.seo : undefined,
      publicado: dados.publicado !== undefined ? !!dados.publicado : undefined,
      destaque: dados.destaque !== undefined ? !!dados.destaque : undefined,
      lancamento: dados.lancamento !== undefined ? !!dados.lancamento : undefined,
      promocao: dados.promocao !== undefined ? !!dados.promocao : undefined,
      origemConteudo: 'flow',
      editadoPor: usuario ?? null,
      editadoEm: new Date(),
    };
    if (dados.slug) {
      data.slug = String(dados.slug).trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 160);
    }

    const existente = await (this.prisma as any).siteProduto.findUnique({ where: { ref: chave } });
    this.cacheFiltros = null;

    if (existente) {
      return (this.prisma as any).siteProduto.update({ where: { ref: chave }, data });
    }
    // Peça que nunca passou pelo site antigo: nasce direto no Flow.
    const linhas: LinhaErp[] = await this.prisma.$queryRawUnsafe(
      `${this.SQL_VARIACOES} AND UPPER(TRIM(p.ref)) = $1`, chave,
    );
    if (!linhas.length) throw new Error(`REF ${chave} não existe no ERP`);
    return (this.prisma as any).siteProduto.create({
      data: {
        ref: chave,
        slug: data.slug || `ref-${chave.toLowerCase()}`,
        nome: data.nome || linhas[0].descricao || chave,
        publicado: data.publicado ?? false,
        ...data,
      },
    });
  }

  /**
   * VALIDAÇÃO ERP × SITE (exigência do sprint): mostra, com número, tudo que
   * está divergente. É o que responde "o site está fiel ao ERP?".
   */
  async validacao() {
    const [erpAgg] = await this.prisma.$queryRawUnsafe<Array<any>>(`
      SELECT COUNT(DISTINCT UPPER(TRIM(ref)))::int AS refs,
             COUNT(*)::int                          AS skus
        FROM wincred_produtos
       WHERE ref IS NOT NULL AND TRIM(ref) <> ''
    `);

    const [publicadas, comImagem, comFicha, semEstoque] = await Promise.all([
      (this.prisma as any).siteProduto.count({ where: { publicado: true } }),
      (this.prisma as any).siteProduto.count({ where: { publicado: true, imagens: { not: null } } }),
      (this.prisma as any).fitProduct.count(),
      this.prisma.$queryRawUnsafe<Array<{ n: number }>>(`
        SELECT COUNT(*)::int AS n FROM (
          SELECT UPPER(TRIM(p.ref)) AS ref, SUM(COALESCE(e.total,0)) AS est
            FROM wincred_produtos p
            LEFT JOIN (SELECT codigo, SUM(COALESCE(estoque,0)) AS total FROM wincred_estoque GROUP BY codigo) e
              ON e.codigo = p.codigo
           WHERE p.ref IS NOT NULL AND TRIM(p.ref) <> ''
           GROUP BY 1 HAVING SUM(COALESCE(e.total,0)) <= 0
        ) x
      `),
    ]);

    // Publicadas que sumiram do ERP (produto descontinuado ainda no ar)
    const orfas: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT s.ref, s.nome
        FROM site_produto s
       WHERE s.publicado = true
         AND NOT EXISTS (
           SELECT 1 FROM wincred_produtos p WHERE UPPER(TRIM(p.ref)) = s.ref
         )
       LIMIT 50
    `);

    // Publicadas sem NENHUM estoque na rede — o site mostra e a cliente não recebe
    const semGrade: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT s.ref, s.nome
        FROM site_produto s
        LEFT JOIN (
          SELECT UPPER(TRIM(p.ref)) AS ref, SUM(COALESCE(e.total,0)) AS est
            FROM wincred_produtos p
            LEFT JOIN (SELECT codigo, SUM(COALESCE(estoque,0)) AS total FROM wincred_estoque GROUP BY codigo) e
              ON e.codigo = p.codigo
           GROUP BY 1
        ) k ON k.ref = s.ref
       WHERE s.publicado = true AND COALESCE(k.est, 0) <= 0
       LIMIT 50
    `);

    const ultimoSync = await (this.prisma as any).siteSyncLog.findFirst({
      where: { tipo: 'conteudo' }, orderBy: { iniciadoEm: 'desc' },
    });

    return {
      erp: { refs: erpAgg?.refs ?? 0, skus: erpAgg?.skus ?? 0, refsSemEstoque: semEstoque?.[0]?.n ?? 0 },
      site: {
        publicadas,
        comImagem,
        semImagem: publicadas - comImagem,
        comFichaDeCaimento: comFicha,
        coberturaFicha: publicadas > 0 ? Math.round((comFicha / publicadas) * 100) : 0,
      },
      divergencias: {
        publicadasForaDoErp: { qtd: orfas.length, exemplos: orfas.slice(0, 20) },
        publicadasSemEstoque: { qtd: semGrade.length, exemplos: semGrade.slice(0, 20) },
      },
      ultimoSync: ultimoSync
        ? {
            em: ultimoSync.iniciadoEm, duracaoMs: ultimoSync.duracaoMs, lidos: ultimoSync.lidos,
            criados: ultimoSync.criados, atualizados: ultimoSync.atualizados,
            ignorados: ultimoSync.ignorados, falhas: ultimoSync.falhas, detalhes: ultimoSync.detalhes,
          }
        : null,
    };
  }
}
