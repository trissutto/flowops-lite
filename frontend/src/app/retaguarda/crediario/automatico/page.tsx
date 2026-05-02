'use client';

/**
 * /retaguarda/crediario/automatico — Disparador automático de cobrança WA.
 *
 * CRUD de campanhas que rodam server-side via cron (a cada 5min).
 *   - Cria campanha com janela de horário, frequência, regras
 *   - Pausa/reativa
 *   - Edita
 *   - Deleta
 *   - "Rodar agora" pra QA
 *   - Ver histórico de tentativas
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CreditCard, Loader2, Play, Pause, Plus, Trash2, Edit2, RefreshCw,
  Clock, Calendar, Zap, Activity, Check, X, AlertTriangle, History, ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';

interface Campanha {
  id: string;
  nome: string;
  lojaCode: string;
  ativa: boolean;
  horaInicio: string;
  horaFim: string;
  frequencia: string;
  minDiasAtraso: number;
  maxDiasAtraso: number | null;
  delayMs: number;
  ultimoEnvio: string | null;
  proximoEnvio: string | null;
  totalEnviadas: number;
  createdAt: string;
}

interface Tentativa {
  id: string;
  codCliente: string;
  nome: string;
  telefone: string;
  telefoneOriginal: string | null;
  templateIndex: number;
  mensagem: string;
  status: string; // ok | falha | skipped
  erro: string | null;
  enviadaEm: string;
}

interface ListResp {
  campanhas: Campanha[];
  stats: Record<string, { ok: number; falha: number; ultima: string | null }>;
}

interface DetailResp {
  campanha: Campanha;
  tentativas: Tentativa[];
}

const FREQUENCIAS = [
  { value: '1x_dia', label: '1x por dia' },
  { value: '2x_dia', label: '2x por dia' },
  { value: 'cada_2_dias', label: 'A cada 2 dias' },
  { value: 'cada_3_dias', label: 'A cada 3 dias' },
  { value: 'semanal', label: '1x por semana' },
];

function freqLabel(v: string) {
  return FREQUENCIAS.find((f) => f.value === v)?.label || v;
}

export default function CrediarioAutomaticoPage() {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) { router.push('/login'); return; }
    api<{ role: string }>('/auth/me')
      .then((me) => {
        if (me.role !== 'admin' && me.role !== 'operator') {
          router.push('/');
          return;
        }
        setAuthed(true);
      })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [data, setData] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Campanha | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<DetailResp | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  // IDs de campanhas executando AGORA em background no servidor (poll a cada 10s)
  const [runningServerIds, setRunningServerIds] = useState<Set<string>>(new Set());

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api<ListResp>('/crediarios/campanhas');
      setData(r);
    } catch (e: any) {
      setErr(e.message || 'falha ao listar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (authed) load(); /* eslint-disable-next-line */ }, [authed]);

  // Poll status de execução em BG a cada 10s (mostra badge "EXECUTANDO" no card
  // enquanto o loop server-side está mandando mensagens com delay anti-ban).
  // Também recarrega o `data` se houver mudança no totalEnviadas em tempo real.
  useEffect(() => {
    if (!authed) return;
    let stop = false;
    async function tick() {
      try {
        const r = await api<{ ids: string[] }>('/crediarios/campanhas-running');
        if (stop) return;
        const newSet = new Set(r.ids);
        setRunningServerIds((prev) => {
          // Se alguma campanha PAROU desde o último check, recarrega `data`
          // pra trazer totalEnviadas atualizado e proximoEnvio.
          for (const id of prev) {
            if (!newSet.has(id)) {
              load();
              break;
            }
          }
          return newSet;
        });
        // Se TEM campanha rodando, recarrega data periodicamente (totalEnviadas
        // incrementa a cada envio OK em tempo real)
        if (r.ids.length > 0) load();
      } catch { /* ignora */ }
    }
    tick();
    const id = setInterval(tick, 10_000);
    return () => { stop = true; clearInterval(id); };
    // eslint-disable-next-line
  }, [authed]);

  async function toggleAtiva(c: Campanha) {
    try {
      await api(`/crediarios/campanhas/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ativa: !c.ativa }),
      });
      load();
    } catch (e: any) {
      alert('Erro: ' + (e.message || 'falha'));
    }
  }

  async function delCampanha(c: Campanha) {
    if (!confirm(`Apagar "${c.nome}"? O histórico de tentativas também será apagado.`)) return;
    try {
      await api(`/crediarios/campanhas/${c.id}`, { method: 'DELETE' });
      load();
    } catch (e: any) {
      alert('Erro: ' + (e.message || 'falha'));
    }
  }

  async function runNow(c: Campanha) {
    const delayMin = (c.delayMs / 60000).toFixed(0);
    if (!confirm(
      `Rodar "${c.nome}" AGORA?\n\n` +
      `🟢 Backend dispara em background — botão libera imediatamente\n` +
      `⏱️ Espaçamento entre mensagens: ${delayMin} minuto(s) (anti-ban WhatsApp)\n` +
      `📊 Pra muitos clientes pode demorar HORAS — acompanhe pelo Histórico\n\n` +
      `WhatsApp precisa estar conectado. Confirma?`,
    )) return;
    setRunning(c.id);
    try {
      const r = await api<{
        started: boolean;
        already_running?: boolean;
        message: string;
      }>(`/crediarios/campanhas/${c.id}/run-now`, {
        method: 'POST',
      });
      if (r.already_running) {
        alert(`⚠️ ${r.message}`);
      } else {
        alert(`✅ ${r.message}\n\nClique em "Histórico" pra acompanhar os envios em tempo real.`);
      }
      load();
    } catch (e: any) {
      alert('Erro ao disparar: ' + (e.message || 'falha'));
    } finally {
      setRunning(null);
    }
  }

  async function openDetail(c: Campanha) {
    try {
      const r = await api<DetailResp>(`/crediarios/campanhas/${c.id}`);
      setDetail(r);
    } catch (e: any) {
      alert('Erro: ' + (e.message || 'falha'));
    }
  }

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Carregando…
      </div>
    );
  }

  return (
    <PastelShell
      title="Cobrança Automática"
      subtitle="Disparadores recorrentes — rodam server-side"
      icon={Zap}
      tone="rose"
      backHref="/retaguarda/crediario"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-slate-600">
          {data ? `${data.campanhas.length} campanha(s) cadastrada(s) — ${data.campanhas.filter((c) => c.ativa).length} ativa(s)` : '...'}
        </div>
        <div className="flex gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1.5 text-sm rounded-lg border border-rose-200 bg-white hover:bg-rose-50 disabled:opacity-40 flex items-center gap-1.5"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Atualizar
          </button>
          <button
            onClick={() => setCreating(true)}
            className="px-3 py-1.5 text-sm rounded-lg text-white shadow-sm flex items-center gap-1.5"
            style={{ background: '#5d7048' }}
          >
            <Plus className="w-4 h-4" /> Nova campanha
          </button>
        </div>
      </div>

      {err && (
        <div className="panel-pastel p-3 border-l-4 border-rose-400 mb-3 flex items-start gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
          <span className="text-rose-700">{err}</span>
        </div>
      )}

      {loading && !data && (
        <div className="panel-pastel p-8 text-center text-slate-400 text-sm">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Carregando campanhas…
        </div>
      )}

      {data && data.campanhas.length === 0 && !loading && (
        <div className="panel-pastel p-8 text-center text-slate-500 text-sm">
          <Zap className="w-10 h-10 text-rose-300 mx-auto mb-2" />
          Nenhuma campanha automática cadastrada ainda.
          <br />
          Clique em <b>Nova campanha</b> pra começar.
        </div>
      )}

      {data && data.campanhas.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {data.campanhas.map((c) => {
            const stat = data.stats[c.id] || { ok: 0, falha: 0, ultima: null };
            return (
              <div
                key={c.id}
                className={`panel-pastel p-4 border-l-4 ${c.ativa ? 'border-emerald-500' : 'border-slate-300 opacity-70'}`}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-base truncate" style={{ color: '#6e3a40' }}>{c.nome}</h3>
                      {c.ativa ? (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-800 font-bold">ATIVA</span>
                      ) : (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-200 text-slate-600 font-bold">PAUSADA</span>
                      )}
                      {runningServerIds.has(c.id) && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800 font-bold flex items-center gap-1 animate-pulse">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          EXECUTANDO
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 flex items-center flex-wrap gap-x-3 gap-y-0.5">
                      <span>Loja {c.lojaCode}</span>
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{c.horaInicio} — {c.horaFim}</span>
                      <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{freqLabel(c.frequencia)}</span>
                      <span>≥ {c.minDiasAtraso}d{c.maxDiasAtraso ? ` — ≤ ${c.maxDiasAtraso}d` : ''}</span>
                    </div>
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-2 mt-3 mb-3">
                  <div className="rounded-lg bg-emerald-50 p-2 border border-emerald-100 text-center">
                    <div className="text-[10px] uppercase tracking-wider text-emerald-800">Enviadas</div>
                    <div className="text-lg font-semibold text-emerald-900 tabular-nums">{c.totalEnviadas}</div>
                  </div>
                  <div className="rounded-lg bg-rose-50 p-2 border border-rose-100 text-center">
                    <div className="text-[10px] uppercase tracking-wider text-rose-800">Falhas</div>
                    <div className="text-lg font-semibold text-rose-900 tabular-nums">{stat.falha}</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-2 border border-slate-200 text-center">
                    <div className="text-[10px] uppercase tracking-wider text-slate-700">Próximo</div>
                    <div className="text-[11px] font-mono text-slate-700">{fmtDateTime(c.proximoEnvio) || '—'}</div>
                  </div>
                </div>

                {/* Ações */}
                <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-rose-100">
                  <button
                    onClick={() => toggleAtiva(c)}
                    className={`px-2.5 py-1 text-xs rounded-lg flex items-center gap-1 font-semibold ${
                      c.ativa
                        ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                        : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                    }`}
                  >
                    {c.ativa ? <><Pause className="w-3 h-3" />Pausar</> : <><Play className="w-3 h-3" />Ativar</>}
                  </button>
                  <button
                    onClick={() => runNow(c)}
                    disabled={running === c.id}
                    className="px-2.5 py-1 text-xs rounded-lg flex items-center gap-1 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {running === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                    Rodar agora
                  </button>
                  <button
                    onClick={() => openDetail(c)}
                    className="px-2.5 py-1 text-xs rounded-lg bg-white border border-rose-200 text-rose-700 hover:bg-rose-50 flex items-center gap-1"
                  >
                    <History className="w-3 h-3" /> Histórico
                  </button>
                  <button
                    onClick={() => setEditing(c)}
                    className="px-2.5 py-1 text-xs rounded-lg bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-1"
                  >
                    <Edit2 className="w-3 h-3" /> Editar
                  </button>
                  <button
                    onClick={() => delCampanha(c)}
                    className="px-2 py-1 text-xs rounded-lg bg-white border border-rose-300 text-rose-600 hover:bg-rose-50 ml-auto"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(creating || editing) && (
        <CampanhaForm
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); load(); }}
        />
      )}

      {detail && (
        <DetailModal data={detail} onClose={() => setDetail(null)} />
      )}
    </PastelShell>
  );
}

// ============================================================
// Form (criar/editar)
// ============================================================
function CampanhaForm({
  initial, onClose, onSaved,
}: {
  initial: Campanha | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nome, setNome] = useState(initial?.nome || '');
  const [lojaCode, setLojaCode] = useState(initial?.lojaCode || '01');
  const [horaInicio, setHoraInicio] = useState(initial?.horaInicio || '09:00');
  const [horaFim, setHoraFim] = useState(initial?.horaFim || '18:00');
  const [frequencia, setFrequencia] = useState(initial?.frequencia || '1x_dia');
  const [minDiasAtraso, setMinDiasAtraso] = useState(initial?.minDiasAtraso ?? 3);
  const [maxDiasAtraso, setMaxDiasAtraso] = useState<number | ''>(initial?.maxDiasAtraso ?? '');
  const [delayMin, setDelayMin] = useState(Math.round((initial?.delayMs || 120000) / 60000));
  const [ativa, setAtiva] = useState(initial?.ativa ?? true);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!nome.trim()) { alert('Dê um nome pra campanha'); return; }
    setSaving(true);
    try {
      const body: any = {
        nome: nome.trim(),
        lojaCode: lojaCode.padStart(2, '0'),
        horaInicio,
        horaFim,
        frequencia,
        minDiasAtraso: Number(minDiasAtraso) || 0,
        maxDiasAtraso: maxDiasAtraso === '' ? null : Number(maxDiasAtraso),
        delayMs: Math.max(60_000, Math.min(600_000, Number(delayMin) * 60_000)),
        ativa,
      };
      if (initial) {
        await api(`/crediarios/campanhas/${initial.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await api('/crediarios/campanhas', { method: 'POST', body: JSON.stringify(body) });
      }
      onSaved();
    } catch (e: any) {
      alert('Erro: ' + (e.message || 'falha'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2" style={{ color: '#6e3a40' }}>
            <Zap className="w-5 h-5" style={{ color: '#5d7048' }} />
            {initial ? 'Editar campanha' : 'Nova campanha automática'}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800 text-2xl">×</button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Nome da campanha</label>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Ex: Cobrança Loja 01 — vencidos +3 dias"
              className="w-full px-3 py-2 text-sm rounded-lg border border-rose-200 bg-white focus:outline-none focus:border-rose-400"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Loja</label>
              <input
                value={lojaCode}
                onChange={(e) => setLojaCode(e.target.value.replace(/\D/g, '').slice(0, 2))}
                className="w-full px-3 py-2 text-sm rounded-lg border border-rose-200 bg-white"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Início</label>
              <input
                type="time"
                value={horaInicio}
                onChange={(e) => setHoraInicio(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-rose-200 bg-white"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Fim</label>
              <input
                type="time"
                value={horaFim}
                onChange={(e) => setHoraFim(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-rose-200 bg-white"
              />
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Frequência</label>
            <select
              value={frequencia}
              onChange={(e) => setFrequencia(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-rose-200 bg-white"
            >
              {FREQUENCIAS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            <div className="text-[11px] text-slate-500 mt-1">
              Quanto tempo o sistema espera antes de mandar uma NOVA mensagem pro mesmo cliente.
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Atraso mínimo (dias)</label>
              <input
                type="number"
                value={minDiasAtraso}
                onChange={(e) => setMinDiasAtraso(Number(e.target.value))}
                min={0}
                max={365}
                className="w-full px-3 py-2 text-sm rounded-lg border border-rose-200 bg-white"
              />
              <div className="text-[11px] text-slate-500 mt-1">Só cobra clientes com atraso ≥ esse valor.</div>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Atraso máximo (opcional)</label>
              <input
                type="number"
                value={maxDiasAtraso}
                onChange={(e) => setMaxDiasAtraso(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="sem limite"
                min={0}
                max={3650}
                className="w-full px-3 py-2 text-sm rounded-lg border border-rose-200 bg-white"
              />
              <div className="text-[11px] text-slate-500 mt-1">Vazio = cobra até pagar.</div>
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-widest font-semibold block mb-1" style={{ color: '#6e3a40' }}>Espaçamento entre mensagens</label>
            <select
              value={delayMin}
              onChange={(e) => setDelayMin(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm rounded-lg border border-rose-200 bg-white"
            >
              <option value={1}>1 min (rápido — mais risco de ban)</option>
              <option value={2}>2 min (recomendado)</option>
              <option value={3}>3 min</option>
              <option value={5}>5 min (seguro)</option>
              <option value={10}>10 min (ultra seguro)</option>
            </select>
          </div>

          <label className="flex items-center gap-2 pt-2 cursor-pointer">
            <input
              type="checkbox"
              checked={ativa}
              onChange={(e) => setAtiva(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm font-medium" style={{ color: '#6e3a40' }}>
              Campanha ativa (vai começar a rodar nos próximos 5 min)
            </span>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-rose-100">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg text-white shadow-sm flex items-center gap-1.5 disabled:opacity-50"
            style={{ background: '#8b4f55' }}
          >
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando…</> : <><Check className="w-4 h-4" /> Salvar</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Detail modal — histórico de tentativas
// ============================================================
function DetailModal({ data, onClose }: { data: DetailResp; onClose: () => void }) {
  const stats = useMemo(() => {
    const ok = data.tentativas.filter((t) => t.status === 'ok').length;
    const falha = data.tentativas.filter((t) => t.status === 'falha').length;
    return { ok, falha, total: data.tentativas.length };
  }, [data.tentativas]);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-5xl w-full max-h-[90vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2" style={{ color: '#6e3a40' }}>
              <History className="w-5 h-5" />
              Histórico — {data.campanha.nome}
            </h2>
            <div className="text-xs text-slate-500 mt-1">
              últimas {data.tentativas.length} tentativas · {stats.ok} ok · {stats.falha} falhas
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800 text-2xl">×</button>
        </div>

        {data.tentativas.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500 bg-slate-50 rounded">
            Ainda sem tentativas registradas.
          </div>
        ) : (
          <div className="overflow-x-auto border border-rose-100 rounded-lg">
            <table className="text-xs w-full">
              <thead className="bg-rose-50 sticky top-0">
                <tr className="text-left">
                  <th className="px-2 py-1.5">Quando</th>
                  <th className="px-2 py-1.5">Cliente</th>
                  <th className="px-2 py-1.5">Telefone</th>
                  <th className="px-2 py-1.5 text-center">Tpl</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Erro</th>
                </tr>
              </thead>
              <tbody>
                {data.tentativas.map((t) => (
                  <tr key={t.id} className="border-t border-rose-50 hover:bg-rose-50/30">
                    <td className="px-2 py-1.5 font-mono text-[11px]">{fmtDateTime(t.enviadaEm)}</td>
                    <td className="px-2 py-1.5">
                      <div className="font-semibold text-slate-800">{t.nome}</div>
                      <div className="text-[10px] text-slate-500">cod {t.codCliente}</div>
                    </td>
                    <td className="px-2 py-1.5 font-mono">{t.telefone}</td>
                    <td className="px-2 py-1.5 text-center">
                      <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-mono">
                        T{t.templateIndex + 1}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      {t.status === 'ok' && <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">OK</span>}
                      {t.status === 'falha' && <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 text-[10px] font-bold">FALHA</span>}
                      {t.status === 'skipped' && <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-bold">SKIP</span>}
                    </td>
                    <td className="px-2 py-1.5 text-rose-700 text-[10px] font-mono">{t.erro || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================
function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}
