import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { refBaseOf, refsDeBusca } from '../common/ref-base';

/**
 * A MINIATURA DO CARRINHO DO PDV — agora do Postgres (14/09/2026).
 *
 * ── O QUE ESTAVA QUEBRADO ──
 *
 * `GET /pdv/product-image` e `/pdv/product-images` pediam a foto pro
 * **WooCommerce** (`WooCommerceService.getProductImageBySku` → `GET
 * WC_URL/wp-json/wc/v3/products?sku=X`). O WordPress foi apagado em
 * 27/08/2026 e `WC_URL` hoje é o site NOVO, que responde **HTTP 403 pela
 * Vercel** — medido em 14/09/2026 no apex e no www.
 *
 * A falha era silenciosa por desenho: o método pegava a exceção, cacheava
 * `null` e devolvia "sem foto". Resultado em produção: TODA peça do carrinho
 * virou a bolinha com a inicial da REF, e ninguém tinha como saber se a peça
 * simplesmente não tinha foto ou se a fonte estava morta. Ainda por cima, cada
 * SKU novo pagava uma ida até a Vercel (8s de timeout) pra ouvir 403.
 *
 * ── DE ONDE A FOTO VEM AGORA ──
 *
 * `product_photos` (Postgres + R2) — **a mesma fonte da Consulta, da
 * Reposição, da Separação, do Realinhamento e do site**. Não é fonte nova: é
 * a que já era a oficial. O Realinhamento fez essa mesma troca antes
 * (`realignment.service.ts` → `fotosOficiaisPorRefCor`) e a régua de chave
 * (`REF|COR`) e a cascata daqui são as de lá, de propósito — foto indexada só
 * por REF fazia a peça VINHO aparecer com a foto da PRETA.
 *
 * ── POR QUE A CASCATA PARA NA COR ──
 *
 * Com a COR conhecida a busca NUNCA cai na foto de outra cor: no PDV a
 * vendedora confere a peça pela imagem, e foto errada é pior que foto
 * nenhuma. Só o item sem cor no cadastro aceita qualquer foto da família.
 *
 * ── SEM CACHE, DE PROPÓSITO ──
 *
 * O caminho antigo cacheava 1h porque cada leitura era um round-trip WAN. Aqui
 * é `product_photos` no mesmo datacenter, e o cache de 1h tinha um efeito
 * ruim: foto que a loja acabou de subir na Reposição só aparecia no carrinho
 * uma hora depois.
 *
 * ── ERRO SOBE ──
 *
 * Miss é resposta (`null` = "esta peça não tem foto"); erro do Postgres SOBE
 * como 500 honesto, sem `catch` devolvendo mapa vazio — foi o `catch`
 * silencioso que escondeu a morte do WooCommerce por semanas. A ponta já
 * aguenta: o carrinho trata miniatura como enfeite e desenha a inicial da REF.
 */
@Injectable()
export class FotoProdutoService {
  private readonly logger = new Logger(FotoProdutoService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mesma normalização do espelho (`WincredMirrorService.normalizeCodigo` /
   * `WincredCatalogService`): o CODIGO é guardado como string numérica SEM
   * zeros à esquerda. A etiqueta da loja e o carrinho mandam o código com
   * zeros às vezes — sem isto a peça "não tem foto" por causa de um zero.
   */
  private normalizeCodigo(raw: unknown): string | null {
    const s = String(raw ?? '').replace(/\D/g, '');
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    return String(n);
  }

  /** Chave do mapa de capas — a MESMA do `ProductPhotosService.getBatch`. */
  private chave(ref: unknown, cor: unknown): string {
    return `${String(ref ?? '').trim().toUpperCase()}|${String(cor ?? '').trim().toUpperCase()}`;
  }

  /**
   * Capa da peça de cada SKU pedido.
   *
   * Devolve um mapa com TODOS os SKUs pedidos — SKU sem foto vem `null`
   * explícito, pra que a ponta consiga diferenciar "pedi e não tem" de "nem
   * perguntei". As chaves saem EXATAMENTE como entraram (o carrinho indexa o
   * cache pela string que mandou).
   */
  async capaPorSku(skus: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    const porCodigo = new Map<string, string[]>();
    for (const bruto of skus) {
      const sku = String(bruto ?? '').trim();
      if (!sku) continue;
      out[sku] = null;
      const codigo = this.normalizeCodigo(sku);
      if (!codigo) continue;
      const jaTem = porCodigo.get(codigo);
      if (jaTem) jaTem.push(sku);
      else porCodigo.set(codigo, [sku]);
    }
    const codigos = Array.from(porCodigo.keys());
    if (!codigos.length) return out;

    /**
     * REF e COR do CADASTRO — lidas das DUAS tabelas, nativa primeiro.
     *
     * A nativa (`product`) é a fonte do catálogo (`PRODUCT_NATIVE_READS`), mas
     * espelho e nativa podem divergir na janela do sync, e peça recém-cadastrada
     * aparece num antes do outro. É a mesma decisão do bipe
     * (`getPdvProductInfoFromMirror`): conferir as duas antes de dizer "não
     * existe". Aqui as duas consultas são PK indexada — barato o suficiente pra
     * não valer um flag que possa divergir do resto.
     */
    const [nativos, espelho] = await Promise.all([
      (this.prisma as any).product.findMany({
        where: { codigo: { in: codigos } },
        select: { codigo: true, ref: true, cor: true },
      }),
      (this.prisma as any).wincredProduto.findMany({
        where: { codigo: { in: codigos } },
        select: { codigo: true, ref: true, cor: true },
      }),
    ]);

    const cadastro = new Map<string, { refUp: string; corUp: string }>();
    for (const linha of [...espelho, ...nativos]) {
      const refUp = String(linha?.ref ?? '').trim().toUpperCase();
      if (!refUp) continue;
      cadastro.set(String(linha.codigo), {
        refUp,
        corUp: String(linha?.cor ?? '').trim().toUpperCase(),
      });
    }
    if (!cadastro.size) return out;

    // Uma consulta só pra todas as REFs (e as REF-BASE) da chamada.
    const refsBuscadas = Array.from(
      new Set(Array.from(cadastro.values()).flatMap((c) => refsDeBusca(c.refUp))),
    );
    const fotos: Array<{ ref: string; cor: string | null; url: string }> = await (
      this.prisma as any
    ).productPhoto.findMany({
      where: { ref: { in: refsBuscadas } },
      orderBy: { ordem: 'asc' },
      select: { ref: true, cor: true, url: true },
    });

    // `ordem` 0 é a capa; o orderBy garante que a primeira que entra fica.
    const capaRefCor: Record<string, string> = {};
    const capaSoRef: Record<string, string> = {};
    for (const f of fotos) {
      const refUp = String(f.ref ?? '').trim().toUpperCase();
      const k = this.chave(refUp, f.cor);
      if (!capaRefCor[k]) capaRefCor[k] = f.url;
      if (!capaSoRef[refUp]) capaSoRef[refUp] = f.url;
    }

    for (const [codigo, skusDoCodigo] of porCodigo) {
      const c = cadastro.get(codigo);
      if (!c) continue;
      const baseUp = refBaseOf(c.refUp);
      const url =
        capaRefCor[this.chave(c.refUp, c.corUp)] ??
        capaRefCor[this.chave(baseUp, c.corUp)] ??
        // Foto genérica da REF (linha gravada com cor nula) — vale pra qualquer cor.
        capaRefCor[this.chave(c.refUp, '')] ??
        capaRefCor[this.chave(baseUp, '')] ??
        // Só a peça SEM cor no cadastro aceita qualquer foto da família.
        (c.corUp ? undefined : (capaSoRef[c.refUp] ?? capaSoRef[baseUp]));
      if (url) for (const sku of skusDoCodigo) out[sku] = url;
    }
    return out;
  }

  /** Conveniência pra rota de UM SKU — mesma régua, mesma consulta. */
  async capaDeUmSku(sku: string): Promise<string | null> {
    const mapa = await this.capaPorSku([sku]);
    return mapa[String(sku ?? '').trim()] ?? null;
  }
}
