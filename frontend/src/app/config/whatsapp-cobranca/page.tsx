'use client';

/**
 * /config/whatsapp-cobranca — Conexão e config do WhatsApp DEDICADO pra cobrança.
 *
 * Diferente do WA do site (/config/whatsapp), este número é só pra disparos
 * automatizados de cobrança. Permite controlar:
 *   - Horário de início e fim dos disparos
 *   - Intervalo entre mensagens (anti-block)
 *   - Pausa a cada N envios
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, RefreshCw, MessageCircle, CheckCircle2, XCircle,
  Loader2, Clock, Send, AlertTriangle,
  LayoutDashboard, Globe2, Store, BarChart3, Settings,
} from 'lucide-react';
import { api } from '@/lib/api';
import AdminShell, { type AdminNavItem } from '@/components/AdminShell';

const NAV: AdminNavItem[] = [
  { key: 'dashboard', label: 'Dashboard',  href: '/',           icon: LayoutDashboard },
  { key: 'site',      label: 'Site',       href: '/site',       icon: Globe2 },
  { key: 'loja',      label: 'Loja',       href: '/loja',       icon: Store },
  { key: 'gestao',    label: 'Gestão',     href: '/retaguarda', icon: BarChart3 },
  { key: 'config',    label: 'Config',     href: '/config',     icon: Settings },
];

interface WaStatus {
  connected: boolean;
  phoneNumber: string | null;
  connectedAt: string | null;
  qr: string | null;
}
interface WaConfig {
  horaInicio: string;
  horaFim: string;
  intervaloSeg: number;
  pausaACada: number;
  pausaSeg: number;
}

export default function WhatsappCobrancaPage() {
  const [status, setStatus] = useState<WaStatus | null>(null);
  const [config, setConfig] = useState<WaConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [testNumber, setTestNumber] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [s, c] = await Promise.all([
        api<WaStatus>('/whatsapp/cobranca/status'),
        api<WaConfig>('/whatsapp/cobranca/config'),
      ]);
      setStatus(s);
      setConfig(c);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(() => {
      // Polling rápido enquanto QR está pendente, lento depois
      api<WaStatus>('/whatsapp/cobranca/status').then(setStatus).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      await api('/whatsapp/cobranca/connect', { method: 'POST', body: '{}' });
      // Aguarda QR aparecer no status (polling já cuida)
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm('Desconectar WhatsApp Cobrança? Você precisará escanear o QR de novo.')) return;
    setBusy(true);
    setError(null);
    try {
      await api('/whatsapp/cobranca/disconnect', { method: 'POST', body: '{}' });
      await load();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    if (!config) return;
    setSavingConfig(true);
    try {
      const updated = await api<WaConfig>('/whatsapp/cobranca/config', {
        method: 'POST',
        body: JSON.stringify(config),
      });
      setConfig(updated);
      alert('Configuração salva.');
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    } finally {
      setSavingConfig(false);
    }
  }

  async function sendTest() {
    if (!testNumber.trim()) return;
    setTestResult(null);
    try {
      const r = await api<{ ok: boolean; error?: string }>('/whatsapp/cobranca/send-test', {
        method: 'POST',
        body: JSON.stringify({ number: testNumber.trim() }),
      });
      setTestResult(r.ok ? '✅ Mensagem de teste enviada com sucesso!' : `❌ ${r.error}`);
    } catch (e: any) {
      setTestResult(`❌ ${e?.message}`);
    }
  }

  return (
    <AdminShell
      title="WhatsApp Cobrança"
      subtitle={<span>Linha dedicada pra cobrança automática · separada do site</span>}
      navItems={NAV}
      activeKey="config"
      noSidebar
      actions={
        <>
          <Link
            href="/config"
            className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
          >
            <ArrowLeft className="w-4 h-4" />
            Config
          </Link>
          <button
            onClick={load}
            className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
          >
            <RefreshCw className="w-4 h-4" /> Atualizar
          </button>
        </>
      }
    >
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* CONEXÃO + QR */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <MessageCircle className="w-5 h-5 text-emerald-600" />
            <h3 className="text-base font-bold text-slate-900">Conexão</h3>
          </div>

          {loading && (
            <div className="text-center py-10 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin inline" />
            </div>
          )}

          {!loading && status && (
            <>
              <div
                className={`rounded-lg p-3 mb-3 flex items-center gap-3 ${
                  status.connected
                    ? 'bg-emerald-50 border border-emerald-200'
                    : 'bg-amber-50 border border-amber-200'
                }`}
              >
                {status.connected ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                ) : (
                  <XCircle className="w-5 h-5 text-amber-600 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm">
                    {status.connected ? 'Conectado' : 'Desconectado'}
                  </div>
                  {status.connected ? (
                    <div className="text-xs text-slate-600">
                      Número: <span className="font-mono font-bold">{status.phoneNumber || '—'}</span>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-600">
                      Clique em <b>Conectar</b> e escaneie o QR no app do WhatsApp.
                    </div>
                  )}
                </div>
              </div>

              {!status.connected && status.qr && (
                <div className="text-center mb-3">
                  <div className="text-xs text-slate-500 mb-2 font-semibold">
                    Escaneie pelo WhatsApp → Aparelhos conectados
                  </div>
                  <img
                    src={status.qr}
                    alt="QR code"
                    className="mx-auto border-4 border-emerald-200 rounded-lg max-w-[280px]"
                  />
                </div>
              )}

              <div className="flex gap-2">
                {!status.connected ? (
                  <button
                    onClick={connect}
                    disabled={busy}
                    className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageCircle className="w-4 h-4" />}
                    Conectar
                  </button>
                ) : (
                  <button
                    onClick={disconnect}
                    disabled={busy}
                    className="flex-1 px-4 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg disabled:opacity-50"
                  >
                    Desconectar
                  </button>
                )}
              </div>

              {/* Teste de envio */}
              {status.connected && (
                <div className="mt-4 pt-4 border-t border-slate-100">
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                    Enviar teste
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="tel"
                      value={testNumber}
                      onChange={(e) => setTestNumber(e.target.value)}
                      placeholder="DDD + número (ex: 13999998888)"
                      className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    />
                    <button
                      onClick={sendTest}
                      disabled={!testNumber.trim()}
                      className="px-4 py-2 bg-slate-700 hover:bg-slate-800 text-white text-sm font-semibold rounded-lg disabled:opacity-50 flex items-center gap-1.5"
                    >
                      <Send className="w-3.5 h-3.5" />
                      Enviar
                    </button>
                  </div>
                  {testResult && (
                    <div className="text-xs mt-2 text-slate-700">{testResult}</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* CONFIG HORÁRIO + INTERVALO */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-5 h-5 text-sky-600" />
            <h3 className="text-base font-bold text-slate-900">Janela de disparo</h3>
          </div>

          {!loading && config && (
            <>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Hora início
                  </label>
                  <input
                    type="time"
                    value={config.horaInicio}
                    onChange={(e) => setConfig({ ...config, horaInicio: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Hora fim
                  </label>
                  <input
                    type="time"
                    value={config.horaFim}
                    onChange={(e) => setConfig({ ...config, horaFim: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Intervalo (seg)
                  </label>
                  <input
                    type="number"
                    min={15} max={600}
                    value={config.intervaloSeg}
                    onChange={(e) => setConfig({ ...config, intervaloSeg: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                  <div className="text-[10px] text-slate-500 mt-1">Entre 1 envio e o próximo</div>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Pausa a cada
                  </label>
                  <input
                    type="number"
                    min={10} max={200}
                    value={config.pausaACada}
                    onChange={(e) => setConfig({ ...config, pausaACada: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                  <div className="text-[10px] text-slate-500 mt-1">N mensagens</div>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Pausa (seg)
                  </label>
                  <input
                    type="number"
                    min={60} max={1800}
                    value={config.pausaSeg}
                    onChange={(e) => setConfig({ ...config, pausaSeg: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                  <div className="text-[10px] text-slate-500 mt-1">Duração da pausa</div>
                </div>
              </div>

              <button
                onClick={saveConfig}
                disabled={savingConfig}
                className="w-full px-4 py-2.5 bg-sky-600 hover:bg-sky-700 text-white font-bold rounded-lg disabled:opacity-50"
              >
                {savingConfig ? 'Salvando…' : 'Salvar configuração'}
              </button>

              <div className="mt-4 pt-4 border-t border-slate-100 text-[12px] text-slate-600 leading-relaxed flex gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  Recomendação anti-block: intervalo entre <b>30-60s</b>, pausa de <b>5min</b> a cada <b>50 envios</b>.
                  Disparos fora dessa janela são automaticamente abortados.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
