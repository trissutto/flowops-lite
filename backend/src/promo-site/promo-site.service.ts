import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromoConfigService } from '../promo-config/promo-config.service';
import {
  PROMO_COLECAO_RE,
  PROMO_CUTOFF,
  aplicarDescontoPromo,
  elegivelPromo,
} from '../common/promo-julho';
import { refBaseOf } from '../common/ref-base';

/**
 * A PROMOÇÃO DE 50% DO CAIXA, VALENDO NO SITE (dono, 15/08).
 *
 * ── O QUE ESTAVA ERRADO ──
 *
 * O Outlet do site listava pela marca `promocao` do cadastro, que veio do
 * `on_sale` do WooCommerce no import. Só que o PREÇO promocional não veio
 * junto: a marca atravessou, o desconto não. Medido em produção em 15/08:
 * **49 peças no Outlet e 1 com "de/por"** — as outras 48 mostravam preço
 * cheio numa aba que promete desconto. Aba de promoção sem promoção é pior
 * que aba vazia: a cliente clica, confere o preço na peça ao lado e conclui
 * que a loja inventou desconto.
 *
 * ── O QUE PASSA A VALER ──
 *
 * A MESMA regra que a vendedora aplica no caixa (`common/promo-julho.ts`):
 * peça de MODA cadastrada até 31/12/2023 (ou REF de coleção -INV/-VER, ou
 * liberada na mão na tela de Classificação) sai por metade do preço. BÁSICO
 * fica de fora — e pelo MESMO interruptor do PDV (`excluirBasicoNa50` da tela
 * "Promoções PDV"), não por uma cópia da decisão aqui.
 *
 * Assim a peça antiga tem UM preço só na rede: o que a etiqueta da arara diz,
 * o que o caixa cobra e o que o site cobra. Enquanto a regra morava só no PDV,
 * a cliente que vinha da loja física para o site via a mesma peça mais cara —
 * e reclamava com razão.
 *
 * ── A FAMÍLIA, NÃO A REF ──
 *
 * O site vende FAMÍLIA (a REF-BASE, com as cores irmãs como bolinha), e a data
 * de cadastro é por REF. A decisão sai da família inteira, com a data MAIS
 * RECENTE dela: se uma cor irmã foi cadastrada este ano, a peça não é acervo
 * velho. Errar pra esse lado só deixa de dar desconto; errar pro outro anuncia
 * metade do preço numa peça nova.
 *
 * ── POR QUE NUM SERVIÇO SEPARADO ──
 *
 * Quem responde tem que ser o MESMO pros dois lados: a vitrine (que mostra) e
 * a trava do carrinho (que cobra). Se divergirem, o pedido é RECUSADO no
 * checkout — o guard recusa quando o catálogo está mais caro que a página que
 * a cliente leu. Uma resposta, dois chamadores.
 *
 * Kill-switch: `SITE_PROMO_50=0` desliga o desconto automático do site (o
 * `precoPromo` manual por peça continua valendo).
 */

export interface PromoDaPeca {
  /** A família entra nos 50%? */
  elegivel: boolean;
  /** Frase pronta pra log e pra retaguarda ("por que essa peça caiu?"). */
  motivo: string;
  /** Data de cadastro considerada (a mais recente da família), 'YYYY-MM-DD'. */
  dataCadastro: string | null;
}

/** O que a decisão precisa saber sobre uma família — nada de banco aqui. */
export interface FamiliaPromo {
  /** REFs da família (a chave e as irmãs). */
  refs: string[];
  /** MAIOR `dataAlt` da família em 'YYYY-MM-DD' (null = ERP não tem a peça). */
  dataCadastro: string | null;
  /** Alguma REF da família está classificada como BÁSICO. */
  basico: boolean;
  /** Alguma REF da família foi liberada na mão na tela de Classificação. */
  liberada: boolean;
  /** Filtro de BÁSICO ligado (config da tela "Promoções PDV"). */
  excluirBasico: boolean;
}

const FORA = 'sem promoção';

/**
 * A decisão, sem banco — é o que os testes cobrem.
 *
 * A ordem importa e é a do caixa: BÁSICO barra antes de tudo (mesmo com data
 * velha), depois a liberação manual, depois data e coleção.
 */
export function decidirPromo(f: FamiliaPromo): PromoDaPeca {
  const bloqueadoPorBasico = f.basico && f.excluirBasico;
  const refColecao = f.refs.find((r) => PROMO_COLECAO_RE.test(String(r).trim()));

  const elegivel = elegivelPromo({
    ref: refColecao ?? f.refs[0] ?? '',
    dataCadastro: f.dataCadastro,
    isBasico: bloqueadoPorBasico,
    promoLiberada: f.liberada,
  });

  let motivo: string;
  if (bloqueadoPorBasico) {
    motivo = 'BÁSICO — fora da promoção de 50%';
  } else if (f.liberada) {
    motivo = 'liberada na mão na tela de Classificação';
  } else if (f.dataCadastro && f.dataCadastro <= PROMO_CUTOFF) {
    motivo = `cadastrada em ${f.dataCadastro.slice(0, 4)} (até 2023)`;
  } else if (refColecao) {
    motivo = `coleção ${refColecao.slice(-3).toUpperCase()}`;
  } else if (!f.dataCadastro) {
    motivo = `${FORA} — sem data de cadastro no ERP`;
  } else {
    motivo = `${FORA} — cadastrada em ${f.dataCadastro.slice(0, 4)}`;
  }

  return { elegivel, motivo, dataCadastro: f.dataCadastro };
}

@Injectable()
export class PromoSiteService {
  private readonly logger = new Logger(PromoSiteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly promoConfig: PromoConfigService,
  ) {}

  /** Desconto ligado? `SITE_PROMO_50=0` desliga sem deploy. */
  get ligada(): boolean {
    return String(process.env.SITE_PROMO_50 ?? '1') !== '0';
  }

  /** O preço com os 50% — mesmo arredondamento do caixa. */
  precoComDesconto(preco: number): number {
    return aplicarDescontoPromo(preco);
  }

  /**
   * A CHAVE de comparação, igual à do catálogo e à da trava do carrinho
   * (`normRef` dos dois): maiúscula, sem espaço nenhum. O cadastro tem a mesma
   * REF escrita "VMS-223 MA" e "VMS-223MA" — sem isto, a vitrine acha a
   * promoção e o carrinho não, e o pedido é recusado no checkout.
   *
   * ⚠️ Só pra COMPARAR. Consulta no banco vai sempre com a REF como ela está
   * gravada, senão o `IN` não casa nada.
   */
  private chaveDe(v: unknown): string {
    return String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
  }

  private norm(v: unknown): string {
    return String(v ?? '').trim().toUpperCase();
  }

  /**
   * Decide a promoção pra cada chave pedida (a REF da peça do site).
   *
   * A chave é sempre a que o chamador conhece: a vitrine passa a chave da
   * família, o carrinho passa a REF que veio na sacola. Aqui as duas viram a
   * MESMA família antes de decidir — é isso que faz vitrine e caixa
   * concordarem.
   *
   * Nunca lança: sem resposta do banco, a peça fica FORA da promoção (preço
   * cheio na vitrine e no checkout). Falhar pro lado do desconto anunciaria
   * metade do preço em cima de uma consulta que não voltou.
   */
  async porChaves(chaves: string[]): Promise<Map<string, PromoDaPeca>> {
    const saida = new Map<string, PromoDaPeca>();
    const pedidas = Array.from(new Set(chaves.map((c) => this.chaveDe(c)).filter(Boolean)));
    if (!pedidas.length || !this.ligada) return saida;

    try {
      const excluirBasico = await this.excluirBasico();
      const { familias, datas } = await this.familias(pedidas);

      const todasRefs = Array.from(new Set([...familias.values()].flat()));
      const cls = await this.classificacaoPorRef(todasRefs);

      for (const chave of pedidas) {
        const refs = familias.get(chave) ?? [chave];
        const dataCadastro =
          refs
            .map((r) => datas.get(this.chaveDe(r)))
            .filter((d): d is string => !!d)
            .sort()
            .slice(-1)[0] ?? null;

        saida.set(
          chave,
          decidirPromo({
            refs,
            dataCadastro,
            basico: refs.some((r) => cls.get(this.chaveDe(r))?.basico),
            liberada: refs.some((r) => cls.get(this.chaveDe(r))?.liberada),
            excluirBasico,
          }),
        );
      }
    } catch (e: any) {
      // Sem promoção é o estado seguro: a peça sai pelo preço cheio nos dois
      // lados (vitrine e checkout continuam concordando).
      this.logger.warn(`[promo-site] não consegui decidir a promoção (segue sem): ${e?.message || e}`);
      return new Map();
    }

    return saida;
  }

  /** Atalho pra quem tem uma peça só (a PDP por link direto). */
  async porChave(chave: string): Promise<PromoDaPeca | null> {
    const m = await this.porChaves([chave]);
    return m.get(this.chaveDe(chave)) ?? null;
  }

  /** O MESMO interruptor do caixa — a tela "Promoções PDV" manda nos dois. */
  private async excluirBasico(): Promise<boolean> {
    try {
      return !!(await this.promoConfig.getConfig()).excluirBasicoNa50;
    } catch {
      // fail-safe igual ao do PDV: sem config, o filtro de BÁSICO vale.
      return true;
    }
  }

  /**
   * As REFs de cada família, pelos DOIS caminhos de agrupamento do catálogo:
   * a REF-BASE (sufixo de cor cortado) e o `grupoRef` que a retaguarda
   * decidiu na mão. Ler só a base deixaria de fora as famílias de letra (a
   * VOGUE, por exemplo), que só se juntam pelo `grupoRef`.
   */
  private async familias(
    chaves: string[],
  ): Promise<{ familias: Map<string, string[]>; datas: Map<string, string> }> {
    // Irmãs por grupoRef (cadastro do site) — a chave pode ser o grupo ou uma
    // das irmãs dele.
    const doGrupo: any[] = await (this.prisma as any).siteProduto.findMany({
      where: { OR: [{ grupoRef: { in: chaves } }, { ref: { in: chaves } }] },
      select: { ref: true, grupoRef: true },
    });
    const grupoDaChave = new Map<string, string>();
    const refsDoGrupo = new Map<string, string[]>();
    for (const r of doGrupo) {
      const grupo = this.chaveDe(r.grupoRef);
      if (!grupo) continue;
      grupoDaChave.set(this.chaveDe(r.ref), grupo);
      if (!refsDoGrupo.has(grupo)) refsDoGrupo.set(grupo, []);
      refsDoGrupo.get(grupo)!.push(this.norm(r.ref));
    }

    /**
     * Irmãs por REF-BASE (espelho do ERP) — a cor virou REF nova no cadastro
     * legado, e é aí que mora a maioria das famílias. A base sai da MESMA
     * expressão que o catálogo usa, e as irmãs do `grupoRef` entram pela base
     * delas (é o que cobre a família de letra, tipo VOGUE).
     *
     * A data vem junto: é a `dataAlt`, a ÚNICA data que o Giga tem. Ela MUDA
     * quando alguém edita o cadastro, então peça velha reeditada sai da
     * promoção — no caixa também, porque é a mesma data que o PDV lê.
     */
    const bases = Array.from(
      new Set([
        ...chaves.map((c) => refBaseOf(c)),
        ...[...refsDoGrupo.values()].flat().map((r) => refBaseOf(r)),
      ]),
    );
    const linhas: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT UPPER(TRIM(ref)) AS ref,
              COALESCE(NULLIF(regexp_replace(UPPER(TRIM(ref)), '[^0-9]+$', ''), ''), UPPER(TRIM(ref))) AS base,
              MAX("dataAlt") AS data
         FROM wincred_produtos
        WHERE ref IS NOT NULL AND TRIM(ref) <> ''
          AND COALESCE(NULLIF(regexp_replace(UPPER(TRIM(ref)), '[^0-9]+$', ''), ''), UPPER(TRIM(ref))) = ANY($1)
        GROUP BY 1, 2`,
      bases,
    );
    const porBase = new Map<string, string[]>();
    const datas = new Map<string, string>();
    for (const l of linhas) {
      const ref = this.norm(l.ref);
      const base = this.norm(l.base);
      if (!porBase.has(base)) porBase.set(base, []);
      porBase.get(base)!.push(ref);
      if (l.data) datas.set(this.chaveDe(ref), new Date(l.data).toISOString().slice(0, 10));
    }

    const familias = new Map<string, string[]>();
    for (const chave of chaves) {
      const grupo = grupoDaChave.get(chave) ?? chave;
      const irmasDoGrupo = refsDoGrupo.get(grupo) ?? [];
      familias.set(
        chave,
        Array.from(
          new Set([
            chave,
            ...irmasDoGrupo,
            ...(porBase.get(refBaseOf(chave)) ?? []),
            ...irmasDoGrupo.flatMap((r) => porBase.get(refBaseOf(r)) ?? []),
          ]),
        ),
      );
    }
    return { familias, datas };
  }

  /** BÁSICO/MODA e liberação manual — a mesma tabela que o caixa consulta. */
  private async classificacaoPorRef(
    refs: string[],
  ): Promise<Map<string, { basico: boolean; liberada: boolean }>> {
    const m = new Map<string, { basico: boolean; liberada: boolean }>();
    if (!refs.length) return m;
    const rows: any[] = await (this.prisma as any).productClassification.findMany({
      where: { ref: { in: refs } },
      select: { ref: true, tipoProduto: true, promoLiberada: true },
    });
    for (const r of rows) {
      m.set(this.chaveDe(r.ref), {
        basico: r.tipoProduto === 1,
        liberada: !!r.promoLiberada,
      });
    }
    return m;
  }
}
