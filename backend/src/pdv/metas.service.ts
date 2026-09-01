import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { FaturamentoService } from '../faturamento/faturamento.service';
import { ActiveSellersService } from './active-sellers.service';
import {
  startOfDayBR,
  startOfDayBRFromYmd,
  startOfNextDayBR,
  ymdBR,
} from '../lib/date-br';

/**
 * MetasService — gamificação de vendas (dono, 29/08/2026).
 *
 * A REGRA DA META, nas palavras dele:
 *   1. Meta do MÊS da loja = o que a MESMA loja vendeu no MESMO mês do ano
 *      anterior (é o `metaMes` que a tela de Faturamento já mostra pra matriz).
 *   2. Meta da VENDEDORA = meta da loja ÷ vendedoras ativas da loja.
 *   3. Meta do DIA = meta da vendedora ÷ dias de venda do mês.
 *
 * FONTES (nenhuma toca o Giga ao vivo no caminho feliz):
 *   - Mês do ano anterior → `erp.getFaturamentoPorLoja`, que lê o espelho
 *     `giga_caixa_mov` (Postgres) e só cai pro Giga se o espelho não cobrir.
 *   - Realizado (mês/hoje) → `FaturamentoService.faturamentoHibrido`: PdvSale
 *     em tempo real + resto do caixa Wincred − devoluções. É A MESMA RÉGUA da
 *     tela de Faturamento — a vendedora e o dono enxergam o mesmo número.
 *   - Por vendedora → pdv_sales com a régua da folha de comissão
 *     (total − vale-troca − devolução dinheiro/pix da vendedora, MARCADO fora).
 *
 * DIAS ÚTEIS (correção do dono na entrega, 29/08): a meta do dia divide pelos
 * dias úteis seg–sáb do MÊS VIGENTE — não pelos dias com venda do mês do ano
 * anterior (a 1ª versão fazia isso e ele mandou trocar).
 *
 * RANKING DA REDE (corrigido pelo dono na entrega, 29/08): quanto cada loja
 * COLABOROU com as vendas GLOBAIS da rede nos últimos 30 dias — participação
 * em %, a soma das lojas dá 100. Em porcentagem de propósito: a vendedora vê
 * a fatia de cada loja sem ver o faturamento em reais de nenhuma. O payload
 * NÃO carrega valores.
 *
 * Cache curto em memória: o modal do PDV fica aberto o dia inteiro no balcão
 * (poll de 60s por loja) — sem cache seriam ~8 queries por refresh por loja.
 */

export type MetaVendedoraRow = {
  nome: string;
  apelido: string | null;
  metaMes: number;
  metaDia: number;
  realizadoMes: number;
  realizadoHoje: number;
  pctMes: number | null;
  pctHoje: number | null;
  /** false = vendeu no mês mas está fora da whitelist de vendedoras ativas. */
  naWhitelist: boolean;
  /**
   * false = está no PDV mas NÃO divide a meta da loja (dono, 01/09): caixa
   * que vende esporádico e o dono não são vendedoras OFICIAIS. A linha só
   * aparece se vendeu, sem meta individual (metaMes/metaDia = 0, pct null).
   */
  contaNaMeta: boolean;
};

export type MetasLojaResponse = {
  mesLabel: string;
  mesRefLabel: string;
  /** Dias úteis (seg–sáb) do mês VIGENTE — divisor da meta do dia. */
  diasUteisMes: number;
  diaDoMes: number;
  diasNoMes: number;
  loja: {
    storeCode: string;
    storeName: string;
    metaMes: number;
    metaDia: number;
    realizadoMes: number;
    realizadoHoje: number;
    pctMes: number | null;
    pctHoje: number | null;
    faltaMes: number;
    projecaoMes: number;
    semBase: boolean;
  };
  vendedoras: MetaVendedoraRow[];
  atualizadoEm: string;
};

export type RankingLojaRow = {
  storeCode: string;
  storeName: string;
  /** Participação da loja nas vendas da REDE no período (soma das lojas = 100). */
  pct: number;
  posicao: number;
  minha: boolean;
};

export type RankingResponse = {
  periodo: { from: string; to: string };
  lojas: RankingLojaRow[];
  atualizadoEm: string;
};

// ── Helpers puros (testados em metas.service.spec.ts) ───────────────────────

/** % com meta zero protegida — sem base não existe %, existe "sem base". */
export function pctDe(realizado: number, meta: number): number | null {
  if (!Number.isFinite(meta) || meta <= 0) return null;
  return Math.round(((realizado || 0) / meta) * 1000) / 10;
}

/** Dias úteis seg–sáb de um mês — divisor da meta do dia (mês vigente). */
export function diasSegASabado(ano: number, mes1a12: number): number {
  const total = new Date(ano, mes1a12, 0).getDate();
  let n = 0;
  for (let d = 1; d <= total; d++) {
    if (new Date(ano, mes1a12 - 1, d).getDay() !== 0) n++;
  }
  return n;
}

/** Código de vendedora: só dígitos, sem zeros à esquerda (padrão do espelho). */
export function normCodigo(s: unknown): string {
  return String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

export function normNome(s: unknown): string {
  return String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

type LinhaVendaVendedora = {
  sellerId: string | null;
  sellerName: string | null;
  mes: number;
  hoje: number;
};

/**
 * Junta whitelist + vendas + devoluções em linhas prontas pra tela.
 *
 * O `sellerId` gravado na venda ora é o código Wincred, ora o Seller.id (ver
 * commission-engine) — o casamento tenta código E nome, e cada linha de venda
 * só é consumida uma vez. Quem vendeu sem estar na whitelist aparece no fim
 * (naWhitelist=false) — some da lista silenciosamente é pior, o total da loja
 * deixaria de fechar com a soma das meninas.
 *
 * RATEIO SÓ ENTRE OFICIAIS (dono, 01/09): a whitelist tem gente que aparece
 * no PDV mas não é vendedora oficial (caixa que vende esporádico, o dono) —
 * `contaNaMeta:false` na whitelist tira do DIVISOR e da meta individual. A
 * linha dela só aparece se vendeu (com o vendido, sem meta nem medalha) —
 * o total da loja continua fechando com a soma de todo mundo.
 */
export function montarVendedoras(args: {
  ativas: Array<{ codigo: string; nome: string; apelido?: string | null; contaNaMeta?: boolean }>;
  vendas: LinhaVendaVendedora[];
  devolucoes: LinhaVendaVendedora[];
  metaMesLoja: number;
  diasUteisMes: number;
}): MetaVendedoraRow[] {
  const { ativas, vendas, devolucoes, metaMesLoja, diasUteisMes } = args;

  const nomesComVenda = new Set(
    vendas.filter((v) => normNome(v.sellerName)).map((v) => normNome(v.sellerName)),
  );
  // DEDUP POR NOME (01/09, caso Brenda/Jundiaí): a whitelist aceita a MESMA
  // pessoa sob dois códigos (cód Wincred 77 + código F… gerado da ficha do
  // Flow — readicionar pela busca cria o segundo). Cada linha virava uma
  // vendedora no quadro E no DIVISOR da meta. Mesmo nome na mesma loja = uma
  // pessoa: junta os códigos numa entrada só — a soma continua pegando as
  // vendas gravadas com qualquer um dos códigos.
  const porNomeUnico = new Map<
    string,
    { codigos: string[]; nome: string; apelido?: string | null; contaNaMeta?: boolean }
  >();
  for (const a of ativas) {
    const k = normNome(a.nome) || `cod:${normCodigo(a.codigo) || String(a.codigo)}`;
    const cur = porNomeUnico.get(k);
    if (!cur) {
      porNomeUnico.set(k, {
        codigos: [a.codigo],
        nome: a.nome,
        apelido: a.apelido,
        contaNaMeta: a.contaNaMeta,
      });
    } else {
      cur.codigos.push(a.codigo);
      if (!cur.apelido && a.apelido) cur.apelido = a.apelido;
      // Qualquer linha fora do rateio tira a pessoa do rateio (conservador).
      if (a.contaNaMeta === false) cur.contaNaMeta = false;
    }
  }
  const unicas = Array.from(porNomeUnico.values());
  // O DIVISOR é só quem conta na meta. Se por configuração ninguém contar,
  // cai no comportamento antigo (whitelist inteira) — nunca divide por zero.
  const oficiais = unicas.filter((a) => a.contaNaMeta !== false);
  const n = oficiais.length > 0
    ? oficiais.length
    : unicas.length > 0
      ? unicas.length
      : nomesComVenda.size;
  if (n === 0) return [];

  const metaMes = metaMesLoja / n;
  const metaDia = diasUteisMes > 0 ? metaMes / diasUteisMes : 0;

  const consumidasVenda = new Set<number>();
  const consumidasDev = new Set<number>();
  const somaLinhas = (
    linhas: LinhaVendaVendedora[],
    consumidas: Set<number>,
    codigos: string[],
    nome: string,
    apelido?: string | null,
  ): { mes: number; hoje: number } => {
    // Todos os códigos da pessoa (dedup acima) — venda gravada com qualquer
    // um deles soma na mesma linha.
    const alvoCodigos = new Set(codigos.map((c) => normCodigo(c)).filter(Boolean));
    const alvoNomes = new Set([normNome(nome), normNome(apelido)].filter(Boolean));
    let mes = 0;
    let hoje = 0;
    linhas.forEach((l, i) => {
      if (consumidas.has(i)) return;
      const porCodigo = alvoCodigos.size > 0 && alvoCodigos.has(normCodigo(l.sellerId));
      const porNome = alvoNomes.has(normNome(l.sellerName));
      if (!porCodigo && !porNome) return;
      consumidas.add(i);
      mes += Number(l.mes) || 0;
      hoje += Number(l.hoje) || 0;
    });
    return { mes, hoje };
  };

  const rows: MetaVendedoraRow[] = [];
  for (const a of unicas) {
    const conta = a.contaNaMeta !== false;
    const v = somaLinhas(vendas, consumidasVenda, a.codigos, a.nome, a.apelido);
    const d = somaLinhas(devolucoes, consumidasDev, a.codigos, a.nome, a.apelido);
    const realizadoMes = v.mes - d.mes;
    const realizadoHoje = v.hoje - d.hoje;
    // Fora do rateio SEM venda no mês = ruído: ela é do popup do PDV, não do
    // quadro de metas. (As linhas dela já foram consumidas acima — se vender
    // amanhã, aparece; nunca vaza pros "extras".)
    if (!conta && realizadoMes === 0 && realizadoHoje === 0) continue;
    rows.push({
      nome: a.nome,
      apelido: a.apelido || null,
      metaMes: conta ? metaMes : 0,
      metaDia: conta ? metaDia : 0,
      realizadoMes,
      realizadoHoje,
      pctMes: conta ? pctDe(realizadoMes, metaMes) : null,
      pctHoje: conta ? pctDe(realizadoHoje, metaDia) : null,
      naWhitelist: true,
      contaNaMeta: conta,
    });
  }

  // Vendeu no mês mas não está na whitelist (ex.: gerente que cobriu um turno).
  const extrasPorNome = new Map<string, { nome: string; mes: number; hoje: number }>();
  vendas.forEach((l, i) => {
    if (consumidasVenda.has(i)) return;
    const chave = normNome(l.sellerName);
    if (!chave) return; // venda sem vendedora não vira linha de gente
    const cur = extrasPorNome.get(chave) || {
      nome: String(l.sellerName).trim(),
      mes: 0,
      hoje: 0,
    };
    cur.mes += Number(l.mes) || 0;
    cur.hoje += Number(l.hoje) || 0;
    extrasPorNome.set(chave, cur);
  });
  devolucoes.forEach((l, i) => {
    if (consumidasDev.has(i)) return;
    const chave = normNome(l.sellerName);
    if (!chave || !extrasPorNome.has(chave)) return;
    const cur = extrasPorNome.get(chave)!;
    cur.mes -= Number(l.mes) || 0;
    cur.hoje -= Number(l.hoje) || 0;
  });
  for (const extra of extrasPorNome.values()) {
    rows.push({
      nome: extra.nome,
      apelido: null,
      metaMes,
      metaDia,
      realizadoMes: extra.mes,
      realizadoHoje: extra.hoje,
      pctMes: pctDe(extra.mes, metaMes),
      pctHoje: pctDe(extra.hoje, metaDia),
      naWhitelist: false,
      contaNaMeta: true,
    });
  }

  // Quem disputa a meta primeiro (medalha é entre oficiais); fora do rateio
  // fecha a lista, também por realizado.
  rows.sort(
    (a, b) =>
      Number(b.contaNaMeta) - Number(a.contaNaMeta) ||
      b.realizadoMes - a.realizadoMes ||
      b.realizadoHoje - a.realizadoHoje ||
      a.nome.localeCompare(b.nome, 'pt-BR'),
  );
  return rows;
}

/** Ranking = fatia de cada loja no bolo da rede (soma 100%), maior primeiro. */
export function montarRanking(args: {
  lojas: Array<{ code: string; name: string }>;
  atualPorCode: Map<string, number>;
  minhaLoja?: string | null;
}): RankingLojaRow[] {
  const { lojas, atualPorCode, minhaLoja } = args;
  // O bolo é a soma das LOJAS DO CADASTRO — código órfão no faturamento (loja
  // desativada/renomeada sem canon) ficaria de fora da lista, e somá-lo faria
  // as fatias exibidas não fecharem em 100.
  const total = lojas.reduce((s, l) => s + (atualPorCode.get(l.code) || 0), 0);
  const rows = lojas.map((l) => {
    const atual = atualPorCode.get(l.code) || 0;
    return {
      storeCode: l.code,
      storeName: l.name || l.code,
      pct: total > 0 ? Math.round((atual / total) * 1000) / 10 : 0,
      posicao: 0,
      minha: !!minhaLoja && l.code === minhaLoja,
    };
  });
  rows.sort(
    (a, b) => b.pct - a.pct || a.storeName.localeCompare(b.storeName, 'pt-BR'),
  );
  rows.forEach((r, i) => { r.posicao = i + 1; });
  return rows;
}

// ── Serviço ─────────────────────────────────────────────────────────────────

@Injectable()
export class MetasService {
  private readonly logger = new Logger(MetasService.name);
  // TTLs curtos: "tempo real" pro balcão sem transformar o poll de 14 lojas
  // em 8 queries × loja × minuto. Histórico (ano anterior) muda nunca; o que
  // muda a cada venda é o realizado, e 60s de atraso ninguém percebe no modal.
  private cacheMetas = new Map<string, { at: number; data: MetasLojaResponse }>();
  private cacheRanking: { at: number; rows: RankingLojaRow[]; periodo: any } | null = null;
  private static readonly TTL_METAS_MS = 60_000;
  private static readonly TTL_RANKING_MS = 120_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly faturamento: FaturamentoService,
    private readonly activeSellers: ActiveSellersService,
  ) {}

  /** Meia-noite LOCAL do servidor a partir de YYYY-MM-DD (+ dias) — é o formato
   *  que `faturamentoHibrido`/`getFaturamentoPorLoja` esperam (ver parseDate
   *  do FaturamentoService: BR pra timestamps é aplicado LÁ DENTRO). */
  private dataLocal(ymd: string, plusDias = 0): Date {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, (m || 1) - 1, (d || 1) + plusDias);
  }

  /** code/nome/nomes antigos (e código sem zero à esquerda) → Store.code. */
  private async canonLojas(): Promise<{
    paraCode: Map<string, string>;
    lojas: Array<{ code: string; name: string; active: boolean }>;
    siteCode: string;
  }> {
    const lojas: any[] = await (this.prisma as any).store.findMany({
      select: { code: true, name: true, nomesAntigos: true, active: true },
    });
    const paraCode = new Map<string, string>();
    for (const l of lojas) {
      const code = String(l.code || '').trim();
      if (!code) continue;
      paraCode.set(code.toUpperCase(), code);
      const semZero = code.replace(/^0+/, '');
      if (semZero) paraCode.set(semZero.toUpperCase(), code);
      // Variante 2 dígitos — o PDV manda '06' mesmo se o cadastro guardar '6'.
      const doisDigitos = code.replace(/\D/g, '').padStart(2, '0').slice(-2);
      if (doisDigitos !== '00') paraCode.set(doisDigitos, code);
      if (l.name) paraCode.set(String(l.name).trim().toUpperCase(), code);
      for (const antigo of String(l.nomesAntigos || '').split(',')) {
        const a = antigo.trim().toUpperCase();
        if (a) paraCode.set(a, code);
      }
    }
    const site = lojas.find(
      (l) => String(l.name || '').trim().toUpperCase() === 'SITE' || l.code === 'SITE',
    );
    return {
      paraCode,
      lojas: lojas.map((l) => ({
        code: String(l.code || '').trim(),
        name: String(l.name || l.code || '').trim(),
        active: l.active !== false,
      })),
      siteCode: site?.code || 'SITE',
    };
  }

  private canon(paraCode: Map<string, string>, raw: unknown): string {
    const k = String(raw ?? '').trim().toUpperCase();
    return paraCode.get(k) ?? k;
  }

  /**
   * Faturamento por loja (canonizado) num período, na régua da tela de
   * Faturamento. `hibrido=true` = período atual (PdvSale em tempo real);
   * `false` = período histórico (espelho do caixa). A loja SITE soma os
   * componentes que só existem no Flow (pedidos do site + live) — sem isso a
   * loja 13 nunca bateria a meta: a meta dela (ano anterior, tudo no Giga)
   * incluiria o site inteiro e o realizado não.
   */
  private async faturamentoPorLojaCanonizado(
    inicio: Date,
    fimExclusive: Date,
    paraCode: Map<string, string>,
    siteCode: string,
    hibrido: boolean,
  ): Promise<Map<string, number>> {
    const [rows, siteFlow, siteLive] = await Promise.all([
      hibrido
        ? this.faturamento.faturamentoHibrido(inicio, fimExclusive)
        : this.erp.getFaturamentoPorLoja(inicio, fimExclusive),
      this.faturamento.getFlowopsSiteFaturamento(inicio, fimExclusive).catch(() => ({ faturamento: 0 })),
      this.faturamento.getLiveFaturamento(inicio, fimExclusive).catch(() => ({ faturamento: 0 })),
    ]);
    const porCode = new Map<string, number>();
    for (const r of rows as any[]) {
      const code = this.canon(paraCode, r.storeCode);
      porCode.set(code, (porCode.get(code) || 0) + (Number(r.faturamento) || 0));
    }
    const extraSite = (Number((siteFlow as any).faturamento) || 0) + (Number((siteLive as any).faturamento) || 0);
    if (extraSite > 0) porCode.set(siteCode, (porCode.get(siteCode) || 0) + extraSite);
    return porCode;
  }

  /** Vendas por vendedora da loja (mês + hoje na mesma query), régua da folha. */
  private async vendasPorVendedora(
    saleCodes: string[],
    mesInicioBR: Date,
    hojeInicioBR: Date,
    amanhaBR: Date,
  ): Promise<LinhaVendaVendedora[]> {
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT s.seller_id AS "sellerId",
              s.seller_name AS "sellerName",
              COALESCE(SUM(s.total - COALESCE(vt.vale, 0)), 0)::float8 AS mes,
              COALESCE(SUM(CASE WHEN s.finalized_at >= $2
                                THEN s.total - COALESCE(vt.vale, 0) ELSE 0 END), 0)::float8 AS hoje
         FROM pdv_sales s
         LEFT JOIN (
           SELECT sale_id, SUM(valor)::float8 AS vale FROM pdv_sale_payments
            WHERE LOWER(TRIM(method)) IN ('vale_troca', 'vale', 'troca')
            GROUP BY sale_id
         ) vt ON vt.sale_id = s.id
        WHERE s.finalized_at >= $1 AND s.finalized_at < $3
          AND s.status = 'finalized'
          AND s.is_training = false
          AND (s.payment_method IS NULL OR s.payment_method <> 'MARCADO')
          AND UPPER(BTRIM(s.store_code)) = ANY($4)
        GROUP BY s.seller_id, s.seller_name`,
      mesInicioBR, hojeInicioBR, amanhaBR, saleCodes,
    );
    return rows.map((r) => ({
      sellerId: r.sellerId ?? null,
      sellerName: r.sellerName ?? null,
      mes: Number(r.mes) || 0,
      hoje: Number(r.hoje) || 0,
    }));
  }

  /** Devoluções dinheiro/pix atribuídas à vendedora da venda original. */
  private async devolucoesPorVendedora(
    saleCodes: string[],
    mesInicioBR: Date,
    hojeInicioBR: Date,
    amanhaBR: Date,
  ): Promise<LinhaVendaVendedora[]> {
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT s.seller_id AS "sellerId",
              s.seller_name AS "sellerName",
              COALESCE(SUM(r.valor_total), 0)::float8 AS mes,
              COALESCE(SUM(CASE WHEN r.created_at >= $2 THEN r.valor_total ELSE 0 END), 0)::float8 AS hoje
         FROM pdv_returns r
         JOIN pdv_sales s ON s.id = r.original_sale_id
        WHERE r.created_at >= $1 AND r.created_at < $3
          AND r.is_training = false
          AND r.modo IN ('dinheiro', 'pix')
          AND COALESCE(r.status, '') <> 'cancelled'
          AND UPPER(BTRIM(r.store_code)) = ANY($4)
        GROUP BY s.seller_id, s.seller_name`,
      mesInicioBR, hojeInicioBR, amanhaBR, saleCodes,
    );
    return rows.map((r) => ({
      sellerId: r.sellerId ?? null,
      sellerName: r.sellerName ?? null,
      mes: Number(r.mes) || 0,
      hoje: Number(r.hoje) || 0,
    }));
  }

  private mesLabel(ano: number, mes1a12: number): string {
    const label = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' })
      .format(new Date(Date.UTC(ano, mes1a12 - 1, 15)));
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  async getMetas(storeCodeNormalizado: string): Promise<MetasLojaResponse> {
    const cached = this.cacheMetas.get(storeCodeNormalizado);
    if (cached && Date.now() - cached.at < MetasService.TTL_METAS_MS) return cached.data;

    const hojeYmd = ymdBR();
    const [ano, mes, dia] = hojeYmd.split('-').map(Number);
    const mm = String(mes).padStart(2, '0');

    const { paraCode, lojas, siteCode } = await this.canonLojas();
    const meuCode = this.canon(paraCode, storeCodeNormalizado);
    const minhaLoja = lojas.find((l) => l.code === meuCode);
    const storeName = minhaLoja?.name || meuCode;

    // Variantes que podem estar gravadas em pdv_sales.store_code (code, code
    // sem zero, nome atual, nomes antigos) — mesma lição do FaturamentoService.
    const saleCodes = Array.from(
      new Set(
        [
          meuCode,
          meuCode.replace(/^0+/, ''),
          storeCodeNormalizado,
          storeCodeNormalizado.replace(/^0+/, ''),
          storeName,
          ...Array.from(paraCode.entries())
            .filter(([, code]) => code === meuCode)
            .map(([k]) => k),
        ]
          .map((s) => String(s || '').trim().toUpperCase())
          .filter(Boolean),
      ),
    );
    // Janelas — locais (server) pros agregados por loja, BR pros timestamps.
    const mesInicioLocal = this.dataLocal(`${ano}-${mm}-01`);
    const hojeLocal = this.dataLocal(hojeYmd);
    const amanhaLocal = this.dataLocal(hojeYmd, 1);
    const refInicioLocal = new Date(ano - 1, mes - 1, 1);
    const refFimLocal = new Date(ano - 1, mes, 1);
    const mesInicioBR = startOfDayBRFromYmd(`${ano}-${mm}-01`);
    const hojeInicioBR = startOfDayBR();
    const amanhaBR = startOfNextDayBR();

    const [metaPorLoja, mesPorLoja, hojePorLoja, ativas, vendas, devolucoes] =
      await Promise.all([
        this.faturamentoPorLojaCanonizado(refInicioLocal, refFimLocal, paraCode, siteCode, false),
        this.faturamentoPorLojaCanonizado(mesInicioLocal, amanhaLocal, paraCode, siteCode, true),
        this.faturamentoPorLojaCanonizado(hojeLocal, amanhaLocal, paraCode, siteCode, true),
        this.listarAtivas(storeCodeNormalizado, meuCode),
        this.vendasPorVendedora(saleCodes, mesInicioBR, hojeInicioBR, amanhaBR),
        this.devolucoesPorVendedora(saleCodes, mesInicioBR, hojeInicioBR, amanhaBR),
      ]);

    const metaMes = metaPorLoja.get(meuCode) || 0;
    const realizadoMes = mesPorLoja.get(meuCode) || 0;
    const realizadoHoje = hojePorLoja.get(meuCode) || 0;

    // Dias úteis seg–sáb do MÊS VIGENTE (ordem do dono na entrega, 29/08).
    const diasUteisMes = diasSegASabado(ano, mes);
    const metaDia = diasUteisMes > 0 ? metaMes / diasUteisMes : 0;
    const diasNoMes = new Date(ano, mes, 0).getDate();

    const data: MetasLojaResponse = {
      mesLabel: this.mesLabel(ano, mes),
      mesRefLabel: this.mesLabel(ano - 1, mes),
      diasUteisMes,
      diaDoMes: dia,
      diasNoMes,
      loja: {
        storeCode: meuCode,
        storeName,
        metaMes,
        metaDia,
        realizadoMes,
        realizadoHoje,
        pctMes: pctDe(realizadoMes, metaMes),
        pctHoje: pctDe(realizadoHoje, metaDia),
        faltaMes: Math.max(0, metaMes - realizadoMes),
        projecaoMes: dia > 0 ? (realizadoMes / dia) * diasNoMes : 0,
        semBase: metaMes <= 0,
      },
      vendedoras: montarVendedoras({
        ativas,
        vendas,
        devolucoes,
        metaMesLoja: metaMes,
        diasUteisMes,
      }),
      atualizadoEm: new Date().toISOString(),
    };

    this.cacheMetas.set(storeCodeNormalizado, { at: Date.now(), data });
    return data;
  }

  /** Whitelist da loja — tenta o código como veio e sem zero à esquerda. */
  private async listarAtivas(
    ...codigos: string[]
  ): Promise<Array<{ codigo: string; nome: string; apelido?: string | null; contaNaMeta: boolean }>> {
    const tentativas = Array.from(
      new Set(
        codigos
          .flatMap((c) => [c, c.replace(/^0+/, '')])
          .map((c) => String(c || '').trim())
          .filter(Boolean),
      ),
    );
    for (const code of tentativas) {
      try {
        const rows = await this.activeSellers.list(code);
        if (rows.length > 0) {
          return rows.map((r: any) => ({
            codigo: String(r.codigo || ''),
            nome: String(r.nome || ''),
            apelido: r.apelido || null,
            // false só quando gravado false — linha antiga sem o campo conta.
            contaNaMeta: r.contaNaMeta !== false,
          }));
        }
      } catch (e: any) {
        this.logger.warn(`[metas] vendedoras ativas ${code}: ${e?.message || e}`);
      }
    }
    return [];
  }

  async getRanking(minhaLoja?: string | null): Promise<RankingResponse> {
    const minha = minhaLoja ? String(minhaLoja).trim() : null;
    if (this.cacheRanking && Date.now() - this.cacheRanking.at < MetasService.TTL_RANKING_MS) {
      return this.montarRespostaRanking(this.cacheRanking, minha);
    }

    const hojeYmd = ymdBR();
    const inicio = this.dataLocal(hojeYmd, -29); // "30 dias anteriores" inclui hoje
    const fimExclusive = this.dataLocal(hojeYmd, 1);

    const { paraCode, lojas, siteCode } = await this.canonLojas();
    const atualPorCode = await this.faturamentoPorLojaCanonizado(
      inicio, fimExclusive, paraCode, siteCode, true,
    );

    const rows = montarRanking({
      lojas: lojas.filter((l) => l.active),
      atualPorCode,
      minhaLoja: null, // a marcação "minha" é por request; o cache é da rede
    });

    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this.cacheRanking = {
      at: Date.now(),
      rows,
      periodo: { from: iso(inicio), to: hojeYmd },
    };
    return this.montarRespostaRanking(this.cacheRanking, minha);
  }

  private montarRespostaRanking(
    cache: { rows: RankingLojaRow[]; periodo: any },
    minha: string | null,
  ): RankingResponse {
    // '6' e '06' são a mesma loja — compara pelos dígitos sem zero à esquerda.
    const chave = (s: unknown) => {
      const raw = String(s ?? '').trim().toUpperCase();
      const dig = raw.replace(/\D/g, '').replace(/^0+/, '');
      return dig || raw;
    };
    const minhaChave = minha ? chave(minha) : null;
    return {
      periodo: cache.periodo,
      lojas: cache.rows.map((r) => ({
        ...r,
        minha: !!minhaChave && chave(r.storeCode) === minhaChave,
      })),
      atualizadoEm: new Date().toISOString(),
    };
  }
}
