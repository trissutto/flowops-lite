import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ProductSearchService — rotina ÚNICA de resolução de produto por termo.
 * (Diretriz do dono, 10/07: nenhuma tela inventa busca própria; todas
 * reutilizam o mecanismo que comprovadamente funciona.)
 *
 * É a cascata da busca da LIVE (extraída de LivePdvService.resolveRowsWithMirror
 * sem mudança de comportamento), rodando 100% no espelho Postgres
 * `giga_produto` (catálogo INTEIRO da tabela `produtos`, sem filtro plus-size).
 * Não toca o Giga ao vivo — imune a pendurada do MySQL/KingHost.
 *
 * Identidade de campos (nunca misturar):
 *   1) termo = CÓDIGO exato          → variante bipada (código interno/EAN)
 *   2) termo = REFERÊNCIA exata/prefixo (maiúscula padrão Giga + como digitado)
 *   3) fallback: REF insensitive OU DESCRICAOCOMPLETA contém o termo inteiro —
 *      cobre "2319 KASUAL" porque a descrição da Giga embute REF+MARCA+COR+TAM.
 */
@Injectable()
export class ProductSearchService {
  private readonly logger = new Logger(ProductSearchService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveRows(
    q: string,
    opts?: { fallbackTake?: number },
  ): Promise<Array<{ codigo: string; ref: string; descricao: string; cor: string; tamanho: string }>> {
    const term = String(q || '').trim();
    if (!term) return [];
    const find = (where: any, take = 1000) =>
      (this.prisma as any).gigaProduto.findMany({ where, take }).catch(() => []);

    // 1) Código exato (índice) — cobre bipar código/EAN.
    let rows = await find({ codigo: term });
    if (rows.length) return rows;

    // 2) REF pelo índice: exato/prefixo em MAIÚSCULA (padrão Giga) e como digitado.
    const up = term.toUpperCase();
    rows = await find({
      OR: [{ ref: up }, { ref: term }, { ref: { startsWith: up } }, { ref: { startsWith: term } }],
    });
    if (rows.length) return rows;

    // 3) Fallback (raro) — ref/nome case-insensitive (varredura). Só quando 1 e 2
    //    não acharam: busca por nome/descrição ou ref gravada em minúscula.
    if (term.length >= 2) {
      rows = await find(
        {
          OR: [
            { ref: { startsWith: term, mode: 'insensitive' } },
            { descricao: { contains: term, mode: 'insensitive' } },
          ],
        },
        opts?.fallbackTake ?? 300,
      );
    }
    return rows;
  }
}
