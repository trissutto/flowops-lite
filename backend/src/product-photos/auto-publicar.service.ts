import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WcFotosImportService } from './wc-fotos-import.service';
import { refBaseOf } from '../common/ref-base';
import { limparNomeVitrine } from '../loja-catalog/nome-vitrine';

/**
 * FOTO SUBIU → PEÇA NO AR — sem botão no meio.
 *
 * Pedido do dono (06/08, e já era a decisão de 02/08: "a FOTO é a chave"):
 * subir a foto na ficha da cor é o ato de publicar. Antes deste serviço a
 * cadeia tinha dois cliques escondidos — o "Salvar cor" (que gravava status e
 * bolinha) e a curadoria `site_produto.publicado`, que peça nova nenhuma
 * tinha. Foto boa no R2 e site sem a peça, esperando cliques que ninguém
 * sabia que deviam.
 *
 * O que o upload passa a garantir, tudo idempotente e best-effort:
 *   1. `site_produto` da REF existe e está `publicado` (o portão da vitrine);
 *   2. a ficha da cor existe com status 'publicado' — o rótulo da tela passa
 *      a dizer a verdade ("Fora do site" numa cor que ESTÁ no site confundia).
 *
 * O que ele NÃO faz:
 *   - não pinta a bolinha (a tela lê a cor por IA na hora do upload e grava;
 *     a varredura de 90s continua como rede pros outros caminhos);
 *   - não roda na IMPORTAÇÃO EM MASSA do site antigo — aquele acervo tem
 *     21 mil REFs fora de linha, e publicar tudo encheria a vitrine de peça
 *     esgotada. Por isso o gancho vive no CONTROLLER do upload (o caminho da
 *     tela), não dentro de `ProductPhotosService.upload`, que o importador
 *     também chama.
 *   - não sobrescreve escolha: status 'pronto' (escolha humana deliberada de
 *     segurar) fica como está; só o default 'nao_publicar' é promovido.
 */
@Injectable()
export class AutoPublicarService {
  private readonly logger = new Logger(AutoPublicarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wcImport: WcFotosImportService,
  ) {}

  /**
   * A REF é masculina/infantil pela descrição do ERP? Mesma regra usada em
   * `loja-catalog.service.ts`, `product-native.service.ts`, `live-pdv` e
   * `product-registration` — aqui evita que "publicar quem está ativo no
   * WooCommerce" volte a marcar `site_produto.publicado=true` numa peça que
   * a loja não vende como plus size feminino (achado 07/08: REF 12199
   * "CALÇA MASCULINA CARGO" foi publicada assim).
   */
  private async ehMasculinoOuInfantil(ref: string): Promise<boolean> {
    const [linha] = await this.prisma.$queryRawUnsafe<Array<{ achou: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM wincred_produtos
          WHERE (UPPER(TRIM(ref)) = $1 OR UPPER(TRIM(ref)) LIKE $1 || ' %')
            AND (
              UPPER(COALESCE("descricaoCompleta", '')) LIKE '%MASCULIN%' OR
              UPPER(COALESCE("descricaoCompleta", '')) LIKE '%INFANTIL%' OR
              UPPER(COALESCE("nomeGrupo", '')) LIKE '%MASCULIN%' OR
              UPPER(COALESCE("nomeGrupo", '')) LIKE '%INFANTIL%'
            )
       ) AS achou`,
      ref,
    );
    return !!linha?.achou;
  }

  /**
   * IMPORTAÇÃO EM MASSA — publica, mas só o que tem ESTOQUE.
   *
   * 🔴 O buraco que isto fecha (achado 07/08 com o dono na tela): "Importar
   * tudo" trouxe **3.517 fotos em 696 peças e não publicou nenhuma**. A REF
   * VLM-222 tinha foto em várias cores e devolvia ZERO na busca do site. O
   * gancho de publicar morava só no CONTROLLER do upload manual, então o
   * caminho que o dono realmente usa — o botão de importar — deixava a peça
   * pronta e invisível.
   *
   * A regra original ("não publicar na importação") foi escrita quando a fila
   * era o acervo inteiro do site antigo, 21 mil REFs fora de linha. Hoje a
   * fila nasce do cruzamento com o catálogo vivo (1.172). O que sobrou do
   * medo legítimo é "encher a vitrine de peça esgotada" — e é exatamente isso
   * que o filtro de estoque resolve, sem segurar o que está pronto pra vender.
   *
   * Devolve o que aconteceu, pro job CONTAR em vez de deixar sumir calado.
   */
  async aoImportarEmMassa(
    refBruta: string,
    cores: string[],
  ): Promise<'publicada' | 'fora_do_wc' | 'nada'> {
    try {
      const ref = refBaseOf(refBruta);
      if (!ref || !cores.length) return 'nada';

      if (await this.ehMasculinoOuInfantil(ref)) {
        this.logger.log(`[auto-publicar] ${ref}: masculino/infantil pela descrição — fora da vitrine`);
        return 'fora_do_wc';
      }

      /**
       * ATIVO NO WOOCOMMERCE = entra (decisão do dono, 07/08). A lista vem
       * cacheada porque o lote chama isto REF por REF e ela é uma query só no
       * WordPress inteiro.
       */
      const noAr = await this.refsAtivasCacheadas();
      if (noAr.size && !noAr.has(ref) && !noAr.has(refBaseOf(ref))) {
        this.logger.log(`[auto-publicar] ${ref}: não está ativa no site antigo — fora da vitrine`);
        return 'fora_do_wc';
      }

      for (const cor of cores) await this.aoSubirFoto(ref, cor);
      return 'publicada';
    } catch (e: any) {
      this.logger.warn(`[auto-publicar] massa ${refBruta}: ${e?.message || e}`);
      return 'nada';
    }
  }

  /**
   * As REFs ativas no site antigo, em cache de 10 min.
   *
   * O lote processa REF por REF; sem cache seria uma varredura do WordPress
   * inteiro por peça. Conjunto VAZIO significa "não consegui listar" — e aí
   * `aoImportarEmMassa` deixa passar em vez de bloquear tudo: WordPress fora
   * do ar não pode virar "nenhuma peça entra no site".
   */
  private cacheAtivas: { at: number; refs: Set<string> } | null = null;
  private async refsAtivasCacheadas(): Promise<Set<string>> {
    const TTL = 10 * 60_000;
    if (this.cacheAtivas && Date.now() - this.cacheAtivas.at < TTL) return this.cacheAtivas.refs;
    const refs = new Set<string>();
    try {
      for (const r of await this.wcImport.refsAtivasNoSiteAntigo()) {
        const u = String(r).toUpperCase();
        refs.add(u);
        const base = refBaseOf(u);
        if (base) refs.add(base);
      }
    } catch (e: any) {
      this.logger.warn(`[auto-publicar] não consegui listar as ativas do WC: ${e?.message || e}`);
    }
    this.cacheAtivas = { at: Date.now(), refs };
    return refs;
  }

  /**
   * REPARO DO PASSIVO — publica o que JÁ TEM FOTO e ficou fora do site.
   *
   * Precisa existir porque o conserto de `aoImportarEmMassa` sozinho não
   * alcança o estrago: "Importar tudo" PULA quem já tem foto
   * (`apenasSemFoto`), então re-rodar responderia "nenhuma REF pra importar"
   * e as 696 peças já importadas continuariam invisíveis pra sempre.
   *
   * É explícito (botão) e não automático no deploy de propósito: isto coloca
   * peça no ar pra cliente ver, e ninguém deve descobrir que publicou
   * centenas de peças pelo log.
   */
  async repararPassivo(simular = false): Promise<{
    simulado: boolean;
    ativasNoWc: number; comFoto: number; jaNoAr: number;
    publicadas: number; foraDoWc: number; falhas: number;
  }> {
    /**
     * CRITÉRIO: ATIVO NO WOOCOMMERCE (decisão do dono, 07/08).
     *
     * Trocou o filtro de estoque que eu tinha proposto. É melhor mesmo: o site
     * antigo é o registro do que a loja escolheu vender online, e peça
     * esgotada hoje volta amanhã — enquanto rascunho lá é decisão de não
     * mostrar, e essa decisão tem que atravessar a migração.
     */
    const ativas = await this.wcImport.refsAtivasNoSiteAntigo();
    const noAr = new Set<string>();
    for (const r of ativas) {
      const u = String(r).toUpperCase();
      noAr.add(u);
      const base = refBaseOf(u);
      if (base) noAr.add(base);
    }

    const fotos: Array<{ ref: string; cor: string | null }> =
      await this.prisma.$queryRawUnsafe(
        `SELECT DISTINCT UPPER(TRIM(ref)) AS ref, NULLIF(TRIM(cor), '') AS cor
           FROM product_photos WHERE ref IS NOT NULL AND TRIM(ref) <> ''`,
      );
    const coresPorRef = new Map<string, string[]>();
    for (const f of fotos) {
      if (!coresPorRef.has(f.ref)) coresPorRef.set(f.ref, []);
      if (f.cor) coresPorRef.get(f.ref)!.push(String(f.cor).toUpperCase());
    }

    const publicados: Array<{ ref: string }> = await (this.prisma as any).siteProduto.findMany({
      where: { publicado: true }, select: { ref: true },
    });
    const jaPublicado = new Set(publicados.map((s) => String(s.ref).toUpperCase()));

    let jaNoAr = 0, publicadas = 0, foraDoWc = 0, falhas = 0;
    for (const [ref, cores] of coresPorRef) {
      if (jaPublicado.has(ref)) { jaNoAr++; continue; }
      if (!noAr.has(ref) && !noAr.has(refBaseOf(ref))) { foraDoWc++; continue; }
      // Achado 07/08: REF 12199 "CALÇA MASCULINA CARGO" entrou pelo reparo do
      // passivo. Mesma trava de `aoImportarEmMassa`.
      if (await this.ehMasculinoOuInfantil(ref)) { foraDoWc++; continue; }
      if (simular) { publicadas++; continue; }
      try {
        // Sem cor casada ainda assim publica a REF: a vitrine mostra a peça
        // com a foto genérica, que é melhor que peça invisível.
        if (cores.length) for (const cor of cores) await this.aoSubirFoto(ref, cor);
        else await this.aoSubirFoto(ref, null);
        publicadas++;
      } catch {
        falhas++;
      }
    }

    const resumo = {
      simulado: simular, ativasNoWc: ativas.length, comFoto: coresPorRef.size,
      jaNoAr, publicadas, foraDoWc, falhas,
    };
    this.logger.log(`[auto-publicar] reparo: ${JSON.stringify(resumo)}`);
    return resumo;
  }

  /** Chamado pelo controller após CADA upload da tela. Nunca lança. */
  async aoSubirFoto(refBruta: string, corBruta?: string | null): Promise<void> {
    try {
      const ref = refBaseOf(refBruta);
      const cor = String(corBruta || '').trim().toUpperCase() || null;
      if (!ref) return;

      // Sem marca no catálogo não há ficha possível (chave é REF+MARCA) —
      // e também não há o que vender. Log e fora.
      const marca = await this.wcImport.marcaDaFamilia(ref);
      if (!marca) {
        this.logger.warn(`[auto-publicar] ${ref}: família sem MARCA no catálogo — nada publicado`);
        return;
      }

      if (cor) {
        const ficha = await (this.prisma as any).produtoFicha.upsert({
          where: { ref_marca: { ref, marca } },
          create: { ref, marca },
          update: {},
        });
        const atual = await (this.prisma as any).produtoFichaCor.findUnique({
          where: { fichaId_cor: { fichaId: ficha.id, cor } },
          select: { id: true, statusPublicacao: true },
        });
        if (!atual) {
          await (this.prisma as any).produtoFichaCor.create({
            data: { fichaId: ficha.id, cor, statusPublicacao: 'publicado' },
          });
        } else if (atual.statusPublicacao === 'nao_publicar' || atual.statusPublicacao === 'sem_fotos') {
          await (this.prisma as any).produtoFichaCor.update({
            where: { id: atual.id },
            data: { statusPublicacao: 'publicado' },
          });
        }
      }

      const site = await (this.prisma as any).siteProduto.findUnique({ where: { ref } });
      if (site) {
        if (!site.publicado) {
          await (this.prisma as any).siteProduto.update({
            where: { ref },
            data: { publicado: true },
          });
          this.logger.log(`[auto-publicar] ${ref}: republicada (foto nova = intenção de estar no ar)`);
        }
        return;
      }

      // Peça que nunca passou pelo site antigo: nasce no Flow, já publicada.
      // O nome NASCE LIMPO: a descrição do ERP é por variação e carrega cor e
      // tamanho — gravada crua, estreou na PDP como "CAMISA MANGA LONGA POÁ
      // MARROM 46" (caso 407012, 13/08). A PDP segue priorizando o nomeCurto
      // da ficha, e o slug segue a convenção `ref-<base>` que o catálogo e a
      // lista de desejos já entendem.
      const linhas = await this.prisma.$queryRawUnsafe<
        Array<{ descricao: string | null; cor: string | null }>
      >(
        `SELECT NULLIF(TRIM("descricaoCompleta"), '') AS descricao,
                NULLIF(TRIM(cor), '')                 AS cor
           FROM wincred_produtos
          WHERE UPPER(TRIM(ref)) = $1 OR UPPER(TRIM(ref)) LIKE $1 || ' %'
          LIMIT 60`,
        ref,
      );
      const coresDaFamilia = Array.from(
        new Set(linhas.map((l) => l.cor).filter(Boolean)),
      ) as string[];
      await (this.prisma as any).siteProduto.create({
        data: {
          ref,
          slug: `ref-${ref.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
          nome: (
            limparNomeVitrine(linhas[0]?.descricao, ref, coresDaFamilia, marca) || ref
          ).slice(0, 160),
          publicado: true,
          origemConteudo: 'flow',
          editadoPor: 'auto-publicar',
          editadoEm: new Date(),
        },
      });
      this.logger.log(`[auto-publicar] ${ref} (${marca}): entrou no site pela primeira foto`);
    } catch (e: any) {
      // Best-effort de verdade: a foto (o caro) já está salva; publicar de
      // novo é grátis no próximo upload.
      this.logger.warn(`[auto-publicar] ${refBruta}/${corBruta ?? '—'}: ${e?.message || e}`);
    }
  }
}
