'use client';

/**
 * PAINEL DE DEBUG DE TRACKING.
 *
 * Duas fontes lado a lado, e a diferença entre elas é o diagnóstico:
 *   SERVIDOR — o que a CAPI e o Measurement Protocol responderam;
 *   NAVEGADOR — o que os pixels fizeram nesta aba.
 *
 * Evento que aparece só no servidor = pixel bloqueado (adblock/iOS). Só no
 * navegador = a fila não chegou ao `/api/events`. Nos dois = par completo,
 * deduplicado pelo `event_id`. É a primeira pergunta de toda investigação de
 * "sumiu conversão", e por isso as duas listas ficam visíveis juntas.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getDataLayer, getLocalLogs, subscribeLogs } from '@/lib/tracking';
import type { DispatchLog, TrackingEvent } from '@/lib/tracking/types';

const TOKEN_KEY = 'lurds_debug_token';
const POLL_MS = 3_000;

export default function TrackingDebugPage() {
  const [token, setToken] = useState('');
  const [serverLogs, setServerLogs] = useState<DispatchLog[]>([]);
  const [browserLogs, setBrowserLogs] = useState<DispatchLog[]>([]);
  const [dataLayer, setDataLayer] = useState<TrackingEvent[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aoVivo, setAoVivo] = useState(true);

  const [filtroStatus, setFiltroStatus] = useState('');
  const [filtroDestino, setFiltroDestino] = useState('');
  const [busca, setBusca] = useState('');
  const [aberto, setAberto] = useState<string | null>(null);

  useEffect(() => {
    setToken(sessionStorage.getItem(TOKEN_KEY) ?? '');
    setBrowserLogs(getLocalLogs());
    setDataLayer(getDataLayer());
    return subscribeLogs((log) => setBrowserLogs((prev) => [...prev.slice(-499), log]));
  }, []);

  const buscarServidor = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (token) qs.set('token', token);
      if (filtroStatus) qs.set('status', filtroStatus);
      if (filtroDestino) qs.set('destination', filtroDestino);
      if (busca) qs.set('search', busca);

      const res = await fetch(`/api/events/logs?${qs}`, { cache: 'no-store' });
      if (res.status === 404) {
        setErro('Token inválido ou rota desabilitada. Configure TRACKING_DEBUG_TOKEN.');
        return;
      }
      if (!res.ok) {
        setErro(`Falha ao ler logs (HTTP ${res.status})`);
        return;
      }
      const json = (await res.json()) as { logs: DispatchLog[] };
      setServerLogs(json.logs);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha de rede');
    }
  }, [token, filtroStatus, filtroDestino, busca]);

  useEffect(() => {
    void buscarServidor();
    if (!aoVivo) return;
    const id = setInterval(() => void buscarServidor(), POLL_MS);
    return () => clearInterval(id);
  }, [buscarServidor, aoVivo]);

  useEffect(() => {
    if (!aoVivo) return;
    const id = setInterval(() => setDataLayer(getDataLayer()), POLL_MS);
    return () => clearInterval(id);
  }, [aoVivo]);

  const metricas = useMemo(() => calcularMetricas(serverLogs), [serverLogs]);

  const logsNavegador = useMemo(() => {
    const termo = busca.toLowerCase();
    return browserLogs
      .filter((l) => !filtroStatus || l.status === filtroStatus)
      .filter((l) => !filtroDestino || l.destination === filtroDestino)
      .filter((l) => !termo || `${l.event} ${l.destination} ${l.error ?? ''} ${l.reason ?? ''}`.toLowerCase().includes(termo))
      .slice(-200)
      .reverse();
  }, [browserLogs, filtroStatus, filtroDestino, busca]);

  const exportar = () => {
    const blob = new Blob([JSON.stringify({ servidor: serverLogs, navegador: browserLogs, dataLayer }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tracking-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 font-mono text-[13px]">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight text-white">Tracking · Debug</h1>
        <span className={`rounded px-2 py-0.5 text-[11px] ${aoVivo ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/10 text-white/50'}`}>
          {aoVivo ? '● ao vivo' : '‖ pausado'}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              sessionStorage.setItem(TOKEN_KEY, e.target.value);
            }}
            placeholder="TRACKING_DEBUG_TOKEN"
            className="w-52 rounded border border-white/15 bg-white/5 px-2.5 py-1.5 text-white placeholder:text-white/30"
          />
          <Botao onClick={() => setAoVivo((v) => !v)}>{aoVivo ? 'Pausar' : 'Retomar'}</Botao>
          <Botao onClick={exportar}>Exportar</Botao>
          <Botao
            onClick={async () => {
              await fetch(`/api/events/logs?token=${token}`, { method: 'DELETE' });
              void buscarServidor();
            }}
          >
            Limpar
          </Botao>
        </div>
      </header>

      {erro && <p className="mb-5 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-300">{erro}</p>}

      {/* Dashboard técnico */}
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Metrica rotulo="Eventos" valor={metricas.total} />
        <Metrica rotulo="Sucesso" valor={metricas.sucesso} tom="ok" />
        <Metrica rotulo="Erros" valor={metricas.erros} tom={metricas.erros ? 'ruim' : undefined} />
        <Metrica rotulo="Retentando" valor={metricas.retry} tom={metricas.retry ? 'alerta' : undefined} />
        <Metrica rotulo="Latência p50" valor={`${metricas.p50}ms`} />
        <Metrica rotulo="Latência p95" valor={`${metricas.p95}ms`} tom={metricas.p95 > 2000 ? 'alerta' : undefined} />
      </section>

      {/* Alertas — leem o mesmo dado, mas dizem o que fazer com ele. */}
      {metricas.alertas.length > 0 && (
        <ul className="mb-6 space-y-1.5">
          {metricas.alertas.map((a) => (
            <li key={a} className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">
              ⚠ {a}
            </li>
          ))}
        </ul>
      )}

      {/* Filtros */}
      <div className="mb-4 flex flex-wrap gap-2">
        <select value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)} className={selectCls}>
          <option value="">status: todos</option>
          <option value="success">success</option>
          <option value="error">error</option>
          <option value="retrying">retrying</option>
          <option value="skipped">skipped</option>
        </select>
        <select value={filtroDestino} onChange={(e) => setFiltroDestino(e.target.value)} className={selectCls}>
          <option value="">destino: todos</option>
          {metricas.destinos.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="buscar evento, erro, id…"
          className="flex-1 min-w-48 rounded border border-white/15 bg-white/5 px-2.5 py-1.5 text-white placeholder:text-white/30"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Lista titulo={`Servidor (${serverLogs.length})`} logs={serverLogs} aberto={aberto} setAberto={setAberto} />
        <Lista titulo={`Navegador (${logsNavegador.length})`} logs={logsNavegador} aberto={aberto} setAberto={setAberto} />
      </div>

      <section className="mt-8">
        <h2 className="mb-2 text-white/80">Data Layer ({dataLayer.length})</h2>
        <div className="max-h-80 overflow-auto rounded border border-white/10 bg-black/30">
          {dataLayer
            .slice()
            .reverse()
            .map((ev) => (
              <details key={ev.event_id} className="border-b border-white/5 px-3 py-1.5">
                <summary className="cursor-pointer text-white/70">
                  <span className="text-white">{ev.event}</span>
                  <span className="ml-2 text-white/35">{ev.event_id.slice(0, 8)}</span>
                  <span className="ml-2 text-white/35">{ev.timestamp.slice(11, 19)}</span>
                </summary>
                <pre className="mt-2 overflow-x-auto text-[11px] leading-relaxed text-white/60">
                  {JSON.stringify(ev, null, 2)}
                </pre>
              </details>
            ))}
          {dataLayer.length === 0 && <p className="px-3 py-4 text-white/40">Navegue pela loja para gerar eventos.</p>}
        </div>
      </section>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

const selectCls = 'rounded border border-white/15 bg-white/5 px-2.5 py-1.5 text-white';

function Botao({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded border border-white/15 px-3 py-1.5 text-white/80 hover:bg-white/10">
      {children}
    </button>
  );
}

function Metrica({ rotulo, valor, tom }: { rotulo: string; valor: number | string; tom?: 'ok' | 'ruim' | 'alerta' }) {
  const cor = tom === 'ok' ? 'text-emerald-300' : tom === 'ruim' ? 'text-red-300' : tom === 'alerta' ? 'text-amber-300' : 'text-white';
  return (
    <div className="rounded border border-white/10 bg-white/5 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wider text-white/40">{rotulo}</div>
      <div className={`mt-0.5 text-lg font-semibold ${cor}`}>{valor}</div>
    </div>
  );
}

function Lista({
  titulo,
  logs,
  aberto,
  setAberto,
}: {
  titulo: string;
  logs: DispatchLog[];
  aberto: string | null;
  setAberto: (id: string | null) => void;
}) {
  return (
    <section>
      <h2 className="mb-2 text-white/80">{titulo}</h2>
      <div className="max-h-[32rem] overflow-auto rounded border border-white/10 bg-black/30">
        {logs.map((l) => (
          <div key={l.id} className="border-b border-white/5">
            <button
              type="button"
              onClick={() => setAberto(aberto === l.id ? null : l.id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5"
            >
              <StatusDot status={l.status} />
              <span className="text-white">{l.event}</span>
              <span className="text-white/40">→ {l.destination}</span>
              <span className="ml-auto shrink-0 text-white/30">
                {l.duration_ms}ms{l.attempt > 1 ? ` · ${l.attempt}ª` : ''}
              </span>
            </button>
            {aberto === l.id && (
              <pre className="overflow-x-auto px-3 pb-2 text-[11px] leading-relaxed text-white/60">
                {JSON.stringify(l, null, 2)}
              </pre>
            )}
          </div>
        ))}
        {logs.length === 0 && <p className="px-3 py-4 text-white/40">Nenhum registro.</p>}
      </div>
    </section>
  );
}

function StatusDot({ status }: { status: DispatchLog['status'] }) {
  const cor =
    status === 'success' ? 'bg-emerald-400' : status === 'error' ? 'bg-red-400' : status === 'retrying' ? 'bg-amber-400' : 'bg-white/25';
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cor}`} aria-label={status} />;
}

/* ────────────────────────────────────────────────────────────────────────── */

function calcularMetricas(logs: DispatchLog[]) {
  const sucesso = logs.filter((l) => l.status === 'success').length;
  const erros = logs.filter((l) => l.status === 'error').length;
  const retry = logs.filter((l) => l.status === 'retrying').length;

  // Percentil só faz sentido sobre despacho que aconteceu de verdade — skip tem
  // duração zero e puxaria a mediana pro chão.
  const duracoes = logs.filter((l) => l.status === 'success').map((l) => l.duration_ms).sort((a, b) => a - b);
  const percentil = (p: number) => (duracoes.length ? duracoes[Math.min(duracoes.length - 1, Math.floor(duracoes.length * p))] : 0);

  const destinos = [...new Set(logs.map((l) => l.destination))].sort();

  const alertas: string[] = [];
  const total = logs.length;
  if (total > 0 && erros / total > 0.1) {
    alertas.push(`Taxa de erro em ${Math.round((erros / total) * 100)}% — confira credenciais e o status das plataformas.`);
  }
  for (const d of destinos) {
    const doDestino = logs.filter((l) => l.destination === d);
    if (doDestino.length >= 5 && doDestino.every((l) => l.status === 'error')) {
      alertas.push(`Destino "${d}" falhou em todas as tentativas recentes — provavelmente está fora ou sem credencial.`);
    }
  }
  if (percentil(0.95) > 3000) alertas.push('Latência p95 acima de 3s — o fan-out está segurando a resposta.');
  if (total > 0 && !logs.some((l) => l.event === 'purchase')) {
    // Informativo, não alarme: em ambiente de teste é o esperado.
    alertas.push('Nenhum purchase no período. Normal em homologação; em produção, investigue.');
  }

  return { total, sucesso, erros, retry, p50: percentil(0.5), p95: percentil(0.95), destinos, alertas };
}
