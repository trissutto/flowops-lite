import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * CREDIÁRIO NATIVO — FASE 1: importação COMPLETA do `movimento` do Giga
 * (parcelas abertas E pagas — todo o histórico) pra `crediario_parcelas`.
 *
 * É a base do Tier 3 do "sair da Giga": com o ledger inteiro no Postgres,
 * a ficha da cliente mostra o crediário completo (como a tela do Giga
 * mostrava) e a fase 2 pluga as ESCRITAS (venda cria parcela no Flow,
 * baixa/estorno idem — Giga vira réplica via outbox).
 *
 * Full-replace preservando flowIsSource (fase 2). SELECT * paginado com
 * mapeamento dinâmico de colunas (nomes variam por instalação Wincred).
 * Sync: manual (botão no /retaguarda/wincred-mirror) + cron diário 04:10
 * gated WINCRED_MIRROR_CRON_ENABLED=1.
 */

/**
 * Resultado da autoconferência do sync: quantas parcelas em aberto foram
 * gravadas contra quantas o Giga diz ter. `diferenca` diferente de zero é
 * dívida sumindo (negativa) ou sobrando (positiva) na ficha da cliente.
 */
type Conferencia = {
  abertasGravadas: number;
  abertasNoGiga: number;
  diferenca: number;
};

@Injectable()
export class CrediarioNativoService {
  private readonly logger = new Logger(CrediarioNativoService.name);
  private running = false;
  private lastResult: { at: Date; total: number; erro?: string; conferencia?: Conferencia | null } | null = null;

  private static readonly PAGE = 10_000;
  private static readonly CHUNK = 1_000;
  private static readonly MAX_ROWS = 2_000_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  @Cron('10 4 * * *', { name: 'crediario-nativo-sync' })
  async cronDiario(): Promise<void> {
    if (process.env.WINCRED_MIRROR_CRON_ENABLED !== '1') return;
    try {
      const r = await this.syncAll();
      this.logger.log(`[crediario-nativo] sync diário: ${JSON.stringify(r)}`);
    } catch (e) {
      this.logger.error(`[crediario-nativo] sync diário falhou: ${(e as Error).message}`);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private pick(row: Record<string, any>, ...res: RegExp[]): any {
    for (const re of res) {
      for (const key of Object.keys(row)) {
        if (re.test(key)) return row[key];
      }
    }
    return undefined;
  }

  private str(v: any, max = 250): string | null {
    if (v == null) return null;
    const s = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
    const t = s.trim();
    return t ? t.slice(0, max) : null;
  }

  private intOf(v: any): number | null {
    if (v == null || v === '') return null;
    const n = parseInt(String(v), 10);
    return isFinite(n) ? n : null;
  }

  private numOf(v: any): number | null {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  private dateOf(v: any): Date | null {
    if (!v || String(v).startsWith('0000')) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    if (isNaN(d.getTime()) || d.getFullYear() < 1950) return null;
    return d;
  }

  /**
   * A coluna EXISTE na tabela? Diferente de "o valor veio nulo" — e a distinção
   * decide se a data de pagamento pode servir de critério. `pick` devolve
   * `undefined` nos dois casos, então ela sozinha não resolve.
   */
  private temColuna(row: Record<string, any>, ...res: RegExp[]): boolean {
    return Object.keys(row).some((k) => res.some((re) => re.test(k)));
  }

  /**
   * Regra de PAGO — a MESMA de `crediario-mirror.service.ts:118`, que é o
   * critério oficial de "em aberto" do sistema:
   *
   *   aberto  ⇔  PAGO IS NULL  OR  PAGO = ''  OR  UPPER(PAGO) IN ('N','NAO','NÃO')
   *
   * INCIDENTE 31/07 — esta função DIZIA no comentário que seguia o espelho, e
   * não seguia. Ela caía na data de pagamento sempre que o VALOR de PAGO era
   * nulo, sem distinguir isso de "a coluna PAGO não existe nesta instalação".
   *
   * No Giga a coluna existe e tem 11.001 linhas nulas — todas com PAGAMENTO
   * preenchido por um bug antigo da baixa, registrado em `erp.service.ts:2420`:
   * "PAGO é o campo que o WinCred consulta; se ficar nulo, a baixa NÃO aparece
   * na UI mesmo com data preenchida". Ou seja: nulo é dívida ABERTA.
   *
   * Efeito do bug: R$ 2,9 milhões em 11.001 parcelas abertas entravam no Flow
   * como PAGAS — e a ficha da cliente lê desta tabela
   * (`clientes-giga.service.ts:388`), sem flag nenhuma no caminho.
   *
   * A data de pagamento só vale como critério quando a coluna PAGO NÃO EXISTE,
   * espelhando o `else if (map.dataPagamento)` do serviço de espelho.
   */
  /**
   * Quantas parcelas o Giga considera EM ABERTO agora, pelo critério oficial
   * (`crediario-mirror.service.ts:118`). Devolve null se não deu pra perguntar
   * — aí a conferência é omitida em vez de inventar um veredito.
   */
  private async contarAbertasNoGiga(pool: any): Promise<number | null> {
    try {
      const [cols] = await pool.query('SHOW COLUMNS FROM `movimento`');
      const nomes = (cols as any[]).map((c) => String(c.Field));
      const colPago = nomes.find((n) => /^(pago|pg|baixado|quitado)$/i.test(n));
      const colData = nomes.find((n) => /^(pagamento|data_?pagamento|datapagto|data_?baixa|datapag)$/i.test(n));

      let cond: string;
      if (colPago) {
        cond = `(\`${colPago}\` IS NULL OR \`${colPago}\` = '' OR UPPER(\`${colPago}\`) IN ('N','NAO','NÃO'))`;
      } else if (colData) {
        cond = `(\`${colData}\` IS NULL OR \`${colData}\` = '0000-00-00')`;
      } else {
        return null;
      }

      const [r] = await pool.query({
        sql: `SELECT COUNT(*) AS n FROM \`movimento\` WHERE ${cond}`,
        timeout: 120_000,
      });
      return Number((r as any[])[0]?.n ?? 0);
    } catch (e) {
      this.logger.warn(`[crediario-nativo] conferência não pôde ser feita: ${(e as Error).message}`);
      return null;
    }
  }

  private pagoOf(row: Record<string, any>): { pago: boolean; dataPagamento: Date | null } {
    const RE_PAGO = [/^pago$/i, /^pg$/i, /^baixado$/i, /^quitado$/i];
    const dataPag = this.dateOf(
      this.pick(row, /^pagamento$/i, /^data_?pagamento$/i, /^datapagto$/i, /^data_?baixa$/i, /^datapag$/i),
    );

    if (this.temColuna(row, ...RE_PAGO)) {
      // `str` já devolve null pra string vazia, então '' cai no mesmo ramo que
      // NULL — igual ao `PAGO = ''` do critério do espelho.
      const flag = this.str(this.pick(row, ...RE_PAGO), 5);
      const aberto = flag == null || ['N', 'NAO', 'NÃO'].includes(flag.toUpperCase());
      return { pago: !aberto, dataPagamento: dataPag };
    }

    return { pago: !!dataPag, dataPagamento: dataPag };
  }

  private mapRow(row: Record<string, any>): Record<string, any> | null {
    const registro = this.str(this.pick(row, /^registro$/i, /^id$/i), 20);
    if (!registro) return null;
    const loja = (this.str(this.pick(row, /^loja$/i, /^cod_?loja$/i, /^filial$/i), 4) || '00').padStart(2, '0');
    const { pago, dataPagamento } = this.pagoOf(row);
    return {
      registro,
      controle: this.str(this.pick(row, /^controle$/i), 20),
      numeroCompra: this.str(this.pick(row, /^numero_?compra$/i, /^numerocompra$/i, /^numero$/i, /^compra$/i), 20),
      loja,
      codCliente: this.str(this.pick(row, /^cod_?cliente$/i, /^codcliente$/i, /^cliente$/i, /^codcli$/i), 20),
      nomeCliente: this.str(this.pick(row, /^nome$/i, /^nome_?cliente$/i), 120),
      parcela: this.intOf(this.pick(row, /^parcela$/i, /^num_?parcela$/i)),
      totalParcelas: this.intOf(this.pick(row, /^total_?parcelas$/i, /^totalparcelas$/i, /^n_?parc(elas)?$/i, /^qtd_?parcelas$/i)),
      dataCompra: this.dateOf(this.pick(row, /^data_?compra$/i, /^datacompra$/i, /^data$/i, /^emissao$/i)),
      valorCompra: this.numOf(this.pick(row, /^valor_?compra$/i, /^valorcompra$/i, /^vlr_?compra$/i)),
      vencimento: this.dateOf(this.pick(row, /^vencimento$/i, /^data_?venc/i, /^dt_?venc/i)),
      valorParcela: this.numOf(this.pick(row, /^valor_?parcela$/i, /^valorparcela$/i, /^valor$/i, /^vlr_?parcela$/i)),
      pago,
      dataPagamento,
      valorPago: this.numOf(this.pick(row, /^valor_?pago$/i, /^valorpago$/i, /^vlrpago$/i)),
      juros: this.numOf(this.pick(row, /^juros$/i, /^vlr_?juros$/i)),
      multa: this.numOf(this.pick(row, /^multa$/i, /^vlr_?multa$/i)),
      obs: this.str(this.pick(row, /^obs$/i, /^observacao$/i), 300),
    };
  }

  // ── sync ─────────────────────────────────────────────────────────────────

  startBackground(): { started: boolean; alreadyRunning: boolean } {
    if (this.running) return { started: false, alreadyRunning: true };
    void this.syncAll();
    return { started: true, alreadyRunning: false };
  }

  async syncAll(): Promise<{ ok: boolean; total: number; paginas: number; erro?: string; conferencia?: Conferencia | null }> {
    if (this.running) return { ok: false, total: 0, paginas: 0, erro: 'sync já em andamento' };
    this.running = true;
    const t0 = Date.now();
    try {
      const pool: any = (this.erp as any).pool;
      if (!pool) throw new Error('pool Giga não inicializado');

      // LÊ ANTES DE APAGAR (31/07). O DELETE vinha primeiro: com o Giga fora na
      // hora do cron (04:10), ele passava, o SELECT estourava e a tabela ficava
      // VAZIA. Como a ficha da cliente lê daqui SEM flag nenhuma, TODA cliente
      // passaria a mostrar dívida zero — e a execução seguinte apagaria o vazio
      // de novo, então não se corrigia sozinho.
      //
      // São 710k linhas, grandes demais pra segurar inteiras na memória antes
      // do replace. A garantia possível é esta: buscar a PRIMEIRA página e só
      // apagar se ela vier. Cobre o caso real — Giga indisponível — sem inchar
      // a memória. Se ele cair no meio da paginação, a conferência do fim do
      // método grita e a próxima execução refaz.
      const primeira = await pool.query({
        sql: `SELECT * FROM \`movimento\` ORDER BY \`REGISTRO\` LIMIT ${CrediarioNativoService.PAGE} OFFSET 0`,
        timeout: 120_000,
      });
      const primeiraPagina = primeira[0] as any[];
      if (!primeiraPagina.length) {
        // Vazio não é resposta válida: a `movimento` nunca está vazia de
        // verdade. Preserva o que está lá e sai.
        throw new Error('SELECT movimento veio vazio — Giga indisponível, parcelas preservadas');
      }

      // Só agora, com a leitura provada, refaz o que veio do Giga.
      // Parcelas nascidas no Flow (flowIsSource) são preservadas sempre.
      await (this.prisma as any).crediarioParcela.deleteMany({ where: { flowIsSource: false } });

      let total = 0;
      let abertas = 0;
      let paginas = 0;
      for (let offset = 0; offset < CrediarioNativoService.MAX_ROWS; offset += CrediarioNativoService.PAGE) {
        // A primeira página já está na mão — não relê.
        const batch = offset === 0
          ? primeiraPagina
          : ((await pool.query({
              sql: `SELECT * FROM \`movimento\` ORDER BY \`REGISTRO\` LIMIT ${CrediarioNativoService.PAGE} OFFSET ${offset}`,
              timeout: 120_000,
            }))[0] as any[]);
        if (!batch.length) break;
        paginas++;

        const data = batch
          .map((row) => this.mapRow(row))
          .filter((r): r is NonNullable<ReturnType<CrediarioNativoService['mapRow']>> => !!r);

        for (let i = 0; i < data.length; i += CrediarioNativoService.CHUNK) {
          await (this.prisma as any).crediarioParcela.createMany({
            data: data.slice(i, i + CrediarioNativoService.CHUNK),
            skipDuplicates: true,
          });
        }
        total += data.length;
        abertas += data.filter((d) => d.pago === false).length;
        if (paginas % 5 === 0) this.logger.log(`[crediario-nativo] página ${paginas}: total ${total}`);
        if (batch.length < CrediarioNativoService.PAGE) break;
      }

      // ── CONFERÊNCIA (31/07) ────────────────────────────────────────────
      // A tabela desta classe é lida pela ficha da cliente SEM flag nenhuma
      // (clientes-giga.service.ts:388 usa "tem alguma linha?" como gate). Uma
      // regra de mapeamento errada aqui vira dívida sumindo do PDV, calada —
      // foi o que aconteceu com 11.001 parcelas (R$ 2,9 mi) até 31/07.
      // Contar de novo não conserta a regra, mas impede que ela erre EM
      // SILÊNCIO: se o número de abertas não bate com o do Giga, o log grita e
      // o status carrega o aviso.
      const abertasNoGiga = await this.contarAbertasNoGiga(pool);
      const conferencia =
        abertasNoGiga == null
          ? null
          : { abertasGravadas: abertas, abertasNoGiga, diferenca: abertas - abertasNoGiga };
      if (conferencia && conferencia.diferenca !== 0) {
        this.logger.error(
          `[crediario-nativo] CONFERÊNCIA FALHOU — gravei ${abertas} parcelas em aberto, ` +
            `o Giga tem ${abertasNoGiga} (diferença ${conferencia.diferenca}). ` +
            `A ficha da cliente lê desta tabela: dívida pode estar sumindo ou sobrando.`,
        );
      } else if (conferencia) {
        this.logger.log(`[crediario-nativo] conferência OK — ${abertas} em aberto, igual ao Giga`);
      }

      this.lastResult = { at: new Date(), total, conferencia };
      this.logger.log(`[crediario-nativo] sync completo: ${total} parcelas em ${Math.round((Date.now() - t0) / 1000)}s`);
      return { ok: true, total, paginas, conferencia };
    } catch (e: any) {
      const erro = String(e?.message || e);
      this.lastResult = { at: new Date(), total: 0, erro };
      this.logger.error(`[crediario-nativo] sync falhou: ${erro}`);
      return { ok: false, total: 0, paginas: 0, erro };
    } finally {
      this.running = false;
    }
  }

  async status() {
    const [total, abertas, pagas, vencidas, ultimo] = await Promise.all([
      (this.prisma as any).crediarioParcela.count(),
      (this.prisma as any).crediarioParcela.count({ where: { pago: false } }),
      (this.prisma as any).crediarioParcela.count({ where: { pago: true } }),
      (this.prisma as any).crediarioParcela.count({ where: { pago: false, vencimento: { lt: new Date() } } }),
      (this.prisma as any).crediarioParcela.findFirst({ orderBy: { syncedAt: 'desc' }, select: { syncedAt: true } }),
    ]);
    return { total, abertas, pagas, vencidas, ultimoSync: ultimo?.syncedAt || null, rodando: this.running, ultimoResultado: this.lastResult };
  }
}
