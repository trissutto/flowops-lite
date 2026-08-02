import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CLASSIFICAÇÃO DA PEÇA — Ocasião, Tecido, Modelagem e Coleção.
 *
 * Os quatro eixos que o site usa pra montar vitrine além da categoria. Ficam
 * numa tabela só (`atributos_peca`) separada por `tipo`, mas cada um tem sua
 * tela em Cadastros. Ver o comentário do model no schema.
 *
 * O slug é gerado do nome e é a URL no site (/ocasioes/casamento). Uma vez
 * criado NÃO muda sozinho ao renomear: link publicado que quebra é link
 * perdido. Pra trocar de slug, tem que mandar explicitamente.
 */

export const TIPOS_ATRIBUTO = ['ocasiao', 'tecido', 'modelagem', 'colecao'] as const;
export type TipoAtributo = (typeof TIPOS_ATRIBUTO)[number];

export interface AtributoInput {
  nome?: string;
  slug?: string;
  descricao?: string | null;
  fotoUrl?: string | null;
  ativo?: boolean;
  ordem?: number;
}

/** Referência gravada em outra tabela (pedido de compra, ficha do produto). */
export interface AtributoRef {
  id: string;
  nome: string;
}

@Injectable()
export class AtributosPecaService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizaTipo(tipo: string): TipoAtributo {
    const t = String(tipo || '').toLowerCase().trim();
    if (!(TIPOS_ATRIBUTO as readonly string[]).includes(t)) {
      throw new BadRequestException(
        `tipo inválido: "${tipo}". Use um de: ${TIPOS_ATRIBUTO.join(', ')}`,
      );
    }
    return t as TipoAtributo;
  }

  /** "Festa de Casamento" → "festa-de-casamento". */
  private slugify(valor: string): string {
    const semAcento = Array.from(String(valor || '').normalize('NFD'))
      // O NFD separa "ç" em "c" + cedilha; aqui cai fora tudo que é marca de
      // acento (U+0300–U+036F). Filtro por code point em vez de regex com a
      // faixa literal: aquela faixa é invisível no fonte e não sobrevive a
      // ferramenta que reencoda o arquivo.
      .filter((c) => {
        const cp = c.codePointAt(0) ?? 0;
        return cp < 0x0300 || cp > 0x036f;
      })
      .join('');

    return semAcento
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  list(tipo: string, incluirInativos = false) {
    return this.prisma.atributoPeca.findMany({
      where: { tipo: this.normalizaTipo(tipo), ...(incluirInativos ? {} : { ativo: true }) },
      orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
    });
  }

  /** Todos os tipos de uma vez — é o que o pedido de compra precisa. */
  async listAll(incluirInativos = false) {
    const linhas = await this.prisma.atributoPeca.findMany({
      where: incluirInativos ? {} : { ativo: true },
      orderBy: [{ tipo: 'asc' }, { ordem: 'asc' }, { nome: 'asc' }],
    });
    const porTipo: Record<string, typeof linhas> = {};
    for (const t of TIPOS_ATRIBUTO) porTipo[t] = [];
    for (const linha of linhas) (porTipo[linha.tipo] ??= []).push(linha);
    return porTipo;
  }

  async create(tipo: string, dados: AtributoInput) {
    const tipoOk = this.normalizaTipo(tipo);
    const nome = String(dados?.nome || '').trim();
    if (!nome) throw new BadRequestException('nome é obrigatório');

    const slug = this.slugify(dados?.slug || nome);
    if (!slug) throw new BadRequestException('não consegui gerar um slug a partir do nome');

    const jaExiste = await this.prisma.atributoPeca.findUnique({
      where: { tipo_slug: { tipo: tipoOk, slug } },
    });
    if (jaExiste) {
      throw new BadRequestException(`já existe "${jaExiste.nome}" com o endereço /${slug}`);
    }

    return this.prisma.atributoPeca.create({
      data: {
        tipo: tipoOk,
        nome,
        slug,
        descricao: dados?.descricao?.trim() || null,
        fotoUrl: dados?.fotoUrl?.trim() || null,
        ativo: dados?.ativo ?? true,
        ordem: Number.isFinite(dados?.ordem) ? Number(dados!.ordem) : 0,
      },
    });
  }

  async update(id: string, dados: AtributoInput) {
    const atual = await this.prisma.atributoPeca.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('atributo não encontrado');

    const patch: Record<string, unknown> = {};
    if (dados.nome !== undefined) {
      const nome = String(dados.nome).trim();
      if (!nome) throw new BadRequestException('nome não pode ficar vazio');
      patch.nome = nome;
    }
    // Slug só muda quando mandado de propósito — renomear não deve quebrar a
    // URL que já está publicada e indexada.
    if (dados.slug !== undefined) {
      const slug = this.slugify(dados.slug);
      if (!slug) throw new BadRequestException('slug inválido');
      if (slug !== atual.slug) {
        const conflito = await this.prisma.atributoPeca.findUnique({
          where: { tipo_slug: { tipo: atual.tipo, slug } },
        });
        if (conflito) throw new BadRequestException(`o endereço /${slug} já está em uso`);
      }
      patch.slug = slug;
    }
    if (dados.descricao !== undefined) patch.descricao = dados.descricao?.trim() || null;
    if (dados.fotoUrl !== undefined) patch.fotoUrl = dados.fotoUrl?.trim() || null;
    if (dados.ativo !== undefined) patch.ativo = Boolean(dados.ativo);
    if (dados.ordem !== undefined) patch.ordem = Number(dados.ordem) || 0;

    return this.prisma.atributoPeca.update({ where: { id }, data: patch });
  }

  /**
   * Desativa em vez de apagar. Peça já classificada guarda o nome junto do id,
   * então o histórico não quebra — mas apagar de verdade deixaria o cadastro
   * inconsistente com pedidos antigos sem ganho nenhum.
   */
  async remove(id: string) {
    const atual = await this.prisma.atributoPeca.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('atributo não encontrado');
    return this.prisma.atributoPeca.update({ where: { id }, data: { ativo: false } });
  }

  /**
   * Valida ids que chegam de fora e devolve {id, nome} pra gravar
   * denormalizado. Como a tabela é uma só, sem esta checagem nada impede um id
   * de coleção cair no campo de tecido.
   *
   * Id desconhecido é IGNORADO em silêncio de propósito: o pedido de compra não
   * pode falhar por causa de um atributo que alguém apagou no meio do caminho.
   */
  async resolveRefs(tipo: string, ids: string[] | undefined | null): Promise<AtributoRef[]> {
    const tipoOk = this.normalizaTipo(tipo);
    const limpos = (ids ?? []).map((i) => String(i || '').trim()).filter(Boolean);
    if (!limpos.length) return [];

    const achados = await this.prisma.atributoPeca.findMany({
      where: { id: { in: limpos }, tipo: tipoOk },
      select: { id: true, nome: true },
    });
    // Devolve na ordem em que vieram, não na do banco.
    const porId = new Map(achados.map((a) => [a.id, a.nome]));
    return limpos.filter((id) => porId.has(id)).map((id) => ({ id, nome: porId.get(id)! }));
  }

  /** Versão de um id só (tecido, coleção). */
  async resolveRef(tipo: string, id: string | undefined | null): Promise<AtributoRef | null> {
    const [primeiro] = await this.resolveRefs(tipo, id ? [id] : []);
    return primeiro ?? null;
  }
}
