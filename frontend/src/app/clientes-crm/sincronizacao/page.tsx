'use client';

/**
 * /clientes-crm/sincronizacao
 *
 * Página dedicada pra todas as operações de sync/ETL do CRM.
 * Tira esses botões do header da listagem (que estava poluído) e centraliza
 * aqui as 3 ações + diagnósticos:
 *
 *   1. Sincronizar do site (WooCommerce → Customer)
 *   2. Sincronizar Giga (Wincred MySQL → Customer + LTV + tier)
 *   3. Atualizar lojas Giga (atribui originStoreId pelo campo LOJA do Giga)
 *
 * Cada uma é um card com explicação + botão + progresso ao vivo.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, RefreshCw, Store as StoreIcon, ShoppingCart, Database,
  CheckCircle2, AlertCircle, Loader2, Info,
} from 'lucide-react';
import { api } from '@/lib/api';

interface EtlState {
  running: boolean;
  source: 'woo' | 'giga' | null;
  totalEmails: number;
  processed: number;
  inserted: number;
  updated: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

interface GigaEtlState {
  running: boolean;
  fase: 'idle' | 'clientes' | 'historico' | 'tier' | 'done' | 'cancelled';
  faseProgresso: { current: number; total: number };
  totalGiga: number;
  processados: number;
  criados: number;
  atualizados: number;
  pulados: number;
  erros: number;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  abortRequested?: boolean;
}

const GIGA_FASE_LABEL: Record<string, string> = {
  idle: 'aguardando',
  clientes: 'importando clientes',
  historico: 'calculando histórico (LTV)',
  tier: 'recalculando tier',
  done: 'concluído',
  cancelled: 'cancelado pelo usuário',
};

export default function SincronizacaoPage() {
  const [wcEtl, setWcEtl] = useState<EtlState | null>(null);
  const [wcSyncing, setWcSyncing] = useState(false);
  const [gigaEtl, setGigaEtl] = useState<GigaEtlState | null>(null);
  const [gigaSyncing, setGigaSyncing] = useState(false);
  const [lojaSyncing, setLojaSyncing] = useState(false);
  const [lojaResult, setLojaResult] = useState<{
    atualizados: number;
    semLojaNoGiga: number;
    semStoreCorrespondente: number;
    pulados: number;
    duracaoMs: number;
  } | null>(null);

  // Polling status WooCommerce + Giga
  useEffect(() => {
    api<EtlState>('/customers-crm/etl/status').then(setWcEtl).catch(() => {});
    api<GigaEtlState>('/customers-crm/etl/giga/status').then(setGigaEtl).catch(() => {});
  }, []);

  useEffect(() => {
    if (!wcEtl?.running && !gigaEtl?.running) return;
    const t = setInterval(async () => {
      try {
        if (wcEtl?.running) {
          const s = await api<EtlState>('/customers-crm/etl/status');
          setWcEtl(s);
        }
        if (gigaEtl?.running) {
          const s = await api<GigaEtlState>('/customers-crm/etl/giga/status');
          setGigaEtl(s);
        }
      } catch {}
    }, 2500);
    return () => clearInterval(t);
  }, [wcEtl?.running, gigaEtl?.running]);

  async function syncWooCommerce() {
    if (!confirm('Sincronizar todos os clientes do WooCommerce para o CRM?\n\nA primeira loja de cada cliente NÃO será sobrescrita.')) return;
    setWcSyncing(true);
    try {
      await api('/customers-crm/etl/woo', { method: 'POST' });
      const s = await api<EtlState>('/customers-crm/etl/status');
      setWcEtl(s);
    } catch (e: any) {
      alert(`Falha: ${e.message}`);
    } finally {
      setWcSyncing(false);
    }
  }

  async function syncGiga() {
    if (!confirm(
      'Sincronizar TODOS os clientes do Giga (Wincred) → CRM?\n\n' +
      '3 fases automáticas:\n' +
      '  1. Importa clientes\n' +
      '  2. Calcula histórico (LTV)\n' +
      '  3. Recalcula tier (Bronze/Prata/Ouro/Diamante)\n\n' +
      'Roda em background — pode demorar 5-15 minutos.',
    )) return;
    setGigaSyncing(true);
    try {
      await api('/customers-crm/etl/giga', { method: 'POST' });
      const s = await api<GigaEtlState>('/customers-crm/etl/giga/status');
      setGigaEtl(s);
    } catch (e: any) {
      alert(`Falha: ${e.message}`);
    } finally {
      setGigaSyncing(false);
    }
  }

  /** Cancela o sync Giga em andamento. Os loops checam abortRequested. */
  async function cancelGiga() {
    if (!confirm(
      'Cancelar o sync Giga em andamento?\n\n' +
      'Os dados já gravados ficam no banco. Você pode rodar de novo depois ' +
      'pra continuar.',
    )) return;
    try {
      await api('/customers-crm/etl/giga/cancelar', { method: 'POST' });
      // Atualiza status logo após
      const s = await api<GigaEtlState>('/customers-crm/etl/giga/status');
      setGigaEtl(s);
    } catch (e: any) {
      alert(`Falha ao cancelar: ${e.message}`);
    }
  }

  async function atualizarLojas() {
    if (!confirm(
      'Atualizar a LOJA dos clientes Giga sem loja vinculada?\n\n' +
      'Lê o campo LOJA da tabela `clientes` do Giga (a loja que cadastrou ' +
      'o cliente) e grava no CRM. NÃO altera quem já tem loja. NÃO mexe ' +
      'em clientes do site (ficam loja 13). Demora 1-3 min.',
    )) return;
    setLojaSyncing(true);
    setLojaResult(null);
    try {
      const r = await api<typeof lojaResult>('/customers-crm/etl/giga/loja-principal', {
        method: 'POST',
      });
      setLojaResult(r);
    } catch (e: any) {
      alert(`Falha: ${e.message}`);
    } finally {
      setLojaSyncing(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/clientes-crm" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
            <Database className="w-5 h-5 text-blue-700" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">Sincronização do CRM</h1>
            <p className="text-xs text-slate-500">Importar e atualizar clientes de WooCommerce e Giga (Wincred)</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-4">
        {/* Card 1 — WooCommerce */}
        <SyncCard
          icon={<ShoppingCart className="w-6 h-6 text-blue-700" />}
          title="WooCommerce (Site)"
          description="Importa clientes que compraram pelo site. Pega email, telefone, endereço de entrega e marca a loja de origem do primeiro pedido."
          color="blue"
          actionLabel={wcEtl?.running ? `Sincronizando... ${wcEtl.processed}/${wcEtl.totalEmails}` : 'Sincronizar do site'}
          loading={wcSyncing || !!wcEtl?.running}
          onAction={syncWooCommerce}
          status={wcEtl}
        />

        {/* Card 2 — Giga */}
        <GigaSyncCard
          state={gigaEtl}
          loading={gigaSyncing || !!gigaEtl?.running}
          onAction={syncGiga}
          onCancel={cancelGiga}
        />

        {/* Card 3 — Atualizar lojas */}
        <LojasUpdateCard
          loading={lojaSyncing}
          gigaRunning={!!gigaEtl?.running}
          result={lojaResult}
          onAction={atualizarLojas}
          onDismiss={() => setLojaResult(null)}
        />

        {/* Card 4 — Diagnóstico colunas Giga (futuro) */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center flex-shrink-0">
              <Info className="w-6 h-6 text-slate-600" />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-slate-800">Diagnóstico de colunas Giga</h3>
              <p className="text-sm text-slate-600 mt-1">
                Lista todas as colunas da tabela <code className="bg-slate-100 px-1 rounded text-xs">clientes</code> do Giga
                com amostras de dados — útil pra decidir quais campos adicionais importar (RG, profissão, etc.).
              </p>
              <a
                href="/api/customers-crm/etl/giga/colunas"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 mt-3 text-sm text-blue-700 hover:text-blue-900 font-medium"
              >
                Abrir JSON diagnóstico <ArrowLeft className="w-3.5 h-3.5 rotate-180" />
              </a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── Card genérico WC ──────────────────────────────────────────────────
function SyncCard({
  icon, title, description, color, actionLabel, loading, onAction, status,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  color: 'blue' | 'emerald' | 'amber';
  actionLabel: string;
  loading: boolean;
  onAction: () => void;
  status: EtlState | null;
}) {
  const colors: Record<typeof color, string> = {
    blue: 'bg-blue-600 hover:bg-blue-700',
    emerald: 'bg-emerald-600 hover:bg-emerald-700',
    amber: 'bg-amber-600 hover:bg-amber-700',
  };
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <div className="flex items-start gap-4">
        <div className={`w-12 h-12 rounded-xl bg-${color}-100 flex items-center justify-center flex-shrink-0`}>
          {icon}
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-slate-800">{title}</h3>
          <p className="text-sm text-slate-600 mt-1">{description}</p>

          <button
            onClick={onAction}
            disabled={loading}
            className={`mt-3 px-4 py-2 ${colors[color]} text-white text-sm font-bold rounded-lg flex items-center gap-2 disabled:opacity-50`}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {actionLabel}
          </button>

          {status && (status.running || (status.finishedAt && Date.now() - new Date(status.finishedAt).getTime() < 60000)) && (
            <div className={`mt-3 rounded-lg p-3 border ${
              status.running ? 'bg-blue-50 border-blue-200' :
              status.errors > 0 ? 'bg-amber-50 border-amber-200' :
              'bg-emerald-50 border-emerald-200'
            }`}>
              <div className="text-xs flex items-center gap-2">
                {status.running ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-700" />
                ) : status.errors > 0 ? (
                  <AlertCircle className="w-3.5 h-3.5 text-amber-700" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />
                )}
                <span className="font-bold">
                  {status.running ? `${status.processed} / ${status.totalEmails}` :
                   status.errors > 0 ? `Concluído com ${status.errors} erros` :
                   'Concluído com sucesso'}
                </span>
                <span className="text-slate-600">
                  · <b>{status.inserted}</b> novos · <b>{status.updated}</b> atualizados
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Card Giga (estado mais rico) ─────────────────────────────────────
function GigaSyncCard({
  state, loading, onAction, onCancel,
}: {
  state: GigaEtlState | null;
  loading: boolean;
  onAction: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-xl bg-emerald-100 flex items-center justify-center flex-shrink-0">
          <Database className="w-6 h-6 text-emerald-700" />
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-slate-800">Giga (Wincred — Loja física)</h3>
          <p className="text-sm text-slate-600 mt-1">
            Importa <b>todos</b> os clientes do Giga MySQL + calcula histórico de compras (LTV) +
            atribui tier VIP. Roda em 3 fases automaticamente. Não toca em dados marketing.
          </p>

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              onClick={onAction}
              disabled={loading}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg flex items-center gap-2 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${state?.running ? 'animate-spin' : ''}`} />
              {state?.running
                ? `${GIGA_FASE_LABEL[state.fase]}... ${state.faseProgresso.current}/${state.faseProgresso.total}`
                : 'Sincronizar Giga'}
            </button>
            {state?.running && (
              <button
                onClick={onCancel}
                disabled={!!state?.abortRequested}
                className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 disabled:opacity-50"
                title="Os dados já gravados ficam — só interrompe o que falta"
              >
                ✕ {state?.abortRequested ? 'Cancelando...' : 'Cancelar sync'}
              </button>
            )}
          </div>

          {state && (state.running || (state.finishedAt && Date.now() - new Date(state.finishedAt).getTime() < 60000)) && (
            <div className={`mt-3 rounded-lg p-3 border ${
              state.running ? 'bg-emerald-50 border-emerald-200' :
              state.erros > 0 ? 'bg-amber-50 border-amber-200' :
              'bg-emerald-50 border-emerald-200'
            }`}>
              <div className="text-xs space-y-1">
                <div className="flex items-center gap-2 font-bold">
                  {state.running ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-700" />
                  ) : (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />
                  )}
                  Fase: <span className="capitalize">{GIGA_FASE_LABEL[state.fase]}</span>
                </div>
                <div className="text-slate-700">
                  <b>{state.criados}</b> novos · <b>{state.atualizados}</b> atualizados
                  {state.pulados > 0 && <> · {state.pulados} pulados</>}
                  {state.erros > 0 && <> · <span className="text-rose-700">{state.erros} erros</span></>}
                </div>
                {state.running && state.faseProgresso.total > 0 && (
                  <div className="h-1.5 bg-emerald-100 rounded overflow-hidden mt-1.5">
                    <div
                      className="h-full bg-emerald-500 transition-all duration-500"
                      style={{ width: `${Math.min(100, (state.faseProgresso.current / state.faseProgresso.total) * 100)}%` }}
                    />
                  </div>
                )}
                {state.lastError && (
                  <div className="text-rose-700 mt-1">Último erro: {state.lastError}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Card atualizar lojas ─────────────────────────────────────────────
function LojasUpdateCard({
  loading, gigaRunning, result, onAction, onDismiss,
}: {
  loading: boolean;
  gigaRunning: boolean;
  result: { atualizados: number; semLojaNoGiga: number; semStoreCorrespondente: number; pulados: number; duracaoMs: number } | null;
  onAction: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0">
          <StoreIcon className="w-6 h-6 text-amber-700" />
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-slate-800">Atualizar lojas dos clientes Giga</h3>
          <p className="text-sm text-slate-600 mt-1">
            Atribui a loja origem dos clientes Giga <b>sem loja vinculada</b> lendo o
            campo <code className="bg-slate-100 px-1 py-0.5 rounded text-xs">LOJA</code> da
            tabela <code className="bg-slate-100 px-1 py-0.5 rounded text-xs">clientes</code> do
            Giga (a loja que cadastrou o cliente). Não altera quem já tem loja vinculada
            nem clientes do site (loja 13). Rodada rápida (1-3 min).
          </p>

          <button
            onClick={onAction}
            disabled={loading || gigaRunning}
            className="mt-3 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-bold rounded-lg flex items-center gap-2 disabled:opacity-50"
            title={gigaRunning ? 'Aguarde o sync Giga terminar' : ''}
          >
            <StoreIcon className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Atualizando...' : 'Atualizar lojas'}
          </button>

          {result && (
            <div className="mt-3 rounded-lg p-3 border bg-amber-50 border-amber-200 flex items-center justify-between">
              <div className="text-xs">
                <span className="font-bold">✓ {result.atualizados} clientes</span> receberam loja origem
                {result.pulados > 0 && <> · {result.pulados} já estavam OK</>}
                {result.semLojaNoGiga > 0 && <> · {result.semLojaNoGiga} sem LOJA no Giga</>}
                {result.semStoreCorrespondente > 0 && (
                  <> · <span className="text-rose-700">{result.semStoreCorrespondente} sem store match</span></>
                )}
                <span className="text-slate-500 ml-2">({Math.round(result.duracaoMs / 1000)}s)</span>
              </div>
              <button onClick={onDismiss} className="text-amber-700 hover:text-amber-900 text-xs font-bold">
                fechar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
