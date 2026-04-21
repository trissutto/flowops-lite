'use client';

/**
 * /marketing/recuperacao
 *
 * Dashboard de recuperação de carrinho via WhatsApp (modo manual).
 *
 * Fluxo:
 *  1. Lista candidatos elegíveis (backend pula já enviados e opt-outs).
 *  2. Operadora clica "Enviar WhatsApp" → abre WA Web com mensagem pronta.
 *  3. Clica "Marcar como enviado" → backend registra WaMessage.
 *  4. Cron/trigger detecta conversão cruzando com Orders novos.
 *
 * Quando o Meta Cloud API estiver configurado, troca o botão manual por
 * disparo automático — tela continua servindo de monitoramento.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3, Check, Clock, Copy, Edit3, ExternalLink, MessageCircle,
  Package, RefreshCw, Search, Send, ShieldOff, Sparkles, Users, X,
} from 'lucide-react';
import { api } from '@/lib/api';

interface StepConfig {
  index: number;
  key: string;
  label: string;
  delayMinutes: number;
  couponPct: number;
  template: string;
}

interface Candidate {
  sourceType: 'cart' | 'wc-pending';
  sourceId: string;
  name: string | null;
  email: string | null;
  phone: string;
  phoneFormatted: string;
  productSummary: string;
  amount: number | null;
  itemCount: number;
  abandonedAt: string;
  ageMinutes: number;
  nextStepIndex: 0 | 1 | 2 | null;
  alreadySentSteps: number[];
  optedOut: boolean;
  converted: boolean;
  lastMessageAt: string | null;
}

interface Stats {
  windowDays: number;
  sent: number;
  delivered: number;
  read: number;
  convertedCount: number;
  conversionRate: number;
  recoveredRevenue: number;
  pendingRevenue: number;
  byStage: Array<{ stepIndex: number; stepKey: string; sent: number; converted: number }>;
}

interface OptOut {
  id: string;
  phone: string;
  reason: string | null;
  createdAt: string;
}

type FilterMode = 'all' | 'T1' | 'T2' | 'T3' | 'pending' | 'sent';

export default function RecuperacaoPage() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [steps, setSteps] = useState<StepConfig[]>([]);
  const [optOuts, setOptOuts] = useState<OptOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('pending');
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<{ cand: Candidate; step: number } | null>(null);
  const [optOutPanelOpen, setOptOutPanelOpen] = useState(false);
  const [siteUrl, setSiteUrl] = useState<string>('');

  // URL do site pra link de retorno — tenta pegar do localStorage ou usa default
  useEffect(() => {
    const cached = typeof window !== 'undefined' ? localStorage.getItem('flowops_site_url') : null;
    setSiteUrl(cached || 'https://www.lurds.com.br');
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, s, cfg, o] = await Promise.all([
        api<Candidate[]>(`/marketing/recovery/candidates?step=${filter}&limit=300`),
        api<Stats>(`/marketing/recovery/stats?window=30`),
        api<{ steps: StepConfig[] }>(`/marketing/recovery/config`),
        api<OptOut[]>(`/marketing/recovery/opt-outs`).catch(() => []),
      ]);
      setCandidates(c);
      setStats(s);
      setSteps(cfg.steps);
      setOptOuts(o);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const filtered = useMemo(() => {
    if (!search.trim()) return candidates;
    const q = search.trim().toLowerCase();
    return candidates.filter(
      (c) =>
        c.name?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone.includes(q.replace(/\D/g, '')) ||
        c.productSummary.toLowerCase().includes(q),
    );
  }, [candidates, search]);

  // ── Render preview ────────────────────────────────────────────────
  function renderMessage(cand: Candidate, stepIndex: number): string {
    const step = steps[stepIndex];
    if (!step) return '';
    const firstName = (cand.name ?? '').split(' ')[0]?.trim() || 'tudo bem';
    const coupon =
      step.couponPct > 0
        ? `VOLTA${step.couponPct}`
        : '';
    const link = siteUrl + (cand.sourceType === 'wc-pending' ? `/my-account/orders/` : '/checkout/');
    return step.template
      .replace(/\{nome\}/g, firstName)
      .replace(/\{produto\}/g, cand.productSummary)
      .replace(/\{valor\}/g, cand.amount != null ? `R$ ${cand.amount.toFixed(2).replace('.', ',')}` : '')
      .replace(/\{cupom\}/g, coupon || 'VOLTA10')
      .replace(/\{link\}/g, link);
  }

  function whatsappWebLink(phone: string, text: string): string {
    const digits = phone.replace(/\D/g, '');
    return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
  }

  async function openAndRegister(cand: Candidate, stepIndex: number) {
    const body = renderMessage(cand, stepIndex);
    const url = whatsappWebLink(cand.phone, body);
    // Abre WhatsApp Web em nova aba fixa (reusa janela)
    window.open(url, 'whatsapp-send', 'noopener');
    // Confirma registro
    const ok = confirm(
      `Após enviar pela janela do WhatsApp, confirmo o registro?\n\nSe você não enviou, clica Cancelar.`,
    );
    if (!ok) return;
    try {
      const step = steps[stepIndex];
      await api('/marketing/recovery/register-sent', {
        method: 'POST',
        body: JSON.stringify({
          sourceType: cand.sourceType,
          sourceId: cand.sourceId,
          stepIndex,
          customerPhone: cand.phone,
          customerName: cand.name,
          customerEmail: cand.email,
          bodyRendered: body,
          amount: cand.amount,
          couponCode: step.couponPct > 0 ? `VOLTA${step.couponPct}` : null,
          couponPct: step.couponPct > 0 ? step.couponPct : null,
        }),
      });
      await loadAll();
    } catch (e: any) {
      alert(e?.message || 'Erro ao registrar envio');
    }
  }

  async function addOptOut(phone: string, name?: string | null) {
    if (!confirm(`Confirmar opt-out pra ${name ?? phone}? Essa cliente não receberá mais mensagens.`)) return;
    try {
      await api('/marketing/recovery/opt-outs', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      });
      await loadAll();
    } catch (e: any) {
      alert(e?.message || 'Erro ao adicionar opt-out');
    }
  }

  async function removeOptOut(phone: string) {
    if (!confirm(`Remover ${phone} do opt-out? Ela voltará a ser elegível pra mensagens.`)) return;
    try {
      await api(`/marketing/recovery/opt-outs/${encodeURIComponent(phone)}`, { method: 'DELETE' });
      await loadAll();
    } catch (e: any) {
      alert(e?.message || 'Erro ao remover opt-out');
    }
  }

  async function runConversionScan() {
    try {
      const r = await api<{ scanned: number; matched: number }>('/marketing/recovery/scan-conversions', {
        method: 'POST',
      });
      alert(`Scan: ${r.scanned} mensagens verificadas, ${r.matched} convertidas.`);
      await loadAll();
    } catch (e: any) {
      alert(e?.message || 'Erro ao rodar scan');
    }
  }

  return (
    <div className="max-w-7xl mx-auto p-6 pb-24">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Sparkles className="text-pink-600" size={30} /> Recuperação de carrinho
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            WhatsApp segmentado por estágio (1h · 24h · 72h) — modo manual enquanto templates oficiais aprovam na Meta.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setOptOutPanelOpen(true)}
            className="text-sm px-3 py-2 rounded border border-gray-300 hover:bg-gray-50 flex items-center gap-1"
          >
            <ShieldOff size={14} /> Opt-outs ({optOuts.length})
          </button>
          <button
            onClick={runConversionScan}
            className="text-sm px-3 py-2 rounded border border-gray-300 hover:bg-gray-50 flex items-center gap-1"
            title="Cruza mensagens enviadas com pedidos novos pra detectar conversões"
          >
            <RefreshCw size={14} /> Scan conversões
          </button>
          <button
            onClick={loadAll}
            className="text-sm px-3 py-2 rounded border border-gray-300 hover:bg-gray-50"
          >
            Atualizar
          </button>
        </div>
      </div>

      {/* Banner modo manual */}
      <div className="bg-blue-50 border-l-4 border-blue-400 p-3 rounded mb-4 text-sm text-blue-900">
        <strong>Modo manual ativo.</strong> O sistema monta a mensagem pronta, você clica "Enviar WhatsApp" e marca como enviado.
        Quando a Meta aprovar os templates oficiais, ligamos o disparo automático.
      </div>

      {/* KPIs */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <Kpi label="Enviadas (30d)" value={stats.sent} icon={<Send size={16} />} />
          <Kpi
            label="Recuperadas"
            value={stats.convertedCount}
            sub={`${stats.conversionRate}%`}
            icon={<Check size={16} />}
            tone="green"
          />
          <Kpi
            label="R$ recuperado"
            value={`R$ ${stats.recoveredRevenue.toFixed(2).replace('.', ',')}`}
            icon={<Sparkles size={16} />}
            tone="green"
          />
          <Kpi
            label="R$ pendente"
            value={`R$ ${stats.pendingRevenue.toFixed(2).replace('.', ',')}`}
            icon={<Package size={16} />}
            tone="amber"
          />
          <Kpi
            label="Carrinhos na fila"
            value={filtered.length}
            icon={<Users size={16} />}
            tone="brand"
          />
        </div>
      )}

      {/* Por estágio */}
      {stats && (
        <div className="grid grid-cols-3 gap-3 mb-6">
          {stats.byStage.map((s) => (
            <div key={s.stepIndex} className="bg-white rounded-lg shadow p-4">
              <div className="text-xs uppercase text-gray-500">
                {steps[s.stepIndex]?.label || `T${s.stepIndex + 1}`}
              </div>
              <div className="flex items-end gap-2 mt-1">
                <div className="text-2xl font-bold">{s.sent}</div>
                <div className="text-xs text-gray-500 pb-1">enviados</div>
                <div className="text-2xl font-bold text-green-700 ml-auto">{s.converted}</div>
                <div className="text-xs text-green-700 pb-1">converteu</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filtros */}
      <div className="bg-white rounded-lg shadow p-3 mb-3 flex flex-wrap gap-2 items-center">
        {([
          ['pending', 'Aguardando envio'],
          ['T1', 'T1 — 1h'],
          ['T2', 'T2 — 24h'],
          ['T3', 'T3 — 72h'],
          ['sent', 'Já enviados'],
          ['all', 'Todos'],
        ] as Array<[FilterMode, string]>).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 text-sm rounded-full border ${
              filter === key
                ? 'bg-brand text-white border-brand'
                : 'border-gray-300 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
        <div className="flex-1 min-w-[200px] relative">
          <Search size={16} className="absolute left-2 top-2.5 text-gray-400" />
          <input
            type="text"
            placeholder="Nome, email, telefone ou produto..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-2 text-sm border border-gray-300 rounded w-full"
          />
        </div>
      </div>

      {loading && <div className="text-gray-500">Carregando…</div>}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      {/* Lista */}
      <div className="space-y-2">
        {filtered.map((c) => (
          <CandidateCard
            key={`${c.sourceType}:${c.sourceId}`}
            cand={c}
            steps={steps}
            onSend={(stepIndex) => openAndRegister(c, stepIndex)}
            onPreview={(stepIndex) => setPreview({ cand: c, step: stepIndex })}
            onOptOut={() => addOptOut(c.phone, c.name)}
          />
        ))}
        {!loading && filtered.length === 0 && (
          <div className="bg-white rounded-lg shadow p-10 text-center text-gray-500">
            <Sparkles className="mx-auto text-pink-400 mb-2" size={36} />
            Nenhum candidato nesse filtro. Tente outro.
          </div>
        )}
      </div>

      {/* Modal preview */}
      {preview && (
        <PreviewModal
          cand={preview.cand}
          stepIndex={preview.step}
          body={renderMessage(preview.cand, preview.step)}
          waUrl={whatsappWebLink(preview.cand.phone, renderMessage(preview.cand, preview.step))}
          onClose={() => setPreview(null)}
          onSendAndRegister={() => {
            const c = preview.cand;
            const s = preview.step;
            setPreview(null);
            openAndRegister(c, s);
          }}
        />
      )}

      {/* Panel opt-outs */}
      {optOutPanelOpen && (
        <OptOutsPanel
          list={optOuts}
          onClose={() => setOptOutPanelOpen(false)}
          onRemove={removeOptOut}
        />
      )}
    </div>
  );
}

// ============================================================
// Sub-componentes
// ============================================================

function Kpi({
  label, value, sub, icon, tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon?: React.ReactNode;
  tone?: 'green' | 'amber' | 'brand';
}) {
  const toneClass =
    tone === 'green' ? 'text-green-700' :
    tone === 'amber' ? 'text-amber-700' :
    tone === 'brand' ? 'text-pink-700' : 'text-gray-900';
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="text-xs uppercase text-gray-500 flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className={`text-2xl font-bold mt-1 ${toneClass}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function CandidateCard({
  cand, steps, onSend, onPreview, onOptOut,
}: {
  cand: Candidate;
  steps: StepConfig[];
  onSend: (step: number) => void;
  onPreview: (step: number) => void;
  onOptOut: () => void;
}) {
  const { nextStepIndex, alreadySentSteps } = cand;
  const urgent = cand.ageMinutes >= 24 * 60;

  return (
    <div
      className={`bg-white rounded-lg shadow border-l-4 p-4 ${
        cand.converted ? 'border-green-500 bg-green-50/50' :
        cand.optedOut ? 'border-gray-300 opacity-60' :
        urgent ? 'border-red-500' : 'border-pink-500'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <div className="font-semibold text-gray-900">
              {cand.name || '(sem nome)'}
            </div>
            <div className="text-xs text-gray-500">{cand.phoneFormatted}</div>
            {cand.email && (
              <div className="text-xs text-gray-500 hidden md:block">{cand.email}</div>
            )}
            <div className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700 flex items-center gap-1">
              <Clock size={10} /> {formatAge(cand.ageMinutes)}
            </div>
            {cand.converted && (
              <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full font-bold">
                ✓ Converteu
              </span>
            )}
            {cand.optedOut && (
              <span className="text-xs bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full">
                Opt-out
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-700">
            <Package size={14} className="text-gray-500" />
            <span className="truncate">{cand.productSummary}</span>
            {cand.amount != null && (
              <span className="font-semibold text-gray-900 ml-2">
                R$ {cand.amount.toFixed(2).replace('.', ',')}
              </span>
            )}
          </div>

          {/* Estado por estágio */}
          <div className="flex gap-1 mt-2">
            {[0, 1, 2].map((si) => {
              const already = alreadySentSteps.includes(si);
              const current = nextStepIndex === si;
              const stepKey = steps[si]?.key ?? `T${si + 1}`;
              return (
                <span
                  key={si}
                  className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${
                    already
                      ? 'bg-green-100 text-green-700'
                      : current
                      ? 'bg-pink-200 text-pink-900 ring-2 ring-pink-400'
                      : 'bg-gray-100 text-gray-400'
                  }`}
                  title={steps[si]?.label}
                >
                  {already ? '✓ ' : ''}
                  {stepKey}
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!cand.optedOut && nextStepIndex != null && !cand.converted && (
            <>
              <button
                onClick={() => onPreview(nextStepIndex)}
                className="p-2 rounded border border-gray-300 hover:bg-gray-50"
                title="Ver mensagem antes de enviar"
              >
                <Edit3 size={16} />
              </button>
              <button
                onClick={() => onSend(nextStepIndex)}
                className="px-4 py-2 text-sm font-bold rounded bg-green-600 text-white hover:bg-green-700 flex items-center gap-2"
              >
                <MessageCircle size={14} />
                Enviar {steps[nextStepIndex]?.key || 'T'}
              </button>
            </>
          )}
          {!cand.optedOut && nextStepIndex == null && !cand.converted && (
            <span className="text-xs text-gray-500 italic">Aguardando próximo estágio…</span>
          )}
          {!cand.optedOut && !cand.converted && (
            <button
              onClick={onOptOut}
              className="p-2 text-gray-400 hover:text-red-600"
              title="Opt-out — não mandar mais"
            >
              <ShieldOff size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewModal({
  cand, stepIndex, body, waUrl, onClose, onSendAndRegister,
}: {
  cand: Candidate;
  stepIndex: number;
  body: string;
  waUrl: string;
  onClose: () => void;
  onSendAndRegister: () => void;
}) {
  function copyToClipboard() {
    navigator.clipboard?.writeText(body).then(
      () => alert('Mensagem copiada!'),
      () => alert('Copiar não funcionou — selecione e copie manualmente.'),
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-xl sm:rounded-xl w-full max-w-xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-gray-500">
              T{stepIndex + 1} — {cand.name || cand.phoneFormatted}
            </div>
            <div className="text-lg font-bold">Pré-visualização</div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X size={20} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="text-sm text-gray-700 bg-emerald-50 border border-emerald-200 rounded p-3 whitespace-pre-wrap">
            {body}
          </div>
          <div className="flex gap-2">
            <button
              onClick={copyToClipboard}
              className="flex-1 px-3 py-2 text-sm rounded border border-gray-300 hover:bg-gray-50 flex items-center justify-center gap-1"
            >
              <Copy size={14} /> Copiar texto
            </button>
            <a
              href={waUrl}
              target="whatsapp-send"
              className="flex-1 px-3 py-2 text-sm rounded border border-gray-300 hover:bg-gray-50 flex items-center justify-center gap-1"
            >
              <ExternalLink size={14} /> Abrir WA
            </a>
          </div>
        </div>
        <div className="sticky bottom-0 bg-white border-t p-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded border border-gray-300 hover:bg-gray-50"
          >
            Fechar
          </button>
          <button
            onClick={onSendAndRegister}
            className="px-4 py-2 text-sm font-bold rounded bg-green-600 text-white hover:bg-green-700 flex items-center gap-2"
          >
            <MessageCircle size={14} /> Enviar WhatsApp &amp; marcar
          </button>
        </div>
      </div>
    </div>
  );
}

function OptOutsPanel({
  list, onClose, onRemove,
}: {
  list: OptOut[];
  onClose: () => void;
  onRemove: (phone: string) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-xl sm:rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between">
          <div>
            <div className="text-lg font-bold flex items-center gap-2">
              <ShieldOff size={18} /> Opt-outs ({list.length})
            </div>
            <div className="text-xs text-gray-500">
              Clientes que pediram pra não receber mensagens.
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X size={20} />
          </button>
        </div>
        <div className="p-4 space-y-2">
          {list.length === 0 && (
            <div className="text-center text-gray-500 text-sm py-8">
              Nenhum opt-out cadastrado.
            </div>
          )}
          {list.map((o) => (
            <div
              key={o.id}
              className="flex items-center justify-between p-2 border rounded"
            >
              <div>
                <div className="font-mono text-sm">{o.phone}</div>
                {o.reason && (
                  <div className="text-xs text-gray-500">{o.reason}</div>
                )}
              </div>
              <button
                onClick={() => onRemove(o.phone)}
                className="text-xs text-red-600 hover:underline"
              >
                Remover
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatAge(min: number): string {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
