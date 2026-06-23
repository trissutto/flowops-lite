import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceiroService } from './financeiro.service';
import { RealignmentReportService } from '../realignment/realignment-report.service';

/**
 * ContaCorrenteService — conta corrente da FRANQUEADA.
 *
 * Há UMA franqueada só (todas as lojas FILIAL = mesmo dono), então é uma conta
 * única que soma todas as FILIAL.
 *
 * - DÉBITOS (o que ela deve): calculados na hora — MERCADORIA vem do RELATÓRIO
 *   de transferências (mesma fonte da aba "Análise", preço VENDAUN em reais ÷2,5,
 *   líquida do que ela mandou pra rede) + royalties 8% + marketing 4%. NÃO usa a
 *   tabela InterStoreObligation (está com bug de preço ÷100).
 * - CRÉDITOS/AJUSTES (manuais): tabela FranquiaLancamento — pagamentos da
 *   franqueada (com comprovante) e ajustes manuais.
 * - SALDO = total débitos − total créditos (quanto a franqueada ainda deve).
 *
 * A conta corrente é a FONTE DE VERDADE dos pagamentos: o débito conta a dívida
 * CHEIA (todas as obrigações não-canceladas, independente do status "paid" do
 * outro fluxo) e os pagamentos vêm só dos lançamentos manuais — evita
 * double-count entre os dois mecanismos.
 */
@Injectable()
export class ContaCorrenteService {
  private readonly logger = new Logger(ContaCorrenteService.name);
  private r2ClientCache: S3Client | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly financeiro: FinanceiroService,
    private readonly report: RealignmentReportService,
  ) {}

  // ── R2 (reaproveita o padrão de seller-documents/product-photos) ──────────
  private getR2Client(): S3Client {
    if (this.r2ClientCache) return this.r2ClientCache;
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secret = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKey || !secret) {
      throw new BadRequestException(
        'R2 não configurado (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).',
      );
    }
    this.r2ClientCache = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: accessKey, secretAccessKey: secret },
    });
    return this.r2ClientCache;
  }

  private sanitizeFilename(name: string): string {
    return String(name || 'documento')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_');
  }

  // ── Débito do mês (consome 100% do cálculo que o sistema já faz) ──────────
  private async debitoDoMes(mes: string): Promise<{
    mes: string;
    mercadoria: number;
    royalties: number;
    marketing: number;
    total: number;
  }> {
    const [y, m] = mes.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const fromStr = `${mes}-01`;
    const toStr = `${mes}-${String(lastDay).padStart(2, '0')}`;

    // MERCADORIA — usa a MESMA fonte da aba "Análise" (relatório), que precifica
    // VENDAUN como REAIS (correto). NÃO usa a tabela InterStoreObligation porque
    // ela está com o bug de preço ÷100 (ex: 566 peças "preço total R$ 1.073" =
    // R$ 1,90/peça), o que zerava/encolhia a mercadoria. A franqueada DEVE pelo
    // que recebeu da rede (redeToFilial) e é CREDITADA pelo que mandou de volta
    // (filialToRede), tudo a custo ÷2,5.
    let mercadoria = 0;
    try {
      const rep = await this.report.getRedeFranquiaSummary('custom', fromStr, toStr);
      mercadoria =
        (rep.flows.redeToFilial.valorCusto || 0) - (rep.flows.filialToRede.valorCusto || 0);
    } catch (e: any) {
      this.logger.warn(`[conta-corrente] mercadoria ${mes} indisponível: ${e?.message || e}`);
    }

    // Royalties 8% + marketing 4% (já calculados pelo FinanceiroService a partir
    // da venda bruta no Giga). Se o Giga estiver fora, o circuit-breaker faz
    // retornar 0 sem travar — degrada só essa parte.
    let royalties = 0;
    let marketing = 0;
    try {
      const r = await this.financeiro.getRoyaltiesByMonth(mes);
      royalties = r.totalRoyalties || 0;
      marketing = r.totalMarketing || 0;
    } catch (e: any) {
      this.logger.warn(`[conta-corrente] royalties ${mes} indisponível: ${e?.message || e}`);
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      mes,
      mercadoria: round(mercadoria),
      royalties: round(royalties),
      marketing: round(marketing),
      total: round(mercadoria + royalties + marketing),
    };
  }

  /** Lista de meses "YYYY-MM" entre duas datas (inclusive). */
  private mesesEntre(from: Date, to: Date): string[] {
    const out: string[] = [];
    let y = from.getUTCFullYear();
    let m = from.getUTCMonth();
    const ey = to.getUTCFullYear();
    const em = to.getUTCMonth();
    let guard = 0;
    while ((y < ey || (y === ey && m <= em)) && guard < 240) {
      out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
      m++;
      if (m > 11) {
        m = 0;
        y++;
      }
      guard++;
    }
    return out;
  }

  private brl(n: number): string {
    return 'R$ ' + (Number(n) || 0).toFixed(2).replace('.', ',');
  }

  // ── Extrato (a conta corrente) ────────────────────────────────────────────
  async extrato(input: { from?: string; to?: string }) {
    const to = input.to ? new Date(input.to) : new Date();
    // default: últimos 6 meses
    const from = input.from
      ? new Date(input.from)
      : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 5, 1));
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Datas inválidas');
    }

    const linhas: any[] = [];
    let totalDebitos = 0;
    let totalCreditos = 0;

    // DÉBITOS automáticos — 1 linha por mês, datada no vencimento (dia 1 do mês
    // seguinte, igual a regra das obrigações).
    for (const mes of this.mesesEntre(from, to)) {
      const d = await this.debitoDoMes(mes);
      if (Math.abs(d.total) < 0.005) continue;
      const [y, mm] = mes.split('-').map(Number);
      const vencimento = new Date(Date.UTC(y, mm, 1)); // 1º dia do mês seguinte
      linhas.push({
        id: `auto-${mes}`,
        data: vencimento.toISOString(),
        tipo: 'debito_sistema',
        natureza: 'debito',
        descricao:
          `Acerto ${mes} — mercadoria ${this.brl(d.mercadoria)} + ` +
          `royalties ${this.brl(d.royalties)} + marketing ${this.brl(d.marketing)}`,
        valor: d.total,
        detalhe: d,
        documentoUrl: null,
        documentoNome: null,
        editavel: false,
      });
      totalDebitos += d.total;
    }

    // LANÇAMENTOS manuais (pagamentos + ajustes) no período.
    const lancs = await (this.prisma as any).franquiaLancamento.findMany({
      where: { data: { gte: from, lte: to } },
      orderBy: { data: 'asc' },
    });
    for (const l of lancs as any[]) {
      const valor = (l.valorCents || 0) / 100;
      if (l.natureza === 'debito') totalDebitos += valor;
      else totalCreditos += valor;
      linhas.push({
        id: l.id,
        data: l.data,
        tipo: l.tipo, // 'pagamento' | 'ajuste'
        natureza: l.natureza, // 'credito' | 'debito'
        descricao: l.descricao,
        valor,
        documentoUrl: l.documentoUrl || null,
        documentoNome: l.documentoNome || null,
        criadoPorNome: l.criadoPorNome || null,
        editavel: true,
      });
    }

    // Ordena por data e calcula o SALDO corrente (quanto a franqueada deve).
    linhas.sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());
    let saldo = 0;
    for (const ln of linhas) {
      saldo += ln.natureza === 'debito' ? ln.valor : -ln.valor;
      ln.saldo = Math.round(saldo * 100) / 100;
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      linhas,
      totalDebitos: round(totalDebitos),
      totalCreditos: round(totalCreditos),
      saldo: round(saldo), // > 0 = franqueada deve; < 0 = crédito a favor dela
    };
  }

  // ── Lançamento manual (com documento opcional) ────────────────────────────
  async criarLancamento(
    input: {
      data?: string;
      tipo: string;
      natureza?: string;
      descricao: string;
      valor: number;
    },
    file: any,
    user: { id?: string | null; nome?: string | null },
  ) {
    const tipo = String(input.tipo || 'pagamento').toLowerCase();
    if (!['pagamento', 'ajuste'].includes(tipo)) {
      throw new BadRequestException("tipo deve ser 'pagamento' ou 'ajuste'");
    }
    // Pagamento é sempre CRÉDITO (reduz o que a franqueada deve). Ajuste escolhe.
    const natureza =
      tipo === 'pagamento' ? 'credito' : String(input.natureza || 'debito').toLowerCase();
    if (!['credito', 'debito'].includes(natureza)) {
      throw new BadRequestException("natureza deve ser 'credito' ou 'debito'");
    }
    const valor = Number(input.valor);
    if (!valor || valor <= 0) throw new BadRequestException('valor deve ser > 0');
    if (!input.descricao || !input.descricao.trim()) {
      throw new BadRequestException('descrição obrigatória');
    }

    let documentoUrl: string | null = null;
    let documentoNome: string | null = null;
    if (file) {
      const up = await this.uploadDoc(file);
      documentoUrl = up.url;
      documentoNome = up.nome;
    }

    const dataLanc = input.data ? new Date(input.data) : new Date();
    if (isNaN(dataLanc.getTime())) throw new BadRequestException('data inválida');

    const l = await (this.prisma as any).franquiaLancamento.create({
      data: {
        data: dataLanc,
        tipo,
        natureza,
        descricao: input.descricao.trim(),
        valorCents: Math.round(valor * 100),
        documentoUrl,
        documentoNome,
        criadoPorId: user.id || null,
        criadoPorNome: user.nome || null,
      },
    });
    this.logger.log(
      `[conta-corrente] lançamento ${tipo}/${natureza} R$${valor.toFixed(2)} ` +
        `(${l.id})${documentoUrl ? ' +doc' : ''}`,
    );
    return l;
  }

  async removerLancamento(id: string) {
    const l = await (this.prisma as any).franquiaLancamento.findUnique({ where: { id } });
    if (!l) throw new NotFoundException('Lançamento não encontrado');
    if (l.documentoUrl) {
      try {
        await this.deleteDoc(l.documentoUrl);
      } catch (e: any) {
        this.logger.warn(`[conta-corrente] falha ao apagar doc do R2: ${e?.message || e}`);
      }
    }
    await (this.prisma as any).franquiaLancamento.delete({ where: { id } });
    return { ok: true, id };
  }

  private async uploadDoc(file: any): Promise<{ url: string; nome: string }> {
    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!bucket || !publicUrl) {
      throw new BadRequestException('R2_BUCKET_NAME ou R2_PUBLIC_URL não configurado.');
    }
    const safe = this.sanitizeFilename(file.originalname || 'documento');
    const key = `franquia/conta-corrente/${Date.now()}-${safe}`;
    await this.getR2Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype || 'application/octet-stream',
        ContentDisposition: `inline; filename="${file.originalname || safe}"`,
      }),
    );
    return {
      url: `${publicUrl.replace(/\/$/, '')}/${key}`,
      nome: file.originalname || safe,
    };
  }

  private async deleteDoc(url: string): Promise<void> {
    const bucket = process.env.R2_BUCKET_NAME;
    const publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    if (!bucket || !publicUrl || !url.startsWith(publicUrl)) return;
    const key = url.slice(publicUrl.length + 1);
    await this.getR2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
