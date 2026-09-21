import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { donosDosPagamentos } from '../common/dono-do-pagamento';
import { classificarPagamentos } from './classificar-pagamentos';
import { facetarConciliacoes, filtrarLinhas, FiltrosConciliacao, LinhaResumo } from './facetas';
import { diaBrasiliaDe } from '../common/tz';

export interface ResultadoMotor {
  conciliadas: number;
  divergentes: number;
  semVenda: number;
  duplicadas: number;
  total: number;
  /** Quantas conciliações a rodada precisou escrever (as outras não mudaram). */
  gravadas: number;
}

/** Linha da base em memória: o que as facetas contam + o que a lista precisa pra paginar. */
interface LinhaDaTela extends LinhaResumo {
  id: string;
  /** Instante da venda em ms — só pra ordenar (mais nova primeiro). Sem data vai pro fim. */
  quando: number;
}

/**
 * CONCILIAÇÃO FINANCEIRA — FASE 2: importadores (aprovado 17/07).
 *
 * V1 varre as tabelas LOCAIS que os webhooks já mantêm frescas
 * (pagbank_payments, pagarme_payments, stone_transactions) e normaliza tudo
 * em financial_transactions — com raw_json + hash de integridade. As APIs de
 * extrato/recebíveis (financial_recebimentos) entram no próximo PR.
 *
 * Cron da hora (:25 — o que mexeu nos últimos 3 dias + motor), cron das 02:00
 * UTC = 23:00 de Brasília (varredura de 400 dias + motor), 90s depois de cada
 * deploy, e POST /conciliacao/importar manual. Idempotente: upsert por
 * (gateway, transactionId).
 */
@Injectable()
export class ConciliacaoService {
  private readonly logger = new Logger(ConciliacaoService.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 02:00 — importa E concilia. Até 20/09 o cron só importava: o veredito só
   * mudava quando alguém clicava "2. Conciliar", então a tela amanhecia com a
   * foto do último clique (e um conserto no motor não aparecia sozinho).
   */
  /**
   * TODA HORA (21/09) — pedido do dono ao ganhar o filtro por data: "Hoje" na
   * tela precisa ter o dia de hoje. Com só a rodada da noite, às 08h26 havia 3
   * PIX pagos no PagBank e 0 na conciliação. Importa só o que mexeu nos últimos
   * 3 dias (~130 cobranças; a das 02:00 segue varrendo tudo) e roda o motor,
   * que agora só escreve o que mudou.
   */
  @Cron('25 * * * *', { name: 'conciliacao-a-cada-hora' })
  async cronDaHora() {
    await this.atualizarRecentes('hora');
  }

  /** Importa o que mexeu nos últimos dias e concilia. Nunca lança: é cron. */
  async atualizarRecentes(quem: string) {
    try {
      await this.importarTudo(3);
      await this.conciliar();
    } catch (e) {
      this.logger.error(`[conciliacao] atualização (${quem}) falhou: ${(e as Error).message}`);
    }
  }

  @Cron('0 2 * * *', { name: 'conciliacao-importar-diario' })
  async cronDiario() {
    try {
      const r = await this.importarTudo();
      this.logger.log(`[conciliacao] importação diária: ${JSON.stringify(r)}`);
    } catch (e) {
      this.logger.error(`[conciliacao] importação diária falhou: ${(e as Error).message}`);
      return;
    }
    try {
      await this.conciliar();
    } catch (e) {
      this.logger.error(`[conciliacao] motor diário falhou: ${(e as Error).message}`);
    }
  }

  private hash(raw: any): string {
    return createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex');
  }

  private toCents(v: any): number | null {
    const n = Number(v);
    return isFinite(n) ? Math.round(n * 100) : null;
  }

  private async upsertTx(t: {
    gateway: string;
    transactionId: string;
    chargeId?: string | null;
    pedidoRef?: string | null;
    storeCode?: string | null;
    nsu?: string | null;
    authorizationCode?: string | null;
    statusGateway?: string | null;
    valorBrutoCents?: number | null;
    parcelas?: number | null;
    bandeira?: string | null;
    tipoPagamento?: string | null;
    cartaoFinal?: string | null;
    dataVenda?: Date | null;
    dataRecebimento?: Date | null;
    raw: any;
  }): Promise<void> {
    const data: any = {
      gateway: t.gateway,
      transactionId: t.transactionId,
      chargeId: t.chargeId || null,
      pedidoRef: t.pedidoRef || null,
      storeCode: t.storeCode || null,
      nsu: t.nsu || null,
      authorizationCode: t.authorizationCode || null,
      statusGateway: t.statusGateway || null,
      valorBrutoCents: t.valorBrutoCents ?? null,
      parcelas: t.parcelas ?? null,
      bandeira: t.bandeira || null,
      tipoPagamento: t.tipoPagamento || null,
      cartaoFinal: t.cartaoFinal || null,
      dataVenda: t.dataVenda || null,
      dataRecebimento: t.dataRecebimento || null,
      rawJson: t.raw ?? null,
      rawHash: this.hash(t.raw),
    };
    const existente: any = await (this.prisma as any).financialTransaction.findFirst({
      where: { gateway: t.gateway, transactionId: t.transactionId },
      select: { id: true, rawHash: true },
    });
    if (existente) {
      if (existente.rawHash !== data.rawHash) {
        await (this.prisma as any).financialTransaction.update({ where: { id: existente.id }, data });
      }
    } else {
      await (this.prisma as any).financialTransaction.create({ data });
    }
  }

  /** Varre as 3 fontes locais. `desdeDias` limita a janela (default 400 = backfill inicial). */
  async importarTudo(desdeDias = 400): Promise<{ pagbank: number; pagarme: number; stone: number }> {
    if (this.running) return { pagbank: 0, pagarme: 0, stone: 0 };
    this.running = true;
    const desde = new Date(Date.now() - desdeDias * 86400000);
    const out = { pagbank: 0, pagarme: 0, stone: 0 };
    try {
      // ── PagBank (PIX/cartão da live + PDV) ──
      const pb: any[] = await (this.prisma as any).pagbankPayment.findMany({
        where: { updatedAt: { gte: desde } },
      });
      for (const p of pb) {
        try {
          await this.upsertTx({
            gateway: 'PAGBANK',
            transactionId: String(p.pagbankOrderId),
            chargeId: p.pagbankChargeId || null,
            pedidoRef: p.saleId || null,
            storeCode: p.storeCode || null,
            statusGateway: p.status || null,
            valorBrutoCents: this.toCents(p.valor),
            tipoPagamento: p.method || null,
            dataVenda: p.createdAt || null,
            dataRecebimento: p.paidAt || null,
            raw: p.rawWebhook ? this.tryJson(p.rawWebhook) : { ...p, rawWebhook: undefined },
          });
          out.pagbank++;
        } catch (e) {
          this.logger.warn(`[conciliacao] pagbank ${p.id}: ${(e as Error).message}`);
        }
      }
      // ── Pagar.me (links de pagamento) ──
      const pm: any[] = await (this.prisma as any).pagarmePayment.findMany({
        where: { updatedAt: { gte: desde } },
      });
      for (const p of pm) {
        try {
          await this.upsertTx({
            gateway: 'PAGARME',
            transactionId: String(p.pagarmeOrderId),
            chargeId: p.pagarmeChargeId || null,
            pedidoRef: p.saleId || null,
            storeCode: p.storeCode || null,
            statusGateway: p.status || null,
            valorBrutoCents: this.toCents(p.valor),
            tipoPagamento: p.method || null,
            dataVenda: p.createdAt || null,
            dataRecebimento: p.paidAt || null,
            raw: p.rawWebhook ? this.tryJson(p.rawWebhook) : { ...p, rawWebhook: undefined },
          });
          out.pagarme++;
        } catch (e) {
          this.logger.warn(`[conciliacao] pagarme ${p.id}: ${(e as Error).message}`);
        }
      }
      // ── Stone (maquininhas físicas das lojas) ──
      const st: any[] = await (this.prisma as any).stoneTransaction.findMany({
        where: { receivedAt: { gte: desde } },
      });
      for (const s of st) {
        try {
          await this.upsertTx({
            gateway: 'STONE',
            transactionId: String(s.stoneTxId),
            pedidoRef: s.matchedSaleId || null,
            storeCode: s.storeCode || null,
            nsu: s.stoneNsu || null,
            authorizationCode: s.authorizationCode || null,
            statusGateway: s.status || null,
            valorBrutoCents: this.toCents(s.amount),
            parcelas: s.installments ?? null,
            bandeira: s.bandeira || null,
            tipoPagamento: s.paymentMethod || null,
            cartaoFinal: s.last4 || null,
            dataVenda: s.capturedAt || null,
            raw: this.tryJson(s.rawPayload),
          });
          out.stone++;
        } catch (e) {
          this.logger.warn(`[conciliacao] stone ${s.id}: ${(e as Error).message}`);
        }
      }
      this.logger.log(`[conciliacao] importados: PagBank=${out.pagbank} Pagarme=${out.pagarme} Stone=${out.stone}`);
      return out;
    } finally {
      this.running = false;
      this.resumoCache = null;
    }
  }

  // ── FASE 3: MOTOR DE CONCILIAÇÃO ──────────────────────────────────────
  private static readonly PAGO = new Set(['paid', 'captured', 'approved', 'succeeded', 'PAID', 'CAPTURED']);

  /**
   * Roda o motor sobre as transações PAGAS da janela. Idempotente.
   *
   * O dono do pagamento sai da régua única (`common/dono-do-pagamento.ts`):
   * venda do PDV, carrinho da live, baixa de crediário OU pedido do site. Até
   * 20/09 o motor só conhecia os dois primeiros, e todo pedido do site e toda
   * parcela paga por PIX apareciam como "Pgto sem venda" (1.519 na tela).
   */
  async conciliar(desdeDias = 400): Promise<ResultadoMotor> {
    // Cron da hora e clique em "2. Conciliar" ao mesmo tempo: quem chega depois
    // espera a rodada em curso e recebe o resultado dela, em vez de dobrar a carga.
    if (this.motorEmCurso) return this.motorEmCurso;
    this.motorEmCurso = this.rodarMotor(desdeDias).finally(() => { this.motorEmCurso = null; });
    return this.motorEmCurso;
  }

  private motorEmCurso: Promise<ResultadoMotor> | null = null;
  /** Fim da última rodada do motor — é o "atualizado às" da tela. Zera no deploy. */
  private ultimaRodadaEm: Date | null = null;

  /**
   * Barata o bastante pra rodar TODA HORA (21/09): lê só as colunas que o
   * veredito usa (sem o JSON bruto do gateway) e GRAVA SÓ O QUE MUDOU. Antes
   * cada rodada regravava ~3 mil conciliações + ~3 mil transações; numa rodada
   * sem novidade, agora nada é escrito.
   *
   * Classifica TUDO a cada rodada, de propósito: o veredito de um pagamento de
   * 10 dias atrás muda se a venda for cancelada hoje, e o "duplicado" depende
   * de enxergar as irmãs de qualquer data.
   */
  private async rodarMotor(desdeDias: number): Promise<ResultadoMotor> {
    const desde = new Date(Date.now() - desdeDias * 86400000);
    const txs: any[] = await (this.prisma as any).financialTransaction.findMany({
      where: { createdAt: { gte: desde } },
      orderBy: { dataVenda: 'asc' },
      select: {
        id: true, pedidoRef: true, transactionId: true, valorBrutoCents: true, tipoPagamento: true,
        statusGateway: true, gateway: true, statusInterno: true,
      },
    });
    const pagas = txs.filter((t) => ConciliacaoService.PAGO.has(String(t.statusGateway || '')));
    const r: ResultadoMotor = { conciliadas: 0, divergentes: 0, semVenda: 0, duplicadas: 0, total: pagas.length, gravadas: 0 };
    const atuais: any[] = pagas.length
      ? await (this.prisma as any).financialConciliacao.findMany({
          where: { transactionId: { in: pagas.map((t) => t.id) } },
          select: {
            transactionId: true, status: true, pedidoRef: true, valorSistemaCents: true,
            valorGatewayCents: true, diferencaCents: true, motivo: true, origem: true,
          },
        })
      : [];
    const atualDaTx = new Map<string, any>(atuais.map((c) => [c.transactionId, c]));
    // Uma ida ao banco pro lote inteiro. Erro aqui SOBE de propósito: consulta
    // que falhou não pode virar "sem venda" carimbado em venda boa.
    const donos = await donosDosPagamentos(this.prisma, pagas.map((t) => t.pedidoRef), { comPagamentos: true });
    // O veredito é puro e tem spec: `classificar-pagamentos.ts` (venda
    // dividida casa com o pagamento que cita a order; dono cancelado não concilia).
    const vereditos = classificarPagamentos(
      pagas.map((t) => ({
        id: t.id,
        pedidoRef: t.pedidoRef,
        gatewayOrderId: t.transactionId,
        cents: Number(t.valorBrutoCents) || null,
        formaGateway: t.tipoPagamento,
      })),
      donos,
    );
    const contador: Record<string, 'conciliadas' | 'divergentes' | 'semVenda' | 'duplicadas'> = {
      CONCILIADO: 'conciliadas', DIVERGENTE: 'divergentes', NAO_ENCONTRADO: 'semVenda', DUPLICADO: 'duplicadas',
    };
    const igual = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
    for (const t of pagas) {
      const v = vereditos.get(t.id)!;
      const { status, motivo, origem } = v;
      const valorSistema = v.valorSistemaCents;
      const gw = Number(t.valorBrutoCents) || null;
      r[contador[status]]++;
      const diferenca = gw != null && valorSistema != null ? gw - valorSistema : null;
      const atual = atualDaTx.get(t.id);
      const mudou =
        !atual ||
        !igual(atual.status, status) || !igual(atual.pedidoRef, t.pedidoRef) || !igual(atual.motivo, motivo) ||
        !igual(atual.origem, origem) || !igual(atual.valorSistemaCents, valorSistema) ||
        !igual(atual.valorGatewayCents, gw) || !igual(atual.diferencaCents, diferenca);
      if (mudou) {
        await (this.prisma as any).financialConciliacao.upsert({
          where: { transactionId: t.id },
          create: {
            transactionId: t.id, pedidoRef: t.pedidoRef, gateway: t.gateway, status,
            valorSistemaCents: valorSistema, valorGatewayCents: gw,
            diferencaCents: diferenca, motivo, origem,
          },
          update: {
            status, pedidoRef: t.pedidoRef, valorSistemaCents: valorSistema,
            valorGatewayCents: gw, diferencaCents: diferenca, motivo, origem,
            ultimaConciliacao: new Date(),
          },
        });
        r.gravadas++;
      }
      if (!igual(t.statusInterno, status.toLowerCase())) {
        await (this.prisma as any).financialTransaction.update({
          where: { id: t.id },
          data: { statusInterno: status.toLowerCase() },
        }).catch(() => null);
      }
    }
    this.resumoCache = null; // os números de cima têm que refletir a rodada que acabou
    this.ultimaRodadaEm = new Date();
    this.logger.log(`[conciliacao] motor: ${JSON.stringify(r)}`);
    return r;
  }

  /**
   * Lista pra tela: transação + conciliação, filtrável.
   *
   * O recorte sai do MESMO predicado dos números de cima (`filtrarLinhas`), em
   * cima da mesma base em memória — lista e resumo não têm como discordar. Loja
   * e DATA moram na transação, não na conciliação: com o `where` do Prisma isso
   * virava um `IN` de milhares de ids por clique. A ordem é a da VENDA (mais
   * nova primeiro); antes era a da última rodada do motor, que só coincidia com
   * a da venda por sorte.
   */
  async listar(f: FiltrosConciliacao & { page?: number; perPage?: number }) {
    const page = Math.max(1, f.page || 1);
    const perPage = Math.min(200, Math.max(10, f.perPage || 50));
    const recorte = filtrarLinhas(await this.linhasDoResumo(), f).sort((a, b) => b.quando - a.quando);
    const total = recorte.length;
    const idsDaPagina = recorte.slice((page - 1) * perPage, page * perPage).map((l) => l.id);
    const achadas: any[] = idsDaPagina.length
      ? await (this.prisma as any).financialConciliacao.findMany({ where: { id: { in: idsDaPagina } } })
      : [];
    const porConcId = new Map(achadas.map((c) => [c.id, c]));
    // findMany não devolve na ordem do `in` — remonta na ordem do recorte.
    const rows: any[] = idsDaPagina.map((id) => porConcId.get(id)).filter(Boolean);
    const txIds = rows.map((r: any) => r.transactionId);
    const txs: any[] = await (this.prisma as any).financialTransaction.findMany({
      where: { id: { in: txIds } },
    });
    const porId = new Map(txs.map((t) => [t.id, t]));

    // NOME DO CLIENTE: do dono do pagamento quando ele existe (mesma régua do
    // motor — venda, live, crediário ou pedido do site); quando é "pgto sem
    // venda", tenta o nome do PAGADOR no raw do gateway (o sistema envia
    // customer.name ao criar a order). Ajuda a identificar de quem é cada PIX
    // que caiu sem venda vinculada.
    const donos = await donosDosPagamentos(this.prisma, rows.map((r: any) => r.pedidoRef));

    return {
      total, page, perPage,
      rows: rows.map((c: any) => {
        const t: any = porId.get(c.transactionId) || {};
        const clienteNome =
          (c.pedidoRef && donos.get(String(c.pedidoRef).trim())?.clienteNome) ||
          this.nomeDoRaw(t.rawJson) ||
          null;
        return {
          ...c,
          clienteNome,
          tipoPagamento: t.tipoPagamento, bandeira: t.bandeira, nsu: t.nsu,
          storeCode: t.storeCode, dataVenda: t.dataVenda, statusGateway: t.statusGateway,
          parcelas: t.parcelas, cartaoFinal: t.cartaoFinal,
        };
      }),
    };
  }

  /** Extrai o nome do pagador/cliente do JSON bruto do gateway (best-effort). */
  private nomeDoRaw(raw: any): string | null {
    if (!raw || typeof raw !== 'object') return null;
    const cands = [
      raw?.customer?.name,
      raw?.charges?.[0]?.customer?.name,
      raw?.data?.customer?.name,
      raw?.order?.customer?.name,
      raw?.customerName,
    ];
    for (const c of cands) {
      const s = c ? String(c).trim() : '';
      if (s) return s;
    }
    return null;
  }

  /** JSON bruto de uma transação (botão Ver JSON da tela). */
  async verJson(transactionId: string) {
    return (this.prisma as any).financialTransaction.findUnique({ where: { id: transactionId } });
  }

  private tryJson(s: any): any {
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch { return { raw: s }; }
  }

  /**
   * OS NÚMEROS DE CIMA — cartões de status, chips de gateway, de origem e o
   * seletor de loja — obedecem os MESMOS filtros da lista (dono, 21/09:
   * "filtrei Itanhaém e lá em cima não mudou nada"). A conta é a de
   * `facetas.ts`, em memória, sobre os pagamentos já conciliados.
   *
   * `transacoes` (tudo o que foi importado, pago ou não) segue na resposta só
   * pra aba aberta com a tela antiga não quebrar.
   */
  async status(f: FiltrosConciliacao = {}) {
    const [porGateway, linhas] = await Promise.all([
      (this.prisma as any).financialTransaction.groupBy({
        by: ['gateway'],
        _count: { _all: true },
        _sum: { valorBrutoCents: true },
      }),
      this.linhasDoResumo(),
    ]);
    return {
      ...facetarConciliacoes(linhas, f),
      transacoes: (porGateway as any[]).map((g) => ({
        gateway: g.gateway, qtd: g._count._all, brutoCents: g._sum.valorBrutoCents || 0,
      })),
      importando: this.running,
      /** Fim da última rodada do motor (null logo depois de um deploy, até a 1ª rodada). */
      atualizadoEm: this.ultimaRodadaEm ? this.ultimaRodadaEm.toISOString() : null,
    };
  }

  /**
   * Base das facetas: uma linha por pagamento conciliado, com a loja da
   * transação. Cada clique de filtro chama o `status`, então a leitura (~8 mil
   * linhas magras) fica 15s em memória; importar e conciliar derrubam o cache.
   * Sem catch: se a leitura falhar a tela mostra o erro, não um zero inventado.
   */
  private resumoCache: { em: number; linhas: LinhaDaTela[] } | null = null;

  private async linhasDoResumo(): Promise<LinhaDaTela[]> {
    if (this.resumoCache && Date.now() - this.resumoCache.em < 15_000) return this.resumoCache.linhas;
    const [concs, txs] = await Promise.all([
      (this.prisma as any).financialConciliacao.findMany({
        select: { id: true, transactionId: true, status: true, gateway: true, origem: true, valorGatewayCents: true },
      }),
      (this.prisma as any).financialTransaction.findMany({
        select: { id: true, storeCode: true, dataVenda: true },
      }),
    ]);
    const txPorId = new Map<string, any>((txs as any[]).map((t) => [t.id, t]));
    const linhas: LinhaDaTela[] = (concs as any[]).map((c) => {
      const t = txPorId.get(c.transactionId);
      const venda: Date | null = t?.dataVenda ? new Date(t.dataVenda) : null;
      return {
        id: c.id,
        status: c.status,
        gateway: c.gateway,
        origem: c.origem ?? null,
        storeCode: t?.storeCode ?? null,
        cents: Number(c.valorGatewayCents) || 0,
        // O dia é o de BRASÍLIA: PIX das 22h30 está gravado como 01h30 UTC do dia seguinte.
        dia: venda ? diaBrasiliaDe(venda) : null,
        quando: venda ? venda.getTime() : 0,
      };
    });
    this.resumoCache = { em: Date.now(), linhas };
    return linhas;
  }

  /**
   * 90s depois de subir, a mesma atualização da hora. Faz duas coisas: a tela
   * não fica sem "atualizado às" até o próximo :25, e qualquer mudança no motor
   * chega na tela sozinha no deploy (lição de 20/09: conserto que depende de
   * alguém clicar "2. Conciliar" não aparece). O motor só escreve o que mudou,
   * então no deploy comum isso é leitura.
   */
  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => { void this.atualizarRecentes('boot'); }, 90_000).unref?.();
  }
}
