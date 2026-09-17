import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { lojaNorm, skuNorm } from '../common/estoque-entregavel';
import { CoberturaRetirada, coberturaDaLoja, normalizaCodigo } from '../common/retirada-prazo';

/**
 * A LOJA DE RETIRADA TEM A SACOLA INTEIRA? — o saldo ENTREGÁVEL por loja.
 *
 * É a régua de `common/estoque-entregavel.ts` recortada POR LOJA: o espelho
 * `wincred_estoque` menos a peça que aquela loja já disse que não achou
 * (`pecas_extraviadas` aberta, por loja+SKU). Loja-canal e loja inativa não
 * entram aqui porque a cliente escolheu uma loja de verdade na lista do
 * site; se um dia a lista oferecer a 13/SITE, o saldo dela conta — e o
 * roteamento, que passa longe dela, vai contar a verdade depois.
 *
 * Reserva de OUTRA cliente (peça vendida e ainda na arara) fica de fora, de
 * propósito: a promessa de 3h já vem com "depois que a loja confirma" — a
 * loja é quem vê a arara. Descontar a reserva aqui mandaria pra "4 dias" uma
 * peça que está a um bipe de sair.
 */
@Injectable()
export class RetiradaCoberturaService {
  private readonly logger = new Logger(RetiradaCoberturaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Saldo entregável de cada (loja, código). Lojas e códigos normalizados
   * (`LJ01`/`01`/`001` são a mesma loja; código sem zeros à esquerda).
   */
  async saldoPorLoja(
    codigos: string[],
    storeCodes: string[],
  ): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>();
    const cods = Array.from(new Set(codigos.map(normalizaCodigo).filter(Boolean)));
    const lojas = Array.from(new Set(storeCodes.map((c) => normalizaLoja(c)).filter(Boolean)));
    if (!cods.length || !lojas.length) return out;

    const sql = `
      SELECT z.loja, z.sku,
             SUM(z.estoque - LEAST(COALESCE(x.qtd, 0), GREATEST(z.estoque, 0)))::int AS saldo
        FROM (
               SELECT COALESCE(e.estoque, 0) AS estoque,
                      ${lojaNorm('e.loja')}  AS loja,
                      ${skuNorm('e.codigo')} AS sku
                 FROM wincred_estoque e
                WHERE ${skuNorm('e.codigo')} = ANY($1)
                  AND COALESCE(e.estoque, 0) <> 0
             ) z
        LEFT JOIN (
               SELECT ${lojaNorm('store_code')} AS loja,
                      ${skuNorm('sku')}         AS sku,
                      SUM(COALESCE(qty, 1))::int AS qtd
                 FROM pecas_extraviadas
                WHERE achada_em IS NULL
                GROUP BY 1, 2
             ) x ON x.loja = z.loja AND x.sku = z.sku
       WHERE z.loja = ANY($2)
       GROUP BY z.loja, z.sku`;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ loja: string; sku: string; saldo: number }>>(
      sql,
      cods,
      lojas,
    );
    for (const r of rows) {
      const loja = String(r.loja);
      if (!out.has(loja)) out.set(loja, new Map());
      out.get(loja)!.set(String(r.sku), Number(r.saldo) || 0);
    }
    return out;
  }

  /**
   * Cobertura de cada loja pra sacola dada. Falha do espelho vira
   * `desconhecida` em todas (com log) — nunca "loja": a regra de ouro é não
   * prometer o que não se conferiu.
   */
  async coberturaPorLoja(
    pedido: Array<{ codigo: string | null; qtd: number }>,
    storeCodes: string[],
  ): Promise<Map<string, CoberturaRetirada>> {
    const out = new Map<string, CoberturaRetirada>();
    const lojas = Array.from(new Set(storeCodes.filter(Boolean)));
    if (!lojas.length) return out;
    const codigos = pedido.map((p) => p.codigo).filter((c): c is string => !!c);
    let saldo: Map<string, Map<string, number>>;
    try {
      saldo = codigos.length ? await this.saldoPorLoja(codigos, lojas) : new Map();
    } catch (e: any) {
      this.logger.warn(`[retirada] espelho de estoque indisponível — cobertura desconhecida: ${e?.message || e}`);
      for (const l of lojas) out.set(l, 'desconhecida');
      return out;
    }
    for (const l of lojas) {
      out.set(l, coberturaDaLoja(pedido, saldo.get(normalizaLoja(l)) ?? new Map()));
    }
    return out;
  }
}

/** A mesma régua do `lojaNorm` do SQL, em TS: `LJ01`, `01`, `001` → `1`. */
function normalizaLoja(v: unknown): string {
  return String(v ?? '').trim().toUpperCase().replace(/^(LJ)?0*/, '');
}
