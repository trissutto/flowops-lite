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
import { GigaMirrorService } from './giga-mirror.service';

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
    private readonly mirror: GigaMirrorService,
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
        // Lê do ESPELHO (Postgres), não do Giga ao vivo — instantâneo e sem blip.
        const mrows = await (this.prisma as any).gigaTransferencia.findMany({
          where: { data: { gte: new Date(`${fromStr}T00:00:00Z`), lte: new Date(`${toStr}T00:00:00Z`) } },
        });
        const rows = (mrows as any[]).map((r) => ({
          origem: r.ljOrigem,
          destino: r.ljDestino,
          controle: r.controle,
          data: new Date(r.data).toISOString().slice(0, 10),
          qty: r.qty,
          totalPreco: r.totalPreco,
        }));
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

    // MERCADORIA FLOW: transferências do Flow (TRANSFERENCIA ponto a ponto +
    // REALINHAMENTO) RECEBIDAS no mês. Mesma cascata REDE↔FRANQUIA + ÷2,5 da
    // Giga. Lê SÓ do Postgres (remessas/itens/espelho de produtos) — NÃO bate no
    // pool de pricing (o gargalo que fez desligarem o flow antes).
    const flowWork = (async () => {
      let valor = 0;
      let ok = true;
      const detalhe: DetalheItem[] = [];
      try {
        const ships = await (this.prisma as any).realignmentShipment.findMany({
          where: {
            status: 'received',
            receivedAt: {
              gte: new Date(`${fromStr}T00:00:00Z`),
              lte: new Date(`${toStr}T23:59:59.999Z`),
            },
          },
          select: { id: true, code: true, fromStoreCode: true, toStoreCode: true, receivedAt: true },
        });
        if (ships.length) {
          const items = await (this.prisma as any).transferOrder.findMany({
            where: { shipmentId: { in: (ships as any[]).map((s) => s.id) } },
            select: { shipmentId: true, codigoBipado: true, qtyOrigem: true, precoUnitCents: true },
          });
          // Itens sem preço snapshot (realinhamento) → resolve pelo espelho giga_produto
          const faltam = Array.from(
            new Set(
              (items as any[])
                .filter((i) => !(i.precoUnitCents > 0) && i.codigoBipado)
                .map((i) => String(i.codigoBipado)),
            ),
          );
          const precoByCod = new Map<string, number>();
          if (faltam.length) {
            const gps = await (this.prisma as any).gigaProduto.findMany({
              where: { codigo: { in: faltam } },
              select: { codigo: true, vendaUn: true },
            });
            for (const g of gps as any[]) precoByCod.set(String(g.codigo), Math.round((Number(g.vendaUn) || 0) * 100));
          }
          // 1) agrega por REMESSA (REM-xxx): peças + valor cheio
          const shipAgg = new Map<string, { pecas: number; totalReais: number }>();
          for (const it of items as any[]) {
            const cents =
              it.precoUnitCents && it.precoUnitCents > 0
                ? it.precoUnitCents
                : precoByCod.get(String(it.codigoBipado)) || 0;
            const qty = it.qtyOrigem || 1;
            let a = shipAgg.get(it.shipmentId);
            if (!a) {
              a = { pecas: 0, totalReais: 0 };
              shipAgg.set(it.shipmentId, a);
            }
            a.pecas += qty;
            a.totalReais += (cents / 100) * qty;
          }
          // 2) agrupa por par origem→destino, guardando as remessas (5º nível)
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
          for (const s of ships as any[]) {
            const a = shipAgg.get(s.id);
            if (!a || a.pecas === 0) continue;
            const key = `${s.fromStoreCode}->${s.toStoreCode}`;
            let p = pares.get(key);
            if (!p) {
              p = { origem: s.fromStoreCode, destino: s.toStoreCode, qty: 0, totalPreco: 0, transfers: [] };
              pares.set(key, p);
            }
            p.qty += a.pecas;
            p.totalPreco += a.totalReais;
            p.transfers.push({
              data: s.receivedAt ? new Date(s.receivedAt).toISOString().slice(0, 10) : '',
              controle: s.code,
              pecas: a.pecas,
              valor: round(a.totalReais / 2.5),
            });
          }
          let recebeu = 0;
          let mandou = 0;
          for (const p of pares.values()) {
            const oFil = tipoOf(p.origem) === 'FILIAL';
            const dFil = tipoOf(p.destino) === 'FILIAL';
            const base = {
              label: `${nomeOf(p.origem)} → ${nomeOf(p.destino)} · ${p.qty} pç`,
              valor: round(p.totalPreco / 2.5),
              from: nomeOf(p.origem),
              to: nomeOf(p.destino),
              fromTipo: tipoOf(p.origem),
              toTipo: tipoOf(p.destino),
              pecas: p.qty,
              transfers: p.transfers.sort(
                (a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0) || b.valor - a.valor,
              ),
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
        }
      } catch (e: any) {
        ok = false;
        this.logger.warn(`[conta-corrente] mercadoria FLOW ${mes} indisponível: ${e?.message || e}`);
      }
      detalhe.sort((a, b) => b.valor - a.valor);
      return { valor, detalhe, ok };
    })();

    const royWork = (async () => {
      let royalties = 0;
      let marketing = 0;
      let ok = true;
      const detalhe: DetalheItem[] = [];
      try {
        // Lê do ESPELHO de caixa (Postgres). Venda bruta por FILIAL no mês →
        // royalties 8% + marketing 4% (mesma regra do FinanceiroService).
        const caixa = await (this.prisma as any).gigaCaixaDiario.findMany({
          where: { data: { gte: new Date(`${fromStr}T00:00:00Z`), lte: new Date(`${toStr}T00:00:00Z`) } },
        });
        const vendaPorLoja = new Map<string, number>();
        for (const c of caixa as any[]) {
          if (tipoOf(c.loja) !== 'FILIAL') continue;
          const code = norm(c.loja);
          vendaPorLoja.set(code, (vendaPorLoja.get(code) || 0) + (Number(c.bruto) || 0));
        }
        const ROY = 0.08;
        const MKT = 0.04;
        for (const [code, venda] of vendaPorLoja) {
          royalties += venda * ROY;
          marketing += venda * MKT;
          const tot = venda * (ROY + MKT);
          if (tot <= 0.005) continue;
          detalhe.push({ label: `${nomeOf(code)} · venda ${this.brl(venda)}`, valor: round(tot), sinal: '+' });
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
    const [giga, roy, flow] = await Promise.all([
      this.withTimeout(gigaWork, 15_000, { valor: 0, detalhe: [] as DetalheItem[], ok: false }, `mercadoria GIGA ${mes}`),
      this.withTimeout(royWork, 15_000, { royalties: 0, marketing: 0, detalhe: [] as DetalheItem[], ok: false }, `royalties ${mes}`),
      this.withTimeout(flowWork, 15_000, { valor: 0, detalhe: [] as DetalheItem[], ok: false }, `mercadoria FLOW ${mes}`),
    ]);

    // ok = as duas leituras do espelho (Postgres) deram certo. Leitura local não
    // dá blip; só marca falha se o Postgres em si der erro. Se !ok, não cacheia.
    const ok = giga.ok && roy.ok && flow.ok;

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
      pushAuto(mes, `Mercadoria FLOW — ${mes}`, 'flow', d.mercadoriaFlow, d.detalheFlow);
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

    // Estado do espelho do Giga (pra tela mostrar "sincronizado às HH:MM" e o
    // botão de sincronizar; pendente = espelho ainda não populado).
    let gigaSync: any = null;
    try {
      gigaSync = await this.mirror.getState();
    } catch {
      /* não bloqueia o extrato se o estado não vier */
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      linhas,
      totalDebitos: round(totalDebitos),
      totalCreditos: round(totalCreditos),
      saldo: round(saldo), // > 0 = franqueada deve; < 0 = crédito a favor dela
      // Falha de LEITURA do espelho (raro — Postgres). Diferente de espelho vazio.
      gigaIndisponivel: mesesIndisponiveis.length > 0,
      mesesIndisponiveis,
      gigaSync, // { lastOkAt, pendente, erro, transferenciaAt, caixaAt, syncing }
    };
  }

  /** Itens (peças/SKU) de uma transferência — 5º nível da cascata, sob demanda. */
  async getTransferItems(input: { controle?: string; data?: string }) {
    const controle = String(input.controle || '').trim();
    if (!controle) throw new BadRequestException('controle obrigatório');
    const round = (n: number) => Math.round(n * 100) / 100;
    // FLOW: remessa REM-xxx → itens do TransferOrder (não vive no espelho do Giga).
    // Agrega por código (peças + valor ÷2,5) pra exibir igual à Giga.
    if (/^REM-/i.test(controle)) {
      const ship = await (this.prisma as any).realignmentShipment.findFirst({
        where: { code: controle },
        select: { id: true },
      });
      if (!ship) return [];
      const orders = await (this.prisma as any).transferOrder.findMany({
        where: { shipmentId: ship.id },
        select: {
          codigoBipado: true,
          refCode: true,
          cor: true,
          tamanho: true,
          qtyOrigem: true,
          precoUnitCents: true,
        },
      });
      const faltam = Array.from(
        new Set(
          (orders as any[])
            .filter((o) => !(o.precoUnitCents > 0) && o.codigoBipado)
            .map((o) => String(o.codigoBipado)),
        ),
      );
      const precoByCod = new Map<string, number>();
      if (faltam.length) {
        const gps = await (this.prisma as any).gigaProduto.findMany({
          where: { codigo: { in: faltam } },
          select: { codigo: true, vendaUn: true },
        });
        for (const g of gps as any[]) precoByCod.set(String(g.codigo), Math.round((Number(g.vendaUn) || 0) * 100));
      }
      const agg = new Map<string, { codigo: string; descricao: string; pecas: number; valor: number }>();
      for (const o of orders as any[]) {
        const cents =
          o.precoUnitCents && o.precoUnitCents > 0
            ? o.precoUnitCents
            : precoByCod.get(String(o.codigoBipado)) || 0;
        const qty = o.qtyOrigem || 1;
        const codigo = String(o.codigoBipado || o.refCode || '');
        const k = `${codigo}|${o.cor || ''}|${o.tamanho || ''}`;
        let a = agg.get(k);
        if (!a) {
          a = { codigo, descricao: `${o.refCode || ''} ${o.cor || ''} ${o.tamanho || ''}`.trim(), pecas: 0, valor: 0 };
          agg.set(k, a);
        }
        a.pecas += qty;
        a.valor += round(((cents / 100) * qty) / 2.5);
      }
      return Array.from(agg.values()).sort((a, b) => b.valor - a.valor);
    }
    const where: any = { controle };
    if (input.data && /^\d{4}-\d{2}-\d{2}$/.test(input.data)) {
      where.data = new Date(`${input.data}T00:00:00Z`);
    }
    const items = await (this.prisma as any).gigaTransferenciaItem.findMany({
      where,
      orderBy: { totalPreco: 'desc' },
    });
    return (items as any[]).map((i) => ({
      codigo: i.codigo,
      descricao: i.descricao || '',
      pecas: i.qty,
      valor: round((i.totalPreco || 0) / 2.5), // custo ÷2,5, igual ao resto
    }));
  }

  /** Dispara o sync do espelho do Giga sob demanda (botão "Sincronizar agora"). */
  async sincronizarGiga() {
    const estado = await this.mirror.sync({ force: true });
    // Zera o cache de débito pra próxima leitura já refletir o espelho novo.
    this.debitoCache.clear();
    return estado;
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
