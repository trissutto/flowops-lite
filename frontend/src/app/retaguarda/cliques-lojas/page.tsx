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
  ArrowLeft, BadgeCheck, CreditCard, Eye, Instagram, Loader2, MapPin,
  MessageCircle, Phone, RefreshCw, ShoppingBag, ShoppingCart, Users,
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
 */
type Agora = {
  ativos5min: number;
  ativos30min: number;
  sessoesHoje: number;
  pageViewsHoje: number;
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
type RespostaFunil = {
  de: string;
  ate: string;
  etapas: EtapaFunil[];
  diagnosticos?: DiagnosticoFunil[];
  faturamento?: { pedidos: number; valor: number };
};

/**
 * Data 'YYYY-MM-DD' SEMPRE em Brasília, independente do fuso do PC. Era
 * `d.toISOString().slice(0,10)` — UTC: depois das 21h de Brasília o "Hoje"
 * pulava pra amanhã e a tela abria vazia. `en-CA` formata como YYYY-MM-DD.
 */
const fmtDataBr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
const iso = (d: Date) => fmtDataBr.format(d);
const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function CliquesLojasPage() {
  // ABRE EM HOJE (dono, 15/08): a pergunta de todo dia é "como foi HOJE?", não
  // "os últimos 30 dias". Os atalhos e o "Limpar (30 dias)" seguem na mão.
  const [de, setDe] = useState(() => iso(new Date()));
  const [ate, setAte] = useState(() => iso(new Date()));
  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [agora, setAgora] = useState<Agora | null>(null);
  const [funil, setFunil] = useState<RespostaFunil | null>(null);

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
    try {
      const qs = new URLSearchParams();
      if (de) qs.set('de', de);
      if (ate) qs.set('ate', ate);
      const sufixo = qs.toString() ? `?${qs}` : '';
      // Funil em paralelo e tolerante: se falhar, a tela de cliques segue de pé.
      const [r, f] = await Promise.all([
        api<Resposta>(`/site-metrics/lojas${sufixo}`),
        api<RespostaFunil>(`/site-metrics/funil${sufixo}`).catch(() => null),
      ]);
      setDados(r);
      setFunil(f);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar');
    } finally {
      setCarregando(false);
    }
  }, [de, ate]);

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

      {/* O FUNIL — acima do bloco de cliques de propósito: dia sem clique de
          loja ainda tem funil, e um não pode esconder o outro. */}
      {funil && <FunilSite etapas={funil.etapas} diagnosticos={funil.diagnosticos ?? []} faturamento={funil.faturamento} />}

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
}: {
  etapas: EtapaFunil[];
  diagnosticos: DiagnosticoFunil[];
  faturamento?: { pedidos: number; valor: number };
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

  let anterior: number | null = null;
  const cards = ordem.map((o) => {
    const dado = por.get(o.evento);
    const pessoas = dado?.pessoas ?? 0;
    const pct = anterior !== null && anterior > 0 ? Math.round((pessoas / anterior) * 100) : null;
    anterior = pessoas;
    return { ...o, pessoas, eventos: dado?.eventos ?? 0, pct, valor: dado?.valor ?? 0 };
  });

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {cards.map((c) => (
          <div key={c.evento} className="bg-white border border-[#E7E2D8] rounded-xl p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs font-semibold uppercase tracking-wide">
              {c.icone} {c.titulo}
            </div>
            <div className={`mt-2 text-2xl font-bold tabular-nums ${c.evento === 'purchase' ? 'text-[#2E7D46]' : 'text-slate-800'}`}>
              {c.pessoas}
            </div>
            {/* VALOR DE CONVERSÃO (dono, 15/08): o R$ somado das compras
                confirmadas do período, colado no card Compras. */}
            {c.evento === 'purchase' && (
              <div
                className="text-sm font-bold text-[#2E7D46] tabular-nums"
                title="Valor de conversão — R$ somado das compras confirmadas no período"
              >
                {brl(c.valor)}
              </div>
            )}
            <div className="text-xs text-slate-400 tabular-nums">
              {c.eventos} evento{c.eventos === 1 ? '' : 's'}
              {c.pct !== null && <span className="ml-1 font-semibold text-[#B8912B]">· {c.pct}%</span>}
            </div>
          </div>
        ))}
      </div>

      {/* FATURAMENTO REAL (dono, 15/08) — a Fonte B, numa linha SEPARADA do
          valor de conversão do funil de propósito: aqui é o DINHEIRO (pedidos
          pagos, inclusive quem veio por e-mail/orgânico e o PIX pago depois);
          lá no card Compras é a conversão das sessões rastreadas. As duas
          divergem e cada uma responde uma pergunta diferente. */}
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
        Compras = pagamento confirmado; o número fiscal é o da tela de Pedidos.
      </p>
      {diagnosticos.length > 0 && (
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
};

function rotuloCampo(campo: string): string {
  return ROTULOS_CAMPO[campo] ?? campo;
}
