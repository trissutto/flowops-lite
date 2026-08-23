/**
 * DE QUAL CAMPANHA VEIO ESTE PEDIDO — a cascata que a tela do pedido abre.
 *
 * A atribuição já existia em três pedaços espalhados: as colunas `utm_*` do
 * `Order` (gravadas no fechamento), o `trackingInfo.attribution` (que guarda o
 * que as colunas não têm — posicionamento, página de entrada, fbclid) e o
 * `_wc_order_attribution_*` do pedido velho do WooCommerce. A tela mostrava
 * uma linha cinza no rodapé com os três colados por barra, e nenhuma delas
 * respondia "de qual ANÚNCIO veio".
 *
 * Aqui os três viram UMA cascata, na mesma ordem da tela de cliques
 * (plataforma → campanha → anúncio → posicionamento → página de entrada):
 * cada degrau só nasce se o dado existir, então pedido direto não inventa
 * campanha e pedido velho não finge ter posicionamento.
 *
 * ⚠️ A CHAVE DA CAMPANHA É O `utm_id`, NUNCA O NOME — mesma regra do
 * `MetaAdsGastoDia`. Campanha renomeada no Gerenciador continua com o id
 * antigo nos pedidos já fechados, e é por isso que `nomeOficial` (que vem do
 * espelho de gasto, achado pelo id) ganha do nome que veio na URL.
 */

export type DegrauAtribuicao = {
  /** Nome do degrau ("Campanha", "Anúncio"…). */
  rotulo: string;
  valor: string;
  /** Segunda linha do degrau — id, utm cru, aviso. Opcional. */
  detalhe?: string | null;
  /** true = valor em fonte mono (id, caminho de página, utm cru). */
  mono?: boolean;
};

export type CascataAtribuicao = {
  /** O que a tela mostra FECHADA — o nome da campanha, quando há uma. */
  titulo: string;
  /** Uma linha de resumo debaixo do título. */
  resumo: string | null;
  /** true = tem marca de tráfego pago (mídia paga, fbclid ou gclid). */
  pago: boolean;
  plataforma: 'meta' | 'google' | null;
  /** Os degraus, do mais largo pro mais estreito. */
  degraus: DegrauAtribuicao[];
  /** false = não há nada além do topo pra abrir (pedido sem etiqueta). */
  temDetalhe: boolean;
  /**
   * true = o `titulo` é MESMO o nome de uma campanha. Pedido direto, orgânico
   * ou da live também tem título — e chamar aquilo de "campanha" na tela seria
   * dar nome de anúncio pra quem não veio de anúncio nenhum.
   */
  temCampanha: boolean;
};

export type EntradaAtribuicao = {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmId?: string | null;
  utmContent?: string | null;
  /** `Order.trackingInfo` já parseado (objeto) — só o pedido nativo tem. */
  trackingInfo?: any;
  /** `_wc_order_attribution_source_type` do WooCommerce. */
  sourceType?: string | null;
  /** `_wc_order_attribution_referrer` do WooCommerce. */
  referrer?: string | null;
  /**
   * Pedido que NÃO nasce de clique no site (live, venda online da loja).
   * Preenchido, encerra a conversa: o topo mostra isto e não há UTM nenhum
   * pra procurar — dizer "direto" ali seria mentira.
   */
  origemFixa?: string | null;
  /** Nome atual da campanha no Meta, achado pelo `utmId` no espelho de gasto. */
  nomeOficial?: string | null;
};

/** A mesma regra de "isso é pago" do site (`flowops-store.ts`). */
const MIDIA_PAGA = /^(cpc|ppc|paid|paid_social|paidsocial|paid-social)$/i;

/** Canais que são a MESMA plataforma — o UTM chega em cinco grafias. */
const CANAIS_META = ['meta', 'facebook', 'fb', 'ig', 'instagram'];

const CANAL_LEGIVEL: Record<string, string> = {
  meta: 'Meta',
  facebook: 'Facebook',
  fb: 'Facebook',
  ig: 'Instagram',
  instagram: 'Instagram',
  google: 'Google',
};

/**
 * O `{{placement}}` do Meta chega como `Instagram_Reels`. Vale traduzir porque
 * é ele que separa Face de Insta — é a resposta de "onde a cliente viu".
 */
const POSICAO_LEGIVEL: Record<string, string> = {
  an_classic: 'Audience Network',
  messenger_inbox: 'Messenger · Caixa de entrada',
  unknown: 'Não informado',
};

function texto(v: any): string {
  return String(v ?? '').trim();
}

function humanizarPosicao(bruto: string): string {
  return POSICAO_LEGIVEL[bruto.toLowerCase()] ?? bruto.replace(/_/g, ' ');
}

function hostDe(url?: string | null): string {
  const cru = texto(url);
  if (!cru) return '';
  try {
    return new URL(cru).hostname.replace(/^www\./, '');
  } catch {
    return cru;
  }
}

export function montarCascataAtribuicao(e: EntradaAtribuicao): CascataAtribuicao {
  // ── Origem que não é clique de site (live, PDV da loja) ──
  // Encerra antes de qualquer UTM: procurar campanha aqui só produziria
  // "Direto", que é uma resposta errada disfarçada de resposta.
  if (texto(e.origemFixa)) {
    return {
      titulo: texto(e.origemFixa),
      resumo: 'Pedido que não nasceu de clique no site — não tem campanha.',
      pago: false,
      plataforma: null,
      degraus: [{ rotulo: 'Origem', valor: texto(e.origemFixa) }],
      temDetalhe: false,
      temCampanha: false,
    };
  }

  const attr =
    (e.trackingInfo && typeof e.trackingInfo === 'object' ? e.trackingInfo.attribution : null) || {};

  // As colunas do Order mandam; o snapshot do checkout cobre o que elas não têm.
  const canalCru = texto(e.utmSource || attr.source);
  const midia = texto(e.utmMedium || attr.medium);
  const campanhaUtm = texto(e.utmCampaign || attr.campaign);
  const campanhaId = texto(e.utmId || attr.id);
  const anuncio = texto(e.utmContent || attr.content);
  const posicaoCrua = texto(attr.term);
  const paginaEntrada = texto(attr.landing_page);
  const fbclid = texto(attr.fbclid);
  const gclid = texto(attr.gclid);
  const tipo = texto(e.sourceType).toLowerCase();
  const canal = canalCru.toLowerCase();

  const plataforma: CascataAtribuicao['plataforma'] =
    CANAIS_META.includes(canal) || fbclid
      ? 'meta'
      : canal.startsWith('google') || gclid
        ? 'google'
        : null;

  const pago = MIDIA_PAGA.test(midia) || !!fbclid || !!gclid;

  // Campanha renomeada no Meta: o id continua o mesmo, o nome não. Vale o
  // nome de HOJE, com o que veio na URL guardado embaixo — senão a tela
  // discorda do pedido e ninguém sabe qual dos dois está certo.
  const nomeOficial = texto(e.nomeOficial);
  const campanha = nomeOficial || campanhaUtm;
  const renomeada = !!nomeOficial && !!campanhaUtm && nomeOficial !== campanhaUtm;

  const plataformaLegivel =
    plataforma === 'meta'
      ? 'Meta'
      : plataforma === 'google'
        ? 'Google'
        : CANAL_LEGIVEL[canal] || canalCru;

  const degraus: DegrauAtribuicao[] = [];

  if (plataformaLegivel) {
    degraus.push({
      rotulo: 'Plataforma',
      valor: plataformaLegivel,
      detalhe: pago
        ? `Tráfego pago${midia ? ` · ${midia}` : ''}`
        : midia
          ? `Mídia: ${midia}`
          : 'Sem marca de tráfego pago',
    });
  }

  if (campanha) {
    degraus.push({
      rotulo: 'Campanha',
      valor: campanha,
      detalhe: campanhaId
        ? `ID ${campanhaId}${renomeada ? ` · no pedido veio como "${campanhaUtm}"` : ''}`
        : 'Sem utm_id — o nome é a única chave desta campanha',
    });
  }

  if (anuncio) degraus.push({ rotulo: 'Anúncio', valor: anuncio });

  if (posicaoCrua) {
    degraus.push({
      rotulo: 'Posicionamento',
      valor: humanizarPosicao(posicaoCrua),
      detalhe: posicaoCrua,
    });
  }

  if (paginaEntrada) degraus.push({ rotulo: 'Entrou por', valor: paginaEntrada, mono: true });

  // ── Pedido velho do WooCommerce: orgânico / encaminhamento ──
  const host = hostDe(e.referrer);
  if (!campanha && (tipo === 'organic' || tipo === 'referral') && host) {
    degraus.push({
      rotulo: tipo === 'organic' ? 'Busca' : 'Veio do site',
      valor: host,
      mono: true,
    });
  }

  // A etiqueta CRUA fecha a cascata: é a prova de onde tudo isso saiu.
  const etiqueta = [
    canalCru && `utm_source=${canalCru}`,
    midia && `utm_medium=${midia}`,
    campanhaUtm && `utm_campaign=${campanhaUtm}`,
    campanhaId && `utm_id=${campanhaId}`,
    anuncio && `utm_content=${anuncio}`,
    posicaoCrua && `utm_term=${posicaoCrua}`,
  ]
    .filter(Boolean)
    .join('&');
  if (etiqueta) degraus.push({ rotulo: 'Etiqueta (UTM)', valor: etiqueta, mono: true });

  const titulo =
    campanha ||
    (tipo === 'organic' ? `Busca orgânica${host ? ` · ${host}` : ''}` : '') ||
    (host ? `Encaminhamento · ${host}` : '') ||
    (plataformaLegivel ? `${plataformaLegivel} · sem campanha` : '') ||
    'Direto — sem campanha';

  const resumo =
    [
      plataformaLegivel && `${plataformaLegivel}${pago ? ' (pago)' : ''}`,
      posicaoCrua && humanizarPosicao(posicaoCrua),
      anuncio && `anúncio ${anuncio}`,
    ]
      .filter(Boolean)
      .join(' · ') || null;

  return {
    titulo,
    resumo,
    pago,
    plataforma,
    degraus,
    temDetalhe: degraus.length > 0,
    temCampanha: !!campanha,
  };
}
