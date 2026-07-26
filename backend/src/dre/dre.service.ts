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
 * │ O CMV sai da MESMA linha de caixa (getCustoVendidoPorLoja).             │
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

/** Markup padrão da planilha (preço = custo × 2,7) — último fallback de CMV. */
const MARKUP_FALLBACK = 2.7;

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
  cmvEstimadoPct: number;
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
    const nome = `${store?.name || ''} ${store?.code || ''}`.toUpperCase();
    if (/\bSITE\b|\bLIVE\b|E-?COMMERCE/.test(nome)) return 'CANAL';
    return 'LOJA';
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
      faturamentoBruto: 0, devolucoes: 0, receitaLiquida: 0,
      cmv: 0, margemBruta: 0, margemBrutaPct: 0,
      impostos: 0, aliquotaPct: null, despesasVariaveis: 0,
      margemContribuicao: 0, margemContribuicaoPct: 0,
      despesasFixas: 0, resultado4Wall: 0, resultado4WallPct: 0,
      rateioRede: 0, despesasFinanceiras: 0, resultadoLiquido: 0, lucratividade: 0,
      pontoEquilibrio: null, pontoEquilibrioDia: null, faltaPraEquilibrio: null,
      cupons: 0, pecas: 0, ticketMedio: 0,
      avisos: [], cmvEstimadoPct: 0,
    };
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

    // ── 2) CMV: mesma linha de caixa do faturamento ──
    const custos = await this.erp.getCustoVendidoPorLoja(inicio, fimExclusive, MARKUP_FALLBACK);
    const cmvIndisponivel = custos == null;
    if (custos) {
      for (const c of custos) {
        const key = resolve(c.storeCode);
        if (!key) continue;
        const col = colunas.get(key)!;
        col.cmv += c.cmv;
        if (col.faturamentoBruto > 0) {
          col.cmvEstimadoPct = Math.min(1, c.receitaSemCusto / col.faturamentoBruto);
        }
      }
    }

    // ── 3) Devoluções (Flow) — o caixa do Giga não registra devolução ──
    const devolucoes: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode", SUM(valor_total)::float AS total
         FROM pdv_returns
        WHERE created_at >= $1 AND created_at <= $2 AND is_training = false
        GROUP BY store_code`,
      startDate, endDate,
    );
    for (const d of devolucoes) {
      const key = resolve(d.storeCode);
      if (!key) continue;
      const col = colunas.get(key)!;
      col.devolucoes += Number(d.total || 0);
      // A peça voltou: o custo dela também sai do CMV.
      col.cmv -= Number(d.total || 0) / MARKUP_FALLBACK;
    }

    // ── 4) Canais digitais (LIVE / SITE) ──
    await this.aplicaCanais(colunas, canais, startDate, endDate);

    // ── 5) Despesas (ContaPagar por VENCIMENTO) ──
    const especies: any[] = await (this.prisma as any).especieConta.findMany();
    const grupoPorEspecie = new Map<string, DreGrupoEspecie>();
    for (const e of especies) grupoPorEspecie.set(e.id, this.grupoDaEspecie(e));

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

    for (const c of contas) {
      const valor = Number(c.valorCents || 0) / 100;
      if (!valor) continue;
      const g: DreGrupoEspecie = (c.especieId ? grupoPorEspecie.get(c.especieId) : undefined) || 'FIXA';
      if (!c.especieId) {
        semEspecie.valor += valor;
        semEspecie.lojas.add(String(c.lojaCode));
      }
      if (g === 'CMV' || g === 'IMPOSTO' || g === 'IGNORAR') continue;

      const alvo = indice.get(String(c.lojaCode || '').trim().toUpperCase());
      if (alvo?.startsWith('__REDE__')) { despesaRede += valor; continue; }
      // Despesa lançada numa FRANQUIA é dela, não do dono — fica de fora.
      if (alvo?.startsWith('__FRANQUIA__')) { despesaFranquia += valor; continue; }
      const key = alvo && !alvo.startsWith('__') ? alvo : null;
      if (!key || !colunas.has(key)) continue;

      const col = colunas.get(key)!;
      if (g === 'VARIAVEL') col.despesasVariaveis += valor;
      else if (g === 'FINANCEIRA') col.despesasFinanceiras += valor;
      else col.despesasFixas += valor;
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

      if (cmvIndisponivel) {
        col.avisos.push('CMV indisponível — o espelho do caixa não cobre este período');
      } else if (col.cmvEstimadoPct > 0.05) {
        col.avisos.push(
          `CMV estimado em ${(col.cmvEstimadoPct * 100).toFixed(0)}% da receita (produto fora do espelho)`,
        );
      }
      if (!col.despesasFixas && col.faturamentoBruto) {
        col.avisos.push('Nenhuma despesa fixa lançada no Contas a Pagar pro período');
      }
    }

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
      config: {
        markupFallback: MARKUP_FALLBACK,
        aliquotaPadrao: ALIQUOTA_PADRAO,
        cmvIndisponivel,
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
      t.cmv += c.cmv;
      t.impostos += c.impostos;
      t.despesasVariaveis += c.despesasVariaveis;
      t.despesasFixas += c.despesasFixas;
      t.despesasFinanceiras += c.despesasFinanceiras;
      t.rateioRede += c.rateioRede;
      t.cupons += c.cupons;
      t.pecas += c.pecas;
    }
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

      // Peça sai da loja a PREÇO DE CUSTO (decisão do dono): o canal assume o
      // custo real, a loja de origem não fatura nada por ela.
      const [cmv]: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT COALESCE(SUM(i.qty), 0)::int AS pecas,
                COALESCE(SUM(COALESCE(wp.custo, i.custo_cents / 100.0, 0) * i.qty), 0)::float AS cmv
           FROM live_pdv_items i
           JOIN live_pdv_carts c ON c.id = i.cart_id
           LEFT JOIN wincred_produtos wp ON wp.codigo = ltrim(i.codigo_bipado, '0')
          WHERE c.paid_at >= $1 AND c.paid_at <= $2
            AND c.status = ANY($3::text[]) AND i.status <> 'cancelled'`,
        startDate, endDate, LIVE_VENDIDO,
      );
      colLive.cmv += Number(cmv?.cmv || 0);
      colLive.pecas += Number(cmv?.pecas || 0);
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

      const [cmv]: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT COALESCE(SUM(oi.quantity), 0)::int AS pecas,
                COALESCE(SUM(COALESCE(wp.custo, oi.unit_price / ${MARKUP_FALLBACK}, 0) * oi.quantity), 0)::float AS cmv
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN wincred_produtos wp ON wp.codigo = ltrim(oi.sku, '0')
          WHERE o.created_at >= $1 AND o.created_at <= $2
            AND o.status = 'completed' AND o.source <> 'live'`,
        startDate, endDate,
      );
      colSite.cmv += Number(cmv?.cmv || 0);
      colSite.pecas += Number(cmv?.pecas || 0);

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
        `SELECT to_char(data_fec, 'YYYY-MM-DD') AS dia,
                COUNT(DISTINCT numero)::int AS cupons,
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
