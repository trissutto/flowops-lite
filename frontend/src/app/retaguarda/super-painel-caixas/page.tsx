'use client';
import { overlayClose } from '@/lib/overlayClose';
import { horaBr } from '@/lib/hora-br';

/**
 * /retaguarda/super-painel-caixas
 *
 * Painel ao vivo das lojas: status do caixa, totais por modalidade,
 * movimento de caixa e ranking de vendedoras. Auto-refresh a cada 60s.
 *
 * 04/08: passou a mostrar UMA loja por vez (seleção pelo nome) em vez de um
 * grid com todos os cards — o movimento de caixa não cabia numa coluna de 1/3
 * de tela. O card selecionado ocupa a largura toda e traz o próprio filtro de
 * data (Hoje / Ontem / Livre).
 */

import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import {
  ArrowLeft, RefreshCw, Loader2, AlertCircle, Banknote, QrCode, CreditCard,
  TrendingUp, Lock, Unlock, Trophy, ShieldCheck, ShieldAlert, ShieldX, HelpCircle,
  ChevronDown, ChevronUp, Globe, Store,
} from 'lucide-react';
import { api } from '@/lib/api';

type Slot = {
  valor: number;
  qtd: number;
  vendas: Array<{
    saleId: string;
    saleTotal: number;
    paymentId: string;
    method: string;
    bandeira?: string | null;
    valor: number;
    // Venda online: COMO o dinheiro entrou — 'pix' (PIX direto na chave da
    // loja), 'link' (link externo, pago por fora) ou 'pagarme_link' (link de
    // cartão gerado pelo Flow). Vem de details.tipo do pagamento.
    onlineTipo?: string | null;
    customerName: string | null;
    customerCpf: string | null;
    sellerName: string | null;
    finalizedAt: string | null;
    parcelas?: number;
  }>;
};
type Detalhado = {
  totais: {
    DINHEIRO: Slot; PIX: Slot; CREDIARIO: Slot;
    MASTERCARD: Slot; VISANET: Slot; CIELO: Slot; ELO: Slot; AMEX: Slot; HIPERCARD: Slot;
    VISA_ELECTRON: Slot; REDE_SHOP: Slot; ELO_DEBITO?: Slot;
    CREDITO_GENERICO: Slot; DEBITO_GENERICO: Slot; OUTROS: Slot;
    // Venda online (WhatsApp/Instagram): dinheiro recebido que não passa pela
    // gaveta. Estava no payload mas não tinha card no painel.
    VENDA_ONLINE?: Slot; VALE_TROCA?: Slot;
  };
};
type Vendedora = { nome: string; qtd: number; total: number };
type Movimento = {
  id: string;
  tipo: string;        // 'sangria' | 'suprimento'
  valor: number;
  motivo: string;
  userName: string | null;
  createdAt: string;
  // Retirada de FECHAMENTO: sangria gerada na abertura do caixa seguinte com o
  // valor contado. Fica FORA de totalSangrias — é o dinheiro que virou fundo do
  // dia seguinte, não uma saída operacional.
  isFechamento?: boolean;
};
type BaixaCrediario = {
  id: string;
  forma: string;             // 'dinheiro' | 'pix' | 'misto'
  origem: string | null;     // 'presencial' | 'link' | null
  valor: number;
  valorDinheiro: number | null;
  valorPix: number | null;
  customerName: string | null;
  paidAt: string;
};
type RecebimentosCrediario = {
  totalGeral: number;
  totalDinheiro: number;
  totalPix: number;
  baixas: BaixaCrediario[];
};
type Loja = {
  storeCode: string;
  storeName: string;
  sessionId: string | null;
  aberta: boolean;
  // Vendeu hoje mas o caixa já foi fechado. Antes essa loja aparecia zerada e
  // ficava FORA do total da rede (01/08: R$ 12.991,17 escondidos em 3 lojas).
  caixaFechadoComVenda?: boolean;
  sessaoPendente?: boolean;            // sessão de outro dia ainda não fechada
  sessaoPendenteAbertaEm?: string | null;
  openedAt: string | null;
  openedByName: string | null;
  fundoTroco: number;
  // ── Conferência manual de caixa (admin marca dia anterior como "conferido")
  checkedAt?: string | null;
  checkedByName?: string | null;
  checkedNote?: string | null;
  sessionsDoDia?: string[]; // IDs das sessões do dia (modo histórico)
  // ── RÉGUA OFICIAL DO FATURAMENTO (dono, 04/08) ──
  // faturamento = vendido − vale-troca − devoluções(dinheiro/pix), frete DENTRO
  // (frete é dinheiro que entrou; o que ele não faz é comissionar) e desconto
  // já embutido no total da venda. Calculado no backend — a tela nunca refaz.
  faturamento?: number;
  totalDevolucoes?: number;
  totalDevolucoesDinheiro?: number;
  totalDevolucoesPix?: number;
  totalFrete?: number;
  totais: {
    totalVendas: number;
    totalDinheiro: number;
    totalPix: number;
    totalCartaoCredito: number;
    totalCartaoDebito: number;
    totalCrediario: number;
    totalVendaOnline?: number;
    totalValeTroca?: number;
    totalSangrias: number;
    totalSuprimentos: number;
    totalFechamento?: number;   // retirada de fechamento (contagem da abertura seguinte)
    dinheiroEsperado: number;
    qtdVendas: number;
  };
  vendedoras: Vendedora[];
  movimentos?: Movimento[];
  recebimentosCrediario?: RecebimentosCrediario;
  detalhado: Detalhado | null;
};
type PixConcStatus = {
  storeCode: string;
  pixLancadoPdv: number;
  pixConfirmadoStone: number;
  diferenca: number;
  qtdLancadoPdv: number;
  qtdConfirmadoStone: number;
  qtdCasados: number;
  qtdDivergentesPdv: number;
  qtdOrfasStone: number;
  status: 'ok' | 'atencao' | 'divergente' | 'sem_stone';
};

type Painel = {
  lojas: Loja[];
  consolidado: {
    totalVendas: number;
    totalDinheiro: number;
    totalPix: number;
    totalCartaoCredito: number;
    totalCartaoDebito: number;
    totalCrediario: number;
    totalVendaOnline?: number;
    totalValeTroca?: number;
    faturamento?: number;
    totalDevolucoes?: number;
    totalDevolucoesDinheiro?: number;
    totalDevolucoesPix?: number;
    totalFrete?: number;
    totalSangrias: number;
    totalSuprimentos: number;
    qtdVendas: number;
    qtdLojasAbertas: number;
    qtdLojasFechadas: number;
  };
  generatedAt: string;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ─────────────────────────────────────────────────────────────────────────
// Selo de conciliação PIX (mostrado ao lado do valor PIX em cada loja)
// ─────────────────────────────────────────────────────────────────────────
function PixBadge({ s }: { s: PixConcStatus | undefined }) {
  if (!s) return null;
  if (s.status === 'ok') {
    return (
      <span
        title={`PIX conciliado com Stone. ${s.qtdCasados} casados.`}
        className="inline-flex items-center gap-1 text-[9px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1 py-0"
      >
        <ShieldCheck size={9} /> ok
      </span>
    );
  }
  if (s.status === 'atencao') {
    return (
      <span
        title={`Diferença pequena: R$ ${s.diferenca.toFixed(2)}. PDV: R$ ${s.pixLancadoPdv.toFixed(2)} · Stone: R$ ${s.pixConfirmadoStone.toFixed(2)}`}
        className="inline-flex items-center gap-1 text-[9px] text-amber-700 bg-amber-50 border border-amber-300 rounded px-1 py-0"
      >
        <ShieldAlert size={9} /> ±{brl(s.diferenca)}
      </span>
    );
  }
  if (s.status === 'divergente') {
    return (
      <span
        title={`DIVERGÊNCIA: PDV R$ ${s.pixLancadoPdv.toFixed(2)} vs Stone R$ ${s.pixConfirmadoStone.toFixed(2)}. ${s.qtdDivergentesPdv} venda(s) PDV sem confirmação. ${s.qtdOrfasStone} PIX Stone sem venda.`}
        className="inline-flex items-center gap-1 text-[9px] text-red-700 bg-red-50 border border-red-300 rounded px-1 py-0 font-semibold"
      >
        <ShieldX size={9} /> {brl(s.diferenca)}
      </span>
    );
  }
  // sem_stone
  return (
    <span
      title="PIX lançado no PDV mas a Stone não confirmou nenhum. Loja pode estar usando outro recebedor ou webhook falhou."
      className="inline-flex items-center gap-1 text-[9px] text-slate-600 bg-slate-100 border border-slate-300 rounded px-1 py-0"
    >
      <HelpCircle size={9} /> sem Stone
    </span>
  );
}


/**
 * VENDA ONLINE — formatos possíveis (details.tipo gravado pelo PDV).
 * Os rótulos seguem os mesmos botões que a vendedora vê ao fechar a venda.
 */
const ONLINE_FORMATOS: Array<{ key: string; label: string; curto: string }> = [
  { key: 'pix', label: 'PIX direto (chave da loja)', curto: 'PIX direto' },
  { key: 'link', label: 'Link externo (pago por fora)', curto: 'Link externo' },
  { key: 'pagarme_link', label: 'Link Pagar.me (cartão)', curto: 'Link cartão' },
  { key: '', label: 'Formato não informado', curto: 'Sem formato' },
];

/** Agrupa as vendas online por formato (só os formatos que tiveram venda). */
function resumoOnlinePorFormato(detalhado: Detalhado | null) {
  const vendas = detalhado?.totais?.VENDA_ONLINE?.vendas || [];
  return ONLINE_FORMATOS
    .map((f) => {
      const doTipo = vendas.filter((v) => String(v.onlineTipo || '') === f.key);
      return {
        ...f,
        vendas: doTipo,
        qtd: doTipo.length,
        valor: doTipo.reduce((a, v) => a + (Number(v.valor) || 0), 0),
      };
    })
    .filter((f) => f.qtd > 0);
}

/** Mesmo resumo, somando TODAS as lojas (faixa do card consolidado). */
function resumoOnlineRede(lojas: Loja[]) {
  const acc = new Map<string, { qtd: number; valor: number }>();
  for (const l of lojas || []) {
    for (const f of resumoOnlinePorFormato(l.detalhado)) {
      const cur = acc.get(f.key) || { qtd: 0, valor: 0 };
      acc.set(f.key, { qtd: cur.qtd + f.qtd, valor: cur.valor + f.valor });
    }
  }
  return ONLINE_FORMATOS
    .map((f) => ({ ...f, ...(acc.get(f.key) || { qtd: 0, valor: 0 }) }))
    .filter((f) => f.qtd > 0);
}

/**
 * Soma das FORMAS DE PAGAMENTO (sem vale-troca — vale não é dinheiro novo,
 * é crédito de peça devolvida cuja venda original já foi contada).
 * Crediário entra: é venda faturada no dia, mesmo que o dinheiro entre depois.
 */
function somaFormas(t: any): number {
  return (
    (t?.totalDinheiro || 0) +
    (t?.totalPix || 0) +
    (t?.totalCartaoCredito || 0) +
    (t?.totalCartaoDebito || 0) +
    (t?.totalCrediario || 0) +
    (t?.totalVendaOnline || 0)
  );
}

const fmtTime = (iso: string | null) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
};

const POLL_INTERVAL_MS = 60_000;

// Formata Date pra YYYY-MM-DD (local time)
function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayYmd(): string {
  return toYmd(new Date());
}

export default function SuperPainelCaixas() {
  const [data, setData] = useState<Painel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secsToRefresh, setSecsToRefresh] = useState(POLL_INTERVAL_MS / 1000);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pixConc, setPixConc] = useState<Record<string, PixConcStatus>>({});
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  // UMA loja por vez (04/08): abrir 12 cards espremia o movimento de caixa em
  // coluna estreita. Escolhe pelo nome e o card ocupa a largura toda.
  const [storeSel, setStoreSel] = useState<string>('');

  // Quem pode EDITAR no painel (bandeira, ajustes master, conferir sessão).
  // 15/07: papéis de franquia editam igual admin — o backend escopa às FILIAIS.
  useEffect(() => {
    (async () => {
      try {
        const me = await api<{ role: string }>('/auth/me');
        setIsAdmin(['admin', 'master_franquia', 'franquias'].includes(me?.role));
      } catch { /* ignora */ }
    })();
  }, []);

  // Busca conciliação PIX por loja (refresca junto com o painel)
  const fetchPixConc = async (dateYmd: string) => {
    try {
      const res = await api<{ porLoja: Record<string, PixConcStatus> }>(
        `/stone/conciliacao-pix-por-loja?date=${dateYmd}`,
      );
      setPixConc(res?.porLoja || {});
    } catch {
      setPixConc({});
    }
  };

  // Filtro de data — default: HOJE (modo ao vivo, sem range)
  const [filterFrom, setFilterFrom] = useState<string>(todayYmd());
  const [filterTo, setFilterTo] = useState<string>(todayYmd());

  // É modo "ao vivo" (hoje) — usa endpoint atual com polling
  const isLiveMode = filterFrom === todayYmd() && filterTo === todayYmd();

  async function load(silent = false) {
    if (!silent) setLoading(true);
    setError(null);
    try {
      // Modo ao vivo: endpoint atual /super-painel (snapshot da sessao atual)
      // Modo historico: /super-painel-historico?from&to (agregado por data)
      const url = isLiveMode
        ? '/pdv/caixa/super-painel'
        : `/pdv/caixa/super-painel-historico?from=${filterFrom}&to=${filterTo}`;
      const r = await api<Painel>(url);
      setData(r);
      setSecsToRefresh(POLL_INTERVAL_MS / 1000);
      // Carrega conciliação PIX em paralelo (não-bloqueante)
      fetchPixConc(isLiveMode ? todayYmd() : filterFrom);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  // Polling automático a cada 60s — SOMENTE em modo ao vivo (hoje)
  useEffect(() => {
    load();
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (isLiveMode) {
      intervalRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterFrom, filterTo]);

  // Atalhos rapidos de periodo
  function applyShortcut(kind: 'hoje' | 'ontem' | '7d' | '30d' | 'mes' | 'mesAnterior') {
    const now = new Date();
    let from = new Date(now);
    let to = new Date(now);
    if (kind === 'hoje') {
      // ja eh hoje
    } else if (kind === 'ontem') {
      from.setDate(now.getDate() - 1);
      to.setDate(now.getDate() - 1);
    } else if (kind === '7d') {
      from.setDate(now.getDate() - 6);
    } else if (kind === '30d') {
      from.setDate(now.getDate() - 29);
    } else if (kind === 'mes') {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = new Date(now);
    } else if (kind === 'mesAnterior') {
      from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      to = new Date(now.getFullYear(), now.getMonth(), 0);
    }
    setFilterFrom(toYmd(from));
    setFilterTo(toYmd(to));
  }

  // Countdown do próximo refresh
  useEffect(() => {
    const t = setInterval(() => setSecsToRefresh((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  // Mantém a loja selecionada válida: na 1ª carga escolhe a que mais vendeu
  // (a que o dono normalmente quer olhar); se a loja sumir da lista, cai na 1ª.
  useEffect(() => {
    if (!data?.lojas?.length) return;
    if (storeSel && data.lojas.some((l) => l.storeCode === storeSel)) return;
    const maisVendeu = [...data.lojas].sort(
      (a, b) => (b.totais?.totalVendas || 0) - (a.totais?.totalVendas || 0),
    )[0];
    setStoreSel(maisVendeu?.storeCode || data.lojas[0].storeCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const lojaSelecionada = data?.lojas?.find((l) => l.storeCode === storeSel) || null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-200 text-slate-700">
              <ArrowLeft size={22} />
            </Link>
            <div>
              <h1 className="text-3xl font-black text-slate-900">SUPER PAINEL · CAIXAS</h1>
              <p className="text-xs text-slate-500">
                {isLiveMode
                  ? `Ao vivo · todas as lojas · refresh a cada ${POLL_INTERVAL_MS / 1000}s`
                  : `Histórico · ${filterFrom === filterTo ? filterFrom : `${filterFrom} → ${filterTo}`}`}
                <Link
                  href="/retaguarda/auditoria-master"
                  className="ml-3 inline-flex items-center gap-1 text-[11px] font-bold text-violet-700 hover:text-violet-900 bg-violet-100 hover:bg-violet-200 px-2 py-0.5 rounded"
                  title="Ver log de alterações master"
                >
                  🛡️ AUDITORIA
                </Link>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {isLiveMode && (
              <span className="text-xs text-slate-500 font-mono tabular-nums">
                próximo em {secsToRefresh}s
              </span>
            )}
            <button
              onClick={() => load()}
              disabled={loading}
              className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-sm font-bold flex items-center gap-1 disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Atualizar
            </button>
          </div>
        </div>

        {/* Filtros de data */}
        <div className="bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-2 flex-wrap shadow-sm">
          <div className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider text-slate-600 mr-2">
            <span>Período:</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">De</label>
            <input
              type="date"
              value={filterFrom}
              max={filterTo}
              onChange={(e) => setFilterFrom(e.target.value)}
              className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm font-mono"
            />
            <label className="text-xs text-slate-500">até</label>
            <input
              type="date"
              value={filterTo}
              min={filterFrom}
              max={todayYmd()}
              onChange={(e) => setFilterTo(e.target.value)}
              className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm font-mono"
            />
          </div>
          <div className="h-6 w-px bg-slate-200" />
          {[
            { k: 'hoje', label: 'Hoje' },
            { k: 'ontem', label: 'Ontem' },
            { k: '7d', label: 'Últ. 7 dias' },
            { k: '30d', label: 'Últ. 30 dias' },
            { k: 'mes', label: 'Este mês' },
            { k: 'mesAnterior', label: 'Mês anterior' },
          ].map((opt) => (
            <button
              key={opt.k}
              type="button"
              onClick={() => applyShortcut(opt.k as any)}
              className="px-2.5 py-1 bg-slate-100 hover:bg-rose-100 hover:text-rose-700 text-slate-700 rounded text-xs font-bold transition"
            >
              {opt.label}
            </button>
          ))}
          {!isLiveMode && (
            <button
              type="button"
              onClick={() => applyShortcut('hoje')}
              className="ml-auto px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-bold"
              title="Volta pro modo ao vivo (hoje)"
            >
              ← Voltar ao vivo
            </button>
          )}
        </div>

        {error && (
          <div className="bg-rose-50 border border-rose-300 text-rose-800 rounded-lg p-3 text-sm flex items-center gap-2">
            <AlertCircle size={18} /> {error}
          </div>
        )}

        {/* Loading inicial */}
        {loading && !data && (
          <div className="text-center p-16">
            <Loader2 size={40} className="mx-auto animate-spin text-rose-600" />
            <div className="text-sm text-slate-500 mt-3">Carregando painel…</div>
          </div>
        )}

        {data && (
          <>
            {/* CARD CONSOLIDADO — destaque máximo */}
            <div className="bg-gradient-to-br from-rose-600 to-rose-800 text-white rounded-2xl shadow-2xl p-6 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="text-xs uppercase tracking-wider opacity-80 font-bold">
                    Faturamento {isLiveMode ? 'hoje' : 'do período'} · TODAS as lojas
                  </div>
                  <div className="text-5xl font-black tabular-nums mt-1">
                    {brl(data.consolidado.faturamento ?? data.consolidado.totalVendas)}
                  </div>
                  {/* Composição da régua — o número grande é líquido, então a
                      conta precisa estar à vista pra ninguém achar que sumiu
                      venda. Frete NÃO abate (já está dentro do vendido). */}
                  <div className="text-[11px] opacity-80 font-mono mt-0.5">
                    vendido {brl(data.consolidado.totalVendas)}
                    {(data.consolidado.totalValeTroca || 0) > 0 && <> − vale {brl(data.consolidado.totalValeTroca || 0)}</>}
                    {(data.consolidado.totalDevolucoes || 0) > 0 && <> − devoluções {brl(data.consolidado.totalDevolucoes || 0)}</>}
                    {(data.consolidado.totalFrete || 0) > 0 && (
                      <span className="opacity-70"> · frete incluso {brl(data.consolidado.totalFrete || 0)}</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1 text-sm">
                  <div className="bg-white/20 px-3 py-1.5 rounded-lg flex items-center gap-2 backdrop-blur">
                    <TrendingUp size={16} />
                    <span className="font-bold">{data.consolidado.qtdVendas}</span> ticket{data.consolidado.qtdVendas !== 1 ? 's' : ''}
                  </div>
                  <div className="bg-white/20 px-3 py-1.5 rounded-lg flex items-center gap-2 backdrop-blur">
                    <Unlock size={14} />
                    <span className="font-bold">{data.consolidado.qtdLojasAbertas}</span> abertas
                    <span className="opacity-60">·</span>
                    <Lock size={14} />
                    <span className="font-bold">{data.consolidado.qtdLojasFechadas}</span> fechadas
                  </div>
                </div>
              </div>
              {/* Breakdown consolidado */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 pt-2 border-t border-white/20">
                <ConsolidadoItem label="Dinheiro" valor={data.consolidado.totalDinheiro} icon={<Banknote size={14} />} />
                <ConsolidadoItem label="PIX" valor={data.consolidado.totalPix} icon={<QrCode size={14} />} />
                <ConsolidadoItem label="Cartão Crédito" valor={data.consolidado.totalCartaoCredito} icon={<CreditCard size={14} />} />
                <ConsolidadoItem label="Cartão Débito" valor={data.consolidado.totalCartaoDebito} icon={<CreditCard size={14} />} />
                <ConsolidadoItem label="Crediário" valor={data.consolidado.totalCrediario} icon={<TrendingUp size={14} />} />
                {/* Venda online (WhatsApp/Insta): entra no Recebido da conciliação
                    mas não passa pela gaveta — por isso card próprio. */}
                <ConsolidadoItem label="Venda Online" valor={data.consolidado.totalVendaOnline || 0} icon={<Globe size={14} />} />
              </div>

              {/* Formato da venda online na REDE inteira: PIX direto, link
                  externo ou link de cartão (Pagar.me). */}
              {(() => {
                const formatos = resumoOnlineRede(data.lojas);
                if (!formatos.length) return null;
                return (
                  <div className="flex items-center gap-2 flex-wrap text-[11px]">
                    <span className="font-bold uppercase tracking-wide opacity-80">
                      Venda online por formato
                    </span>
                    {formatos.map((f) => (
                      <span key={f.key || 'sem'} className="bg-white/15 backdrop-blur rounded px-2 py-0.5 flex items-center gap-1">
                        <span className="font-semibold">{f.curto}</span>
                        <span className="font-mono tabular-nums font-black">{brl(f.valor)}</span>
                        <span className="opacity-70">({f.qtd})</span>
                      </span>
                    ))}
                  </div>
                );
              })()}

              {/* CONCILIACAO GERAL — régua oficial (04/08).
                  FATURAMENTO         = vendido − vale − devoluções
                  FORMAS DE PAGAMENTO = dinheiro + pix + cartões + crediário +
                                        venda online − devoluções(dinheiro/pix)
                  A devolução tem que sair dos DOIS lados: ela não reduz o
                  pagamento da venda (sai por sangria), então sem isso o
                  confronto virava tautologia e nunca acusava erro. */}
              {(() => {
                const c: any = data.consolidado;
                const formas = somaFormas(c);
                const dev = c.totalDevolucoes || 0;
                const formasLiquidas = Number((formas - dev).toFixed(2));
                const faturamento = Number((c.faturamento ?? ((c.totalVendas || 0) - (c.totalValeTroca || 0))).toFixed(2));
                const diff = Number((faturamento - formasLiquidas).toFixed(2));
                const bate = Math.abs(diff) < 0.02;
                return (
                  <div className={`mt-2 px-3 py-2 rounded-lg border-2 flex items-center justify-between gap-3 text-sm flex-wrap ${
                    bate
                      ? 'bg-emerald-500/20 border-emerald-300 text-white'
                      : 'bg-amber-500/30 border-amber-200 text-white'
                  }`}>
                    <div className="font-bold uppercase tracking-wide flex items-center gap-2">
                      {bate ? '✓' : '⚠️'} CONCILIACAO GERAL
                    </div>
                    <div className="flex items-center gap-2 font-mono flex-wrap">
                      <span>Faturamento <b>{brl(faturamento)}</b></span>
                      <span className="opacity-70">vs</span>
                      <span>Formas <b>{brl(formasLiquidas)}</b></span>
                      {dev > 0 && (
                        <span className="text-[10px] opacity-80">({brl(formas)} − devoluções {brl(dev)})</span>
                      )}
                      {!bate && (
                        <span className="ml-2 px-2 py-0.5 bg-amber-200 text-amber-900 rounded font-black">
                          Diferenca {diff > 0 ? '+' : ''}{brl(diff)}
                        </span>
                      )}
                      {bate && (
                        <span className="ml-2 px-2 py-0.5 bg-emerald-200 text-emerald-900 rounded font-black">
                          ✓ BATE
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* DINHEIRO EM CAIXA por loja — réplica da tela "Dinheiro em
                Caixa (Todas as Lojas)" do Wincred que o dono pediu (02/07):
                quanto cada loja tem NA GAVETA agora/naquele dia. */}
            <DinheiroEmCaixaTable lojas={data.lojas} />

            {/* Seleção da loja — uma por vez, card em largura total */}
            <LojaSelector
              lojas={data.lojas}
              value={storeSel}
              onChange={setStoreSel}
            />

            {lojaSelecionada ? (
              <LojaCard
                key={lojaSelecionada.storeCode}
                loja={lojaSelecionada}
                isAdmin={isAdmin}
                pixStatus={pixConc[lojaSelecionada.storeCode]}
                onReload={() => load(true)}
                dateFrom={filterFrom}
                dateTo={filterTo}
                onDateRange={(from, to) => { setFilterFrom(from); setFilterTo(to); }}
              />
            ) : (
              <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">
                Escolha uma loja acima pra ver o movimento de caixa.
              </div>
            )}

            {/* Footer */}
            <div className="text-center text-[10px] text-slate-400 pt-2">
              Última atualização: {new Date(data.generatedAt).toLocaleString('pt-BR')}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Seleção da loja pelo NOME. Dropdown (busca rápida no teclado) + atalhos com
 * status do caixa e venda do dia — dá pra comparar as lojas sem abrir todos os
 * cards, que era o que espremia o movimento de caixa.
 */
function LojaSelector({
  lojas, value, onChange,
}: { lojas: Loja[]; value: string; onChange: (code: string) => void }) {
  const abertas = lojas.filter((l) => l.aberta).length;
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-600 flex items-center gap-1">
          <Store size={14} /> Loja
        </span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-bold text-slate-800 bg-white min-w-[240px] focus:ring-2 focus:ring-rose-300"
        >
          {lojas.map((l) => (
            <option key={l.storeCode} value={l.storeCode}>
              {l.storeName} ({l.storeCode}) — {brl(l.faturamento ?? l.totais?.totalVendas ?? 0)}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-slate-400">
          {lojas.length} loja{lojas.length !== 1 ? 's' : ''} · {abertas} com caixa aberto
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {lojas.map((l) => {
          const sel = l.storeCode === value;
          const vendeu = (l.totais?.totalVendas || 0) > 0;
          return (
            <button
              key={l.storeCode}
              type="button"
              onClick={() => onChange(l.storeCode)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] font-bold transition ${
                sel
                  ? 'bg-rose-600 border-rose-700 text-white shadow'
                  : vendeu
                    ? 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-rose-50 hover:border-rose-300'
                    : 'bg-slate-50 border-slate-200 text-slate-400 hover:bg-slate-100'
              }`}
              title={`${l.storeName} · ${l.aberta ? 'caixa aberto' : 'caixa fechado'}`}
            >
              {l.aberta ? <Unlock size={10} /> : <Lock size={10} />}
              <span className="uppercase">{l.storeName}</span>
              <span className={`font-mono tabular-nums ${sel ? 'text-white' : vendeu ? 'text-emerald-700' : 'text-slate-300'}`}>
                {brl(l.faturamento ?? l.totais?.totalVendas ?? 0)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ConsolidadoItem({ label, valor, icon }: { label: string; valor: number; icon: React.ReactNode }) {
  return (
    <div className="bg-white/10 backdrop-blur rounded-lg p-2 space-y-0.5">
      <div className="text-[10px] uppercase opacity-80 font-bold tracking-wide flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="text-base font-black tabular-nums">{brl(valor)}</div>
    </div>
  );
}

/**
 * DINHEIRO EM CAIXA (todas as lojas) — réplica da tela homônima do Wincred.
 * Uma linha por loja: quanto tem NA GAVETA = fundo + vendas em dinheiro +
 * crediário recebido em dinheiro + suprimentos − sangrias. Tudo calculado
 * do payload que o painel já carrega — zero request extra.
 */
function DinheiroEmCaixaTable({ lojas }: { lojas: Loja[] }) {
  const [open, setOpen] = useState(true);
  const rows = (lojas || []).map((l) => {
    const fundo = Number(l.fundoTroco) || 0;
    const vendasDin = Number(l.totais?.totalDinheiro) || 0;
    const recDin = Number((l.recebimentosCrediario as any)?.totalDinheiro) || 0;
    const supr = Number(l.totais?.totalSuprimentos) || 0;
    const sangrias = Number(l.totais?.totalSangrias) || 0;
    const total = Math.round((fundo + vendasDin + recDin + supr - sangrias) * 100) / 100;
    const vazia = fundo === 0 && vendasDin === 0 && recDin === 0 && supr === 0 && sangrias === 0;
    return { code: l.storeCode, name: l.storeName, fundo, vendasDin, recDin, supr, sangrias, total, vazia };
  });
  const tot = rows.reduce(
    (a, r) => ({
      fundo: a.fundo + r.fundo,
      vendasDin: a.vendasDin + r.vendasDin,
      recDin: a.recDin + r.recDin,
      supr: a.supr + r.supr,
      sangrias: a.sangrias + r.sangrias,
      total: a.total + r.total,
    }),
    { fundo: 0, vendasDin: 0, recDin: 0, supr: 0, sangrias: 0, total: 0 },
  );
  const num = (v: number, cls = 'text-slate-700') => (
    <td className={`px-2 py-1 text-right font-mono tabular-nums ${v === 0 ? 'text-slate-300' : cls}`}>
      {brl(v)}
    </td>
  );
  return (
    <div className="bg-white rounded-xl shadow-lg border-2 border-slate-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between bg-slate-700 text-white hover:bg-slate-600 transition"
        title="Quanto cada loja tem em dinheiro na gaveta"
      >
        <span className="font-black text-sm uppercase flex items-center gap-2">
          <Banknote size={16} />
          Dinheiro em caixa (todas as lojas)
        </span>
        <span className="flex items-center gap-3">
          <span className="font-mono font-black tabular-nums">{brl(tot.total)}</span>
          <span className={`transition-transform inline-block text-xs ${open ? 'rotate-90' : ''}`}>▶</span>
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-slate-100 text-slate-600 uppercase text-[10px]">
                <th className="px-2 py-1.5 text-left">Loja</th>
                <th className="px-2 py-1.5 text-right">Fundo</th>
                <th className="px-2 py-1.5 text-right">Dinheiro (vendas)</th>
                <th className="px-2 py-1.5 text-right">Recebidos (crediário)</th>
                <th className="px-2 py-1.5 text-right">Suprimentos</th>
                <th className="px-2 py-1.5 text-right">Retiradas</th>
                <th className="px-2 py-1.5 text-right">Total na gaveta</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code} className={`border-t border-slate-100 ${r.vazia ? 'opacity-40' : 'hover:bg-slate-50'}`}>
                  <td className="px-2 py-1 font-bold text-slate-800">
                    {r.name} <span className="font-mono text-[9px] text-slate-400">{r.code}</span>
                  </td>
                  {num(r.fundo)}
                  {num(r.vendasDin, 'text-emerald-700')}
                  {num(r.recDin, 'text-emerald-700')}
                  {num(r.supr, 'text-sky-700')}
                  {num(r.sangrias, 'text-rose-600')}
                  <td className={`px-2 py-1 text-right font-mono font-black tabular-nums ${
                    r.total < 0 ? 'bg-rose-50 text-rose-700' : r.total > 0 ? 'bg-emerald-50 text-emerald-800' : 'text-slate-300'
                  }`}>
                    {brl(r.total)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-black">
                <td className="px-2 py-1.5 text-slate-800 uppercase text-[10px]">Total</td>
                {num(tot.fundo, 'text-slate-800')}
                {num(tot.vendasDin, 'text-emerald-800')}
                {num(tot.recDin, 'text-emerald-800')}
                {num(tot.supr, 'text-sky-800')}
                {num(tot.sangrias, 'text-rose-700')}
                <td className={`px-2 py-1.5 text-right font-mono font-black tabular-nums ${tot.total < 0 ? 'text-rose-700' : 'text-emerald-800'}`}>
                  {brl(tot.total)}
                </td>
              </tr>
            </tfoot>
          </table>
          <div className="px-3 py-1.5 text-[10px] text-slate-400 border-t border-slate-100">
            Total na gaveta = fundo + vendas em dinheiro + crediário recebido em dinheiro + suprimentos − sangrias
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Filtro de data DENTRO do card da loja: Hoje · Ontem · Livre (De/Até).
 * Hoje = modo ao vivo (polling); qualquer outra data cai no histórico.
 */
function CardDateFilter({
  dateFrom, dateTo, onDateRange,
}: { dateFrom?: string; dateTo?: string; onDateRange: (from: string, to: string) => void }) {
  const hoje = todayYmd();
  const ontemDate = new Date();
  ontemDate.setDate(ontemDate.getDate() - 1);
  const ontem = toYmd(ontemDate);
  const modo: 'hoje' | 'ontem' | 'livre' =
    dateFrom === hoje && dateTo === hoje ? 'hoje'
      : dateFrom === ontem && dateTo === ontem ? 'ontem'
        : 'livre';
  const [livreAberto, setLivreAberto] = useState(false);
  const mostrarInputs = livreAberto || modo === 'livre';

  const btn = (ativo: boolean) =>
    `px-3 py-1 rounded-lg text-xs font-bold transition border ${
      ativo
        ? 'bg-slate-800 border-slate-900 text-white shadow'
        : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-100'
    }`;

  return (
    <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2 flex-wrap">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Período</span>
      <button type="button" className={btn(modo === 'hoje')}
        onClick={() => { setLivreAberto(false); onDateRange(hoje, hoje); }}>
        Hoje
      </button>
      <button type="button" className={btn(modo === 'ontem')}
        onClick={() => { setLivreAberto(false); onDateRange(ontem, ontem); }}>
        Ontem
      </button>
      <button type="button" className={btn(mostrarInputs)}
        onClick={() => setLivreAberto((v) => !v)}>
        Livre
      </button>
      {mostrarInputs && (
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-slate-500">De</label>
          <input
            type="date"
            value={dateFrom || hoje}
            max={dateTo || hoje}
            onChange={(e) => onDateRange(e.target.value, dateTo || e.target.value)}
            className="px-2 py-1 border border-slate-300 rounded-lg text-xs font-mono"
          />
          <label className="text-[10px] text-slate-500">até</label>
          <input
            type="date"
            value={dateTo || hoje}
            min={dateFrom || undefined}
            max={hoje}
            onChange={(e) => onDateRange(dateFrom || e.target.value, e.target.value)}
            className="px-2 py-1 border border-slate-300 rounded-lg text-xs font-mono"
          />
        </div>
      )}
      {modo !== 'hoje' && (
        <span className="ml-auto text-[10px] font-bold text-amber-700 bg-amber-100 border border-amber-300 rounded px-2 py-0.5">
          histórico · sem refresh automático
        </span>
      )}
    </div>
  );
}

function LojaCard({ loja, isAdmin, pixStatus, onReload, dateFrom, dateTo, onDateRange }: { loja: Loja; isAdmin?: boolean; pixStatus?: PixConcStatus; onReload?: () => void; dateFrom?: string; dateTo?: string; onDateRange?: (from: string, to: string) => void }) {
  // Card ocupa a largura toda (uma loja por vez) — ranking já abre expandido.
  const [rankingOpen, setRankingOpen] = useState(true);
  const reload = () => { if (onReload) onReload(); };
  const t = loja.totais;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showSangrias, setShowSangrias] = useState(false);
  const [showSuprimentos, setShowSuprimentos] = useState(false);
  const [showRecebimentos, setShowRecebimentos] = useState(false);
  const [editBandeira, setEditBandeira] = useState<{ paymentId: string; currentBandeira: string; currentMethod: string; valor: number; saleHint: string } | null>(null);
  const [masterModal, setMasterModal] = useState(false);
  // Lançamento (sangria/suprimento) em edição no modal master (editar/excluir).
  const [editMov, setEditMov] = useState<Movimento | null>(null);
  // A retirada de FECHAMENTO sai da lista de sangrias operacionais e ganha
  // linha própria — ela não é uma saída do dia, é o dinheiro contado na manhã
  // seguinte que virou fundo do caixa novo.
  const sangriasList = (loja.movimentos || []).filter((m) => m.tipo === 'sangria' && !m.isFechamento);
  const suprimentosList = (loja.movimentos || []).filter((m) => m.tipo === 'suprimento');
  const fechamentoMov = (loja.movimentos || []).find((m) => m.isFechamento) || null;
  const totalFechamento = Number(t.totalFechamento ?? fechamentoMov?.valor ?? 0);
  const formatosOnline = resumoOnlinePorFormato(loja.detalhado);
  // Régua oficial do faturamento — vem pronta do backend (ver blocoFaturamento).
  const valeTroca = t.totalValeTroca || 0;
  const devolucoes = loja.totalDevolucoes || 0;
  const faturamento = loja.faturamento ?? ((t.totalVendas || 0) - valeTroca);
  const rec = loja.recebimentosCrediario || { totalGeral: 0, totalDinheiro: 0, totalPix: 0, baixas: [] };
  const recDinheiroBaixas = rec.baixas.filter((b) => b.forma === 'dinheiro' || (b.forma === 'misto' && (b.valorDinheiro || 0) > 0));
  const recPixBaixas = rec.baixas.filter((b) => b.forma === 'pix' || (b.forma === 'misto' && (b.valorPix || 0) > 0));
  return (
    <div className={`rounded-xl shadow-lg overflow-hidden border-2 ${
      loja.aberta
        ? 'bg-white border-emerald-300'
        // Caixa fechado MAS vendeu: não é loja parada — o valor conta no total
        // da rede, então não pode ficar apagada igual a quem não abriu.
        : loja.caixaFechadoComVenda
          ? 'bg-white border-slate-400'
          : 'bg-slate-100 border-slate-300 opacity-75'
    }`}>
      {/* Header da loja */}
      <div className={`px-3 py-2 flex items-center justify-between ${
        loja.aberta ? 'bg-emerald-600 text-white' : 'bg-slate-500 text-white'
      }`}>
        <div className="flex items-center gap-1.5">
          {loja.aberta ? <Unlock size={14} /> : <Lock size={14} />}
          <span className="font-black text-sm uppercase">{loja.storeName}</span>
          <span className="text-[10px] opacity-80 font-mono">{loja.storeCode}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {loja.aberta ? (
            <span className="text-[10px] opacity-90 font-bold">desde {fmtTime(loja.openedAt)}</span>
          ) : (
            <span className="text-[10px] opacity-90 font-bold uppercase">
              {loja.caixaFechadoComVenda ? 'Caixa fechado' : 'Fechado'}
            </span>
          )}
          {/* Tela cheia de fechamento/conferência desta loja no dia filtrado */}
          <a
            href={`/retaguarda/fechamento-caixa?storeCode=${encodeURIComponent(loja.storeCode)}&date=${dateFrom || ''}`}
            className="ml-1 px-1.5 py-0.5 rounded bg-white/20 hover:bg-white/35 text-[10px] font-bold flex items-center gap-1"
            title="Abrir o fechamento de caixa desta loja"
          >
            🧾 FECHAMENTO
          </a>
          <a
            href={`/retaguarda/produtos-vendidos?storeCode=${encodeURIComponent(loja.storeCode)}${dateFrom ? `&from=${dateFrom}` : ''}${dateTo ? `&to=${dateTo}` : ''}`}
            className="ml-1 px-1.5 py-0.5 rounded bg-white/20 hover:bg-white/35 text-[10px] font-bold flex items-center gap-1"
            title="Ver produtos vendidos desta loja"
          >
            📋 PRODUTOS
          </a>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setMasterModal(true)}
              className="ml-1 px-1.5 py-0.5 rounded bg-white/20 hover:bg-white/35 text-[10px] font-bold flex items-center gap-1"
              title="Ajustes master (senha)"
            >
              ⚙️ MASTER
            </button>
          )}
        </div>
      </div>
      {/* Filtro de data DO CARD — Hoje / Ontem / Livre. Mexe no mesmo período
          que o painel carrega (uma loja por vez, então não há conflito). */}
      {onDateRange && (
        <CardDateFilter dateFrom={dateFrom} dateTo={dateTo} onDateRange={onDateRange} />
      )}

      {masterModal && (
        <MasterAdjustModal
          loja={loja}
          date={loja.aberta ? null : dateFrom || null}
          onClose={() => setMasterModal(false)}
          onSaved={() => { setMasterModal(false); reload(); }}
        />
      )}
      {editMov && (
        <MovementEditModal
          loja={loja}
          mov={editMov}
          onClose={() => setEditMov(null)}
          onSaved={() => { setEditMov(null); reload(); }}
        />
      )}

      {/* Aviso de sessão pendente (caixa de ontem ainda aberto) */}
      {loja.sessaoPendente && (
        <div className="bg-amber-100 border-b border-amber-300 px-3 py-2 text-[11px] text-amber-900 flex items-center gap-1.5">
          <AlertCircle size={13} className="flex-shrink-0" />
          <span>
            <strong>Sessão pendente</strong> aberta em{' '}
            {loja.sessaoPendenteAbertaEm
              ? new Date(loja.sessaoPendenteAbertaEm).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
              : '—'}
            {' '}— feche o caixa pra contabilizar.
          </span>
        </div>
      )}

      {/* Total grande */}
      <div className="p-3 space-y-2">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-500">Faturamento</div>
            <div className={`text-3xl font-black tabular-nums ${
              loja.aberta
                ? 'text-emerald-700'
                : loja.caixaFechadoComVenda ? 'text-slate-700' : 'text-slate-400'
            }`}>
              {brl(faturamento)}
            </div>
            {/* Composição da régua: o número acima é líquido. */}
            <div className="text-[10px] text-slate-500 font-mono">
              vendido {brl(t.totalVendas)}
              {valeTroca > 0 && <> − vale {brl(valeTroca)}</>}
              {devolucoes > 0 && <> − devoluções {brl(devolucoes)}</>}
              {(loja.totalFrete || 0) > 0 && (
                <span className="text-slate-400"> · frete incluso {brl(loja.totalFrete || 0)}</span>
              )}
            </div>
            {loja.caixaFechadoComVenda && (
              <div className="text-[10px] text-slate-500 font-semibold">
                caixa já fechado · valor conta no total da rede
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-[10px] text-slate-500 font-bold">{t.qtdVendas} ticket{t.qtdVendas !== 1 ? 's' : ''}</div>
            {loja.openedByName && (
              <div className="text-[10px] text-slate-400 italic truncate max-w-[120px]">{loja.openedByName}</div>
            )}
          </div>
        </div>

        {/* Corpo em COLUNAS (04/08): vendas à esquerda (2/3), caixa e ranking
            à direita (1/3). Em largura total o card virava uma tira alta e
            estreita de conteúdo — assim ele fica quadrado e cabe mais dado. */}
        <div className="grid lg:grid-cols-3 gap-3 items-start">
        <div className="lg:col-span-2 space-y-2">

        {/* Breakdown por modalidade — clicável pra expandir cascade */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 pt-2 border-t border-slate-200">
          <ModItem label="Dinheiro" valor={t.totalDinheiro} cor="emerald"
            active={expanded === 'dinheiro'}
            onClick={loja.detalhado && t.totalDinheiro > 0 ? () => setExpanded(expanded === 'dinheiro' ? null : 'dinheiro') : undefined} />
          <ModItem label="PIX" valor={t.totalPix} cor="cyan"
            active={expanded === 'pix'}
            badge={<PixBadge s={pixStatus} />}
            onClick={loja.detalhado && t.totalPix > 0 ? () => setExpanded(expanded === 'pix' ? null : 'pix') : undefined} />
          <ModItem label="Crédito" valor={t.totalCartaoCredito} cor="blue"
            active={expanded === 'credito'}
            onClick={loja.detalhado && t.totalCartaoCredito > 0 ? () => setExpanded(expanded === 'credito' ? null : 'credito') : undefined} />
          <ModItem label="Débito" valor={t.totalCartaoDebito} cor="indigo"
            active={expanded === 'debito'}
            onClick={loja.detalhado && t.totalCartaoDebito > 0 ? () => setExpanded(expanded === 'debito' ? null : 'debito') : undefined} />
          <ModItem label="Crediário" valor={t.totalCrediario} cor="rose"
            active={expanded === 'crediario'}
            onClick={loja.detalhado && t.totalCrediario > 0 ? () => setExpanded(expanded === 'crediario' ? null : 'crediario') : undefined} />
          {/* VENDA ONLINE (WhatsApp/Instagram): já entrava na conciliação como
              recebido, mas não tinha card — a modalidade ficava invisível. */}
          <ModItem label="Venda Online" valor={t.totalVendaOnline || 0} cor="violet"
            active={expanded === 'venda_online'}
            onClick={loja.detalhado && (t.totalVendaOnline || 0) > 0 ? () => setExpanded(expanded === 'venda_online' ? null : 'venda_online') : undefined} />
        </div>

        {/* BANDEIRAS separadas (04/08 — pedido do dono): "Crédito R$ 1.648,80"
            não dizia se foi Master, Visa ou Elo. Cada bandeira com valor vira
            um chip clicável que abre as vendas dela. */}
        {loja.detalhado && (
          <div className="grid sm:grid-cols-2 gap-2">
            <BandeirasBloco
              titulo="Crédito"
              total={t.totalCartaoCredito}
              cor="blue"
              chaves={BANDEIRAS_CREDITO}
              detalhado={loja.detalhado}
              expanded={expanded}
              onToggle={setExpanded}
            />
            <BandeirasBloco
              titulo="Débito"
              total={t.totalCartaoDebito}
              cor="indigo"
              chaves={BANDEIRAS_DEBITO}
              detalhado={loja.detalhado}
              expanded={expanded}
              onToggle={setExpanded}
            />
          </div>
        )}

        {/* COMO a venda online entrou: PIX direto, link externo ou link de
            cartão (Pagar.me). O total sozinho não dizia o formato. */}
        {formatosOnline.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(expanded === 'venda_online' ? null : 'venda_online')}
            className="w-full flex items-center gap-2 flex-wrap px-2 py-1 rounded-md bg-violet-50 border border-violet-200 text-[11px] text-violet-900 hover:bg-violet-100 transition"
            title="Clica pra ver as vendas online por formato"
          >
            <span className="font-bold uppercase tracking-wide flex items-center gap-1">
              <Globe size={11} /> Venda online por formato
            </span>
            {formatosOnline.map((f) => (
              <span key={f.key || 'sem'} className="flex items-center gap-1 bg-white border border-violet-200 rounded px-1.5 py-0.5">
                <span className="font-semibold">{f.curto}</span>
                <span className="font-mono tabular-nums font-bold">{brl(f.valor)}</span>
                <span className="text-violet-500">({f.qtd})</span>
              </span>
            ))}
          </button>
        )}

        {/* CONCILIACAO INLINE — régua oficial (04/08):
              Faturamento (vendido − vale − devoluções)
              vs Formas de pagamento − devoluções(dinheiro/pix)
            Click leva pra /produtos-vendidos com filtro de data + loja. */}
        {t.totalVendas > 0 && (() => {
          const formasLiquidas = Number((somaFormas(t) - devolucoes).toFixed(2));
          const diff = Number((faturamento - formasLiquidas).toFixed(2));
          const bate = Math.abs(diff) < 0.02;
          const concUrl = `/retaguarda/produtos-vendidos?storeCode=${encodeURIComponent(loja.storeCode)}${dateFrom ? `&from=${dateFrom}` : ''}${dateTo ? `&to=${dateTo}` : ''}`;
          return (
            <a
              href={concUrl}
              className={`mt-1.5 flex items-center justify-between gap-2 px-2 py-1.5 rounded-md border text-[11px] transition hover:shadow-sm ${
                bate
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100'
                  : 'bg-amber-50 border-amber-400 text-amber-900 hover:bg-amber-100'
              }`}
              title="Click pra abrir Produtos Vendidos da loja"
            >
              <span className="font-bold uppercase tracking-wide">
                {bate ? '✓' : '⚠️'} Conciliacao
              </span>
              <span className="flex items-center gap-1.5">
                <span className="font-mono">{brl(faturamento)}</span>
                <span className="opacity-60">vs formas</span>
                <span className="font-mono">{brl(formasLiquidas)}</span>
                {devolucoes > 0 && (
                  <span className="opacity-60 text-[10px]">(−devol. {brl(devolucoes)})</span>
                )}
                {!bate && (
                  <span className="ml-1 font-mono font-black">
                    ({diff > 0 ? '+' : ''}{brl(diff)})
                  </span>
                )}
              </span>
            </a>
          );
        })()}

        {/* Cascade — vendas/bandeiras quando expandido */}
        {expanded && loja.detalhado && (
          <div className="pt-2 border-t border-slate-100">
            <CascadeModalidade
              detalhado={loja.detalhado}
              modalidade={expanded}
              isAdmin={isAdmin}
              onEditBandeira={(paymentId, currentBandeira, valor, saleHint, currentMethod) =>
                setEditBandeira({ paymentId, currentBandeira, currentMethod: currentMethod || expanded || 'credito', valor, saleHint })
              }
            />
          </div>
        )}

        {/* Modal de edição de pagamento (master+) */}
        {editBandeira && (
          <MasterEditPaymentModal
            paymentId={editBandeira.paymentId}
            currentBandeira={editBandeira.currentBandeira}
            currentMethod={editBandeira.currentMethod}
            currentValor={editBandeira.valor}
            saleHint={editBandeira.saleHint}
            onClose={() => setEditBandeira(null)}
            onSaved={() => { setEditBandeira(null); reload(); }}
          />
        )}

        </div>{/* fim da coluna de vendas */}

        {/* Coluna do CAIXA: fundo, fechamento, movimentos e ranking */}
        <div className="space-y-2">
        {/* Bloco financeiro do caixa: fundo, dinheiro fim de dia, conferência */}
        {(loja.aberta || t.totalSangrias > 0 || t.totalSuprimentos > 0 || loja.fundoTroco > 0 || t.totalDinheiro > 0 || totalFechamento > 0) && (
          <div className="pt-1 border-t border-slate-100 space-y-1">
            {/* Fundo do caixa — agora SEMPRE aparece (inclusive dias anteriores) */}
            <div className="flex justify-between text-[11px] text-slate-700">
              <span className="font-bold">💵 Fundo do caixa (abertura)</span>
              <span className="font-mono tabular-nums font-bold">{brl(loja.fundoTroco)}</span>
            </div>
            {/* Dinheiro esperado fim de dia — pra bater caixa físico contra Wincred.
                Esse valor é o que deveria estar no caixa ao fechar (vira fundo do dia seguinte). */}
            {!loja.aberta && t.dinheiroEsperado !== undefined && (
              <div className="flex justify-between text-[11px] text-emerald-800 bg-emerald-50 rounded px-1.5 py-1">
                <span className="font-bold">💰 Dinheiro fim de dia (fundo + vendas - sangrias + suprimentos)</span>
                <span className="font-mono tabular-nums font-bold">{brl(t.dinheiroEsperado)}</span>
              </div>
            )}
            {/* RETIRADA DE FECHAMENTO — gerada automaticamente quando a loja
                abriu o caixa seguinte e digitou o dinheiro contado. É o
                fechamento deste dia: o valor saiu daqui e virou o fundo do
                próximo caixa. Fica fora de "Sangria" pra não virar despesa. */}
            {totalFechamento > 0 && (
              <div className="text-[11px] text-violet-900 bg-violet-50 border border-violet-200 rounded px-1.5 py-1 space-y-0.5">
                <div className="flex justify-between">
                  <span className="font-bold">🔒 Fechamento do dia (retirada automática)</span>
                  <span className="font-mono tabular-nums font-bold">{brl(totalFechamento)}</span>
                </div>
                <div className="flex justify-between text-[10px] text-violet-700">
                  <span className="italic truncate">
                    {fechamentoMov?.userName
                      ? `contado por ${fechamentoMov.userName}`
                      : 'contagem feita na abertura do dia seguinte'}
                  </span>
                  <span className="font-mono">
                    sobra em caixa {brl(Math.round(((t.dinheiroEsperado || 0) - totalFechamento) * 100) / 100)}
                  </span>
                </div>
              </div>
            )}
            {/* Conferência: badge se já conferido OU botão pra marcar */}
            {!loja.aberta && loja.sessionsDoDia && loja.sessionsDoDia.length > 0 && (
              loja.checkedAt ? (
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm(`Desmarcar conferência de ${loja.storeName}?`)) return;
                    try {
                      await api('/pdv/caixa/admin/uncheck-sessions', {
                        method: 'POST',
                        body: JSON.stringify({ sessionIds: loja.sessionsDoDia }),
                      });
                      reload();
                    } catch (e: any) {
                      alert(`Erro: ${e?.message || e}`);
                    }
                  }}
                  className="w-full flex justify-between items-center text-[11px] bg-emerald-100 hover:bg-emerald-200 text-emerald-900 rounded px-1.5 py-1 transition"
                  title="Clica pra desmarcar"
                >
                  <span className="font-bold">
                    ✅ Conferido por <b>{loja.checkedByName}</b>
                  </span>
                  <span className="font-mono text-emerald-700">
                    {loja.checkedAt ? new Date(loja.checkedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    const note = prompt(`Marcar caixa de ${loja.storeName} como CONFERIDO?\n\nObservação (opcional, ex: "diferença R$ 2,00"):`, '');
                    if (note === null) return; // cancelou
                    try {
                      await api('/pdv/caixa/admin/check-sessions', {
                        method: 'POST',
                        body: JSON.stringify({
                          sessionIds: loja.sessionsDoDia,
                          note: note.trim() || undefined,
                        }),
                      });
                      reload();
                    } catch (e: any) {
                      alert(`Erro: ${e?.message || e}`);
                    }
                  }}
                  className="w-full flex justify-center items-center gap-1 text-[11px] bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded px-1.5 py-1.5 transition"
                  title="Marca esse caixa como conferido (bate valores contra Wincred)"
                >
                  ✓ CONFERIR CAIXA
                </button>
              )
            )}
            {loja.checkedNote && (
              <div className="text-[10px] text-slate-600 italic bg-slate-50 rounded px-1.5 py-0.5">
                📝 {loja.checkedNote}
              </div>
            )}

            {/* Crediarios recebidos — cascata separando PIX e Dinheiro */}
            {rec.totalGeral > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowRecebimentos((v) => !v)}
                  className="w-full flex justify-between items-center text-[11px] text-emerald-700 hover:bg-emerald-50 rounded px-1 py-0.5 transition"
                  title="Clica pra ver os recebimentos"
                >
                  <span className="font-bold flex items-center gap-1">
                    <span className={`transition-transform inline-block ${showRecebimentos ? 'rotate-90' : ''}`}>▶</span>
                    📥 Crediários recebidos · {rec.baixas.length} baixa{rec.baixas.length !== 1 ? 's' : ''}
                  </span>
                  <span className="font-mono tabular-nums font-bold">{brl(rec.totalGeral)}</span>
                </button>
                {showRecebimentos && (
                  <div className="ml-3 pl-2 border-l-2 border-emerald-200 space-y-2">
                    {rec.totalDinheiro > 0 && (
                      <div className="space-y-0.5">
                        <div className="flex justify-between items-center text-[10px] font-bold text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded">
                          <span>💵 Em DINHEIRO ({recDinheiroBaixas.length})</span>
                          <span className="font-mono tabular-nums">{brl(rec.totalDinheiro)}</span>
                        </div>
                        {recDinheiroBaixas.map((b) => {
                          const hora = new Date(b.paidAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                          const valor = b.forma === 'misto' ? (b.valorDinheiro || 0) : b.valor;
                          return (
                            <div key={`d-${b.id}`} className="flex justify-between items-center text-[10px] gap-2 hover:bg-amber-50 rounded px-1 py-0.5">
                              <div className="min-w-0 flex-1 flex items-center gap-1">
                                <span className="text-slate-400 font-mono shrink-0">{hora}</span>
                                <span className="text-slate-700 truncate">{b.customerName || 'Cliente'}</span>
                                {b.forma === 'misto' && (
                                  <span className="text-[9px] text-violet-600 italic shrink-0">misto</span>
                                )}
                              </div>
                              <span className="font-mono font-bold tabular-nums text-amber-700 shrink-0">{brl(valor)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {rec.totalPix > 0 && (
                      <div className="space-y-0.5">
                        <div className="flex justify-between items-center text-[10px] font-bold text-cyan-800 bg-cyan-50 px-1.5 py-0.5 rounded">
                          <span>📱 Em PIX ({recPixBaixas.length})</span>
                          <span className="font-mono tabular-nums">{brl(rec.totalPix)}</span>
                        </div>
                        {recPixBaixas.map((b) => {
                          const hora = new Date(b.paidAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                          const valor = b.forma === 'misto' ? (b.valorPix || 0) : b.valor;
                          const isLink = b.origem === 'link';
                          return (
                            <div key={`p-${b.id}`} className="flex justify-between items-center text-[10px] gap-2 hover:bg-cyan-50 rounded px-1 py-0.5">
                              <div className="min-w-0 flex-1 flex items-center gap-1">
                                <span className="text-slate-400 font-mono shrink-0">{hora}</span>
                                <span className="text-slate-700 truncate">{b.customerName || 'Cliente'}</span>
                                {isLink && (
                                  <span className="text-[9px] text-emerald-600 italic shrink-0 font-bold">🔗 link</span>
                                )}
                                {b.forma === 'misto' && (
                                  <span className="text-[9px] text-violet-600 italic shrink-0">misto</span>
                                )}
                              </div>
                              <span className="font-mono font-bold tabular-nums text-cyan-700 shrink-0">{brl(valor)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {t.totalSangrias > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowSangrias((v) => !v)}
                  className="w-full flex justify-between items-center text-[11px] text-rose-700 hover:bg-rose-50 rounded px-1 py-0.5 transition"
                  title="Clica pra ver os lancamentos"
                >
                  <span className="font-bold flex items-center gap-1">
                    <span className={`transition-transform inline-block ${showSangrias ? 'rotate-90' : ''}`}>▶</span>
                    ↓ Sangria · {sangriasList.length} lanc.
                  </span>
                  <span className="font-mono tabular-nums font-bold">{brl(t.totalSangrias)}</span>
                </button>
                {showSangrias && sangriasList.length > 0 && (
                  <div className="ml-3 pl-2 border-l-2 border-rose-200 space-y-0.5 max-h-48 overflow-y-auto">
                    {sangriasList.map((m) => {
                      const hora = horaBr(m.createdAt);
                      return (
                        <div key={m.id} className="flex justify-between items-start text-[10px] gap-2 hover:bg-rose-50 rounded px-1 py-0.5">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1">
                              <span className="text-slate-400 font-mono shrink-0">{hora}</span>
                              <span className="text-slate-700 truncate">{m.motivo || '(sem motivo)'}</span>
                            </div>
                            {m.userName && (
                              <div className="text-slate-400 italic truncate">por {m.userName.split(' ')[0]}</div>
                            )}
                          </div>
                          <span className="font-mono font-bold tabular-nums text-rose-700 shrink-0">{brl(m.valor)}</span>
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => setEditMov(m)}
                              className="shrink-0 text-slate-400 hover:text-violet-600 leading-none"
                              title="Editar / excluir (master)"
                            >
                              ✏️
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {t.totalSuprimentos > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowSuprimentos((v) => !v)}
                  className="w-full flex justify-between items-center text-[11px] text-amber-700 hover:bg-amber-50 rounded px-1 py-0.5 transition"
                  title="Clica pra ver os lancamentos"
                >
                  <span className="font-bold flex items-center gap-1">
                    <span className={`transition-transform inline-block ${showSuprimentos ? 'rotate-90' : ''}`}>▶</span>
                    ↑ Suprimento · {suprimentosList.length} lanc.
                  </span>
                  <span className="font-mono tabular-nums font-bold">{brl(t.totalSuprimentos)}</span>
                </button>
                {showSuprimentos && suprimentosList.length > 0 && (
                  <div className="ml-3 pl-2 border-l-2 border-amber-200 space-y-0.5 max-h-48 overflow-y-auto">
                    {suprimentosList.map((m) => {
                      const hora = horaBr(m.createdAt);
                      return (
                        <div key={m.id} className="flex justify-between items-start text-[10px] gap-2 hover:bg-amber-50 rounded px-1 py-0.5">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1">
                              <span className="text-slate-400 font-mono shrink-0">{hora}</span>
                              <span className="text-slate-700 truncate">{m.motivo || '(sem motivo)'}</span>
                            </div>
                            {m.userName && (
                              <div className="text-slate-400 italic truncate">por {m.userName.split(' ')[0]}</div>
                            )}
                          </div>
                          <span className="font-mono font-bold tabular-nums text-amber-700 shrink-0">{brl(m.valor)}</span>
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => setEditMov(m)}
                              className="shrink-0 text-slate-400 hover:text-violet-600 leading-none"
                              title="Editar / excluir (master)"
                            >
                              ✏️
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Ranking de vendedoras (colapsavel) */}
        {loja.vendedoras.length > 0 && (
          <div className="pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setRankingOpen(!rankingOpen)}
              className="w-full text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 hover:text-slate-700 transition-colors"
              title={rankingOpen ? 'Recolher ranking' : 'Expandir ranking'}
            >
              <Trophy size={10} className="text-amber-500" />
              <span>Ranking vendedoras</span>
              <span className="ml-auto text-slate-400 font-mono tabular-nums">
                {loja.vendedoras.length}
              </span>
              {rankingOpen
                ? <ChevronUp size={12} className="text-slate-400" />
                : <ChevronDown size={12} className="text-slate-400" />}
            </button>
            {rankingOpen && (
              <div className="space-y-0.5 mt-1">
                {loja.vendedoras.slice(0, 10).map((v, i) => (
                  <div key={i} className="flex items-center justify-between text-[11px]">
                    <span className="font-bold text-slate-700 truncate flex items-center gap-1">
                      {i === 0 && <span className="text-amber-500">🏆</span>}
                      {v.nome.split(' ')[0]}
                    </span>
                    <span className="font-mono tabular-nums text-slate-600">
                      {v.qtd} · <span className="font-bold text-emerald-700">{brl(v.total)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        </div>{/* fim da coluna do caixa */}
        </div>{/* fim do grid de colunas */}
      </div>
    </div>
  );
}

/**
 * Bandeiras de um cartão (crédito OU débito) como chips separados.
 * Cada chip abre a lista de vendas daquela bandeira na cascata.
 */
function BandeirasBloco({
  titulo, total, cor, chaves, detalhado, expanded, onToggle,
}: {
  titulo: string;
  total: number;
  cor: 'blue' | 'indigo';
  chaves: readonly string[];
  detalhado: Detalhado;
  expanded: string | null;
  onToggle: (v: string | null) => void;
}) {
  const itens = chaves
    .map((k) => ({ chave: k, slot: (detalhado.totais as any)[k] as Slot | undefined }))
    .filter((x) => x.slot && x.slot.qtd > 0);
  if (itens.length === 0) return null;
  const tons = cor === 'blue'
    ? { box: 'border-blue-200 bg-blue-50/60', head: 'text-blue-900', chip: 'border-blue-200 hover:bg-blue-100', on: 'bg-blue-600 text-white border-blue-700' }
    : { box: 'border-indigo-200 bg-indigo-50/60', head: 'text-indigo-900', chip: 'border-indigo-200 hover:bg-indigo-100', on: 'bg-indigo-600 text-white border-indigo-700' };
  return (
    <div className={`rounded-lg border p-2 space-y-1 ${tons.box}`}>
      <div className={`flex items-center justify-between text-[11px] font-bold uppercase tracking-wide ${tons.head}`}>
        <span className="flex items-center gap-1"><CreditCard size={11} /> {titulo}</span>
        <span className="font-mono tabular-nums">{brl(total)}</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {itens.map(({ chave, slot }) => {
          const key = `band:${chave}`;
          const ativo = expanded === key;
          return (
            <button
              key={chave}
              type="button"
              onClick={() => onToggle(ativo ? null : key)}
              className={`rounded-md border bg-white px-1.5 py-1 text-left transition ${ativo ? tons.on : tons.chip}`}
              title={`${slot!.qtd} venda(s) — clica pra ver`}
            >
              <div className="text-[9px] font-bold uppercase leading-tight truncate">
                {BANDEIRA_LABEL[chave] || chave.replace(/_/g, ' ')}
              </div>
              <div className="flex items-baseline justify-between gap-1">
                <span className="text-[11px] font-black tabular-nums">{brl(slot!.valor)}</span>
                <span className={`text-[9px] ${ativo ? 'opacity-80' : 'text-slate-400'}`}>{slot!.qtd}x</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModItem({ label, valor, cor, onClick, active, badge }: { label: string; valor: number; cor: 'emerald' | 'cyan' | 'blue' | 'indigo' | 'rose' | 'violet'; onClick?: () => void; active?: boolean; badge?: React.ReactNode }) {
  const tones = {
    emerald: 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100 hover:border-emerald-300',
    cyan: 'bg-cyan-50 text-cyan-800 border-cyan-200 hover:bg-cyan-100 hover:border-cyan-300',
    blue: 'bg-blue-50 text-blue-800 border-blue-200 hover:bg-blue-100 hover:border-blue-300',
    indigo: 'bg-indigo-50 text-indigo-800 border-indigo-200 hover:bg-indigo-100 hover:border-indigo-300',
    rose: 'bg-rose-50 text-rose-800 border-rose-200 hover:bg-rose-100 hover:border-rose-300',
    violet: 'bg-violet-50 text-violet-800 border-violet-200 hover:bg-violet-100 hover:border-violet-300',
  };
  const tonesActive = {
    emerald: 'bg-emerald-600 text-white border-emerald-700 shadow-md',
    cyan: 'bg-cyan-600 text-white border-cyan-700 shadow-md',
    blue: 'bg-blue-600 text-white border-blue-700 shadow-md',
    indigo: 'bg-indigo-600 text-white border-indigo-700 shadow-md',
    rose: 'bg-rose-600 text-white border-rose-700 shadow-md',
    violet: 'bg-violet-600 text-white border-violet-700 shadow-md',
  };
  const ativo = valor > 0;
  const cls = active ? tonesActive[cor] : (ativo ? tones[cor] : 'bg-slate-50 border-slate-200 text-slate-400');
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`rounded-md border px-1.5 py-1 text-center transition-all disabled:cursor-default ${onClick ? 'cursor-pointer' : ''} ${cls}`}
    >
      <div className="text-[8px] uppercase font-bold tracking-tight">{label}</div>
      <div className="text-[11px] font-black tabular-nums leading-tight">{brl(valor)}</div>
      {badge && <div className="mt-0.5 flex justify-center">{badge}</div>}
    </button>
  );
}

// ── Cascade detalhada por modalidade ──
const BANDEIRAS_CREDITO = ['MASTERCARD', 'VISANET', 'CIELO', 'ELO', 'AMEX', 'HIPERCARD', 'CREDITO_GENERICO'] as const;
const BANDEIRAS_DEBITO = ['VISA_ELECTRON', 'REDE_SHOP', 'ELO_DEBITO', 'DEBITO_GENERICO'] as const;
/** Nome curto de cada bandeira pros chips do card. */
const BANDEIRA_LABEL: Record<string, string> = {
  MASTERCARD: 'Mastercard', VISANET: 'Visa', CIELO: 'Cielo', ELO: 'Elo',
  AMEX: 'Amex', HIPERCARD: 'Hipercard', CREDITO_GENERICO: 'Sem bandeira',
  VISA_ELECTRON: 'Visa Electron', REDE_SHOP: 'Redeshop', ELO_DEBITO: 'Elo débito',
  DEBITO_GENERICO: 'Sem bandeira',
};

function CascadeModalidade({
  detalhado, modalidade, isAdmin, onEditBandeira,
}: {
  detalhado: Detalhado;
  modalidade: string;
  isAdmin?: boolean;
  onEditBandeira?: (paymentId: string, currentBandeira: string, valor: number, saleHint: string, currentMethod?: string) => void;
}) {
  const isCartao = modalidade === 'credito' || modalidade === 'debito';
  const [bandeiraOpen, setBandeiraOpen] = useState<string | null>(null);

  // Chip de bandeira clicado no card (ex: "band:MASTERCARD") — lista direto as
  // vendas daquela bandeira, sem passar pelo agrupamento de crédito/débito.
  if (modalidade.startsWith('band:')) {
    const chave = modalidade.slice(5);
    const slot = (detalhado.totais as any)[chave] as Slot | undefined;
    const metodo = (BANDEIRAS_DEBITO as readonly string[]).includes(chave) ? 'debito' : 'credito';
    return (
      <div className="space-y-1">
        <div className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">
          {BANDEIRA_LABEL[chave] || chave.replace(/_/g, ' ')} · {metodo}
        </div>
        <ListaVendas
          vendas={slot?.vendas || []}
          bandeiraAtual={chave}
          modalidadeAtual={metodo}
          isAdmin={isAdmin}
          onEditBandeira={onEditBandeira}
        />
      </div>
    );
  }
  if (modalidade === 'dinheiro') {
    return <ListaVendas vendas={detalhado.totais.DINHEIRO.vendas} modalidadeAtual="dinheiro" isAdmin={isAdmin} onEditBandeira={onEditBandeira} />;
  }
  if (modalidade === 'pix') {
    return <ListaVendas vendas={detalhado.totais.PIX.vendas} modalidadeAtual="pix" isAdmin={isAdmin} onEditBandeira={onEditBandeira} />;
  }
  if (modalidade === 'crediario') {
    return <ListaVendas vendas={detalhado.totais.CREDIARIO.vendas} modalidadeAtual="crediario" isAdmin={isAdmin} onEditBandeira={onEditBandeira} />;
  }
  if (modalidade === 'venda_online') {
    // Agrupa por FORMATO (PIX direto / link externo / link de cartão), igual
    // o crédito agrupa por bandeira — é a resposta pra "como entrou o dinheiro".
    const grupos = resumoOnlinePorFormato(detalhado);
    if (grupos.length === 0) {
      return <ListaVendas vendas={detalhado.totais.VENDA_ONLINE?.vendas || []} modalidadeAtual="venda_online" isAdmin={isAdmin} onEditBandeira={onEditBandeira} />;
    }
    return (
      <div className="space-y-1">
        {grupos.map((g) => {
          const gKey = `online:${g.key || 'sem'}`;
          return (
            <div key={gKey} className="bg-violet-50 rounded-md border border-violet-200 overflow-hidden">
              <button
                onClick={() => setBandeiraOpen(bandeiraOpen === gKey ? null : gKey)}
                className="w-full flex items-center justify-between px-2 py-1.5 text-xs hover:bg-violet-100"
              >
                <span className="font-bold text-violet-900">{g.label}</span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-violet-600">{g.qtd} {g.qtd === 1 ? 'tk' : 'tks'}</span>
                  <span className="font-mono font-bold tabular-nums text-violet-900">{brl(g.valor)}</span>
                  <span className={`text-[10px] transition-transform ${bandeiraOpen === gKey ? 'rotate-180' : ''}`}>▼</span>
                </div>
              </button>
              {bandeiraOpen === gKey && (
                <div className="border-t border-violet-200 bg-white px-2 py-1.5">
                  <ListaVendas vendas={g.vendas} modalidadeAtual="venda_online" isAdmin={isAdmin} onEditBandeira={onEditBandeira} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Cartão crédito ou débito — agrupa por bandeira
  const bandeiras = (modalidade === 'credito' ? BANDEIRAS_CREDITO : BANDEIRAS_DEBITO)
    .map((b) => ({ nome: b, slot: (detalhado.totais as any)[b] as Slot }))
    .filter((b) => b.slot && b.slot.qtd > 0);

  if (bandeiras.length === 0) {
    return <div className="text-[11px] text-slate-400 italic text-center py-2">Sem vendas registradas</div>;
  }

  return (
    <div className="space-y-1">
      {bandeiras.map((b) => (
        <div key={b.nome} className="bg-slate-50 rounded-md border border-slate-200 overflow-hidden">
          <button
            onClick={() => setBandeiraOpen(bandeiraOpen === b.nome ? null : b.nome)}
            className="w-full flex items-center justify-between px-2 py-1.5 text-xs hover:bg-slate-100"
          >
            <span className="font-bold text-slate-700">{b.nome.replace('_', ' ')}</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500">{b.slot.qtd} {b.slot.qtd === 1 ? 'tk' : 'tks'}</span>
              <span className="font-mono font-bold tabular-nums text-slate-800">{brl(b.slot.valor)}</span>
              <span className={`text-[10px] transition-transform ${bandeiraOpen === b.nome ? 'rotate-180' : ''}`}>â¼</span>
            </div>
          </button>
          {bandeiraOpen === b.nome && (
            <div className="border-t border-slate-200 bg-white px-2 py-1.5">
              <ListaVendas
                vendas={b.slot.vendas}
                bandeiraAtual={b.nome}
                modalidadeAtual={modalidade}
                isAdmin={isAdmin}
                onEditBandeira={onEditBandeira}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ListaVendas({
  vendas, bandeiraAtual, modalidadeAtual, isAdmin, onEditBandeira,
}: {
  vendas: Slot['vendas'];
  bandeiraAtual?: string;
  modalidadeAtual?: string;
  isAdmin?: boolean;
  onEditBandeira?: (paymentId: string, currentBandeira: string, valor: number, saleHint: string, currentMethod?: string) => void;
}) {
  if (!vendas || vendas.length === 0) {
    return <div className="text-[11px] text-slate-400 italic text-center py-2">Sem vendas</div>;
  }
  return (
    <div className="space-y-0.5 max-h-60 overflow-y-auto">
      {vendas.map((v, i) => {
        const hora = v.finalizedAt ? horaBr(v.finalizedAt) : '';
        const cliente = v.customerName || (v.customerCpf ? `CPF ${v.customerCpf}` : 'Sem identificacao');
        return (
          <div key={i} className="flex items-center justify-between text-[11px] py-0.5 px-1 hover:bg-slate-50 rounded">
            <div className="flex items-center gap-2 min-w-0">
              {hora && <span className="text-slate-400 font-mono shrink-0">{hora}</span>}
              <span className={`truncate ${v.customerName ? 'text-slate-800 font-medium' : 'text-slate-400 italic'}`}>{cliente}</span>
              {v.sellerName && <span className="text-slate-500 text-[10px] shrink-0">- {v.sellerName.split(' ')[0]}</span>}
              {v.parcelas && v.parcelas > 1 && <span className="text-violet-600 text-[10px] shrink-0">- {v.parcelas}x</span>}
              {/* Formato da venda online direto na linha — vale também quando a
                  lista aparece fora do agrupamento por formato. */}
              {v.onlineTipo && (
                <span className="shrink-0 text-[9px] font-bold uppercase text-violet-700 bg-violet-100 border border-violet-200 rounded px-1">
                  {ONLINE_FORMATOS.find((f) => f.key === v.onlineTipo)?.curto || v.onlineTipo}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-2">
              <span className="font-mono font-bold tabular-nums">{brl(v.valor)}</span>
              {isAdmin && onEditBandeira && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const hint = `${cliente} - ${brl(v.valor)}`;
                    onEditBandeira(v.paymentId, bandeiraAtual || '', v.valor, hint, modalidadeAtual);
                  }}
                  title="Editar pagamento (master)"
                  className="text-[10px] text-violet-600 hover:text-violet-900 font-bold underline"
                >
                  editar
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Modal de edição de bandeira (admin only) ───
const BANDEIRAS_DISPONIVEIS = [
  { value: 'MASTERCARD', label: 'MASTERCARD' },
  { value: 'VISANET', label: 'VISA (Visanet)' },
  { value: 'CIELO', label: 'CIELO' },
  { value: 'ELO', label: 'ELO' },
  { value: 'AMEX', label: 'AMEX (American Express)' },
  { value: 'HIPERCARD', label: 'HIPERCARD' },
  { value: 'VISA_ELECTRON', label: 'VISA ELECTRON' },
  { value: 'REDE_SHOP', label: 'REDE SHOP' },
  { value: 'CREDITO_GENERICO', label: 'Crédito genérico' },
  { value: 'DEBITO_GENERICO', label: 'Débito genérico' },
  { value: 'OUTROS', label: 'OUTROS' },
];

function EditBandeiraModal({
  paymentId, currentBandeira, valor, saleHint, onClose, onSaved,
}: {
  paymentId: string;
  currentBandeira: string;
  valor: number;
  saleHint: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nova, setNova] = useState(currentBandeira);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function save() {
    if (!nova || nova === currentBandeira) {
      setErrMsg('Escolha uma bandeira diferente da atual');
      return;
    }
    setSaving(true);
    setErrMsg(null);
    try {
      const r: any = await api(`/pdv/caixa/payments/${paymentId}/bandeira`, {
        method: 'PATCH',
        body: JSON.stringify({ bandeira: nova, reason: reason || undefined }),
      });
      if (r?.ok) {
        const wOk = r.wincred?.ok;
        if (!wOk) {
          alert(`Atualizado no flowops, mas Wincred falhou: ${r.wincred?.error || 'sem detalhes'}.\nA mudança aparece no painel mas pode precisar de ajuste manual no Giga.`);
        }
        onSaved();
      } else {
        setErrMsg(r?.message || 'Falha desconhecida');
      }
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" {...overlayClose(onClose)}>
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-black mb-1">Trocar bandeira do cartão</h2>
        <p className="text-xs text-slate-500 mb-3">{saleHint}</p>

        <div className="bg-slate-50 rounded-lg p-3 mb-3 text-xs">
          <div className="flex justify-between mb-1">
            <span className="text-slate-500">Bandeira atual:</span>
            <span className="font-bold text-rose-700">{currentBandeira || '(vazio)'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Valor:</span>
            <span className="font-mono font-bold">{brl(valor)}</span>
          </div>
        </div>

        <label className="block text-xs font-bold text-slate-700 mb-1">Nova bandeira:</label>
        <select
          value={nova}
          onChange={(e) => setNova(e.target.value)}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          {BANDEIRAS_DISPONIVEIS.map((b) => (
            <option key={b.value} value={b.value}>{b.label}</option>
          ))}
        </select>

        <label className="block text-xs font-bold text-slate-700 mb-1">Motivo (opcional):</label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="ex: operadora bipou bandeira errada"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-violet-500"
        />

        {errMsg && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded p-2 mb-3">{errMsg}</div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={save}
            disabled={saving || nova === currentBandeira}
            className="px-4 py-2 text-sm font-bold text-white bg-violet-600 hover:bg-violet-700 rounded-lg disabled:opacity-40"
          >
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MASTER ADJUST MODAL — ajusta fundo de caixa OU adiciona sangria/suprimento
// Usa senha master (env MASTER_PASSWORD). Persiste a senha em sessionStorage
// pra nao precisar redigitar a cada loja na mesma sessao do navegador.
// ═══════════════════════════════════════════════════════════════════════
function MasterAdjustModal({
  loja, onClose, onSaved, date,
}: {
  loja: Loja;
  onClose: () => void;
  onSaved: () => void;
  /** Data do filtro (YYYY-MM-DD) no modo HISTÓRICO — ajusta o fundo da 1ª
   *  sessão DESSE dia (a que o painel mostra). Nulo no modo ao vivo. */
  date?: string | null;
}) {
  type Tab = 'fundo' | 'sangria' | 'suprimento';
  const [tab, setTab] = useState<Tab>('fundo');
  const [password, setPassword] = useState<string>(() => {
    try { return sessionStorage.getItem('flowops.masterPwd') || ''; } catch { return ''; }
  });
  const [savePwd, setSavePwd] = useState(true);
  const [valor, setValor] = useState<string>(tab === 'fundo' ? String(loja.fundoTroco || 0) : '');
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // Reset valor ao trocar de aba
  useEffect(() => {
    setValor(tab === 'fundo' ? String(loja.fundoTroco || 0) : '');
    setErrMsg(null);
    setOkMsg(null);
  }, [tab, loja.fundoTroco]);

  async function save() {
    setErrMsg(null);
    setOkMsg(null);
    if (!password) { setErrMsg('Senha master obrigatoria'); return; }
    const valorNum = Number(String(valor).replace(',', '.'));
    if (isNaN(valorNum) || (tab !== 'fundo' && valorNum <= 0) || valorNum < 0) {
      setErrMsg('Valor invalido');
      return;
    }
    if (!motivo || motivo.trim().length < 3) {
      setErrMsg('Informe o motivo (minimo 3 caracteres)');
      return;
    }
    setSaving(true);
    try {
      if (tab === 'fundo') {
        await api('/pdv/caixa/master/fundo', {
          method: 'PATCH',
          body: JSON.stringify({
            storeCode: loja.storeCode,
            valor: valorNum,
            motivo: motivo.trim(),
            password,
            // Modo histórico: ajusta a 1ª sessão do dia filtrado (a que o
            // painel exibe). Sem data (ao vivo), backend usa a última sessão.
            ...(date ? { date } : {}),
          }),
        });
      } else {
        await api('/pdv/caixa/master/movement', {
          method: 'POST',
          body: JSON.stringify({
            storeCode: loja.storeCode,
            tipo: tab,
            valor: valorNum,
            motivo: motivo.trim(),
            password,
            // Modo histórico: grava na sessão do dia filtrado (a que o painel
            // exibe). Sem data (ao vivo, caixa aberto), backend usa a última sessão.
            ...(date ? { date } : {}),
          }),
        });
      }
      if (savePwd) {
        try { sessionStorage.setItem('flowops.masterPwd', password); } catch {}
      }
      setOkMsg('Ajuste salvo. Recarregando...');
      setTimeout(() => onSaved(), 600);
    } catch (e: any) {
      setErrMsg(e?.message || 'Falha no ajuste');
    } finally {
      setSaving(false);
    }
  }

  // Portal: renderiza no body pra escapar de parents com `transform`/`overflow`
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9998] bg-black/60 flex items-center justify-center p-4" {...overlayClose(onClose)}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-lg font-black text-slate-900">⚙️ Ajustes Master</h3>
            <p className="text-xs text-slate-500 font-bold">{loja.storeName} <span className="font-mono opacity-70">{loja.storeCode}</span></p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-4 bg-slate-100 rounded-lg p-1">
          {(['fundo','sangria','suprimento'] as Tab[]).map((tk) => (
            <button
              key={tk}
              onClick={() => setTab(tk)}
              className={`flex-1 py-2 text-xs font-bold rounded transition ${
                tab === tk ? 'bg-white text-violet-700 shadow' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tk === 'fundo' ? '💵 Fundo' : tk === 'sangria' ? '⬇️ Sangria' : '⬆️ Suprimento'}
            </button>
          ))}
        </div>

        <label className="block text-xs font-bold text-slate-700 mb-1">
          {tab === 'fundo' ? 'Novo valor do fundo (R$)' : tab === 'sangria' ? 'Valor da sangria (R$)' : 'Valor do suprimento (R$)'}
        </label>
        <input
          type="number"
          step="0.01"
          min="0"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          placeholder="0.00"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
        />

        <label className="block text-xs font-bold text-slate-700 mb-1">Motivo *</label>
        <input
          type="text"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder={tab === 'fundo' ? 'ex: correcao de abertura' : tab === 'sangria' ? 'ex: deposito banco' : 'ex: reforco de troco'}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-violet-500"
        />

        <label className="block text-xs font-bold text-slate-700 mb-1">Senha master *</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="senha"
          autoComplete="current-password"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-2 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
        />
        <label className="flex items-center gap-2 text-[11px] text-slate-600 mb-3 cursor-pointer">
          <input type="checkbox" checked={savePwd} onChange={(e) => setSavePwd(e.target.checked)} />
          Lembrar senha nesta sessao
        </label>

        {errMsg && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded p-2 mb-3">{errMsg}</div>}
        {okMsg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded p-2 mb-3">{okMsg}</div>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm font-bold text-white bg-violet-600 hover:bg-violet-700 rounded-lg disabled:opacity-40"
          >
            {saving ? 'Salvando...' : 'Confirmar'}
          </button>
        </div>

        <p className="mt-3 text-[10px] text-slate-400 leading-tight">
          ⚠️ Acao registrada em log com seu usuario. Use somente pra correcoes legitimas — sem rastreabilidade visual no fluxo da vendedora.
        </p>
      </div>
    </div>,
    document.body,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MOVEMENT EDIT MODAL — edita/exclui UM lançamento de sangria/suprimento.
// Reusa a senha master (sessionStorage) do painel. PATCH edita valor/motivo;
// DELETE (com confirmação) estorna. O backend recalcula o caixa do dia.
// ═══════════════════════════════════════════════════════════════════════
function MovementEditModal({
  loja, mov, onClose, onSaved,
}: {
  loja: Loja;
  mov: Movimento;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ehSangria = mov.tipo === 'sangria';
  const [password, setPassword] = useState<string>(() => {
    try { return sessionStorage.getItem('flowops.masterPwd') || ''; } catch { return ''; }
  });
  const [savePwd, setSavePwd] = useState(true);
  const [valor, setValor] = useState<string>(String(mov.valor ?? ''));
  const [motivo, setMotivo] = useState<string>(mov.motivo || '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const rememberPwd = () => {
    if (savePwd) { try { sessionStorage.setItem('flowops.masterPwd', password); } catch {} }
  };

  async function salvar() {
    setErrMsg(null); setOkMsg(null);
    if (!password) { setErrMsg('Senha master obrigatoria'); return; }
    const valorNum = Number(String(valor).replace(',', '.'));
    if (isNaN(valorNum) || valorNum <= 0) { setErrMsg('Valor invalido'); return; }
    if (!motivo || motivo.trim().length < 3) { setErrMsg('Informe o motivo (minimo 3 caracteres)'); return; }
    setSaving(true);
    try {
      await api(`/pdv/caixa/master/movement/${mov.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ valor: valorNum, motivo: motivo.trim(), password }),
      });
      rememberPwd();
      setOkMsg('Lançamento atualizado. Recarregando...');
      setTimeout(() => onSaved(), 600);
    } catch (e: any) {
      setErrMsg(e?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function excluir() {
    setErrMsg(null); setOkMsg(null);
    if (!password) { setErrMsg('Senha master obrigatoria'); return; }
    if (!window.confirm(`Excluir este lançamento de ${ehSangria ? 'sangria' : 'suprimento'} de ${brl(mov.valor)}?\n\nO caixa do dia é recalculado.`)) return;
    setDeleting(true);
    try {
      await api(`/pdv/caixa/master/movement/${mov.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ password }),
      });
      rememberPwd();
      setOkMsg('Lançamento excluído. Recarregando...');
      setTimeout(() => onSaved(), 600);
    } catch (e: any) {
      setErrMsg(e?.message || 'Falha ao excluir');
    } finally {
      setDeleting(false);
    }
  }

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  const busy = saving || deleting;

  return createPortal(
    <div className="fixed inset-0 z-[9998] bg-black/60 flex items-center justify-center p-4" {...overlayClose(onClose)}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-lg font-black text-slate-900">
              {ehSangria ? '⬇️ Editar sangria' : '⬆️ Editar suprimento'}
            </h3>
            <p className="text-xs text-slate-500 font-bold">{loja.storeName} <span className="font-mono opacity-70">{loja.storeCode}</span></p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        <label className="block text-xs font-bold text-slate-700 mb-1">Valor (R$)</label>
        <input
          type="number" step="0.01" min="0" value={valor}
          onChange={(e) => setValor(e.target.value)} placeholder="0.00"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
        />

        <label className="block text-xs font-bold text-slate-700 mb-1">Motivo *</label>
        <input
          type="text" value={motivo}
          onChange={(e) => setMotivo(e.target.value)} placeholder="motivo do lançamento"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-violet-500"
        />

        <label className="block text-xs font-bold text-slate-700 mb-1">Senha master *</label>
        <input
          type="password" value={password}
          onChange={(e) => setPassword(e.target.value)} placeholder="senha" autoComplete="current-password"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-2 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
        />
        <label className="flex items-center gap-2 text-[11px] text-slate-600 mb-3 cursor-pointer">
          <input type="checkbox" checked={savePwd} onChange={(e) => setSavePwd(e.target.checked)} />
          Lembrar senha nesta sessao
        </label>

        {errMsg && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded p-2 mb-3">{errMsg}</div>}
        {okMsg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded p-2 mb-3">{okMsg}</div>}

        <div className="flex items-center justify-between gap-2">
          <button
            onClick={excluir} disabled={busy}
            className="px-4 py-2 text-sm font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-lg disabled:opacity-40"
          >
            {deleting ? 'Excluindo...' : '🗑️ Excluir'}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={busy} className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-40">Cancelar</button>
            <button onClick={salvar} disabled={busy} className="px-4 py-2 text-sm font-bold text-white bg-violet-600 hover:bg-violet-700 rounded-lg disabled:opacity-40">
              {saving ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        </div>

        <p className="mt-3 text-[10px] text-slate-400 leading-tight">
          ⚠️ Ação registrada em log com seu usuario. O caixa do dia é recalculado ao salvar/excluir.
        </p>
      </div>
    </div>,
    document.body,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MASTER EDIT PAYMENT MODAL — edita method/valor/bandeira de um pagamento
// Usado pra corrigir vendas registradas com modalidade errada (ex: dinheiro
// que era PIX). Senha por nivel (MASTER+).
// ═══════════════════════════════════════════════════════════════════════
const METHOD_OPTIONS = [
  { value: 'dinheiro', label: '💵 Dinheiro' },
  { value: 'pix', label: '📲 PIX' },
  { value: 'credito', label: '💳 Cartão Crédito' },
  { value: 'debito', label: '💳 Cartão Débito' },
  { value: 'crediario', label: '📝 Crediário' },
];

function MasterEditPaymentModal({
  paymentId, currentBandeira, currentMethod, currentValor, saleHint, onClose, onSaved,
}: {
  paymentId: string;
  currentBandeira: string;
  currentMethod: string;
  currentValor: number;
  saleHint: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [method, setMethod] = useState(currentMethod || 'credito');
  const [valor, setValor] = useState<string>(String(currentValor));
  const [bandeira, setBandeira] = useState(currentBandeira || '');
  const [motivo, setMotivo] = useState('');
  const [password, setPassword] = useState<string>(() => {
    try { return sessionStorage.getItem('flowops.masterPwd') || ''; } catch { return ''; }
  });
  const [savePwd, setSavePwd] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const isCartao = method === 'credito' || method === 'debito';

  async function save() {
    setErrMsg(null);
    if (!password) { setErrMsg('Senha obrigatoria'); return; }
    if (!motivo || motivo.trim().length < 3) { setErrMsg('Motivo obrigatorio (>=3 chars)'); return; }
    const valorNum = Number(String(valor).replace(',', '.'));
    if (isNaN(valorNum) || valorNum <= 0) { setErrMsg('Valor invalido'); return; }

    const payload: any = {
      motivo: motivo.trim(),
      password,
    };
    if (method !== currentMethod) payload.method = method;
    if (valorNum !== currentValor) payload.valor = valorNum;
    if (isCartao && bandeira && bandeira !== currentBandeira) {
      payload.bandeira = bandeira.toUpperCase();
    }

    if (!payload.method && !payload.valor && !payload.bandeira) {
      setErrMsg('Nada foi alterado');
      return;
    }

    setSaving(true);
    try {
      await api(`/pdv/caixa/master/payment/${paymentId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      if (savePwd) {
        try { sessionStorage.setItem('flowops.masterPwd', password); } catch {}
      }
      onSaved();
    } catch (e: any) {
      setErrMsg(e?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  // Portal: renderiza no body pra escapar de parents com `transform`/`overflow`
  // que quebram `position: fixed` (motivo do bug do modal transparente preso no card).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9998] bg-black/60 flex items-center justify-center p-4" {...overlayClose(onClose)}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-lg font-black text-slate-900">✏️ Editar Pagamento</h3>
            <p className="text-xs text-slate-500 truncate max-w-[280px]">{saleHint}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        <label className="block text-xs font-bold text-slate-700 mb-1">Modalidade *</label>
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          {METHOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <label className="block text-xs font-bold text-slate-700 mb-1">Valor (R$) *</label>
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
        />

        {isCartao && (
          <>
            <label className="block text-xs font-bold text-slate-700 mb-1">Bandeira</label>
            <select
              value={bandeira}
              onChange={(e) => setBandeira(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-violet-500"
            >
              <option value="">— manter atual —</option>
              {BANDEIRAS_DISPONIVEIS.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </>
        )}

        <label className="block text-xs font-bold text-slate-700 mb-1">Motivo *</label>
        <input
          type="text"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="ex: caixa marcou dinheiro mas foi pix"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-violet-500"
        />

        <label className="block text-xs font-bold text-slate-700 mb-1">Senha (MASTER ou SUPREMA)</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="senha"
          autoComplete="current-password"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-2 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
        />
        <label className="flex items-center gap-2 text-[11px] text-slate-600 mb-3 cursor-pointer">
          <input type="checkbox" checked={savePwd} onChange={(e) => setSavePwd(e.target.checked)} />
          Lembrar senha nesta sessao
        </label>

        {errMsg && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded p-2 mb-3">{errMsg}</div>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-40">
            Cancelar
          </button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 text-sm font-bold text-white bg-violet-600 hover:bg-violet-700 rounded-lg disabled:opacity-40">
            {saving ? 'Salvando...' : 'Confirmar'}
          </button>
        </div>

        <p className="mt-3 text-[10px] text-slate-400 leading-tight">
          ⚠️ Alteracao registrada em PdvPaymentAudit. Se sessao ja fechou, totais sao recalculados automaticamente.
        </p>
      </div>
    </div>,
    document.body,
  );
}
