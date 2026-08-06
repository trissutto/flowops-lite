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
