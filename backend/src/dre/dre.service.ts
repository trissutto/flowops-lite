import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * DRE por loja — painel /retaguarda/dre (v1, 26/07/2026).
 *
 * Traduz a "PLANILHA IDEAL" (modelo SEBRAE/SP) pro que o Flow já sabe, com as
 * decisões fechadas com o dono:
 *
 *  1. Faturamento, devolução e CMV saem do FLOW (PdvSale/PdvReturn + itens).
 *     Venda lançada só no Giga (WhatsApp antigo) NÃO entra — a tela avisa.
 *  2. CMV = custo CONGELADO no item (`custoUnitCents`, gravado no bipe). Item
 *     sem carimbo cai pro custo ATUAL do produto e, na falta dele, pro markup
 *     padrão — nos dois casos a coluna é marcada como ESTIMADA.
 *  3. Despesa vem de ContaPagar por VENCIMENTO (competência), classificada
 *     pelo `EspecieConta.dreGrupo`. Compra de mercadoria (CMV) e DAS (IMPOSTO)
 *     ficam de fora: entrariam duas vezes.
 *  4. Imposto = alíquota efetiva por CNPJ × mês (`DreAliquota`), aplicada
 *     sobre a receita líquida. Loja herda pelo `Store.expectedCnpj`.
 *  5. Dois resultados por coluna: 4-WALL (só o que a loja controla) e
 *     LÍQUIDO (depois do rateio das despesas da matriz, por faturamento).
 *  6. LIVE e SITE são COLUNAS (Store com dreGrupo='CANAL'). A peça que sai da
 *     loja entra no canal a PREÇO DE CUSTO — a loja de origem não fatura nada
 *     por ela, a margem inteira do digital aparece na coluna do canal.
 */

/** Markup padrão da planilha (preço = custo × 2,7) — último fallback de CMV. */
const MARKUP_FALLBACK = 2.7;

/** Status de venda da LIVE que contam como vendido (mesma lista do faturamento). */
const LIVE_VENDIDO = ['paid', 'separating', 'shipped', 'delivered'];

type DreGrupoLoja = 'LOJA' | 'CANAL' | 'REDE' | 'FORA';
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

  /** Sinalizadores de qualidade do número — a tela mostra como aviso. */
  avisos: string[];
  cmvEstimadoPct: number;
}

@Injectable()
export class DreService {
  private readonly logger = new Logger(DreService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── helpers ──────────────────────────────────────────────────────────────

  private brtRange(de: string, ate: string): { startDate: Date; endDate: Date } {
    const startDate = new Date(`${de}T03:00:00.000Z`); // 00:00 BRT
    const endDate = new Date(new Date(`${ate}T03:00:00.000Z`).getTime() + 24 * 3600 * 1000 - 1);
    return { startDate, endDate };
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
   * Papel da loja na DRE. Enquanto o dono não configurar, LIVE/SITE viram
   * CANAL pelo nome e o resto vira LOJA — nunca REDE por heurística (rateio
   * inventado é pior que rateio zero).
   */
  private grupoDaLoja(store: any): DreGrupoLoja {
    const cfg = String(store?.dreGrupo || '').toUpperCase();
    if (cfg === 'LOJA' || cfg === 'CANAL' || cfg === 'REDE' || cfg === 'FORA') {
      return cfg as DreGrupoLoja;
    }
    const nome = `${store?.name || ''} ${store?.code || ''}`.toUpperCase();
    if (/\bSITE\b|\bLIVE\b|E-?COMMERCE/.test(nome)) return 'CANAL';
    return 'LOJA';
  }

  /**
   * Classificação da espécie de conta. A heurística cobre a base herdada do
   * GIGA (20 anos de espécies sem grupo) — o painel deixa reclassificar.
   */
  private grupoDaEspecie(especie: any): DreGrupoEspecie {
    const cfg = String(especie?.dreGrupo || '').toUpperCase();
    if (['VARIAVEL', 'FIXA', 'FINANCEIRA', 'CMV', 'IMPOSTO', 'IGNORAR'].includes(cfg)) {
      return cfg as DreGrupoEspecie;
    }
    const n = String(especie?.nome || '').toUpperCase();
    if (!n) return 'FIXA';
    // Compra de mercadoria → o CMV vem das peças vendidas, não da compra.
    if (/MERCADORIA|COMPRA|FORNECEDOR|DUPLICATA/.test(n)) return 'CMV';
    // Imposto → vem da alíquota por CNPJ.
    if (/IMPOSTO|DAS\b|SIMPLES|ICMS|PIS|COFINS|IRPJ|CSLL|TRIBUT/.test(n)) return 'IMPOSTO';
    if (/JURO|MULTA|IOF|EMPRESTIMO|EMPRÉSTIMO|FINANCIAMENTO/.test(n)) return 'FINANCEIRA';
    if (/COMISS|TAXA|CARTAO|CARTÃO|FRETE|ROYALT|MARKETING|PUBLICID/.test(n)) return 'VARIAVEL';
    if (/TRANSFER|ADIANT|VALE\b|APORTE|EMPRESTIMO SOCIO/.test(n)) return 'IGNORAR';
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

  // ── DRE ──────────────────────────────────────────────────────────────────

  async resultado(input: { de: string; ate: string }) {
    const { de, ate } = this.validaPeriodo(input.de, input.ate);
    const { startDate, endDate } = this.brtRange(de, ate);
    const mesRef = ate.slice(0, 7);

    const stores: any[] = await (this.prisma as any).store.findMany({
      orderBy: { code: 'asc' },
    });

    // Mapa storeCode/nome → coluna. O PdvSale grava ora o code, ora o nome da
    // loja (histórico) — o faturamento já lida com isso; aqui o índice aceita
    // os dois pra não perder venda.
    const colunas = new Map<string, DreColuna>();
    const indice = new Map<string, string>(); // chave normalizada → coluna.key
    const lojasRede: string[] = [];           // storeCodes com dreGrupo=REDE
    const canais: any[] = [];

    for (const s of stores) {
      const grupo = this.grupoDaLoja(s);
      if (grupo === 'FORA') continue;
      if (grupo === 'REDE') {
        lojasRede.push(s.code);
        indice.set(String(s.code).toUpperCase(), `__REDE__${s.code}`);
        indice.set(String(s.name || '').toUpperCase(), `__REDE__${s.code}`);
        continue;
      }
      if (!s.active && grupo === 'LOJA') {
        // Loja inativa só entra se tiver movimento no período — resolvido
        // abaixo, quando a venda aparece sem coluna. Segue cadastrada no
        // índice pra receber o movimento.
      }
      const col = this.colunaVazia(s.code, s.name || s.code, grupo, this.soDigitos(s.expectedCnpj) || null);
      colunas.set(s.code, col);
      indice.set(String(s.code).toUpperCase(), s.code);
      if (s.name) indice.set(String(s.name).toUpperCase(), s.code);
      if (grupo === 'CANAL') canais.push(s);
    }

    const resolve = (raw: string): string | null => {
      const k = String(raw || '').trim().toUpperCase();
      const hit = indice.get(k);
      if (!hit) return null;
      return hit.startsWith('__REDE__') ? null : hit;
    };

    // ── 1) Faturamento e peças das LOJAS FÍSICAS (PdvSale) ──
    const vendas: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode",
              COUNT(*)::int AS cupons,
              SUM(total)::float AS total
         FROM pdv_sales
        WHERE finalized_at >= $1 AND finalized_at <= $2
          AND status = 'finalized'
          AND is_training = false
          AND (payment_method IS NULL OR payment_method <> 'MARCADO')
        GROUP BY store_code`,
      startDate, endDate,
    );

    for (const v of vendas) {
      const key = resolve(v.storeCode);
      if (!key) continue;
      const col = colunas.get(key)!;
      col.faturamentoBruto += Number(v.total || 0);
      col.cupons += Number(v.cupons || 0);
    }

    // ── 2) CMV das lojas físicas ──
    // Custo carimbado no item > custo atual do espelho Wincred > markup.
    // `ltrim(sku,'0')` porque o código do Giga tem padding de zero inconsistente
    // e o espelho guarda normalizado.
    const cmvLojas: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT s.store_code AS "storeCode",
              SUM(i.qty)::int AS pecas,
              SUM(COALESCE(i.custo_unit_cents / 100.0, wp.custo, 0) * i.qty)::float AS cmv,
              SUM(CASE WHEN i.custo_unit_cents IS NULL THEN i.qty ELSE 0 END)::int AS "pecasEstimadas",
              SUM(CASE WHEN i.custo_unit_cents IS NULL AND wp.custo IS NULL
                       THEN i.total ELSE 0 END)::float AS "receitaSemCusto"
         FROM pdv_sale_items i
         JOIN pdv_sales s ON s.id = i.sale_id
         LEFT JOIN wincred_produtos wp ON wp.codigo = ltrim(i.sku, '0')
        WHERE s.finalized_at >= $1 AND s.finalized_at <= $2
          AND s.status = 'finalized'
          AND s.is_training = false
          AND (s.payment_method IS NULL OR s.payment_method <> 'MARCADO')
        GROUP BY s.store_code`,
      startDate, endDate,
    );

    const estimativa = new Map<string, { pecas: number; estimadas: number }>();
    for (const r of cmvLojas) {
      const key = resolve(r.storeCode);
      if (!key) continue;
      const col = colunas.get(key)!;
      col.pecas += Number(r.pecas || 0);
      // Peça sem custo em lugar nenhum (item manual, produto fora do espelho)
      // entra pelo markup da planilha pra não zerar o CMV e inflar a margem.
      col.cmv += Number(r.cmv || 0) + Number(r.receitaSemCusto || 0) / MARKUP_FALLBACK;
      const acc = estimativa.get(key) || { pecas: 0, estimadas: 0 };
      acc.pecas += Number(r.pecas || 0);
      acc.estimadas += Number(r.pecasEstimadas || 0);
      estimativa.set(key, acc);
    }

    // ── 3) Devoluções (reversão de receita E de CMV) ──
    // TODAS as modalidades abatem: a peça voltou. Quando o vale é usado numa
    // venda futura, aquela venda entra inteira — sem abater aqui, a mesma
    // mercadoria contaria receita duas vezes.
    const devolucoes: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode", SUM(valor_total)::float AS total
         FROM pdv_returns
        WHERE created_at >= $1 AND created_at <= $2
          AND is_training = false
        GROUP BY store_code`,
      startDate, endDate,
    );
    for (const d of devolucoes) {
      const key = resolve(d.storeCode);
      if (!key) continue;
      colunas.get(key)!.devolucoes += Number(d.total || 0);
    }

    const cmvDevolvido: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT r.store_code AS "storeCode",
              SUM(COALESCE(wp.custo, ri.total / ${MARKUP_FALLBACK}) * ri.qty)::float AS cmv
         FROM pdv_return_items ri
         JOIN pdv_returns r ON r.id = ri.return_id
         LEFT JOIN wincred_produtos wp ON wp.codigo = ltrim(ri.sku, '0')
        WHERE r.created_at >= $1 AND r.created_at <= $2
          AND r.is_training = false
        GROUP BY r.store_code`,
      startDate, endDate,
    );
    for (const d of cmvDevolvido) {
      const key = resolve(d.storeCode);
      if (!key) continue;
      colunas.get(key)!.cmv -= Number(d.cmv || 0);
    }

    // ── 4) Canais: LIVE (carrinho pago) e SITE (Order do WooCommerce) ──
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
          AND status <> 'cancelada'
          AND deleted_at IS NULL
        GROUP BY loja_code, especie_id`,
      de, ate,
    );

    let despesaRede = 0;
    const semEspecie = { valor: 0, lojas: new Set<string>() };

    for (const c of contas) {
      const valor = Number(c.valorCents || 0) / 100;
      if (!valor) continue;
      const grupo = c.especieId ? grupoPorEspecie.get(c.especieId) : undefined;
      const g: DreGrupoEspecie = grupo || 'FIXA';
      if (!c.especieId) {
        semEspecie.valor += valor;
        semEspecie.lojas.add(String(c.lojaCode));
      }
      // CMV/IMPOSTO/IGNORAR não entram como despesa (dupla contagem).
      if (g === 'CMV' || g === 'IMPOSTO' || g === 'IGNORAR') continue;

      const raw = String(c.lojaCode || '').trim().toUpperCase();
      const alvo = indice.get(raw);
      if (alvo && alvo.startsWith('__REDE__')) {
        despesaRede += valor;
        continue;
      }
      const key = alvo || null;
      if (!key || !colunas.has(key)) continue; // conta de loja fora da DRE
      const col = colunas.get(key)!;
      if (g === 'VARIAVEL') col.despesasVariaveis += valor;
      else if (g === 'FINANCEIRA') col.despesasFinanceiras += valor;
      else col.despesasFixas += valor;
    }

    // ── 6) Imposto pela alíquota do CNPJ ──
    const aliquotas = await this.aliquotasVigentes(mesRef);

    // ── 7) Fecha a conta de cada coluna ──
    const lista = [...colunas.values()].filter(
      (c) => c.faturamentoBruto || c.devolucoes || c.despesasFixas || c.despesasVariaveis || c.cmv,
    );

    const faturamentoTotal = lista.reduce((s, c) => s + c.faturamentoBruto, 0);
    const serie = await this.serieDiaria(startDate, endDate, indice);

    for (const col of lista) {
      col.receitaLiquida = col.faturamentoBruto - col.devolucoes;
      col.margemBruta = col.receitaLiquida - col.cmv;

      const aliq = col.cnpj ? aliquotas.get(col.cnpj) ?? null : null;
      col.aliquotaPct = aliq;
      col.impostos = aliq != null ? col.receitaLiquida * (aliq / 100) : 0;

      col.margemContribuicao = col.margemBruta - col.impostos - col.despesasVariaveis;
      col.resultado4Wall = col.margemContribuicao - col.despesasFixas;

      // Rateio da matriz, proporcional ao faturamento.
      col.rateioRede = faturamentoTotal
        ? despesaRede * (col.faturamentoBruto / faturamentoTotal)
        : 0;

      col.resultadoLiquido = col.resultado4Wall - col.rateioRede - col.despesasFinanceiras;

      col.margemBrutaPct = this.pct(col.margemBruta, col.receitaLiquida);
      col.margemContribuicaoPct = this.pct(col.margemContribuicao, col.receitaLiquida);
      col.resultado4WallPct = this.pct(col.resultado4Wall, col.receitaLiquida);
      col.lucratividade = this.pct(col.resultadoLiquido, col.receitaLiquida);
      col.ticketMedio = col.cupons ? col.faturamentoBruto / col.cupons : 0;

      // Ponto de equilíbrio: custo fixo ÷ margem de contribuição %.
      const custoFixoTotal = col.despesasFixas + col.rateioRede + col.despesasFinanceiras;
      const mcPct = col.margemContribuicaoPct;
      if (mcPct > 0 && custoFixoTotal > 0) {
        col.pontoEquilibrio = custoFixoTotal / mcPct;
        const dia = this.diaDoEquilibrio(serie.get(col.key) || [], col.pontoEquilibrio);
        col.pontoEquilibrioDia = dia;
        col.faltaPraEquilibrio = dia ? 0 : Math.max(0, col.pontoEquilibrio - col.receitaLiquida);
      }

      // Avisos de qualidade
      const est = estimativa.get(col.key);
      if (est && est.pecas > 0) {
        col.cmvEstimadoPct = est.estimadas / est.pecas;
        if (col.cmvEstimadoPct > 0.05) {
          col.avisos.push(
            `CMV estimado em ${(col.cmvEstimadoPct * 100).toFixed(0)}% das peças (venda anterior ao carimbo de custo)`,
          );
        }
      }
      if (col.grupo === 'CANAL' && col.cmv > 0 && !col.faturamentoBruto) {
        col.avisos.push('Canal com custo e sem faturamento no período');
      }
      if (col.aliquotaPct == null) {
        col.avisos.push(
          col.cnpj
            ? `Sem alíquota cadastrada pro CNPJ ${col.cnpj} — imposto entrou como zero`
            : 'Loja sem CNPJ cadastrado — imposto entrou como zero',
        );
      }
      if (!col.despesasFixas && col.faturamentoBruto) {
        col.avisos.push('Nenhuma despesa fixa lançada no Contas a Pagar pro período');
      }
    }

    lista.sort((a, b) => b.faturamentoBruto - a.faturamentoBruto);

    const total = this.consolida(lista, despesaRede);

    return {
      de, ate, mesRef,
      total,
      colunas: lista,
      rede: {
        despesaTotal: despesaRede,
        lojas: lojasRede,
        criterioRateio: 'faturamento',
      },
      config: {
        markupFallback: MARKUP_FALLBACK,
        lojasSemGrupo: stores.filter((s) => !s.dreGrupo).map((s) => s.code),
        especiesSemGrupo: especies.filter((e) => !e.dreGrupo).length,
        contasSemEspecie: {
          valor: semEspecie.valor,
          lojas: [...semEspecie.lojas],
        },
      },
      fonte: 'Flow (PdvSale · PdvReturn · ContaPagar · LivePdvCart · Order)',
    };
  }

  /** Consolidado da rede — soma as colunas e recalcula os percentuais. */
  private consolida(lista: DreColuna[], despesaRede: number) {
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
    // O rateio já está distribuído nas colunas; o total não pode somar de novo.
    void despesaRede;
    return t;
  }

  /**
   * Faturamento das colunas de CANAL.
   *
   * LIVE = carrinho pago (subtotal, sem frete — frete não é venda de
   * mercadoria). SITE = Order do WooCommerce, excluindo `source='live'` pra
   * não contar a mesma venda duas vezes.
   *
   * Quando existe UMA só loja-canal cadastrada, LIVE e SITE caem juntos nela.
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
      const alvo = s ? colunas.get(s.code) : null;
      return alvo || colunas.get(canais[0].code) || null;
    };

    const colLive = acha(/\bLIVE\b/);
    const colSite = acha(/\bSITE\b|E-?COMMERCE/);

    // ── LIVE ──
    if (colLive) {
      const [venda]: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS cupons, SUM(subtotal_cents)::bigint AS total
           FROM live_pdv_carts
          WHERE paid_at >= $1 AND paid_at <= $2
            AND status = ANY($3::text[])`,
        startDate, endDate, LIVE_VENDIDO,
      );
      colLive.faturamentoBruto += Number(venda?.total || 0) / 100;
      colLive.cupons += Number(venda?.cupons || 0);

      // CMV a PREÇO DE CUSTO do produto (decisão do dono): a loja de origem
      // não fatura a peça, o canal assume o custo real dela. `custo_cents` do
      // item (preço÷2,5, valor de transferência) só entra se o produto não
      // estiver no espelho.
      const [cmv]: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT SUM(i.qty)::int AS pecas,
                SUM(COALESCE(wp.custo, i.custo_cents / 100.0, 0) * i.qty)::float AS cmv
           FROM live_pdv_items i
           JOIN live_pdv_carts c ON c.id = i.cart_id
           LEFT JOIN wincred_produtos wp ON wp.codigo = ltrim(i.codigo_bipado, '0')
          WHERE c.paid_at >= $1 AND c.paid_at <= $2
            AND c.status = ANY($3::text[])
            AND i.status <> 'cancelled'`,
        startDate, endDate, LIVE_VENDIDO,
      );
      colLive.cmv += Number(cmv?.cmv || 0);
      colLive.pecas += Number(cmv?.pecas || 0);
    }

    // ── SITE ──
    if (colSite && colSite.key !== colLive?.key) {
      const [venda]: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS cupons, SUM(total_amount)::float AS total
           FROM orders
          WHERE created_at >= $1 AND created_at <= $2
            AND status = 'completed'
            AND source <> 'live'`,
        startDate, endDate,
      );
      colSite.faturamentoBruto += Number(venda?.total || 0);
      colSite.cupons += Number(venda?.cupons || 0);

      const [cmv]: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT SUM(oi.quantity)::int AS pecas,
                SUM(COALESCE(wp.custo, oi.unit_price / ${MARKUP_FALLBACK}, 0) * oi.quantity)::float AS cmv
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN wincred_produtos wp ON wp.codigo = ltrim(oi.sku, '0')
          WHERE o.created_at >= $1 AND o.created_at <= $2
            AND o.status = 'completed'
            AND o.source <> 'live'`,
        startDate, endDate,
      );
      colSite.cmv += Number(cmv?.cmv || 0);
      colSite.pecas += Number(cmv?.pecas || 0);
    } else if (colSite && colLive && colSite.key === colLive.key) {
      // Uma coluna só pros dois canais: soma o site nela também.
      const [venda]: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS cupons, SUM(total_amount)::float AS total
           FROM orders
          WHERE created_at >= $1 AND created_at <= $2
            AND status = 'completed' AND source <> 'live'`,
        startDate, endDate,
      );
      colSite.faturamentoBruto += Number(venda?.total || 0);
      colSite.cupons += Number(venda?.cupons || 0);
      colSite.avisos.push('LIVE e SITE estão na MESMA coluna — cadastre uma loja-canal pra cada um pra separar');
    }
  }

  /** Faturamento por dia e por loja — base do "a loja virou o mês no dia X". */
  private async serieDiaria(startDate: Date, endDate: Date, indice: Map<string, string>) {
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode",
              to_char(finalized_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
              SUM(total)::float AS total
         FROM pdv_sales
        WHERE finalized_at >= $1 AND finalized_at <= $2
          AND status = 'finalized' AND is_training = false
          AND (payment_method IS NULL OR payment_method <> 'MARCADO')
        GROUP BY 1, 2
        ORDER BY 2`,
      startDate, endDate,
    );
    const out = new Map<string, Array<{ dia: string; total: number }>>();
    for (const r of rows) {
      const raw = String(r.storeCode || '').trim().toUpperCase();
      const key = indice.get(raw);
      if (!key || key.startsWith('__REDE__')) continue;
      const arr = out.get(key) || [];
      arr.push({ dia: r.dia, total: Number(r.total || 0) });
      out.set(key, arr);
    }
    return out;
  }

  /** Primeiro dia em que o acumulado passou o ponto de equilíbrio. */
  private diaDoEquilibrio(serie: Array<{ dia: string; total: number }>, pe: number): string | null {
    let acc = 0;
    for (const p of serie) {
      acc += p.total;
      if (acc >= pe) return p.dia;
    }
    return null;
  }

  /**
   * Alíquota vigente por CNPJ no mês de referência. Mês sem linha própria
   * herda a mais recente ANTERIOR do mesmo CNPJ (a faixa do Simples só muda
   * quando o RBT12 vira).
   */
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

  /**
   * Detalhe de uma linha da DRE. É o que separa painel confiável de painel
   * bonito: todo número da tela abre na origem.
   */
  async drill(input: { de: string; ate: string; coluna: string; linha: string }) {
    const { de, ate } = this.validaPeriodo(input.de, input.ate);
    const { startDate, endDate } = this.brtRange(de, ate);
    const linha = String(input.linha || '').toUpperCase();

    const store: any = await (this.prisma as any).store.findUnique({
      where: { code: input.coluna },
    });
    const codes = [input.coluna, store?.name].filter(Boolean);

    if (linha === 'FATURAMENTO') {
      const vendas: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT to_char(finalized_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
                COUNT(*)::int AS cupons,
                SUM(total)::float AS total
           FROM pdv_sales
          WHERE finalized_at >= $1 AND finalized_at <= $2
            AND status = 'finalized' AND is_training = false
            AND (payment_method IS NULL OR payment_method <> 'MARCADO')
            AND store_code = ANY($3::text[])
          GROUP BY 1 ORDER BY 1`,
        startDate, endDate, codes,
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
        (c) => (c.especieId && idsDoGrupo.has(c.especieId)) || (!c.especieId && linha !== 'VARIAVEL' && linha !== 'FINANCEIRA'),
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
      lojas: stores.map((s: any) => ({
        code: s.code,
        name: s.name,
        active: s.active,
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
        id: a.id,
        cnpj: a.cnpj,
        mes: a.mes,
        aliquotaPct: Number(a.aliquotaPct),
        observacao: a.observacao,
      })),
      grupos: {
        loja: ['LOJA', 'CANAL', 'REDE', 'FORA'],
        especie: ['VARIAVEL', 'FIXA', 'FINANCEIRA', 'CMV', 'IMPOSTO', 'IGNORAR'],
      },
    };
  }

  async setGrupoLoja(code: string, grupo: string) {
    const g = String(grupo || '').toUpperCase();
    if (!['LOJA', 'CANAL', 'REDE', 'FORA'].includes(g)) {
      throw new BadRequestException('Grupo inválido (LOJA | CANAL | REDE | FORA)');
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

  async upsertAliquota(input: { cnpj: string; mes: string; aliquotaPct: number; observacao?: string }, usuario?: string) {
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
