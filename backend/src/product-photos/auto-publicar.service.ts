import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WcFotosImportService } from './wc-fotos-import.service';
import { refBaseOf } from '../common/ref-base';

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
  ): Promise<'publicada' | 'sem_estoque' | 'nada'> {
    try {
      const ref = refBaseOf(refBruta);
      if (!ref || !cores.length) return 'nada';

      const [linha] = await this.prisma.$queryRawUnsafe<Array<{ total: number }>>(
        `SELECT COALESCE(SUM(e.estoque), 0)::int AS total
           FROM wincred_produtos p
           JOIN wincred_estoque e ON e.codigo = p.codigo
          WHERE UPPER(TRIM(p.ref)) = $1 OR UPPER(TRIM(p.ref)) LIKE $1 || ' %'`,
        ref,
      );
      if (!linha || linha.total <= 0) {
        this.logger.log(`[auto-publicar] ${ref}: tem foto mas está sem estoque — fora do site`);
        return 'sem_estoque';
      }

      for (const cor of cores) await this.aoSubirFoto(ref, cor);
      return 'publicada';
    } catch (e: any) {
      this.logger.warn(`[auto-publicar] massa ${refBruta}: ${e?.message || e}`);
      return 'nada';
    }
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
  async repararPassivo(): Promise<{
    comFoto: number; jaNoAr: number; publicadas: number; semEstoque: number; falhas: number;
  }> {
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

    const comEstoque: Array<{ ref: string }> = await this.prisma.$queryRawUnsafe(
      `SELECT DISTINCT UPPER(TRIM(p.ref)) AS ref
         FROM wincred_produtos p
         JOIN (SELECT codigo, SUM(COALESCE(estoque,0)) AS total
                 FROM wincred_estoque GROUP BY codigo) e ON e.codigo = p.codigo
        WHERE p.ref IS NOT NULL AND TRIM(p.ref) <> '' AND e.total > 0`,
    );
    const temEstoque = new Set<string>();
    for (const l of comEstoque) {
      temEstoque.add(l.ref);
      const base = refBaseOf(l.ref);
      if (base) temEstoque.add(base);
    }

    const publicados: Array<{ ref: string }> = await (this.prisma as any).siteProduto.findMany({
      where: { publicado: true }, select: { ref: true },
    });
    const jaPublicado = new Set(publicados.map((s) => String(s.ref).toUpperCase()));

    let jaNoAr = 0, publicadas = 0, semEstoque = 0, falhas = 0;
    for (const [ref, cores] of coresPorRef) {
      if (jaPublicado.has(ref)) { jaNoAr++; continue; }
      if (!temEstoque.has(ref) && !temEstoque.has(refBaseOf(ref))) { semEstoque++; continue; }
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

    const resumo = { comFoto: coresPorRef.size, jaNoAr, publicadas, semEstoque, falhas };
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
      // Nome cru do catálogo serve de fallback — a PDP prioriza o nomeCurto
      // da ficha, e o slug segue a convenção `ref-<base>` que o catálogo e a
      // lista de desejos já entendem.
      const [linha] = await this.prisma.$queryRawUnsafe<Array<{ descricao: string | null }>>(
        `SELECT NULLIF(TRIM("descricaoCompleta"), '') AS descricao
           FROM wincred_produtos
          WHERE UPPER(TRIM(ref)) = $1 OR UPPER(TRIM(ref)) LIKE $1 || ' %'
          LIMIT 1`,
        ref,
      );
      await (this.prisma as any).siteProduto.create({
        data: {
          ref,
          slug: `ref-${ref.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
          nome: (linha?.descricao || ref).slice(0, 160),
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
