import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { discriminadorProduto } from '../common/produto-discriminador';
import { ehLojaCanal } from '../common/loja-canal';

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
 *   - espelho MISS (SKU não achado — ex.: produto cadastrado há minutos, ou
 *     EAN13 que só resolve nas colunas do Giga) → consulta o Giga
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
   * P2 da migração de produtos: PRODUCT_NATIVE_READS=1 → catálogo lido da
   * tabela NATIVA `product` (curada no Flow) em vez do espelho
   * wincred_produtos. Os campos têm os MESMOS nomes nos dois models, então
   * só o model troca. Kill-switch: remover a env volta pro espelho na hora.
   * (Estoque/EAN continuam nos espelhos — só o CADASTRO migra aqui.)
   */
  private get produtoTable(): any {
    const nativo = String(process.env.PRODUCT_NATIVE_READS ?? '').trim() === '1';
    return nativo ? (this.prisma as any).product : (this.prisma as any).wincredProduto;
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
    /** Preço "DE" registrado da promoção (> preco) — null = sem promoção. */
    precoDe?: number | null;
    ncm: string | null;
    cfop: string | null;
    custo: number | null;
    dataCadastro: string | null;
  } | null> {
    const t0 = Date.now();
    let info: any = null;
    if (this.enabled) {
      try {
        const hit = await this.getPdvProductInfoFromMirror(skuOrEan);
        if (hit) {
          this.logger.log(`[bipe] ${skuOrEan}: espelho HIT (${Date.now() - t0}ms)`);
          info = hit;
        } else {
          this.logger.log(`[bipe] ${skuOrEan}: espelho MISS → Giga ao vivo`);
        }
      } catch (e: any) {
        this.logger.warn(`[bipe] ${skuOrEan}: espelho ERRO (${e?.message || e}) → Giga ao vivo`);
      }
    }
    if (!info) info = await this.erp.getPdvProductInfo(skuOrEan);
    return this.anexarPrecoDe(info);
  }

  /**
   * PREÇO "DE" DA PROMOÇÃO no bipe (dono, 26/08): "você economizou R$ 30".
   * A coluna vive só na tabela NATIVA (`product.precoDe` — o espelho é
   * recriado pelo sync). Anexado aqui, depois de qualquer caminho (espelho ou
   * Giga), pra valer nos dois. DE que não é maior que o preço atual é âncora
   * velha — vai como null, nunca "economia negativa".
   */
  private async anexarPrecoDe<T extends { sku: string; preco: number } | null>(info: T): Promise<T> {
    if (!info) return info;
    try {
      const codigo = this.normalizeCodigo(info.sku) || String(info.sku).trim();
      const p: any = await (this.prisma as any).product.findUnique({
        where: { codigo },
        select: { precoDe: true },
      });
      const de = p?.precoDe != null ? Math.round(Number(p.precoDe) * 100) / 100 : null;
      (info as any).precoDe = de != null && de > info.preco ? de : null;
    } catch {
      (info as any).precoDe = null;
    }
    return info;
  }

  private async getPdvProductInfoFromMirror(skuOrEan: string) {
    const codigo = this.normalizeCodigo(skuOrEan);
    if (!codigo) return null; // termo com letras (EAN alfanum etc) → Giga resolve

    const p: any = await this.produtoTable.findUnique({
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

  /**
   * Padrões aceitos como variação de cor da MESMA REF base (igual ao Giga):
   * exata · base+" X" · base+"-X" · base+letras. Rejeita base+dígito
   * ("9002" não pode trazer "900271", que é outra REF). Letras COLADAS: só
   * sufixo curto de cor (1-2 letras, ex.: "223P", "223VN"). 3+ letras é OUTRA
   * REF ("8709RIU" ≠ variação de "8709") — regra alinhada com o
   * normalizeBaseRef da consulta (velho erro de "adivinhar a referência",
   * dono 21/07).
   */
  private isVariationOf(foundRef: string, baseRef: string): boolean {
    if (!foundRef) return false;
    if (foundRef === baseRef) return true;
    if (!foundRef.startsWith(baseRef)) return false;
    const suffix = foundRef.slice(baseRef.length);
    if (suffix.startsWith(' ') || suffix.startsWith('-')) return true;
    if (/^[A-Za-z]{1,2}$/.test(suffix)) return true;
    return false;
  }

  private async searchFromMirror(term: string, storeCode?: string): Promise<any[]> {
    const cleanTerm = String(term || '').trim();
    if (!cleanTerm) return [];
    const isNumericRef = /^\d{3,}$/.test(cleanTerm);
    const prisma: any = this.prisma;

    let products: any[] = [];
    if (isNumericRef) {
      // 1) CODIGO exato (normalizado) OU REF exata.
      const codigo = this.normalizeCodigo(cleanTerm);
      products = await this.produtoTable.findMany({
        where: {
          OR: [
            ...(codigo ? [{ codigo }] : []),
            { ref: cleanTerm },
          ],
        },
        orderBy: [{ descricaoCompleta: 'asc' }, { tamanho: 'asc' }, { cor: 'asc' }],
        take: 80,
      });
      // PRIORIDADE: se o número existe como REF (ex.: "223263" = família MARRIE),
      // a REF vem PRIMEIRO — senão colide com o CÓDIGO homônimo de outra peça
      // ("223263" também é o CÓDIGO de uma peça do REF 6168). Só afeta a busca
      // por REF (erp-search/dropdown); o BIPE do leitor usa getPdvProductInfo e
      // segue CÓDIGO-primeiro (scanner intocado). Sem REF exata → código primeiro.
      const temRefExata = products.some((p: any) => String(p.ref ?? '').trim() === cleanTerm);
      if (temRefExata) {
        // IRMÃS DE COR (14/08, caso 900895): a REF exata é só UMA cor da
        // família ("900895" = ESTAMPA PRETO); as outras cores vivem em REFs
        // com sufixo ("900895A" = ESTAMPA AZUL). O match exato retornava
        // direto e o passo 2 (prefixo) nunca rodava — o dropdown do PDV
        // escondia as irmãs que a Consulta mostra.
        const irmas = await this.produtoTable.findMany({
          where: { ref: { startsWith: cleanTerm, not: cleanTerm } },
          orderBy: [{ ref: 'asc' }, { cor: 'asc' }, { tamanho: 'asc' }],
          take: 80,
        });
        const jaTem = new Set(products.map((p: any) => String(p.codigo)));
        for (const p of irmas) {
          if (jaTem.has(String(p.codigo))) continue;
          if (this.isVariationOf(String(p.ref ?? '').trim(), cleanTerm)) products.push(p);
        }
        // REF exata primeiro, irmãs de cor depois, CÓDIGO homônimo por último.
        const rank = (p: any) => {
          const r = String(p.ref ?? '').trim();
          return r === cleanTerm ? 0 : this.isVariationOf(r, cleanTerm) ? 1 : 2;
        };
        products.sort((a: any, b: any) => rank(a) - rank(b));
      } else if (codigo) {
        products.sort((a: any, b: any) => (a.codigo === codigo ? 0 : 1) - (b.codigo === codigo ? 0 : 1));
      }
      // 2) REF por prefixo
      if (!products.length) {
        products = await this.produtoTable.findMany({
          where: { ref: { startsWith: cleanTerm } },
          orderBy: [{ ref: 'asc' }, { tamanho: 'asc' }, { cor: 'asc' }],
          take: 30,
        });
      }
      // 3) contains genérico
      if (!products.length) {
        products = await this.produtoTable.findMany({
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
        products = await this.produtoTable.findMany({
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
        products = await this.produtoTable.findMany({
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
        // A LOJA-CANAL NÃO ENTRA NA CONTA (dono, 24/08): ela não cede peça, e
        // somá-la no total faz a vendedora prometer o que ninguém tem. Ver
        // `common/loja-canal.ts`.
        if (ehLojaCanal(r.loja)) continue;
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
  // CONSULTA DE PRODUTOS (F10) — /products/store-search.
  // Réplicas fiéis dos 4 métodos do ErpService que a tela usa, lendo do
  // espelho com fallback pro Giga (produto recém-cadastrado, EAN, erro).
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Mesma semântica do ErpService.searchByRef: tudo que começa com a REF
   * base, filtrado pelos padrões de sufixo de cor da Lurd's, com dedup por
   * (REF+COR+TAM) escolhendo o CODIGO com mais estoque total.
   */
  async searchByRef(ref: string): Promise<any[]> {
    if (this.enabled) {
      try {
        const rows = await this.searchByRefFromMirror(ref);
        if (rows.length > 0) return rows;
        this.logger.log(`[consulta] ref "${ref}": espelho vazio → Giga ao vivo`);
      } catch (e: any) {
        this.logger.warn(`[consulta] ref "${ref}": espelho ERRO (${e?.message || e}) → Giga`);
      }
    }
    return this.erp.searchByRef(ref);
  }

  /**
   * SÓ POSTGRES — nunca encosta no Giga (31/08, reclamação do dono).
   *
   * `searchByRef`/`searchByCodeAndExpandRef` caem no MySQL quando o espelho
   * volta vazio, e quem precisa perguntar AS DUAS COISAS (é REF? é CÓDIGO?)
   * pra desempatar uma colisão pagava DOIS timeouts do Giga numa busca que
   * não achou nada. Com `queueLimit: 0` no pool, cada uma dessas idas é uma
   * chance de pendurar o app inteiro — foi assim que a live de 01/07 caiu.
   *
   * Quem chama estas duas decide a hora de arriscar UMA ida ao Giga (o caso
   * legítimo é a peça cadastrada há menos de 10min, que o espelho ainda não
   * puxou), em vez de arriscar a cada pergunta intermediária.
   */
  async searchByRefSemGiga(ref: string): Promise<any[]> {
    if (!this.enabled) return [];
    try {
      return await this.searchByRefFromMirror(ref);
    } catch (e: any) {
      this.logger.warn(`[consulta] ref "${ref}": espelho ERRO (${e?.message || e}) — SEM ida ao Giga`);
      return [];
    }
  }

  /** Par do `searchByRefSemGiga` pro lado do CÓDIGO. Só Postgres. */
  async searchByCodeAndExpandRefSemGiga(code: string): Promise<any[]> {
    if (!this.enabled) return [];
    try {
      const codigo = this.normalizeCodigo(code);
      if (!codigo) return [];
      const p: any = await this.produtoTable.findUnique({
        where: { codigo },
        select: { ref: true },
      });
      if (!p?.ref) return [];
      return await this.searchByRefFromMirror(String(p.ref).trim(), codigo);
    } catch (e: any) {
      this.logger.warn(`[consulta] codigo "${code}": espelho ERRO (${e?.message || e}) — SEM ida ao Giga`);
      return [];
    }
  }

  private async searchByRefFromMirror(
    ref: string,
    /** Código bipado — imune à dedup (ver o comentário da chave, abaixo). */
    preservarCodigo?: string,
  ): Promise<any[]> {
    const clean = String(ref || '').trim();
    if (!clean) return [];
    const prisma: any = this.prisma;

    // ⚠️ NUNCA deixar "parcial vencer completo" (varredura 03/08, BMM-100):
    // com PRODUCT_NATIVE_READS a fonte é a tabela nativa, mas ela é populada
    // por sync com janela — se tiver só parte da família, devolver esse
    // parcial NÃO-VAZIO suprime o fallback que conhecia o resto e a cor some
    // da Consultar. Aqui consultamos AS DUAS tabelas Postgres com o mesmo
    // WHERE e mesclamos por codigo (nativa vence no conflito).
    const whereRef = { OR: [{ ref: clean }, { ref: { startsWith: clean } }] };
    const args = { where: whereRef, orderBy: [{ cor: 'asc' }, { tamanho: 'asc' }] as any, take: 1000 };
    const [nativos, espelho]: [any[], any[]] = await Promise.all([
      prisma.product.findMany(args).catch(() => []),
      prisma.wincredProduto.findMany(args).catch(() => []),
    ]);
    if (nativos.length !== espelho.length) {
      this.logger.log(`[consulta] ref "${clean}": nativo=${nativos.length} espelho=${espelho.length} (mesclando)`);
    }
    const porCodigo = new Map<string, any>();
    for (const p of espelho) porCodigo.set(String(p.codigo), p);
    for (const p of nativos) porCodigo.set(String(p.codigo), p); // nativa vence
    const produtos: any[] = Array.from(porCodigo.values());
    if (!produtos.length) return [];

    const filtered = produtos.filter((p) => this.isVariationOf(String(p.ref || '').trim(), clean));
    if (!filtered.length) return [];

    // TOTAL_EST por codigo (dedup de duplicidade do Wincred, igual ao Giga)
    const codigos = filtered.map((p) => String(p.codigo));
    const estRows: any[] = await prisma.wincredEstoque.findMany({
      where: { codigo: { in: codigos } },
      // `loja` entra no select só pra poder DESCARTAR a loja-canal logo abaixo.
      select: { codigo: true, loja: true, estoque: true },
    });
    const totalByCodigo = new Map<string, number>();
    for (const r of estRows) {
      // Loja-canal fora do TOTAL_EST: ela não cede peça (`common/loja-canal.ts`),
      // e é este total que decide qual CÓDIGO ganha a dedup — deixá-la dentro
      // elegia o código cujo estoque só existe no canal.
      if (ehLojaCanal(r.loja)) continue;
      const c = String(r.codigo);
      totalByCodigo.set(c, (totalByCodigo.get(c) || 0) + (Number(r.estoque) || 0));
    }

    const norm = (s: any) => String(s ?? '').trim().toUpperCase();
    const byKey = new Map<string, any>();
    for (const p of filtered) {
      // ⚠️ O DISCRIMINADOR ENTRA NA CHAVE (12/08): a dedup existe pra matar
      // duplicidade do Wincred DENTRO do mesmo produto. Sem marca/família na
      // chave, "6605 JEANS 38" da BERMUDA KATHO e "6605 JEANS 38" da CALÇA
      // MAX DENIM viram a mesma célula e uma APAGA a outra do resultado —
      // não é cartão errado, é linha que some da Consulta.
      const k = `${norm(p.ref)}|${discriminadorProduto(p.marca, p.descricaoCompleta)}|${norm(p.cor)}|${norm(p.tamanho)}`;
      const totalEst = totalByCodigo.get(String(p.codigo)) || 0;
      const codigoNum = Number(p.codigo) || 0;
      const cur = byKey.get(k);
      if (!cur) { byKey.set(k, { p, totalEst, codigoNum }); continue; }
      // O código BIPADO nunca perde a disputa: quem bipou a etiqueta tem que
      // ver aquela peça, mesmo que a irmã duplicada tenha mais estoque.
      if (preservarCodigo && String(cur.p.codigo) === preservarCodigo) continue;
      if (
        (preservarCodigo && String(p.codigo) === preservarCodigo) ||
        totalEst > cur.totalEst ||
        (totalEst === cur.totalEst && codigoNum > cur.codigoNum)
      ) {
        byKey.set(k, { p, totalEst, codigoNum });
      }
    }
    return Array.from(byKey.values()).map(({ p, totalEst }) => ({
      CODIGO: String(p.codigo),
      REF: p.ref ? String(p.ref).trim() : null,
      DESCRICAOCOMPLETA: p.descricaoCompleta ? String(p.descricaoCompleta).trim() : null,
      COR: p.cor ? String(p.cor).trim() : null,
      TAMANHO: p.tamanho ? String(p.tamanho).trim() : null,
      ESTOQUE: p.estoque != null ? Number(p.estoque) : null,
      TOTAL_EST: totalEst,
      ID: p.idWincred != null ? Number(p.idWincred) : null,
      // vendaUn no espelho é DECIMAL em REAIS — NUNCA dividir por 100
      VENDAUN: p.vendaUn != null ? Number(p.vendaUn) : null,
      FORNECEDOR: p.fornecedor ? String(p.fornecedor).trim() : null,
      // MARCA e o discriminador do balde na Consulta (nao o CNPJ) — ver
      // products.service.storeProductSearch.
      MARCA: p.marca ? String(p.marca).trim() : null,
    }));
  }

  /**
   * Bipou código na consulta: acha a REF do código e expande a REF inteira.
   * EAN não existe no espelho — miss cai pro Giga (que varre colunas de EAN).
   */
  async searchByCodeAndExpandRef(code: string): Promise<any[]> {
    if (this.enabled) {
      try {
        const codigo = this.normalizeCodigo(code);
        if (codigo) {
          const p: any = await this.produtoTable.findUnique({
            where: { codigo },
            select: { ref: true },
          });
          if (p?.ref) {
            const rows = await this.searchByRefFromMirror(String(p.ref).trim(), codigo);
            if (rows.length > 0) return rows;
          }
        }
        this.logger.log(`[consulta] codigo "${code}": espelho MISS → Giga ao vivo`);
      } catch (e: any) {
        this.logger.warn(`[consulta] codigo "${code}": espelho ERRO (${e?.message || e}) → Giga`);
      }
    }
    return this.erp.searchByCodeAndExpandRef(code);
  }

  /**
   * Busca por descrição agrupada por REF (modo "desc" da consulta).
   * Mesma lógica do Giga: termo REF-like → match exato/prefixo agrupado por
   * família; texto livre → todas as palavras na descrição, agrupado por REF.
   */
  async searchByDescriptionGrouped(
    term: string,
  ): Promise<Array<{ REF: string; DESCRICAOCOMPLETA: string; VARIANT_COUNT: number; FAMILIA?: string }>> {
    if (this.enabled) {
      try {
        const rows = await this.searchByDescriptionGroupedFromMirror(term);
        if (rows.length > 0) return rows;
        this.logger.log(`[consulta] desc "${term}": espelho vazio → Giga ao vivo`);
      } catch (e: any) {
        this.logger.warn(`[consulta] desc "${term}": espelho ERRO (${e?.message || e}) → Giga`);
      }
    }
    return this.erp.searchByDescriptionGrouped(term);
  }

  private async searchByDescriptionGroupedFromMirror(term: string) {
    const trimmed = String(term || '').trim();
    if (!trimmed) return [];
    const prisma: any = this.prisma;

    const isRefLike = /^[A-Z0-9]+(-[A-Z0-9]+)*$/i.test(trimmed) && !trimmed.includes(' ');
    if (isRefLike) {
      let rows: any[] = await this.produtoTable.findMany({
        where: { ref: trimmed },
        select: { ref: true, descricaoCompleta: true },
      });
      if (!rows.length) {
        rows = await this.produtoTable.findMany({
          where: { ref: { startsWith: trimmed, not: '' } },
          select: { ref: true, descricaoCompleta: true },
          orderBy: { ref: 'asc' },
          take: 500,
        });
      }
      return this.groupRowsByFamily(
        rows.map((r) => ({ REF: String(r.ref || ''), DESCRICAOCOMPLETA: String(r.descricaoCompleta || '') })),
      );
    }

    const words = trimmed.split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
    if (!words.length) return [];
    const rows: any[] = await this.produtoTable.findMany({
      where: {
        AND: [
          ...words.map((w) => ({ descricaoCompleta: { contains: w, mode: 'insensitive' } })),
          { ref: { not: null } },
          { NOT: { ref: '' } },
        ],
      },
      select: { ref: true, descricaoCompleta: true },
      take: 5000,
    });
    // Agrupa por REF (COUNT + uma descrição de amostra), ordena por variantes
    const byRef = new Map<string, { desc: string; count: number }>();
    for (const r of rows) {
      const ref = String(r.ref || '').trim();
      if (!ref) continue;
      const cur = byRef.get(ref);
      if (cur) cur.count++;
      else byRef.set(ref, { desc: String(r.descricaoCompleta || ''), count: 1 });
    }
    return Array.from(byRef.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 200)
      .map(([ref, g]) => ({ REF: ref, DESCRICAOCOMPLETA: g.desc, VARIANT_COUNT: g.count }));
  }

  /**
   * Cópia do ErpService.groupRowsByFamily — REF ambígua (mesma REF pra
   * PIJAMA e VESTIDO) vira uma linha por família de descrição.
   */
  private groupRowsByFamily(
    rows: Array<{ REF: string; DESCRICAOCOMPLETA: string }>,
  ): Array<{ REF: string; DESCRICAOCOMPLETA: string; VARIANT_COUNT: number; FAMILIA?: string }> {
    const STOPWORDS = new Set([
      'plus', 'size', 'feminina', 'feminino', 'masculino', 'masculina',
      'infantil', 'unissex', 'adulto', 'manga', 'curta', 'longa', 'comum',
      'basica', 'basico', 'alfaiataria', 'modelo', 'inverno', 'verao',
    ]);
    const norm = (s: string) =>
      String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const groups = new Map<string, { ref: string; desc: string; count: number; familia: string }>();
    for (const r of rows) {
      const ref = String(r.REF || '').trim();
      const desc = String(r.DESCRICAOCOMPLETA || '').trim();
      if (!ref) continue;
      const palavras = norm(desc).split(/\s+/).filter(Boolean);
      const familia = palavras.find((w) => w.length >= 4 && !STOPWORDS.has(w)) || '_outros';
      const key = `${ref}::${familia}`;
      const existing = groups.get(key);
      if (existing) existing.count++;
      else groups.set(key, { ref, desc, count: 1, familia });
    }
    return Array.from(groups.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 200)
      .map((g) => ({ REF: g.ref, DESCRICAOCOMPLETA: g.desc, VARIANT_COUNT: g.count, FAMILIA: g.familia }));
  }

  /**
   * Estoque detalhado por loja pros SKUs (shape Record<sku, [{storeCode, qty}]>).
   * Espelho primeiro; se não achou NADA, fallback Giga (produto fora do espelho).
   */
  async getStockBySkusDetailed(
    skus: string[],
  ): Promise<Record<string, Array<{ storeCode: string; qty: number }>>> {
    if (this.enabled && skus.length) {
      try {
        const map = await this.getStockBySkusDetailedFromMirror(skus);
        if (Object.keys(map).length > 0) return map;
        this.logger.log(`[consulta] estoque de ${skus.length} SKU(s): espelho vazio → Giga ao vivo`);
      } catch (e: any) {
        this.logger.warn(`[consulta] estoque: espelho ERRO (${e?.message || e}) → Giga`);
      }
    }
    return this.erp.getStockBySkusDetailed(skus);
  }

  private async getStockBySkusDetailedFromMirror(skus: string[]) {
    const bySkuNorm = new Map<string, string>();
    for (const s of skus) {
      const n = this.normalizeCodigo(s);
      if (n && !bySkuNorm.has(n)) bySkuNorm.set(n, String(s).trim());
    }
    if (!bySkuNorm.size) return {};
    const rows: any[] = await (this.prisma as any).wincredEstoque.findMany({
      where: { codigo: { in: Array.from(bySkuNorm.keys()) }, estoque: { gt: 0 } },
      select: { codigo: true, loja: true, estoque: true },
    });
    const agg = new Map<string, Map<string, number>>();
    for (const r of rows) {
      // A loja-canal não aparece pra quem está atendendo cliente (dono, 24/08):
      // ela não tem arara. Ver `common/loja-canal.ts`.
      if (ehLojaCanal(r.loja)) continue;
      const original = bySkuNorm.get(String(r.codigo).trim());
      if (!original) continue;
      const storeCode = String(r.loja || '').trim();
      const qty = Number(r.estoque) || 0;
      if (qty <= 0 || !storeCode) continue;
      if (!agg.has(original)) agg.set(original, new Map());
      const lojaMap = agg.get(original)!;
      lojaMap.set(storeCode, (lojaMap.get(storeCode) || 0) + qty);
    }
    const map: Record<string, Array<{ storeCode: string; qty: number }>> = {};
    for (const [sku, lojaMap] of agg.entries()) {
      map[sku] = Array.from(lojaMap.entries()).map(([storeCode, qty]) => ({ storeCode, qty }));
    }
    return map;
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
