import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
 *   3) FULL-TEXT na descrição (pg_trgm): todas as palavras do termo, em
 *      qualquer ordem, aceitando pedaço de palavra — cobre "2319 KASUAL" e
 *      "KASUAL 2319" porque a descrição da Giga embute REF+MARCA+COR+TAM.
 */
@Injectable()
export class ProductSearchService implements OnModuleInit {
  private readonly logger = new Logger(ProductSearchService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * FULL-TEXT NO POSTGRES (decisão do dono, 10/07): entre os motores de busca
   * (Elasticsearch/Meilisearch/Typesense/PG), escolhemos o do PRÓPRIO Postgres —
   * zero infra nova, zero sync extra (roda em cima do espelho giga_produto que
   * já existe). Extensão pg_trgm + índice GIN trigram na DESCRICAO tornam o
   * ILIKE %palavra% indexado (rápido mesmo com 350k+ linhas) e permitem busca
   * por PEDAÇO de palavra ("KASU" acha KASUAL) em QUALQUER ordem.
   * DDL idempotente (IF NOT EXISTS), roda em background pra não travar o boot;
   * se falhar (ex.: sem permissão pra extensão), a busca continua funcionando —
   * só sem o índice (seq scan, mais lenta).
   */
  onModuleInit() {
    void (async () => {
      try {
        await this.prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
        await this.prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS giga_produto_descricao_trgm_idx
             ON giga_produto USING gin (descricao gin_trgm_ops)`,
        );
        this.logger.log('[fulltext] pg_trgm + índice trigram em giga_produto.descricao OK');
      } catch (e) {
        this.logger.warn(`[fulltext] setup pg_trgm falhou (busca segue sem índice): ${(e as Error).message}`);
      }
    })();
  }

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

    // 3) FULL-TEXT na DESCRIÇÃO (10/07) — estilo motor de busca, via pg_trgm:
    //    TODAS as palavras do termo têm que aparecer na DESCRICAOCOMPLETA, em
    //    QUALQUER ordem, aceitando pedaço de palavra ("2319 KASU" e
    //    "KASUAL 2319" acham "BLUSÃO ... 2319 KASUAL VINHO 46"). Antes exigia
    //    o termo inteiro contíguo — fora de ordem não achava. O índice GIN
    //    trigram (onModuleInit) mantém isso rápido. + ref insensitive.
    if (term.length >= 2) {
      const words = term.split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2).slice(0, 6);
      rows = await find(
        {
          OR: [
            { ref: { startsWith: term, mode: 'insensitive' } },
            ...(words.length
              ? [{ AND: words.map((w) => ({ descricao: { contains: w, mode: 'insensitive' as const } })) }]
              : [{ descricao: { contains: term, mode: 'insensitive' as const } }]),
          ],
        },
        opts?.fallbackTake ?? 300,
      );
    }
    return rows;
  }

  // Stopwords da extração de FAMÍLIA — cópia do ErpService.groupRowsByFamily /
  // WincredCatalogService (mesma heurística usada na consulta/realinhamento).
  private static readonly FAMILIA_STOPWORDS = new Set([
    'plus', 'size', 'feminina', 'feminino', 'masculino', 'masculina',
    'infantil', 'unissex', 'adulto', 'manga', 'curta', 'longa', 'comum',
    'basica', 'basico', 'alfaiataria', 'modelo', 'inverno', 'verao',
  ]);

  /**
   * Descrição/preço de EXIBIÇÃO por REF = os do produto DOMINANTE da REF
   * (a família de descrição com MAIS variações), lidos do espelho giga_produto.
   *
   * Motivo (caso REF 2319, 10/07): REF ambígua na Giga — "HELICOPTERO LIDER"
   * (1 variação, 2016, R$53,90) E "BLUSÃO ... KASUAL" (18+ variações, atual,
   * R$189,90). Agregar por MAX() monta uma linha Frankenstein (descrição/preço
   * do helicóptero com marca do blusão). A LIVE mostra o produto certo porque
   * trabalha nas variações — aqui escolhemos a família majoritária, igual ao
   * critério de ordenação do realinhamento (VARIANT_COUNT DESC).
   * Preço = maior vendaUn da REF (mesma regra do refPriceWithMirror da live).
   */
  async displayInfoByRefs(
    refs: string[],
  ): Promise<Map<string, { descricao: string; preco: number | null; variantes: number }>> {
    const out = new Map<string, { descricao: string; preco: number | null; variantes: number }>();
    const clean = Array.from(
      new Set(refs.map((r) => String(r || '').trim().toUpperCase()).filter(Boolean)),
    );
    if (!clean.length) return out;
    try {
      const rows: any[] = await (this.prisma as any).gigaProduto.findMany({
        where: { ref: { in: clean } },
        select: { ref: true, descricao: true, vendaUn: true },
      });
      const norm = (s: string) =>
        String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      // por REF: contagem por família + melhor descrição/preço da família
      const byRef = new Map<string, Map<string, { desc: string; count: number; preco: number }>>();
      for (const r of rows) {
        const ref = String(r.ref || '').trim().toUpperCase();
        const desc = String(r.descricao || '').trim();
        if (!ref || !desc) continue;
        const palavras = norm(desc).split(/\s+/).filter(Boolean);
        const familia =
          palavras.find((w) => w.length >= 4 && !ProductSearchService.FAMILIA_STOPWORDS.has(w)) ||
          '_outros';
        let fams = byRef.get(ref);
        if (!fams) byRef.set(ref, (fams = new Map()));
        const preco = Number(r.vendaUn) > 0 ? Number(r.vendaUn) : 0;
        const cur = fams.get(familia);
        if (cur) {
          cur.count++;
          if (preco > cur.preco) cur.preco = preco;
        } else {
          fams.set(familia, { desc, count: 1, preco });
        }
      }
      for (const [ref, fams] of byRef) {
        let best: { desc: string; count: number; preco: number } | null = null;
        for (const f of fams.values()) if (!best || f.count > best.count) best = f;
        if (best) {
          out.set(ref, {
            descricao: best.desc,
            preco: best.preco > 0 ? best.preco : null,
            variantes: best.count,
          });
        }
      }
    } catch (e) {
      this.logger.warn(`displayInfoByRefs falhou (espelho): ${(e as Error).message}`);
    }
    return out;
  }
}
