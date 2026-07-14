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
        // P2 migração de produtos: mesmo índice na tabela NATIVA `product`.
        await this.prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS product_descricao_trgm_idx
             ON product USING gin ("descricaoCompleta" gin_trgm_ops)`,
        );
        this.logger.log('[fulltext] pg_trgm + índices trigram (giga_produto + product) OK');
      } catch (e) {
        this.logger.warn(`[fulltext] setup pg_trgm falhou (busca segue sem índice): ${(e as Error).message}`);
      }
    })();
  }

  /**
   * P2 da migração de produtos: PRODUCT_NATIVE_READS=1 → a busca única lê a
   * tabela NATIVA `product` (curada, com ativo/genero) em vez do espelho
   * giga_produto. Kill-switch instantâneo: remover a env volta pro espelho.
   */
  private get nativeReads(): boolean {
    return String(process.env.PRODUCT_NATIVE_READS ?? '').trim() === '1';
  }

  /** Mesma normalização do espelho Wincred (codigo sem zeros à esquerda). */
  private normalizeCodigo(raw: string): string {
    const s = String(raw ?? '').trim();
    if (!s || !/^\d+$/.test(s)) return s;
    return s.replace(/^0+/, '') || '0';
  }

  /** Linha da tabela nativa no formato que TODOS os consumidores esperam. */
  private mapNative(r: any) {
    return {
      codigo: String(r.codigo ?? ''),
      ref: r.ref != null ? String(r.ref) : '',
      descricao: r.descricaoCompleta != null ? String(r.descricaoCompleta) : '',
      cor: r.cor != null ? String(r.cor) : '',
      tamanho: r.tamanho != null ? String(r.tamanho) : '',
      vendaUn: r.vendaUn != null ? Number(r.vendaUn) : null,
    };
  }

  async resolveRows(
    q: string,
    opts?: { fallbackTake?: number },
  ): Promise<Array<{ codigo: string; ref: string; descricao: string; cor: string; tamanho: string }>> {
    const term = String(q || '').trim();
    if (!term) return [];

    // ── TABELA NATIVA (P2, flag PRODUCT_NATIVE_READS) ──
    if (this.nativeReads) {
      const p = (this.prisma as any).product;
      const findN = (where: any, take = 1000) =>
        p.findMany({ where: { ativo: true, ...where }, take }).catch(() => []);
      // 1) Código exato — como digitado E normalizado (nativo guarda sem zeros).
      let nrows = await findN({ codigo: { in: [term, this.normalizeCodigo(term)] } });
      if (nrows.length) {
        // BIPE → GRADE INTEIRA (13/07): bipar UMA variação expande pra TODAS
        // as linhas da REF dela — a live monta a grade completa (cor×tamanho),
        // não só a célula da peça bipada.
        const refsHit = Array.from(new Set(nrows.map((r: any) => r.ref).filter(Boolean)));
        if (refsHit.length) {
          const familia = await findN({ ref: { in: refsHit } });
          if (familia.length) nrows = familia;
        }
        return nrows.map((r: any) => this.mapNative(r));
      }
      // 2) REF exata/prefixo.
      const upN = term.toUpperCase();
      nrows = await findN({
        OR: [{ ref: upN }, { ref: term }, { ref: { startsWith: upN } }, { ref: { startsWith: term } }],
      });
      if (nrows.length) return nrows.map((r: any) => this.mapNative(r));
      // 3) Full-text na descrição (pg_trgm no índice product_descricao_trgm_idx).
      if (term.length >= 2) {
        const wordsN = term.split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2).slice(0, 6);
        nrows = await findN(
          {
            OR: [
              { ref: { startsWith: term, mode: 'insensitive' } },
              ...(wordsN.length
                ? [{ AND: wordsN.map((w) => ({ descricaoCompleta: { contains: w, mode: 'insensitive' as const } })) }]
                : [{ descricaoCompleta: { contains: term, mode: 'insensitive' as const } }]),
            ],
          },
          opts?.fallbackTake ?? 300,
        );
      }
      return nrows.map((r: any) => this.mapNative(r));
    }

    const find = (where: any, take = 1000) =>
      (this.prisma as any).gigaProduto.findMany({ where, take }).catch(() => []);

    // 1) Código exato (índice) — cobre bipar código/EAN.
    let rows = await find({ codigo: term });
    if (rows.length) {
      // BIPE → GRADE INTEIRA (13/07): mesmo comportamento do caminho nativo —
      // expande a peça bipada pra todas as variações da REF dela.
      const refsHit = Array.from(new Set(rows.map((r: any) => r.ref).filter(Boolean)));
      if (refsHit.length) {
        const familia = await find({ ref: { in: refsHit } });
        if (familia.length) rows = familia;
      }
      return rows;
    }

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

  /**
   * BUSCA SOMENTE PELA DESCRIÇÃO — ORDEM EXPLÍCITA DO DONO (10/07):
   * "FAÇA A BUSCA SOMENTE UTILIZANDO A DESCRIÇÃO. PEGUE QUALQUER PARTE."
   *
   * TODAS as palavras do termo têm que aparecer na DESCRICAOCOMPLETA, em
   * QUALQUER ordem e QUALQUER posição. Ex.: "VESTIDO LONGO MANGA CURTA REF
   * 30333 PRETO 48" é achado por "VESTIDO 48", por "30333" e por
   * "MANGA CURTA 48 PRETO". SEM cascata de código/REF — a descrição da Giga
   * embute REF+MARCA+COR+TAMANHO, então buscar a REF acha pela descrição.
   * Se vier produto a mais contendo as mesmas palavras, entra mesmo
   * ("aí é por minha conta" — dono). Índice pg_trgm mantém rápido.
   */
  async searchDescricaoOnly(
    term: string,
    take = 20000,
  ): Promise<Array<{ codigo: string; ref: string | null; descricao: string | null }>> {
    const words = String(term || '')
      .trim()
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2)
      .slice(0, 8);
    if (!words.length) return [];
    if (this.nativeReads) {
      const rows: any[] = await (this.prisma as any).product.findMany({
        where: {
          ativo: true,
          AND: words.map((w) => ({ descricaoCompleta: { contains: w, mode: 'insensitive' } })),
        },
        select: { codigo: true, ref: true, descricaoCompleta: true },
        take,
      });
      return rows.map((r) => ({ codigo: r.codigo, ref: r.ref, descricao: r.descricaoCompleta }));
    }
    return (this.prisma as any).gigaProduto.findMany({
      where: { AND: words.map((w) => ({ descricao: { contains: w, mode: 'insensitive' } })) },
      select: { codigo: true, ref: true, descricao: true },
      take,
    });
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
   *
   * matchWords (caso REF 321, 10/07): quando a tela tem BUSCA ativa, a linha
   * mostra a família QUE CASOU com a busca — não a dominante. Sem isso,
   * "KASUAL VEST" achava o "VESTIDO ... 321 KASUAL" mas a linha exibia a
   * "BERMUDA JEANS 321 YACIMA" (família com mais variações da mesma REF) —
   * parecia resultado errado. Famílias que casam TODAS as palavras têm
   * prioridade; entre elas, vence a com mais variações; sem match, dominante.
   */
  async displayInfoByRefs(
    refs: string[],
    opts?: { matchWords?: string[] },
  ): Promise<Map<string, { descricao: string; preco: number | null; variantes: number }>> {
    const out = new Map<string, { descricao: string; preco: number | null; variantes: number }>();
    const clean = Array.from(
      new Set(refs.map((r) => String(r || '').trim().toUpperCase()).filter(Boolean)),
    );
    if (!clean.length) return out;
    const norm = (s: string) =>
      String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const matchWords = (opts?.matchWords || [])
      .map((w) => norm(w).trim())
      .filter((w) => w.length >= 2);
    try {
      const rows: any[] = this.nativeReads
        ? (
            await (this.prisma as any).product.findMany({
              where: { ref: { in: clean }, ativo: true },
              select: { ref: true, descricaoCompleta: true, vendaUn: true },
            })
          ).map((r: any) => ({ ref: r.ref, descricao: r.descricaoCompleta, vendaUn: r.vendaUn }))
        : await (this.prisma as any).gigaProduto.findMany({
            where: { ref: { in: clean } },
            select: { ref: true, descricao: true, vendaUn: true },
          });
      // por REF: contagem por família + melhor descrição/preço da família.
      // matched = a família tem ao menos UMA variação casando TODAS as palavras.
      const byRef = new Map<string, Map<string, { desc: string; count: number; preco: number; matched: boolean }>>();
      for (const r of rows) {
        const ref = String(r.ref || '').trim().toUpperCase();
        const desc = String(r.descricao || '').trim();
        if (!ref || !desc) continue;
        const descNorm = norm(desc);
        const palavras = descNorm.split(/\s+/).filter(Boolean);
        const familia =
          palavras.find((w) => w.length >= 4 && !ProductSearchService.FAMILIA_STOPWORDS.has(w)) ||
          '_outros';
        const casa = matchWords.length > 0 && matchWords.every((w) => descNorm.includes(w));
        let fams = byRef.get(ref);
        if (!fams) byRef.set(ref, (fams = new Map()));
        const preco = Number(r.vendaUn) > 0 ? Number(r.vendaUn) : 0;
        const cur = fams.get(familia);
        if (cur) {
          cur.count++;
          if (preco > cur.preco) cur.preco = preco;
          // Se qualquer variação da família casa a busca, a família casa.
          // A desc exibida segue a 1ª da família (diferem só por cor/tamanho).
          if (casa) cur.matched = true;
        } else {
          fams.set(familia, { desc, count: 1, preco, matched: casa });
        }
      }
      for (const [ref, fams] of byRef) {
        let best: { desc: string; count: number; preco: number; matched: boolean } | null = null;
        for (const f of fams.values()) {
          if (!best) { best = f; continue; }
          // Família que casou com a busca SEMPRE ganha de família que não casou;
          // dentro do mesmo grupo, vence a com mais variações.
          if (f.matched !== best.matched) { if (f.matched) best = f; continue; }
          if (f.count > best.count) best = f;
        }
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
