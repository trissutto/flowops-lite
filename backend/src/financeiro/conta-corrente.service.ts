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
import { ErpService } from '../erp/erp.service';

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

  // Cache do débito por mês (TTL curto). O extrato bate no Giga (transferências
  // + caixa + preços do relatório) por mês — caro, pela internet. Cachear evita
  // re-bater o Giga em re-loads / troca de datas (mata o "às vezes trava").
  private debitoCache = new Map<string, { at: number; data: any }>();
  private readonly DEBITO_TTL_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly financeiro: FinanceiroService,
    private readonly report: RealignmentReportService,
    private readonly erp: ErpService,
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
    mercadoriaGiga: number;
    mercadoriaFlow: number;
    royalties: number;
    marketing: number;
    total: number;
    detalheGiga: Array<{ label: string; valor: number; sinal: string }>;
    detalheFlow: Array<{ label: string; valor: number; sinal: string }>;
    detalheRoy: Array<{ label: string; valor: number; sinal: string }>;
  }> {
    // Cache: meses (sobretudo passados) não mudam toda hora. Re-load / troca de
    // datas fica instantâneo e não re-bate o Giga.
    const cached = this.debitoCache.get(mes);
    if (cached && Date.now() - cached.at < this.DEBITO_TTL_MS) return cached.data;

    const [y, m] = mes.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const fromStr = `${mes}-01`;
    const toStr = `${mes}-${String(lastDay).padStart(2, '0')}`;
    const round = (n: number) => Math.round(n * 100) / 100;

    // Tipo + nome por loja (Postgres, rápido). Normaliza zero à esquerda pra casar
    // LJ_ORIGEM/DESTINO char(2) do Giga ('01','07') com o Store.code do Flow.
    const stores = await this.prisma.store.findMany({
      select: { code: true, tipo: true, name: true } as any,
    });
    const norm = (c: any) => String(c ?? '').trim().padStart(2, '0');
    const tipoMap = new Map<string, string>();
    const nameMap = new Map<string, string>();
    for (const s of stores as any[]) {
      tipoMap.set(norm(s.code), s.tipo === 'FILIAL' ? 'FILIAL' : 'REDE');
      nameMap.set(norm(s.code), s.name || s.code);
    }
    const tipoOf = (code: string) => tipoMap.get(norm(code)) || 'REDE';
    const nomeOf = (code: string) => nameMap.get(norm(code)) || String(code);

    // As 3 fontes batem no Giga (transferências, relatório/preços, caixa) e são
    // INDEPENDENTES → rodam em PARALELO pra cortar a latência (era sequencial).
    const gigaWork = (async () => {
      let valor = 0;
      const detalhe: Array<{ label: string; valor: number; sinal: string }> = [];
      try {
        const transf = await this.erp.getGigaTransfersByPair(
          new Date(`${fromStr}T00:00:00Z`),
          new Date(`${toStr}T23:59:59Z`),
        );
        let recebeu = 0;
        let mandou = 0;
        for (const t of transf) {
          const oFil = tipoOf(t.origem) === 'FILIAL';
          const dFil = tipoOf(t.destino) === 'FILIAL';
          const vc = round(t.totalPreco / 2.5);
          if (!oFil && dFil) {
            recebeu += t.totalPreco; // REDE → FRANQUIA (soma)
            detalhe.push({ label: `${nomeOf(t.origem)} → ${nomeOf(t.destino)} · ${t.qty} pç`, valor: vc, sinal: '+' });
          } else if (oFil && !dFil) {
            mandou += t.totalPreco; // FRANQUIA → REDE (abate)
            detalhe.push({ label: `${nomeOf(t.origem)} → ${nomeOf(t.destino)} · ${t.qty} pç`, valor: vc, sinal: '-' });
          }
        }
        valor = (recebeu - mandou) / 2.5;
      } catch (e: any) {
        this.logger.warn(`[conta-corrente] mercadoria GIGA ${mes} indisponível: ${e?.message || e}`);
      }
      detalhe.sort((a, b) => b.valor - a.valor);
      return { valor, detalhe };
    })();

    const flowWork = (async () => {
      let valor = 0;
      const detalhe: Array<{ label: string; valor: number; sinal: string }> = [];
      try {
        const rep = await this.report.getRedeFranquiaSummary('custom', fromStr, toStr);
        valor = (rep.flows.redeToFilial.valorCusto || 0) - (rep.flows.filialToRede.valorCusto || 0);
        for (const p of (((rep as any).pairs as any[]) || [])) {
          if (p.direction === 'redeToFilial') {
            detalhe.push({ label: `${p.fromName} → ${p.toName} · ${p.pecas} pç`, valor: round(p.valorCusto), sinal: '+' });
          } else if (p.direction === 'filialToRede') {
            detalhe.push({ label: `${p.fromName} → ${p.toName} · ${p.pecas} pç`, valor: round(p.valorCusto), sinal: '-' });
          }
        }
      } catch (e: any) {
        this.logger.warn(`[conta-corrente] mercadoria FLOW ${mes} indisponível: ${e?.message || e}`);
      }
      detalhe.sort((a, b) => b.valor - a.valor);
      return { valor, detalhe };
    })();

    const royWork = (async () => {
      let royalties = 0;
      let marketing = 0;
      const detalhe: Array<{ label: string; valor: number; sinal: string }> = [];
      try {
        const r = await this.financeiro.getRoyaltiesByMonth(mes);
        royalties = r.totalRoyalties || 0;
        marketing = r.totalMarketing || 0;
        for (const f of (((r as any).porFilial as any[]) || [])) {
          const tot = (f.royaltiesValor || 0) + (f.marketingValor || 0);
          if (tot <= 0.005) continue;
          detalhe.push({ label: `${f.storeName || f.storeCode} · venda ${this.brl(f.vendaBruta || 0)}`, valor: round(tot), sinal: '+' });
        }
      } catch (e: any) {
        this.logger.warn(`[conta-corrente] royalties ${mes} indisponível: ${e?.message || e}`);
      }
      detalhe.sort((a, b) => b.valor - a.valor);
      return { royalties, marketing, detalhe };
    })();

    const [giga, flow, roy] = await Promise.all([gigaWork, flowWork, royWork]);

    const data = {
      mes,
      mercadoriaGiga: round(giga.valor),
      mercadoriaFlow: round(flow.valor),
      royalties: round(roy.royalties),
      marketing: round(roy.marketing),
      total: round(giga.valor + flow.valor + roy.royalties + roy.marketing),
      detalheGiga: giga.detalhe,
      detalheFlow: flow.detalhe,
      detalheRoy: roy.detalhe,
    };
    this.debitoCache.set(mes, { at: Date.now(), data });
    return data;
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

    // DÉBITOS automáticos — SEPARADOS POR SISTEMA (GIGA × FLOW) + royalties.
    // Datados no vencimento (dia 1 do mês seguinte). Valor negativo (a franquia
    // devolveu mais do que recebeu da rede) vira CRÉDITO.
    const pushAuto = (
      mesRef: string,
      descricao: string,
      sistema: string,
      valor: number,
      detalhe?: Array<{ label: string; valor: number; sinal: string }>,
    ) => {
      if (Math.abs(valor) < 0.005) return;
      const [yy, mm] = mesRef.split('-').map(Number);
      const vencimento = new Date(Date.UTC(yy, mm, 1)).toISOString();
      const natureza = valor >= 0 ? 'debito' : 'credito';
      linhas.push({
        id: `auto-${mesRef}-${sistema}`,
        data: vencimento,
        tipo: 'debito_sistema',
        natureza,
        sistema,
        descricao,
        valor: Math.abs(valor),
        documentoUrl: null,
        documentoNome: null,
        editavel: false,
        detalhe: detalhe && detalhe.length ? detalhe : undefined,
      });
      if (natureza === 'debito') totalDebitos += Math.abs(valor);
      else totalCreditos += Math.abs(valor);
    };
    for (const mes of this.mesesEntre(from, to)) {
      const d = await this.debitoDoMes(mes);
      pushAuto(mes, `Mercadoria GIGA — ${mes}`, 'giga', d.mercadoriaGiga, d.detalheGiga);
      pushAuto(mes, `Mercadoria Flow — ${mes}`, 'flow', d.mercadoriaFlow, d.detalheFlow);
      pushAuto(mes, `Royalties 8% + Marketing 4% — ${mes}`, 'royalties', d.royalties + d.marketing, d.detalheRoy);
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
