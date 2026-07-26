import { BadRequestException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { FaturamentoService } from '../faturamento/faturamento.service';

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
 * CMV = VENDA ÷ MARKUP (decisão do dono 26/07).
 *
 * NÃO usa o campo CUSTO do cadastro do Giga de propósito — ele está
 * desatualizado/zerado em parte da base, o que distorcia a margem sem aviso.
 * Markup é premissa gerencial explícita: todo mundo enxerga a regra.
 *
 * 2,7 é o padrão da rede; a loja que compra diferente sobrepõe em
 * `Store.dreMarkup` (ITANHAÉM = 2,35). Ou seja: a margem bruta agora PODE
 * variar entre colunas — mas só quando o dono disse que varia, nunca por
 * cadastro de custo furado.
 */
const MARKUP_PADRAO = 2.7;

/** Alíquota efetiva padrão — decisão do dono 26/07 ("considere 10%"). */
const ALIQUOTA_PADRAO = 10;

/** Royalties da franquia — é o que o dono ganha sobre a venda dela. */
const ROYALTIES_PCT = 8;

/** Fundo de marketing da franquia: repasse de custo, NÃO lucro. */
const MARKETING_PCT = 4;

/** Status de venda da LIVE que contam como vendido (mesma lista do faturamento). */
const LIVE_VENDIDO = ['paid', 'separating', 'shipped', 'delivered'];

/**
 * Rubricas de despesa da "PLANILHA IDEAL" (modelo SEBRAE/SP), na ordem dela.
 * Serve pra tela responder "o que a planilha tem e a DRE não tem" — cada
 * rubrica é procurada nas espécies do Contas a Pagar por palavra-chave.
 */
const RUBRICAS_PLANILHA: Array<{ rubrica: string; termos: string[]; grupo: 'FIXA' | 'VARIAVEL' | 'FINANCEIRA' }> = [
  { rubrica: 'Aluguel', termos: ['ALUGUE', 'LOCACAO'], grupo: 'FIXA' }, // 'ALUGUE' casa ALUGUEL e ALUGUEIS (nome real da especie)
  { rubrica: 'Salários', termos: ['SALARIO', 'FOLHA', 'ORDENADO'], grupo: 'FIXA' },
  { rubrica: 'Encargos', termos: ['ENCARGO', 'FGTS', 'INSS', 'RESCISAO', 'FERIAS', 'DECIMO', '13 SALARIO'], grupo: 'FIXA' },
  { rubrica: 'Vale transporte/alimentação', termos: ['VALE TRANSP', 'VALE ALIM', 'VALE REFEI', 'BENEFICIO', 'CESTA'], grupo: 'FIXA' },
  { rubrica: 'Uniformes', termos: ['UNIFORME'], grupo: 'FIXA' },
  { rubrica: 'Água', termos: ['AGUA', 'SABESP'], grupo: 'FIXA' },
  { rubrica: 'Telefone', termos: ['TELEFON', 'FONE', 'CELULAR', 'VIVO', 'CLARO'], grupo: 'FIXA' },
  { rubrica: 'Internet', termos: ['INTERNET', 'LINK', 'BANDA'], grupo: 'FIXA' },
  { rubrica: 'Luz', termos: ['LUZ', 'ENERGIA', 'ELETRIC', 'ENEL', 'CPFL'], grupo: 'FIXA' },
  { rubrica: 'Material de escritório', termos: ['MATERIAL', 'ESCRITORIO', 'PAPELARIA'], grupo: 'FIXA' },
  { rubrica: 'Despesas com veículos', termos: ['VEICULO', 'COMBUSTIVEL', 'FROTA', 'PEDAGIO'], grupo: 'FIXA' },
  { rubrica: 'Contador', termos: ['CONTADOR', 'CONTABIL', 'HONORARIO'], grupo: 'FIXA' },
  { rubrica: 'Manutenção', termos: ['MANUTENCAO', 'REPARO', 'CONSERTO'], grupo: 'FIXA' },
  { rubrica: 'Equipe MKT', termos: ['MKT', 'MARKETING', 'AGENCIA', 'SOCIAL'], grupo: 'FIXA' },
  { rubrica: 'Royalties', termos: ['ROYALT'], grupo: 'FIXA' },
  { rubrica: 'Publicidade', termos: ['PUBLICID', 'ANUNCIO', 'TRAFEGO', 'META ADS', 'GOOGLE'], grupo: 'FIXA' },
  { rubrica: 'Pró-labore', termos: ['PRO-LABORE', 'PRO LABORE', 'PROLABORE', 'RETIRADA'], grupo: 'FIXA' },
  { rubrica: 'Taxas de banco', termos: ['TAXA', 'BANCO', 'TARIFA'], grupo: 'VARIAVEL' },
  { rubrica: 'Segurança e monitoramento', termos: ['SEGURANCA', 'MONITORA', 'VIGIL', 'ALARME'], grupo: 'FIXA' },
  { rubrica: 'Seguros', termos: ['SEGURO'], grupo: 'FIXA' },
  { rubrica: 'Comissão', termos: ['COMISS'], grupo: 'VARIAVEL' },
  { rubrica: 'Despesas financeiras', termos: ['JURO', 'MULTA', 'IOF'], grupo: 'FINANCEIRA' },
];

type DreGrupoLoja = 'LOJA' | 'CANAL' | 'FRANQUIA' | 'REDE' | 'FORA';
type DreGrupoEspecie = 'VARIAVEL' | 'FIXA' | 'FINANCEIRA' | 'CMV' | 'IMPOSTO' | 'IGNORAR';

export interface DreColuna {
  key: string;
  label: string;
  grupo: 'LOJA' | 'CANAL';
  cnpj: string | null;
  /** Markup usado no CMV desta coluna (padrão da rede ou override da loja). */
  markup: number;

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
export class DreService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly faturamento: FaturamentoService,
  ) {}

  /**
   * Semeia os ajustes que o dono pediu em 26/07 — uma vez só.
   *
   * A trava é uma chave em AppConfig, NÃO "tabela vazia": se ele apagar os
   * dois ajustes depois, é porque não quer mais, e o boot seguinte não pode
   * ressuscitá-los.
   */
  async onApplicationBootstrap() {
    // Cada bloco tem CHAVE PRÓPRIA. Uma trava única já falhou: o seed rodou
    // no primeiro deploy (VERISURE + segurança) e, quando as taxas e o
    // marketing entraram depois, a chave existente fez o boot inteiro sair
    // pelo `return` — a grade de taxas nunca foi criada e a tela ficou sem
    // onde digitar. Seed novo = chave nova, sempre.
    const blocos: Array<{ chave: string; rotulo: string; run: () => Promise<void> }> = [
      {
        chave: 'dre_ajustes_seed_2607',
        rotulo: 'VERISURE fora + segurança R$ 200/loja (exceto SANTOS)',
        run: async () => {
          await (this.prisma as any).dreAjuste.createMany({
            data: [
              {
                tipo: 'EXCLUIR_FORNECEDOR',
                descricao: 'VERISURE (contrato encerrado)',
                fornecedorMatch: 'VERISURE',
                criadoPor: 'seed 26/07',
              },
              {
                tipo: 'DESPESA_FIXA',
                descricao: 'Segurança e monitoramento',
                valorMensalCents: 20000, // R$ 200,00 por loja/mês
                grupo: 'FIXA',
                lojasExcluidas: 'SANTOS', // Santos não paga
                criadoPor: 'seed 26/07',
              },
            ],
            skipDuplicates: true,
          });
        },
      },
      {
        chave: 'dre_marketing_pct_2607',
        rotulo: 'Marketing 5% do faturamento (despesa variável)',
        run: async () => {
          // A verba acompanha a venda de cada loja — não é valor fixo.
          await (this.prisma as any).dreAjuste.createMany({
            data: [{
              tipo: 'DESPESA_PCT',
              descricao: 'Marketing',
              percentual: 5,
              grupo: 'VARIAVEL',
              criadoPor: 'seed 26/07',
            }],
            skipDuplicates: true,
          });
        },
      },
      {
        chave: 'dre_marketing_site_20pct_2607',
        rotulo: 'Marketing do SITE 20% (loja física fica em 5%)',
        run: async () => {
          // O digital gasta MUITO mais mídia que a loja física (dono, 26/07).
          // Em vez de um percentual médio que mente nos dois lados, são dois
          // ajustes mirando alvos diferentes.
          await (this.prisma as any).dreAjuste.updateMany({
            where: { tipo: 'DESPESA_PCT', descricao: 'Marketing' },
            data: { lojasExcluidas: 'SITE' },
          });
          await (this.prisma as any).dreAjuste.create({
            data: {
              tipo: 'DESPESA_PCT',
              descricao: 'Marketing SITE',
              percentual: 20,
              grupo: 'VARIAVEL',
              lojasIncluidas: 'SITE',
              criadoPor: 'seed 26/07',
            },
          });
        },
      },
      {
        chave: 'dre_especies_limpeza_2607',
        rotulo: 'espécies de despesa criadas + formas de pagamento inativadas',
        run: async () => {
          // 1) CRIA o que faltava. Sem isso, inativar OUTROS/BOLETO deixaria o
          // dono sem onde lançar contador, marketing, tecnologia — o catálogo
          // do Giga não tinha NENHUMA espécie de despesa real além de água,
          // energia, internet, aluguel e folha.
          const novas: Array<[string, DreGrupoEspecie]> = [
            ['CONTADOR', 'FIXA'],
            ['MARKETING', 'VARIAVEL'],
            ['PUBLICIDADE', 'VARIAVEL'],
            ['TECNOLOGIA', 'FIXA'],
            ['MANUTENCAO', 'FIXA'],
            ['LIMPEZA', 'FIXA'],
            ['SEGURANCA', 'FIXA'],
            ['SEGUROS', 'FIXA'],
            ['MATERIAL ESCRITORIO', 'FIXA'],
            ['TELEFONE', 'FIXA'],
            ['CONDOMINIO', 'FIXA'],
            ['IPTU', 'FIXA'],
            ['ENCARGOS', 'FIXA'],
            ['PRO-LABORE', 'FIXA'],
            ['VEICULOS', 'FIXA'],
            ['FRETE', 'VARIAVEL'],
            ['TAXA BANCARIA', 'VARIAVEL'],
            ['JURIDICO', 'FIXA'],
            ['TARIFAS E JUROS', 'FINANCEIRA'],
          ];
          for (const [nome, dreGrupo] of novas) {
            await (this.prisma as any).especieConta.upsert({
              where: { nome },
              create: { nome, dreGrupo },
              update: { ativa: true },
            });
          }

          // 2) INATIVA as formas de pagamento herdadas do Giga (pedido do dono
          // 26/07). NÃO apaga: as contas históricas continuam apontando pra
          // elas. Só somem do lançamento novo e da tela de classificação.
          const aposentar = [
            'CARNE', 'DEPOSITO', 'PROMISSORIA', 'SEM ESPECIE',
            'CHEQUE', 'DUPLICATA', 'BOLETO', 'OUTROS',
          ];
          await (this.prisma as any).especieConta.updateMany({
            where: { nome: { in: aposentar } },
            data: { ativa: false },
          });
        },
      },
      {
        chave: 'dre_taxas_cartao_2607',
        rotulo: 'grade de taxas de cartão/PIX (percentual zerado)',
        run: async () => {
          // Percentual entra ZERADO de propósito: taxa chutada vira despesa
          // inventada. A tela também monta linha a partir das bandeiras que
          // apareceram nas vendas, então não depende só desta grade.
          const grade = [
            { forma: 'PIX', bandeira: 'PIX', faixaParcela: 'UNICA' },
            ...['VISA ELECTRON', 'REDESHOP', 'ELO'].map((b) => ({
              forma: 'DEBITO', bandeira: b, faixaParcela: 'UNICA',
            })),
            ...['VISA', 'MASTERCARD', 'HIPERCARD', 'AMEX', 'CIELO'].flatMap((b) =>
              ['1', '2-6', '7-12'].map((f) => ({ forma: 'CREDITO', bandeira: b, faixaParcela: f })),
            ),
          ].map((t) => ({ ...t, taxaPct: 0, criadoPor: 'seed 26/07' }));
          await (this.prisma as any).taxaCartao.createMany({ data: grade, skipDuplicates: true });
        },
      },
      {
        chave: 'dre_markup_itanhaem_2607',
        rotulo: 'markup de ITANHAEM em 2,35 (rede fica em 2,7)',
        run: async () => {
          // Nem toda loja compra igual (dono, 26/07). Casa por nome porque o
          // código da loja varia entre ambientes.
          await (this.prisma as any).store.updateMany({
            where: { name: { contains: 'ITANHA', mode: 'insensitive' } },
            data: { dreMarkup: 2.35 },
          });
        },
      },
      {
        chave: 'dre_especies_rh_2607',
        rotulo: 'espécies de encargo e benefício de RH',
        run: async () => {
          // O catálogo tinha RH/SALARIO/COMISSAO/VALE e mais nada — encargo e
          // benefício não tinham onde ser lançados, e "VALE" sozinho é
          // ambíguo (adiantamento ≠ vale-transporte).
          const novas: Array<[string, DreGrupoEspecie]> = [
            ['FGTS', 'FIXA'],
            ['INSS', 'FIXA'],
            ['VALE TRANSPORTE', 'FIXA'],
            ['VALE ALIMENTACAO', 'FIXA'],
            ['FERIAS', 'FIXA'],
            ['13 SALARIO', 'FIXA'],
            ['RESCISAO', 'FIXA'],
            ['UNIFORMES', 'FIXA'],
          ];
          for (const [nome, dreGrupo] of novas) {
            await (this.prisma as any).especieConta.upsert({
              where: { nome },
              create: { nome, dreGrupo, restrita: true },
              update: { ativa: true, dreGrupo },
            });
          }
        },
      },
      {
        chave: 'dre_marketing_por_canal_2607',
        rotulo: 'Meta/Google Ads separados por loja e SITE',
        run: async () => {
          // O dono quer enxergar mídia por PLATAFORMA e por DESTINO — Meta e
          // Google gastam diferente, e o SITE consome muito mais que a loja.
          // Um "Marketing 5%" único escondia as quatro realidades.
          // Estes % são SIMULAÇÃO: no fim do mês ele lança o gasto real e o
          // valor lançado passa a mandar (DreAjusteRealizado).
          await (this.prisma as any).dreAjuste.deleteMany({
            where: { tipo: 'DESPESA_PCT', descricao: { in: ['Marketing', 'Marketing SITE'] } },
          });
          await (this.prisma as any).dreAjuste.createMany({
            data: [
              { descricao: 'META ADS LOJAS', percentual: 3, lojasExcluidas: 'SITE' },
              { descricao: 'META ADS SITE', percentual: 20, lojasIncluidas: 'SITE' },
              { descricao: 'GOOGLE ADS LOJAS', percentual: 3, lojasExcluidas: 'SITE' },
              { descricao: 'GOOGLE ADS SITE', percentual: 10, lojasIncluidas: 'SITE' },
            ].map((a) => ({
              ...a, tipo: 'DESPESA_PCT', grupo: 'VARIAVEL', criadoPor: 'seed 26/07',
            })),
            skipDuplicates: true,
          });
        },
      },
    ];

    for (const b of blocos) {
      try {
        const feito = await (this.prisma as any).appConfig.findUnique({ where: { key: b.chave } });
        if (feito) continue;
        await b.run();
        await (this.prisma as any).appConfig.create({
          data: { key: b.chave, valueJson: JSON.stringify({ seededAt: new Date().toISOString() }) },
        });
        this.logger.log(`[dre] seed aplicado: ${b.rotulo}`);
      } catch (e: any) {
        // Nunca deixa o seed derrubar o boot — e um bloco quebrado não
        // impede os outros.
        this.logger.warn(`[dre] seed "${b.chave}" pulado: ${e?.message || e}`);
      }
    }
  }

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
    // ── FORMA DE PAGAMENTO ≠ NATUREZA DE DESPESA ──────────────────────────
    // 6 das 17 espécies herdadas do Giga são forma de pagamento: DEPOSITO,
    // BOLETO, CHEQUE, PROMISSORIA, CARNE, DUPLICATA. O dono confirmou em
    // 26/07 que TODAS são pagamento de MERCADORIA.
    //
    // Antes disso, só DUPLICATA era reconhecida — as outras 5 caíam no default
    // FIXA, ou seja: compra de mercadoria virava custo fixo da loja. Era o que
    // inflava a despesa fixa e comia o resultado (ITANHAÉM aparecia com R$ 2MM
    // de fixa contra ~R$ 300k das outras).
    //
    // Marcadas como CMV = ficam FORA da DRE, porque o custo da mercadoria já
    // entra por VENDA ÷ 2,65 ("nada entra como pagamento de mercadoria por
    // enquanto" — dono). O valor não some: aparece no bloco "o que ficou de
    // fora" com o motivo.
    if (/MERCADORIA|COMPRA|FORNECEDOR|DUPLICATA|DEPOSITO|BOLETO|CHEQUE|PROMISSORIA|CARNE/.test(n)) {
      return 'CMV';
    }
    if (/IMPOSTO|DAS\b|SIMPLES|ICMS|PIS|COFINS|IRPJ|CSLL|TRIBUT/.test(n)) return 'IMPOSTO';
    if (/JURO|MULTA|IOF|EMPRESTIMO|EMPRÉSTIMO|FINANCIAMENTO/.test(n)) return 'FINANCEIRA';
    if (/COMISS|TAXA|CARTAO|CARTÃO|FRETE|ROYALT|MARKETING|PUBLICID/.test(n)) return 'VARIAVEL';

    // BENEFÍCIO É DESPESA — e tem que ser testado ANTES da regra do vale.
    // "VALE TRANSPORTE" casava com /VALE\b/ e caía em IGNORAR, ou seja: VT e
    // VA sumiam da DRE sem ninguém perceber. Só o VALE de ADIANTAMENTO de
    // salário é que fica de fora (é antecipação, não custo do período).
    if (/VALE.?(TRANSP|ALIM|REFEI|COMBUST)|^VT$|^VA$|^VR$|BENEFICIO|CESTA/.test(n)) return 'FIXA';
    if (/ENCARGO|FGTS|INSS|RESCISAO|FERIAS|DECIMO|13|SINDICA/.test(n)) return 'FIXA';

    if (/TRANSFER|ADIANT|VALE\b|APORTE/.test(n)) return 'IGNORAR';
    return 'FIXA';
  }

  private colunaVazia(key: string, label: string, grupo: 'LOJA' | 'CANAL', cnpj: string | null, markup = MARKUP_PADRAO): DreColuna {
    return {
      key, label, grupo, cnpj, markup,
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

      // Markup da loja (ex: ITANHAÉM 2,35) ou o padrão da rede.
      const mk = s.dreMarkup != null ? Number(s.dreMarkup) : MARKUP_PADRAO;
      const col = this.colunaVazia(
        s.code, s.name || s.code, grupo,
        this.soDigitos(s.expectedCnpj) || null,
        Number.isFinite(mk) && mk > 0 ? mk : MARKUP_PADRAO,
      );
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
    await this.aplicaCanais(colunas, canais, inicio, fimExclusive);

    // ── 5) Despesas (ContaPagar por VENCIMENTO) ──
    const especies: any[] = await (this.prisma as any).especieConta.findMany();
    const grupoPorEspecie = new Map<string, DreGrupoEspecie>();
    for (const e of especies) grupoPorEspecie.set(e.id, this.grupoDaEspecie(e));

    const nomeEspecie = new Map<string, string>();
    for (const e of especies) nomeEspecie.set(e.id, e.nome);

    const contas: any[] = await this.prisma.$queryRawUnsafe(
      // JUROS entra junto (26/07): a baixa grava juros_cents separado do
      // principal e a DRE ignorava — juro pago por atraso era despesa
      // invisível no resultado. Vem numa coluna própria porque ele NÃO é da
      // natureza da conta: aluguel pago com atraso não gera "mais aluguel",
      // gera DESPESA FINANCEIRA.
      `SELECT loja_code AS "lojaCode", especie_id AS "especieId",
              COALESCE(fornecedor_nome, seller_nome, '') AS "beneficiario",
              SUM(valor_cents)::bigint AS "valorCents",
              SUM(juros_cents)::bigint AS "jurosCents"
         FROM conta_pagar
        WHERE vencimento >= $1::date AND vencimento <= $2::date
          AND status <> 'cancelada' AND deleted_at IS NULL
        GROUP BY loja_code, especie_id, COALESCE(fornecedor_nome, seller_nome, '')`,
      de, ate,
    );

    // Ajustes gerenciais (não mexem no Contas a Pagar — ver model DreAjuste).
    const ajustesGerenciais: any[] = await (this.prisma as any).dreAjuste.findMany({
      where: { ativo: true },
    });
    const exclusoes = ajustesGerenciais
      .filter((a) => a.tipo === 'EXCLUIR_FORNECEDOR' && a.fornecedorMatch)
      .map((a) => ({ termo: this.semAcento(a.fornecedorMatch), descricao: a.descricao }));
    const excluidoPorAjuste = new Map<string, number>();

    let despesaRede = 0;
    let despesaFranquia = 0;
    const semEspecie = { valor: 0, lojas: new Set<string>() };
    // Despesa que a DRE viu e NÃO usou — o dono precisa saber o que foi
    // descartado e por quê, senão "faltou aluguel" vira mistério.
    const descartadas = new Map<string, { grupo: DreGrupoEspecie; valor: number }>();
    let despesaSemColuna = 0;

    for (const c of contas) {
      const valor = Number(c.valorCents || 0) / 100;
      const juros = Number(c.jurosCents || 0) / 100;
      if (!valor && !juros) continue;
      // Fornecedor excluído por ajuste (ex: VERISURE, contrato encerrado):
      // sai da DRE mas NÃO some — vai pro bloco "o que ficou de fora".
      const benef = this.semAcento(c.beneficiario);
      const excluido = benef && exclusoes.find((e) => benef.includes(e.termo));
      if (excluido) {
        excluidoPorAjuste.set(
          excluido.descricao,
          (excluidoPorAjuste.get(excluido.descricao) || 0) + valor,
        );
        continue;
      }

      const g: DreGrupoEspecie = (c.especieId ? grupoPorEspecie.get(c.especieId) : undefined) || 'FIXA';
      const nome = (c.especieId ? nomeEspecie.get(c.especieId) : null) || '(sem espécie)';
      if (!c.especieId) {
        semEspecie.valor += valor;
        semEspecie.lojas.add(String(c.lojaCode));
      }

      const alvo = indice.get(String(c.lojaCode || '').trim().toUpperCase());
      const key = alvo && !alvo.startsWith('__') ? alvo : null;
      const col = key ? colunas.get(key) : null;

      // JUROS entra SEMPRE que a loja é coluna — inclusive de conta cujo
      // principal é descartado. Juro de boleto de mercadoria não é mercadoria:
      // é multa por atraso, despesa financeira de verdade.
      if (juros > 0 && col) this.somaDespesa(col, 'Juros por atraso', 'FINANCEIRA', juros);

      if (!valor) continue;
      if (g === 'CMV' || g === 'IMPOSTO' || g === 'IGNORAR') {
        const d = descartadas.get(nome) || { grupo: g, valor: 0 };
        d.valor += valor;
        descartadas.set(nome, d);
        continue;
      }

      if (alvo?.startsWith('__REDE__')) { despesaRede += valor; continue; }
      // Despesa lançada numa FRANQUIA é dela, não do dono — fica de fora.
      if (alvo?.startsWith('__FRANQUIA__')) { despesaFranquia += valor; continue; }
      if (!col) { despesaSemColuna += valor; continue; }

      this.somaDespesa(col, nome, g, valor);
    }

    // ── 5a) TAXA DE CARTÃO — despesa variável calculada, não lançada ─────
    const taxas = await this.taxaCartaoPorLoja(startDate, endDate, indice);
    for (const [key, t] of taxas.porLoja) {
      const col = colunas.get(key);
      if (!col) continue;
      this.somaDespesa(col, 'Taxa de cartão/PIX', 'VARIAVEL', t.taxa);
      if (t.semTaxaCadastrada > 0) {
        col.avisos.push(
          `${this.brl(t.semTaxaCadastrada)} pagos em bandeira/parcela SEM taxa cadastrada ` +
          `(${[...t.faltando].join(', ')}) — essa parte entrou com taxa zero.`,
        );
      }
    }

    // ── 5b) Despesa fixa GERENCIAL (o dono sabe que existe, não está lançada)
    // Valor é MENSAL por loja e entra proporcional aos dias do período — sem
    // isso, filtrar "7 dias" cobraria o mês inteiro de segurança.
    const diasPeriodo = Math.max(
      1,
      Math.round((new Date(`${ate}T00:00:00Z`).getTime() - new Date(`${de}T00:00:00Z`).getTime()) / 86400000) + 1,
    );
    const diasNoMes = new Date(Number(mesRef.slice(0, 4)), Number(mesRef.slice(5, 7)), 0).getDate();
    const proporcao = Math.min(1, diasPeriodo / diasNoMes);

    // Despesa em % do faturamento (ex: marketing 5%) — acompanha a venda, não
    // precisa de proporção por dias nem de rateio: vendeu mais, gastou mais.
    const pctGerenciais = ajustesGerenciais.filter((a) => a.tipo === 'DESPESA_PCT' && a.percentual);

    // REALIZADO SOBREPÕE O SIMULADO: enquanto a fatura da mídia não fecha, a
    // DRE usa o coeficiente; no dia em que o dono lança o gasto real daquele
    // mês, o valor lançado manda e o percentual vira só referência.
    const realizados: any[] = pctGerenciais.length
      ? await (this.prisma as any).dreAjusteRealizado.findMany({
          where: { mes: mesRef, ajusteId: { in: pctGerenciais.map((a: any) => a.id) } },
        })
      : [];
    const realizadoPorAjuste = new Map<string, number>();
    for (const r of realizados) realizadoPorAjuste.set(r.ajusteId, Number(r.valorCents) / 100);

    const simulacao: any[] = [];
    for (const aj of pctGerenciais) {
      const grupo = (String(aj.grupo || 'VARIAVEL').toUpperCase() as DreGrupoEspecie);
      const alvos = [...colunas.values()].filter(
        (c) => c.faturamentoBruto > 0 && this.ajusteValePra(aj, c),
      );
      const baseAlvo = alvos.reduce((s, c) => s + c.faturamentoBruto, 0);
      if (!baseAlvo) continue;

      const real = realizadoPorAjuste.get(aj.id);
      // Valor lançado é do MÊS: num filtro parcial entra proporcional aos dias,
      // igual à despesa fixa — senão "últimos 7 dias" cobraria a mídia inteira.
      const totalAplicado = real != null
        ? real * proporcao
        : baseAlvo * (Number(aj.percentual) / 100);

      for (const col of alvos) {
        // Rateio pelo faturamento: mesma régua do percentual, então trocar
        // simulado por realizado não muda a distribuição entre as lojas.
        this.somaDespesa(col, aj.descricao, grupo, totalAplicado * (col.faturamentoBruto / baseAlvo));
      }

      simulacao.push({
        id: aj.id,
        descricao: aj.descricao,
        percentual: Number(aj.percentual),
        alvo: alvos.map((c) => c.label),
        baseFaturamento: baseAlvo,
        simulado: baseAlvo * (Number(aj.percentual) / 100),
        realizado: real ?? null,
        aplicado: totalAplicado,
        fonte: real != null ? 'realizado' : 'simulado',
      });
    }

    const fixasGerenciais = ajustesGerenciais.filter((a) => a.tipo === 'DESPESA_FIXA' && a.valorMensalCents);
    for (const aj of fixasGerenciais) {
      const valor = (Number(aj.valorMensalCents) / 100) * proporcao;
      const grupo = (String(aj.grupo || 'FIXA').toUpperCase() as DreGrupoEspecie);
      const temWhitelist = !!String(aj.lojasIncluidas || '').trim();
      for (const col of colunas.values()) {
        // Só loja física paga — canal digital não tem ponto pra vigiar. Mas se
        // o ajuste mira lojas específicas, a escolha é do dono e vale.
        if (!temWhitelist && col.grupo !== 'LOJA') continue;
        if (!this.ajusteValePra(aj, col)) continue;
        this.somaDespesa(col, aj.descricao, grupo, valor);
      }
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
      // TROCA/VALE NÃO ABATE (decisão do dono, 26/07 — repetida). Só sai da
      // receita a devolução em DINHEIRO/PIX, onde a cliente levou o dinheiro
      // embora. Troca fica visível na tela como informação, fora da conta.
      col.receitaLiquida = col.faturamentoBruto - col.devolucoesDinheiro;
      // CMV = venda ÷ 2,65 sobre a receita LÍQUIDA — peça devolvida não
      // vendeu, então o custo dela já sai junto. Regra ÚNICA: vale pra loja
      // física e pra canal digital (LIVE/SITE) igual.
      col.cmv = col.receitaLiquida / col.markup;
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
      // ── SANIDADE DA CONTAGEM DE CUPOM (3 checagens) ────────────────────
      // A causa raiz já foi corrigida (o NUMERO é FLOAT e achatava na
      // conversão pra texto — ver getCaixaMovRaw), mas as checagens ficam:
      // é dado que vem de fora e pode voltar a quebrar sem avisar.
      const noFlow = cuponsFlow.get(col.key) || 0;
      if (noFlow > 0 && col.cupons > 0 && col.cupons < noFlow) {
        col.avisos.push(
          `Contagem de cupom colapsada: ${col.cupons} no caixa contra ${noFlow} vendas no PDV — ` +
          'o caixa contém o PDV, então não pode ter menos. Ticket médio e peças/venda estão inflados.',
        );
      }
      if (col.cupons > 0 && col.pecas > 0) {
        const itensPorCupom = col.pecas / col.cupons;
        if (itensPorCupom > 8) {
          col.avisos.push(
            `${itensPorCupom.toFixed(1)} peças por venda — alto demais pra varejo de moda. ` +
            'Sinal de cupom colapsado (várias vendas contadas como uma).',
          );
        } else if (itensPorCupom < 1) {
          col.avisos.push(
            `${itensPorCupom.toFixed(2)} peça por venda — abaixo de 1 é impossível. ` +
            'Sinal de cupom inflado (a mesma venda contada várias vezes).',
          );
        }
      }
      if (col.ticketMedio > 0 && (col.ticketMedio < 80 || col.ticketMedio > 1200)) {
        col.avisos.push(
          `Ticket médio de ${this.brl(col.ticketMedio)} fora da faixa esperada de moda plus size ` +
          '(R$ 80 a R$ 1.200) — confira a contagem de cupom antes de usar esse número.',
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
      // Confronto com a PLANILHA IDEAL: rubrica por rubrica, o que tem
      // lançamento no período e o que está zerado. É a resposta permanente
      // pro "quais despesas a planilha tem que a DRE não tem".
      planilha: this.conferePlanilha(total),
      // Toda despesa do Contas a Pagar que a DRE viu e NÃO somou. Sem isso,
      // "cadê o aluguel?" não tem resposta na tela.
      despesaDescartada: {
        porEspecie: [...descartadas.entries()]
          .map(([especie, d]) => ({ especie, grupo: d.grupo, valor: d.valor }))
          .sort((a, b) => b.valor - a.valor),
        semColuna: despesaSemColuna,
        emFranquia: despesaFranquia,
        porAjuste: [...excluidoPorAjuste.entries()].map(([descricao, valor]) => ({ descricao, valor })),
        total: [...descartadas.values()].reduce((s, d) => s + d.valor, 0)
          + despesaSemColuna + despesaFranquia
          + [...excluidoPorAjuste.values()].reduce((s, v) => s + v, 0),
      },
      // Mídia: quanto está SIMULADO por coeficiente e quanto já foi LANÇADO.
      // A tela usa isso pro dono fechar o mês com o valor real da fatura.
      midia: {
        mes: mesRef,
        linhas: simulacao,
        totalAplicado: simulacao.reduce((s, m) => s + m.aplicado, 0),
        aindaSimulado: simulacao.filter((m) => m.fonte === 'simulado').length,
      },
      ajustes: ajustesGerenciais.map((a: any) => ({
        id: a.id, tipo: a.tipo, descricao: a.descricao,
        fornecedorMatch: a.fornecedorMatch,
        valorMensal: a.valorMensalCents != null ? a.valorMensalCents / 100 : null,
      percentual: a.percentual != null ? Number(a.percentual) : null,
        grupo: a.grupo, lojasExcluidas: a.lojasExcluidas, lojasIncluidas: a.lojasIncluidas,
      })),
      config: {
        markupPadrao: MARKUP_PADRAO,
        aliquotaPadrao: ALIQUOTA_PADRAO,
        lojasSemGrupo: stores.filter((s) => !s.dreGrupo).map((s) => s.code),
        especiesSemGrupo: especies.filter((e) => !e.dreGrupo).length,
        contasSemEspecie: { valor: semEspecie.valor, lojas: [...semEspecie.lojas] },
      },
      fonte: 'Caixa do Giga (espelho giga_caixa_mov) — MESMA fonte da tela Faturamento por Loja',
    };
  }

  /**
   * O ajuste vale pra esta coluna? `lojasIncluidas` (whitelist) tem
   * precedência: preenchido, aplica SÓ nelas. Senão, aplica em todas menos
   * as de `lojasExcluidas`. Casa por código OU por nome, sem acento.
   */
  private ajusteValePra(aj: any, col: DreColuna): boolean {
    const lista = (v: string) => new Set(
      String(v || '').split(',').map((s) => this.semAcento(s).trim()).filter(Boolean),
    );
    const alvo = [this.semAcento(col.key), this.semAcento(col.label)];

    const incluidas = lista(aj.lojasIncluidas);
    if (incluidas.size > 0) return alvo.some((a) => incluidas.has(a));

    const excluidas = lista(aj.lojasExcluidas);
    return !alvo.some((a) => excluidas.has(a));
  }

  /** Faixa de parcela usada na tabela de taxa. */
  private faixaDe(metodo: string, parcelas: number): string {
    if (metodo !== 'credito') return 'UNICA';
    if (parcelas <= 1) return '1';
    if (parcelas <= 6) return '2-6';
    return '7-12';
  }

  /**
   * Normaliza o nome da bandeira. O PDV grava o que a vendedora escolheu
   * ("VISA ELECTRON", "Mastercard", "REDE SHOP") e o cadastro de taxa precisa
   * casar com isso sem depender de digitação idêntica.
   */
  private normalizaBandeira(raw: string, metodo: string): string {
    const b = this.semAcento(raw).replace(/[_\-\s]+/g, ' ').trim();
    if (!b) return metodo === 'pix' ? 'PIX' : metodo === 'debito' ? 'DEBITO' : 'CREDITO';
    if (/^MASTER/.test(b)) return 'MASTERCARD';
    if (/^VISA ?ELECTRON/.test(b)) return 'VISA ELECTRON';
    if (/^VISA/.test(b)) return 'VISA';
    if (/^REDE ?SHOP/.test(b)) return 'REDESHOP';
    if (/^AMERICAN|^AMEX/.test(b)) return 'AMEX';
    if (/^HIPER/.test(b)) return 'HIPERCARD';
    if (/^ELO/.test(b)) return 'ELO';
    return b;
  }

  /**
   * Taxa de cartão/PIX por loja: cruza os pagamentos REAIS da venda (bandeira
   * + nº de parcelas, que o PDV grava em `PdvSalePayment.details`) com a
   * tabela de taxa cadastrada. Vira DESPESA VARIÁVEL sem ninguém lançar nada
   * no Contas a Pagar.
   *
   * Ressalva medida, não escondida: a fonte é o Flow e o faturamento da DRE
   * vem do caixa do Giga. Venda lançada direto no Giga não tem bandeira aqui
   * e fica sem taxa — a tela avisa em vez de fingir que está completo.
   */
  private async taxaCartaoPorLoja(
    startDate: Date,
    endDate: Date,
    indice: Map<string, string>,
  ) {
    const tabela: any[] = await (this.prisma as any).taxaCartao.findMany({ where: { ativo: true } });
    if (!tabela.length) return { porLoja: new Map(), cadastradas: 0 };

    const porChave = new Map<string, number>();
    for (const t of tabela) {
      porChave.set(`${this.semAcento(t.bandeira)}|${t.faixaParcela}`, Number(t.taxaPct));
    }

    const pagamentos: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT s.store_code AS "storeCode", p.method, p.details, SUM(p.valor)::float AS total
         FROM pdv_sale_payments p
         JOIN pdv_sales s ON s.id = p.sale_id
        WHERE s.finalized_at >= $1 AND s.finalized_at <= $2
          AND s.status = 'finalized' AND s.is_training = false
          AND (s.payment_method IS NULL OR s.payment_method <> 'MARCADO')
          AND lower(p.method) IN ('pix','debito','credito','cartao')
        GROUP BY s.store_code, p.method, p.details`,
      startDate, endDate,
    );

    const porLoja = new Map<string, {
      taxa: number; base: number; semTaxaCadastrada: number; faltando: Set<string>;
    }>();

    for (const row of pagamentos) {
      const hit = indice.get(String(row.storeCode || '').trim().toUpperCase());
      if (!hit || hit.startsWith('__')) continue;
      const valor = Number(row.total || 0);
      if (!valor) continue;

      const metodo = String(row.method || '').toLowerCase();
      let bandeiraRaw = '';
      let parcelas = 1;
      try {
        const det = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
        bandeiraRaw = String(det?.bandeira || '');
        parcelas = Number(det?.parcelas) || 1;
      } catch { /* details inválido → cai no genérico */ }

      const bandeira = this.normalizaBandeira(bandeiraRaw, metodo);
      const faixa = this.faixaDe(metodo, parcelas);
      const pct = porChave.get(`${bandeira}|${faixa}`);

      const acc = porLoja.get(hit)
        || { taxa: 0, base: 0, semTaxaCadastrada: 0, faltando: new Set<string>() };
      acc.base += valor;
      if (pct == null) {
        acc.semTaxaCadastrada += valor;
        acc.faltando.add(faixa === 'UNICA' ? bandeira : `${bandeira} ${faixa}x`);
      } else {
        acc.taxa += valor * (pct / 100);
      }
      porLoja.set(hit, acc);
    }

    return { porLoja, cadastradas: tabela.length };
  }

  /**
   * Confronta as rubricas da PLANILHA IDEAL com o que veio do Contas a Pagar
   * no período. Rubrica sem lançamento não significa erro do sistema — quer
   * dizer que a despesa não está lançada (ou está com outro nome de espécie).
   */
  private conferePlanilha(total: DreColuna) {
    const detalhe = total.despesasDetalhe || [];
    const itens = RUBRICAS_PLANILHA.map((r) => {
      const casadas = detalhe.filter((d) => {
        const nome = this.semAcento(d.especie);
        return r.termos.some((t) => nome.includes(t));
      });
      return {
        rubrica: r.rubrica,
        grupo: r.grupo,
        valor: casadas.reduce((s, d) => s + d.valor, 0),
        especies: casadas.map((d) => d.especie),
        presente: casadas.length > 0,
      };
    });
    // Espécie que gastou dinheiro e não casou com nenhuma rubrica da planilha.
    const cobertas = new Set(itens.flatMap((i) => i.especies));
    const foraDaPlanilha = detalhe
      .filter((d) => !cobertas.has(d.especie) && d.valor > 0)
      .map((d) => ({ especie: d.especie, valor: d.valor }));

    return {
      itens,
      faltando: itens.filter((i) => !i.presente).map((i) => i.rubrica),
      foraDaPlanilha,
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
    // Mesma regra das colunas: troca/vale não abate.
    t.receitaLiquida = t.faturamentoBruto - t.devolucoesDinheiro;
    t.margemBruta = t.receitaLiquida - t.cmv;
    // O CMV do total é a SOMA das colunas (cada uma com o seu markup), então
    // o markup da rede é o EFETIVO — mistura de 2,7 com o 2,35 de ITANHAÉM.
    t.markup = t.cmv > 0 ? t.receitaLiquida / t.cmv : MARKUP_PADRAO;
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
    inicio: Date,
    fimExclusive: Date,
  ) {
    if (!canais.length) return;

    const acha = (regex: RegExp): DreColuna | null => {
      const s = canais.find((c) => regex.test(`${c.name || ''} ${c.code || ''}`.toUpperCase()));
      return (s ? colunas.get(s.code) : null) || colunas.get(canais[0].code) || null;
    };
    const colLive = acha(/\bLIVE\b/);
    const colSite = acha(/\bSITE\b|E-?COMMERCE/);

    // Os MESMOS métodos que a tela /retaguarda/faturamento usa. Reimplementar
    // aqui já custou R$ 48k de divergência no SITE (26/07): a tela conta 8
    // status de pedido, pela data da COMPRA e sem frete; a cópia contava só
    // 'completed', pela data de chegada no Flow e com frete.
    const [live, site] = await Promise.all([
      colLive ? this.faturamento.getLiveFaturamento(inicio, fimExclusive) : null,
      colSite ? this.faturamento.getFlowopsSiteFaturamento(inicio, fimExclusive) : null,
    ]);

    if (colLive && live) {
      colLive.faturamentoBruto += live.faturamento;
      colLive.cupons += live.cupons;
      colLive.pecas += live.pecas;
    }
    if (colSite && site) {
      colSite.faturamentoBruto += site.faturamento;
      colSite.cupons += site.cupons;
      colSite.pecas += site.pecas;

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

  async drill(input: { de: string; ate: string; coluna: string; linha: string; especie?: string }) {
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
                COUNT(DISTINCT COALESCE(NULLIF(btrim(obs_pedido), ''), 'n:' || numero))::int AS cupons,
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
      // Filtro opcional por ESPÉCIE: é o segundo nível da cascata — clicou em
      // ALUGUEIS dentro de Despesas fixas, vê só as contas de aluguel.
      const especieAlvo = this.semAcento(input.especie || '');
      const filtradas = contas.filter((c) => {
        const doGrupo = (c.especieId && idsDoGrupo.has(c.especieId))
          || (!c.especieId && linha !== 'VARIAVEL' && linha !== 'FINANCEIRA');
        if (!doGrupo) return false;
        if (!especieAlvo) return true;
        return this.semAcento(c.especie?.nome || '(sem espécie)') === especieAlvo;
      });
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

  /**
   * DIAGNÓSTICO DA CONTAGEM DE CUPOM.
   *
   * O ticket médio saiu em R$ 2.722 numa loja de moda plus size e o alarme
   * acusou 50 cupons no caixa contra 347 vendas no PDV. Antes de trocar a
   * chave de novo no escuro (já errei uma vez supondo que o NUMERO
   * reiniciava — ele é MAX(NUMERO)+1 global), esta rota MEDE cada candidata
   * a chave de cupom contra a verdade conhecida: o nº de vendas do PdvSale.
   *
   * A chave certa é a que chega perto de `vendasPdv` sem ficar abaixo.
   */
  async diagnosticoCupom(input: { de: string; ate: string }) {
    const { de, ate } = this.validaPeriodo(input.de, input.ate);
    const { inicio, fimExclusive } = this.caixaRange(de, ate);
    const { startDate, endDate } = this.brtRange(de, ate);

    const chaves: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT loja AS "loja",
              COUNT(*)::int                                   AS linhas,
              COUNT(DISTINCT numero)::int                     AS "porNumero",
              COUNT(DISTINCT (data_fec, numero))::int         AS "porDataNumero",
              COUNT(DISTINCT controle)::int                   AS "porControle",
              COUNT(DISTINCT (numero, hora))::int             AS "porNumeroHora",
              COUNT(DISTINCT (data_fec, numero, cod_cliente))::int AS "porDataNumeroCliente",
              COUNT(DISTINCT registro)::int                   AS "porRegistro",
              SUM(CASE WHEN numero IS NULL THEN 1 ELSE 0 END)::int AS "numeroNulo",
              SUM(CASE WHEN controle IS NULL THEN 1 ELSE 0 END)::int AS "controleNulo"
         FROM giga_caixa_mov
        WHERE data_fec >= $1 AND data_fec < $2
          AND (marcado IS NULL OR marcado <> 'SIM')
        GROUP BY loja`,
      inicio, fimExclusive,
    );

    const vendas: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode", COUNT(*)::int AS vendas
         FROM pdv_sales
        WHERE finalized_at >= $1 AND finalized_at <= $2
          AND status = 'finalized' AND is_training = false
          AND (payment_method IS NULL OR payment_method <> 'MARCADO')
        GROUP BY store_code`,
      startDate, endDate,
    );
    const pdvPorLoja = new Map<string, number>();
    for (const v of vendas) {
      for (const variante of this.variantes(v.storeCode)) {
        pdvPorLoja.set(variante, Number(v.vendas || 0));
      }
      pdvPorLoja.set(String(v.storeCode || '').toUpperCase(), Number(v.vendas || 0));
    }

    // Amostra: os NUMEROs que mais repetem — mostra o que está sendo agrupado.
    const amostra: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT loja, numero, controle,
              COUNT(*)::int AS linhas,
              COUNT(DISTINCT data_fec)::int AS dias,
              COUNT(DISTINCT cod_cliente)::int AS clientes,
              MIN(hora) AS "horaMin", MAX(hora) AS "horaMax",
              SUM(valor_total)::float8 AS total
         FROM giga_caixa_mov
        WHERE data_fec >= $1 AND data_fec < $2
          AND (marcado IS NULL OR marcado <> 'SIM')
        GROUP BY loja, numero, controle
        ORDER BY linhas DESC
        LIMIT 15`,
      inicio, fimExclusive,
    );

    return {
      de, ate,
      explicacao:
        'CUPOM = uma venda. A DRE conta valores distintos de NUMERO na caixa do Giga. '
        + 'Compare cada coluna "por*" com vendasPdv: a chave boa é a que chega perto SEM ficar abaixo '
        + '(o caixa contém o PDV, então nunca pode ter menos).',
      lojas: chaves.map((c) => ({
        ...c,
        vendasPdv: pdvPorLoja.get(String(c.loja || '').trim().toUpperCase()) ?? null,
      })),
      amostraNumerosQueMaisRepetem: amostra,
    };
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
      markupPadrao: MARKUP_PADRAO,
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
        markup: s.dreMarkup != null ? Number(s.dreMarkup) : null,
      })),
      // Só as ATIVAS na tela de classificação — inativa não recebe conta nova,
      // não faz sentido pedir pro dono classificar.
      especies: especies.filter((e: any) => e.ativa !== false).map((e: any) => ({
        id: e.id,
        nome: e.nome,
        dreGrupo: e.dreGrupo || null,
        dreGrupoEfetivo: this.grupoDaEspecie(e),
        configurado: !!e.dreGrupo,
      })),
      especiesInativas: especies.filter((e: any) => e.ativa === false).map((e: any) => ({
        id: e.id, nome: e.nome,
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

  /**
   * Markup da loja pro CMV. `null` volta pro padrão da rede.
   * Faixa 1,1–10: abaixo de 1 o custo seria maior que a venda; acima de 10 é
   * dedo errado, não negócio.
   */
  async setMarkupLoja(code: string, markup: number | null) {
    let valor: number | null = null;
    if (markup != null && String(markup) !== '') {
      valor = Number(markup);
      if (!Number.isFinite(valor) || valor < 1.1 || valor > 10) {
        throw new BadRequestException('Markup deve estar entre 1,1 e 10');
      }
    }
    await (this.prisma as any).store.update({ where: { code }, data: { dreMarkup: valor } });
    return { ok: true, code, markup: valor, padrao: MARKUP_PADRAO };
  }

  async setGrupoLoja(code: string, grupo: string) {
    const g = String(grupo || '').toUpperCase();
    if (!['LOJA', 'CANAL', 'FRANQUIA', 'REDE', 'FORA'].includes(g)) {
      throw new BadRequestException('Grupo inválido (LOJA | CANAL | FRANQUIA | REDE | FORA)');
    }
    await (this.prisma as any).store.update({ where: { code }, data: { dreGrupo: g } });
    return { ok: true, code, dreGrupo: g };
  }

  /**
   * CRIA espécie de conta. Não existia no sistema: o catálogo era fechado nos
   * 17 nomes herdados do Giga, e metade nem era natureza de despesa (BOLETO,
   * CHEQUE, DEPOSITO…). Sem isso, toda despesa nova era obrigada a virar
   * "OUTROS" — que cai em despesa FIXA e mente na DRE.
   */
  async criarEspecie(input: { nome: string; dreGrupo?: string; restrita?: boolean }, usuario?: string) {
    const nome = String(input.nome || '').trim().toUpperCase().slice(0, 30);
    if (nome.length < 2) throw new BadRequestException('Nome da espécie obrigatório');

    const existente = await (this.prisma as any).especieConta.findUnique({ where: { nome } });
    if (existente) {
      // Já existe mas estava inativa → reativa em vez de estourar erro.
      if (!existente.ativa) {
        await (this.prisma as any).especieConta.update({ where: { nome }, data: { ativa: true } });
        return { ok: true, id: existente.id, nome, reativada: true };
      }
      throw new BadRequestException(`Espécie "${nome}" já existe`);
    }

    const g = String(input.dreGrupo || '').toUpperCase();
    const row = await (this.prisma as any).especieConta.create({
      data: {
        nome,
        restrita: !!input.restrita,
        dreGrupo: ['VARIAVEL', 'FIXA', 'FINANCEIRA', 'CMV', 'IMPOSTO', 'IGNORAR'].includes(g) ? g : null,
      },
    });
    this.logger.log(`[dre] espécie "${nome}" criada por ${usuario || '—'}`);
    return { ok: true, id: row.id, nome };
  }

  /**
   * INATIVA a espécie (não apaga). As contas históricas continuam apontando
   * pra ela — apagar de verdade quebraria 20 anos de Contas a Pagar migrado
   * do Giga. Some do lançamento novo e da tela de classificação.
   */
  async setEspecieAtiva(id: string, ativa: boolean) {
    const row = await (this.prisma as any).especieConta.update({
      where: { id },
      data: { ativa },
    });
    return { ok: true, id, nome: row.nome, ativa };
  }

  /**
   * PRÉVIA da reclassificação em massa: quantas contas seriam movidas, quanto
   * somam e uma amostra pra conferir ANTES de aplicar.
   *
   * Serve pro caso real: existem N contas de vale-transporte lançadas como
   * VALE (ou OUTROS) e o dono quer todas na espécie VALE TRANSPORTE de uma
   * vez, sem abrir conta por conta.
   */
  async previaReclassificacao(input: {
    especieOrigemId?: string;
    busca?: string;
    de?: string;
    ate?: string;
  }) {
    const where = this.whereReclassificacao(input);
    const [total, agg, amostra] = await Promise.all([
      (this.prisma as any).contaPagar.count({ where }),
      (this.prisma as any).contaPagar.aggregate({ where, _sum: { valorCents: true } }),
      (this.prisma as any).contaPagar.findMany({
        where,
        orderBy: { vencimento: 'desc' },
        take: 25,
        include: { especie: true },
      }),
    ]);

    return {
      total,
      valor: Number(agg?._sum?.valorCents || 0) / 100,
      amostra: amostra.map((c: any) => ({
        id: c.id,
        numero: c.numero,
        vencimento: c.vencimento,
        beneficiario: c.fornecedorNome || c.sellerNome || '—',
        especieAtual: c.especie?.nome || '(sem espécie)',
        observacao: c.observacao,
        lojaCode: c.lojaCode,
        valor: Number(c.valorCents || 0) / 100,
      })),
    };
  }

  private whereReclassificacao(input: {
    especieOrigemId?: string; busca?: string; de?: string; ate?: string;
  }) {
    const where: any = { deletedAt: null, status: { not: 'cancelada' } };
    if (input.especieOrigemId) {
      where.especieId = input.especieOrigemId === '__SEM__' ? null : input.especieOrigemId;
    }
    const q = String(input.busca || '').trim();
    if (q) {
      // Procura em TODO campo onde o operador pode ter escrito "vale
      // transporte": nome do beneficiário, observação e nota fiscal.
      where.OR = [
        { fornecedorNome: { contains: q, mode: 'insensitive' } },
        { sellerNome: { contains: q, mode: 'insensitive' } },
        { observacao: { contains: q, mode: 'insensitive' } },
        { notaFiscal: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (input.de || input.ate) {
      where.vencimento = {};
      if (input.de) where.vencimento.gte = new Date(`${input.de}T00:00:00Z`);
      if (input.ate) where.vencimento.lte = new Date(`${input.ate}T00:00:00Z`);
    }
    return where;
  }

  /**
   * APLICA a reclassificação. Cada conta movida gera ContaPagarLog — o mesmo
   * rastro de "quem mudou o quê" que a edição unitária já deixa. Reversível:
   * é só reclassificar de volta.
   */
  async reclassificarEmMassa(
    input: {
      especieOrigemId?: string; busca?: string; de?: string; ate?: string;
      especieDestinoId: string;
    },
    usuario?: string,
  ) {
    const destino = await (this.prisma as any).especieConta.findUnique({
      where: { id: input.especieDestinoId },
    });
    if (!destino) throw new BadRequestException('Espécie de destino não encontrada');

    const where = this.whereReclassificacao(input);
    const alvos: any[] = await (this.prisma as any).contaPagar.findMany({
      where,
      select: { id: true, especieId: true, especie: { select: { nome: true } } },
      take: 5000,
    });
    if (!alvos.length) return { ok: true, movidas: 0, destino: destino.nome };
    if (alvos.some((a) => a.especieId === input.especieDestinoId) && alvos.length === 1) {
      return { ok: true, movidas: 0, destino: destino.nome, jaEstavam: 1 };
    }

    const paraMover = alvos.filter((a) => a.especieId !== input.especieDestinoId);

    // TRANSAÇÃO: mover e registrar têm que acontecer JUNTOS.
    //
    // Antes eram dois awaits soltos e isso mordeu de verdade (26/07): o INSERT
    // do log estourou um VarChar, a API devolveu 500 — mas as contas JÁ
    // tinham sido movidas. O dono viu "erro", foi conferir e o filtro veio
    // vazio, porque as contas não estavam mais na espécie de origem. Estado
    // ambíguo é pior que falha limpa: agora, se o log não entra, o move volta
    // atrás e ele pode simplesmente tentar de novo.
    //
    // Campos curtos no schema (origem 20, usuario 80, valores 300) — cortados
    // aqui pra não estourar de novo.
    await this.prisma.$transaction(async (tx: any) => {
      await tx.contaPagar.updateMany({
        where: { id: { in: paraMover.map((a) => a.id) } },
        data: { especieId: input.especieDestinoId, updatedBy: usuario?.slice(0, 80) || null },
      });
      await tx.contaPagarLog.createMany({
        data: paraMover.map((a) => ({
          contaId: a.id,
          campo: 'especieId',
          valorAntigo: String(a.especie?.nome || '(sem espécie)').slice(0, 300),
          valorNovo: String(destino.nome).slice(0, 300),
          usuario: usuario ? String(usuario).slice(0, 80) : null,
          origem: 'massa',
        })),
      });
    }, { timeout: 30_000 });

    this.logger.log(
      `[dre] reclassificação em massa: ${paraMover.length} conta(s) → "${destino.nome}" por ${usuario || '—'}`,
    );
    return {
      ok: true,
      movidas: paraMover.length,
      jaEstavam: alvos.length - paraMover.length,
      destino: destino.nome,
      truncado: alvos.length >= 5000,
    };
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
      create: { cnpj, mes, aliquotaPct: pct, observacao: input.observacao?.slice(0, 120) || null, criadoPor: usuario?.slice(0, 80) || null },
      update: { aliquotaPct: pct, observacao: input.observacao?.slice(0, 120) || null },
    });
    return { ok: true, id: row.id, cnpj, mes, aliquotaPct: pct };
  }

  async deleteAliquota(id: string) {
    await (this.prisma as any).dreAliquota.delete({ where: { id } });
    return { ok: true };
  }

  // ── ajustes gerenciais ───────────────────────────────────────────────────

  async listAjustes() {
    const rows: any[] = await (this.prisma as any).dreAjuste.findMany({
      orderBy: [{ tipo: 'asc' }, { descricao: 'asc' }],
    });
    return rows.map((a) => ({
      id: a.id, tipo: a.tipo, descricao: a.descricao,
      fornecedorMatch: a.fornecedorMatch,
      valorMensal: a.valorMensalCents != null ? a.valorMensalCents / 100 : null,
      percentual: a.percentual != null ? Number(a.percentual) : null,
      grupo: a.grupo, lojasExcluidas: a.lojasExcluidas, lojasIncluidas: a.lojasIncluidas, ativo: a.ativo,
    }));
  }

  async upsertAjuste(input: {
    id?: string;
    tipo: string;
    descricao: string;
    fornecedorMatch?: string;
    valorMensal?: number;
    percentual?: number;
    grupo?: string;
    lojasExcluidas?: string;
    lojasIncluidas?: string;
    ativo?: boolean;
  }, usuario?: string) {
    const tipo = String(input.tipo || '').toUpperCase();
    if (!['EXCLUIR_FORNECEDOR', 'DESPESA_FIXA', 'DESPESA_PCT'].includes(tipo)) {
      throw new BadRequestException('Tipo inválido (EXCLUIR_FORNECEDOR | DESPESA_FIXA | DESPESA_PCT)');
    }
    const descricao = String(input.descricao || '').trim().slice(0, 60);
    if (descricao.length < 2) throw new BadRequestException('Descrição obrigatória');

    if (tipo === 'EXCLUIR_FORNECEDOR' && !String(input.fornecedorMatch || '').trim()) {
      throw new BadRequestException('Informe o nome (ou parte) do fornecedor a excluir');
    }
    if (tipo === 'DESPESA_FIXA') {
      const v = Number(input.valorMensal);
      if (!Number.isFinite(v) || v <= 0) throw new BadRequestException('Valor mensal deve ser maior que zero');
    }
    if (tipo === 'DESPESA_PCT') {
      const v = Number(input.percentual);
      if (!Number.isFinite(v) || v <= 0 || v > 100) {
        throw new BadRequestException('Percentual deve estar entre 0 e 100');
      }
    }

    const data: any = {
      tipo,
      descricao,
      fornecedorMatch: tipo === 'EXCLUIR_FORNECEDOR'
        ? String(input.fornecedorMatch).trim().slice(0, 60) : null,
      valorMensalCents: tipo === 'DESPESA_FIXA'
        ? Math.round(Number(input.valorMensal) * 100) : null,
      percentual: tipo === 'DESPESA_PCT' ? Number(input.percentual) : null,
      grupo: tipo === 'EXCLUIR_FORNECEDOR' ? null
        : String(input.grupo || (tipo === 'DESPESA_PCT' ? 'VARIAVEL' : 'FIXA')).toUpperCase(),
      lojasIncluidas: tipo !== 'EXCLUIR_FORNECEDOR'
        ? (String(input.lojasIncluidas || '').trim().slice(0, 200) || null) : null,
      lojasExcluidas: tipo !== 'EXCLUIR_FORNECEDOR'
        ? (String(input.lojasExcluidas || '').trim().slice(0, 200) || null) : null,
      ativo: input.ativo !== false,
    };

    const row = input.id
      ? await (this.prisma as any).dreAjuste.update({ where: { id: input.id }, data })
      : await (this.prisma as any).dreAjuste.create({ data: { ...data, criadoPor: usuario?.slice(0, 80) || null } });
    return { ok: true, id: row.id };
  }

  async deleteAjuste(id: string) {
    await (this.prisma as any).dreAjuste.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Lança o gasto REAL de um ajuste percentual num mês. A partir daí a DRE
   * para de simular por coeficiente naquele mês.
   */
  async lancarRealizado(
    input: { ajusteId: string; mes: string; valor: number; observacao?: string },
    usuario?: string,
  ) {
    const mes = String(input.mes || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) throw new BadRequestException('Mês inválido (YYYY-MM)');
    const valor = Number(input.valor);
    if (!Number.isFinite(valor) || valor < 0) throw new BadRequestException('Valor inválido');

    const ajuste = await (this.prisma as any).dreAjuste.findUnique({ where: { id: input.ajusteId } });
    if (!ajuste) throw new BadRequestException('Ajuste não encontrado');
    if (ajuste.tipo !== 'DESPESA_PCT') {
      throw new BadRequestException('Só ajuste percentual aceita valor realizado');
    }

    const row = await (this.prisma as any).dreAjusteRealizado.upsert({
      where: { ajusteId_mes: { ajusteId: input.ajusteId, mes } },
      create: {
        ajusteId: input.ajusteId,
        mes,
        valorCents: Math.round(valor * 100),
        observacao: input.observacao?.slice(0, 160) || null,
        lancadoPor: usuario?.slice(0, 80) || null,
      },
      update: {
        valorCents: Math.round(valor * 100),
        observacao: input.observacao?.slice(0, 160) || null,
        lancadoPor: usuario?.slice(0, 80) || null,
      },
    });
    return { ok: true, id: row.id, mes, valor };
  }

  /** Apaga o lançado — o mês volta a usar o coeficiente. */
  async apagarRealizado(ajusteId: string, mes: string) {
    await (this.prisma as any).dreAjusteRealizado.deleteMany({ where: { ajusteId, mes } });
    return { ok: true, voltouPraSimulacao: true };
  }

  /** Lançamentos de um mês, pra tela mostrar o que já foi fechado. */
  async listRealizados(mes: string) {
    const m = String(mes || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) throw new BadRequestException('Mês inválido (YYYY-MM)');
    const rows: any[] = await (this.prisma as any).dreAjusteRealizado.findMany({
      where: { mes: m },
    });
    return rows.map((r) => ({
      ajusteId: r.ajusteId, mes: r.mes,
      valor: Number(r.valorCents) / 100,
      observacao: r.observacao, lancadoPor: r.lancadoPor, lancadoEm: r.updatedAt,
    }));
  }

  // ── taxas de cartão ──────────────────────────────────────────────────────

  async listTaxas() {
    const rows: any[] = await (this.prisma as any).taxaCartao.findMany({
      orderBy: [{ forma: 'asc' }, { bandeira: 'asc' }, { faixaParcela: 'asc' }],
    });
    return rows.map((t) => ({
      id: t.id, forma: t.forma, bandeira: t.bandeira,
      faixaParcela: t.faixaParcela, taxaPct: Number(t.taxaPct), ativo: t.ativo,
    }));
  }

  async upsertTaxa(
    input: { forma: string; bandeira: string; faixaParcela: string; taxaPct: number; ativo?: boolean },
    usuario?: string,
  ) {
    const forma = String(input.forma || '').toUpperCase().trim();
    if (!['PIX', 'DEBITO', 'CREDITO'].includes(forma)) {
      throw new BadRequestException('Forma inválida (PIX | DEBITO | CREDITO)');
    }
    // slice(0,20): a coluna é VarChar(20) e estourar derruba tudo em 500.
    const bandeira = this.semAcento(input.bandeira).replace(/[_\-\s]+/g, ' ').trim().slice(0, 20);
    if (!bandeira) throw new BadRequestException('Bandeira obrigatória');
    const faixa = String(input.faixaParcela || 'UNICA').toUpperCase().trim();
    if (!['UNICA', '1', '2-6', '7-12'].includes(faixa)) {
      throw new BadRequestException('Faixa inválida (UNICA | 1 | 2-6 | 7-12)');
    }
    const pct = Number(input.taxaPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 30) {
      throw new BadRequestException('Taxa deve estar entre 0 e 30%');
    }

    const row = await (this.prisma as any).taxaCartao.upsert({
      where: { bandeira_faixaParcela: { bandeira, faixaParcela: faixa } },
      create: { forma, bandeira, faixaParcela: faixa, taxaPct: pct, criadoPor: usuario?.slice(0, 80) || null },
      update: { forma, taxaPct: pct, ativo: input.ativo !== false },
    });
    return { ok: true, id: row.id, bandeira, faixaParcela: faixa, taxaPct: pct };
  }

  async deleteTaxa(id: string) {
    await (this.prisma as any).taxaCartao.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Bandeiras/faixas que APARECERAM nas vendas do período, com o volume — pra
   * tela mostrar o que precisa de taxa em vez de o dono adivinhar. Inclui o
   * que já tem taxa (pra conferir) e o que não tem (pra cadastrar).
   */
  async bandeirasDoPeriodo(input: { de: string; ate: string }) {
    const { de, ate } = this.validaPeriodo(input.de, input.ate);
    const { startDate, endDate } = this.brtRange(de, ate);

    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT p.method, p.details, SUM(p.valor)::float AS total, COUNT(*)::int AS qtd
         FROM pdv_sale_payments p
         JOIN pdv_sales s ON s.id = p.sale_id
        WHERE s.finalized_at >= $1 AND s.finalized_at <= $2
          AND s.status = 'finalized' AND s.is_training = false
          AND lower(p.method) IN ('pix','debito','credito','cartao')
        GROUP BY p.method, p.details`,
      startDate, endDate,
    );

    const tabela: any[] = await (this.prisma as any).taxaCartao.findMany();
    const temTaxa = new Set(tabela.map((t) => `${this.semAcento(t.bandeira)}|${t.faixaParcela}`));

    const agrupado = new Map<string, any>();
    for (const r of rows) {
      const metodo = String(r.method || '').toLowerCase();
      let bandeiraRaw = ''; let parcelas = 1;
      try {
        const det = typeof r.details === 'string' ? JSON.parse(r.details) : r.details;
        bandeiraRaw = String(det?.bandeira || '');
        parcelas = Number(det?.parcelas) || 1;
      } catch { /* ignora */ }
      const bandeira = this.normalizaBandeira(bandeiraRaw, metodo);
      const faixa = this.faixaDe(metodo, parcelas);
      const chave = `${bandeira}|${faixa}`;
      const acc = agrupado.get(chave) || {
        forma: metodo === 'pix' ? 'PIX' : metodo === 'debito' ? 'DEBITO' : 'CREDITO',
        bandeira, faixaParcela: faixa, volume: 0, transacoes: 0,
        temTaxa: temTaxa.has(chave),
      };
      acc.volume += Number(r.total || 0);
      acc.transacoes += Number(r.qtd || 0);
      agrupado.set(chave, acc);
    }

    return [...agrupado.values()].sort((a, b) => b.volume - a.volume);
  }
}
