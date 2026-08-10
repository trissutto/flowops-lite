import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * MESMA PEÇA EM REFs DIFERENTES — juntando o que o catálogo legado separou.
 *
 * ── O PROBLEMA ──
 *
 * No site antigo, cor virava REF NOVA: `900887` era o macaquinho preto e
 * `900887B` o mesmo macaquinho bege. Dois cadastros, duas fotos, dois cards
 * lado a lado na vitrine — e a cliente escolhendo entre o que parece ser o
 * mesmo produto repetido. A REF nova (gerada pela `EanSequence`) já nasce com
 * a cor resolvida dentro da peça; isto aqui é dívida do que ficou pra trás.
 *
 * ── A REGRA ──
 *
 * A RAIZ é a parte numérica da frente: `900887B` → `900887`, `207275P` →
 * `207275`. Ela separa produto de produto — `900889` (macacão longo) tem raiz
 * diferente de `900887` (macaquinho), e por isso não se misturam.
 *
 * Mas raiz igual NÃO BASTA pra juntar. Duas travas, porque agrupar errado é
 * pior que não agrupar: junta duas peças diferentes num card só, e a cliente
 * compra a errada.
 *
 *   1. **Mesma categoria.** Macaquinho não junta com vestido, nem que a raiz
 *      bata por acaso.
 *   2. **Preço parecido** (até 15% de diferença). Mesma peça em outra cor
 *      custa o mesmo; diferença grande é sinal de que são peças distintas.
 *
 * O que não passa nas travas fica SEPARADO e é registrado — a tela de revisão
 * mostra pra decidir na mão.
 *
 * ── QUEM MANDA ──
 *
 * Grupo marcado à mão (`grupoRefManual`) o sync NUNCA toca. Sem isso, a
 * correção de quem revisou seria desfeita na madrugada seguinte.
 */
@Injectable()
export class GrupoRefService {
  private readonly logger = new Logger(GrupoRefService.name);

  /** Diferença de preço tolerada dentro de um grupo. */
  private static readonly TOLERANCIA_PRECO = 0.15;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A raiz de uma REF: os dígitos da frente.
   *
   * `900887B` → `900887` · `207275P` → `207275` · `900887-BR` → `900887`
   *
   * REF que não começa com dígito (ou é só letra) devolve `null` — sem raiz
   * numérica não há como afirmar parentesco, e chutar aqui juntaria peças que
   * não têm nada a ver.
   */
  static raiz(ref: string): string | null {
    const m = String(ref || '').trim().match(/^(\d{3,})/);
    return m ? m[1] : null;
  }

  /**
   * Recalcula os grupos a partir do catálogo publicado.
   *
   * Roda depois do sync de conteúdo (a REF pode nascer a qualquer momento) e
   * pelo botão da retaguarda.
   */
  async recalcular(): Promise<{
    gruposCriados: number;
    pecasAgrupadas: number;
    recusados: Array<{ raiz: string; refs: string[]; motivo: string }>;
  }> {
    const pecas: Array<{
      ref: string;
      categoria: string | null;
      grupoRef: string | null;
      grupoRefManual: boolean;
    }> = await (this.prisma as any).siteProduto.findMany({
      where: { publicado: true },
      select: { ref: true, categoria: true, grupoRef: true, grupoRefManual: true },
    });

    // Preço vem do espelho do ERP, não do cadastro — é lá que ele vive.
    const precos = await this.precosPorRef(pecas.map((p) => p.ref));

    const porRaiz = new Map<string, typeof pecas>();
    for (const p of pecas) {
      const r = GrupoRefService.raiz(p.ref);
      if (!r) continue;
      if (!porRaiz.has(r)) porRaiz.set(r, []);
      porRaiz.get(r)!.push(p);
    }

    const recusados: Array<{ raiz: string; refs: string[]; motivo: string }> = [];
    let gruposCriados = 0;
    let pecasAgrupadas = 0;

    for (const [raiz, doGrupo] of porRaiz) {
      // Raiz com uma peça só não é grupo — é o caso normal.
      if (doGrupo.length < 2) continue;
      // Alguém já decidiu na mão: não mexe em nenhuma peça desta raiz.
      if (doGrupo.some((p) => p.grupoRefManual)) continue;

      const categorias = new Set(doGrupo.map((p) => p.categoria ?? '—'));
      if (categorias.size > 1) {
        recusados.push({
          raiz,
          refs: doGrupo.map((p) => p.ref),
          motivo: `categorias diferentes (${[...categorias].join(', ')})`,
        });
        continue;
      }

      const comPreco = doGrupo.map((p) => precos.get(p.ref) ?? 0).filter((v) => v > 0);
      if (comPreco.length >= 2) {
        const min = Math.min(...comPreco);
        const max = Math.max(...comPreco);
        if (min > 0 && (max - min) / min > GrupoRefService.TOLERANCIA_PRECO) {
          recusados.push({
            raiz,
            refs: doGrupo.map((p) => p.ref),
            motivo: `preços distantes (R$ ${min.toFixed(2)} a R$ ${max.toFixed(2)})`,
          });
          continue;
        }
      }

      const alvo = doGrupo.filter((p) => p.grupoRef !== raiz).map((p) => p.ref);
      if (alvo.length) {
        await (this.prisma as any).siteProduto.updateMany({
          where: { ref: { in: alvo } },
          data: { grupoRef: raiz },
        });
      }
      gruposCriados += 1;
      pecasAgrupadas += doGrupo.length;
    }

    if (recusados.length) {
      this.logger.warn(
        `[grupo-ref] ${recusados.length} raiz(es) NÃO agrupadas — conferir em /retaguarda/produtos-agrupados`,
      );
    }
    this.logger.log(
      `[grupo-ref] ${gruposCriados} grupos · ${pecasAgrupadas} peças · ${recusados.length} recusados`,
    );
    return { gruposCriados, pecasAgrupadas, recusados };
  }

  /** Menor preço de venda por REF, do espelho do ERP. */
  private async precosPorRef(refs: string[]): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    if (!refs.length) return m;
    try {
      const linhas: Array<{ ref: string; preco: number }> =
        await this.prisma.$queryRawUnsafe(
          `SELECT UPPER(TRIM(p.ref)) AS ref, MIN(COALESCE(p."vendaUn", 0))::float8 AS preco
             FROM wincred_produtos p
            WHERE UPPER(TRIM(p.ref)) = ANY($1)
            GROUP BY UPPER(TRIM(p.ref))`,
          refs.map((r) => r.trim().toUpperCase()),
        );
      for (const l of linhas) m.set(String(l.ref), Number(l.preco) || 0);
    } catch (e: any) {
      // Sem preço a trava de preço não roda; a de categoria continua valendo.
      this.logger.warn(`[grupo-ref] preços indisponíveis: ${e?.message || e}`);
    }
    return m;
  }

  /** O que a tela de revisão mostra: os grupos formados, peça a peça. */
  async listar() {
    const pecas: any[] = await (this.prisma as any).siteProduto.findMany({
      where: { publicado: true, grupoRef: { not: null } },
      select: { ref: true, nome: true, categoria: true, grupoRef: true, grupoRefManual: true },
      orderBy: [{ grupoRef: 'asc' }, { ref: 'asc' }],
    });
    const grupos = new Map<string, any[]>();
    for (const p of pecas) {
      if (!grupos.has(p.grupoRef)) grupos.set(p.grupoRef, []);
      grupos.get(p.grupoRef)!.push(p);
    }
    return [...grupos.entries()].map(([raiz, itens]) => ({
      raiz,
      manual: itens.some((i) => i.grupoRefManual),
      itens,
    }));
  }

  /**
   * Separa uma peça do grupo (ou põe nele), travando a decisão contra o sync.
   * `grupo = null` desagrupa.
   */
  async definir(ref: string, grupo: string | null) {
    await (this.prisma as any).siteProduto.update({
      where: { ref: String(ref).trim().toUpperCase() },
      data: { grupoRef: grupo ? String(grupo).trim().toUpperCase() : null, grupoRefManual: true },
    });
    return { ok: true };
  }
}
