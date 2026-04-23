'use client';

/**
 * TrackingTimeline — componente que consulta /tracking/:code e mostra
 * os eventos em timeline vertical. Clicar "Atualizar" refetcha.
 *
 * Uso:
 *   <TrackingTimeline code={order.trackingCode} carrier={order.carrier} />
 *
 * Render states:
 *   - Sem código → nada (retorna null)
 *   - Loading → skeleton
 *   - Erro/sem token → aviso amarelo com instrução
 *   - OK → timeline + banner verde "entregue" quando delivered=true
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface TrackingEvent {
  date: string;
  time: string;
  location: string;
  description: string;
  isDelivery: boolean;
}

interface TrackingResult {
  code: string;
  carrier: string;
  service: string | null;
  events: TrackingEvent[];
  lastStatus: string | null;
  delivered: boolean;
  fetchedAt: string;
  provider: string;
  error?: string;
}

interface Props {
  code: string | null | undefined;
  carrier?: string | null;
  /** Se true, já faz fetch ao montar. Se false, só quando usuário clica. */
  autoFetch?: boolean;
  /** Compact = esconde eventos antigos, só mostra último status + botão expandir. */
  compact?: boolean;
}

export default function TrackingTimeline({
  code,
  carrier,
  autoFetch = true,
  compact = false,
}: Props) {
  const [data, setData] = useState<TrackingResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(!compact);
  const [err, setErr] = useState<string | null>(null);

  const fetchIt = useCallback(async () => {
    if (!code) return;
    setLoading(true);
    setErr(null);
    try {
      const qs = carrier ? `?carrier=${encodeURIComponent(carrier)}` : '';
      const r = await api<TrackingResult>(`/tracking/${encodeURIComponent(code)}${qs}`);
      setData(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao consultar rastreio');
    } finally {
      setLoading(false);
    }
  }, [code, carrier]);

  useEffect(() => {
    if (autoFetch && code) void fetchIt();
  }, [autoFetch, code, fetchIt]);

  if (!code) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">📦</span>
          <div>
            <div className="text-sm font-semibold text-slate-900">
              Rastreio {carrier ? `(${carrier.toUpperCase()})` : ''}
            </div>
            <div className="font-mono text-xs text-slate-500">{code}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={fetchIt}
          disabled={loading}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? 'Atualizando…' : 'Atualizar'}
        </button>
      </div>

      {err && (
        <div className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
          {err}
        </div>
      )}

      {data?.error && (
        <div className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ⚠️ {data.error}
        </div>
      )}

      {data?.delivered && (
        <div className="mt-3 rounded bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
          ✅ Objeto entregue
        </div>
      )}

      {data?.lastStatus && !data.delivered && (
        <div className="mt-3 rounded bg-sky-50 px-3 py-2 text-sm text-sky-900">
          <span className="font-semibold">Último status:</span> {data.lastStatus}
        </div>
      )}

      {data && data.events.length > 0 && (
        <>
          {compact && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 text-xs font-medium text-sky-700 hover:underline"
            >
              Ver histórico completo ({data.events.length} eventos)
            </button>
          )}
          {expanded && (
            <ol className="mt-4 space-y-3 border-l-2 border-slate-200 pl-4">
              {data.events.map((ev, i) => (
                <li key={i} className="relative">
                  <span
                    className={`absolute -left-[22px] top-1 h-3 w-3 rounded-full border-2 border-white ${
                      ev.isDelivery
                        ? 'bg-emerald-500'
                        : i === 0
                          ? 'bg-sky-500'
                          : 'bg-slate-400'
                    }`}
                  />
                  <div className="text-sm font-medium text-slate-900">
                    {ev.description}
                  </div>
                  <div className="text-xs text-slate-600">
                    {ev.date} {ev.time && `· ${ev.time}`}
                    {ev.location && ` · ${ev.location}`}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {data && data.events.length === 0 && !data.error && !loading && (
        <div className="mt-3 rounded bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Ainda sem eventos registrados pelo Correios. Pode levar até 24h após a postagem.
        </div>
      )}

      {data?.fetchedAt && (
        <div className="mt-3 text-right text-[10px] text-slate-400">
          Atualizado: {new Date(data.fetchedAt).toLocaleTimeString('pt-BR')}
        </div>
      )}
    </div>
  );
}
