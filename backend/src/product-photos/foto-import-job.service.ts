import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { WcFotosImportService } from './wc-fotos-import.service';
import { AutoPublicarService } from './auto-publicar.service';
import { refBaseOf } from '../common/ref-base';

/**
 * IMPORTAR TUDO — o acervo inteiro do site antigo, num clique.
 *
 * TRÊS DECISÕES QUE DEFINEM ESTE ARQUIVO:
 *
 * 1. O estado mora no BANCO, não na memória. Deploy reinicia o backend em ~30s
 *    e mata o que estava em voo — hoje mesmo isso deixou uma trava de envio
 *    presa e a loja sem conseguir postar. Job em memória morreria no meio de
 *    2.000 REFs e ninguém saberia. Aqui o cron reabre o job e continua de onde
 *    parou.
 *
 * 2. Vai DEVAGAR, de propósito. O WordPress divide servidor com o ERP antigo;
 *    baixar imagem em paralelo lá é a receita pra derrubar o site que ainda
 *    está vendendo. Poucas REFs por ciclo, em série, com respiro entre elas.
 *
 * 3. Cada REF importada já sai com a BOLINHA pintada — a leitura de cor por IA
 *    roda dentro da própria importação. Sem isso o lote entregaria milhares de
 *    peças com foto e bolinha cinza, e alguém teria que abrir uma a uma.
 */

const POR_CICLO = 3;          // REFs por rodada do cron
const CICLO_MS = 15_000;      // uma rodada a cada 15s
const MAX_PROBLEMAS = 200;    // teto do relatório de falhas

@Injectable()
export class FotoImportJobService {
  private readonly logger = new Logger(FotoImportJobService.name);
  /** Evita dois ciclos rodando juntos se um demorar mais que o intervalo. */
  private ocupado = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly importador: WcFotosImportService,
    private readonly autoPublicar: AutoPublicarService,
  ) {}

  /**
   * Monta a fila e abre o job.
   *
   * A FILA NASCE DO SITE ANTIGO (invertido em 06/08, pedido do dono): antes
   * ela varria as ~21 mil REFs do catálogo perguntando ao WordPress uma a
   * uma — e o acervo de lá não tem nem 10% disso, então 90% dos ciclos era
   * "site antigo não tem esta peça". Agora uma query lista o que o WordPress
   * TEM, e entra na fila só o que também existe no catálogo com estoque.
   *
   * `apenasSemFoto` (padrão) descarta as REFs que já têm qualquer foto — numa
   * segunda rodada isso corta a fila em quase tudo e economiza horas.
   */
  async iniciar(opcoes: { apenasSemFoto?: boolean; limite?: number; usuario?: string } = {}) {
    const emAndamento = await (this.prisma as any).fotoImportJob.findFirst({
      where: { status: 'rodando' },
    });
    if (emAndamento) {
      throw new BadRequestException('Já existe uma importação rodando. Acompanhe ou cancele antes.');
    }

    // O que o site antigo tem (lança erro claro com o WordPress fora).
    const doSiteAntigo = await this.importador.refsDoSiteAntigo();

    // Só REF com estoque: importar foto de peça que não existe mais na arara é
    // gastar banda do servidor do site antigo à toa.
    const linhas = await this.prisma.$queryRawUnsafe<Array<{ ref: string }>>(
      `SELECT DISTINCT UPPER(TRIM(p.ref)) AS ref
         FROM wincred_produtos p
         JOIN (SELECT codigo, SUM(COALESCE(estoque,0)) AS total
                 FROM wincred_estoque GROUP BY codigo) e ON e.codigo = p.codigo
        WHERE p.ref IS NOT NULL AND TRIM(p.ref) <> '' AND e.total > 0
        ORDER BY 1`,
    );
    const comEstoque = linhas.map((l) => l.ref).filter(Boolean);
    const exatas = new Set(comEstoque);
    // A REF do site antigo costuma ser a BASE da família ("VMS-223") enquanto
    // o catálogo guarda as variações ("VMS-223 MA") — casa pelos dois lados.
    const bases = new Set(comEstoque.map((r) => refBaseOf(r)).filter(Boolean));
    let refs = doSiteAntigo.filter((r) => exatas.has(r) || bases.has(r));
    const foraDoCatalogo = doSiteAntigo.length - refs.length;

    if (opcoes.apenasSemFoto !== false) {
      const comFoto = await (this.prisma as any).productPhoto.findMany({
        distinct: ['ref'], select: { ref: true },
      });
      const ja = new Set(comFoto.map((f: any) => String(f.ref).toUpperCase()));
      refs = refs.filter((r) => !ja.has(r) && !ja.has(refBaseOf(r)));
    }
    refs.sort();
    if (opcoes.limite && opcoes.limite > 0) refs = refs.slice(0, opcoes.limite);
    if (!refs.length) {
      throw new BadRequestException(
        'Nenhuma REF pra importar — o que o site antigo tem (e ainda tem estoque) já tem foto aqui.',
      );
    }
    this.logger.log(
      `[import-lote] site antigo: ${doSiteAntigo.length} REF(s) · na fila: ${refs.length} · ` +
        `fora do catálogo/sem estoque: ${foraDoCatalogo}`,
    );

    const job = await (this.prisma as any).fotoImportJob.create({
      data: {
        refs: JSON.stringify(refs),
        total: refs.length,
        criadoPor: opcoes.usuario ?? null,
      },
    });
    this.logger.log(`[import-lote] job ${job.id} aberto com ${refs.length} REF(s)`);
    return this.status();
  }

  async cancelar() {
    await (this.prisma as any).fotoImportJob.updateMany({
      where: { status: 'rodando' },
      data: { status: 'cancelado' },
    });
    return this.status();
  }

  /** O que a tela mostra — sem a fila inteira, que pode ter milhares de itens. */
  async status() {
    const job = await (this.prisma as any).fotoImportJob.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!job) return { existe: false };

    let problemas: any[] = [];
    try { problemas = JSON.parse(job.problemas || '[]'); } catch { problemas = []; }

    return {
      existe: true,
      id: job.id,
      status: job.status,
      total: job.total,
      processadas: job.indice,
      restantes: Math.max(0, job.total - job.indice),
      fotos: job.fotos,
      bolinhas: job.bolinhas,
      refsComFoto: job.refsComFoto,
      // Foto no banco ≠ peça no site. A tela mostra os dois números porque
      // foi exatamente a diferença entre eles que passou despercebida.
      publicadas: job.publicadas,
      semEstoque: job.semEstoque,
      refAtual: job.refAtual,
      problemas: problemas.slice(-30),
      atualizadoEm: job.updatedAt,
    };
  }

  /**
   * O motor. Roda sozinho a cada ciclo e pega o job aberto — é isto que faz a
   * importação sobreviver a deploy: não existe "processo do lote", existe um
   * cursor no banco que qualquer instância continua.
   */
  @Interval(CICLO_MS)
  async processar() {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      const job = await (this.prisma as any).fotoImportJob.findFirst({
        where: { status: 'rodando' },
        orderBy: { createdAt: 'asc' },
      });
      if (!job) return;

      let refs: string[] = [];
      try { refs = JSON.parse(job.refs || '[]'); } catch { refs = []; }

      if (job.indice >= refs.length) {
        await (this.prisma as any).fotoImportJob.update({
          where: { id: job.id },
          data: { status: 'concluido', refAtual: null },
        });
        this.logger.log(`[import-lote] job ${job.id} concluído: ${job.fotos} foto(s)`);
        return;
      }

      let problemas: any[] = [];
      try { problemas = JSON.parse(job.problemas || '[]'); } catch { problemas = []; }

      let { indice, fotos, bolinhas, refsComFoto, publicadas, semEstoque } = job;

      for (let n = 0; n < POR_CICLO && indice < refs.length; n++) {
        const ref = refs[indice];
        try {
          const r = await this.importador.importarRef(ref, job.criadoPor ?? undefined);
          fotos += r.fotos;
          if (r.fotos > 0) refsComFoto += 1;
          // A bolinha é pintada dentro do importador; aqui só contabiliza o
          // que ganhou foto agora, que é o que ganhou bolinha.
          bolinhas += r.coresComFoto.length;

          /**
           * 🔴 IMPORTOU = VAI PRO SITE (07/08).
           *
           * Faltava esta linha, e era ela que fazia o dono olhar 3.517 fotos
           * importadas e não achar UMA peça na busca: a foto entrava, a
           * curadoria `site_produto.publicado` continuava falsa, e a vitrine
           * ignorava tudo. `aoImportarEmMassa` segura só quem está sem
           * estoque — peça esgotada não precisa entrar na vitrine agora.
           *
           * Vale pras cores que JÁ TINHAM foto também: a REF pode ter sido
           * importada numa rodada anterior (quando ninguém publicava) e estar
           * parada até hoje. Sem isso o conserto não alcançaria o passivo.
           */
          const coresNoAr = [...new Set([...r.coresComFoto, ...r.jaTinham])];
          const desfecho = await this.autoPublicar.aoImportarEmMassa(ref, coresNoAr);
          if (desfecho === 'publicada') publicadas += 1;
          else if (desfecho === 'sem_estoque') semEstoque += 1;

          if (r.produtosEncontrados === 0) {
            problemas.push({ ref, motivo: 'site antigo não tem esta peça' });
          } else if (desfecho === 'sem_estoque') {
            problemas.push({ ref, motivo: 'tem foto, mas está sem estoque — fora do site' });
          } else if (r.produtosWcSemCor.length) {
            problemas.push({ ref, motivo: `${r.produtosWcSemCor.length} produto(s) sem cor casada` });
          }
        } catch (e: any) {
          problemas.push({ ref, motivo: String(e?.message || e).slice(0, 120) });
        }
        indice += 1;

        await (this.prisma as any).fotoImportJob.update({
          where: { id: job.id },
          data: {
            indice, fotos, bolinhas, refsComFoto, publicadas, semEstoque,
            refAtual: ref,
            problemas: JSON.stringify(problemas.slice(-MAX_PROBLEMAS)),
          },
        });
      }
    } catch (e: any) {
      this.logger.warn(`[import-lote] ciclo falhou: ${e?.message || e}`);
    } finally {
      this.ocupado = false;
    }
  }
}
