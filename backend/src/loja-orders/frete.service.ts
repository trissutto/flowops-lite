import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CorreiosService } from '../correios/correios.service';
import { caixaDoSite } from '../common/caixa-site';

/**
 * FRETE DO SITE — uma fonte só, e ela mora aqui (bloco B da lista).
 *
 * ANTES: o e-commerce tinha uma tabela fixa por faixa de CEP em
 * `lib/commerce/frete.ts`, declarada como estimativa, e o backend tinha a
 * cotação real dos Correios COM CONTRATO que ninguém consumia. Duas verdades,
 * e a que a cliente via era a errada.
 *
 * AGORA (decisão do dono, 04/08): o preço que a cliente vê é **tabela
 * promocional**, cadastrada e com janela de datas:
 *
 *   SP                    → SEDEX  R$  9,99
 *   RJ · MG · PR · SC · RS→ PAC    R$ 19,99  (+ SEDEX pela cotação do contrato)
 *   demais UFs            → cotação real do contrato (dono, 06/08)
 *
 * A cotação real continua sendo consultada em todos os casos: é ela que dá o
 * PRAZO oficial e o preço do SEDEX opcional. Origem sempre a MATRIZ
 * (`CORREIOS_CEP_ORIGEM`) — cotar pela loja que despacha daria preço diferente
 * pro mesmo carrinho a cada recálculo do roteamento.
 *
 * TRÊS DEFESAS que a lista pediu por nome:
 *
 *  - **item 20** — Correios fora do ar NÃO trava o checkout. Cai na estimativa
 *    interna (a mesma tabela por faixa de CEP que o site usava), marcada com
 *    `estimado: true`. Frete aproximado é melhor que checkout parado — e a
 *    promocional, que é a maior parte dos pedidos, nem depende da cotação.
 *  - **item 21** — cache por CEP+peso (20 min). A cliente recota a cada peça
 *    que entra na sacola, e a API dos Correios não é rápida.
 *  - **item 25** — o prazo mostrado é o do transportador **+ dias de
 *    separação** (2, configurável). Prometer o prazo cru é prometer que a peça
 *    sai no mesmo dia; ela ainda vai ser separada, conferida e postada.
 */

/* ─────────────────────────────── contrato ─────────────────────────────── */

export interface OpcaoFrete {
  id: string;
  /** correios | expressa | retirada — o vocabulário que o site já usa. */
  kind: 'correios' | 'expressa';
  label: string;
  /** Em REAIS. 0 = grátis. */
  price: number;
  etaDays: { min: number; max: number };
  /** true = veio da estimativa interna, não da cotação real. */
  estimado?: boolean;
  /** true = preço de tabela promocional, não cotação. */
  promocional?: boolean;
}

export interface CotacaoFrete {
  ok: boolean;
  cep: string;
  uf: string | null;
  opcoes: OpcaoFrete[];
  /** Régua vigente do frete grátis — o site desenha a barra de progresso com isto. */
  freteGratis: { ativo: boolean; minimo: number; alcancado: boolean; falta: number };
  /** true = alguma opção saiu da estimativa (Correios não responderam, ou não a tempo — `CORREIOS_ORCAMENTO_MS`). */
  estimado: boolean;
}

/** servico ('pac' | 'sedex') → preço e prazo que os Correios devolveram. */
type MapaCotacao = Map<string, { preco: number; prazo: number | null }>;

/* ───────────────────────── faixas de CEP → UF ──────────────────────────── */

/**
 * Faixas oficiais dos Correios. Precisa ser exato: é o que decide se a cliente
 * paga R$ 19,99 de promocional ou a cotação cheia.
 */
const FAIXAS_UF: Array<[number, number, string]> = [
  [1000000, 19999999, 'SP'],
  [20000000, 28999999, 'RJ'],
  [29000000, 29999999, 'ES'],
  [30000000, 39999999, 'MG'],
  [40000000, 48999999, 'BA'],
  [49000000, 49999999, 'SE'],
  [50000000, 56999999, 'PE'],
  [57000000, 57999999, 'AL'],
  [58000000, 58999999, 'PB'],
  [59000000, 59999999, 'RN'],
  [60000000, 63999999, 'CE'],
  [64000000, 64999999, 'PI'],
  [65000000, 65999999, 'MA'],
  [66000000, 68899999, 'PA'],
  [68900000, 68999999, 'AP'],
  [69000000, 69299999, 'AM'],
  [69300000, 69399999, 'RR'],
  [69400000, 69899999, 'AM'],
  [69900000, 69999999, 'AC'],
  [70000000, 72799999, 'DF'],
  [72800000, 72999999, 'GO'],
  [73000000, 73699999, 'DF'],
  [73700000, 76799999, 'GO'],
  [76800000, 76999999, 'RO'],
  [77000000, 77999999, 'TO'],
  [78000000, 78899999, 'MT'],
  [79000000, 79999999, 'MS'],
  [80000000, 87999999, 'PR'],
  [88000000, 89999999, 'SC'],
  [90000000, 99999999, 'RS'],
];

export function ufDoCep(cep: string): string | null {
  const n = Number(String(cep || '').replace(/\D/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const faixa = FAIXAS_UF.find(([de, ate]) => n >= de && n <= ate);
  return faixa ? faixa[2] : null;
}

/**
 * ESTIMATIVA INTERNA — o paraquedas do item 20. É a mesma tabela por faixa de
 * CEP que o site usava como preço oficial; aqui ela desce de categoria: só
 * aparece quando os Correios não respondem, e sempre marcada `estimado`.
 */
const ESTIMATIVA: Record<string, { pac: [number, number, number]; sedex: [number, number, number] }> = {
  //                      preço, prazoMin, prazoMax
  SP: { pac: [17.9, 2, 5], sedex: [28.9, 1, 3] },
  RJ: { pac: [21.9, 4, 7], sedex: [34.9, 2, 4] },
  ES: { pac: [21.9, 4, 7], sedex: [34.9, 2, 4] },
  MG: { pac: [21.9, 4, 7], sedex: [34.9, 2, 4] },
  PR: { pac: [24.9, 5, 8], sedex: [39.9, 2, 4] },
  SC: { pac: [24.9, 5, 8], sedex: [39.9, 2, 4] },
  RS: { pac: [24.9, 5, 8], sedex: [39.9, 2, 4] },
  __norte: { pac: [32.9, 8, 12], sedex: [54.9, 4, 7] },
  __resto: { pac: [27.9, 6, 10], sedex: [46.9, 3, 5] },
};
const UF_NORTE = new Set(['AC', 'AM', 'AP', 'PA', 'RO', 'RR', 'TO']);

@Injectable()
export class FreteService {
  private readonly logger = new Logger(FreteService.name);

  /** Item 21 — cache por CEP+peso. 20 min: preço de contrato não muda no dia. */
  private cache = new Map<string, { at: number; dados: any }>();
  private static readonly CACHE_TTL = 20 * 60_000;
  private static readonly CACHE_MAX = 500;

  /**
   * ORÇAMENTO DE TEMPO da cotação dos Correios (17/08).
   *
   * O BFF do site (`ecommerce/src/app/api/loja/frete/route.ts`) desiste em 9 s
   * e cai na tabela local — SEM promoção e SEM raio de retirada. Aqui não
   * havia limite nenhum: auth 20 s + PAC 20 s + SEDEX 20 s (em série). Bastava
   * os Correios responderem em ~6 s por chamada (o normal já é ~5 s no total,
   * medido 17/08) pra cliente de SP ver "SEDEX R$ 24,90 estimado" no lugar do
   * SEDEX R$ 9,99 anunciado — e a promoção NEM DEPENDE dos Correios.
   *
   * 7 s: fica abaixo dos 9 s do BFF com folga pra config + rede, e acima dos
   * ~5 s normais. Estourou → devolve `null` (a `cotar` cai na estimativa
   * marcada `estimado`), mas a chamada original continua e grava o cache
   * quando responder — a próxima cotação desse CEP+peso já sai real.
   */
  private static readonly CORREIOS_ORCAMENTO_MS = 7_000;

  /**
   * Cotações EM VOO por chave (CEP+peso+altura). A tela de entrega re-dispara
   * a cotação a cada mudança de subtotal/peças e o checkout cota de novo no
   * clique do PIX — antes, cada uma abria OUTRA rodada nos Correios enquanto a
   * primeira ainda rodava. Agora quem chega com a mesma chave aguarda a mesma
   * promessa (com o seu próprio orçamento de tempo) e ela sai do mapa quando
   * termina, de um jeito ou de outro.
   */
  private emVoo = new Map<string, Promise<MapaCotacao | null>>();

  private configCache: { at: number; cfg: any; promos: any[] } | null = null;
  private static readonly CONFIG_TTL = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly correios: CorreiosService,
  ) {}

  private reais(v: any): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  /* ─────────────────────────── configuração ──────────────────────────── */

  /**
   * Lê config + promoções, semeando na PRIMEIRA vez.
   *
   * O seed nasce junto com o singleton, nunca depois: se um dia a loja apagar
   * todas as promoções de propósito, não é papel do código ressuscitá-las.
   */
  private async carregarConfig(): Promise<{ cfg: any; promos: any[] }> {
    if (this.configCache && Date.now() - this.configCache.at < FreteService.CONFIG_TTL) {
      return { cfg: this.configCache.cfg, promos: this.configCache.promos };
    }

    let cfg: any = null;
    let promos: any[] = [];
    try {
      cfg = await (this.prisma as any).siteFreteConfig.findUnique({ where: { id: 'singleton' } });
      if (!cfg) {
        cfg = await (this.prisma as any).siteFreteConfig.create({
          data: {
            id: 'singleton',
            freteGratisAtivo: true,
            // Régua escolhida pelo dono em 06/08 (era 399,90 chumbado no site).
            freteGratisMinimo: 499.9,
            diasSeparacao: 2,
            retiradaPrazoHoras: 3,
            retiradaInstrucoes:
              'Leve um documento com foto. A peça fica reservada por 3 dias corridos a partir do aviso de que chegou.',
          },
        });
        // Tabela promocional do dono (04/08), só no nascimento do singleton.
        await (this.prisma as any).siteFretePromo.createMany({
          data: [
            { label: 'SEDEX', servico: 'sedex', ufs: 'SP', preco: 9.99, ordem: 1 },
            { label: 'Correios PAC', servico: 'pac', ufs: 'RJ,MG,PR,SC,RS', preco: 19.99, ordem: 2 },
          ],
        });
        this.logger.log('[frete] config e tabela promocional criadas (primeira execução)');
      }
      promos = await (this.prisma as any).siteFretePromo.findMany({
        where: { ativo: true },
        orderBy: { ordem: 'asc' },
      });
    } catch (e: any) {
      // Tabela ainda não existe (deploy anterior ao db push): segue com o
      // padrão em memória em vez de derrubar a cotação.
      this.logger.warn(`[frete] config indisponível, usando padrão: ${e?.message || e}`);
      cfg = { freteGratisAtivo: true, freteGratisMinimo: 499.9, diasSeparacao: 2, retiradaPrazoHoras: 3 };
      promos = [
        { label: 'SEDEX', servico: 'sedex', ufs: 'SP', preco: 9.99, ordem: 1 },
        { label: 'Correios PAC', servico: 'pac', ufs: 'RJ,MG,PR,SC,RS', preco: 19.99, ordem: 2 },
      ];
    }

    this.configCache = { at: Date.now(), cfg, promos };
    return { cfg, promos };
  }

  /** Zera o cache — a tela de configuração chama depois de salvar. */
  invalidarCache(): void {
    this.configCache = null;
    this.cache.clear();
  }

  private naJanela(row: { inicioEm?: Date | null; fimEm?: Date | null }): boolean {
    const agora = Date.now();
    if (row.inicioEm && new Date(row.inicioEm).getTime() > agora) return false;
    if (row.fimEm && new Date(row.fimEm).getTime() < agora) return false;
    return true;
  }

  /* ──────────────────────────── cotação real ─────────────────────────── */

  /**
   * PESO E CAIXA — números do dono (04/08): 250 g/peça, 28 × 40 cm, e a
   * ALTURA por faixa (1–2 peças = 3 cm · 3–5 = 6 · 6+ = 10). Roupa comprime,
   * não empilha como tijolo.
   */
  private caixa(pecas: number) {
    return caixaDoSite(pecas);
  }

  /** Resposta crua do `CorreiosService` → mapa por serviço. Vazio = nada aproveitável. */
  private montarMapa(r: any): MapaCotacao {
    const mapa: MapaCotacao = new Map();
    for (const o of r?.opcoes ?? []) {
      if (o?.precoReais == null || !(Number(o.precoReais) > 0)) continue;
      mapa.set(String(o.servico).toLowerCase(), {
        preco: this.reais(o.precoReais),
        prazo: o.prazoDias != null ? Number(o.prazoDias) : null,
      });
    }
    return mapa;
  }

  /**
   * A chamada COMPLETA aos Correios, sem orçamento de tempo: é ela que grava o
   * cache quando terminar, mesmo que quem pediu já tenha desistido. NUNCA
   * rejeita — falha vira `null` aqui dentro. Isso importa porque a promessa
   * fica viva depois do race em `cotarCorreios`: uma rejeição tardia sem
   * ninguém escutando viraria `unhandledRejection` e derrubaria o processo.
   */
  private cotarCorreiosCompleto(
    chave: string,
    cep: string,
    c: { pesoGramas: number; comprimento: number; largura: number; altura: number },
  ): Promise<MapaCotacao | null> {
    return this.correios
      .calcularFrete({
        cepDestino: cep,
        pesoGramas: c.pesoGramas,
        comprimento: c.comprimento,
        largura: c.largura,
        altura: c.altura,
      })
      .then((r: any) => {
        const mapa = this.montarMapa(r);
        if (!mapa.size) return null;
        if (this.cache.size > FreteService.CACHE_MAX) this.cache.clear();
        this.cache.set(chave, { at: Date.now(), dados: mapa });
        return mapa;
      })
      .catch((e: any) => {
        this.logger.warn(`[frete] Correios não respondeu (${cep}): ${e?.message || e}`);
        return null;
      });
  }

  /**
   * Cotação dos Correios com cache, dedupe de chamadas em voo e orçamento de
   * tempo (`CORREIOS_ORCAMENTO_MS`). `null` = não respondeu A TEMPO (cai na
   * estimativa) — a chamada completa segue rodando e aquece o cache.
   */
  private async cotarCorreios(cep: string, pecas: number): Promise<MapaCotacao | null> {
    const c = this.caixa(pecas);
    const chave = `${cep}:${c.pesoGramas}:${c.altura}`;

    const guardado = this.cache.get(chave);
    if (guardado && Date.now() - guardado.at < FreteService.CACHE_TTL) return guardado.dados;

    // Já tem alguém cotando esta chave? Espera a mesma promessa em vez de
    // abrir outra rodada nos Correios.
    let completa = this.emVoo.get(chave);
    if (!completa) {
      const nova = this.cotarCorreiosCompleto(chave, cep, c);
      this.emVoo.set(chave, nova);
      // Sai do mapa ao terminar (só se ainda for a nossa — `invalidarCache`
      // não mexe aqui, mas o guard custa nada). `nova` nunca rejeita, então o
      // `.finally` encadeado também não.
      void nova.finally(() => {
        if (this.emVoo.get(chave) === nova) this.emVoo.delete(chave);
      });
      completa = nova;
    }

    const ESTOUROU = Symbol('estourou');
    let timer: NodeJS.Timeout | undefined;
    const orcamento = new Promise<typeof ESTOUROU>((resolve) => {
      timer = setTimeout(() => resolve(ESTOUROU), FreteService.CORREIOS_ORCAMENTO_MS);
    });

    try {
      const venceu = await Promise.race([completa, orcamento]);
      if (venceu === ESTOUROU) {
        this.logger.warn(
          `[frete] Correios passaram de ${FreteService.CORREIOS_ORCAMENTO_MS}ms (${cep}, ${c.pesoGramas}g) ` +
            `— respondendo com estimativa; o cache é gravado quando a cotação terminar.`,
        );
        return null;
      }
      return venceu;
    } finally {
      // A cotação venceu antes do prazo: não deixa o timer pendurado.
      if (timer) clearTimeout(timer);
    }
  }

  private estimativaDe(uf: string | null) {
    if (uf && ESTIMATIVA[uf]) return ESTIMATIVA[uf];
    if (uf && UF_NORTE.has(uf)) return ESTIMATIVA.__norte;
    return ESTIMATIVA.__resto;
  }

  /* ─────────────────────────────── cotar ─────────────────────────────── */

  /**
   * As opções que o site mostra, na ordem em que devem aparecer.
   *
   * Regras, na ordem em que valem:
   *  1. Promoção vigente pra UF entra com o preço dela (e o prazo do
   *     transportador, se a cotação respondeu).
   *  2. O serviço que a promoção NÃO cobre entra pela cotação — é o SEDEX
   *     opcional dos 5 estados e são as duas opções das demais UFs.
   *  3. Frete grátis zera a opção ECONÔMICA mais barata. Nunca o expresso:
   *     quem quer SEDEX paga SEDEX.
   *  4. Todo prazo leva +`diasSeparacao`.
   */
  async cotar(input: { cep: string; subtotal?: number; pecas?: number }): Promise<CotacaoFrete> {
    const cep = String(input?.cep || '').replace(/\D/g, '');
    const subtotal = this.reais(input?.subtotal);
    const pecas = Math.max(1, Number(input?.pecas) || 1);

    if (cep.length !== 8) {
      return {
        ok: false, cep, uf: null, opcoes: [],
        freteGratis: { ativo: false, minimo: 0, alcancado: false, falta: 0 },
        estimado: false,
      };
    }

    const uf = ufDoCep(cep);
    const { cfg, promos } = await this.carregarConfig();
    const dias = Math.max(0, Number(cfg?.diasSeparacao ?? 2));

    const cotado = await this.cotarCorreios(cep, pecas);
    const estimativa = this.estimativaDe(uf);
    const usouEstimativa = !cotado;

    /** Prazo final = transportador (ou estimativa) + separação. */
    const prazo = (servico: 'pac' | 'sedex'): { min: number; max: number } => {
      const oficial = cotado?.get(servico)?.prazo;
      if (oficial != null && oficial > 0) {
        // Os Correios devolvem UM número. A faixa que a cliente lê é ele e o
        // dia seguinte — prazo exato de transporte não existe.
        return { min: oficial + dias, max: oficial + dias + 1 };
      }
      const [, min, max] = estimativa[servico];
      return { min: min + dias, max: max + dias };
    };

    const opcoes: OpcaoFrete[] = [];
    const cobertosPorPromo = new Set<string>();

    // 1) Promoções da UF
    for (const p of promos) {
      if (!this.naJanela(p)) continue;
      const ufs = String(p.ufs || '')
        .split(',')
        .map((u: string) => u.trim().toUpperCase())
        .filter(Boolean);
      if (!uf || !ufs.includes(uf)) continue;

      const servico = String(p.servico || 'pac').toLowerCase() === 'sedex' ? 'sedex' : 'pac';
      cobertosPorPromo.add(servico);
      const base = prazo(servico);
      opcoes.push({
        id: `correios-${servico}`,
        // O SEDEX promocional de SP é a entrega PADRÃO da cliente paulista —
        // marcar como 'expressa' faria o cupom de frete grátis pular ele e o
        // checkout ficaria sem opção econômica nenhuma no maior mercado.
        kind: 'correios',
        label: p.label || (servico === 'sedex' ? 'SEDEX' : 'Correios PAC'),
        price: this.reais(p.preco),
        etaDays: {
          min: p.prazoMin != null ? Number(p.prazoMin) : base.min,
          max: p.prazoMax != null ? Number(p.prazoMax) : base.max,
        },
        promocional: true,
        ...(usouEstimativa && p.prazoMin == null ? { estimado: true } : {}),
      });
    }

    // 2) O que a promoção não cobriu, pela cotação (ou estimativa)
    for (const servico of ['pac', 'sedex'] as const) {
      if (cobertosPorPromo.has(servico)) continue;
      const vivo = cotado?.get(servico);
      let preco = vivo ? vivo.preco : estimativa[servico][0];
      let daCotacao = !!vivo;

      /**
       * 🔴 TRAVA DE SANIDADE (13/08) — expresso nunca mais barato que o
       * econômico que está na MESMA tela.
       *
       * Aconteceu de verdade: pedido pra Balneário Camboriú/SC saiu com
       * **SEDEX Expresso R$ 9,94** ao lado do PAC promocional de R$ 19,99. O
       * site ordena por preço, então o expresso apareceu PRIMEIRO e a cliente
       * escolheu — pagou R$ 9,94 por um envio que custa múltiplo disso.
       *
       * Preço de expresso abaixo do econômico não existe no mundo real: é erro
       * de leitura da cotação. Nesse caso a opção cai na estimativa interna
       * (marcada `estimado`) em vez de virar prejuízo silencioso, e o WARN
       * deixa rastro pra achar a causa na resposta crua dos Correios.
       */
      if (servico === 'sedex' && daCotacao) {
        const economico = opcoes.filter((o) => o.kind === 'correios').sort((a, b) => a.price - b.price)[0];
        if (economico && preco < economico.price) {
          this.logger.warn(
            `[frete] SEDEX cotado (R$ ${preco}) saiu ABAIXO do econômico (R$ ${economico.price}) pro CEP ${cep} ` +
              `— cotação descartada, usando estimativa. Confira a resposta crua em /retaguarda/correios.`,
          );
          preco = estimativa.sedex[0];
          daCotacao = false;
        }
      }

      if (!(preco > 0)) continue;
      const base = prazo(servico);
      opcoes.push({
        id: `correios-${servico}`,
        kind: servico === 'sedex' ? 'expressa' : 'correios',
        label: servico === 'sedex' ? 'SEDEX Expresso' : 'Correios PAC',
        price: this.reais(preco),
        etaDays: base,
        ...(daCotacao ? {} : { estimado: true }),
      });
    }

    // 3) Frete grátis — zera a econômica mais barata
    const gratisLigado =
      !!cfg?.freteGratisAtivo &&
      this.naJanela({ inicioEm: cfg?.freteGratisInicio, fimEm: cfg?.freteGratisFim }) &&
      this.ufNoRecorte(uf, cfg?.freteGratisUfs);
    const minimo = this.reais(cfg?.freteGratisMinimo ?? 499.9);
    const alcancado = gratisLigado && minimo > 0 && subtotal >= minimo;

    if (alcancado) {
      const economicas = opcoes.filter((o) => o.kind === 'correios');
      const alvo = economicas.sort((a, b) => a.price - b.price)[0];
      if (alvo) alvo.price = 0;
    }

    opcoes.sort((a, b) => a.price - b.price);

    return {
      ok: opcoes.length > 0,
      cep,
      uf,
      opcoes,
      freteGratis: {
        ativo: gratisLigado,
        minimo,
        alcancado,
        falta: alcancado ? 0 : Math.max(0, this.reais(minimo - subtotal)),
      },
      estimado: opcoes.some((o) => o.estimado),
    };
  }

  /** Recorte de região do frete grátis. Vazio = vale pro Brasil inteiro. */
  private ufNoRecorte(uf: string | null, csv?: string | null): boolean {
    const lista = String(csv || '')
      .split(',')
      .map((u) => u.trim().toUpperCase())
      .filter(Boolean);
    if (!lista.length) return true;
    return !!uf && lista.includes(uf);
  }

  /**
   * A opção escolhida ainda existe e custa o que o site disse? É a conferência
   * que o `reprecificar()` faz antes de cobrar — frete também é dinheiro.
   */
  async conferir(input: {
    cep: string;
    subtotal: number;
    pecas: number;
    quoteId: string;
  }): Promise<OpcaoFrete | null> {
    const r = await this.cotar(input);
    return r.opcoes.find((o) => o.id === input.quoteId) ?? null;
  }

  /** Config vigente — a tela de entrega usa pro texto da retirada. */
  async config() {
    const { cfg, promos } = await this.carregarConfig();
    return { cfg, promos };
  }
}
