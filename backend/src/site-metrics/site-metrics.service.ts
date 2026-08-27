import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { diaBrasiliaSql } from '../common/tz';

/** Só estes entram. Evento fora da lista é descartado em silêncio — a rota é
 *  pública (token compartilhado) e não vira depósito de qualquer coisa. */
const EVENTOS_ACEITOS = new Set([
  'whatsapp_click',
  'instagram_click',
  'store_locator',
  'phone_click',
]);

export interface CliqueEntrada {
  evento?: string;
  loja?: string | null;
  cidade?: string | null;
  origem?: string | null;
  path?: string | null;
  sessionId?: string | null;
}

/** Um evento genérico do site — a cópia de primeira parte do funil inteiro. */
export interface EventoEntrada {
  evento?: string;
  path?: string | null;
  loja?: string | null;
  sessionId?: string | null;
  valor?: number | null;
  dados?: unknown;
  semAceite?: boolean;
  /** Carimbado pelo `/api/events` do site, pelo user-agent (ver `bot-detect.ts`). */
  bot?: boolean;
  botNome?: string | null;
}

/**
 * SESSÃO DE GENTE — a segunda defesa contra robô, e a que pega quem mente.
 *
 * A primeira é o carimbo `bot`, feito na origem pelo user-agent. Scraper em
 * Chrome headless disfarçado de Chrome normal passa por ela — mas não passa
 * por esta: ele carrega a página e vai embora, sem rolar, sem ficar, sem
 * clicar. Pessoa produz `scroll_depth`/`time_on_page` em segundos, ou navega
 * pra uma segunda página.
 *
 * Daí a régua: "algum evento de AÇÃO HUMANA, OU 2+ páginas". Ela custa a
 * sessão legítima que bateu e saiu em menos de ~3s — que é, com o dado que
 * temos, indistinguível de robô.
 *
 * Medição que originou a regra (16/08/2026): em `/lojas`, 31 de 38 sessões
 * tinham UM `page_view` e mais nada; na mesma manhã, numa página de produto
 * com gente de verdade, eram 4 de 112 (3,6%).
 *
 * ── POR QUE `view_item` NÃO CONTA COMO SINAL (16/08/2026, segunda passada) ──
 *
 * A primeira versão da régua dizia "algum evento além de `page_view`", e com
 * ela a tela ficou PIOR na página de produto: 419 de 432 sessões (97%) viram
 * peça, e a perda "Visita → Produto visto" desabou de 36% pra 3%. O corte
 * limpou a home e não limpou a PDP — justo onde estava o problema.
 *
 * A causa é que `view_item` NÃO É AÇÃO DE NINGUÉM: ele dispara sozinho no
 * `useEffect` de montagem do `BuyBox` (site), a cada carregamento de PDP.
 * Scraper que abre `/produto/x` ganhava `page_view` + `view_item` e com isso
 * era PROMOVIDO a pessoa — enquanto o mesmo scraper na home, que só produz
 * `page_view`, era corretamente descartado. A régua certificava como humana
 * exatamente a etapa que ela precisava medir.
 *
 * Sinal de gente é o que exige um dedo: `scroll_depth`, `time_on_page` (3s+,
 * dispara também quando a aba some), troca de cor/tamanho, busca, filtro,
 * sacola, checkout. `page_view` e `view_item` são automáticos e ficam fora.
 *
 * ── QUEM VEIO DE ANÚNCIO NUNCA É CORTADA (dono, 16/08/2026) ──
 *
 * "E se a pessoa entrar e sair antes de 3 segundos porque o site não tinha
 * nada a ver com o que ela esperava? Aí é erro de campanha."
 *
 * Está certo, e sem esta cláusula a régua apagava justamente a prova disso: a
 * rejeição relâmpago de tráfego pago é o sintoma nº 1 de anúncio prometendo o
 * que a página não entrega, e some da conta classificada como robô. O pior
 * tipo de erro de medição — o que esconde dinheiro sendo queimado.
 *
 * Clique em anúncio é ação humana por definição. `campanha`/`canal` só são
 * gravados quando houve UTM na URL ou referrer externo de verdade (ver
 * `captureAttribution` e `inferSource` no site): scraper batendo na URL crua
 * não tem nenhum dos dois. `midia` NÃO serve — ela vale 'direct' pra todo
 * mundo que chega sem referrer, robô incluído.
 *
 * Vale pro passado inteiro sem depender de deploy — é comportamento que já
 * está gravado, não campo novo.
 *
 * A REGRA VIVE AQUI, EM UM LUGAR SÓ. Cada tela que a copiasse seria uma
 * definição de "pessoa" pronta pra divergir das outras.
 */

/** Eventos que o navegador dispara SOZINHO ao montar a página. Não provam
 *  gente: robô com JavaScript produz os dois sem tocar em nada. */
const EVENTOS_AUTOMATICOS = `('page_view','view_item')`;

/** Chegou por link identificado (UTM ou referrer externo) — clicou em algo
 *  fora do site pra chegar aqui, e isso é dedo de gente. */
const SQL_VEIO_DE_LINK = `dados ? 'campanha' OR dados ? 'canal'`;

const SQL_SINAL_DE_GENTE = `
    COUNT(*) FILTER (WHERE evento NOT IN ${EVENTOS_AUTOMATICOS}) > 0
    OR COUNT(DISTINCT path) > 1
    OR COUNT(*) FILTER (WHERE ${SQL_VEIO_DE_LINK}) > 0`;

/** As sessões de gente de um período ($1..$2) — pronta pra virar CTE. */
const SQL_SESSOES_DE_GENTE = `
    SELECT session_id
      FROM site_eventos
     WHERE criado_em >= $1 AND criado_em <= $2 AND session_id IS NOT NULL AND NOT bot
     GROUP BY session_id
    HAVING ${SQL_SINAL_DE_GENTE}`;

/**
 * O CORTE "SÓ GENTE" pronto pra colar em QUALQUER query desta tela. Exige que
 * a query declare a CTE `gente` (= `SQL_SESSOES_DE_GENTE`).
 *
 * ── POR QUE ISTO VIROU FUNÇÃO (16/08/2026) ──
 *
 * A régua de "pessoa" existia em um lugar só, mas era APLICADA em um lugar só
 * também: o `funil()` filtrava robô e o quadro "Onde a compra parou", logo
 * abaixo dele NA MESMA TELA, não filtrava nada. O parágrafo explicativo
 * prometia o corte para os dois. Duas populações, um texto, uma tela.
 *
 * O sintoma era o topo do funil inchado: `session_id` nasce no `sessionStorage`
 * do navegador, então CADA página que um robô com JavaScript abre vira uma
 * "pessoa" nova (ver `bot-detect.ts` no site). Varredura de catálogo dispara
 * `page_view` + `view_item` — o `view_item` só existe na página de produto —
 * e nunca avança. Medição de 16/08: 401 de 622 sessões "viram peça" (64%,
 * quando gente de verdade fica em 25-40%) e 386 delas morriam ali, produzindo
 * um "MAIOR PERDA: 96%" que era varredura, não cliente desistindo.
 *
 * Regra daqui pra frente: query nova nesta tela nasce com este corte. Tela que
 * se contradiz sozinha já custou caro antes (a lista do CRM que mostrava o
 * cliente e a ficha que negava).
 */
const soGente = (alias: string) =>
  `NOT ${alias}.bot AND ${alias}.session_id IN (SELECT session_id FROM gente)`;

/**
 * O SEGMENTO — a cascata "tudo → pago → plataforma → campanha".
 *
 * Pedido do dono (16/08): "aparece todos os dados, depois filtramos tráfego
 * pago, depois Google/Meta, depois a campanha". O recorte é de SESSÃO, não de
 * evento: a pergunta é "como é o funil INTEIRO do público desse anúncio", e
 * pra isso a sessão precisa entrar ou sair por completo. Filtrar evento a
 * evento daria um funil onde a visita é de um público e a compra é de outro.
 *
 * ── A ORIGEM DA SESSÃO É A DO PRIMEIRO EVENTO QUE TIVER UMA ──
 *
 * `DISTINCT ON` com `(canal) IS NULL` primeiro no ORDER BY: vale o evento mais
 * antigo que trouxe origem, e só cai pro mais antigo de todos quando nenhum
 * trouxe. Mesmo critério que o quadro "por campanha" do tráfego de lojas já
 * usava — dois critérios de "de onde veio" na mesma tela seria pedir pra
 * divergirem.
 *
 * ⚠️ A atribuição vive 30 dias no navegador (last-click, igual Meta e GA4).
 * "Sessão da campanha X" quer dizer "o último anúncio que essa pessoa clicou
 * foi o X", não "esta visita veio do anúncio". A tela avisa.
 *
 * Os três filtros são parâmetros ($3/$4/$5) e NULL desliga cada um. Sempre
 * referenciados, mesmo em "tudo": query que deixasse de citar um parâmetro
 * quebraria no bind do Postgres, e valor concatenado à mão seria injeção.
 */
/**
 * A PLATAFORMA, NORMALIZADA — Google continua sendo Google com o UTM torto.
 *
 * `plataforma` só é preenchida quando veio `gclid`/`fbclid`; sem id de clique
 * ela cai pro `canal`, que é o `utm_source` cru. E `utm_source` cru chega
 * errado com frequência: em 22/08/2026 a tela mostrava
 * `Google_Pmax_Feeds_Petter` e `Google_Shopping_Novidades_Petter` como se
 * fossem PLATAFORMAS — alguém pôs o nome da campanha no `utm_source`. Fatiar o
 * Google em três linhas de uma peça só não é relatório, é ruído; e uma
 * variação de maiúscula (`Meta` × `meta`) já bastava pra abrir linha nova.
 *
 * Dobra só o que é reconhecível e devolve o resto intacto: normalizar tudo
 * apagaria origem legítima que ninguém previu.
 *
 * ⚠️ Tem que ser o MESMO texto nos dois lugares — na lista que MOSTRA as
 * opções (`segmentosDisponiveis`) e no filtro que RECORTA por elas
 * (`SQL_SESSOES_DO_SEGMENTO`). Divergir aqui é oferecer na tela um "google"
 * que o filtro não encontra, e o relatório inteiro voltar vazio.
 */
const SQL_PLATAFORMA = `
      CASE
        WHEN lower(COALESCE(plataforma, canal)) LIKE '%google%'          THEN 'google'
        WHEN lower(COALESCE(plataforma, canal)) ~ '(meta|facebook|instagram)' THEN 'meta'
        ELSE COALESCE(plataforma, canal)
      END`;

/**
 * O NOME DA CAMPANHA SEGUNDO OS ESPELHOS — id → nome, Meta E Google.
 *
 * Existe porque a tela mostra o rótulo do ESPELHO (`COALESCE(g.nome, campanha)`)
 * e usa esse MESMO texto como valor de filtro. Quando o nome do espelho difere
 * do `utm_campaign` cru — que é justamente o caso que o espelho existe pra
 * consertar (`utm_campaign={{campaign.id}}`, campanha renomeada no Gerenciador,
 * nome com codificação dupla) — filtrar pelo rótulo não acha nada, e a tela
 * responde "essa campanha não gerou nada" em vez de "não achei a campanha".
 *
 * ⚠️ Tem que cobrir os DOIS espelhos. Enquanto isto lia só o `meta_ads_gasto_dia`,
 * marcar um anúncio de lojas do GOOGLE salvava e não fazia efeito nenhum: o nome
 * salvo não era o utm cru nem o nome do Meta, então não casava de lado nenhum —
 * o botão dizia "salvo" e o número não se mexia.
 */
const SQL_NOMES_DE_CAMPANHA = `
      SELECT campanha_id, MAX(campanha_nome) AS nome FROM meta_ads_gasto_dia GROUP BY campanha_id
      UNION ALL
      SELECT campanha_id, MAX(campanha_nome) AS nome FROM google_ads_gasto_dia GROUP BY campanha_id`;

const SQL_SESSOES_DO_SEGMENTO = `
    SELECT session_id FROM (
      SELECT DISTINCT ON (session_id) session_id,
             dados->>'campanha'   AS campanha,
             dados->>'canal'      AS canal,
             dados->>'plataforma' AS plataforma,
             dados->>'utm_id'     AS utm_id,
             COALESCE(dados->>'pago', 'false') = 'true' AS pago
        FROM site_eventos
       WHERE criado_em >= $1 AND criado_em <= $2 AND session_id IS NOT NULL
       ORDER BY session_id, (dados->>'canal') IS NULL, criado_em
    ) origem
     WHERE ($3::text IS NULL
            OR ($3 = 'pago'     AND pago)
            OR ($3 = 'organico' AND NOT pago AND canal IS NOT NULL)
            OR ($3 = 'direto'   AND canal IS NULL))
       AND ($4::text IS NULL OR (${SQL_PLATAFORMA}) = $4)
       -- Casa pelo utm_campaign CRU **ou** pelo nome que o espelho dá àquele
       -- utm_id — porque é o rótulo do espelho que a tela mostra e devolve como
       -- filtro. Sem o segundo braço, clicar numa campanha renomeada no
       -- Gerenciador zera funil, jornada e problemas de uma vez.
       AND ($5::text IS NULL
            OR campanha = $5
            OR utm_id IN (SELECT campanha_id FROM (${SQL_NOMES_DE_CAMPANHA}) nc WHERE nc.nome = $5))`;

/** Recorte do segmento pra uma tabela `site_eventos` com o alias dado. Exige
 *  que a query declare a CTE `segmento`. */
const doSegmento = (alias: string) =>
  `${alias}.session_id IN (SELECT session_id FROM segmento)`;

/**
 * OS DOIS CORTES JUNTOS — é assim que toda query desta tela filtra.
 *
 * Só gente E só o segmento escolhido. Existem colados de propósito: a versão
 * anterior tinha o corte de robô aplicado em umas queries e não em outras, e a
 * tela mostrou duas populações ao mesmo tempo. Um filtro que dá pra esquecer é
 * um filtro que vai ser esquecido.
 */
const soGenteDoSegmento = (alias: string) =>
  `${soGente(alias)} AND ${doSegmento(alias)}`;

/** O que os três níveis da cascata aceitam. Qualquer outra coisa vira "tudo". */
export const TRAFEGOS = ['pago', 'organico', 'direto'] as const;
export type Trafego = (typeof TRAFEGOS)[number];

/** Os três filtros da cascata, já normalizados pro bind ($3/$4/$5). */
export interface Segmento {
  trafego: Trafego | null;
  plataforma: string | null;
  campanha: string | null;
}

export const SEM_SEGMENTO: Segmento = { trafego: null, plataforma: null, campanha: null };

/** Os parâmetros da cascata na ordem do bind, pra não repetir em 8 queries. */
const args = (de: Date, ate: Date, s: Segmento) =>
  [de, ate, s.trafego, s.plataforma, s.campanha] as const;

/**
 * Os MESMOS cinco + a lista de anúncios de lojas ($6) — pras queries que
 * declaram a CTE `lojas`. Só elas: o Postgres recusa bind com parâmetro
 * sobrando ("bind message supplies 6 parameters, but ... requires 5"), então
 * query sem `lojas` continua com `args()` e não com este.
 */
const argsLojas = (de: Date, ate: Date, s: Segmento, campanhasLojas: readonly string[]) =>
  [de, ate, s.trafego, s.plataforma, s.campanha, [...campanhasLojas]] as const;

const CAMPOS_DIAGNOSTICOS: Record<string, readonly string[]> = {
  // `item_list_name` entra em 18/08, junto com as cinco vitrines da home.
  //
  // O site SEMPRE mandou o nome da vitrine no `select_item` — o GA4 recebe e
  // usa. Aqui ele era podado em silêncio: `select_item` não tinha entrada
  // neste mapa, então `permitidos` ficava só com os campos de contexto e o
  // nome sumia. Com duas vitrines dava pra viver sem; com cinco, os cliques
  // ficariam indistinguíveis no banco e "qual vitrine vende" não teria
  // resposta no painel de primeira parte. Mesma família da poda do UTM.
  select_item: ['item_list_name'],
  color_switch: ['color'],
  size_switch: ['size'],
  add_to_cart_blocked: ['reason'],
  add_shipping_info: ['shipping_tier'],
  add_payment_info: ['payment_type'],
  checkout_submission: ['method'],
  // `code`, `field`, `stage` e `attempt` entram (17/08): a Kênia falhou 14
  // vezes com `validation_error` e ninguém sabia QUAL campo — o front mandava,
  // o sanitizador podava. Diagnóstico às cegas custa a venda seguinte.
  // `motivo` e `ref` entram (23/08) pelo MESMO motivo do `field`, um nível
  // acima: o site já mandava os dois desde 22/08 e este mapa podava os dois em
  // silêncio. Sem eles, `catalog_unavailable` — que é UM código cobrindo SETE
  // recusas (peça sumiu, despublicada, esgotou, estoque insuficiente, preço
  // subiu…) — chega ao painel como uma frase só. Medido em 22/08: 7 clientes
  // recusadas no envio do pedido e nenhuma resposta sobre qual das sete foi.
  checkout_error: ['method', 'reason', 'code', 'field', 'stage', 'attempt', 'motivo', 'ref'],
  checkout_validation_error: ['section', 'field'],
  pix_created: ['method'],
  payment_method_selected: ['method'],
  pix_copied: ['method', 'order_id'],
  pix_expired: ['method', 'order_id'],
  card_declined: ['method', 'attempt'],
  payment_retry: ['method', 'attempt'],
  checkout_recovered: ['method', 'order_id'],
};

/**
 * CAMPOS DE CONTEXTO — valem pra QUALQUER evento.
 *
 * ── O BUG QUE ISTO CONSERTA (16/08/2026) ──
 *
 * `CAMPOS_DIAGNOSTICOS` é indexado POR EVENTO, e o UTM não pertence a evento
 * nenhum: ele viaja em todos. Resultado, desde que a coleta nasceu: `campanha`,
 * `canal`, `midia`, `posicao` e `utm_id` chegavam do site e eram descartados
 * aqui em SILÊNCIO — `page_view` nem tem entrada no mapa, então `permitidos`
 * era `[]` e o `dados` inteiro virava `undefined`.
 *
 * Duas coisas estavam no ar por causa disto: o quadro "por campanha" do
 * tráfego de lojas respondia "sem campanha" pra todo mundo, e a cláusula que
 * protege tráfego pago do corte de robô (`dados ? 'campanha'`) era letra
 * morta — a chave nunca existiu no banco.
 *
 * Mesma família da pegadinha do Zod: chave fora do schema some sem erro. Por
 * isso a lista de contexto mora separada da de diagnóstico — pro próximo campo
 * que valha pra todo evento não ter que ser repetido em quinze linhas.
 *
 * A defesa contra PII continua inteira: a lista é FECHADA e os valores são
 * cortados. E-mail, telefone e endereço seguem sem entrar.
 */
const CAMPOS_DE_CONTEXTO = [
  'campanha',
  'canal',
  'midia',
  'posicao',
  'utm_id',
  /** `true` quando veio de gclid/fbclid ou de utm_medium pago (ver o site). */
  'pago',
  'plataforma',
  'busca',
  'origem',
] as const;

/** Defesa final contra PII: só persiste chaves fechadas e valores curtos. */
export function sanitizarDadosEvento(
  evento: string,
  dados: unknown,
): Record<string, string | string[]> | undefined {
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return undefined;
  const permitidos = [...CAMPOS_DE_CONTEXTO, ...(CAMPOS_DIAGNOSTICOS[evento] ?? [])];
  const origem = dados as Record<string, unknown>;
  const limpo: Record<string, string | string[]> = {};
  for (const campo of permitidos) {
    const valor = origem[campo];
    if (typeof valor !== 'string' && typeof valor !== 'number' && typeof valor !== 'boolean') continue;
    const texto = String(valor).trim().slice(0, 80);
    if (texto) limpo[campo] = texto;
  }

  /**
   * `refs` (as REFs das peças do evento) é LISTA e não passa pelo laço acima,
   * que só aceita escalar — então vinha sendo descartada pelo mesmo silêncio.
   * Teto de 6 itens curtos, igual ao que o site já manda.
   */
  const refs = origem.refs;
  if (Array.isArray(refs)) {
    const limpas = refs
      .filter((r): r is string => typeof r === 'string')
      .map((r) => r.trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 6);
    if (limpas.length) limpo.refs = limpas;
  }

  return Object.keys(limpo).length ? limpo : undefined;
}

/** Uma linha do relatório: a loja e o que fizeram nela. */
export interface LinhaLoja {
  loja: string;
  comoChegar: number;
  whatsapp: number;
  instagram: number;
  telefone: number;
  total: number;
  /** Sessões distintas — quantas PESSOAS, não quantos cliques. */
  pessoas: number;
}

export const ETAPAS_JORNADA = [
  'page_view',
  'view_item',
  'add_to_cart',
  'begin_checkout',
  'add_payment_info',
  'purchase',
] as const;

export type LinhaJornada = {
  evento: (typeof ETAPAS_JORNADA)[number];
  chegaram: number;
  avancaram: number | null;
  abandonaram: number;
  taxaAvanco: number | null;
  taxaPerda: number | null;
};

/** Converte a etapa máxima de cada sessão em transições sem dupla contagem. */
export function montarJornada(
  contagens: Array<{ etapaMaxima: number; pessoas: number }>,
): LinhaJornada[] {
  const porEtapa = new Map<number, number>();
  for (const linha of contagens) {
    const etapa = Number(linha.etapaMaxima);
    porEtapa.set(etapa, (porEtapa.get(etapa) ?? 0) + (Number(linha.pessoas) || 0));
  }

  return ETAPAS_JORNADA.map((evento, indice) => {
    const chegaram = Array.from(porEtapa.entries()).reduce(
      (total, [etapa, pessoas]) => total + (etapa >= indice ? pessoas : 0),
      0,
    );
    const final = indice === ETAPAS_JORNADA.length - 1;
    const avancaram = final
      ? null
      : Array.from(porEtapa.entries()).reduce(
          (total, [etapa, pessoas]) => total + (etapa > indice ? pessoas : 0),
          0,
        );
    const abandonaram = final ? 0 : Math.max(0, chegaram - (avancaram ?? 0));

    return {
      evento,
      chegaram,
      avancaram,
      abandonaram,
      taxaAvanco: final || chegaram === 0 ? null : ((avancaram ?? 0) / chegaram) * 100,
      taxaPerda: final || chegaram === 0 ? null : (abandonaram / chegaram) * 100,
    };
  });
}

@Injectable()
export class SiteMetricsService {
  private readonly logger = new Logger(SiteMetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── ANÚNCIOS DE LOJAS — a lista que tira campanha do funil do site ──────
  //
  // Chave em `app_config` (mesmo padrão do cashback e do desconto
  // progressivo): lista de NOMES de campanha, como aparecem na cascata da
  // tela. Sessão cuja origem é uma delas vira "tráfego de lojas" mesmo
  // entrando pela home (ver `SESSOES_DE_LOJA`).
  //
  // PADRÃO enquanto o dono não salva nada: a campanha que motivou isto
  // (19/08/2026) — ela já está no ar apontando pra home, e esperar um clique
  // na tela pra voltar a separar seria deixar o funil mentindo um dia a mais.
  // A primeira gravação pela tela substitui o padrão por inteiro.
  static readonly CHAVE_CAMPANHAS_DE_LOJAS = 'site_metrics.campanhas_de_lojas';
  static readonly CAMPANHAS_DE_LOJAS_PADRAO: readonly string[] = [
    '|SITE NOVO| Tráfego Home / Nossas Lojas',
  ];

  async campanhasDeLojas(): Promise<string[]> {
    try {
      const row = await (this.prisma as any).appConfig?.findUnique({
        where: { key: SiteMetricsService.CHAVE_CAMPANHAS_DE_LOJAS },
      });
      if (row?.valueJson) {
        const lista = JSON.parse(row.valueJson);
        if (Array.isArray(lista)) {
          return lista.map((c) => String(c).trim()).filter(Boolean);
        }
      }
    } catch (e: any) {
      this.logger.warn(`[campanhas-de-lojas] ler app_config falhou: ${e?.message}`);
    }
    return [...SiteMetricsService.CAMPANHAS_DE_LOJAS_PADRAO];
  }

  /** Substitui a lista inteira. Nome vazio cai fora; repetido conta uma vez. */
  async salvarCampanhasDeLojas(lista: unknown): Promise<string[]> {
    const limpa = Array.from(
      new Set(
        (Array.isArray(lista) ? lista : [])
          .map((c) => String(c ?? '').trim().slice(0, 200))
          .filter(Boolean),
      ),
    ).slice(0, 100);
    await (this.prisma as any).appConfig.upsert({
      where: { key: SiteMetricsService.CHAVE_CAMPANHAS_DE_LOJAS },
      create: { key: SiteMetricsService.CHAVE_CAMPANHAS_DE_LOJAS, valueJson: JSON.stringify(limpa) },
      update: { valueJson: JSON.stringify(limpa) },
    });
    this.logger.log(`[campanhas-de-lojas] lista atualizada: ${JSON.stringify(limpa)}`);
    return limpa;
  }

  /** Corta no tamanho da coluna. Texto maior que o VarChar derruba o INSERT
   *  inteiro no Postgres, e derrubar um lote de cliques por causa de um path
   *  comprido seria perder dado bom por causa de dado feio. */
  private corta(valor: unknown, max: number): string | null {
    if (valor === null || valor === undefined) return null;
    const texto = String(valor).trim();
    return texto ? texto.slice(0, max) : null;
  }

  /**
   * Grava o lote vindo do site. NUNCA lança: se a gravação falhar, o site não
   * pode quebrar por causa de métrica. Devolve quantos entraram.
   */
  async registrar(entradas: CliqueEntrada[]): Promise<number> {
    const linhas = entradas
      .filter((e) => e?.evento && EVENTOS_ACEITOS.has(e.evento))
      .map((e) => ({
        evento: this.corta(e.evento, 40) as string,
        loja: this.corta(e.loja, 80),
        cidade: this.corta(e.cidade, 80),
        origem: this.corta(e.origem, 40),
        path: this.corta(e.path, 160),
        sessionId: this.corta(e.sessionId, 64),
      }));

    if (!linhas.length) return 0;

    try {
      const r = await this.prisma.siteStoreClick.createMany({ data: linhas });
      return r.count;
    } catch (err) {
      this.logger.error(`falha ao gravar cliques de loja: ${String(err)}`);
      return 0;
    }
  }

  /**
   * TODO EVENTO DO SITE, sem lista fechada (dono, 13/08: "para todo o site").
   * Aqui aceita qualquer nome de evento — quem valida forma e teto é o BFF do
   * e-commerce, e a rota continua atrás do token compartilhado. `semAceite`
   * marca a linha anônima de quem não aceitou o banner.
   */
  async registrarEventos(entradas: EventoEntrada[]): Promise<number> {
    const linhas = entradas
      .filter((e) => e?.evento && String(e.evento).trim())
      .map((e) => ({
        evento: this.corta(e.evento, 40) as string,
        path: this.corta(e.path, 200),
        loja: this.corta(e.loja, 80),
        sessionId: this.corta(e.sessionId, 64),
        valor: typeof e.valor === 'number' && Number.isFinite(e.valor) ? e.valor : null,
        dados: sanitizarDadosEvento(String(e.evento), e.dados),
        semAceite: e.semAceite === true,
        bot: e.bot === true,
        botNome: this.corta(e.botNome, 60),
      }));

    if (!linhas.length) return 0;

    try {
      const r = await (this.prisma as any).siteEvento.createMany({ data: linhas });
      return r.count;
    } catch (err) {
      this.logger.error(`falha ao gravar eventos do site: ${String(err)}`);
      return 0;
    }
  }

  /**
   * O LEAD DO WHATSAPP — quem clicou E mandou a mensagem carimbada.
   *
   * Quem chama é o n8n (Evolution → webhook → cá), não o site. Dedup de
   * rajada: a MESMA pessoa mandando de novo em menos de 1h não vira lead
   * novo — o WhatsApp reenvia webhook com facilidade e cada toque duplicado
   * inflaria a tela. Depois de 1h conta de novo de propósito: voltou outro
   * dia, é interesse novo.
   */
  async registrarLeadWhatsapp(entrada: {
    telefone?: string; nome?: string | null; loja?: string | null;
    mensagem?: string | null; instancia?: string | null;
  }): Promise<{ ok: boolean; duplicado?: boolean }> {
    const telefone = String(entrada?.telefone || '').replace(/\D/g, '').slice(0, 20);
    if (telefone.length < 10) return { ok: false };

    try {
      const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000);
      const recente = await (this.prisma as any).whatsappLead.findFirst({
        where: { telefone, criadoEm: { gte: umaHoraAtras } },
        select: { id: true },
      });
      if (recente) return { ok: true, duplicado: true };

      await (this.prisma as any).whatsappLead.create({
        data: {
          telefone,
          nome: this.corta(entrada.nome, 120),
          loja: this.corta(entrada.loja, 80),
          mensagem: this.corta(entrada.mensagem, 2000),
          instancia: this.corta(entrada.instancia, 60),
        },
      });
      return { ok: true };
    } catch (err) {
      this.logger.error(`falha ao gravar lead do whatsapp: ${String(err)}`);
      return { ok: false };
    }
  }

  /** A tela de leads: lista do período + contagem por loja. */
  async leadsWhatsapp(de: Date, ate: Date): Promise<{
    total: number;
    porLoja: Array<{ loja: string; leads: number }>;
    linhas: Array<{
      id: string; telefone: string; nome: string | null; loja: string | null;
      mensagem: string | null; instancia: string | null; criadoEm: Date;
    }>;
  }> {
    const janela = { gte: de, lte: ate };
    const linhas = await (this.prisma as any).whatsappLead.findMany({
      where: { criadoEm: janela },
      orderBy: { criadoEm: 'desc' },
      take: 500,
    });

    const porLojaMapa = new Map<string, number>();
    for (const l of linhas as Array<{ loja: string | null }>) {
      const chave = l.loja || 'Atendimento do site';
      porLojaMapa.set(chave, (porLojaMapa.get(chave) || 0) + 1);
    }

    return {
      total: linhas.length,
      porLoja: Array.from(porLojaMapa.entries())
        .map(([loja, leads]) => ({ loja, leads }))
        .sort((a, b) => b.leads - a.leads),
      linhas,
    };
  }

  /**
   * O FUNIL DE VENDA DO SITE (dono, 13/08: "preciso destes dados na tela de
   * cliques — add cart, initiate checkout, etc"). Do `site_eventos` — a cópia
   * de primeira parte, que conta todo mundo (com e sem aceite do banner).
   *
   * EVENTOS (toques) e PESSOAS (sessões distintas) por etapa. A coleta nasceu
   * em 13/08/2026 à tarde: período anterior vem zerado, e a tela avisa em vez
   * de deixar parecer que o site não vendia. `::int` nos COUNTs: BigInt na
   * resposta é 500 mudo de serialização.
   */
  /**
   * SESSÕES QUE ENTRARAM PELA PÁGINA DAS LOJAS — ficam FORA do funil.
   *
   * Decisão do dono (16/08): o anúncio que cai na `/lojas` vende visita à loja
   * física, não compra no site. Essa gente navega, às vezes olha peça, e sai
   * sem comprar; contá-la no denominador afunda a conversão do site com um
   * público que nunca teve intenção de comprar online. O que ELAS convertem é
   * contato com a loja, e isso tem quadro próprio (`trafegoDeLojas`).
   *
   * O corte é pela PÁGINA DE ENTRADA, não pelo UTM, de propósito: a atribuição
   * sobrevive 30 dias no navegador, então quem veio pelo anúncio hoje continua
   * carimbado se voltar semana que vem — e uma compra orgânica dela sumiria da
   * conta. Entrar pela `/lojas` é o que define a intenção DAQUELA visita; o UTM
   * (gravado desde 16/08) responde de qual anúncio ela veio.
   *
   * Ressalva conhecida: sessão iniciada ANTES da janela tem como "entrada" o
   * primeiro evento dentro dela. O erro é pequeno e sempre a favor de contar no
   * funil — nunca de esconder venda.
   *
   * ── ROBÔ FICA DE FORA DAQUI (16/08/2026) ──
   *
   * Esta é a lista que alimenta o quadro do tráfego de lojas, ou seja, a
   * medição do anúncio. É JUSTAMENTE onde a varredura mais mentia: naquela
   * manhã, 31 das 38 sessões da `/lojas` eram um `page_view` sozinho, sem
   * rolagem e sem segundo passo. Sem o corte, o anúncio parecia trazer 38
   * pessoas que não contatavam ninguém — e o número real de "chegaram" é o
   * denominador de "chegaram × contataram".
   *
   * Quem contatou a loja nunca cai fora: `whatsapp_click` e companhia não são
   * `page_view`, então a sessão passa na régua por definição.
   *
   * ── O ANÚNCIO DE LOJAS QUE CAI NA HOME (dono, 19/08/2026) ──
   *
   * O corte por página de entrada cobria o anúncio enquanto ele apontava pra
   * `/lojas`. Em 18/08 o dono apontou a campanha "Tráfego Home / Nossas Lojas"
   * pra HOME — e no dia seguinte ~700 sessões/dia desse público (metade das
   * visitas) entraram no funil do site: conversão 0,3% contra faixa de 1-2,5%,
   * e a /lojas "esvaziou". A intenção dessas pessoas não mudou, só a porta.
   *
   * Por isso o segundo ramo: sessão cuja ORIGEM (mesmo critério da cascata —
   * primeiro evento com `canal`) é uma campanha MARCADA como "anúncio de
   * lojas" ($6, lista que o dono mantém na tela) também é tráfego de lojas,
   * entre por onde entrar. Casa pelo nome gravado no UTM OU pelo nome que o
   * espelho do Meta dá ao `utm_id` — o rótulo que a tela mostra pode vir de
   * qualquer um dos dois, e marcar pelo rótulo tem que funcionar.
   *
   * A ressalva dos 30 dias (comentário acima) vale aqui: quem clicou no
   * anúncio de lojas e voltar direto em 5 dias continua carimbada e fica
   * neste quadro — inclusive se comprar (o quadro mostra "compraram" e o
   * valor; a venda não some, muda de quadro). É o mesmo last-click do Meta.
   */
  private static readonly SESSOES_DE_LOJA = `
    SELECT session_id FROM (
      SELECT session_id FROM (
        SELECT DISTINCT ON (session_id) session_id, path
          FROM site_eventos
         WHERE criado_em >= $1 AND criado_em <= $2
           AND session_id IS NOT NULL AND path IS NOT NULL AND NOT bot
         ORDER BY session_id, criado_em
      ) entrada
       WHERE (path ILIKE '/lojas%' OR path ILIKE '/nossaslojas%')
      UNION
      SELECT o.session_id FROM (
        SELECT DISTINCT ON (session_id) session_id,
               dados->>'campanha' AS campanha,
               dados->>'utm_id'   AS utm_id
          FROM site_eventos
         WHERE criado_em >= $1 AND criado_em <= $2
           AND session_id IS NOT NULL AND NOT bot
         ORDER BY session_id, (dados->>'canal') IS NULL, criado_em
      ) o
       LEFT JOIN (SELECT campanha_id, MAX(nome) AS nome
                    FROM (${SQL_NOMES_DE_CAMPANHA}) n GROUP BY campanha_id) g
              ON g.campanha_id = o.utm_id
       WHERE (o.campanha = ANY($6::text[]) OR g.nome = ANY($6::text[]))
    ) de_loja
     WHERE session_id IN (${SQL_SESSOES_DE_GENTE})`;

  async funil(
    de: Date,
    ate: Date,
    seg: Segmento = SEM_SEGMENTO,
    /** Anúncios marcados como "de lojas" — sessão deles sai do funil (ver `SESSOES_DE_LOJA`). */
    campanhasLojas: readonly string[] = [],
  ): Promise<Array<{ evento: string; eventos: number; pessoas: number; valor: number }>> {
    const linhas = await this.prisma.$queryRawUnsafe<
      Array<{ evento: string; eventos: number; pessoas: number; valor: number }>
    >(
      /**
       * MESMO CORTE DE ROBÔ DO CARD "AGORA NO SITE" — de propósito.
       *
       * As duas coisas vivem na MESMA tela: o card ao vivo em cima, VISITAS
       * logo abaixo. Filtrar só um lado faria a tela se contradizer sozinha
       * ("18 pessoas agora" embaixo de 379 visitas cheias de varredura) — e
       * divergência assim já custou caro em outra tela (a lista do CRM que
       * mostrava o cliente e a ficha que negava). Na prática o corte só mexe
       * no topo do funil: quem chegou no `add_to_cart` já provou que é gente.
       */
      `WITH gente AS (${SQL_SESSOES_DE_GENTE}),
            segmento AS (${SQL_SESSOES_DO_SEGMENTO}),
            lojas AS (${SiteMetricsService.SESSOES_DE_LOJA})
       SELECT evento,
              COUNT(*)::int                   AS eventos,
              COUNT(DISTINCT session_id)::int AS pessoas,
              COALESCE(SUM(valor), 0)::float  AS valor
         FROM site_eventos e
        WHERE criado_em >= $1 AND criado_em <= $2 AND NOT bot
          AND evento IN ('page_view','view_item','add_to_cart','begin_checkout','add_payment_info','purchase')
          -- Sessão sem id não dá pra classificar: fica no funil. Perder dado é
          -- pior que carregar um punhado de anônimos no denominador.
          AND (e.session_id IS NULL
               OR (e.session_id IN (SELECT session_id FROM gente)
                   AND e.session_id IN (SELECT session_id FROM segmento)
                   AND e.session_id NOT IN (SELECT session_id FROM lojas)))
        GROUP BY evento`,
      ...argsLojas(de, ate, seg, campanhasLojas),
    );
    return linhas.map((l) => ({
      evento: l.evento,
      eventos: Number(l.eventos),
      pessoas: Number(l.pessoas),
      // VALOR DE CONVERSÃO (dono, 15/08). Só interessa em `purchase` — é o R$
      // somado das compras do período (`valor` do evento = total do pedido). As
      // outras etapas somam o preço da peça vista/na sacola e a tela ignora.
      valor: Number(l.valor) || 0,
    }));
  }

  /** Jornada real: uma sessão ocupa somente a etapa mais avançada que alcançou. */
  async jornadaCompra(
    de: Date,
    ate: Date,
    seg: Segmento = SEM_SEGMENTO,
    campanhasLojas: readonly string[] = [],
  ): Promise<{
    jornada: LinhaJornada[];
    problemas: Array<{
      evento: string; codigo: string; campo: string | null;
      pessoas: number; ocorrencias: number; recuperadas: number;
    }>;
    interacoes: Array<{
      evento: string; codigo: string; campo: string | null; pessoas: number; interacoes: number;
    }>;
    resumo: {
      maiorPerda: LinhaJornada | null;
      sessoesComProblema: number;
      sessoesRecuperadas: number;
      pixPendente: number;
      amostraPequena: boolean;
    };
  }> {
    const [maximos, problemasRaw, interacoesRaw, totais] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ etapa_maxima: number; pessoas: number }>>(
        `WITH gente AS (${SQL_SESSOES_DE_GENTE}),
              segmento AS (${SQL_SESSOES_DO_SEGMENTO}),
              lojas AS (${SiteMetricsService.SESSOES_DE_LOJA}),
              sessoes AS (
                SELECT e.session_id,
                       MAX(CASE e.evento
                         WHEN 'page_view' THEN 0 WHEN 'view_item' THEN 1
                         WHEN 'add_to_cart' THEN 2 WHEN 'begin_checkout' THEN 3
                         WHEN 'add_payment_info' THEN 4 WHEN 'purchase' THEN 5
                       END)::int AS etapa_maxima
                  FROM site_eventos e
                 WHERE e.criado_em >= $1 AND e.criado_em <= $2
                   AND e.session_id IS NOT NULL
                   AND e.evento IN ('page_view','view_item','add_to_cart','begin_checkout','add_payment_info','purchase')
                   AND ${soGenteDoSegmento('e')}
                   AND e.session_id NOT IN (SELECT session_id FROM lojas)
                 GROUP BY e.session_id
              )
         SELECT etapa_maxima, COUNT(*)::int AS pessoas
           FROM sessoes GROUP BY etapa_maxima ORDER BY etapa_maxima`,
        ...argsLojas(de, ate, seg, campanhasLojas),
      ),
      this.prisma.$queryRawUnsafe<Array<{
        evento: string; codigo: string; campo: string | null;
        pessoas: number; ocorrencias: number; recuperadas: number;
      }>>(
        `WITH gente AS (${SQL_SESSOES_DE_GENTE}),
              segmento AS (${SQL_SESSOES_DO_SEGMENTO}),
              lojas AS (${SiteMetricsService.SESSOES_DE_LOJA}),
              falhas AS (
                SELECT e.*,
                       COALESCE(e.dados->>'reason', e.dados->>'method', e.dados->>'section', 'sem_codigo') AS codigo,
                       /* A CAUSA EXATA quando não há campo (22/08): o código
                          catalog_unavailable cobre SETE recusas do guard e a
                          tela mostrava as sete numa linha só. O motivo entra
                          na MESMA coluna do field — os dois respondem "o que
                          exatamente reprovou", um nível abaixo do código, e
                          nunca vêm juntos no mesmo evento. A REF vai colada,
                          que é o que deixa ir direto na peça.
                          Sem crase aqui dentro: este SQL mora num template
                          literal e a crase fecharia a string (quebrou o build
                          em 22/08). */
                       CASE
                         WHEN e.dados ? 'field' THEN e.dados->>'field'
                         WHEN e.dados ? 'motivo' THEN
                           e.dados->>'motivo' ||
                           COALESCE(' · ' || NULLIF(e.dados->>'ref', ''), '')
                         ELSE NULL
                       END AS campo,
                       CASE e.evento
                         WHEN 'add_to_cart_blocked' THEN 1
                         WHEN 'checkout_validation_error' THEN 3
                         WHEN 'checkout_error' THEN 3
                         ELSE 4
                       END AS etapa_falha
                  FROM site_eventos e
                 WHERE e.criado_em >= $1 AND e.criado_em <= $2
                   AND e.session_id IS NOT NULL
                   AND e.evento IN ('add_to_cart_blocked','checkout_validation_error','checkout_error',
                                    'card_declined','pix_expired','payment_retry')
                   AND (e.evento <> 'payment_retry' OR (
                     SELECT COUNT(*) FROM site_eventos repeticao
                      WHERE repeticao.session_id = e.session_id
                        AND repeticao.evento = 'payment_retry'
                        AND repeticao.criado_em >= $1 AND repeticao.criado_em <= $2
                   ) >= 2)
                   AND ${soGenteDoSegmento('e')}
                   AND e.session_id NOT IN (SELECT session_id FROM lojas)
              ), agrupadas AS (
                SELECT evento, codigo, campo, session_id,
                       COUNT(*)::int AS ocorrencias,
                       MAX(criado_em) AS ultima_falha,
                       MAX(etapa_falha) AS etapa_falha
                  FROM falhas
                 GROUP BY evento, codigo, campo, session_id
              )
         SELECT f.evento, f.codigo, f.campo,
                COUNT(*)::int AS pessoas,
                SUM(f.ocorrencias)::int AS ocorrencias,
                COUNT(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM site_eventos r
                   WHERE r.session_id = f.session_id AND r.criado_em > f.ultima_falha
                     AND r.criado_em <= $2
                     AND (r.evento IN ('checkout_recovered','purchase') OR
                          CASE r.evento
                            WHEN 'view_item' THEN 1 WHEN 'add_to_cart' THEN 2
                            WHEN 'begin_checkout' THEN 3 WHEN 'add_payment_info' THEN 4
                            WHEN 'purchase' THEN 5 ELSE -1
                          END > f.etapa_falha)
                ))::int AS recuperadas
           FROM agrupadas f
          GROUP BY f.evento, f.codigo, f.campo
          ORDER BY pessoas DESC, ocorrencias DESC
          LIMIT 100`,
        ...argsLojas(de, ate, seg, campanhasLojas),
      ),
      this.prisma.$queryRawUnsafe<Array<{
        evento: string; codigo: string; campo: string | null; pessoas: number; interacoes: number;
      }>>(
        `WITH gente AS (${SQL_SESSOES_DE_GENTE}),
              segmento AS (${SQL_SESSOES_DO_SEGMENTO}),
              lojas AS (${SiteMetricsService.SESSOES_DE_LOJA})
         SELECT e.evento,
                COALESCE(e.dados->>'method', e.dados->>'shipping_tier',
                         e.dados->>'color', e.dados->>'size', 'sem_codigo') AS codigo,
                NULL::text AS campo,
                COUNT(DISTINCT e.session_id)::int AS pessoas,
                COUNT(*)::int AS interacoes
           FROM site_eventos e
          WHERE e.criado_em >= $1 AND e.criado_em <= $2
            AND e.session_id IS NOT NULL
            AND e.evento IN ('color_switch','size_switch','add_shipping_info',
                             'payment_method_selected','pix_copied')
            AND ${soGenteDoSegmento('e')}
            AND e.session_id NOT IN (SELECT session_id FROM lojas)
          GROUP BY e.evento, codigo
          ORDER BY interacoes DESC, e.evento, codigo
          LIMIT 100`,
        ...argsLojas(de, ate, seg, campanhasLojas),
      ),
      this.prisma.$queryRawUnsafe<Array<{
        sessoes_problema: number; sessoes_recuperadas: number; pix_pendente: number;
      }>>(
        `WITH gente AS (${SQL_SESSOES_DE_GENTE}),
              segmento AS (${SQL_SESSOES_DO_SEGMENTO}),
              lojas AS (${SiteMetricsService.SESSOES_DE_LOJA}),
              falhas AS (
                SELECT evento, session_id, criado_em,
                       CASE evento
                         WHEN 'add_to_cart_blocked' THEN 1
                         WHEN 'checkout_validation_error' THEN 3
                         WHEN 'checkout_error' THEN 3
                         ELSE 4
                       END AS etapa_falha
                  FROM site_eventos e
                 WHERE criado_em >= $1 AND criado_em <= $2 AND session_id IS NOT NULL
                   AND evento IN ('add_to_cart_blocked','checkout_validation_error','checkout_error',
                                  'card_declined','pix_expired','payment_retry')
                   AND (evento <> 'payment_retry' OR (
                     SELECT COUNT(*) FROM site_eventos repeticao
                      WHERE repeticao.session_id = e.session_id
                        AND repeticao.evento = 'payment_retry'
                        AND repeticao.criado_em >= $1 AND repeticao.criado_em <= $2
                   ) >= 2)
                   AND ${soGenteDoSegmento('e')}
                   AND session_id NOT IN (SELECT session_id FROM lojas)
              ),
              falhas_sessao AS (
                SELECT session_id, MAX(criado_em) AS ultima_falha, MAX(etapa_falha) AS etapa_falha
                  FROM falhas GROUP BY session_id
              ),
              recuperadas AS (
                SELECT f.session_id FROM falhas_sessao f
                 WHERE EXISTS (
                   SELECT 1 FROM site_eventos r
                    WHERE r.session_id = f.session_id AND r.criado_em > f.ultima_falha
                      AND r.criado_em <= $2
                      AND (r.evento IN ('checkout_recovered','purchase') OR
                           CASE r.evento
                             WHEN 'view_item' THEN 1 WHEN 'add_to_cart' THEN 2
                             WHEN 'begin_checkout' THEN 3 WHEN 'add_payment_info' THEN 4
                             WHEN 'purchase' THEN 5 ELSE -1
                           END > f.etapa_falha)
                 )
              ),
              pix AS (
                SELECT DISTINCT p.session_id FROM site_eventos p
                 WHERE p.criado_em >= $1 AND p.criado_em <= $2 AND p.evento = 'pix_created'
                   AND p.session_id IS NOT NULL AND ${soGenteDoSegmento('p')}
                   AND p.session_id NOT IN (SELECT session_id FROM lojas)
                   AND NOT EXISTS (
                     SELECT 1 FROM site_eventos c WHERE c.session_id = p.session_id
                       AND c.evento = 'purchase' AND c.criado_em >= p.criado_em AND c.criado_em <= $2
                   )
              )
         SELECT (SELECT COUNT(DISTINCT session_id) FROM falhas)::int AS sessoes_problema,
                (SELECT COUNT(*) FROM recuperadas)::int AS sessoes_recuperadas,
                (SELECT COUNT(*) FROM pix)::int AS pix_pendente`,
        ...argsLojas(de, ate, seg, campanhasLojas),
      ),
    ]);

    const jornada = montarJornada(maximos.map((linha) => ({
      etapaMaxima: Number(linha.etapa_maxima),
      pessoas: Number(linha.pessoas),
    })));
    const candidatas = jornada.filter((linha) => linha.taxaPerda !== null && linha.chegaram > 0);
    const maiorPerda = candidatas.reduce<LinhaJornada | null>(
      (maior, linha) => !maior || (linha.taxaPerda ?? 0) > (maior.taxaPerda ?? 0) ? linha : maior,
      null,
    );
    const total = totais[0];

    return {
      jornada,
      problemas: problemasRaw.map((linha) => ({
        ...linha,
        pessoas: Number(linha.pessoas),
        ocorrencias: Number(linha.ocorrencias),
        recuperadas: Number(linha.recuperadas),
      })),
      interacoes: interacoesRaw.map((linha) => ({
        ...linha,
        pessoas: Number(linha.pessoas),
        interacoes: Number(linha.interacoes),
      })),
      resumo: {
        maiorPerda,
        sessoesComProblema: Number(total?.sessoes_problema ?? 0),
        sessoesRecuperadas: Number(total?.sessoes_recuperadas ?? 0),
        pixPendente: Number(total?.pix_pendente ?? 0),
        amostraPequena: (maiorPerda?.chegaram ?? 0) < 20,
      },
    };
  }

  /**
   * O MAPA DO TRÁFEGO DE LOJAS (dono, 16/08: "crie um mapa disso mostrando que
   * tipo de conversão este tráfego nos trás").
   *
   * Estas pessoas saíram do funil de e-commerce — mas sair do funil não é
   * sumir. A conversão delas é OUTRA: falar com a loja. Aqui a conta é
   * "chegaram × contataram", com a unidade que recebeu o contato, a campanha
   * que trouxe e o que elas fizeram no site apesar de tudo (parte compra, e
   * isso precisa aparecer em algum lugar).
   */
  async trafegoDeLojas(
    de: Date,
    ate: Date,
    seg: Segmento = SEM_SEGMENTO,
    campanhasLojas: readonly string[] = [],
  ): Promise<{
    pessoas: number;
    contataram: number;
    contatos: { whatsapp: number; comoChegar: number; telefone: number; instagram: number };
    navegaram: { viramPeca: number; sacola: number; checkout: number; compraram: number };
    valorComprado: number;
    porUnidade: Array<{ loja: string; contatos: number }>;
    porCampanha: Array<{ campanha: string; canal: string | null; pessoas: number }>;
  }> {
    const CONTATO = `('whatsapp_click','store_locator','phone_click','instagram_click')`;

    const [tot] = await this.prisma.$queryRawUnsafe<Array<Record<string, any>>>(
      `WITH segmento AS (${SQL_SESSOES_DO_SEGMENTO}),
            lojas AS (${SiteMetricsService.SESSOES_DE_LOJA})
       SELECT COUNT(DISTINCT l.session_id)::int AS pessoas,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.evento IN ${CONTATO})::int AS contataram,
              COUNT(*) FILTER (WHERE e.evento='whatsapp_click')::int  AS whatsapp,
              COUNT(*) FILTER (WHERE e.evento='store_locator')::int   AS como_chegar,
              COUNT(*) FILTER (WHERE e.evento='phone_click')::int     AS telefone,
              COUNT(*) FILTER (WHERE e.evento='instagram_click')::int AS instagram,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.evento='view_item')::int      AS viram_peca,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.evento='add_to_cart')::int    AS sacola,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.evento='begin_checkout')::int AS checkout,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.evento='purchase')::int       AS compraram,
              COALESCE(SUM(e.valor) FILTER (WHERE e.evento='purchase'), 0)::float        AS valor
         FROM lojas l
         JOIN segmento sg ON sg.session_id = l.session_id
         LEFT JOIN site_eventos e
                ON e.session_id = l.session_id AND e.criado_em >= $1 AND e.criado_em <= $2`,
      ...argsLojas(de, ate, seg, campanhasLojas),
    );

    const porUnidade = await this.prisma.$queryRawUnsafe<Array<{ loja: string; contatos: number }>>(
      `WITH segmento AS (${SQL_SESSOES_DO_SEGMENTO}),
            lojas AS (${SiteMetricsService.SESSOES_DE_LOJA})
       SELECT COALESCE(e.loja, 'sem unidade') AS loja, COUNT(*)::int AS contatos
         FROM site_eventos e JOIN lojas l ON l.session_id = e.session_id
        WHERE e.criado_em >= $1 AND e.criado_em <= $2 AND e.evento IN ${CONTATO}
          AND ${doSegmento('e')}
        GROUP BY 1 ORDER BY contatos DESC LIMIT 20`,
      ...argsLojas(de, ate, seg, campanhasLojas),
    );

    // A campanha vem do UTM gravado desde 16/08 (`dados->>'campanha'`). Sessão
    // anterior a isso — ou visita orgânica — cai em "sem campanha", e isso é
    // informação: mostra quanto do tráfego da /lojas não é do anúncio.
    const porCampanha = await this.prisma.$queryRawUnsafe<
      Array<{
        campanha: string; canal: string | null; utm_id: string | null;
        pessoas: number; contataram: number; gasto: number | null;
      }>
    >(
      `WITH segmento AS (${SQL_SESSOES_DO_SEGMENTO}),
            lojas AS (${SiteMetricsService.SESSOES_DE_LOJA}),
            marca AS (
              SELECT DISTINCT ON (e.session_id) e.session_id,
                     COALESCE(e.dados->>'campanha', 'sem campanha') AS campanha,
                     e.dados->>'canal' AS canal,
                     -- O ID da campanha é o que casa com o espelho de gasto. O
                     -- NOME não serve: é renomeado no Gerenciador e chega com
                     -- codificação dupla (a mesma pegadinha da tela de ROAS).
                     e.dados->>'utm_id' AS utm_id
                FROM site_eventos e JOIN lojas l ON l.session_id = e.session_id
               WHERE e.criado_em >= $1 AND e.criado_em <= $2
                 AND ${doSegmento('e')}
               ORDER BY e.session_id, (e.dados->>'campanha') IS NULL, e.criado_em
            ),
            -- Quem FALOU com a loja, por sessão. Sem isto a tabela responde
            -- "quantas vieram" e não "quantas serviram pra alguma coisa" — e é
            -- a segunda pergunta que decide se o anúncio continua no ar.
            contatou AS (
              SELECT DISTINCT e.session_id
                FROM site_eventos e JOIN lojas l ON l.session_id = e.session_id
               WHERE e.criado_em >= $1 AND e.criado_em <= $2
                 AND e.evento IN ${CONTATO}
                 AND ${doSegmento('e')}
            ),
            agg AS (
              SELECT m.campanha, m.canal,
                     MAX(m.utm_id) AS utm_id,
                     COUNT(*)::int AS pessoas,
                     COUNT(*) FILTER (WHERE c.session_id IS NOT NULL)::int AS contataram
                FROM marca m
                LEFT JOIN contatou c ON c.session_id = m.session_id
               GROUP BY 1, 2
            ),
            -- Gasto do PERÍODO por campanha. Vem de TODAS as contas do espelho
            -- (inclusive as de loja, que entraram em 26/08/2026): aqui é o
            -- lugar certo desse dinheiro — ver common/contas-de-anuncio.ts.
            -- Os DOIS espelhos: Google traz loja também (o Pmax Local sozinho
            -- fez 45 pessoas em 20→26/08). Ler só o Meta deixaria metade da
            -- tabela com custo em branco parecendo tráfego de graça.
            custo AS (
              SELECT campanha_id, SUM(gasto)::numeric AS gasto FROM (
                SELECT campanha_id, gasto FROM meta_ads_gasto_dia
                 WHERE dia >= $1::date AND dia <= $2::date
                UNION ALL
                SELECT campanha_id, gasto FROM google_ads_gasto_dia
                 WHERE dia >= $1::date AND dia <= $2::date
              ) t GROUP BY campanha_id
            )
       SELECT a.campanha, a.canal, a.utm_id, a.pessoas, a.contataram,
              -- NULL de propósito quando o espelho não conhece a campanha:
              -- ausência não é zero, e escrever "R$ 0,00" num anúncio que
              -- custou dinheiro é pior que admitir que não se sabe.
              cu.gasto::float AS gasto
         FROM agg a
         LEFT JOIN custo cu ON cu.campanha_id = a.utm_id
        ORDER BY a.pessoas DESC LIMIT 12`,
      ...argsLojas(de, ate, seg, campanhasLojas),
    );

    return {
      pessoas: Number(tot?.pessoas ?? 0),
      contataram: Number(tot?.contataram ?? 0),
      contatos: {
        whatsapp: Number(tot?.whatsapp ?? 0),
        comoChegar: Number(tot?.como_chegar ?? 0),
        telefone: Number(tot?.telefone ?? 0),
        instagram: Number(tot?.instagram ?? 0),
      },
      navegaram: {
        viramPeca: Number(tot?.viram_peca ?? 0),
        sacola: Number(tot?.sacola ?? 0),
        checkout: Number(tot?.checkout ?? 0),
        compraram: Number(tot?.compraram ?? 0),
      },
      valorComprado: Number(tot?.valor ?? 0),
      porUnidade: porUnidade.map((u) => ({ loja: u.loja, contatos: Number(u.contatos) })),
      porCampanha: porCampanha.map((c) => ({
        campanha: c.campanha,
        canal: c.canal,
        utmId: c.utm_id,
        pessoas: Number(c.pessoas),
        contataram: Number(c.contataram),
        // `null` = o espelho não conhece essa campanha (orgânico, campanha de
        // conta não coletada, sessão sem utm_id). Não vira 0.
        gasto: c.gasto == null ? null : Number(c.gasto),
      })),
    };
  }

  /**
   * O QUE EXISTE PRA FILTRAR no período — alimenta a cascata da tela.
   *
   * Uma linha por combinação (tráfego, plataforma, campanha) com o tamanho de
   * cada uma. Os TRÊS níveis saem daqui e a tela monta a cascata em cima
   * disto: o nível 1 agrupa por tráfego, o 2 por plataforma, o 3 é a campanha.
   *
   * Uma query só, de propósito. Três endpoints encadeados dariam três estados
   * de carregamento e a chance de a lista de campanhas discordar da lista de
   * plataformas — e esta tela já teve o bastante de dois números brigando.
   *
   * Conta só gente: opção que só existe por causa de robô não é opção. E não
   * recebe segmento — este método é justamente quem descobre quais existem.
   */
  async segmentosDisponiveis(de: Date, ate: Date): Promise<Array<{
    trafego: Trafego;
    plataforma: string | null;
    campanha: string | null;
    /** `campaign.id` (Meta ou Google) — a chave que casa gasto e receita. */
    utmId: string | null;
    pessoas: number;
    gasto: number;
    receita: number;
    pedidos: number;
    /**
     * O QUE A PLATAFORMA DIZ que converteu, quando ela diz. `null` = não
     * coletamos essa métrica dela (hoje: Meta) — e null NÃO é zero. Só o
     * espelho do Google traz isto, porque é lá que a nossa receita ainda não
     * casa e o número dele é a única resposta que existe.
     */
    convPlataforma: number | null;
    valorPlataforma: number | null;
    /** De qual espelho veio o gasto: `meta` | `google` | null (não temos). */
    fonteGasto: string | null;
  }>> {
    const linhas = await this.prisma.$queryRawUnsafe<Array<{
      trafego: Trafego; plataforma: string | null; campanha: string | null;
      utm_id: string | null; pessoas: number; gasto: number; receita: number; pedidos: number;
      conv_plataforma: number | null; valor_plataforma: number | null; fonte_gasto: string | null;
    }>>(
      /**
       * O DINHEIRO ENTRA AQUI JUNTO COM AS PESSOAS.
       *
       * `gasto` vem dos espelhos de anúncio (Meta E Google, unidos abaixo) e
       * `receita` vem de `orders` — pedido PAGO, não evento rastreado. As duas
       * casam pelo **id** da campanha (`utm_id` = `campaign.id`), nunca pelo
       * nome: nome é renomeado no Gerenciador, chega codificado duas vezes na
       * URL e às vezes vem como número. E o rótulo passa a sair do
       * `campanha_nome` da API, então UTM mal etiquetado deixa de sujar a tela.
       *
       * Receita por PEDIDO e não por evento `purchase` de propósito: ROAS é
       * sobre dinheiro que entrou no caixa. O evento serve pro funil.
       *
       * ── O DINHEIRO CONTA UMA VEZ SÓ (corrigido em 22/08/2026) ──
       *
       * `sessoes` agrupa por (tráfego, plataforma, campanha, utm_id), e o
       * MESMO `utm_id` cai em mais de uma dessas linhas sempre que o UTM chega
       * escrito de dois jeitos. Com o LEFT JOIN puro, cada uma dessas linhas
       * recebia a receita INTEIRA da campanha — e a cascata somava tudo de
       * novo por cima. Foi o que fez o mesmo R$ 210 aparecer em "Google" e em
       * "Google_Shopping_Novidades_Petter" no mesmo dia, inflando o total.
       *
       * Agora o dinheiro entra só na linha de POSTO 1 daquele `utm_id` — a de
       * mais gente. As irmãs continuam aparecendo com as pessoas delas e
       * dinheiro zero, o total fecha, e o número não é inventado nem dividido
       * por um critério que ninguém conseguiria explicar depois.
       */
      `WITH gente AS (${SQL_SESSOES_DE_GENTE}),
            origem AS (
              SELECT DISTINCT ON (e.session_id) e.session_id,
                     e.dados->>'campanha'   AS campanha,
                     e.dados->>'canal'      AS canal,
                     e.dados->>'plataforma' AS plataforma,
                     e.dados->>'utm_id'     AS utm_id,
                     COALESCE(e.dados->>'pago', 'false') = 'true' AS pago
                FROM site_eventos e
               WHERE e.criado_em >= $1 AND e.criado_em <= $2
                 AND e.session_id IS NOT NULL AND NOT e.bot
                 AND e.session_id IN (SELECT session_id FROM gente)
               ORDER BY e.session_id, (e.dados->>'canal') IS NULL, e.criado_em
            ),
            sessoes AS (
              SELECT CASE WHEN pago THEN 'pago'
                          WHEN canal IS NOT NULL THEN 'organico'
                          ELSE 'direto' END      AS trafego,
                     (${SQL_PLATAFORMA})         AS plataforma,
                     campanha,
                     utm_id,
                     COUNT(*)::int               AS pessoas
                FROM origem
               GROUP BY 1, 2, 3, 4
            ),
            ranqueadas AS (
              -- O desempate aqui tem que ser o MESMO da ordenação final lá
              -- embaixo, senão o LIMIT 200 pode cortar justamente a linha de
              -- posto 1 e deixar na tela só as irmãs — que carregam zero. O
              -- dinheiro da campanha sumiria sem nada indicar que sumiu.
              SELECT s.*,
                     ROW_NUMBER() OVER (PARTITION BY s.utm_id
                                        ORDER BY s.pessoas DESC, s.trafego,
                                                 s.plataforma, s.campanha) AS posto
                FROM sessoes s
            ),
            anuncio AS (
              -- ⚠️ A JANELA É EM BRASÍLIA, NÃO EM UTC.
              --
              -- $2 chega como 23:59:59.999 de São Paulo, que é 02:59:59.999Z
              -- do dia SEGUINTE. $2::date truncava isso e devolvia amanhã —
              -- então "Ontem" somava o gasto de HOJE (os crons já gravaram a
              -- linha do dia quando o relatório roda). Gasto inflado + receita
              -- certa = ROAS menor do que é, justamente na tela que decide
              -- onde pôr dinheiro. A coluna dia do espelho já está no fuso
              -- da conta; quem precisava converter era o parâmetro.
              SELECT campanha_id, campanha_nome, gasto, 'meta'::text AS fonte,
                     NULL::numeric AS conversoes, NULL::numeric AS valor_conv
                FROM meta_ads_gasto_dia
               WHERE dia >= ${diaBrasiliaSql('$1')} AND dia <= ${diaBrasiliaSql('$2')}
               UNION ALL
              SELECT campanha_id, campanha_nome, gasto, 'google'::text AS fonte,
                     conversoes, valor_conversoes
                FROM google_ads_gasto_dia
               WHERE dia >= ${diaBrasiliaSql('$1')} AND dia <= ${diaBrasiliaSql('$2')}
            ),
            gasto AS (
              SELECT campanha_id,
                     MAX(campanha_nome)      AS nome,
                     -- De QUEM é este número. A tela precisa escrever "o
                     -- Google conta X conversões" com o nome certo; "a
                     -- plataforma diz" não dá pra conferir em lugar nenhum.
                     MAX(fonte)              AS fonte,
                     SUM(gasto)::float       AS gasto,
                     -- SUM de coluna toda NULL devolve NULL, e é isso que
                     -- separa "o Meta não reporta conversão pra gente" de "o
                     -- Google reportou zero conversão". Ausência ≠ zero.
                     SUM(conversoes)::float  AS conversoes,
                     SUM(valor_conv)::float  AS valor_conv
                FROM anuncio
               GROUP BY campanha_id
            ),
            receita AS (
              SELECT utm_id,
                     SUM(total_amount)::float AS receita,
                     COUNT(*)::int            AS pedidos
                FROM orders
               WHERE source = 'ecommerce'
                 AND status IN ('paid','separating','shipped','delivered','completed')
                 AND created_at >= $1 AND created_at <= $2
                 AND utm_id IS NOT NULL
               GROUP BY utm_id
            )
       SELECT s.trafego,
              s.plataforma,
              -- O NOME vem sempre do espelho quando existe, inclusive nas
              -- linhas de posto 2+: rótulo certo não é dinheiro, pode repetir.
              COALESCE(g.nome, s.campanha)  AS campanha,
              s.utm_id,
              s.pessoas,
              CASE WHEN s.posto = 1 THEN COALESCE(g.gasto, 0)   ELSE 0 END::float AS gasto,
              CASE WHEN s.posto = 1 THEN COALESCE(r.receita, 0) ELSE 0 END::float AS receita,
              CASE WHEN s.posto = 1 THEN COALESCE(r.pedidos, 0) ELSE 0 END::int   AS pedidos,
              (CASE WHEN s.posto = 1 THEN g.conversoes END)::float AS conv_plataforma,
              (CASE WHEN s.posto = 1 THEN g.valor_conv END)::float AS valor_plataforma,
              g.fonte                       AS fonte_gasto
         FROM ranqueadas s
         LEFT JOIN gasto   g ON g.campanha_id = s.utm_id
         LEFT JOIN receita r ON r.utm_id      = s.utm_id
        -- s.posto no fim garante que a linha que carrega o dinheiro nunca
        -- fique atrás de uma irmã do mesmo utm_id: o corte do LIMIT só leva o
        -- posto 1 junto com o grupo inteiro, nunca sozinho.
        ORDER BY s.pessoas DESC, 1, 2, 3, s.utm_id, s.posto
        LIMIT 200`,
      de,
      ate,
    );
    return linhas.map((l) => ({
      trafego: l.trafego,
      plataforma: l.plataforma,
      campanha: l.campanha,
      utmId: l.utm_id,
      pessoas: Number(l.pessoas),
      gasto: Number(l.gasto) || 0,
      receita: Number(l.receita) || 0,
      pedidos: Number(l.pedidos) || 0,
      // `?? null` e não `|| 0`: zero conversão é uma afirmação do Google,
      // ausência é a plataforma que não reporta. A tela trata as duas
      // diferente e só consegue porque o null chega inteiro até ela.
      convPlataforma: l.conv_plataforma == null ? null : Number(l.conv_plataforma),
      valorPlataforma: l.valor_plataforma == null ? null : Number(l.valor_plataforma),
      fonteGasto: l.fonte_gasto ?? null,
    }));
  }

  /**
   * FATURAMENTO REAL DO SITE no período (dono, 15/08) — a Fonte B, ao lado do
   * valor de conversão do funil (Fonte A). O funil soma o EVENTO `purchase`
   * (sessionizado, com/sem cookie) e casa com a coluna Compras; isto soma o
   * DINHEIRO: pedidos `source='ecommerce'` já pagos. As duas divergem quando um
   * PIX é pago noutro dia ou o evento do navegador não dispara — por isso ficam
   * em linhas separadas, cada uma com seu significado. Janela por `created_at`,
   * a mesma do funil (um PIX pago depois conta retroativo no dia do pedido).
   */
  async faturamentoSite(de: Date, ate: Date): Promise<{ pedidos: number; valor: number }> {
    const r = await this.prisma.$queryRawUnsafe<Array<{ pedidos: number; valor: number }>>(
      `SELECT COUNT(*)::int AS pedidos, COALESCE(SUM(total_amount), 0)::float AS valor
         FROM orders
        WHERE source = 'ecommerce'
          AND status IN ('paid','separating','shipped','delivered','completed')
          AND created_at >= $1 AND created_at <= $2`,
      de,
      ate,
    );
    return { pedidos: Number(r[0]?.pedidos ?? 0), valor: Number(r[0]?.valor ?? 0) };
  }

  async diagnosticosFunil(de: Date, ate: Date, seg: Segmento = SEM_SEGMENTO): Promise<Array<{
    evento: string; codigo: string; campo: string | null; pessoas: number; eventos: number;
  }>> {
    const linhas = await this.prisma.$queryRawUnsafe<Array<{
      evento: string; codigo: string; campo: string | null; pessoas: number; eventos: number;
    }>>(
      `WITH gente AS (${SQL_SESSOES_DE_GENTE}),
            segmento AS (${SQL_SESSOES_DO_SEGMENTO})
       SELECT e.evento,
              COALESCE(e.dados->>'reason', e.dados->>'method', e.dados->>'payment_type', e.dados->>'section',
                       e.dados->>'shipping_tier', e.dados->>'color', e.dados->>'size', 'sem_codigo') AS codigo,
              CASE WHEN e.dados ? 'field' THEN e.dados->>'field' ELSE NULL END AS campo,
              COUNT(DISTINCT e.session_id)::int AS pessoas,
              COUNT(*)::int AS eventos
         FROM site_eventos e
        WHERE e.criado_em >= $1 AND e.criado_em <= $2
          AND e.session_id IS NOT NULL
          AND e.evento IN ('color_switch','size_switch','add_to_cart_blocked',
                         'add_shipping_info','add_payment_info','checkout_submission',
                         'checkout_error','checkout_validation_error','pix_created',
                         'payment_method_selected','pix_copied','pix_expired',
                         'card_declined','payment_retry','checkout_recovered')
          AND ${soGenteDoSegmento('e')}
        GROUP BY e.evento, codigo, campo
        ORDER BY eventos DESC, e.evento, codigo
        LIMIT 100`,
      ...args(de, ate, seg),
    );
    return linhas.map((l) => ({
      evento: l.evento,
      codigo: l.codigo,
      campo: l.campo,
      pessoas: Number(l.pessoas),
      eventos: Number(l.eventos),
    }));
  }

  /** Sessões que tiveram pelo menos duas falhas num intervalo móvel de 10 min. */
  async alertasCheckout(de: Date, ate: Date, seg: Segmento = SEM_SEGMENTO): Promise<Array<{
    sessionId: string; etapa: string; pagamento: string; codigo: string;
    pedido: string | null; tentativas: number; primeiraFalha: Date; ultimaFalha: Date;
  }>> {
    const linhas = await this.prisma.$queryRawUnsafe<Array<{
      session_id: string; etapa: string; pagamento: string; codigo: string;
      pedido: string | null; tentativas: number; primeira_falha: Date; ultima_falha: Date;
    }>>(
      `WITH gente AS (${SQL_SESSOES_DE_GENTE}),
            segmento AS (${SQL_SESSOES_DO_SEGMENTO}),
            erros AS (
         SELECT e.session_id, e.criado_em, e.dados
           FROM site_eventos e
          WHERE e.criado_em >= $1 AND e.criado_em <= $2
            AND e.evento = 'checkout_error' AND e.session_id IS NOT NULL
            AND ${soGenteDoSegmento('e')}
       ), sessoes_alerta AS (
         SELECT DISTINCT a.session_id
           FROM erros a
           JOIN erros b ON b.session_id = a.session_id
                        AND b.criado_em > a.criado_em
                        AND b.criado_em <= a.criado_em + INTERVAL '10 minutes'
       )
       SELECT e.session_id,
              COALESCE((ARRAY_AGG(e.dados->>'stage' ORDER BY e.criado_em DESC))[1], 'submission') AS etapa,
              COALESCE((ARRAY_AGG(e.dados->>'method' ORDER BY e.criado_em DESC))[1], 'desconhecido') AS pagamento,
              COALESCE((ARRAY_AGG(e.dados->>'reason' ORDER BY e.criado_em DESC))[1], 'sem_codigo') AS codigo,
              (ARRAY_AGG(e.dados->>'order_id' ORDER BY e.criado_em DESC))[1] AS pedido,
              COUNT(*)::int AS tentativas,
              MIN(e.criado_em) AS primeira_falha,
              MAX(e.criado_em) AS ultima_falha
         FROM erros e
         JOIN sessoes_alerta s ON s.session_id = e.session_id
        GROUP BY e.session_id
        ORDER BY ultima_falha DESC
        LIMIT 100`,
      ...args(de, ate, seg),
    );
    return linhas.map((l) => ({
      sessionId: l.session_id,
      etapa: l.etapa,
      pagamento: l.pagamento,
      codigo: l.codigo,
      pedido: l.pedido,
      tentativas: Number(l.tentativas),
      primeiraFalha: l.primeira_falha,
      ultimaFalha: l.ultima_falha,
    }));
  }

  /**
   * QUANTAS PESSOAS ESTÃO NO SITE AGORA — do nosso dado, não do GA4.
   *
   * Pergunta do dono (13/08): "quantas pessoas estão no site neste momento?
   * como vejo pelo sistema nosso?". A resposta vem de `site_eventos`: o site
   * manda page_view/scroll/time_on_page de TODO mundo (com ou sem aceite do
   * banner, linha anonimizada), então sessão com evento recente = pessoa
   * navegando. Não é batida de presença: quem está parado numa página só
   * aparece enquanto os eventos de tempo/rolagem pingam — por isso o card
   * mostra a janela ("últimos 5 min") em vez de fingir precisão.
   *
   * GA4 não serve pra isso hoje: o site novo dispara no MESMO stream do
   * WordPress ([[ga4-site-novo-stream-trocado]]), então o "tempo real" de lá
   * soma os dois sites.
   *
   * ── PESSOA ≠ SESSÃO (16/08/2026) ──
   *
   * Este card já mostrou "26 pessoas navegando · 25 em /lojas" numa manhã em
   * que /lojas recebia 1 visita por hora. A conta estava certa e o número era
   * mentira: `session_id` nasce no `sessionStorage`, então cada acesso de robô
   * inaugura uma sessão e vira "pessoa". Agora passam DOIS filtros — o carimbo
   * `bot` (user-agent, feito na origem) e a régua de comportamento
   * (`SQL_SINAL_DE_GENTE`), que é a que pega quem falseia o user-agent.
   *
   * O robô não é escondido, é CONTADO à parte: some da conta de gente e
   * aparece com nome próprio. Varredura é informação — inclusive de custo.
   *
   * Duas queries: os números (uma só, com CTE) e as páginas quentes. A tela
   * recarrega a cada 20s e não vale seis idas ao banco. `::int` em todo COUNT:
   * BigInt na resposta é 500 mudo de serialização.
   */
  async agora(): Promise<{
    ativos5min: number;
    ativos30min: number;
    sessoesHoje: number;
    pageViewsHoje: number;
    robos5min: number;
    robosHoje: number;
    quemSaoOsRobos: Array<{ nome: string; acessos: number }>;
    paginasQuentes: Array<{ path: string; pessoas: number }>;
  }> {
    // "Hoje" no fuso da loja (São Paulo), não em UTC — meia-noite UTC é 21h
    // daqui e comeria as três primeiras horas do dia (mesmo cuidado do
    // relatório de cliques).
    const DIA = `date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`;

    const [linha] = await this.prisma.$queryRawUnsafe<Array<{
      ativos5: number; ativos30: number; sessoes_hoje: number; pv_hoje: number;
      total5: number; total_hoje: number;
    }>>(
      `WITH gente AS (
         SELECT session_id, MAX(criado_em) AS ultimo
           FROM site_eventos
          WHERE criado_em > NOW() - INTERVAL '30 minutes'
            AND session_id IS NOT NULL AND NOT bot
          GROUP BY session_id
         HAVING ${SQL_SINAL_DE_GENTE}
       ), gente_dia AS (
         SELECT session_id, COUNT(*) FILTER (WHERE evento = 'page_view')::int AS page_views
           FROM site_eventos
          WHERE criado_em >= ${DIA} AND session_id IS NOT NULL AND NOT bot
          GROUP BY session_id
         HAVING ${SQL_SINAL_DE_GENTE}
       )
       SELECT
         (SELECT COUNT(*)::int FROM gente WHERE ultimo > NOW() - INTERVAL '5 minutes') AS ativos5,
         (SELECT COUNT(*)::int FROM gente)                                             AS ativos30,
         (SELECT COUNT(*)::int FROM gente_dia)                                         AS sessoes_hoje,
         (SELECT COALESCE(SUM(page_views), 0)::int FROM gente_dia)                     AS pv_hoje,
         -- Total CRU (robô incluído): a diferença pro de cima é o que a
         -- varredura estava inflando, e é o que a tela mostra como "robôs".
         (SELECT COUNT(DISTINCT session_id)::int FROM site_eventos
           WHERE criado_em > NOW() - INTERVAL '5 minutes' AND session_id IS NOT NULL)  AS total5,
         (SELECT COUNT(DISTINCT session_id)::int FROM site_eventos
           WHERE criado_em >= ${DIA} AND session_id IS NOT NULL)                       AS total_hoje`,
    );

    const paginas = await this.prisma.$queryRawUnsafe<Array<{ path: string; pessoas: number }>>(
      `WITH gente AS (
         SELECT session_id
           FROM site_eventos
          WHERE criado_em > NOW() - INTERVAL '30 minutes'
            AND session_id IS NOT NULL AND NOT bot
          GROUP BY session_id
         HAVING ${SQL_SINAL_DE_GENTE}
       )
       SELECT e.path, COUNT(DISTINCT e.session_id)::int AS pessoas
         FROM site_eventos e
         JOIN gente g ON g.session_id = e.session_id
        WHERE e.criado_em > NOW() - INTERVAL '5 minutes' AND e.path IS NOT NULL AND NOT e.bot
        GROUP BY e.path
        ORDER BY pessoas DESC, e.path
        LIMIT 8`,
    );

    /** QUEM veio varrer hoje — a resposta que o carimbo do user-agent dá e o
     *  filtro de comportamento não dá: nome e volume de cada robô. */
    const robos = await this.prisma.$queryRawUnsafe<Array<{ nome: string; acessos: number }>>(
      `SELECT COALESCE(bot_nome, 'nao-identificado') AS nome, COUNT(*)::int AS acessos
         FROM site_eventos
        WHERE criado_em >= ${DIA} AND bot
        GROUP BY 1 ORDER BY acessos DESC LIMIT 10`,
    );

    const ativos5 = Number(linha?.ativos5 ?? 0);
    const sessoesHoje = Number(linha?.sessoes_hoje ?? 0);

    return {
      ativos5min: ativos5,
      ativos30min: Number(linha?.ativos30 ?? 0),
      sessoesHoje,
      pageViewsHoje: Number(linha?.pv_hoje ?? 0),
      // Nunca negativo: as duas contas saem da mesma query, mas subtração de
      // número vindo do banco não é lugar pra confiar em invariante.
      robos5min: Math.max(0, Number(linha?.total5 ?? 0) - ativos5),
      robosHoje: Math.max(0, Number(linha?.total_hoje ?? 0) - sessoesHoje),
      quemSaoOsRobos: robos.map((r) => ({ nome: r.nome, acessos: Number(r.acessos) })),
      paginasQuentes: paginas.map((p) => ({ path: p.path, pessoas: Number(p.pessoas) })),
    };
  }

  /**
   * Relatório por loja no período.
   *
   * Duas queries de propósito: `groupBy` conta CLIQUES (soma tudo), e a segunda
   * conta SESSÕES distintas. Não dá pra tirar as duas de um groupBy só — o
   * Prisma não faz `count(distinct)` dentro de agregação — e a diferença entre
   * elas é justamente o que separa "23 cliques" de "23 pessoas".
   */
  async porLoja(de: Date, ate: Date): Promise<{ linhas: LinhaLoja[]; totalCliques: number }> {
    const janela = { gte: de, lte: ate };

    const grupos = await this.prisma.siteStoreClick.groupBy({
      by: ['loja', 'evento'],
      where: { createdAt: janela },
      _count: { _all: true },
    });

    const sessoes = await this.prisma.siteStoreClick.findMany({
      where: { createdAt: janela, sessionId: { not: null } },
      select: { loja: true, sessionId: true },
      distinct: ['loja', 'sessionId'],
    });

    const pessoasPorLoja = new Map<string, number>();
    for (const s of sessoes) {
      const chave = s.loja ?? '—';
      pessoasPorLoja.set(chave, (pessoasPorLoja.get(chave) ?? 0) + 1);
    }

    const porLoja = new Map<string, LinhaLoja>();
    let totalCliques = 0;

    for (const g of grupos) {
      // Loja nula é clique que não nasceu de uma unidade (WhatsApp geral).
      // Vira uma linha própria em vez de sumir — senão o total da tela não
      // bate com o total do período e ninguém entende por quê.
      const chave = g.loja ?? '—';
      const n = g._count._all;
      totalCliques += n;

      const linha =
        porLoja.get(chave) ??
        { loja: chave, comoChegar: 0, whatsapp: 0, instagram: 0, telefone: 0, total: 0, pessoas: 0 };

      if (g.evento === 'store_locator') linha.comoChegar += n;
      else if (g.evento === 'whatsapp_click') linha.whatsapp += n;
      else if (g.evento === 'instagram_click') linha.instagram += n;
      else if (g.evento === 'phone_click') linha.telefone += n;

      linha.total += n;
      porLoja.set(chave, linha);
    }

    for (const [chave, linha] of porLoja) {
      linha.pessoas = pessoasPorLoja.get(chave) ?? 0;
    }

    const linhas = [...porLoja.values()].sort((a, b) => b.total - a.total);
    return { linhas, totalCliques };
  }
}
