import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import {
  agoraBrasilia,
  fimDoDiaUtcExclusivo,
  hojeBrasilia,
  inicioDoDiaUtc,
  utcParaBrasilia,
} from '../common/tz';
import {
  conciliarCartoes,
  frasesDaConciliacao,
  PagamentoSistema,
  Resultado,
  TransacaoMaquininha,
} from './conciliar-cartoes';
import { ResumoImportacao, StoneArquivosService } from './stone-arquivos.service';

/**
 * CONFERÊNCIA DE CARTÕES × STONE (16/09/2026).
 *
 * Todo dia, depois das 4h (quando a Stone libera o arquivo do dia anterior), o
 * Flow baixa as transações de cada maquininha e cruza com as vendas no cartão
 * do PDV (`conciliar-cartoes.ts`). O resultado vira o checklist de
 * /retaguarda/conciliacao-cartoes e o resumo diário no WhatsApp.
 *
 * Configuração (tela, sem deploy): StoneCodes de cada loja, destinos e hora do
 * WhatsApp. Chaves da Stone: `STONE_CONCILIACAO_CHAVES` no Railway.
 * Kill-switch dos crons: `STONE_CONCILIACAO=0`.
 *
 * Regra que vale ouro: sem o arquivo da Stone o dia NÃO é "venda sem
 * transação" — é "aguardando arquivo". Fonte que não respondeu nunca vira
 * divergência calada nem falsa.
 */

export interface ConfigConciliacao {
  /** storeCode → StoneCodes das maquininhas da loja */
  lojas: Record<string, string[]>;
  whats: { ativo: boolean; destinos: string[]; hora: number };
}

const CONFIG_CHAVE = 'conciliacao-cartao';
const ENVIO_CHAVE = 'conciliacao-cartao-resumo-enviado';
const CONFIG_PADRAO: ConfigConciliacao = { lojas: {}, whats: { ativo: true, destinos: [], hora: 9 } };
const DIAS_REPESCAGEM = 5;

const r2 = (n: number) => Math.round(n * 100) / 100;

function detalhes(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, any>;
  try {
    const d = JSON.parse(String(raw));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

/** '5' e '05' são a mesma loja (vendas antigas gravaram sem o zero). */
function codigoLoja(c: unknown): string {
  const s = String(c ?? '').trim();
  return /^\d$/.test(s) ? `0${s}` : s;
}

function variantes(code: string): string[] {
  const out = new Set([code]);
  if (/^\d+$/.test(code)) out.add(String(Number(code)));
  return [...out];
}

function diaMais(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
function diaCurto(dia: string): string {
  const d = new Date(`${dia}T12:00:00.000Z`);
  return `${SEMANA[d.getUTCDay()]} ${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}

const horaBr = (d: Date | null | undefined) => (d ? utcParaBrasilia(d).toISOString().slice(11, 16) : null);

@Injectable()
export class ConciliacaoCartaoService implements OnModuleInit {
  private readonly logger = new Logger(ConciliacaoCartaoService.name);
  private rodando = false;
  private carga: { rodando: boolean; inicio?: Date; fim?: Date; feitos: number; total: number; erros: string[] } = {
    rodando: false,
    feitos: 0,
    total: 0,
    erros: [],
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly arquivos: StoneArquivosService,
    private readonly whatsapp: WhatsappService,
  ) {}

  private get db(): any {
    return this.prisma as any;
  }

  private get ligado(): boolean {
    return String(process.env.STONE_CONCILIACAO ?? '1') !== '0';
  }

  async onModuleInit() {
    const n = this.arquivos.chaves().length;
    this.logger.log(
      `[stone] conferência de cartões ${this.ligado ? 'LIGADA' : 'DESLIGADA (STONE_CONCILIACAO=0)'} · ` +
        `${n} chave(s) da Stone no Railway${n ? '' : ' — nada será baixado até cadastrar STONE_CONCILIACAO_CHAVES'}`,
    );
  }

  // ───────────────────────── configuração ─────────────────────────

  async config(): Promise<ConfigConciliacao> {
    const row = await this.db.appConfig.findUnique({ where: { key: CONFIG_CHAVE } });
    if (!row) return JSON.parse(JSON.stringify(CONFIG_PADRAO));
    const v = JSON.parse(row.valueJson || '{}');
    const lojas: Record<string, string[]> = {};
    for (const [loja, codigos] of Object.entries(v.lojas || {})) {
      const lista = (Array.isArray(codigos) ? codigos : []).map((c) => String(c).replace(/\D/g, '')).filter(Boolean);
      if (lista.length) lojas[codigoLoja(loja)] = [...new Set(lista)];
    }
    const w = v.whats || {};
    return {
      lojas,
      whats: {
        ativo: w.ativo !== false,
        destinos: Array.isArray(w.destinos) ? w.destinos.map(String) : [],
        hora: Number.isInteger(w.hora) && w.hora >= 0 && w.hora <= 23 ? w.hora : CONFIG_PADRAO.whats.hora,
      },
    };
  }

  async salvarConfig(dto: Partial<ConfigConciliacao>, usuario: string | null) {
    const atual = await this.config();
    const lojas: Record<string, string[]> = dto.lojas ? {} : atual.lojas;
    if (dto.lojas) {
      const dono = new Map<string, string>();
      for (const [loja, codigos] of Object.entries(dto.lojas)) {
        const lista = [...new Set((codigos || []).map((c) => String(c).replace(/\D/g, '')).filter((c) => c.length >= 6))];
        for (const c of lista) {
          const outra = dono.get(c);
          if (outra && outra !== codigoLoja(loja)) {
            throw new BadRequestException(`O StoneCode ${c} está em duas lojas (${outra} e ${codigoLoja(loja)})`);
          }
          dono.set(c, codigoLoja(loja));
        }
        if (lista.length) lojas[codigoLoja(loja)] = lista;
      }
    }
    const w = dto.whats;
    const destinos = w?.destinos
      ? [...new Set(w.destinos.map((d) => String(d).replace(/\D/g, '')).filter((d) => d.length >= 10 && d.length <= 13))]
      : atual.whats.destinos;
    const hora = w?.hora == null ? atual.whats.hora : Number(w.hora);
    if (!Number.isInteger(hora) || hora < 0 || hora > 23) throw new BadRequestException('Hora inválida (0 a 23)');
    const nova: ConfigConciliacao = {
      lojas,
      whats: { ativo: w?.ativo == null ? atual.whats.ativo : !!w.ativo, destinos, hora },
    };
    await this.db.appConfig.upsert({
      where: { key: CONFIG_CHAVE },
      create: { key: CONFIG_CHAVE, valueJson: JSON.stringify(nova) },
      update: { valueJson: JSON.stringify(nova) },
    });
    this.logger.log(`[stone] config salva por ${usuario || '?'}: ${JSON.stringify(nova)}`);
    return nova;
  }

  async codigosDaFranquia(): Promise<string[]> {
    const rows = await this.db.store.findMany({ where: { tipo: 'FILIAL', active: true }, select: { code: true } });
    return (rows as any[]).map((r) => codigoLoja(r.code));
  }

  private async nomesDasLojas(): Promise<Map<string, { nome: string; tipo: string; ativa: boolean }>> {
    const rows = await this.db.store.findMany({ select: { code: true, name: true, tipo: true, active: true } });
    return new Map(
      (rows as any[]).map((r) => [codigoLoja(r.code), { nome: r.name, tipo: r.tipo, ativa: r.active !== false }]),
    );
  }

  async estadoDaIntegracao() {
    const [cfg, arquivos, lojas] = await Promise.all([
      this.config(),
      this.db.stoneArquivo.findMany({
        where: { dia: { gte: diaMais(hojeBrasilia(), -7) } },
        orderBy: [{ dia: 'desc' }, { stoneCode: 'asc' }],
      }),
      this.nomesDasLojas(),
    ]);
    return {
      ligado: this.ligado,
      chaves: this.arquivos.chaves().length,
      carga: this.carga,
      lojas: [...lojas.entries()]
        .filter(([, l]) => l.ativa)
        .map(([code, l]) => ({ code, nome: l.nome, tipo: l.tipo, stoneCodes: cfg.lojas[code] || [] }))
        .sort((a, b) => a.code.localeCompare(b.code, 'pt-BR', { numeric: true })),
      whats: cfg.whats,
      arquivos: (arquivos as any[]).map((a) => ({
        stoneCode: a.stoneCode,
        storeCode: a.storeCode,
        dia: a.dia,
        status: a.status,
        capturas: a.capturas,
        cancelamentos: a.cancelamentos,
        erro: a.erro,
        baixadoEm: a.baixadoEm,
        ultimaTentativa: a.ultimaTentativa,
      })),
    };
  }

  // ───────────────────────── os dois lados ─────────────────────────

  async pagamentosDoSistema(storeCode: string, dia: string): Promise<{ pagamentos: PagamentoSistema[]; porId: Map<string, any> }> {
    const vendas = await this.db.pdvSale.findMany({
      where: {
        storeCode: { in: variantes(storeCode) },
        isTraining: false,
        status: { in: ['finalized', 'cancelled'] },
        finalizedAt: { gte: inicioDoDiaUtc(dia), lt: fimDoDiaUtcExclusivo(dia) },
      },
      select: {
        id: true,
        status: true,
        total: true,
        paymentMethod: true,
        finalizedAt: true,
        customerName: true,
        vendedorName: true,
        sellerName: true,
        stoneNsu: true,
        payments: { select: { id: true, method: true, valor: true, details: true, createdAt: true } },
      },
    });
    const pagamentos: PagamentoSistema[] = [];
    const porId = new Map<string, any>();
    for (const v of vendas as any[]) {
      if (String(v.paymentMethod || '').toUpperCase() === 'MARCADO') continue;
      for (const p of v.payments || []) {
        const metodo = String(p.method || '').toLowerCase();
        const det = detalhes(p.details);
        const cartao = metodo === 'credito' || metodo === 'debito';
        // Link "externo" pago na maquininha da loja: aceita par, não cobra.
        const linkExterno = metodo === 'venda_online' && String(det.tipo || '') === 'link';
        if (!cartao && !linkExterno) continue;
        const valor = r2(Number(p.valor) || 0);
        if (valor <= 0) continue;
        const pag: PagamentoSistema = {
          id: p.id,
          vendaId: v.id,
          venda: String(v.id).slice(-8).toUpperCase(),
          valor,
          tipo: metodo === 'debito' ? 'debito' : 'credito',
          bandeira: det.bandeira ? String(det.bandeira).toUpperCase().trim() : null,
          parcelas: metodo === 'credito' ? Number(det.parcelas) || 1 : metodo === 'debito' ? 1 : null,
          momento: p.createdAt || v.finalizedAt,
          vendaCancelada: v.status === 'cancelled',
          vendedora: v.sellerName || v.vendedorName || null,
          cliente: v.customerName || null,
          obrigatorio: cartao,
        };
        pagamentos.push(pag);
        porId.set(p.id, {
          ...pag,
          metodo,
          horaVenda: horaBr(v.finalizedAt),
          hora: horaBr(pag.momento),
          nsuGravado: v.stoneNsu || null,
          qtdCartoesNaVenda: (v.payments || []).filter((x: any) =>
            ['credito', 'debito'].includes(String(x.method || '').toLowerCase()),
          ).length,
        });
      }
    }
    return { pagamentos, porId };
  }

  async transacoesDaMaquininha(storeCode: string, dia: string): Promise<{ transacoes: TransacaoMaquininha[]; porId: Map<string, any> }> {
    const cfg = await this.config();
    const codigos = cfg.lojas[storeCode] || [];
    if (!codigos.length) return { transacoes: [], porId: new Map() };
    const rows = await this.db.stoneTransaction.findMany({
      where: {
        merchantId: { in: codigos },
        capturedAt: { gte: inicioDoDiaUtc(dia), lt: fimDoDiaUtcExclusivo(dia) },
        // `NOT` sozinho esconderia as linhas com paymentMethod nulo
        OR: [{ paymentMethod: null }, { NOT: { paymentMethod: 'boleto' } }],
      },
      orderBy: { capturedAt: 'asc' },
    });
    const transacoes: TransacaoMaquininha[] = [];
    const porId = new Map<string, any>();
    for (const t of rows as any[]) {
      const tipo =
        t.paymentMethod === 'credit_card'
          ? 'credito'
          : t.paymentMethod === 'debit_card'
            ? 'debito'
            : t.paymentMethod === 'voucher'
              ? 'voucher'
              : 'outro';
      const capturado = r2(Number(t.valorCapturado ?? t.amount) || 0);
      const tr: TransacaoMaquininha = {
        id: t.id,
        nsu: t.stoneNsu || t.stoneTxId,
        valorCapturado: capturado,
        valorCancelado: r2(Number(t.valorCancelado) || 0),
        tipo,
        bandeira: t.bandeira,
        parcelas: t.installments ?? null,
        momento: t.capturedAt,
        finalCartao: t.last4,
        autorizacao: t.authorizationCode,
        terminal: t.tipoTerminal,
      };
      transacoes.push(tr);
      porId.set(t.id, {
        ...tr,
        hora: horaBr(t.capturedAt),
        stoneCode: t.merchantId,
        taxa: t.taxa,
        valorLiquido: t.valorLiquido,
        previsaoPagamento: t.previsaoPagamento,
        serial: t.serialTerminal,
        status: t.status,
        canceladaEm: t.canceladaEm,
      });
    }
    return { transacoes, porId };
  }

  // ───────────────────────── conciliar um dia ─────────────────────────

  private async situacaoDosArquivos(storeCode: string, dia: string) {
    const cfg = await this.config();
    const codigos = cfg.lojas[storeCode] || [];
    if (!codigos.length) return { codigos, status: 'sem_stone' as const, arquivos: [] as any[] };
    const arquivos = await this.db.stoneArquivo.findMany({ where: { stoneCode: { in: codigos }, dia } });
    const porCodigo = new Map((arquivos as any[]).map((a) => [a.stoneCode, a]));
    const faltando = codigos.filter((c) => porCodigo.get(c)?.status !== 'ok');
    if (!faltando.length) return { codigos, status: 'ok' as const, arquivos };
    const comErro = faltando.some((c) => ['erro', 'sem_acesso'].includes(porCodigo.get(c)?.status));
    return { codigos, status: comErro ? ('erro_arquivo' as const) : ('aguardando_arquivo' as const), arquivos };
  }

  async conciliarDia(storeCode: string, dia: string) {
    const loja = codigoLoja(storeCode);
    const [{ pagamentos, porId: pagPorId }, { transacoes, porId: trPorId }, arquivos] = await Promise.all([
      this.pagamentosDoSistema(loja, dia),
      this.transacoesDaMaquininha(loja, dia),
      this.situacaoDosArquivos(loja, dia),
    ]);
    const resultado = conciliarCartoes(pagamentos, transacoes);
    const status = arquivos.status === 'ok' ? resultado.status : arquivos.status;
    const conta = arquivos.status === 'ok';
    const frases = conta ? frasesDaConciliacao(resultado, 6) : [];
    const dados = {
      status,
      qtdSistema: resultado.totais.sistema.qtd,
      valorSistema: resultado.totais.sistema.valor,
      qtdStone: resultado.totais.maquininha.qtd,
      valorStone: resultado.totais.maquininha.valor,
      divergencias: conta ? resultado.contagem.divergencia : 0,
      atencoes: conta ? resultado.contagem.atencao : 0,
      valorDivergente: conta ? resultado.totais.valorDivergente : 0,
      conferidoEm: new Date(),
      resultado: JSON.parse(
        JSON.stringify({
          versao: 1,
          resultado,
          frases,
          arquivos: (arquivos.arquivos as any[]).map((a) => ({
            stoneCode: a.stoneCode,
            status: a.status,
            erro: a.erro,
            baixadoEm: a.baixadoEm,
          })),
          codigos: arquivos.codigos,
        }),
      ),
    };
    if (status !== 'sem_stone' && (pagamentos.length || transacoes.length || conta)) {
      await this.db.conciliacaoCartaoDia.upsert({
        where: { storeCode_dia: { storeCode: loja, dia } },
        create: { storeCode: loja, dia, ...dados },
        update: dados,
      });
    }
    if (conta) await this.carimbarVendas(resultado, pagPorId, trPorId);
    return { storeCode: loja, dia, status, resultado, frases, pagPorId, trPorId, arquivos };
  }

  /** NSU na venda que casou — outras telas passam a enxergar a transação. */
  private async carimbarVendas(r: Resultado, pagPorId: Map<string, any>, trPorId: Map<string, any>) {
    for (const l of r.linhas) {
      if (!l.pagamentoId || !l.transacaoId) continue;
      if (!['confere', 'confere_com_nota', 'valor_diferente'].includes(l.situacao)) continue;
      const p = pagPorId.get(l.pagamentoId);
      const t = trPorId.get(l.transacaoId);
      if (!p || !t || p.qtdCartoesNaVenda !== 1 || p.nsuGravado === t.nsu) continue;
      await this.db.pdvSale
        .update({
          where: { id: p.vendaId },
          data: {
            stoneNsu: t.nsu,
            stoneTxId: t.nsu,
            stoneBandeira: t.bandeira,
            stoneLast4: t.finalCartao,
            stoneConciliatedAt: new Date(),
          },
        })
        .catch((e: any) => this.logger.warn(`[stone] não carimbei a venda ${p.vendaId}: ${e?.message || e}`));
    }
  }

  // ───────────────────────── baixar + conciliar ─────────────────────────

  async importarEConciliar(dias: string[], opts: { forcar?: boolean; lojas?: string[] } = {}) {
    const cfg = await this.config();
    const resumos: ResumoImportacao[] = [];
    const afetados = new Map<string, Set<string>>();
    const lojas = Object.entries(cfg.lojas).filter(([loja]) => !opts.lojas || opts.lojas.includes(loja));
    for (const dia of dias) {
      for (const [loja, codigos] of lojas) {
        for (const codigo of codigos) {
          const r = await this.arquivos.importar(codigo, loja, dia, opts.forcar);
          resumos.push(r);
          const set = afetados.get(loja) || new Set<string>();
          set.add(dia);
          for (const d of r.diasAfetados) set.add(d);
          afetados.set(loja, set);
          if (this.carga.rodando) this.carga.feitos++;
          if (r.status !== 'ok' && this.carga.rodando) this.carga.erros.push(`${loja}/${codigo} ${dia}: ${r.erro}`);
        }
      }
    }
    for (const [loja, set] of afetados) {
      for (const d of set) {
        await this.conciliarDia(loja, d).catch((e) =>
          this.logger.warn(`[stone] conciliação ${loja} ${d} falhou: ${e?.message || e}`),
        );
      }
    }
    return resumos;
  }

  /** Carga retroativa (primeira vez, ou StoneCode novo). Roda em segundo plano. */
  async iniciarCarga(de: string, ate: string, lojas?: string[]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate) || ate < de) {
      throw new BadRequestException('Período inválido');
    }
    const ontem = diaMais(hojeBrasilia(), -1);
    const fim = ate > ontem ? ontem : ate;
    if (fim < de) throw new BadRequestException('O arquivo de hoje só sai amanhã, a partir das 4h');
    if (this.carga.rodando) throw new BadRequestException('Já tem uma carga rodando');
    const dias: string[] = [];
    for (let d = de; d <= fim; d = diaMais(d, 1)) dias.push(d);
    if (dias.length > 62) throw new BadRequestException('No máximo 62 dias por carga');
    const cfg = await this.config();
    const codigos = Object.entries(cfg.lojas)
      .filter(([loja]) => !lojas || lojas.includes(loja))
      .reduce((s, [, c]) => s + c.length, 0);
    if (!codigos) throw new BadRequestException('Cadastre os StoneCodes das lojas antes');
    this.carga = { rodando: true, inicio: new Date(), feitos: 0, total: dias.length * codigos, erros: [] };
    setImmediate(() => {
      this.importarEConciliar(dias, { lojas })
        .catch((e) => this.carga.erros.push(`falhou: ${e?.message || e}`))
        .finally(() => {
          this.carga.rodando = false;
          this.carga.fim = new Date();
          this.logger.log(`[stone] carga ${de}→${fim}: ${this.carga.feitos}/${this.carga.total}, ${this.carga.erros.length} erro(s)`);
        });
    });
    return { ok: true, dias: dias.length, arquivos: this.carga.total };
  }

  @Cron('40 6 * * *', { name: 'stone-conciliacao-diaria', timeZone: 'America/Sao_Paulo' })
  async cronDiario() {
    if (!this.ligado || this.rodando || !this.arquivos.chaves().length) return;
    this.rodando = true;
    try {
      const ontem = diaMais(hojeBrasilia(), -1);
      await this.importarEConciliar([ontem, diaMais(ontem, -1)]);
    } catch (e: any) {
      this.logger.warn(`[stone] rotina diária falhou: ${e?.message || e}`);
    } finally {
      this.rodando = false;
    }
  }

  /** Repescagem: o que não veio de manhã (503/erro) tenta de novo. */
  @Cron('40 9,13,18 * * *', { name: 'stone-conciliacao-repescagem', timeZone: 'America/Sao_Paulo' })
  async cronRepescagem() {
    if (!this.ligado || this.rodando || !this.arquivos.chaves().length) return;
    this.rodando = true;
    try {
      const hoje = hojeBrasilia();
      const dias: string[] = [];
      for (let i = 1; i <= DIAS_REPESCAGEM; i++) dias.push(diaMais(hoje, -i));
      await this.importarEConciliar(dias);
    } catch (e: any) {
      this.logger.warn(`[stone] repescagem falhou: ${e?.message || e}`);
    } finally {
      this.rodando = false;
    }
  }

  // ───────────────────────── retaguarda ─────────────────────────

  async listar(de: string, ate: string, lojasPermitidas?: string[]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
      throw new BadRequestException('Período inválido (use AAAA-MM-DD)');
    }
    if (ate < de) throw new BadRequestException('"Até" não pode ser antes de "De"');
    const hoje = hojeBrasilia();
    const [dias, vendas, cfg, lojas] = await Promise.all([
      this.db.conciliacaoCartaoDia.findMany({ where: { dia: { gte: de, lte: ate } } }),
      this.db.$queryRawUnsafe(
        `SELECT s.store_code AS loja,
                ((s.finalized_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date)::text AS dia,
                count(*)::int AS qtd,
                coalesce(sum(p.valor), 0)::float AS valor
           FROM pdv_sales s
           JOIN pdv_sale_payments p ON p.sale_id = s.id
          WHERE s.finalized_at >= $1 AND s.finalized_at < $2
            AND s.status = 'finalized' AND NOT s.is_training
            AND upper(coalesce(s.payment_method, '')) <> 'MARCADO'
            AND lower(p.method) IN ('credito', 'debito')
          GROUP BY 1, 2`,
        inicioDoDiaUtc(de),
        fimDoDiaUtcExclusivo(ate),
      ),
      this.config(),
      this.nomesDasLojas(),
    ]);

    type LinhaLista = {
      storeCode: string;
      storeName: string;
      dia: string;
      diaCurto: string;
      status: string;
      qtdSistema: number;
      valorSistema: number;
      qtdStone: number;
      valorStone: number;
      divergencias: number;
      atencoes: number;
      valorDivergente: number;
      frases: string[];
      conferidoEm: Date | null;
      revisadoEm: Date | null;
      revisadoPor: string | null;
      revisadoNota: string | null;
    };
    const linhas = new Map<string, LinhaLista>();
    const nova = (loja: string, dia: string): LinhaLista => ({
      storeCode: loja,
      storeName: lojas.get(loja)?.nome || loja,
      dia,
      diaCurto: diaCurto(dia),
      status: '',
      qtdSistema: 0,
      valorSistema: 0,
      qtdStone: 0,
      valorStone: 0,
      divergencias: 0,
      atencoes: 0,
      valorDivergente: 0,
      frases: [],
      conferidoEm: null,
      revisadoEm: null,
      revisadoPor: null,
      revisadoNota: null,
    });
    for (const v of vendas as any[]) {
      const loja = codigoLoja(v.loja);
      const k = `${loja}|${v.dia}`;
      const l = linhas.get(k) || nova(loja, v.dia);
      l.qtdSistema += Number(v.qtd) || 0;
      l.valorSistema = r2(l.valorSistema + (Number(v.valor) || 0));
      linhas.set(k, l);
    }
    for (const d of dias as any[]) {
      const k = `${d.storeCode}|${d.dia}`;
      const l = linhas.get(k) || nova(d.storeCode, d.dia);
      Object.assign(l, {
        status: d.status,
        qtdSistema: d.qtdSistema,
        valorSistema: d.valorSistema,
        qtdStone: d.qtdStone,
        valorStone: d.valorStone,
        divergencias: d.divergencias,
        atencoes: d.atencoes,
        valorDivergente: d.valorDivergente,
        frases: Array.isArray((d.resultado as any)?.frases) ? (d.resultado as any).frases : [],
        conferidoEm: d.conferidoEm,
        revisadoEm: d.revisadoEm,
        revisadoPor: d.revisadoPor,
        revisadoNota: d.revisadoNota,
      });
      linhas.set(k, l);
    }
    for (const l of linhas.values()) {
      if (l.status) continue;
      if (!(cfg.lojas[l.storeCode] || []).length) l.status = 'sem_stone';
      else if (l.dia >= hoje) l.status = 'em_andamento';
      else l.status = 'aguardando_arquivo';
    }
    const lista = [...linhas.values()]
      .filter((l) => !lojasPermitidas || lojasPermitidas.includes(l.storeCode))
      .filter((l) => !(l.status === 'sem_movimento' && !l.qtdSistema && !l.qtdStone))
      .sort((a, b) => b.dia.localeCompare(a.dia) || a.storeCode.localeCompare(b.storeCode, 'pt-BR', { numeric: true }));
    const contagem: Record<string, number> = {};
    let valorDivergente = 0;
    let valorSistema = 0;
    let valorStone = 0;
    for (const l of lista) {
      contagem[l.status] = (contagem[l.status] || 0) + 1;
      valorDivergente += l.valorDivergente;
      valorSistema += l.valorSistema;
      valorStone += l.valorStone;
    }
    return {
      de,
      ate,
      linhas: lista,
      contagem,
      totais: { valorDivergente: r2(valorDivergente), valorSistema: r2(valorSistema), valorStone: r2(valorStone) },
      chaves: this.arquivos.chaves().length,
      lojasComStone: Object.keys(cfg.lojas).length,
    };
  }

  async detalhe(storeCode: string, dia: string, lojasPermitidas?: string[]) {
    const loja = codigoLoja(storeCode);
    if (lojasPermitidas && !lojasPermitidas.includes(loja)) throw new BadRequestException('Loja fora do seu acesso');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new BadRequestException('Dia inválido');
    const c = await this.conciliarDia(loja, dia);
    const [salvo, lojas] = await Promise.all([
      this.db.conciliacaoCartaoDia.findUnique({ where: { storeCode_dia: { storeCode: loja, dia } } }),
      this.nomesDasLojas(),
    ]);
    const conta = c.arquivos.status === 'ok';
    return {
      storeCode: loja,
      storeName: lojas.get(loja)?.nome || loja,
      dia,
      diaCurto: diaCurto(dia),
      status: c.status,
      totais: c.resultado.totais,
      contagem: conta ? c.resultado.contagem : null,
      frases: c.frases,
      stoneCodes: c.arquivos.codigos,
      arquivos: (c.arquivos.arquivos as any[]).map((a) => ({
        stoneCode: a.stoneCode,
        status: a.status,
        capturas: a.capturas,
        erro: a.erro,
        baixadoEm: a.baixadoEm,
        ultimaTentativa: a.ultimaTentativa,
      })),
      linhas: c.resultado.linhas.map((l) => ({
        ...l,
        pagamento: l.pagamentoId ? c.pagPorId.get(l.pagamentoId) || null : null,
        transacao: l.transacaoId ? c.trPorId.get(l.transacaoId) || null : null,
      })),
      revisadoEm: salvo?.revisadoEm || null,
      revisadoPor: salvo?.revisadoPor || null,
      revisadoNota: salvo?.revisadoNota || null,
    };
  }

  async revisar(storeCode: string, dia: string, nota: string, usuario: string | null) {
    const loja = codigoLoja(storeCode);
    const linha = await this.db.conciliacaoCartaoDia.findUnique({ where: { storeCode_dia: { storeCode: loja, dia } } });
    if (!linha) throw new BadRequestException('Este dia ainda não foi conferido');
    await this.db.conciliacaoCartaoDia.update({
      where: { id: linha.id },
      data: { revisadoEm: new Date(), revisadoPor: usuario, revisadoNota: String(nota || '').trim().slice(0, 1000) || null },
    });
    return { ok: true };
  }

  async rebaixarDia(storeCode: string, dia: string) {
    const loja = codigoLoja(storeCode);
    const ontem = diaMais(hojeBrasilia(), -1);
    if (dia > ontem) throw new BadRequestException('O arquivo deste dia só sai amanhã, a partir das 4h');
    const cfg = await this.config();
    if (!(cfg.lojas[loja] || []).length) throw new BadRequestException('Esta loja não tem StoneCode cadastrado');
    const resumos = await this.importarEConciliar([dia], { forcar: true, lojas: [loja] });
    return { ok: resumos.every((r) => r.status === 'ok'), resumos };
  }

  // ───────────────────────── resumo diário (WhatsApp) ─────────────────────────

  async textoResumo(dia = diaMais(hojeBrasilia(), -1)): Promise<string | null> {
    const lista = await this.listar(dia, dia);
    const linhas = lista.linhas.filter((l) => l.status !== 'sem_movimento');
    if (!linhas.length) return null;
    const rot = (l: (typeof linhas)[number]) => `${l.storeCode} ${l.storeName}`;
    const reais = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const out: string[] = [`💳 *CONFERÊNCIA DOS CARTÕES* — ${diaCurto(dia)}`, 'vendas no cartão × maquininha Stone', ''];
    const div = linhas.filter((l) => l.status === 'divergente');
    if (div.length) {
      out.push(`🔴 *Divergência (${div.length})*`);
      for (const l of div) out.push(`• ${rot(l)}: ${l.frases.slice(0, 3).join(' · ') || reais(l.valorDivergente)}`);
      out.push('');
    }
    const at = linhas.filter((l) => l.status === 'atencao');
    if (at.length) {
      out.push(`🟡 *Atenção (${at.length})*`);
      for (const l of at) out.push(`• ${rot(l)}: ${l.frases.slice(0, 2).join(' · ')}`);
      out.push('');
    }
    const semArquivo = linhas.filter((l) => ['aguardando_arquivo', 'erro_arquivo'].includes(l.status));
    if (semArquivo.length) out.push(`⏳ Sem arquivo da Stone ainda: ${semArquivo.map(rot).join(', ')}`);
    const semStone = linhas.filter((l) => l.status === 'sem_stone');
    if (semStone.length) out.push(`⚙️ Sem StoneCode cadastrado: ${semStone.map((l) => l.storeCode).join(', ')}`);
    const ok = linhas.filter((l) => l.status === 'confere');
    if (ok.length) out.push(`✅ Batem (${ok.length}): ${ok.map((l) => l.storeCode).join(', ')}`);
    const base = String(process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
    if (base) out.push('', `Checklist: ${base}/retaguarda/conciliacao-cartoes?dia=${dia}`);
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async enviarResumo(motivo: 'cron' | 'manual', usuario: string | null = null) {
    const cfg = await this.config();
    if (!cfg.whats.destinos.length) throw new BadRequestException('Cadastre ao menos um WhatsApp que recebe o resumo');
    const texto = await this.textoResumo();
    if (!texto) return { ok: true, enviado: false, motivo: 'nenhuma loja com venda no cartão ontem' };
    const falhas: string[] = [];
    for (const numero of cfg.whats.destinos) {
      const r = await this.whatsapp.sendText(numero, texto).catch((e: any) => ({ ok: false, error: e?.message }));
      if (!r?.ok) falhas.push(`${numero}: ${(r as any)?.error || 'falhou'}`);
    }
    const marca = { dia: hojeBrasilia(), em: new Date(), motivo, usuario, falhas };
    await this.db.appConfig.upsert({
      where: { key: ENVIO_CHAVE },
      create: { key: ENVIO_CHAVE, valueJson: JSON.stringify(marca) },
      update: { valueJson: JSON.stringify(marca) },
    });
    this.logger.log(`[stone] resumo (${motivo}) → ${cfg.whats.destinos.length - falhas.length}/${cfg.whats.destinos.length}`);
    return { ok: !falhas.length, enviado: true, falhas, texto };
  }

  @Cron('50 * * * *', { name: 'conciliacao-cartao-resumo', timeZone: 'America/Sao_Paulo' })
  async cronResumo() {
    try {
      if (!this.ligado) return;
      const cfg = await this.config();
      if (!cfg.whats.ativo || !cfg.whats.destinos.length) return;
      if (agoraBrasilia().getUTCHours() !== cfg.whats.hora) return;
      const marca = await this.db.appConfig.findUnique({ where: { key: ENVIO_CHAVE } });
      if (marca && JSON.parse(marca.valueJson || '{}').dia === hojeBrasilia()) return;
      await this.enviarResumo('cron');
    } catch (e: any) {
      this.logger.warn(`[stone] resumo diário falhou: ${e?.message || e}`);
    }
  }
}
