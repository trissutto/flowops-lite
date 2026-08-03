import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AtributosPecaService } from '../atributos-peca/atributos-peca.service';

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

@Injectable()
export class ProdutoFichaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly atributos: AtributosPecaService,
  ) {}

  private chave(ref: string, marca: string) {
    const r = String(ref || '').trim().toUpperCase();
    const m = String(marca || '').trim().toUpperCase();
    if (!r) throw new BadRequestException('REF obrigatória');
    if (!m) throw new BadRequestException('MARCA obrigatória — REF sozinha se repete entre fornecedores');
    return { ref: r, marca: m };
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
    const { ref, marca } = this.chave(refRaw, marcaRaw);

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
    if (!ficha) {
      const fotosSoltas = await (this.prisma as any).productPhoto.findMany({
        where: { ref },
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
      where: { ref },
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
    const { ref, marca } = this.chave(refRaw, marcaRaw);

    const patch: Record<string, unknown> = { atualizadoPor: usuario ?? null };
    if (dados.nomeCurto !== undefined) patch.nomeCurto = dados.nomeCurto?.trim() || null;
    if (dados.descricao !== undefined) patch.descricao = dados.descricao?.trim() || null;

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
    return this.get(ref, marca);
  }

  /**
   * Cria ou atualiza uma COR. A ficha REF nasce junto se ainda não existir —
   * quem edita a cor não deveria precisar criar a REF antes.
   */
  async upsertCor(
    refRaw: string, marcaRaw: string, corRaw: string, dados: FichaCorInput, usuario?: string,
  ) {
    const { ref, marca } = this.chave(refRaw, marcaRaw);
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
}
