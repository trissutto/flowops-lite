'use client';

/**
 * /retaguarda/super-painel-caixas
 *
 * Painel ao vivo de TODAS as lojas: status do caixa, totais por modalidade,
 * ranking de vendedoras. Auto-refresh a cada 60s.
 */

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, RefreshCw, Loader2, AlertCircle, Banknote, QrCode, CreditCard,
  TrendingUp, Lock, Unlock, Trophy,
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
    VISA_ELECTRON: Slot; REDE_SHOP: Slot;
    CREDITO_GENERICO: Slot; DEBITO_GENERICO: Slot; OUTROS: Slot;
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
  openedAt: string | null;
  openedByName: string | null;
  fundoTroco: number;
  // ── Conferência manual de caixa (admin marca dia anterior como "conferido")
  checkedAt?: string | null;
  checkedByName?: string | null;
  checkedNote?: string | null;
  sessionsDoDia?: string[]; // IDs das sessões do dia (modo histórico)
  totais: {
    totalVendas: number;
    totalDinheiro: number;
    totalPix: number;
    totalCartaoCredito: number;
    totalCartaoDebito: number;
    totalCrediario: number;
    totalSangrias: number;
    totalSuprimentos: number;
    dinheiroEsperado: number;
    qtdVendas: number;
  };
  vendedoras: Vendedora[];
  movimentos?: Movimento[];
  recebimentosCrediario?: RecebimentosCrediario;
  detalhado: Detalhado | null;
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
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Detecta role do user (admin pode editar bandeira)
  useEffect(() => {
    (async () => {
      try {
        const me = await api<{ role: string }>('/auth/me');
        setIsAdmin(me?.role === 'admin');
      } catch { /* ignora */ }
    })();
  }, []);

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
                  <div className="text-xs uppercase tracking-wider opacity-80 font-bold">Vendas hoje · TODAS as lojas</div>
                  <div className="text-5xl font-black tabular-nums mt-1">{brl(data.consolidado.totalVendas)}</div>
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
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-white/20">
                <ConsolidadoItem label="Dinheiro" valor={data.consolidado.totalDinheiro} icon={<Banknote size={14} />} />
                <ConsolidadoItem label="PIX" valor={data.consolidado.totalPix} icon={<QrCode size={14} />} />
                <ConsolidadoItem label="Cartão Crédito" valor={data.consolidado.totalCartaoCredito} icon={<CreditCard size={14} />} />
                <ConsolidadoItem label="Cartão Débito" valor={data.consolidado.totalCartaoDebito} icon={<CreditCard size={14} />} />
                <ConsolidadoItem label="Crediário" valor={data.consolidado.totalCrediario} icon={<TrendingUp size={14} />} />
              </div>
            </div>

            {/* Grid de lojas */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {data.lojas.map((l) => (
                <LojaCard key={l.storeCode} loja={l} isAdmin={isAdmin} onReload={() => load(true)} />
              ))}
            </div>

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

function LojaCard({ loja, isAdmin, onReload }: { loja: Loja; isAdmin?: boolean; onReload?: () => void }) {
  const reload = () => { if (onReload) onReload(); };
  const t = loja.totais;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showSangrias, setShowSangrias] = useState(false);
  const [showSuprimentos, setShowSuprimentos] = useState(false);
  const [showRecebimentos, setShowRecebimentos] = useState(false);
  const [editBandeira, setEditBandeira] = useState<{ paymentId: string; currentBandeira: string; valor: number; saleHint: string } | null>(null);
  const sangriasList = (loja.movimentos || []).filter((m) => m.tipo === 'sangria');
  const suprimentosList = (loja.movimentos || []).filter((m) => m.tipo === 'suprimento');
  const rec = loja.recebimentosCrediario || { totalGeral: 0, totalDinheiro: 0, totalPix: 0, baixas: [] };
  const recDinheiroBaixas = rec.baixas.filter((b) => b.forma === 'dinheiro' || (b.forma === 'misto' && (b.valorDinheiro || 0) > 0));
  const recPixBaixas = rec.baixas.filter((b) => b.forma === 'pix' || (b.forma === 'misto' && (b.valorPix || 0) > 0));
  return (
    <div className={`rounded-xl shadow-lg overflow-hidden border-2 ${
      loja.aberta ? 'bg-white border-emerald-300' : 'bg-slate-100 border-slate-300 opacity-75'
    }`}>
      {/* Header da loja */}
      <div className={`px-3 py-2 flex items-center justify-between ${
        loja.aberta ? 'bg-emerald-600 text-white' : 'bg-slate-400 text-white'
      }`}>
        <div className="flex items-center gap-1.5">
          {loja.aberta ? <Unlock size={14} /> : <Lock size={14} />}
          <span className="font-black text-sm uppercase">{loja.storeName}</span>
          <span className="text-[10px] opacity-80 font-mono">{loja.storeCode}</span>
        </div>
        {loja.aberta ? (
          <span className="text-[10px] opacity-90 font-bold">desde {fmtTime(loja.openedAt)}</span>
        ) : (
          <span className="text-[10px] opacity-90 font-bold uppercase">Fechado</span>
        )}
      </div>

      {/* Total grande */}
      <div className="p-3 space-y-2">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-500">Vendas hoje</div>
            <div className={`text-3xl font-black tabular-nums ${loja.aberta ? 'text-emerald-700' : 'text-slate-400'}`}>
              {brl(t.totalVendas)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-slate-500 font-bold">{t.qtdVendas} ticket{t.qtdVendas !== 1 ? 's' : ''}</div>
            {loja.openedByName && (
              <div className="text-[10px] text-slate-400 italic truncate max-w-[120px]">{loja.openedByName}</div>
            )}
          </div>
        </div>

        {/* Breakdown por modalidade — clicável pra expandir cascade */}
        <div className="grid grid-cols-5 gap-1 pt-2 border-t border-slate-200">
          <ModItem label="Dinheiro" valor={t.totalDinheiro} cor="emerald"
            active={expanded === 'dinheiro'}
            onClick={loja.detalhado && t.totalDinheiro > 0 ? () => setExpanded(expanded === 'dinheiro' ? null : 'dinheiro') : undefined} />
          <ModItem label="PIX" valor={t.totalPix} cor="cyan"
            active={expanded === 'pix'}
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
        </div>

        {/* Cascade — vendas/bandeiras quando expandido */}
        {expanded && loja.detalhado && (
          <div className="pt-2 border-t border-slate-100">
            <CascadeModalidade
              detalhado={loja.detalhado}
              modalidade={expanded}
              isAdmin={isAdmin}
              onEditBandeira={(paymentId, currentBandeira, valor, saleHint) =>
                setEditBandeira({ paymentId, currentBandeira, valor, saleHint })
              }
            />
          </div>
        )}

        {/* Modal de edição de bandeira (admin only) */}
        {editBandeira && (
          <EditBandeiraModal
            paymentId={editBandeira.paymentId}
            currentBandeira={editBandeira.currentBandeira}
            valor={editBandeira.valor}
            saleHint={editBandeira.saleHint}
            onClose={() => setEditBandeira(null)}
            onSaved={() => { setEditBandeira(null); reload(); }}
          />
        )}

        {/* Bloco financeiro do caixa: fundo, dinheiro fim de dia, conferência */}
        {(loja.aberta || t.totalSangrias > 0 || t.totalSuprimentos > 0 || loja.fundoTroco > 0 || t.totalDinheiro > 0) && (
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
                      const hora = new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
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
                      const hora = new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
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
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Ranking de vendedoras */}
        {loja.vendedoras.length > 0 && (
          <div className="pt-2 border-t border-slate-100">
            <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1">
              <Trophy size={10} className="text-amber-500" /> Ranking vendedoras
            </div>
            <div className="space-y-0.5">
              {loja.vendedoras.slice(0, 5).map((v, i) => (
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
          </div>
        )}
      </div>
    </div>
  );
}

function ModItem({ label, valor, cor, onClick, active }: { label: string; valor: number; cor: 'emerald' | 'cyan' | 'blue' | 'indigo' | 'rose'; onClick?: () => void; active?: boolean }) {
  const tones = {
    emerald: 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100 hover:border-emerald-300',
    cyan: 'bg-cyan-50 text-cyan-800 border-cyan-200 hover:bg-cyan-100 hover:border-cyan-300',
    blue: 'bg-blue-50 text-blue-800 border-blue-200 hover:bg-blue-100 hover:border-blue-300',
    indigo: 'bg-indigo-50 text-indigo-800 border-indigo-200 hover:bg-indigo-100 hover:border-indigo-300',
    rose: 'bg-rose-50 text-rose-800 border-rose-200 hover:bg-rose-100 hover:border-rose-300',
  };
  const tonesActive = {
    emerald: 'bg-emerald-600 text-white border-emerald-700 shadow-md',
    cyan: 'bg-cyan-600 text-white border-cyan-700 shadow-md',
    blue: 'bg-blue-600 text-white border-blue-700 shadow-md',
    indigo: 'bg-indigo-600 text-white border-indigo-700 shadow-md',
    rose: 'bg-rose-600 text-white border-rose-700 shadow-md',
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
    </button>
  );
}

// ── Cascade detalhada por modalidade ──
const BANDEIRAS_CREDITO = ['MASTERCARD', 'VISANET', 'CIELO', 'ELO', 'AMEX', 'HIPERCARD', 'CREDITO_GENERICO'] as const;
const BANDEIRAS_DEBITO = ['VISA_ELECTRON', 'REDE_SHOP', 'DEBITO_GENERICO'] as const;

function CascadeModalidade({
  detalhado, modalidade, isAdmin, onEditBandeira,
}: {
  detalhado: Detalhado;
  modalidade: string;
  isAdmin?: boolean;
  onEditBandeira?: (paymentId: string, currentBandeira: string, valor: number, saleHint: string) => void;
}) {
  const isCartao = modalidade === 'credito' || modalidade === 'debito';
  const [bandeiraOpen, setBandeiraOpen] = useState<string | null>(null);

  if (modalidade === 'dinheiro') {
    return <ListaVendas vendas={detalhado.totais.DINHEIRO.vendas} />;
  }
  if (modalidade === 'pix') {
    return <ListaVendas vendas={detalhado.totais.PIX.vendas} />;
  }
  if (modalidade === 'crediario') {
    return <ListaVendas vendas={detalhado.totais.CREDIARIO.vendas} />;
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
                isAdmin={!!isAdmin && isCartao}
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
  vendas, bandeiraAtual, isAdmin, onEditBandeira,
}: {
  vendas: Slot['vendas'];
  bandeiraAtual?: string;
  isAdmin?: boolean;
  onEditBandeira?: (paymentId: string, currentBandeira: string, valor: number, saleHint: string) => void;
}) {
  if (!vendas || vendas.length === 0) {
    return <div className="text-[11px] text-slate-400 italic text-center py-2">Sem vendas</div>;
  }
  return (
    <div className="space-y-0.5 max-h-60 overflow-y-auto">
      {vendas.map((v, i) => {
        const hora = v.finalizedAt ? new Date(v.finalizedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
        const cliente = v.customerName || (v.customerCpf ? `CPF ${v.customerCpf}` : 'Sem identificacao');
        return (
          <div key={i} className="flex items-center justify-between text-[11px] py-0.5 px-1 hover:bg-slate-50 rounded">
            <div className="flex items-center gap-2 min-w-0">
              {hora && <span className="text-slate-400 font-mono shrink-0">{hora}</span>}
              <span className={`truncate ${v.customerName ? 'text-slate-800 font-medium' : 'text-slate-400 italic'}`}>{cliente}</span>
              {v.sellerName && <span className="text-slate-500 text-[10px] shrink-0">- {v.sellerName.split(' ')[0]}</span>}
              {v.parcelas && v.parcelas > 1 && <span className="text-violet-600 text-[10px] shrink-0">- {v.parcelas}x</span>}
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-2">
              <span className="font-mono font-bold tabular-nums">{brl(v.valor)}</span>
              {isAdmin && onEditBandeira && bandeiraAtual && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const hint = `${cliente} - ${brl(v.valor)}`;
                    onEditBandeira(v.paymentId, bandeiraAtual, v.valor, hint);
                  }}
                  title="Trocar bandeira (admin)"
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
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
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
