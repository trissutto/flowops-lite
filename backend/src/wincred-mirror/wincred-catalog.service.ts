import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * WincredCatalogService — leitura do CATÁLOGO pro caminho quente do PDV
 * (bipe + busca por nome), servida pelo ESPELHO Postgres (wincred_produtos /
 * wincred_estoque) em vez do MySQL Giga ao vivo.
 *
 * Por que: o Giga PENDURA quando o firewall da KingHost derruba o IP do
 * Railway — e cada bipe/busca fazia round-trip WAN ao MySQL. O espelho é
 * local (Postgres, mesmo datacenter), responde em ms e não morre junto.
 *
 * Regras de fallback (Giga ao vivo continua como plano B):
 *   - espelho MISS (SKU não achado — ex.: produto não-plus-size, que o sync
 *     filtra, ou EAN13 que só resolve nas colunas do Giga) → consulta o Giga
 *   - espelho com preço zerado → Giga (lá existe fallback de preço via caixa)
 *   - erro de query no espelho → Giga
 *   - kill-switch: PDV_MIRROR_READS=0 desliga tudo e volta 100% pro Giga
 *
 * Frescor: produtos sincronizam a cada 10min (incremental por DATAALT) +
 * full às 3h; estoque ganhou full sync de hora em hora (cron). Pro bipe,
 * preço/descrição com até 10min de atraso é aceitável — alteração de preço
 * durante o expediente é rara e o fallback cobre produto recém-cadastrado.
 */
@Injectable()
export class WincredCatalogService {
  private readonly logger = new Logger(WincredCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  /** Kill-switch — PDV_MIRROR_READS=0 desliga a leitura pelo espelho. */
  get enabled(): boolean {
    return String(process.env.PDV_MIRROR_READS ?? '').trim() !== '0';
  }

  /**
   * Mesma normalização do sync (WincredMirrorService.normalizeCodigo):
   * o espelho guarda CODIGO como string numérica SEM zeros à esquerda.
   */
  private normalizeCodigo(raw: any): string | null {
    if (raw == null) return null;
    const s = String(raw).replace(/\D/g, '');
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    return String(n);
  }

  /** Normaliza código de loja: 'LJ01' / '1' / '01 ' → '01'. */
  private normalizeLoja(raw: any): string {
    return String(raw || '').trim().toUpperCase().replace(/^LJ/i, '').padStart(2, '0');
  }

  /**
   * VENDAUN no Giga é DECIMAL em REAIS (80.00 = R$ 80,00) — o espelho copia
   * o valor cru, então aqui é só Number().
   *
   * ⚠ NÃO dividir por 100! O caminho antigo do Giga PARECIA centavos porque
   * o parsePrice de lá remove o ponto ("80.00" → 8000) e o isCentavos divide
   * por 100 de volta. Ler o Decimal do Prisma direto já dá o valor em reais —
   * dividir de novo derrubava o preço 100× (bug de 01/07: blusa R$ 80 → 0,80).
   */
  private precoFromVendaUn(vendaUn: any): number {
    const n = Number(vendaUn);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BIPE — info do produto pro addItem do PDV.
  // Mesma assinatura/retorno do ErpService.getPdvProductInfo.
  // ═══════════════════════════════════════════════════════════════════════

  async getPdvProductInfo(skuOrEan: string): Promise<{
    sku: string;
    ean: string | null;
    ref: string | null;
    cor: string | null;
    tamanho: string | null;
    descricao: string;
    preco: number;
    ncm: string | null;
    cfop: string | null;
    custo: number | null;
    dataCadastro: string | null;
  } | null> {
    const t0 = Date.now();
    if (this.enabled) {
      try {
        const hit = await this.getPdvProductInfoFromMirror(skuOrEan);
        if (hit) {
          this.logger.log(`[bipe] ${skuOrEan}: espelho HIT (${Date.now() - t0}ms)`);
          return hit;
        }
        this.logger.log(`[bipe] ${skuOrEan}: espelho MISS → Giga ao vivo`);
      } catch (e: any) {
        this.logger.warn(`[bipe] ${skuOrEan}: espelho ERRO (${e?.message || e}) → Giga ao vivo`);
      }
    }
    return this.erp.getPdvProductInfo(skuOrEan);
  }

  private async getPdvProductInfoFromMirror(skuOrEan: string) {
    const codigo = this.normalizeCodigo(skuOrEan);
    if (!codigo) return null; // termo com letras (EAN alfanum etc) → Giga resolve

    const p: any = await (this.prisma as any).wincredProduto.findUnique({
      where: { codigo },
    });
    if (!p) return null;

    const preco = this.precoFromVendaUn(p.vendaUn);
    // Sem preço no espelho → deixa o Giga responder (lá tem fallback via
    // último unitário praticado na `caixa`).
    if (preco <= 0) return null;

    const custo = p.custo != null ? Number(p.custo) : null;
    return {
      sku: codigo,
      // O espelho não tem coluna de EAN (o `produtos` da Lurd's também não —
      // as etiquetas carregam o próprio CODIGO). NFC-e cai pra 'SEM GTIN',
      // igual ao comportamento atual.
      ean: null,
      ref: p.ref ? String(p.ref).trim() : null,
      cor: p.cor ? String(p.cor).trim() : null,
      tamanho: p.tamanho ? String(p.tamanho).trim() : null,
      descricao:
        (p.descricaoCompleta && String(p.descricaoCompleta).trim()) ||
        `${p.ref || codigo} ${p.cor || ''} ${p.tamanho || ''}`.trim(),
      preco,
      ncm: p.ncm ? String(p.ncm).trim() : null,
      cfop: p.cfop != null ? String(p.cfop) : null,
      custo: custo != null && Number.isFinite(custo) ? custo : null,
      dataCadastro: p.dataAlt ? new Date(p.dataAlt).toISOString().slice(0, 10) : null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BUSCA — dropdown do PDV (/products/erp-search).
  // Mesma lógica em 3 camadas do ErpService.searchProductsLike:
  //   numérico → CODIGO/REF exato → REF prefixo → contains genérico
  //   texto    → todas as palavras na DESCRICAOCOMPLETA (+ codigo/ref contains)
  // Retorno no MESMO shape (CODIGO, REF, DESCRICAOCOMPLETA, COR, TAMANHO,
  // ESTOQUE, qtyMyStore, qtyTotal).
  // ═══════════════════════════════════════════════════════════════════════

  async searchProductsLike(term: string, storeCode?: string): Promise<any[]> {
    const t0 = Date.now();
    if (this.enabled) {
      try {
        const rows = await this.searchFromMirror(term, storeCode);
        if (rows.length > 0) {
          this.logger.log(`[busca] "${term}": espelho ${rows.length} resultado(s) (${Date.now() - t0}ms)`);
          return rows;
        }
        this.logger.log(`[busca] "${term}": espelho vazio → Giga ao vivo`);
      } catch (e: any) {
        this.logger.warn(`[busca] "${term}": espelho ERRO (${e?.message || e}) → Giga ao vivo`);
      }
    }
    return this.erp.searchProductsLike(term, storeCode);
  }

  private async searchFromMirror(term: string, storeCode?: string): Promise<any[]> {
    const cleanTerm = String(term || '').trim();
    if (!cleanTerm) return [];
    const isNumericRef = /^\d{3,}$/.test(cleanTerm);
    const prisma: any = this.prisma;

    let products: any[] = [];
    if (isNumericRef) {
      // 1) CODIGO exato (normalizado) OU REF exata — CODIGO primeiro
      const codigo = this.normalizeCodigo(cleanTerm);
      products = await prisma.wincredProduto.findMany({
        where: {
          OR: [
            ...(codigo ? [{ codigo }] : []),
            { ref: cleanTerm },
          ],
        },
        orderBy: [{ descricaoCompleta: 'asc' }, { tamanho: 'asc' }, { cor: 'asc' }],
        take: 80,
      });
      if (codigo) {
        products.sort((a: any, b: any) => (a.codigo === codigo ? 0 : 1) - (b.codigo === codigo ? 0 : 1));
      }
      // 2) REF por prefixo
      if (!products.length) {
        products = await prisma.wincredProduto.findMany({
          where: { ref: { startsWith: cleanTerm } },
          orderBy: [{ ref: 'asc' }, { tamanho: 'asc' }, { cor: 'asc' }],
          take: 30,
        });
      }
      // 3) contains genérico
      if (!products.length) {
        products = await prisma.wincredProduto.findMany({
          where: {
            OR: [
              { codigo: { contains: cleanTerm } },
              { ref: { contains: cleanTerm } },
              { descricaoCompleta: { contains: cleanTerm, mode: 'insensitive' } },
            ],
          },
          take: 20,
        });
      }
    } else {
      const words = cleanTerm.split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2);
      if (words.length >= 2) {
        products = await prisma.wincredProduto.findMany({
          where: {
            OR: [
              { AND: words.map((w) => ({ descricaoCompleta: { contains: w, mode: 'insensitive' } })) },
              { codigo: { contains: cleanTerm } },
              { ref: { contains: cleanTerm, mode: 'insensitive' } },
            ],
          },
          take: 20,
        });
      } else {
        products = await prisma.wincredProduto.findMany({
          where: {
            OR: [
              { codigo: { contains: cleanTerm } },
              { ref: { contains: cleanTerm, mode: 'insensitive' } },
              { descricaoCompleta: { contains: cleanTerm, mode: 'insensitive' } },
            ],
          },
          take: 20,
        });
      }
    }

    if (!products.length) return [];

    // Estoque por loja do espelho (mesma agregação da versão Giga)
    const codigos = products.map((p: any) => String(p.codigo).trim()).filter(Boolean);
    const lojaClean = storeCode ? this.normalizeLoja(storeCode) : null;
    const stockByCodigo = new Map<string, { myStore: number; total: number }>();
    if (codigos.length) {
      const estRows: any[] = await prisma.wincredEstoque.findMany({
        where: { codigo: { in: codigos }, estoque: { gt: 0 } },
        select: { codigo: true, loja: true, estoque: true },
      });
      for (const r of estRows) {
        const c = String(r.codigo).trim();
        const loja = this.normalizeLoja(r.loja);
        const qty = Number(r.estoque) || 0;
        const cur = stockByCodigo.get(c) || { myStore: 0, total: 0 };
        cur.total += qty;
        if (lojaClean && loja === lojaClean) cur.myStore += qty;
        stockByCodigo.set(c, cur);
      }
    }

    return products.map((p: any) => {
      const c = String(p.codigo).trim();
      const s = stockByCodigo.get(c) || { myStore: 0, total: 0 };
      return {
        CODIGO: c,
        REF: p.ref ? String(p.ref).trim() : null,
        DESCRICAOCOMPLETA: p.descricaoCompleta ? String(p.descricaoCompleta).trim() : null,
        COR: p.cor ? String(p.cor).trim() : null,
        TAMANHO: p.tamanho ? String(p.tamanho).trim() : null,
        ID: p.idWincred != null ? Number(p.idWincred) : null,
        ESTOQUE: s.myStore, // legado — alguns consumers ainda leem ESTOQUE
        qtyMyStore: s.myStore,
        qtyTotal: s.total,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ESTOQUE — fallback pro StockService quando o Giga ao vivo falhar.
  // Retorna o shape StockEntry { sku, storeCode, availableQty }.
  // ═══════════════════════════════════════════════════════════════════════

  async getStockFromMirror(
    skus: string[],
    storeCodes: string[],
  ): Promise<Array<{ sku: string; storeCode: string; availableQty: number }>> {
    const bySkuNorm = new Map<string, string>(); // normalizado → como o caller passou
    for (const s of skus) {
      const n = this.normalizeCodigo(s);
      if (n && !bySkuNorm.has(n)) bySkuNorm.set(n, s);
    }
    const byLojaNorm = new Map<string, string>();
    for (const sc of storeCodes) {
      const n = this.normalizeLoja(sc);
      if (!byLojaNorm.has(n)) byLojaNorm.set(n, sc);
    }
    if (!bySkuNorm.size || !byLojaNorm.size) return [];

    const rows: any[] = await (this.prisma as any).wincredEstoque.findMany({
      where: { codigo: { in: Array.from(bySkuNorm.keys()) } },
      select: { codigo: true, loja: true, estoque: true },
    });

    const agg = new Map<string, number>(); // `${skuOrig}|${storeOrig}` → qty
    for (const r of rows) {
      const skuOrig = bySkuNorm.get(String(r.codigo).trim());
      const storeOrig = byLojaNorm.get(this.normalizeLoja(r.loja));
      if (!skuOrig || !storeOrig) continue;
      const k = `${skuOrig}|${storeOrig}`;
      agg.set(k, (agg.get(k) || 0) + (Number(r.estoque) || 0));
    }

    const out: Array<{ sku: string; storeCode: string; availableQty: number }> = [];
    for (const [k, qty] of agg) {
      const [sku, storeCode] = k.split('|');
      out.push({ sku, storeCode, availableQty: Math.max(0, qty) });
    }
    return out;
  }
}
