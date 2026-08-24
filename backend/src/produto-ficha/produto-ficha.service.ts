import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AtributosPecaService } from '../atributos-peca/atributos-peca.service';
import { LojaCatalogService } from '../loja-catalog/loja-catalog.service';
import { avisarVitrine } from '../common/avisar-vitrine';
import { refBaseOf, refsDeBusca } from '../common/ref-base';

/**
 * FICHA DO PRODUTO — a camada que o Flow ACRESCENTA ao catálogo.
 *
 * Preço, estoque, grupo/subgrupo e EANs continuam vindo do catálogo; aqui mora
 * só o que o site precisa e não existe em lugar nenhum: foto, descrição de
 * venda, classificação, medidas, elasticidade e vídeo.
 *
 * Dois níveis, espelhando a cascata da tela master:
 *   REF+MARCA  → o que vale pra todas as cores (tecido, modelagem, descrição)
 *   +COR       → a página do site (título, vídeo, publicação, fotos)
 *
 * A chave é REF + MARCA e nunca REF sozinha: REF numérica é reciclada entre
 * fornecedores, e dois "222" de marcas diferentes são peças diferentes.
 */

export const ELASTICIDADES = ['nao', 'pouco', 'muito'] as const;
export type Elasticidade = (typeof ELASTICIDADES)[number];

/** Ordem de exibição do status; 'sem_fotos' é calculado, nunca gravado. */
export const STATUS_PUBLICACAO = [
  'publicado', 'pronto', 'sem_fotos', 'nao_publicar',
] as const;

export interface FichaInput {
  nomeCurto?: string | null;
  descricao?: string | null;
  /**
   * O texto CURTO da PDP e a descrição que o feed do Meta manda pro anúncio.
   * Era só da IA (que nunca sobrescreve gente) — mas gente não tinha COMO
   * escrever: o pedido do dono de 13/08 ("nas descrições da BMM-100…")
   * esbarrou em campo sem porta. Mesmo teto de 400 caracteres da IA.
   */
  resumo?: string | null;
  tecidoId?: string | null;
  colecaoId?: string | null;
  ocasiaoIds?: string[];
  modelagemIds?: string[];
  gradeMedidasId?: string | null;
  medidasAjuste?: unknown;
  elasticidade?: string | null;
}

export interface FichaCorInput {
  tituloComercial?: string | null;
  youtubeUrl?: string | null;
  statusPublicacao?: string;
  /** Bolinha do seletor de cor: 'cor' (hex) ou 'foto' (recorte da estampa). */
  swatchTipo?: string;
  corHex?: string | null;
  swatchFocoX?: number | null;
  swatchFocoY?: number | null;
}

export const SWATCH_TIPOS = ['cor', 'foto'] as const;
const HEX_RGB = /^#[0-9A-Fa-f]{6}$/;

/** Um buraco da ficha, do jeito que a tela mostra. */
export interface FaltaDaFicha {
  campo: string;
  rotulo: string;
  /** `true` = o site fica visivelmente pior sem isto. */
  critico: boolean;
}

@Injectable()
export class ProdutoFichaService {
  private readonly logger = new Logger(ProdutoFichaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly atributos: AtributosPecaService,
    private readonly catalogo: LojaCatalogService,
  ) {}

  /**
   * O SITE PRECISA SABER NA HORA (19/08/2026).
   *
   * A tela master é a porta pela qual a peça entra e sai do site, e nada aqui
   * avisava ninguém: o catálogo do backend tem cache de 60s e a borda do site
   * revalida sozinha em 60-300s. Quem marcava "fora do site", salvava e
   * conferia no mesmo minuto via a peça no ar e concluía que não tinha
   * salvado — foi exatamente o relato do dono em 19/08 (a 701501 saiu, mas só
   * depois). Mesma cura da tela de cores (`coresSemFotoRecarregar`): derruba o
   * cache do backend e avisa a vitrine.
   *
   * O aviso pra vitrine é uma chamada de rede, então só sai quando a
   * PUBLICAÇÃO muda — que é o que a cliente vê. Título e bolinha derrubam só o
   * cache daqui e chegam no site na revalidação normal; sem isso, arrastar o
   * conta-gotas (que salva sozinho, com debounce) viraria uma rajada de
   * revalidações no site inteiro.
   */
  private aposEditar(mudouPublicacao: boolean) {
    this.catalogo.invalidarCache();
    if (mudouPublicacao) {
      avisarVitrine(['catalogo', 'categorias', 'filtros', 'vitrine'], this.logger, 'produto-ficha');
    }
  }

  /**
   * FILA DE TRABALHO DA FICHA (item 24 de docs/MELHORIAS-SITE.md).
   *
   * O problema: o site inteiro depende da ficha (título, descrição, tecido,
   * ocasião, modelagem, medidas, bolinha) e o catálogo tem milhares de REFs.
   * Medido em 06/08 na produção: das **525 peças publicadas, ZERO tinham
   * modelagem preenchida** — o filtro "Modelagem" nem aparecia na vitrine por
   * falta de dado, não por falta de código.
   *
   * Preencher "o catálogo" é tarefa que ninguém começa. Preencher "estas 20,
   * que venderam 340 peças no trimestre e estão sem descrição" é tarefa que
   * acaba. A fila existe pra transformar uma na outra.
   *
   * A ORDEM é por VENDA, não por data de cadastro: a peça que sai é a que a
   * cliente procura no site, e ficha vazia numa peça que ninguém procura não
   * custa venda nenhuma. Peça sem foto fica no fim de propósito — sem foto ela
   * nem entra na vitrine, então a ficha dela não muda nada hoje.
   *
   * ⚠️ A venda é somada por REF, não por REF+MARCA: `pdv_sale_items` não
   * guarda marca. Quando a mesma REF foi reciclada entre dois fornecedores, as
   * duas fichas herdam o total das duas. Isso ordena um pouco pra cima uma das
   * peças — aceitável numa fila de prioridade, e o motivo de o número aparecer
   * na tela como "unidades no período", não como relatório de vendas.
   */
  async fila(
    params: { de?: string; ate?: string; limite?: number; incluirCompletas?: boolean } = {},
  ) {
    const limite = Math.min(Math.max(Number(params.limite) || 50, 1), 300);

    // Recorte de tempo em De/Até (convenção da casa) — não em "últimos N dias".
    // Padrão: os últimos 90 dias, que é uma estação de venda inteira.
    const hoje = new Date();
    const ate = params.ate ? new Date(`${params.ate}T23:59:59.999`) : hoje;
    const de = params.de
      ? new Date(`${params.de}T00:00:00.000`)
      : new Date(ate.getTime() - 90 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime())) {
      throw new BadRequestException('Datas inválidas');
    }
    if (de > ate) throw new BadRequestException('A data inicial é depois da final');
    const desde = de;

    /* 1) O universo é o que ESTÁ NO SITE — publicado. */
    const publicadas: Array<{ ref: string }> = await (this.prisma as any).siteProduto.findMany({
      where: { publicado: true },
      select: { ref: true },
    });
    const refs = publicadas.map((p) => String(p.ref).trim().toUpperCase());
    const periodo = { de: de.toISOString(), ate: ate.toISOString() };
    if (!refs.length) {
      return {
        periodo, total: 0, comPendencia: 0, completas: 0,
        semMarca: 0, naoMostradas: 0, itens: [],
      };
    }

    /* 2) REF+MARCA reais do catálogo (a chave da ficha é o par). */
    const variacoes: Array<{
      ref: string; marca: string | null; cores: number; estoque: number; preco: number;
    }> = await this.prisma.$queryRawUnsafe(
      `SELECT UPPER(TRIM(p.ref))                        AS ref,
              NULLIF(TRIM(p.marca), '')                 AS marca,
              COUNT(DISTINCT NULLIF(TRIM(p.cor), ''))::int AS cores,
              COALESCE(SUM(e.total), 0)::int            AS estoque,
              COALESCE(MIN(NULLIF(p."vendaUn", 0)), 0)::float8 AS preco
         FROM wincred_produtos p
         LEFT JOIN (SELECT codigo, SUM(COALESCE(estoque, 0)) AS total
                      FROM wincred_estoque GROUP BY codigo) e ON e.codigo = p.codigo
        WHERE UPPER(TRIM(p.ref)) = ANY($1)
        GROUP BY 1, 2`,
      refs,
    );

    /**
     * 3) Venda do período, por REF (ver a ressalva de marca no cabeçalho).
     *
     * A definição de "venda válida" é a MESMA do motor de comissão
     * (`CommissionEngineService`): finalizada, fora do treino e sem MARCADO —
     * marcação é "provar em casa", não venda. Inventar um critério próprio
     * aqui faria esta tela ranquear por um número que não bate com o de
     * nenhuma outra, e aí ninguém confia em nenhum dos dois.
     */
    const vendas: Array<{ ref: string; unidades: number }> = await this.prisma.$queryRawUnsafe(
      `SELECT UPPER(TRIM(i.ref)) AS ref, COALESCE(SUM(i.qty), 0)::int AS unidades
         FROM pdv_sale_items i
         JOIN pdv_sales s ON s.id = i.sale_id
        WHERE i.ref IS NOT NULL
          AND UPPER(TRIM(i.ref)) = ANY($1)
          AND s.finalized_at >= $2
          AND s.finalized_at <= $3
          AND s.status = 'finalized'
          AND s.is_training = false
          AND (s.payment_method IS NULL OR s.payment_method <> 'MARCADO')
        GROUP BY 1`,
      refs,
      desde,
      ate,
    );
    const vendaPorRef = new Map(vendas.map((v) => [v.ref, v.unidades]));

    /* 4) Fichas e fotos que já existem. */
    const fichas: any[] = await (this.prisma as any).produtoFicha.findMany({
      where: { ref: { in: refs } },
      include: { cores: true },
    });
    const fichaPorChave = new Map(
      fichas.map((f) => [`${String(f.ref).toUpperCase()}|${String(f.marca).toUpperCase()}`, f]),
    );

    const fotos: Array<{ ref: string; cores: number }> = await this.prisma.$queryRawUnsafe(
      `SELECT UPPER(TRIM(ref)) AS ref, COUNT(DISTINCT COALESCE(NULLIF(TRIM(cor), ''), '—'))::int AS cores
         FROM product_photos WHERE UPPER(TRIM(ref)) = ANY($1) GROUP BY 1`,
      refs,
    );
    const fotoPorRef = new Map(fotos.map((f) => [f.ref, f.cores]));

    /* 5) O que falta em cada uma. */
    const preenchido = (v: unknown) => String(v ?? '').trim().length > 0;
    const listaCheia = (raw: unknown) => {
      if (!raw) return false;
      try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(arr) && arr.length > 0;
      } catch {
        return false;
      }
    };

    /**
     * Peça publicada SEM MARCA não tem ficha possível — a chave é REF+MARCA.
     * Ela sai da fila, mas o número vai junto na resposta: cap silencioso vira
     * peça esquecida pra sempre, porque ninguém procura o que a tela não conta.
     */
    const semMarca = variacoes.filter((v) => !v.marca).length;

    const itens = variacoes
      .filter((v) => v.marca)
      .map((v) => {
        const chave = `${v.ref}|${String(v.marca).toUpperCase()}`;
        const f = fichaPorChave.get(chave);
        const temFoto = (fotoPorRef.get(v.ref) ?? 0) > 0;

        const faltas: FaltaDaFicha[] = [];
        const exigir = (ok: boolean, campo: string, rotulo: string, critico: boolean) => {
          if (!ok) faltas.push({ campo, rotulo, critico });
        };

        // Críticos: sem eles a vitrine mostra a peça pior do que ela é.
        exigir(preenchido(f?.nomeCurto), 'nomeCurto', 'Nome curto', true);
        exigir(preenchido(f?.descricao), 'descricao', 'Descrição de venda', true);
        exigir(preenchido(f?.tecidoNome), 'tecido', 'Tecido', true);
        // A bolinha é por COR: basta uma cor com foto e sem bolinha pra faltar.
        const coresSemBolinha = ((f?.cores ?? []) as any[]).filter(
          (c) => c.swatchTipo === 'cor' && !preenchido(c.corHex),
        ).length;
        exigir(temFoto && coresSemBolinha === 0, 'bolinha', 'Bolinha de cor', true);

        // Importantes: alimentam filtro e recomendação, não a primeira olhada.
        exigir(listaCheia(f?.modelagens), 'modelagens', 'Modelagem', false);
        exigir(listaCheia(f?.ocasioes), 'ocasioes', 'Ocasião', false);
        exigir(preenchido(f?.gradeMedidasId), 'medidas', 'Tabela de medidas', false);
        exigir(preenchido(f?.elasticidade), 'elasticidade', 'Elasticidade', false);

        const total = 8;
        return {
          ref: v.ref,
          marca: v.marca,
          cores: v.cores,
          estoque: v.estoque,
          preco: v.preco,
          temFoto,
          temFicha: !!f,
          unidadesVendidas: vendaPorRef.get(v.ref) ?? 0,
          faltas,
          faltamCriticos: faltas.filter((x) => x.critico).length,
          completude: Math.round(((total - faltas.length) / total) * 100),
        };
      });

    const comPendencia = itens.filter((i) => i.faltas.length > 0);
    const candidatos = params.incluirCompletas ? itens : comPendencia;

    candidatos.sort((a, b) => {
      // 1º) sem foto vai pro fim: hoje ela nem aparece na vitrine.
      if (a.temFoto !== b.temFoto) return a.temFoto ? -1 : 1;
      // 2º) quem vendeu mais primeiro — é o que a cliente procura no site.
      if (b.unidadesVendidas !== a.unidadesVendidas) return b.unidadesVendidas - a.unidadesVendidas;
      // 3º) empate (inclusive tudo zerado): quem tem mais buraco crítico.
      if (b.faltamCriticos !== a.faltamCriticos) return b.faltamCriticos - a.faltamCriticos;
      return b.estoque - a.estoque;
    });

    return {
      periodo,
      /** Publicadas com marca conhecida — o denominador do progresso. */
      total: itens.length,
      comPendencia: comPendencia.length,
      completas: itens.length - comPendencia.length,
      semMarca,
      itens: candidatos.slice(0, limite),
      /** Quantas ficaram de fora do recorte — a fila nunca "acaba" calada. */
      naoMostradas: Math.max(0, candidatos.length - limite),
    };
  }

  /**
   * Chave da ficha = REF-BASE + MARCA.
   *
   * BASE, não a REF crua: no ERP a cor virou sufixo de REF ("VMS-223",
   * "VMS-223 MA", "VMS-223 MM", "VMS-223 P" são o MESMO vestido em quatro
   * cadastros). Com a REF crua, o mesmo produto ganhava quatro fichas de uma
   * cor cada — e no site viraria quatro produtos em vez de um com quatro
   * bolinhas, que é exatamente o contrário do que a tela existe pra fazer.
   *
   * MARCA continua na chave porque REF numérica se recicla entre fornecedores.
   */
  private chave(ref: string, marca: string) {
    const r = refBaseOf(ref);
    const m = String(marca || '').trim().toUpperCase();
    if (!r) throw new BadRequestException('REF obrigatória');
    if (!m) throw new BadRequestException('MARCA obrigatória — REF sozinha se repete entre fornecedores');
    return { ref: r, marca: m };
  }

  /**
   * MARCA VAZIA E "SEM MARCA" SÃO A MESMA PEÇA (19/08/2026).
   *
   * Peça sem marca no ERP recebe dois nomes de chave, dependendo de quem
   * grava primeiro: o importador de fotos escreve marca VAZIA
   * (`wc-fotos-import`) e a tela master escreve "SEM MARCA" (a tela mostra
   * `row.marca || 'SEM MARCA'` e manda isso de volta). Eram 62 REFs com ficha
   * de marca vazia na produção. Duas fichas pra mesma REF fazem a edição da
   * retaguarda cair numa linha e a vitrine ler a outra — foi assim que a
   * 350842/CHOCOLATE ficou marcada "fora do site" e seguiu à venda.
   *
   * Aqui a tela ADOTA a ficha que já existe em vez de criar a segunda. Só
   * vale pro par vazio/"SEM MARCA": marca de verdade continua separando peça
   * de fornecedores diferentes, que é pra isso que ela está na chave.
   */
  private async chaveDaFicha(refRaw: string, marcaRaw: string) {
    const { ref, marca } = this.chave(refRaw, marcaRaw);
    if (marca !== 'SEM MARCA') return { ref, marca };

    const fichas: Array<{ marca: string }> = await (this.prisma as any).produtoFicha.findMany({
      where: { ref, marca: { in: ['SEM MARCA', ''] } },
      select: { marca: true },
    });
    // A explícita ganha; a vazia só é adotada quando é a única que existe.
    if (fichas.some((f) => f.marca === 'SEM MARCA') || !fichas.length) return { ref, marca };
    return { ref, marca: '' };
  }

  private parseJson<T>(valor: string | null | undefined, padrao: T): T {
    if (!valor) return padrao;
    try { return JSON.parse(valor) as T; } catch { return padrao; }
  }

  /**
   * Status real da cor. 'sem_fotos' ganha de qualquer coisa que esteja gravada:
   * sem foto o site não tem o que mostrar, então não adianta estar "publicado".
   */
  private statusEfetivo(gravado: string, temFoto: boolean): string {
    if (!temFoto) return 'sem_fotos';
    return gravado === 'sem_fotos' ? 'nao_publicar' : gravado;
  }

  /** Ficha completa pra tela master. Não cria nada — REF sem ficha volta null. */
  async get(refRaw: string, marcaRaw: string) {
    const { ref, marca } = await this.chaveDaFicha(refRaw, marcaRaw);

    const ficha = await (this.prisma as any).produtoFicha.findUnique({
      where: { ref_marca: { ref, marca } },
      include: { cores: { orderBy: { cor: 'asc' } }, gradeMedidas: true },
    });

    /**
     * SEM FICHA AINDA, MAS COM FOTO: devolve uma ficha "casca".
     *
     * A ficha só nasce quando alguém salva algum campo. Só que as FOTOS não
     * dependem dela — vivem em `product_photos` por (ref, cor) e chegam antes,
     * pela importação do site antigo. Devolver `null` aqui fazia a tela
     * mostrar "0 fotos" logo depois de importar 17: elas existiam, mas o
     * caminho pra enxergá-las passava por uma linha que ninguém criou.
     */
    // Procura pela BASE e pela REF como veio: foto importada antes da
    // unificação está gravada sob a REF inteira ("VMS-223 MA"), e ignorá-la
    // faria a galeria "sumir" no dia da mudança.
    const refsFoto = refsDeBusca(refRaw);

    if (!ficha) {
      const fotosSoltas = await (this.prisma as any).productPhoto.findMany({
        where: { ref: { in: refsFoto } },
        orderBy: [{ cor: 'asc' }, { ordem: 'asc' }],
      });
      if (!fotosSoltas.length) return null;

      const porCor = new Map<string, any[]>();
      for (const f of fotosSoltas) {
        const k = (f.cor || '').toUpperCase();
        if (!k) continue;
        if (!porCor.has(k)) porCor.set(k, []);
        porCor.get(k)!.push(f);
      }
      return {
        ref, marca,
        nomeCurto: null, descricao: null,
        tecidoId: null, tecidoNome: null, colecaoId: null, colecaoNome: null,
        ocasioes: [], modelagens: [],
        gradeMedidasId: null, gradeMedidas: null, medidasAjuste: null,
        elasticidade: null,
        cores: Array.from(porCor.entries()).map(([cor, fotos]) => ({
          cor,
          tituloComercial: null,
          youtubeUrl: null,
          statusPublicacao: 'nao_publicar',
          swatchTipo: 'cor',
          corHex: null,
          swatchFocoX: null,
          swatchFocoY: null,
          fotos,
        })),
      };
    }

    // Uma query só pras fotos de todas as cores da REF.
    const fotos = await (this.prisma as any).productPhoto.findMany({
      where: { ref: { in: refsFoto } },
      orderBy: { ordem: 'asc' },
    });
    const fotosPorCor = new Map<string, any[]>();
    for (const f of fotos) {
      const k = (f.cor || '').toUpperCase();
      if (!fotosPorCor.has(k)) fotosPorCor.set(k, []);
      fotosPorCor.get(k)!.push(f);
    }

    return {
      ...ficha,
      ocasioes: this.parseJson(ficha.ocasioes, [] as { id: string; nome: string }[]),
      modelagens: this.parseJson(ficha.modelagens, [] as { id: string; nome: string }[]),
      medidasAjuste: this.parseJson(ficha.medidasAjuste, null),
      gradeMedidas: ficha.gradeMedidas
        ? { ...ficha.gradeMedidas, linhas: this.parseJson(ficha.gradeMedidas.linhas, []) }
        : null,
      /**
       * A lista de cores é a UNIÃO de duas origens:
       *   1. as cores que já têm linha em `produto_ficha_cor` (alguém salvou);
       *   2. as cores que têm FOTO em `product_photos`.
       *
       * A segunda é o caso da importação do site antigo: a foto chega antes de
       * qualquer campo ser salvo. Enquanto a lista vinha só da tabela da ficha,
       * a cor recém-importada ficava invisível — a foto existia, estava no
       * bucket, e a tela dizia "faltam fotos" até alguém editar algo naquela
       * cor e criar a linha. Foi exatamente o "só aparece depois que eu edito".
       */
      cores: (() => {
        const salvas = ficha.cores.map((c: any) => {
          const suasFotos = fotosPorCor.get(c.cor.toUpperCase()) ?? [];
          return {
            ...c,
            fotos: suasFotos,
            statusPublicacao: this.statusEfetivo(c.statusPublicacao, suasFotos.length > 0),
          };
        });
        const jaListadas = new Set(salvas.map((c: any) => String(c.cor).toUpperCase()));

        const soComFoto = Array.from(fotosPorCor.entries())
          .filter(([cor]) => cor && !jaListadas.has(cor))
          .map(([cor, suasFotos]) => ({
            cor,
            tituloComercial: null,
            youtubeUrl: null,
            statusPublicacao: this.statusEfetivo('nao_publicar', suasFotos.length > 0),
            swatchTipo: 'cor',
            corHex: null,
            swatchFocoX: null,
            swatchFocoY: null,
            fotos: suasFotos,
          }));

        return [...salvas, ...soComFoto].sort((a: any, b: any) =>
          String(a.cor).localeCompare(String(b.cor), 'pt-BR'),
        );
      })(),
    };
  }

  /** Cria ou atualiza o nível REF. Campo ausente = não mexeu. */
  async upsert(refRaw: string, marcaRaw: string, dados: FichaInput, usuario?: string) {
    const { ref, marca } = await this.chaveDaFicha(refRaw, marcaRaw);

    const patch: Record<string, unknown> = { atualizadoPor: usuario ?? null };
    if (dados.nomeCurto !== undefined) patch.nomeCurto = dados.nomeCurto?.trim() || null;
    if (dados.descricao !== undefined) patch.descricao = dados.descricao?.trim() || null;
    if (dados.resumo !== undefined) patch.resumo = dados.resumo?.trim().slice(0, 400) || null;

    if (dados.tecidoId !== undefined) {
      const t = await this.atributos.resolveRef('tecido', dados.tecidoId);
      patch.tecidoId = t?.id ?? null;
      patch.tecidoNome = t?.nome ?? null;
    }
    if (dados.colecaoId !== undefined) {
      const c = await this.atributos.resolveRef('colecao', dados.colecaoId);
      patch.colecaoId = c?.id ?? null;
      patch.colecaoNome = c?.nome ?? null;
    }
    if (dados.ocasiaoIds !== undefined) {
      const refs = await this.atributos.resolveRefs('ocasiao', dados.ocasiaoIds);
      patch.ocasioes = refs.length ? JSON.stringify(refs) : null;
    }
    if (dados.modelagemIds !== undefined) {
      const refs = await this.atributos.resolveRefs('modelagem', dados.modelagemIds);
      patch.modelagens = refs.length ? JSON.stringify(refs) : null;
    }

    if (dados.gradeMedidasId !== undefined) {
      const id = dados.gradeMedidasId?.trim() || null;
      if (id) {
        const existe = await (this.prisma as any).gradeMedidas.findUnique({ where: { id } });
        if (!existe) throw new BadRequestException('grade de medidas não encontrada');
      }
      patch.gradeMedidasId = id;
    }
    if (dados.medidasAjuste !== undefined) {
      patch.medidasAjuste = dados.medidasAjuste ? JSON.stringify(dados.medidasAjuste) : null;
    }
    if (dados.elasticidade !== undefined) {
      const e = dados.elasticidade?.trim() || null;
      if (e && !(ELASTICIDADES as readonly string[]).includes(e)) {
        throw new BadRequestException(`elasticidade inválida: use ${ELASTICIDADES.join(', ')}`);
      }
      patch.elasticidade = e;
    }

    await (this.prisma as any).produtoFicha.upsert({
      where: { ref_marca: { ref, marca } },
      create: { ref, marca, ...patch },
      update: patch,
    });
    // Tudo daqui (nome, descrição, tecido, medidas) aparece no card e na PDP.
    this.aposEditar(false);
    return this.get(ref, marca);
  }

  /**
   * Cria ou atualiza uma COR. A ficha REF nasce junto se ainda não existir —
   * quem edita a cor não deveria precisar criar a REF antes.
   */
  async upsertCor(
    refRaw: string, marcaRaw: string, corRaw: string, dados: FichaCorInput, usuario?: string,
  ) {
    const { ref, marca } = await this.chaveDaFicha(refRaw, marcaRaw);
    const cor = String(corRaw || '').trim().toUpperCase();
    if (!cor) throw new BadRequestException('COR obrigatória');

    const ficha = await (this.prisma as any).produtoFicha.upsert({
      where: { ref_marca: { ref, marca } },
      create: { ref, marca, atualizadoPor: usuario ?? null },
      update: {},
    });

    const patch: Record<string, unknown> = {};
    if (dados.tituloComercial !== undefined) {
      patch.tituloComercial = dados.tituloComercial?.trim() || null;
    }
    if (dados.youtubeUrl !== undefined) patch.youtubeUrl = dados.youtubeUrl?.trim() || null;
    if (dados.statusPublicacao !== undefined) {
      const s = String(dados.statusPublicacao);
      if (!(STATUS_PUBLICACAO as readonly string[]).includes(s)) {
        throw new BadRequestException('status de publicação inválido');
      }
      // 'sem_fotos' é conclusão do sistema, não escolha de quem edita.
      if (s === 'sem_fotos') {
        throw new BadRequestException(
          '"faltam fotos" é calculado pelo sistema — suba as fotos ou escolha outro status',
        );
      }
      patch.statusPublicacao = s;
    }

    if (dados.swatchTipo !== undefined) {
      const t = String(dados.swatchTipo);
      if (!(SWATCH_TIPOS as readonly string[]).includes(t)) {
        throw new BadRequestException(`tipo de bolinha inválido: use ${SWATCH_TIPOS.join(' ou ')}`);
      }
      patch.swatchTipo = t;
    }
    if (dados.corHex !== undefined) {
      const v = dados.corHex?.trim().toUpperCase() || null;
      if (v && !HEX_RGB.test(v)) {
        throw new BadRequestException('cor da bolinha inválida — esperado #RRGGBB');
      }
      patch.corHex = v;
    }
    // Foco do recorte: guardado em fração (0..1) e não em pixel, senão trocar a
    // foto por uma de outra resolução moveria o enquadramento sozinho.
    for (const eixo of ['swatchFocoX', 'swatchFocoY'] as const) {
      if (dados[eixo] === undefined) continue;
      const n = dados[eixo];
      patch[eixo] = n === null ? null : Math.min(1, Math.max(0, Number(n) || 0));
    }

    await (this.prisma as any).produtoFichaCor.upsert({
      where: { fichaId_cor: { fichaId: ficha.id, cor } },
      create: { fichaId: ficha.id, cor, ...patch },
      update: patch,
    });
    this.aposEditar(patch.statusPublicacao !== undefined);
    return this.get(ref, marca);
  }

  /* ───────────────────────────── Grades de medidas ───────────────────────── */

  listGrades(incluirInativas = false) {
    return (this.prisma as any).gradeMedidas.findMany({
      where: incluirInativas ? {} : { ativo: true },
      orderBy: { nome: 'asc' },
    }).then((linhas: any[]) =>
      linhas.map((g) => ({ ...g, linhas: this.parseJson(g.linhas, []) })),
    );
  }

  async createGrade(dados: { nome?: string; observacao?: string; linhas?: unknown }) {
    const nome = String(dados?.nome || '').trim();
    if (!nome) throw new BadRequestException('nome da grade é obrigatório');
    if (!Array.isArray(dados?.linhas) || dados.linhas.length === 0) {
      throw new BadRequestException('a grade precisa de ao menos uma linha de tamanho');
    }
    return (this.prisma as any).gradeMedidas.create({
      data: {
        nome,
        observacao: dados.observacao?.trim() || null,
        linhas: JSON.stringify(dados.linhas),
      },
    });
  }

  async updateGrade(
    id: string,
    dados: { nome?: string; observacao?: string | null; linhas?: unknown; ativo?: boolean },
  ) {
    const atual = await (this.prisma as any).gradeMedidas.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('grade não encontrada');

    const patch: Record<string, unknown> = {};
    if (dados.nome !== undefined) {
      const nome = String(dados.nome).trim();
      if (!nome) throw new BadRequestException('nome não pode ficar vazio');
      patch.nome = nome;
    }
    if (dados.observacao !== undefined) patch.observacao = dados.observacao?.trim() || null;
    if (dados.linhas !== undefined) {
      if (!Array.isArray(dados.linhas) || dados.linhas.length === 0) {
        throw new BadRequestException('a grade precisa de ao menos uma linha de tamanho');
      }
      patch.linhas = JSON.stringify(dados.linhas);
    }
    if (dados.ativo !== undefined) patch.ativo = Boolean(dados.ativo);

    return (this.prisma as any).gradeMedidas.update({ where: { id }, data: patch });
  }

  /* ────────────────────────── Reposição por tamanho ──────────────────────── */

  /**
   * MÍNIMO e IDEAL já configurados desta cor — as linhas 3 e 4 da matriz.
   *
   * Devolve SÓ o que está guardado. O que TENHO e o que VENDEU continuam
   * saindo de onde já saíam (espelho de estoque e relatório de vendas):
   * repetir os dois aqui criaria um SEGUNDO número de estoque na casa, e a
   * grade por loja logo acima, na MESMA tela, mostraria o outro.
   *
   * A chave passa pelo mesmo `chave()` da ficha (REF-base + MARCA), então a
   * matriz cai exatamente no grupo que a cascata da tela desenha.
   */
  async reposicao(refRaw: string, marcaRaw: string, corRaw: string) {
    const { ref, marca } = this.chave(refRaw, marcaRaw);
    const cor = String(corRaw || '').trim().toUpperCase();
    if (!cor) throw new BadRequestException('COR obrigatória');

    const linhas = await (this.prisma as any).produtoReposicao.findMany({
      where: { ref, marca, cor },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      ref,
      marca,
      cor,
      tamanhos: linhas.map((l: any) => ({
        tamanho: l.tamanho,
        minimoLoja: l.minimoLoja,
        idealLoja: l.idealLoja,
      })),
      // A linha mais recente responde "quem mexeu por último nesta grade".
      atualizadoPor: linhas[0]?.atualizadoPor ?? null,
      atualizadoEm: linhas[0]?.updatedAt ?? null,
    };
  }

  /**
   * Grava a grade INTEIRA de uma cor, e não célula a célula: quem configura
   * mexe em vários tamanhos de uma vez, e um POST por tecla encheria a fila
   * de estados intermediários que ninguém pediu.
   *
   * ⚠️ NULO ≠ ZERO, e a diferença decide o pedido de compra. Nulo é "ninguém
   * configurou ainda" — a linha some da tabela e o tamanho fica fora da conta.
   * Zero é "esta loja não carrega este tamanho" e fica GRAVADO; sem essa
   * distinção, o tamanho que a compradora decidiu não repor voltaria pro
   * pedido toda vez que alguém abrisse a tela.
   */
  async salvarReposicao(
    refRaw: string,
    marcaRaw: string,
    corRaw: string,
    tamanhos: Array<{ tamanho?: string; minimoLoja?: number | null; idealLoja?: number | null }>,
    quem: string,
  ) {
    const { ref, marca } = this.chave(refRaw, marcaRaw);
    const cor = String(corRaw || '').trim().toUpperCase();
    if (!cor) throw new BadRequestException('COR obrigatória');
    if (!Array.isArray(tamanhos)) throw new BadRequestException('tamanhos precisa ser uma lista');

    /** Teto de 999: acima disso é dedo escorregado, não decisão de compra. */
    const quantia = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n)) return null;
      return Math.min(999, Math.max(0, n));
    };

    /**
     * Valida TUDO antes de gravar QUALQUER coisa. Estourar no meio do laço
     * deixaria metade da grade salva e metade não, sem a pessoa ter como
     * saber onde parou — e o pedido sairia de uma grade pela metade.
     */
    const planos: Array<{ tamanho: string; minimoLoja: number | null; idealLoja: number | null }> = [];
    for (const t of tamanhos) {
      const tamanho = String(t?.tamanho || '').trim().toUpperCase();
      if (!tamanho) continue;
      const minimoLoja = quantia(t?.minimoLoja);
      const idealLoja = quantia(t?.idealLoja);
      // Ideal abaixo do mínimo inverte a banda: o "comprar" miraria num
      // patamar mais baixo do que o que não pode faltar na arara.
      if (minimoLoja !== null && idealLoja !== null && idealLoja < minimoLoja) {
        throw new BadRequestException(
          `Tamanho ${tamanho}: o ideal (${idealLoja}) não pode ser menor que o mínimo (${minimoLoja}).`,
        );
      }
      planos.push({ tamanho, minimoLoja, idealLoja });
    }

    for (const p of planos) {
      if (p.minimoLoja === null && p.idealLoja === null) {
        await (this.prisma as any).produtoReposicao.deleteMany({
          where: { ref, marca, cor, tamanho: p.tamanho },
        });
        continue;
      }
      await (this.prisma as any).produtoReposicao.upsert({
        where: { ref_marca_cor_tamanho: { ref, marca, cor, tamanho: p.tamanho } },
        create: {
          ref, marca, cor, tamanho: p.tamanho,
          minimoLoja: p.minimoLoja, idealLoja: p.idealLoja, atualizadoPor: quem,
        },
        update: { minimoLoja: p.minimoLoja, idealLoja: p.idealLoja, atualizadoPor: quem },
      });
    }

    return this.reposicao(ref, marca, cor);
  }
}
