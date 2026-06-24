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
import { GigaBreaker } from '../common/giga-breaker';

/**
 * Item de detalhe de um débito de mercadoria. Além do `label` (compat), carrega
 * origem/destino/tipo/peças pra montar a árvore em cascata (REDE/FRANQUIA →
 * cidade que enviou → cidades destino) no front. Royalties não preenchem os
 * campos opcionais → caem na lista simples.
 */
type DetalheItem = {
  label: string;
  valor: number;
  sinal: string;
  from?: string;
  to?: string;
  fromTipo?: string;
  toTipo?: string;
  pecas?: number;
  // Nível mais fundo da cascata: as transferências (1 por CONTROLE) que compõem
  // o par origem→destino. valor já em custo (÷2,5).
  transfers?: Array<{ data: string; controle: string; pecas: number; valor: number }>;
};

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

  /**
   * Corre uma promise contra um timeout. Se estourar, devolve `fallback` (e loga)
   * em vez de pendurar. Os "works" internos nunca rejeitam (têm try/catch), então
   * só o timeout pode disparar — garante que o extrato sempre responde.
   */
  private async withTimeout<T>(work: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        this.logger.error(`[conta-corrente] ${label} excedeu ${ms}ms — usando fallback (0)`);
        resolve(fallback);
      }, ms);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Débito do mês (consome 100% do cálculo que o sistema já faz) ──────────
  private async debitoDoMes(mes: string): Promise<{
    mes: string;
    mercadoriaGiga: number;
    mercadoriaFlow: number;
    royalties: number;
    marketing: number;
    total: number;
    detalheGiga: DetalheItem[];
    detalheFlow: DetalheItem[];
    detalheRoy: DetalheItem[];
    ok: boolean; // false = Giga falhou/indisponível neste mês (não confiar nos 0)
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
      let ok = true;
      const detalhe: DetalheItem[] = [];
      try {
        const rows = await this.erp.getGigaTransfersDetailed(
          new Date(`${fromStr}T00:00:00Z`),
          new Date(`${toStr}T23:59:59Z`),
        );
        // Agrupa as transferências (uma por CONTROLE) por par origem→destino,
        // guardando a lista pro nível mais fundo da cascata.
        const pares = new Map<
          string,
          {
            origem: string;
            destino: string;
            qty: number;
            totalPreco: number;
            transfers: Array<{ data: string; controle: string; pecas: number; valor: number }>;
          }
        >();
        for (const r of rows) {
          const key = `${r.origem}->${r.destino}`;
          let p = pares.get(key);
          if (!p) {
            p = { origem: r.origem, destino: r.destino, qty: 0, totalPreco: 0, transfers: [] };
            pares.set(key, p);
          }
          p.qty += r.qty;
          p.totalPreco += r.totalPreco;
          p.transfers.push({ data: r.data, controle: r.controle, pecas: r.qty, valor: round(r.totalPreco / 2.5) });
        }

        let recebeu = 0;
        let mandou = 0;
        for (const p of pares.values()) {
          const oFil = tipoOf(p.origem) === 'FILIAL';
          const dFil = tipoOf(p.destino) === 'FILIAL';
          const vc = round(p.totalPreco / 2.5);
          // transferências por data crescente, depois maior valor
          const transfers = p.transfers.sort(
            (a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0) || b.valor - a.valor,
          );
          const base = {
            label: `${nomeOf(p.origem)} → ${nomeOf(p.destino)} · ${p.qty} pç`,
            valor: vc,
            from: nomeOf(p.origem),
            to: nomeOf(p.destino),
            fromTipo: tipoOf(p.origem),
            toTipo: tipoOf(p.destino),
            pecas: p.qty,
            transfers,
          };
          if (!oFil && dFil) {
            recebeu += p.totalPreco; // REDE → FRANQUIA (soma)
            detalhe.push({ ...base, sinal: '+' });
          } else if (oFil && !dFil) {
            mandou += p.totalPreco; // FRANQUIA → REDE (abate)
            detalhe.push({ ...base, sinal: '-' });
          }
        }
        valor = (recebeu - mandou) / 2.5;
      } catch (e: any) {
        ok = false;
        this.logger.warn(`[conta-corrente] mercadoria GIGA ${mes} indisponível: ${e?.message || e}`);
      }
      detalhe.sort((a, b) => b.valor - a.valor);
      return { valor, detalhe, ok };
    })();

    // FLOW DESLIGADO: era um cross-check redundante (a mercadoria REAL já vem do
    // gigaWork, direto da tabela `transferencias` numa query só). Ele usava o
    // pool de pricing (connectionLimit 2, queries em chunk) — o gargalo que
    // travava o extrato — e na prática vinha sempre 0. Mantido como 0 fixo; se um
    // dia precisar do cross-check, reativar SEM bater no pricing por mês.
    const flow = { valor: 0, detalhe: [] as DetalheItem[] };

    const royWork = (async () => {
      let royalties = 0;
      let marketing = 0;
      let ok = true;
      const detalhe: DetalheItem[] = [];
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
        ok = false;
        this.logger.warn(`[conta-corrente] royalties ${mes} indisponível: ${e?.message || e}`);
      }
      detalhe.sort((a, b) => b.valor - a.valor);
      return { royalties, marketing, detalhe, ok };
    })();

    // Giga (mercadoria) e royalties são os débitos REAIS — 1 query cada no pool
    // do ERP. Rodam juntos (2 conexões, tranquilo) com time-box generoso só pra
    // o endpoint nunca pendurar numa query presa.
    const [giga, roy] = await Promise.all([
      this.withTimeout(gigaWork, 15_000, { valor: 0, detalhe: [] as DetalheItem[], ok: false }, `mercadoria GIGA ${mes}`),
      this.withTimeout(royWork, 15_000, { royalties: 0, marketing: 0, detalhe: [] as DetalheItem[], ok: false }, `royalties ${mes}`),
    ]);

    // ok = as DUAS fontes responderam E o circuit-breaker não está aberto. Se
    // falhou, os 0 NÃO são reais (é indisponibilidade) → marca ok=false, a tela
    // avisa, e NÃO cacheia (senão um blip "trava" o 0 por 60s; refresh resolve).
    const ok = giga.ok && roy.ok && !GigaBreaker.isOpen();

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
      ok,
    };
    if (ok) this.debitoCache.set(mes, { at: Date.now(), data });
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
      detalhe?: DetalheItem[],
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
    // Meses em SÉRIE de propósito: 1 mês por vez = no máximo 2 conexões ao Giga
    // simultâneas (giga + roy). Paralelizar os meses dispara um BURST de conexões
    // que o servidor do Giga recusa → o circuit-breaker abre → tudo vem 0. Sem o
    // flowWork (que era o lento), cada mês é só 2 queries rápidas, então série já
    // é veloz e segura. NÃO paralelizar os meses.
    const mesesIndisponiveis: string[] = [];
    for (const mes of this.mesesEntre(from, to)) {
      const d = await this.debitoDoMes(mes);
      if (!d.ok) mesesIndisponiveis.push(mes);
      pushAuto(mes, `Mercadoria GIGA — ${mes}`, 'giga', d.mercadoriaGiga, d.detalheGiga);
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
      // Avisa a tela: a busca do Giga falhou em ao menos 1 mês → mercadoria/
      // royalties podem estar INCOMPLETOS (não são 0 reais). Refresh tenta de novo.
      gigaIndisponivel: mesesIndisponiveis.length > 0,
      mesesIndisponiveis,
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
