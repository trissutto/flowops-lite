import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * DRE por loja — painel /retaguarda/dre.
 *
 * ┌─ FONTE ÚNICA DE FATURAMENTO (fix 26/07) ────────────────────────────────┐
 * │ O faturamento sai do MESMO método que a tela /retaguarda/faturamento    │
 * │ usa (`ErpService.getFaturamentoPorLoja` → espelho `giga_caixa_mov`,     │
 * │ filtro DATAFEC, sem MARCADO='SIM'). Não é query paralela "equivalente": │
 * │ é a mesma chamada, pra não existir dois faturamentos no sistema.        │
 * │                                                                         │
 * │ A v1 lia PdvSale (Postgres do Flow) e dava ~R$ 100k a menos no mês —    │
 * │ o caixa do Giga é SUPERSET: contém as vendas do PDV (via outbox) MAIS   │
 * │ as lançadas direto no Giga (WhatsApp, loja fora do PDV novo). Pro       │
 * │ resultado do dono não pode faltar venda.                                │
 * │ O CMV NAO vem do cadastro: e VENDA / 2,65 (markup do dono).             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * REDE × FRANQUIAS (decisão do dono 26/07): franquia NÃO é resultado dele.
 * O que ele ganha na franquia são os 8% de royalties — então a loja FILIAL
 * sai das colunas de resultado e vira um bloco próprio, onde entra o
 * faturamento dela (informativo) e os 8% como RECEITA no consolidado.
 *
 * Demais regras: despesa por VENCIMENTO (competência) classificada pelo
 * `EspecieConta.dreGrupo`; imposto 10% (padrão do dono, com override por
 * CNPJ/mês); resultado 4-WALL separado do rateio da matriz.
 */

/**
 * CMV = VENDA ÷ MARKUP (decisão do dono 26/07: markup 2,65).
 *
 * NÃO usa o campo CUSTO do cadastro do Giga de propósito — ele está
 * desatualizado/zerado em parte da base, o que distorcia a margem sem aviso.
 * Markup fixo é premissa gerencial explícita: todo mundo enxerga a regra.
 *
 * Consequência assumida: a margem BRUTA fica igual em todas as colunas
 * (1 − 1/2,65 = 62,3%). Quem diferencia loja de loja daqui pra baixo é
 * despesa, imposto e rateio — não o mix de produto.
 */
const MARKUP = 2.65;

/** Alíquota efetiva padrão — decisão do dono 26/07 ("considere 10%"). */
const ALIQUOTA_PADRAO = 10;

/** Royalties da franquia — é o que o dono ganha sobre a venda dela. */
const ROYALTIES_PCT = 8;

/** Fundo de marketing da franquia: repasse de custo, NÃO lucro. */
const MARKETING_PCT = 4;

/** Status de venda da LIVE que contam como vendido (mesma lista do faturamento). */
const LIVE_VENDIDO = ['paid', 'separating', 'shipped', 'delivered'];

type DreGrupoLoja = 'LOJA' | 'CANAL' | 'FRANQUIA' | 'REDE' | 'FORA';
type DreGrupoEspecie = 'VARIAVEL' | 'FIXA' | 'FINANCEIRA' | 'CMV' | 'IMPOSTO' | 'IGNORAR';

export interface DreColuna {
  key: string;
  label: string;
  grupo: 'LOJA' | 'CANAL';
  cnpj: string | null;

  faturamentoBruto: number;
  devolucoes: number;
  /** Devolução em dinheiro/pix — cliente levou o dinheiro, não há venda nova. */
  devolucoesDinheiro: number;
  /** Devolução que virou vale/troca — a peça nova entra CHEIA no caixa depois. */
  devolucoesTroca: number;
  /**
   * Ajuste negativo lançado DENTRO da venda (item manual com valor negativo,
   * ex. "TROCA DEFEITO -39,90"). JÁ sai abatido do faturamento bruto porque o
   * item negativo vai pro caixa do Giga — informativo, NÃO subtrai de novo.
   */
  ajustesNaVenda: number;
  receitaLiquida: number;

  cmv: number;
  margemBruta: number;
  margemBrutaPct: number;

  impostos: number;
  aliquotaPct: number | null;
  despesasVariaveis: number;
  margemContribuicao: number;
  margemContribuicaoPct: number;

  despesasFixas: number;
  resultado4Wall: number;
  resultado4WallPct: number;

  rateioRede: number;
  despesasFinanceiras: number;
  resultadoLiquido: number;
  lucratividade: number;

  pontoEquilibrio: number | null;
  pontoEquilibrioDia: string | null;
  faltaPraEquilibrio: number | null;

  cupons: number;
  pecas: number;
  ticketMedio: number;

  avisos: string[];

  /** De onde veio cada real de despesa — espécie a espécie, do Contas a Pagar. */
  despesasDetalhe: Array<{ especie: string; grupo: DreGrupoEspecie; valor: number }>;
}

@Injectable()
export class DreService {
  private readonly logger = new Logger(DreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  // ── helpers ──────────────────────────────────────────────────────────────

  private brtRange(de: string, ate: string): { startDate: Date; endDate: Date } {
    const startDate = new Date(`${de}T03:00:00.000Z`); // 00:00 BRT
    const endDate = new Date(new Date(`${ate}T03:00:00.000Z`).getTime() + 24 * 3600 * 1000 - 1);
    return { startDate, endDate };
  }

  /**
   * Janela do CAIXA do Giga: DATAFEC é @db.Date e a query usa `< fim`.
   * Precisa ser dia-cheio em UTC, igual a tela de faturamento faz — senão
   * o último dia do período entra pela metade e o total não bate.
   */
  private caixaRange(de: string, ate: string): { inicio: Date; fimExclusive: Date } {
    const inicio = new Date(`${de}T00:00:00.000Z`);
    const fimExclusive = new Date(new Date(`${ate}T00:00:00.000Z`).getTime() + 24 * 3600 * 1000);
    return { inicio, fimExclusive };
  }

  private validaPeriodo(de: string, ate: string): { de: string; ate: string } {
    const d = String(de || '').slice(0, 10);
    const a = String(ate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{4}-\d{2}-\d{2}$/.test(a)) {
      throw new BadRequestException('Período inválido — use De/Até (YYYY-MM-DD)');
    }
    if (d > a) throw new BadRequestException('Data inicial maior que a final');
    return { de: d, ate: a };
  }

  private soDigitos(s?: string | null): string {
    return String(s || '').replace(/\D/g, '');
  }

  private pct(parte: number, total: number): number {
    if (!total) return 0;
    return parte / total;
  }

  private brl(v: number): string {
    return `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  /**
   * Papel da loja na DRE. FILIAL (cadastro que já existe) vira FRANQUIA
   * automaticamente — franquia não é coluna de resultado do dono.
   * LIVE/SITE viram CANAL pelo nome. Nunca REDE por heurística: rateio
   * inventado é pior que rateio zero.
   */
  private grupoDaLoja(store: any): DreGrupoLoja {
    const cfg = String(store?.dreGrupo || '').toUpperCase();
    if (['LOJA', 'CANAL', 'FRANQUIA', 'REDE', 'FORA'].includes(cfg)) return cfg as DreGrupoLoja;
    if (String(store?.tipo || '').toUpperCase() === 'FILIAL') return 'FRANQUIA';
    const nome = this.semAcento(`${store?.name || ''} ${store?.code || ''}`);
    // Ponto logístico não é loja: não tem vitrine, não tem resultado próprio.
    // O que passar por ele aparece na CONCILIAÇÃO como "fora da DRE" — o
    // dinheiro não some da tela, só sai do resultado (pedido do dono 26/07).
    if (/\bDEPOSITO\b|\bALMOXARIFADO\b|\bCD\b|\bCENTRO DE DISTRIBUICAO\b/.test(nome)) return 'FORA';
    if (/\bSITE\b|\bLIVE\b|E-?COMMERCE/.test(nome)) return 'CANAL';
    return 'LOJA';
  }

  private semAcento(s: string): string {
    // Tira acento pra "Depósito" casar com /DEPOSITO/. O range do replace são
    // os acentos combinantes (U+0300–U+036F) que o normalize('NFD') separa.
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  }

  private grupoDaEspecie(especie: any): DreGrupoEspecie {
    const cfg = String(especie?.dreGrupo || '').toUpperCase();
    if (['VARIAVEL', 'FIXA', 'FINANCEIRA', 'CMV', 'IMPOSTO', 'IGNORAR'].includes(cfg)) {
      return cfg as DreGrupoEspecie;
    }
    const n = String(especie?.nome || '').toUpperCase();
    if (!n) return 'FIXA';
    if (/MERCADORIA|COMPRA|FORNECEDOR|DUPLICATA/.test(n)) return 'CMV';
    if (/IMPOSTO|DAS\b|SIMPLES|ICMS|PIS|COFINS|IRPJ|CSLL|TRIBUT/.test(n)) return 'IMPOSTO';
    if (/JURO|MULTA|IOF|EMPRESTIMO|EMPRÉSTIMO|FINANCIAMENTO/.test(n)) return 'FINANCEIRA';
    if (/COMISS|TAXA|CARTAO|CARTÃO|FRETE|ROYALT|MARKETING|PUBLICID/.test(n)) return 'VARIAVEL';
    if (/TRANSFER|ADIANT|VALE\b|APORTE/.test(n)) return 'IGNORAR';
    return 'FIXA';
  }

  private colunaVazia(key: string, label: string, grupo: 'LOJA' | 'CANAL', cnpj: string | null): DreColuna {
    return {
      key, label, grupo, cnpj,
      faturamentoBruto: 0, devolucoes: 0, devolucoesDinheiro: 0, devolucoesTroca: 0,
      ajustesNaVenda: 0, receitaLiquida: 0,
      cmv: 0, margemBruta: 0, margemBrutaPct: 0,
      impostos: 0, aliquotaPct: null, despesasVariaveis: 0,
      margemContribuicao: 0, margemContribuicaoPct: 0,
      despesasFixas: 0, resultado4Wall: 0, resultado4WallPct: 0,
      rateioRede: 0, despesasFinanceiras: 0, resultadoLiquido: 0, lucratividade: 0,
      pontoEquilibrio: null, pontoEquilibrioDia: null, faltaPraEquilibrio: null,
      cupons: 0, pecas: 0, ticketMedio: 0,
      avisos: [], despesasDetalhe: [],
    };
  }

  /** Acumula a despesa na coluna E guarda de qual espécie ela veio. */
  private somaDespesa(col: DreColuna, especie: string, grupo: DreGrupoEspecie, valor: number) {
    if (grupo === 'VARIAVEL') col.despesasVariaveis += valor;
    else if (grupo === 'FINANCEIRA') col.despesasFinanceiras += valor;
    else col.despesasFixas += valor;

    const hit = col.despesasDetalhe.find((d) => d.especie === especie && d.grupo === grupo);
    if (hit) hit.valor += valor;
    else col.despesasDetalhe.push({ especie, grupo, valor });
  }

  /** Variantes do código de loja — o Giga grava ora '01', ora '1'. */
  private variantes(code: string): string[] {
    const s = String(code || '').trim().toUpperCase();
    const set = new Set<string>([s]);
    if (/^\d{1,2}$/.test(s)) {
      set.add(s.padStart(2, '0'));
      set.add(s.replace(/^0+/, '') || s);
    }
    return [...set];
  }

  // ── DRE ──────────────────────────────────────────────────────────────────

  async resultado(input: { de: string; ate: string }) {
    const { de, ate } = this.validaPeriodo(input.de, input.ate);
    const { startDate, endDate } = this.brtRange(de, ate);
    const { inicio, fimExclusive } = this.caixaRange(de, ate);
    const mesRef = ate.slice(0, 7);

    const stores: any[] = await (this.prisma as any).store.findMany({ orderBy: { code: 'asc' } });

    const colunas = new Map<string, DreColuna>();
    const indice = new Map<string, string>();     // chave normalizada → coluna.key
    const lojasRede: string[] = [];               // matriz (despesa a ratear)
    const franquiaStores: any[] = [];
    const canais: any[] = [];

    for (const s of stores) {
      const grupo = this.grupoDaLoja(s);
      if (grupo === 'FORA') continue;

      if (grupo === 'REDE') {
        lojasRede.push(s.code);
        for (const v of this.variantes(s.code)) indice.set(v, `__REDE__${s.code}`);
        if (s.name) indice.set(String(s.name).toUpperCase(), `__REDE__${s.code}`);
        continue;
      }
      if (grupo === 'FRANQUIA') {
        franquiaStores.push(s);
        for (const v of this.variantes(s.code)) indice.set(v, `__FRANQUIA__${s.code}`);
        if (s.name) indice.set(String(s.name).toUpperCase(), `__FRANQUIA__${s.code}`);
        continue;
      }

      const col = this.colunaVazia(s.code, s.name || s.code, grupo, this.soDigitos(s.expectedCnpj) || null);
      colunas.set(s.code, col);
      for (const v of this.variantes(s.code)) indice.set(v, s.code);
      if (s.name) indice.set(String(s.name).toUpperCase(), s.code);
      if (grupo === 'CANAL') canais.push(s);
    }

    const resolve = (raw: string): string | null => {
      const hit = indice.get(String(raw || '').trim().toUpperCase());
      if (!hit || hit.startsWith('__')) return null;
      return hit;
    };

    // ── 1) FATURAMENTO: mesma chamada da tela /retaguarda/faturamento ──
    const gigaPorLoja = await this.erp.getFaturamentoPorLoja(inicio, fimExclusive);

    let faturamentoForaDaDre = 0;
    const lojasForaDaDre: string[] = [];
    const franquiaBruto = new Map<string, { faturamento: number; cupons: number; pecas: number }>();

    for (const g of gigaPorLoja) {
      const alvo = indice.get(String(g.storeCode || '').trim().toUpperCase());
      if (alvo?.startsWith('__FRANQUIA__')) {
        const code = alvo.replace('__FRANQUIA__', '');
        const acc = franquiaBruto.get(code) || { faturamento: 0, cupons: 0, pecas: 0 };
        acc.faturamento += g.faturamento;
        acc.cupons += g.cupons;
        acc.pecas += g.pecas;
        franquiaBruto.set(code, acc);
        continue;
      }
      const key = alvo && !alvo.startsWith('__') ? alvo : null;
      if (!key) {
        // Loja que o Giga fatura e a DRE não conhece — não some em silêncio.
        faturamentoForaDaDre += g.faturamento;
        if (g.faturamento > 0) lojasForaDaDre.push(g.storeCode);
        continue;
      }
      const col = colunas.get(key)!;
      col.faturamentoBruto += g.faturamento;
      col.cupons += g.cupons;
      col.pecas += g.pecas;
    }

    // ── 2) CMV = receita ÷ markup ────────────────────────────────────────
    // Aplicado no fim (depois das devoluções), sobre a RECEITA LÍQUIDA: peça
    // devolvida não vendeu, então o custo dela sai junto automaticamente.

    // ── 3) Devoluções ────────────────────────────────────────────────────
    // O caixa do Giga NÃO registra devolução (returns.service só mexe em
    // estoque) e o vale-troca é FORMA DE PAGAMENTO — a peça nova entra CHEIA
    // no caixa. Sem abater aqui, a mesma mercadoria contaria duas vezes:
    // venda original + venda que consumiu o vale.
    //
    // Separado por modo porque são coisas diferentes: dinheiro/pix o cliente
    // levou embora; troca/crédito volta como venda nova depois.
    const devolucoes: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode",
              SUM(CASE WHEN modo IN ('dinheiro','pix') THEN valor_total ELSE 0 END)::float AS dinheiro,
              SUM(CASE WHEN modo NOT IN ('dinheiro','pix') THEN valor_total ELSE 0 END)::float AS troca
         FROM pdv_returns
        WHERE created_at >= $1 AND created_at <= $2 AND is_training = false
        GROUP BY store_code`,
      startDate, endDate,
    );
    for (const d of devolucoes) {
      const key = resolve(d.storeCode);
      if (!key) continue;
      const col = colunas.get(key)!;
      col.devolucoesDinheiro += Number(d.dinheiro || 0);
      col.devolucoesTroca += Number(d.troca || 0);
      col.devolucoes += Number(d.dinheiro || 0) + Number(d.troca || 0);
    }

    // ── 3a) SANIDADE DA CONTAGEM DE CUPOM ────────────────────────────────
    // O caixa do Giga é SUPERSET do PdvSale (tem as vendas do PDV via outbox
    // MAIS as lançadas direto no Giga). Logo cupons do caixa < vendas do
    // PdvSale é IMPOSSÍVEL — quando acontece, a chave do cupom está
    // colapsando (foi assim que o ticket médio foi pra R$ 1.000 em 26/07).
    // Fica no código como alarme permanente: se a numeração reiniciar por
    // caixa/operador e (data, número) não bastar, a tela avisa sozinha.
    const vendasFlow: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode", COUNT(*)::int AS vendas
         FROM pdv_sales
        WHERE finalized_at >= $1 AND finalized_at <= $2
          AND status = 'finalized' AND is_training = false
          AND (payment_method IS NULL OR payment_method <> 'MARCADO')
        GROUP BY store_code`,
      startDate, endDate,
    );
    const cuponsFlow = new Map<string, number>();
    for (const v of vendasFlow) {
      const key = resolve(v.storeCode);
      if (!key) continue;
      cuponsFlow.set(key, (cuponsFlow.get(key) || 0) + Number(v.vendas || 0));
    }

    // ── 3b) Ajuste negativo lançado DENTRO da venda ──────────────────────
    // Item manual com valor negativo ("TROCA DEFEITO -39,90") vai pro caixa
    // do Giga como linha negativa — ou seja, JÁ está abatido no faturamento
    // bruto. É só medido pra aparecer na tela; abater de novo seria contar a
    // mesma troca duas vezes (foi a suspeita do dono em 26/07).
    const ajustes: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT s.store_code AS "storeCode", SUM(i.total)::float AS total
         FROM pdv_sale_items i
         JOIN pdv_sales s ON s.id = i.sale_id
        WHERE s.finalized_at >= $1 AND s.finalized_at <= $2
          AND s.status = 'finalized' AND s.is_training = false
          AND i.total < 0
        GROUP BY s.store_code`,
      startDate, endDate,
    );
    for (const a of ajustes) {
      const key = resolve(a.storeCode);
      if (!key) continue;
      colunas.get(key)!.ajustesNaVenda += Math.abs(Number(a.total || 0));
    }

    // ── 4) Canais digitais (LIVE / SITE) ──
    await this.aplicaCanais(colunas, canais, startDate, endDate);

    // ── 5) Despesas (ContaPagar por VENCIMENTO) ──
    const especies: any[] = await (this.prisma as any).especieConta.findMany();
    const grupoPorEspecie = new Map<string, DreGrupoEspecie>();
    for (const e of especies) grupoPorEspecie.set(e.id, this.grupoDaEspecie(e));

    const nomeEspecie = new Map<string, string>();
    for (const e of especies) nomeEspecie.set(e.id, e.nome);

    const contas: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT loja_code AS "lojaCode", especie_id AS "especieId",
              SUM(valor_cents)::bigint AS "valorCents"
         FROM conta_pagar
        WHERE vencimento >= $1::date AND vencimento <= $2::date
          AND status <> 'cancelada' AND deleted_at IS NULL
        GROUP BY loja_code, especie_id`,
      de, ate,
    );

    let despesaRede = 0;
    let despesaFranquia = 0;
    const semEspecie = { valor: 0, lojas: new Set<string>() };
    // Despesa que a DRE viu e NÃO usou — o dono precisa saber o que foi
    // descartado e por quê, senão "faltou aluguel" vira mistério.
    const descartadas = new Map<string, { grupo: DreGrupoEspecie; valor: number }>();
    let despesaSemColuna = 0;

    for (const c of contas) {
      const valor = Number(c.valorCents || 0) / 100;
      if (!valor) continue;
      const g: DreGrupoEspecie = (c.especieId ? grupoPorEspecie.get(c.especieId) : undefined) || 'FIXA';
      const nome = (c.especieId ? nomeEspecie.get(c.especieId) : null) || '(sem espécie)';
      if (!c.especieId) {
        semEspecie.valor += valor;
        semEspecie.lojas.add(String(c.lojaCode));
      }
      if (g === 'CMV' || g === 'IMPOSTO' || g === 'IGNORAR') {
        const d = descartadas.get(nome) || { grupo: g, valor: 0 };
        d.valor += valor;
        descartadas.set(nome, d);
        continue;
      }

      const alvo = indice.get(String(c.lojaCode || '').trim().toUpperCase());
      if (alvo?.startsWith('__REDE__')) { despesaRede += valor; continue; }
      // Despesa lançada numa FRANQUIA é dela, não do dono — fica de fora.
      if (alvo?.startsWith('__FRANQUIA__')) { despesaFranquia += valor; continue; }
      const key = alvo && !alvo.startsWith('__') ? alvo : null;
      if (!key || !colunas.has(key)) { despesaSemColuna += valor; continue; }

      this.somaDespesa(colunas.get(key)!, nome, g, valor);
    }

    // ── 6) Imposto: 10% padrão, com override por CNPJ/mês ──
    const overrides = await this.aliquotasVigentes(mesRef);

    // ── 7) Fecha cada coluna ──
    const lista = [...colunas.values()].filter(
      (c) => c.faturamentoBruto || c.devolucoes || c.despesasFixas || c.despesasVariaveis || c.cmv,
    );
    const faturamentoRede = lista.reduce((s, c) => s + c.faturamentoBruto, 0);
    const serie = await this.serieDiaria(inicio, fimExclusive, indice);

    for (const col of lista) {
      col.receitaLiquida = col.faturamentoBruto - col.devolucoes;
      // CMV = venda ÷ 2,65 sobre a receita LÍQUIDA — peça devolvida não
      // vendeu, então o custo dela já sai junto. Regra ÚNICA: vale pra loja
      // física e pra canal digital (LIVE/SITE) igual.
      col.cmv = col.receitaLiquida / MARKUP;
      col.margemBruta = col.receitaLiquida - col.cmv;

      const aliq = (col.cnpj ? overrides.get(col.cnpj) : undefined) ?? ALIQUOTA_PADRAO;
      col.aliquotaPct = aliq;
      col.impostos = col.receitaLiquida * (aliq / 100);

      col.margemContribuicao = col.margemBruta - col.impostos - col.despesasVariaveis;
      col.resultado4Wall = col.margemContribuicao - col.despesasFixas;
      col.rateioRede = faturamentoRede ? despesaRede * (col.faturamentoBruto / faturamentoRede) : 0;
      col.resultadoLiquido = col.resultado4Wall - col.rateioRede - col.despesasFinanceiras;

      col.margemBrutaPct = this.pct(col.margemBruta, col.receitaLiquida);
      col.margemContribuicaoPct = this.pct(col.margemContribuicao, col.receitaLiquida);
      col.resultado4WallPct = this.pct(col.resultado4Wall, col.receitaLiquida);
      col.lucratividade = this.pct(col.resultadoLiquido, col.receitaLiquida);
      col.ticketMedio = col.cupons ? col.faturamentoBruto / col.cupons : 0;

      const custoFixoTotal = col.despesasFixas + col.rateioRede + col.despesasFinanceiras;
      if (col.margemContribuicaoPct > 0 && custoFixoTotal > 0) {
        col.pontoEquilibrio = custoFixoTotal / col.margemContribuicaoPct;
        const dia = this.diaDoEquilibrio(serie.get(col.key) || [], col.pontoEquilibrio);
        col.pontoEquilibrioDia = dia;
        col.faltaPraEquilibrio = dia ? 0 : Math.max(0, col.pontoEquilibrio - col.receitaLiquida);
      }

      if (!col.despesasFixas && col.faturamentoBruto) {
        col.avisos.push('Nenhuma despesa fixa lançada no Contas a Pagar pro período');
      }
      // Alarme de cupom colapsado (ver bloco 3a).
      const noFlow = cuponsFlow.get(col.key) || 0;
      if (noFlow > 0 && col.cupons > 0 && col.cupons < noFlow) {
        col.avisos.push(
          `Contagem de cupom suspeita: ${col.cupons} no caixa do Giga contra ${noFlow} vendas no PDV — ` +
          'o caixa contém o PDV, então não pode ter menos. O ticket médio está inflado; ' +
          'a numeração do cupom deve reiniciar por caixa/operador, não só por dia.',
        );
      }
      // Os DOIS caminhos de troca em uso ao mesmo tempo: se a mesma troca foi
      // lançada como item negativo E como devolução, ela é abatida em dobro.
      if (col.ajustesNaVenda > 0 && col.devolucoesTroca > 0) {
        col.avisos.push(
          `Troca lançada dos 2 jeitos no período: ${this.brl(col.ajustesNaVenda)} como item negativo ` +
          `dentro da venda (já abatido no faturamento) e ${this.brl(col.devolucoesTroca)} como devolução/vale. ` +
          'Confira se alguma foi lançada duas vezes.',
        );
      }
    }

    for (const col of lista) col.despesasDetalhe.sort((a, b) => b.valor - a.valor);
    lista.sort((a, b) => b.faturamentoBruto - a.faturamentoBruto);
    const total = this.consolida(lista);

    // ── 8) Bloco FRANQUIAS — o ganho do dono aqui é só o royalty ──
    const franquias = franquiaStores
      .map((s) => {
        const b = franquiaBruto.get(s.code) || { faturamento: 0, cupons: 0, pecas: 0 };
        return {
          code: s.code,
          name: s.name || s.code,
          faturamentoBruto: b.faturamento,
          cupons: b.cupons,
          pecas: b.pecas,
          royalties: b.faturamento * (ROYALTIES_PCT / 100),
          marketing: b.faturamento * (MARKETING_PCT / 100),
        };
      })
      .filter((f) => f.faturamentoBruto > 0)
      .sort((a, b) => b.faturamentoBruto - a.faturamentoBruto);

    const franquiaTotal = {
      faturamentoBruto: franquias.reduce((s, f) => s + f.faturamentoBruto, 0),
      royalties: franquias.reduce((s, f) => s + f.royalties, 0),
      marketing: franquias.reduce((s, f) => s + f.marketing, 0),
      royaltiesPct: ROYALTIES_PCT,
      marketingPct: MARKETING_PCT,
      despesaLancada: despesaFranquia,
    };

    return {
      de, ate, mesRef,
      total,
      colunas: lista,
      franquias: { lojas: franquias, ...franquiaTotal },
      // O que sobra pro dono: resultado das lojas próprias + royalties.
      consolidadoDono: {
        resultadoRede: total.resultadoLiquido,
        royaltiesFranquia: franquiaTotal.royalties,
        total: total.resultadoLiquido + franquiaTotal.royalties,
      },
      // Fecha a conta contra a tela de Faturamento: rede + franquias + fora.
      conciliacao: {
        faturamentoRede,
        faturamentoFranquias: franquiaTotal.faturamentoBruto,
        faturamentoForaDaDre,
        lojasForaDaDre,
        totalGrupo: faturamentoRede + franquiaTotal.faturamentoBruto + faturamentoForaDaDre,
      },
      rede: { despesaTotal: despesaRede, lojas: lojasRede, criterioRateio: 'faturamento' },
      // Toda despesa do Contas a Pagar que a DRE viu e NÃO somou. Sem isso,
      // "cadê o aluguel?" não tem resposta na tela.
      despesaDescartada: {
        porEspecie: [...descartadas.entries()]
          .map(([especie, d]) => ({ especie, grupo: d.grupo, valor: d.valor }))
          .sort((a, b) => b.valor - a.valor),
        semColuna: despesaSemColuna,
        emFranquia: despesaFranquia,
        total: [...descartadas.values()].reduce((s, d) => s + d.valor, 0)
          + despesaSemColuna + despesaFranquia,
      },
      config: {
        markup: MARKUP,
        aliquotaPadrao: ALIQUOTA_PADRAO,
        lojasSemGrupo: stores.filter((s) => !s.dreGrupo).map((s) => s.code),
        especiesSemGrupo: especies.filter((e) => !e.dreGrupo).length,
        contasSemEspecie: { valor: semEspecie.valor, lojas: [...semEspecie.lojas] },
      },
      fonte: 'Caixa do Giga (espelho giga_caixa_mov) — MESMA fonte da tela Faturamento por Loja',
    };
  }

  private consolida(lista: DreColuna[]) {
    const t = this.colunaVazia('TOTAL', 'TOTAL REDE', 'LOJA', null);
    for (const c of lista) {
      t.faturamentoBruto += c.faturamentoBruto;
      t.devolucoes += c.devolucoes;
      t.devolucoesDinheiro += c.devolucoesDinheiro;
      t.devolucoesTroca += c.devolucoesTroca;
      t.ajustesNaVenda += c.ajustesNaVenda;
      t.cmv += c.cmv;
      t.impostos += c.impostos;
      t.despesasVariaveis += c.despesasVariaveis;
      t.despesasFixas += c.despesasFixas;
      t.despesasFinanceiras += c.despesasFinanceiras;
      t.rateioRede += c.rateioRede;
      t.cupons += c.cupons;
      t.pecas += c.pecas;
      for (const d of c.despesasDetalhe) {
        const hit = t.despesasDetalhe.find((x) => x.especie === d.especie && x.grupo === d.grupo);
        if (hit) hit.valor += d.valor;
        else t.despesasDetalhe.push({ ...d });
      }
    }
    t.despesasDetalhe.sort((a, b) => b.valor - a.valor);
    t.receitaLiquida = t.faturamentoBruto - t.devolucoes;
    t.margemBruta = t.receitaLiquida - t.cmv;
    t.margemContribuicao = t.margemBruta - t.impostos - t.despesasVariaveis;
    t.resultado4Wall = t.margemContribuicao - t.despesasFixas;
    t.resultadoLiquido = t.resultado4Wall - t.rateioRede - t.despesasFinanceiras;
    t.margemBrutaPct = this.pct(t.margemBruta, t.receitaLiquida);
    t.margemContribuicaoPct = this.pct(t.margemContribuicao, t.receitaLiquida);
    t.resultado4WallPct = this.pct(t.resultado4Wall, t.receitaLiquida);
    t.lucratividade = this.pct(t.resultadoLiquido, t.receitaLiquida);
    t.ticketMedio = t.cupons ? t.faturamentoBruto / t.cupons : 0;
    t.aliquotaPct = t.receitaLiquida ? (t.impostos / t.receitaLiquida) * 100 : null;

    const custoFixoTotal = t.despesasFixas + t.rateioRede + t.despesasFinanceiras;
    if (t.margemContribuicaoPct > 0 && custoFixoTotal > 0) {
      t.pontoEquilibrio = custoFixoTotal / t.margemContribuicaoPct;
      t.faltaPraEquilibrio = Math.max(0, t.pontoEquilibrio - t.receitaLiquida);
    }
    return t;
  }

  /**
   * Canais digitais. A tela de Faturamento compõe SITE = Giga SITE (WhatsApp)
   * + Order do flowops + LIVE; aqui é a mesma composição — o Giga SITE já
   * entrou no passo 1, isto soma as duas partes que só existem no Flow.
   */
  private async aplicaCanais(
    colunas: Map<string, DreColuna>,
    canais: any[],
    startDate: Date,
    endDate: Date,
  ) {
    if (!canais.length) return;

    const acha = (regex: RegExp): DreColuna | null => {
      const s = canais.find((c) => regex.test(`${c.name || ''} ${c.code || ''}`.toUpperCase()));
      return (s ? colunas.get(s.code) : null) || colunas.get(canais[0].code) || null;
    };
    const colLive = acha(/\bLIVE\b/);
    const colSite = acha(/\bSITE\b|E-?COMMERCE/);

    if (colLive) {
      const [venda]: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS cupons, COALESCE(SUM(subtotal_cents), 0)::bigint AS total
           FROM live_pdv_carts
          WHERE paid_at >= $1 AND paid_at <= $2 AND status = ANY($3::text[])`,
        startDate, endDate, LIVE_VENDIDO,
      );
      colLive.faturamentoBruto += Number(venda?.total || 0) / 100;
      colLive.cupons += Number(venda?.cupons || 0);

      // Só as PEÇAS — o CMV do canal sai do markup, igual às lojas.
      const [pc]: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT COALESCE(SUM(i.qty), 0)::int AS pecas
           FROM live_pdv_items i
           JOIN live_pdv_carts c ON c.id = i.cart_id
          WHERE c.paid_at >= $1 AND c.paid_at <= $2
            AND c.status = ANY($3::text[]) AND i.status <> 'cancelled'`,
        startDate, endDate, LIVE_VENDIDO,
      );
      colLive.pecas += Number(pc?.pecas || 0);
    }

    if (colSite) {
      const [venda]: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS cupons, COALESCE(SUM(total_amount), 0)::float AS total
           FROM orders
          WHERE created_at >= $1 AND created_at <= $2
            AND status = 'completed' AND source <> 'live'`,
        startDate, endDate,
      );
      colSite.faturamentoBruto += Number(venda?.total || 0);
      colSite.cupons += Number(venda?.cupons || 0);

      const [pc]: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT COALESCE(SUM(oi.quantity), 0)::int AS pecas
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE o.created_at >= $1 AND o.created_at <= $2
            AND o.status = 'completed' AND o.source <> 'live'`,
        startDate, endDate,
      );
      colSite.pecas += Number(pc?.pecas || 0);

      if (colLive && colSite.key === colLive.key) {
        colSite.avisos.push('LIVE e SITE na MESMA coluna — cadastre uma loja-canal pra cada um pra separar');
      }
    }
  }

  /** Faturamento por dia e por loja (caixa do Giga) — base do PE-dia. */
  private async serieDiaria(inicio: Date, fimExclusive: Date, indice: Map<string, string>) {
    const out = new Map<string, Array<{ dia: string; total: number }>>();
    try {
      const rows: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT loja AS "storeCode",
                to_char(data_fec, 'YYYY-MM-DD') AS dia,
                COALESCE(SUM(valor_total), 0)::float8 AS total
           FROM giga_caixa_mov
          WHERE data_fec >= $1 AND data_fec < $2
            AND (marcado IS NULL OR marcado <> 'SIM')
          GROUP BY 1, 2 ORDER BY 2`,
        inicio, fimExclusive,
      );
      for (const r of rows) {
        const key = indice.get(String(r.storeCode || '').trim().toUpperCase());
        if (!key || key.startsWith('__')) continue;
        const arr = out.get(key) || [];
        arr.push({ dia: r.dia, total: Number(r.total || 0) });
        out.set(key, arr);
      }
    } catch (e: any) {
      this.logger.warn(`[dre] série diária falhou: ${e?.message || e}`);
    }
    return out;
  }

  private diaDoEquilibrio(serie: Array<{ dia: string; total: number }>, pe: number): string | null {
    let acc = 0;
    for (const p of serie) {
      acc += p.total;
      if (acc >= pe) return p.dia;
    }
    return null;
  }

  /** Overrides de alíquota por CNPJ (o padrão é ALIQUOTA_PADRAO). */
  private async aliquotasVigentes(mesRef: string): Promise<Map<string, number>> {
    const rows: any[] = await (this.prisma as any).dreAliquota.findMany({
      where: { mes: { lte: mesRef } },
      orderBy: [{ cnpj: 'asc' }, { mes: 'desc' }],
    });
    const out = new Map<string, number>();
    for (const r of rows) {
      const cnpj = this.soDigitos(r.cnpj);
      if (!out.has(cnpj)) out.set(cnpj, Number(r.aliquotaPct));
    }
    return out;
  }

  // ── drill-down ───────────────────────────────────────────────────────────

  async drill(input: { de: string; ate: string; coluna: string; linha: string }) {
    const { de, ate } = this.validaPeriodo(input.de, input.ate);
    const { inicio, fimExclusive } = this.caixaRange(de, ate);
    const linha = String(input.linha || '').toUpperCase();

    const store: any = await (this.prisma as any).store.findUnique({ where: { code: input.coluna } });
    const codes = [...this.variantes(input.coluna), ...(store?.name ? [String(store.name).toUpperCase()] : [])];

    if (linha === 'FATURAMENTO') {
      const vendas: any[] = await this.prisma.$queryRawUnsafe(
        // Aqui o GROUP BY já é por DIA, então DISTINCT numero basta — mas
        // mantém a chave completa pra não virar armadilha se o agrupamento mudar.
        `SELECT to_char(data_fec, 'YYYY-MM-DD') AS dia,
                COUNT(DISTINCT (data_fec, numero))::int AS cupons,
                COALESCE(SUM(valor_total), 0)::float8 AS total
           FROM giga_caixa_mov
          WHERE data_fec >= $1 AND data_fec < $2
            AND (marcado IS NULL OR marcado <> 'SIM')
            AND upper(trim(loja)) = ANY($3::text[])
          GROUP BY 1 ORDER BY 1`,
        inicio, fimExclusive, codes,
      );
      return { tipo: 'faturamento', linhas: vendas };
    }

    if (['FIXA', 'VARIAVEL', 'FINANCEIRA', 'DESPESAS'].includes(linha)) {
      const especies: any[] = await (this.prisma as any).especieConta.findMany();
      const idsDoGrupo = new Set(
        especies
          .filter((e) => {
            const g = this.grupoDaEspecie(e);
            if (linha === 'DESPESAS') return g === 'FIXA' || g === 'VARIAVEL' || g === 'FINANCEIRA';
            return g === linha;
          })
          .map((e) => e.id),
      );
      const contas: any[] = await (this.prisma as any).contaPagar.findMany({
        where: {
          lojaCode: { in: codes },
          vencimento: { gte: new Date(`${de}T00:00:00Z`), lte: new Date(`${ate}T00:00:00Z`) },
          status: { not: 'cancelada' },
          deletedAt: null,
        },
        orderBy: { vencimento: 'asc' },
        take: 500,
        include: { especie: true },
      });
      const filtradas = contas.filter(
        (c) => (c.especieId && idsDoGrupo.has(c.especieId))
          || (!c.especieId && linha !== 'VARIAVEL' && linha !== 'FINANCEIRA'),
      );
      return {
        tipo: 'despesas',
        linhas: filtradas.map((c) => ({
          id: c.id,
          numero: c.numero,
          vencimento: c.vencimento,
          beneficiario: c.fornecedorNome || c.sellerNome || '—',
          especie: c.especie?.nome || '(sem espécie)',
          valor: Number(c.valorCents || 0) / 100,
          status: c.status,
          notaFiscal: c.notaFiscal,
        })),
        truncado: contas.length >= 500,
      };
    }

    throw new BadRequestException(`Linha "${input.linha}" não tem drill-down`);
  }

  // ── configuração ─────────────────────────────────────────────────────────

  async config() {
    const [stores, especies, aliquotas] = await Promise.all([
      (this.prisma as any).store.findMany({ orderBy: { code: 'asc' } }),
      (this.prisma as any).especieConta.findMany({ orderBy: { nome: 'asc' } }),
      (this.prisma as any).dreAliquota.findMany({ orderBy: [{ cnpj: 'asc' }, { mes: 'desc' }] }),
    ]);

    return {
      aliquotaPadrao: ALIQUOTA_PADRAO,
      royaltiesPct: ROYALTIES_PCT,
      marketingPct: MARKETING_PCT,
      lojas: stores.map((s: any) => ({
        code: s.code,
        name: s.name,
        active: s.active,
        tipo: s.tipo,
        cnpj: this.soDigitos(s.expectedCnpj) || null,
        dreGrupo: s.dreGrupo || null,
        dreGrupoEfetivo: this.grupoDaLoja(s),
        configurado: !!s.dreGrupo,
      })),
      especies: especies.map((e: any) => ({
        id: e.id,
        nome: e.nome,
        dreGrupo: e.dreGrupo || null,
        dreGrupoEfetivo: this.grupoDaEspecie(e),
        configurado: !!e.dreGrupo,
      })),
      aliquotas: aliquotas.map((a: any) => ({
        id: a.id, cnpj: a.cnpj, mes: a.mes,
        aliquotaPct: Number(a.aliquotaPct), observacao: a.observacao,
      })),
      grupos: {
        loja: ['LOJA', 'CANAL', 'FRANQUIA', 'REDE', 'FORA'],
        especie: ['VARIAVEL', 'FIXA', 'FINANCEIRA', 'CMV', 'IMPOSTO', 'IGNORAR'],
      },
    };
  }

  async setGrupoLoja(code: string, grupo: string) {
    const g = String(grupo || '').toUpperCase();
    if (!['LOJA', 'CANAL', 'FRANQUIA', 'REDE', 'FORA'].includes(g)) {
      throw new BadRequestException('Grupo inválido (LOJA | CANAL | FRANQUIA | REDE | FORA)');
    }
    await (this.prisma as any).store.update({ where: { code }, data: { dreGrupo: g } });
    return { ok: true, code, dreGrupo: g };
  }

  async setGrupoEspecie(id: string, grupo: string) {
    const g = String(grupo || '').toUpperCase();
    if (!['VARIAVEL', 'FIXA', 'FINANCEIRA', 'CMV', 'IMPOSTO', 'IGNORAR'].includes(g)) {
      throw new BadRequestException('Grupo inválido');
    }
    await (this.prisma as any).especieConta.update({ where: { id }, data: { dreGrupo: g } });
    return { ok: true, id, dreGrupo: g };
  }

  async upsertAliquota(
    input: { cnpj: string; mes: string; aliquotaPct: number; observacao?: string },
    usuario?: string,
  ) {
    const cnpj = this.soDigitos(input.cnpj);
    if (cnpj.length !== 14) throw new BadRequestException('CNPJ inválido (14 dígitos)');
    const mes = String(input.mes || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) throw new BadRequestException('Mês inválido (YYYY-MM)');
    const pct = Number(input.aliquotaPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new BadRequestException('Alíquota deve estar entre 0 e 100');
    }
    const row = await (this.prisma as any).dreAliquota.upsert({
      where: { cnpj_mes: { cnpj, mes } },
      create: { cnpj, mes, aliquotaPct: pct, observacao: input.observacao || null, criadoPor: usuario || null },
      update: { aliquotaPct: pct, observacao: input.observacao || null },
    });
    return { ok: true, id: row.id, cnpj, mes, aliquotaPct: pct };
  }

  async deleteAliquota(id: string) {
    await (this.prisma as any).dreAliquota.delete({ where: { id } });
    return { ok: true };
  }
}
