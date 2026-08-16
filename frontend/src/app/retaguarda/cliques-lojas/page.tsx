'use client';

/**
 * /retaguarda/cliques-lojas
 *
 * Quantas pessoas pediram rota, chamaram no WhatsApp, abriram o Instagram ou
 * ligaram — LOJA POR LOJA, no período escolhido.
 *
 * Pedido do dono em 13/08/2026. A página /lojas do site tinha esses quatro
 * botões em 14 unidades e nenhum deles disparava evento: o clique que mais
 * aproxima cliente de loja física era o único sem medida em todo o sistema.
 *
 * Por que a tela existe em vez de "olhe no GA4": o dado é gravado no NOSSO
 * Postgres (`site_store_clicks`), então não depende de cota de API, não sofre
 * amostragem do Google e fica ao lado do resto da operação. O evento continua
 * indo pro GA4 em paralelo — aqui é a cópia que é nossa.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, ArrowLeft, BadgeCheck, CreditCard, Eye, Gauge, Instagram, Loader2, MapPin,
  MessageCircle, Phone, RefreshCw, ShoppingBag, ShoppingCart, Users, X,
} from 'lucide-react';
import { api } from '@/lib/api';

type Linha = {
  loja: string;
  comoChegar: number;
  whatsapp: number;
  instagram: number;
  telefone: number;
  total: number;
  pessoas: number;
};

type Resposta = { de: string; ate: string; totalCliques: number; linhas: Linha[] };

/**
 * "Quantas pessoas estão no site AGORA" (pergunta do dono, 13/08). Vem de
 * `site_eventos` — o nosso Postgres, não o GA4 (que mistura o site novo com o
 * WordPress no mesmo stream). Sessão com evento nos últimos 5 min = pessoa
 * navegando agora.
 *
 * PESSOA, não sessão (16/08): robô que roda JavaScript ganha sessão nova a
 * cada acesso e chegou a responder por 25 das 26 "pessoas" numa manhã. O
 * backend agora separa os dois — e o robô aparece na tela em vez de sumir,
 * porque saber que estão varrendo o site é informação.
 */
type Agora = {
  ativos5min: number;
  ativos30min: number;
  sessoesHoje: number;
  pageViewsHoje: number;
  robos5min: number;
  robosHoje: number;
  quemSaoOsRobos: Array<{ nome: string; acessos: number }>;
  paginasQuentes: Array<{ path: string; pessoas: number }>;
};

/**
 * O FUNIL DE VENDA (dono, 13/08: "preciso destes dados na tela de cliques —
 * add cart, initiate checkout, etc"). Mesmo período De/Até dos cliques; conta
 * todo mundo (com e sem aceite do banner) porque vem de `site_eventos`.
 */
type EtapaFunil = { evento: string; eventos: number; pessoas: number; valor?: number };
type DiagnosticoFunil = {
  evento: string;
  codigo: string;
  campo: string | null;
  pessoas: number;
  eventos: number;
};
type LinhaJornada = {
  evento: string;
  chegaram: number;
  avancaram: number | null;
  abandonaram: number;
  taxaAvanco: number | null;
  taxaPerda: number | null;
};
type ProblemaJornada = {
  evento: string;
  codigo: string;
  campo: string | null;
  pessoas: number;
  ocorrencias: number;
  recuperadas: number;
};
type InteracaoJornada = {
  evento: string;
  codigo: string;
  campo: string | null;
  pessoas: number;
  interacoes: number;
};
type ResumoJornada = {
  maiorPerda: LinhaJornada | null;
  sessoesComProblema: number;
  sessoesRecuperadas: number;
  pixPendente: number;
  amostraPequena: boolean;
};
type AlertaCheckout = {
  sessionId: string;
  etapa: string;
  pagamento: string;
  codigo: string;
  pedido: string | null;
  tentativas: number;
  primeiraFalha: string;
  ultimaFalha: string;
};
/**
 * O tráfego que entra pela página das LOJAS (anúncio de loja física).
 *
 * Ele sai do funil de e-commerce de propósito — não veio comprar no site, e
 * contá-lo lá dentro afunda a conversão com quem nunca teve essa intenção. A
 * conversão DELE é outra: falar com a loja.
 */
type TrafegoLojas = {
  pessoas: number;
  contataram: number;
  contatos: { whatsapp: number; comoChegar: number; telefone: number; instagram: number };
  navegaram: { viramPeca: number; sacola: number; checkout: number; compraram: number };
  valorComprado: number;
  porUnidade: Array<{ loja: string; contatos: number }>;
  porCampanha: Array<{ campanha: string; canal: string | null; pessoas: number }>;
};
/** Tráfego pago, orgânico ou direto — o primeiro nível da cascata. */
type Trafego = 'pago' | 'organico' | 'direto';
/**
 * Uma combinação que EXISTE no período, com o tamanho dela. A cascata inteira
 * é montada a partir desta lista — o backend manda as combinações do período
 * cheio, nunca do recorte atual, senão escolher uma campanha apagaria as
 * outras da lista e não teria como voltar.
 */
type OpcaoSegmento = {
  trafego: Trafego;
  plataforma: string | null;
  campanha: string | null;
  pessoas: number;
};
type RespostaFunil = {
  de: string;
  ate: string;
  segmentos?: OpcaoSegmento[];
  etapas: EtapaFunil[];
  diagnosticos?: DiagnosticoFunil[];
  faturamento?: { pedidos: number; valor: number };
  alertasCheckout?: AlertaCheckout[];
  trafegoLojas?: TrafegoLojas;
  jornada?: LinhaJornada[];
  problemas?: ProblemaJornada[];
  interacoes?: InteracaoJornada[];
  resumo?: ResumoJornada;
};

/**
 * Data 'YYYY-MM-DD' SEMPRE em Brasília, independente do fuso do PC. Era
 * `d.toISOString().slice(0,10)` — UTC: depois das 21h de Brasília o "Hoje"
 * pulava pra amanhã e a tela abria vazia. `en-CA` formata como YYYY-MM-DD.
 */
const fmtDataBr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
const iso = (d: Date) => fmtDataBr.format(d);
const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const ROTULO_TRAFEGO: Record<Trafego, string> = {
  pago: 'Tráfego pago',
  organico: 'Orgânico e indicação',
  direto: 'Direto',
};

/** Nome bonito só pros que a gente conhece; o resto sai como veio do UTM. */
const ROTULO_PLATAFORMA: Record<string, string> = {
  google: 'Google',
  meta: 'Meta',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  whatsapp: 'WhatsApp',
};

/**
 * O NOME DA CAMPANHA, LEGÍVEL.
 *
 * Duas sujeiras chegam aqui, de origens diferentes:
 *
 * 1. CODIFICAÇÃO DUPLA do Meta — `%7CSITENOVO%7C+Vendas+Capitais` em vez de
 *    `|SITENOVO| Vendas Capitais`. Corrigido na origem (`decodificaUtm`, no
 *    site), mas as linhas gravadas ANTES do conserto continuam tortas no
 *    banco. Este decode existe pra elas: é leitura, não regravação.
 *
 * 2. ID NO LUGAR DO NOME — anúncio etiquetado com `utm_campaign={{campaign.id}}`
 *    manda `52531954165766`. Aqui não dá pra adivinhar o nome, então a tela
 *    ASSUME o buraco em vez de mostrar um número solto: quem lê entende que
 *    falta arrumar a etiqueta daquele anúncio, e não que a campanha se chama
 *    assim.
 */
function rotuloCampanha(valor: string): string {
  let texto = valor;
  for (let i = 0; i < 2 && /%[0-9A-Fa-f]{2}/.test(texto); i += 1) {
    try {
      texto = decodeURIComponent(texto.replace(/\+/g, ' '));
    } catch {
      break;
    }
  }
  // Sobrou `+` e nenhum espaço: era espaço codificado (ver `decodificaUtm`).
  if (texto.includes('+') && !texto.includes(' ')) texto = texto.replace(/\+/g, ' ');
  texto = texto.trim();
  // Só dígitos = é o ID da campanha, não o nome dela.
  if (/^\d{6,}$/.test(texto)) return `sem nome (ID ${texto.slice(-6)})`;
  return texto || valor;
}

/** Um degrau da cascata. Vazio some — degrau com uma opção só não é escolha. */
function Degrau({
  titulo,
  opcoes,
  valor,
  onEscolher,
  rotulo = (v: string) => v,
}: {
  titulo: string;
  opcoes: Array<{ valor: string; pessoas: number }>;
  valor: string | null;
  onEscolher: (v: string | null) => void;
  rotulo?: (v: string) => string;
}) {
  if (!opcoes.length) return null;
  const total = opcoes.reduce((s, o) => s + o.pessoas, 0);
  const pilula = (ativo: boolean) =>
    `px-3 py-1 rounded-full border text-sm transition ${
      ativo
        ? 'border-[#B8912B] bg-[#FBF6E6] text-[#8C7325] font-semibold'
        : 'border-[#E7E2D8] text-slate-600 hover:bg-[#FBF6E6]'
    }`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 w-20 shrink-0">
        {titulo}
      </span>
      <button className={pilula(valor === null)} onClick={() => onEscolher(null)}>
        Tudo <span className="tabular-nums text-slate-400">{total}</span>
      </button>
      {opcoes.map((o) => (
        <button key={o.valor} className={pilula(valor === o.valor)} onClick={() => onEscolher(o.valor)}>
          {rotulo(o.valor)} <span className="tabular-nums text-slate-400">{o.pessoas}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A CASCATA — tudo → tráfego pago → Google/Meta → campanha.
 *
 * Pedido do dono (16/08). Ela filtra o RELATÓRIO INTEIRO, não um quadro: a
 * pergunta é "como é o funil do público desse anúncio", e isso só responde se
 * visita, sacola, checkout e compra vierem todos do mesmo recorte.
 *
 * Cada degrau só aparece depois do de cima estar escolhido — é o que faz dela
 * uma cascata e não três filtros soltos. Trocar um degrau limpa os de baixo,
 * senão sobraria uma campanha do Meta selecionada embaixo de "Google".
 *
 * O número em cada pílula é gente, não evento: dá pra ver o tamanho da fatia
 * antes de clicar e não cair num funil de 3 pessoas sem perceber.
 */
function Cascata({
  opcoes,
  trafego,
  plataforma,
  campanha,
  onMudar,
}: {
  opcoes: OpcaoSegmento[];
  trafego: Trafego | null;
  plataforma: string | null;
  campanha: string | null;
  onMudar: (s: { trafego: Trafego | null; plataforma: string | null; campanha: string | null }) => void;
}) {
  const somar = (
    linhas: OpcaoSegmento[],
    chave: (o: OpcaoSegmento) => string | null,
  ): Array<{ valor: string; pessoas: number }> => {
    const mapa = new Map<string, number>();
    for (const o of linhas) {
      const k = chave(o);
      if (!k) continue;
      mapa.set(k, (mapa.get(k) ?? 0) + o.pessoas);
    }
    return Array.from(mapa, ([valor, pessoas]) => ({ valor, pessoas })).sort(
      (a, b) => b.pessoas - a.pessoas || a.valor.localeCompare(b.valor),
    );
  };

  const nivel1 = somar(opcoes, (o) => o.trafego);
  const doTrafego = trafego ? opcoes.filter((o) => o.trafego === trafego) : [];
  const nivel2 = somar(doTrafego, (o) => o.plataforma);
  const daPlataforma = plataforma ? doTrafego.filter((o) => o.plataforma === plataforma) : [];
  const nivel3 = somar(daPlataforma, (o) => o.campanha);
  const filtrando = Boolean(trafego || plataforma || campanha);

  return (
    <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800 text-sm">De onde veio quem estou olhando</h2>
          <p className="text-xs text-slate-500">
            Filtra o relatório inteiro — funil, jornada e problemas.
          </p>
        </div>
        {filtrando && (
          <button
            onClick={() => onMudar({ trafego: null, plataforma: null, campanha: null })}
            className="px-3 py-1 rounded-full border border-[#E7E2D8] text-slate-500 hover:bg-[#FBF6E6] text-sm shrink-0"
          >
            Limpar
          </button>
        )}
      </div>

      <Degrau
        titulo="Tráfego"
        opcoes={nivel1}
        valor={trafego}
        rotulo={(v) => ROTULO_TRAFEGO[v as Trafego] ?? v}
        onEscolher={(v) =>
          onMudar({ trafego: (v as Trafego) ?? null, plataforma: null, campanha: null })
        }
      />
      {trafego && (
        <Degrau
          titulo="Origem"
          opcoes={nivel2}
          valor={plataforma}
          rotulo={(v) => ROTULO_PLATAFORMA[v.toLowerCase()] ?? v}
          onEscolher={(v) => onMudar({ trafego, plataforma: v, campanha: null })}
        />
      )}
      {trafego && plataforma && (
        <Degrau
          titulo="Campanha"
          opcoes={nivel3}
          valor={campanha}
          rotulo={rotuloCampanha}
          onEscolher={(v) => onMudar({ trafego, plataforma, campanha: v })}
        />
      )}

      {!opcoes.length && (
        <p className="text-xs text-slate-500">
          Nenhuma origem gravada neste período. O UTM só passou a ser guardado
          em 16/08/2026 — antes disso ele chegava e era descartado, então
          período anterior aparece vazio aqui.
        </p>
      )}
      {filtrando && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          A origem vale por 30 dias no navegador, igual ao Meta e ao GA4 (último
          clique). &quot;Campanha X&quot; quer dizer <strong>o último anúncio que
          essa pessoa clicou foi o X</strong> — não que esta visita veio dele. O
          faturamento sai da tela enquanto há filtro: ele vem do pedido, que não
          guarda sessão, e não dá pra recortar por campanha.
        </p>
      )}
    </div>
  );
}

export default function CliquesLojasPage() {
  // ABRE EM HOJE (dono, 15/08): a pergunta de todo dia é "como foi HOJE?", não
  // "os últimos 30 dias". Os atalhos e o "Limpar (30 dias)" seguem na mão.
  const [de, setDe] = useState(() => iso(new Date()));
  const [ate, setAte] = useState(() => iso(new Date()));
  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  /** Separado do `erro` geral: o funil pode cair sozinho e a tela continua. */
  const [erroFunil, setErroFunil] = useState('');
  const [agora, setAgora] = useState<Agora | null>(null);
  const [funil, setFunil] = useState<RespostaFunil | null>(null);
  // A cascata. Os três juntos num estado só porque nunca mudam sozinhos:
  // trocar o de cima limpa os de baixo, e dois `useState` separados abririam
  // a janela pra um render com "campanha do Meta" embaixo de "Google".
  const [seg, setSeg] = useState<{
    trafego: Trafego | null;
    plataforma: string | null;
    campanha: string | null;
  }>({ trafego: null, plataforma: null, campanha: null });

  /**
   * O card ao vivo se atualiza sozinho a cada 20s — "agora" com botão de
   * atualizar seria um contrassenso. Falha fica muda de propósito: o resto da
   * tela continua servindo, e o card mostra o último número que teve.
   */
  useEffect(() => {
    let vivo = true;
    const busca = () =>
      api<Agora>('/site-metrics/agora')
        .then((r) => { if (vivo) setAgora(r); })
        .catch(() => {});
    busca();
    const timer = setInterval(busca, 20_000);
    return () => { vivo = false; clearInterval(timer); };
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    setErroFunil('');
    try {
      const qs = new URLSearchParams();
      if (de) qs.set('de', de);
      if (ate) qs.set('ate', ate);
      const sufixo = qs.toString() ? `?${qs}` : '';
      // A cascata vale só pro funil. A lista de cliques por loja é outra
      // pergunta ("qual unidade recebeu contato") e não se recorta por campanha.
      const qsFunil = new URLSearchParams(qs);
      if (seg.trafego) qsFunil.set('trafego', seg.trafego);
      if (seg.plataforma) qsFunil.set('plataforma', seg.plataforma);
      if (seg.campanha) qsFunil.set('campanha', seg.campanha);
      const sufixoFunil = qsFunil.toString() ? `?${qsFunil}` : '';
      /**
       * Funil em paralelo e tolerante: se falhar, a tela de cliques segue de
       * pé. Mas o erro APARECE — em 16/08 uma CTE duplicada derrubou o
       * endpoint e este `catch` mudo transformou o 500 num relatório vazio,
       * com cara de "não teve movimento hoje". Silêncio aqui é pior que a
       * falha: número errado não se anuncia sozinho.
       */
      const [r, f] = await Promise.all([
        api<Resposta>(`/site-metrics/lojas${sufixo}`),
        api<RespostaFunil>(`/site-metrics/funil${sufixoFunil}`).catch((e) => {
          setErroFunil(e?.message || 'não consegui carregar o funil');
          return null;
        }),
      ]);
      setDados(r);
      setFunil(f);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar');
    } finally {
      setCarregando(false);
    }
  }, [de, ate, seg]);

  useEffect(() => { carregar(); }, [carregar]);

  /** Atalhos olham pra TRÁS — aqui o passado é que interessa, ao contrário da
   *  tela de contas a pagar, onde "7 dias" são os vencimentos que vêm. */
  const atalho = (qual: number | 'hoje' | 'ontem' | 'mes') => {
    const h = new Date();
    if (qual === 'hoje') { setDe(iso(h)); setAte(iso(h)); }
    else if (qual === 'ontem') {
      const o = new Date(h.getTime() - 86400000);
      setDe(iso(o)); setAte(iso(o));
    } else if (qual === 'mes') {
      setDe(iso(new Date(h.getFullYear(), h.getMonth(), 1)));
      setAte(iso(new Date(h.getFullYear(), h.getMonth() + 1, 0)));
    } else {
      setDe(iso(new Date(h.getTime() - qual * 86400000))); setAte(iso(h));
    }
  };

  const linhas = dados?.linhas ?? [];
  const soma = (campo: keyof Linha) =>
    linhas.reduce((s, l) => s + (Number(l[campo]) || 0), 0);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-800">Cliques nas lojas</h1>
          <p className="text-sm text-slate-500">
            Quem pediu rota, chamou no WhatsApp ou abriu o Instagram — por unidade.
          </p>
        </div>
        <button
          onClick={carregar}
          className="px-3 py-2 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-600"
          title="Atualizar"
        >
          <RefreshCw className={`w-4 h-4 ${carregando ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* AGORA NO SITE — ao vivo, do nosso Postgres (não é GA4) */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 text-xs font-bold tracking-wide text-slate-500 uppercase">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
              </span>
              Agora no site
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-4xl font-extrabold text-slate-800 tabular-nums">
                {agora ? agora.ativos5min : '—'}
              </span>
              <span className="text-sm text-slate-500">
                {agora?.ativos5min === 1 ? 'pessoa navegando' : 'pessoas navegando'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              últimos 5 min · dado nosso, só do lurdsplussize.com.br · atualiza sozinho
            </p>

            {/**
             * O ROBÔ APARECE, NÃO SOME.
             *
             * Podia ser filtrado em silêncio, mas aí o número cairia sem
             * explicação e a primeira reação seria achar que o site perdeu
             * visita. Mostrando os dois lado a lado, a queda se explica
             * sozinha — e "quem" varreu é resposta útil (16/08: 25 das 26
             * "pessoas" da tela eram varredura na página das lojas).
             */}
            {!!agora?.robos5min && (
              <p className="text-xs text-slate-500 mt-1.5">
                <span className="font-semibold text-slate-600">
                  +{agora.robos5min} {agora.robos5min === 1 ? 'robô' : 'robôs'}
                </span>{' '}
                agora (fora da conta)
                {!!agora.robosHoje && ` · ${agora.robosHoje} hoje`}
                {!!agora.quemSaoOsRobos?.length && (
                  <span className="text-slate-400">
                    {' — '}
                    {agora.quemSaoOsRobos
                      .slice(0, 4)
                      .map((r) => `${r.nome} (${r.acessos})`)
                      .join(' · ')}
                  </span>
                )}
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3 sm:w-auto w-full">
            {[
              { rotulo: 'Últimos 30 min', valor: agora?.ativos30min },
              { rotulo: 'Visitas hoje', valor: agora?.sessoesHoje },
              { rotulo: 'Páginas vistas hoje', valor: agora?.pageViewsHoje },
            ].map((m) => (
              <div key={m.rotulo} className="rounded-lg border border-[#E7E2D8] px-3 py-2 text-center">
                <div className="text-lg font-bold text-slate-700 tabular-nums">{m.valor ?? '—'}</div>
                <div className="text-[11px] text-slate-500 leading-tight">{m.rotulo}</div>
              </div>
            ))}
          </div>
        </div>

        {!!agora?.paginasQuentes?.length && (
          <div className="mt-3 pt-3 border-t border-[#F1EDE3]">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Onde elas estão
            </div>
            <div className="flex flex-wrap gap-1.5">
              {agora.paginasQuentes.slice(0, 6).map((p) => (
                <span
                  key={p.path}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#E7E2D8] bg-[#FAFAF7] px-2.5 py-1 text-xs text-slate-600"
                  title={p.path}
                >
                  <span className="font-semibold text-slate-700">{p.pessoas}</span>
                  <span className="max-w-[220px] truncate">{p.path}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* filtros — De/Até + atalhos, padrão de toda tela com período */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="text-slate-500 font-semibold">De</label>
          <input
            type="date" value={de} onChange={(e) => setDe(e.target.value)}
            className="border border-[#E7E2D8] rounded-lg px-2 py-1"
          />
          <label className="text-slate-500 font-semibold">Até</label>
          <input
            type="date" value={ate} onChange={(e) => setAte(e.target.value)}
            className="border border-[#E7E2D8] rounded-lg px-2 py-1"
          />
          <button onClick={() => atalho('hoje')} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">Hoje</button>
          <button onClick={() => atalho('ontem')} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">Ontem</button>
          <button onClick={() => atalho(7)} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">7 dias</button>
          <button onClick={() => atalho('mes')} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">Mês</button>
          <button onClick={() => { setDe(''); setAte(''); }} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-500">Limpar (30 dias)</button>
        </div>
      </div>

      {/* O funil caiu sozinho: diz isso, em vez de mostrar relatório vazio,
          que se confunde com "não teve movimento". */}
      {erroFunil && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">O relatório de conversão não carregou.</p>
            <p className="text-rose-700">
              Os números abaixo são só dos cliques de loja — o funil, a jornada e os
              problemas estão FORA DO AR neste momento, não zerados. ({erroFunil})
            </p>
          </div>
        </div>
      )}

      {/* A CASCATA — colada no filtro de data, porque as duas respondem "de
          quem é esse número": uma recorta o quando, a outra o quem. */}
      <Cascata
        opcoes={funil?.segmentos ?? []}
        trafego={seg.trafego}
        plataforma={seg.plataforma}
        campanha={seg.campanha}
        onMudar={setSeg}
      />

      {/* O FUNIL — acima do bloco de cliques de propósito: dia sem clique de
          loja ainda tem funil, e um não pode esconder o outro. */}
      {funil && <FunilSite
        etapas={funil.etapas}
        diagnosticos={funil.diagnosticos ?? []}
        faturamento={funil.faturamento}
        alertasCheckout={funil.alertasCheckout ?? []}
        jornada={funil.jornada ?? []}
        problemas={funil.problemas ?? []}
        interacoes={funil.interacoes ?? []}
        resumo={funil.resumo}
      />}

      {/* Logo abaixo do funil, e não numa aba escondida: é aqui que a pessoa
          entende POR QUE o número do funil mudou de tamanho. */}
      {funil?.trafegoLojas && <TrafegoDeLojas dados={funil.trafegoLojas} />}

      {erro && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-4 text-sm">{erro}</div>
      )}

      {carregando && !dados ? (
        <div className="flex items-center gap-2 text-slate-500 p-8 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" /> Carregando…
        </div>
      ) : linhas.length === 0 ? (
        <div className="bg-white border border-[#E7E2D8] rounded-xl p-8 text-center space-y-2">
          <p className="font-semibold text-slate-700">Nenhum clique no período.</p>
          {/* Vazio aqui tem 3 causas legítimas e nenhuma é "quebrou". Dizer
              quais evita o chamado de "a tela não funciona". */}
          <p className="text-sm text-slate-500 max-w-xl mx-auto">
            A contagem começa na data em que esta medição entrou no ar — não é
            retroativa. Só conta quem aceitou o banner de cookies do site
            (exigência da LGPD), e o período pode simplesmente não ter tido
            clique.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Cartao titulo="Como chegar" valor={soma('comoChegar')} icone={<MapPin className="w-4 h-4" />} cor="text-slate-800" />
            <Cartao titulo="WhatsApp" valor={soma('whatsapp')} icone={<MessageCircle className="w-4 h-4" />} cor="text-[#2E7D46]" />
            <Cartao titulo="Instagram" valor={soma('instagram')} icone={<Instagram className="w-4 h-4" />} cor="text-slate-800" />
            <Cartao titulo="Telefone" valor={soma('telefone')} icone={<Phone className="w-4 h-4" />} cor="text-slate-800" />
            <Cartao titulo="Pessoas" valor={soma('pessoas')} icone={<Users className="w-4 h-4" />} cor="text-[#B8912B]" />
          </div>

          <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#FBF6E6] text-slate-600">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold">Loja</th>
                  <th className="text-right px-4 py-3 font-semibold">Como chegar</th>
                  <th className="text-right px-4 py-3 font-semibold">WhatsApp</th>
                  <th className="text-right px-4 py-3 font-semibold">Instagram</th>
                  <th className="text-right px-4 py-3 font-semibold">Telefone</th>
                  <th className="text-right px-4 py-3 font-semibold">Total</th>
                  <th className="text-right px-4 py-3 font-semibold" title="Sessões distintas: quantas pessoas, não quantos cliques">
                    Pessoas
                  </th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.loja} className="border-t border-[#E7E2D8] hover:bg-[#FBF6E6]/40">
                    <td className="px-4 py-3 font-semibold text-slate-800">
                      {/* "—" é o clique que não nasceu de uma unidade. Aparece
                          em vez de sumir, pra o total da tela bater. */}
                      {l.loja === '—' ? <span className="text-slate-400">Sem loja definida</span> : l.loja}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{l.comoChegar || '–'}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-[#2E7D46]">{l.whatsapp || '–'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{l.instagram || '–'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{l.telefone || '–'}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-bold text-slate-800">{l.total}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-500">{l.pessoas || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-400">
            Contagem anônima: nenhum dado identifica a pessoa. Para saber QUEM
            chamou, a conversa está no WhatsApp da unidade.
          </p>
        </>
      )}
    </div>
  );
}

function Cartao({ titulo, valor, icone, cor }: { titulo: string; valor: number; icone: React.ReactNode; cor: string }) {
  return (
    <div className="bg-white border border-[#E7E2D8] rounded-xl p-4">
      <div className="flex items-center gap-2 text-slate-500 text-xs font-semibold uppercase tracking-wide">
        {icone} {titulo}
      </div>
      <div className={`mt-2 text-2xl font-bold tabular-nums ${cor}`}>{valor}</div>
    </div>
  );
}

/**
 * O funil da visita à compra, em PESSOAS (sessões) — o % de cada etapa é
 * sobre a anterior. Números pequenos embaixo são os toques (eventos).
 */
function FunilSite({
  etapas,
  diagnosticos,
  faturamento,
  alertasCheckout,
  jornada,
  problemas,
  interacoes,
  resumo,
}: {
  etapas: EtapaFunil[];
  diagnosticos: DiagnosticoFunil[];
  faturamento?: { pedidos: number; valor: number };
  alertasCheckout: AlertaCheckout[];
  jornada: LinhaJornada[];
  problemas: ProblemaJornada[];
  interacoes: InteracaoJornada[];
  resumo?: ResumoJornada;
}) {
  const por = new Map(etapas.map((e) => [e.evento, e]));
  const ordem = [
    { evento: 'page_view', titulo: 'Visitas', icone: <Users className="w-4 h-4" /> },
    { evento: 'view_item', titulo: 'Viram peça', icone: <Eye className="w-4 h-4" /> },
    { evento: 'add_to_cart', titulo: 'Sacola', icone: <ShoppingBag className="w-4 h-4" /> },
    { evento: 'begin_checkout', titulo: 'Checkout', icone: <ShoppingCart className="w-4 h-4" /> },
    { evento: 'add_payment_info', titulo: 'Pagamento', icone: <CreditCard className="w-4 h-4" /> },
    { evento: 'purchase', titulo: 'Compras', icone: <BadgeCheck className="w-4 h-4" /> },
  ];

  const [analisando, setAnalisando] = useState(false);

  /**
   * UM FUNIL SÓ NA TELA (dono, 16/08: "pode tirar os cards").
   *
   * Existiam DOIS: a fileira de cards saía do `funil()` (conta o evento que
   * de fato aconteceu) e a tabela "Onde a compra parou" sai da `jornada`
   * (cada sessão na etapa mais avançada, IMPUTANDO as anteriores). As duas
   * estão certas e discordam de propósito — a compra que chega pelo webhook
   * não tem `view_item` do navegador, então a tabela assume que ela viu a
   * peça e o card não conta. No dia 16/08 dava 153 contra 156.
   *
   * Duas definições de "viram peça" na mesma tela é uma a mais. Ficou a da
   * tabela, que é a que responde "onde a compra parou", e os cards saíram.
   *
   * A análise de conversão passa a ler a MESMA lista — antes ela lia os
   * cards, e teria continuado a divergir sozinha depois deles sumirem.
   */
  const rotuloEtapa = new Map(ordem.map((o) => [o.evento, o.titulo]));
  const etapasAnalise = jornada.length
    ? jornada.map((l) => ({
        evento: l.evento,
        titulo: rotuloEtapa.get(l.evento) ?? l.evento,
        pessoas: l.chegaram,
      }))
    : ordem.map((o) => ({
        evento: o.evento,
        titulo: o.titulo,
        pessoas: por.get(o.evento)?.pessoas ?? 0,
      }));
  const valorCompras = por.get('purchase')?.valor ?? 0;

  return (
    <div className="space-y-2">
      {/* O % de cada card responde "quanto passou daqui pra lá". O que ele NÃO
          responde é "isso é bom?" — pra isso é o botão, que põe cada etapa ao
          lado da faixa de mercado de moda feminina. */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
          Da visita à compra
        </h2>
        <button
          onClick={() => setAnalisando(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-[#B8912B] bg-[#FBF6E6] px-3 py-2 text-sm font-bold text-[#8C7325] hover:bg-[#F6EBCD]"
        >
          <Gauge className="h-4 w-4" />
          Analisar conversão
        </button>
      </div>

      {analisando && (
        <AnaliseConversao
          etapas={etapasAnalise}
          faturamento={faturamento}
          valorCompras={valorCompras}
          aoFechar={() => setAnalisando(false)}
        />
      )}

      {/* O DINHEIRO, UMA VEZ SÓ.
          Eram dois valores na tela: este e o R$ do card Compras (a soma dos
          eventos `purchase` rastreados). Divergiam por motivo legítimo — o PIX
          pago hoje de um pedido de ontem conta no dia do PEDIDO aqui e no dia
          do PAGAMENTO lá —, mas dois números em verde a três centímetros um do
          outro só fazem duvidar dos dois. Ficou o do pedido pago, que é o
          dinheiro que entrou. */}
      {faturamento && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#CDE9D6] bg-[#F3FAF5] px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <BadgeCheck className="w-4 h-4 text-[#2E7D46]" />
            Faturamento do site no período
            <span className="font-normal text-slate-400">· pedidos pagos, o dinheiro de verdade</span>
          </div>
          <div className="text-right">
            <div className="text-xl font-bold text-[#2E7D46] tabular-nums">{brl(faturamento.valor)}</div>
            <div className="text-xs text-slate-400 tabular-nums">
              {faturamento.pedidos} pedido{faturamento.pedidos === 1 ? '' : 's'} pago{faturamento.pedidos === 1 ? '' : 's'}
            </div>
          </div>
        </div>
      )}

      <p className="text-xs text-slate-400">
        Funil em pessoas (sessões), contando todo mundo — com e sem aceite de cookies. Coleta
        desde 13/08/2026; período anterior aparece zerado. O % é sobre a etapa anterior.
        Compras = pagamento confirmado; o número fiscal é o da tela de Pedidos.{' '}
        <strong className="font-semibold text-slate-600">
          Quem entrou pela página das lojas fica FORA desta conta
        </strong>{' '}
        — veio pra achar a loja, não pra comprar no site; está no quadro logo abaixo.{' '}
        <strong className="font-semibold text-slate-600">Robô também fica de fora</strong> — o de
        user-agent conhecido (Google, IA, SEO) e o disfarçado, que se entrega por carregar a página
        e ir embora sem rolar nem dar um segundo passo.{' '}
        {/* Sem esta frase a tela se contradiz sozinha: o card ao vivo lá em cima
            conta a rede inteira, este funil conta só quem veio comprar. Já
            aconteceu de "565 visitas hoje" aparecer em cima de "173 visitas". */}
        Por isso <strong className="font-semibold text-slate-600">este número é menor que o
        &quot;Visitas hoje&quot; do card ao vivo</strong> — lá entra o site todo, incluindo a
        página das lojas.
      </p>
      {jornada.length > 0 && resumo && (
        <RelatorioJornada
          jornada={jornada}
          problemas={problemas}
          interacoes={interacoes}
          resumo={resumo}
        />
      )}
      {alertasCheckout.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-amber-300 bg-white">
          <div className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            <div>
              <h2 className="font-semibold text-amber-950">Alertas de checkout</h2>
              <p className="text-xs text-amber-800">Sessões com duas ou mais falhas em até dez minutos.</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#FBF6E6] text-slate-600">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">Última falha</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Sessão</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Etapa / pagamento</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Código / pedido</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Tentativas</th>
                </tr>
              </thead>
              <tbody>
                {alertasCheckout.map((a) => (
                  <tr key={a.sessionId} className="border-t border-[#E7E2D8]">
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {new Date(a.ultimaFalha).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-600" title={a.sessionId}>
                      {a.sessionId.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{a.etapa} · {rotuloCodigo(a.pagamento)}</td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {rotuloCodigo(a.codigo)}{a.pedido ? ` · ${a.pedido}` : ''}
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold tabular-nums text-amber-800">{a.tentativas}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {jornada.length === 0 && diagnosticos.length > 0 && (
        <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#E7E2D8]">
            <h2 className="font-semibold text-slate-800">Diagnóstico das decisões e falhas</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Mostra onde a cliente parou, sem armazenar dados pessoais ou dados do cartão.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#FBF6E6] text-slate-600">
                <tr>
                  <th className="text-left px-4 py-2.5 font-semibold">Momento</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Motivo / escolha</th>
                  <th className="text-right px-4 py-2.5 font-semibold">Pessoas</th>
                  <th className="text-right px-4 py-2.5 font-semibold">Tentativas</th>
                </tr>
              </thead>
              <tbody>
                {diagnosticos.map((d, index) => (
                  <tr key={`${d.evento}:${d.codigo}:${d.campo ?? ''}:${index}`} className="border-t border-[#E7E2D8]">
                    <td className="px-4 py-2.5 font-medium text-slate-700">{rotuloDiagnostico(d.evento)}</td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {rotuloCodigo(d.codigo)}{d.campo ? ` · ${rotuloCampo(d.campo)}` : ''}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{d.pessoas}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{d.eventos}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const TITULOS_ETAPA: Record<string, string> = {
  page_view: 'Visita',
  view_item: 'Produto visto',
  add_to_cart: 'Sacola',
  begin_checkout: 'Checkout',
  add_payment_info: 'Pagamento',
  purchase: 'Compra confirmada',
};

function formatarPct(valor: number | null): string {
  if (valor === null) return '—';
  return `${valor.toFixed(valor < 10 ? 1 : 0).replace('.', ',')}%`;
}

function RelatorioJornada({
  jornada,
  problemas,
  interacoes,
  resumo,
}: {
  jornada: LinhaJornada[];
  problemas: ProblemaJornada[];
  interacoes: InteracaoJornada[];
  resumo: ResumoJornada;
}) {
  const maior = resumo.maiorPerda;

  return (
    <div className="space-y-3">
      {maior && (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-amber-800">Maior perda da jornada</p>
            <p className="mt-0.5 font-semibold text-amber-950">
              {TITULOS_ETAPA[maior.evento] ?? maior.evento}: {maior.abandonaram} pessoa{maior.abandonaram === 1 ? '' : 's'} não avançaram
            </p>
            <p className="text-xs text-amber-800">
              {resumo.amostraPequena
                ? 'Amostra pequena: use como indício, não como conclusão.'
                : `Base de ${maior.chegaram} pessoas nesta etapa.`}
            </p>
          </div>
          <div className="text-3xl font-black tabular-nums text-amber-900">{formatarPct(maior.taxaPerda)}</div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-[#E7E2D8] bg-white">
        <div className="border-b border-[#E7E2D8] px-4 py-3">
          <h2 className="font-semibold text-slate-800">Onde a compra parou</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Cada sessão aparece uma única vez na etapa mais avançada que alcançou.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#FBF6E6] text-slate-600">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">Etapa</th>
                <th className="px-4 py-2.5 text-right font-semibold">Chegaram</th>
                <th className="px-4 py-2.5 text-right font-semibold">Avançaram</th>
                <th className="px-4 py-2.5 text-right font-semibold">Pararam aqui</th>
                <th className="px-4 py-2.5 text-right font-semibold">Perda</th>
              </tr>
            </thead>
            <tbody>
              {jornada.map((linha) => (
                <tr key={linha.evento} className="border-t border-[#E7E2D8]">
                  <td className="px-4 py-2.5 font-medium text-slate-700">{TITULOS_ETAPA[linha.evento] ?? linha.evento}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{linha.chegaram}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-[#2E7D46]">{linha.avancaram ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-800">{linha.evento === 'purchase' ? '—' : linha.abandonaram}</td>
                  <td className="px-4 py-2.5 text-right font-bold tabular-nums text-amber-800">{formatarPct(linha.taxaPerda)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(problemas.length > 0 || resumo.pixPendente > 0) && (
        <div className="overflow-hidden rounded-xl border border-rose-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-100 bg-rose-50 px-4 py-3">
            <div>
              <h2 className="font-semibold text-rose-950">Problemas confirmados</h2>
              <p className="text-xs text-rose-800">Falhas reais, separadas das escolhas normais de produto.</p>
            </div>
            <div className="text-xs text-rose-900">
              <strong>{resumo.sessoesComProblema}</strong> sessões com problema ·{' '}
              <strong className="text-[#2E7D46]">{resumo.sessoesRecuperadas}</strong> recuperadas
            </div>
          </div>
          {resumo.pixPendente > 0 && (
            <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm">
              <span className="font-medium text-amber-950">Pix criado, ainda sem compra confirmada no período</span>
              <strong className="tabular-nums text-amber-900">{resumo.pixPendente}</strong>
            </div>
          )}
          {problemas.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold">Problema</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Motivo</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Pessoas</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Ocorrências</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Recuperadas</th>
                  </tr>
                </thead>
                <tbody>
                  {problemas.map((linha, index) => (
                    <tr key={`${linha.evento}:${linha.codigo}:${linha.campo ?? ''}:${index}`} className="border-t border-[#E7E2D8]">
                      <td className="px-4 py-2.5 font-medium text-slate-700">{rotuloDiagnostico(linha.evento)}</td>
                      <td className="px-4 py-2.5 text-slate-600">{rotuloCodigo(linha.codigo)}{linha.campo ? ` · ${rotuloCampo(linha.campo)}` : ''}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{linha.pessoas}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{linha.ocorrencias}</td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-[#2E7D46]">{linha.recuperadas}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {interacoes.length > 0 && (
        <details className="overflow-hidden rounded-xl border border-[#E7E2D8] bg-white">
          <summary className="cursor-pointer px-4 py-3 font-semibold text-slate-700 hover:bg-[#FBF6E6]">
            O que as clientes compararam
            <span className="ml-2 text-xs font-normal text-slate-500">cores, tamanhos, frete e pagamento — não são erros</span>
          </summary>
          <div className="border-t border-[#E7E2D8]">
            <p className="px-4 py-2 text-xs text-slate-500">
              A mesma pessoa pode comparar várias opções; por isso as linhas abaixo não devem ser somadas.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FBF6E6] text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold">Interação</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Escolha</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Pessoas</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Interações</th>
                  </tr>
                </thead>
                <tbody>
                  {interacoes.map((linha, index) => (
                    <tr key={`${linha.evento}:${linha.codigo}:${index}`} className="border-t border-[#E7E2D8]">
                      <td className="px-4 py-2.5 font-medium text-slate-700">{rotuloDiagnostico(linha.evento)}</td>
                      <td className="px-4 py-2.5 text-slate-600">{rotuloCodigo(linha.codigo)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{linha.pessoas}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{linha.interacoes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

/* ═══════════ O MAPA DO TRÁFEGO DE LOJAS (dono, 16/08) ═══════════
 *
 * "pessoas que entraram pelo /lojas não contam no funil de ecomm, pois elas
 * andam pelo site mas acabam sem comprar — mas crie um mapa disso mostrando
 * que tipo de conversão este tráfego nos traz."
 *
 * Sair do funil não é sumir. Esta gente converte em CONTATO com a loja, e o
 * quadro põe as duas leituras lado a lado: o que ela veio fazer (falar com a
 * unidade) e o que ela acabou fazendo no site mesmo assim — porque uma parte
 * compra, e essa venda não pode ficar sem dono.
 */
function TrafegoDeLojas({ dados }: { dados: TrafegoLojas }) {
  const { pessoas, contataram, contatos, navegaram, valorComprado, porUnidade, porCampanha } = dados;
  if (!pessoas) return null;

  const pct = (n: number) => (pessoas > 0 ? Math.round((n / pessoas) * 100) : 0);
  const blocos = [
    { titulo: 'Chegaram pela /lojas', valor: pessoas, sub: 'fora do funil do site' },
    { titulo: 'Falaram com a loja', valor: contataram, sub: `${pct(contataram)}% de quem chegou` },
    { titulo: 'Olharam peça', valor: navegaram.viramPeca, sub: `${pct(navegaram.viramPeca)}% passearam no catálogo` },
    { titulo: 'Compraram no site', valor: navegaram.compraram, sub: valorComprado > 0 ? brl(valorComprado) : 'mesmo sem ser o objetivo' },
  ];

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
        Tráfego de lojas — o que ele converte
      </h2>

      <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-hidden">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-[#E7E2D8]">
          {blocos.map((b) => (
            <div key={b.titulo} className="px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{b.titulo}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-800">{b.valor}</p>
              <p className="text-xs text-slate-500">{b.sub}</p>
            </div>
          ))}
        </div>

        <div className="border-t border-[#E7E2D8] px-4 py-3 text-sm text-slate-600">
          <span className="font-semibold text-slate-700">Como falaram: </span>
          WhatsApp {contatos.whatsapp} · Como chegar {contatos.comoChegar} · Telefone {contatos.telefone} · Instagram {contatos.instagram}
          <span className="ml-2 text-slate-400">
            (sacola {navegaram.sacola} · checkout {navegaram.checkout})
          </span>
        </div>
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#E7E2D8]">
            <h3 className="font-semibold text-slate-800 text-sm">Qual unidade recebeu o contato</h3>
          </div>
          {porUnidade.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate-500">
              Ninguém clicou pra falar com loja nesse período.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {porUnidade.map((u) => (
                  <tr key={u.loja} className="border-t border-[#E7E2D8] first:border-t-0">
                    <td className="px-4 py-2 text-slate-700">{u.loja}</td>
                    <td className="px-4 py-2 text-right font-bold tabular-nums text-slate-800">{u.contatos}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#E7E2D8]">
            <h3 className="font-semibold text-slate-800 text-sm">De qual anúncio vieram</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Vem do UTM do link. Sessão antes de 16/08 — ou visita orgânica — aparece como “sem campanha”.
            </p>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {porCampanha.map((c) => (
                <tr key={`${c.campanha}:${c.canal ?? ''}`} className="border-t border-[#E7E2D8] first:border-t-0">
                  <td className="px-4 py-2 text-slate-700">
                    {c.campanha}
                    {c.canal && <span className="text-slate-400"> · {c.canal}</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-bold tabular-nums text-slate-800">{c.pessoas}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════ ANÁLISE DE CONVERSÃO (dono, 15/08) ══════════════════
 *
 * O funil já mostrava o % de cada etapa. Faltava a pergunta que vem logo
 * depois — "isso é bom ou é ruim?". Aqui cada etapa aparece ao lado da FAIXA
 * ESPERADA pra e-commerce de MODA FEMININA, com o veredito na cara.
 *
 * ⚠️ As faixas são REFERÊNCIA DE MERCADO (moda/vestuário, tráfego misto
 * mobile+desktop), não lei — servem pra dizer "olhe aqui primeiro", não pra
 * carimbar nota. Duas leituras honestas antes de agir:
 *
 *  1. AMOSTRA. Com 18 pessoas no pagamento, cada uma vale 5,5 pontos de
 *     percentual: a etapa pula de "ótimo" pra "péssimo" com 2 pessoas de
 *     diferença. Por isso a tela marca as etapas com base < 50 pessoas como
 *     indício, não veredito.
 *  2. O ALVO DE VERDADE é a NOSSA série histórica. A faixa de mercado é o
 *     mapa enquanto a nossa medição é nova (coleta desde 13/08).
 */

type FaixaEtapa = {
  de: string;               // evento denominador
  para: string;             // evento numerador
  titulo: string;
  /** Piso e teto da faixa de mercado (%) — moda/vestuário. */
  piso: number;
  teto: number;
  /** O que costuma explicar essa etapa quando ela está baixa. */
  causa: string;
};

const FAIXAS: FaixaEtapa[] = [
  {
    de: 'page_view', para: 'view_item', titulo: 'Entrou → abriu uma peça',
    piso: 40, teto: 65,
    causa: 'vitrine e busca: se a home/categoria não puxa pra ficha, o resto do funil nem começa',
  },
  {
    de: 'view_item', para: 'add_to_cart', titulo: 'Abriu a peça → botou na sacola',
    piso: 8, teto: 15,
    causa: 'foto, tamanho disponível, preço e frete na ficha — é aqui que a régua de tamanho pesa',
  },
  {
    de: 'add_to_cart', para: 'begin_checkout', titulo: 'Sacola → começou o checkout',
    piso: 45, teto: 65,
    causa: 'susto de frete/prazo e sacola sem urgência',
  },
  {
    de: 'begin_checkout', para: 'add_payment_info', titulo: 'Checkout → escolheu pagamento',
    piso: 55, teto: 75,
    causa: 'formulário longo, CEP/entrega travando, cupom que não aceita',
  },
  {
    de: 'add_payment_info', para: 'purchase', titulo: 'Pagamento → compra confirmada',
    piso: 50, teto: 75,
    causa: 'cartão recusado, PIX que expira sem pagar, erro no gateway',
  },
];

/** Conversão da loja inteira: visita → compra. Moda feminina fica em ~1–2,5%. */
const FAIXA_GERAL = { piso: 1.0, teto: 2.5 };

type Veredito = 'acima' | 'dentro' | 'abaixo' | 'critico' | 'sem-dado';

function julgar(taxa: number | null, piso: number, teto: number): Veredito {
  if (taxa === null) return 'sem-dado';
  if (taxa > teto) return 'acima';
  if (taxa >= piso) return 'dentro';
  // Menos da metade do piso não é "abaixo", é buraco — merece cor própria.
  return taxa >= piso / 2 ? 'abaixo' : 'critico';
}

const ESTILO_VEREDITO: Record<Veredito, { rotulo: string; classe: string; barra: string }> = {
  acima:     { rotulo: 'Acima do esperado', classe: 'bg-[#E8F3EC] text-[#1F5C33] border-[#CDE9D6]', barra: 'bg-[#2E7D46]' },
  dentro:    { rotulo: 'Dentro do esperado', classe: 'bg-[#E8F3EC] text-[#1F5C33] border-[#CDE9D6]', barra: 'bg-[#2E7D46]' },
  abaixo:    { rotulo: 'Abaixo do esperado', classe: 'bg-amber-50 text-amber-900 border-amber-300', barra: 'bg-amber-500' },
  critico:   { rotulo: 'Muito abaixo', classe: 'bg-rose-50 text-rose-900 border-rose-300', barra: 'bg-rose-600' },
  'sem-dado': { rotulo: 'Sem dado', classe: 'bg-slate-100 text-slate-500 border-slate-200', barra: 'bg-slate-300' },
};

/** 69 → "69%" · 1,23 → "1,2%". Decimal só quando ele diz alguma coisa. */
const pct = (n: number) =>
  `${(Number.isInteger(n) ? String(n) : n.toFixed(1)).replace('.', ',')}%`;

function AnaliseConversao({
  etapas,
  faturamento,
  valorCompras,
  aoFechar,
}: {
  etapas: Array<{ evento: string; titulo: string; pessoas: number }>;
  faturamento?: { pedidos: number; valor: number };
  valorCompras: number;
  aoFechar: () => void;
}) {
  const pessoasDe = (evento: string) =>
    etapas.find((e) => e.evento === evento)?.pessoas ?? 0;

  const visitas = pessoasDe('page_view');
  const compras = pessoasDe('purchase');

  const linhas = FAIXAS.map((f) => {
    const base = pessoasDe(f.de);
    const chegou = pessoasDe(f.para);
    const taxa = base > 0 ? (chegou / base) * 100 : null;
    return {
      ...f,
      base,
      chegou,
      taxa,
      veredito: julgar(taxa, f.piso, f.teto),
      // Base pequena = a etapa pula de ótima pra péssima com 2 pessoas.
      poucaBase: base > 0 && base < 50,
    };
  });

  const taxaGeral = visitas > 0 ? (compras / visitas) * 100 : null;
  const vereditoGeral = julgar(taxaGeral, FAIXA_GERAL.piso, FAIXA_GERAL.teto);

  /**
   * MAIOR VAZAMENTO — a etapa que mais perde gente em relação ao PISO da
   * faixa. Compara em PESSOAS, não em pontos percentuais: 10 pontos abaixo em
   * cima de 400 pessoas dói muito mais que 10 pontos em cima de 18.
   */
  const comPerda = linhas
    .filter((l) => l.taxa !== null && (l.veredito === 'abaixo' || l.veredito === 'critico'))
    .map((l) => ({ ...l, perdidas: Math.round(l.base * (l.piso / 100) - l.chegou) }))
    .filter((l) => l.perdidas > 0)
    .sort((a, b) => b.perdidas - a.perdidas);
  const gargalo = comPerda[0] ?? null;

  /**
   * Quanto essas pessoas valeriam: leva as recuperadas pelo resto do funil
   * usando as NOSSAS taxas de hoje (não as de mercado — seria empilhar
   * otimismo em cima de otimismo) e multiplica pelo ticket médio real.
   */
  const ticket = faturamento && faturamento.pedidos > 0
    ? faturamento.valor / faturamento.pedidos
    : compras > 0 ? valorCompras / compras : 0;

  let comprasExtra = 0;
  if (gargalo) {
    const iGargalo = linhas.findIndex((l) => l.para === gargalo.para);
    const restante = linhas.slice(iGargalo + 1);
    comprasExtra = restante.reduce(
      (acc, l) => acc * (l.taxa !== null ? l.taxa / 100 : 0),
      gargalo.perdidas,
    );
  }
  const dinheiroExtra = comprasExtra * ticket;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onClick={aoFechar}
    >
      <div
        className="my-6 w-full max-w-3xl rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-[#E7E2D8] px-5 py-4">
          <Gauge className="mt-0.5 h-5 w-5 text-[#B8912B]" />
          <div className="flex-1">
            <h2 className="text-lg font-bold text-slate-800">Análise de conversão</h2>
            <p className="text-sm text-slate-500">
              Cada etapa do período comparada com a faixa de e-commerce de moda feminina.
            </p>
          </div>
          <button onClick={aoFechar} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" title="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          {/* VEREDITO GERAL */}
          <div className="rounded-xl border border-[#E7E2D8] bg-[#FAFAF7] p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">
                  Conversão da loja (visita → compra)
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-4xl font-extrabold tabular-nums text-slate-800">
                    {taxaGeral === null ? '—' : pct(taxaGeral)}
                  </span>
                  <span className="text-sm text-slate-500 tabular-nums">
                    {compras} de {visitas} pessoas
                  </span>
                </div>
              </div>
              <span className={`rounded-full border px-3 py-1 text-sm font-bold ${ESTILO_VEREDITO[vereditoGeral].classe}`}>
                {ESTILO_VEREDITO[vereditoGeral].rotulo}
              </span>
            </div>
            <BarraFaixa
              taxa={taxaGeral} piso={FAIXA_GERAL.piso} teto={FAIXA_GERAL.teto}
              escala={4} veredito={vereditoGeral}
            />
            <p className="mt-2 text-xs text-slate-500">
              Esperado em moda feminina: <b>{pct(FAIXA_GERAL.piso)} a {pct(FAIXA_GERAL.teto)}</b> das visitas
              viram compra.
            </p>
          </div>

          {/* ETAPA POR ETAPA */}
          <div className="space-y-3">
            {linhas.map((l) => {
              const est = ESTILO_VEREDITO[l.veredito];
              return (
                <div key={l.para} className="rounded-xl border border-[#E7E2D8] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-slate-800">{l.titulo}</div>
                    <div className="flex items-center gap-2">
                      {l.poucaBase && (
                        <span
                          className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500"
                          title="Menos de 50 pessoas na base: 1 ou 2 clientes já viram o número de lado. Leia como indício."
                        >
                          amostra pequena
                        </span>
                      )}
                      <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${est.classe}`}>
                        {est.rotulo}
                      </span>
                    </div>
                  </div>

                  <div className="mt-1 flex items-baseline gap-3">
                    <span className="text-2xl font-bold tabular-nums text-slate-800">
                      {l.taxa === null ? '—' : pct(l.taxa)}
                    </span>
                    <span className="text-xs text-slate-500 tabular-nums">
                      {l.chegou} de {l.base}
                    </span>
                    <span className="ml-auto text-xs text-slate-500">
                      esperado <b className="text-slate-700">{l.piso}% a {l.teto}%</b>
                    </span>
                  </div>

                  <BarraFaixa taxa={l.taxa} piso={l.piso} teto={l.teto} escala={100} veredito={l.veredito} />

                  {(l.veredito === 'abaixo' || l.veredito === 'critico') && (
                    <p className="mt-2 text-xs text-slate-600">
                      <b>Onde costuma estar:</b> {l.causa}.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* O QUE FAZER PRIMEIRO */}
          {gargalo ? (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                <div className="text-sm text-amber-950">
                  <div className="font-bold">
                    Comece por: {gargalo.titulo.toLowerCase()}
                  </div>
                  <p className="mt-1 leading-snug">
                    Está em <b>{gargalo.taxa === null ? '—' : pct(gargalo.taxa)}</b> quando o piso do
                    segmento é <b>{gargalo.piso}%</b> — <b>{gargalo.perdidas} pessoas</b> a menos
                    passaram dessa etapa no período.
                    {comprasExtra >= 0.5 && (
                      <>
                        {' '}Só voltar ao piso, mantendo o resto do funil como está hoje, daria
                        aproximadamente <b>{Math.round(comprasExtra)} compra
                        {Math.round(comprasExtra) === 1 ? '' : 's'}</b>
                        {ticket > 0 && <> (~<b>{brl(dinheiroExtra)}</b>)</>}.
                      </>
                    )}
                  </p>
                  <p className="mt-1.5 leading-snug">{gargalo.causa}.</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-[#CDE9D6] bg-[#F3FAF5] p-4 text-sm text-[#1F5C33]">
              <b>Nenhuma etapa abaixo da faixa no período.</b> Quando todas passam, o ganho
              vem de trazer mais gente (tráfego), não de consertar o funil.
            </div>
          )}

          {/* METODOLOGIA — sem isso o número vira opinião */}
          <div className="rounded-xl bg-[#FAFAF7] p-4 text-xs leading-relaxed text-slate-500">
            <b className="text-slate-600">Como ler:</b> as faixas são referência de mercado pra
            moda/vestuário (tráfego misto celular + computador) e servem pra apontar onde olhar
            primeiro, não pra dar nota. O alvo que vale de verdade é a nossa própria série
            histórica — a coleta começou em 13/08/2026, então ainda é curta. Etapa marcada como
            <b> amostra pequena</b> tem menos de 50 pessoas na base: 1 ou 2 clientes já mudam o
            veredito. O dinheiro estimado usa o ticket médio real do período
            {ticket > 0 ? ` (${brl(ticket)})` : ''} e as nossas taxas atuais nas etapas seguintes.
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A régua: trilho 0→escala, faixa esperada pintada e o nosso número como
 * marcador. É o que faz "dentro/fora" ser visto antes de ser lido.
 */
function BarraFaixa({
  taxa, piso, teto, escala, veredito,
}: { taxa: number | null; piso: number; teto: number; escala: number; veredito: Veredito }) {
  const posicao = (v: number) => `${Math.min(100, Math.max(0, (v / escala) * 100))}%`;
  return (
    <div className="mt-2.5">
      <div className="relative h-3 w-full rounded-full bg-slate-100">
        {/* faixa esperada */}
        <div
          className="absolute top-0 h-3 rounded-full bg-[#CDE9D6]"
          style={{ left: posicao(piso), width: `calc(${posicao(teto)} - ${posicao(piso)})` }}
          title={`Faixa esperada: ${piso}% a ${teto}%`}
        />
        {/* nosso número */}
        {taxa !== null && (
          <div
            className={`absolute -top-0.5 h-4 w-1.5 rounded-full ring-2 ring-white ${ESTILO_VEREDITO[veredito].barra}`}
            style={{ left: posicao(taxa) }}
            title={`Nós: ${pct(taxa)}`}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>0%</span>
        <span>faixa esperada {pct(piso)} a {pct(teto)}</span>
        <span>{pct(escala)}</span>
      </div>
    </div>
  );
}

const ROTULOS_EVENTO: Record<string, string> = {
  color_switch: 'Escolha de cor',
  size_switch: 'Escolha de tamanho',
  add_to_cart_blocked: 'Sacola bloqueada',
  add_shipping_info: 'Frete escolhido',
  add_payment_info: 'Pagamento escolhido',
  checkout_submission: 'Tentativa de pagamento',
  checkout_error: 'Falha ao finalizar',
  checkout_validation_error: 'Campo inválido',
  pix_created: 'PIX criado',
  payment_method_selected: 'Meio de pagamento escolhido',
  pix_copied: 'Código PIX copiado',
  pix_expired: 'PIX expirado',
  card_declined: 'Cartão recusado',
  payment_retry: 'Nova tentativa de pagamento',
  checkout_recovered: 'Checkout recuperado',
};

const ROTULOS_CODIGO: Record<string, string> = {
  size_missing: 'Tamanho não escolhido',
  sold_out: 'Produto esgotado',
  card_declined: 'Cartão não aprovado',
  catalog_unavailable: 'Produto, estoque ou preço alterado',
  coupon_invalid: 'Cupom não aceito',
  shipping_invalid: 'Entrega não confirmada',
  validation_error: 'Dados do pedido incompletos',
  rate_limited: 'Tentativas demais em pouco tempo',
  payment_unavailable: 'Pagamento indisponível',
  internal_error: 'Erro interno',
  api_rejected: 'Motivo não detalhado (dado antigo)',
  invalid_response: 'Resposta inválida do servidor',
  network_error: 'Falha de conexão',
  identification: 'Identificação',
  shipping: 'Entrega',
  pix: 'PIX',
  card: 'Cartão',
};

function rotuloDiagnostico(evento: string): string {
  return ROTULOS_EVENTO[evento] ?? evento;
}

function rotuloCodigo(codigo: string): string {
  return ROTULOS_CODIGO[codigo] ?? codigo;
}

const ROTULOS_CAMPO: Record<string, string> = {
  name: 'nome', email: 'e-mail', cpf: 'CPF', phone: 'celular',
  street: 'rua', number: 'número', neighborhood: 'bairro', city: 'cidade', uf: 'UF',
  shipping_method: 'forma de entrega',
  card_number: 'número do cartão', holder: 'nome no cartão', expiry: 'validade', cvv: 'CVV',
  // Campos que o SERVIDOR reprova no envio do pedido (o site passou a mandar
  // o nome do campo junto do erro em 15/08). Antes disto, "Dados do pedido
  // incompletos" não dizia qual dado.
  complement: 'complemento', cep: 'CEP',
  endereco_ausente: 'endereço não veio', shippingQuoteId: 'frete escolhido',
  paymentMethod: 'forma de pagamento', installments: 'parcelas', cardToken: 'token do cartão',
  couponCode: 'cupom', total: 'total do pedido', corpo_ilegivel: 'pedido ilegível',
  item_size: 'tamanho da peça', item_image_src: 'foto da peça', item_unitPrice: 'preço da peça',
  item_name: 'nome da peça', item_quantity: 'quantidade', item_color: 'cor da peça',
  backend_validacao: 'recusado na validação do backend',
};

function rotuloCampo(campo: string): string {
  return ROTULOS_CAMPO[campo] ?? campo;
}
