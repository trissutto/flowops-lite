'use client';

/**
 * /retaguarda/whatsapp — gerencia a sessão do Baileys.
 *
 * Fluxo:
 *   1. Tela abre → GET /whatsapp/status pra saber se já está conectado.
 *   2. Se desconectado: botão "Conectar" chama POST /whatsapp/connect.
 *   3. Backend começa a emitir QR → tela faz polling em /status a cada 2s e
 *      mostra o QR como imagem.
 *   4. Usuário escaneia pelo celular (WhatsApp → Aparelhos conectados).
 *   5. Status vira `connected: true` → para o polling e mostra o número logado.
 *   6. Botão "Desconectar" chama /logout e apaga sessão (próxima conexão = QR novo).
 *
 * Sessão dura SEMANAS enquanto o app principal do celular estiver ativo.
 */

import { useEffect, useRef, useState } from 'react';
import { Smartphone, QrCode, Loader2, CheckCircle2, LogOut, AlertTriangle, RefreshCw, Send, Phone } from 'lucide-react';
import { api } from '@/lib/api';

type Status = {
  connected: boolean;
  phoneNumber: string | null;
  connectedAt: string | null;
  qr: string | null;
};

export default function WhatsappPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Teste de envio manual
  const [testNumber, setTestNumber] = useState('');
  const [testText, setTestText] = useState('Teste do Order One 🚀');
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const pollRef = useRef<any>(null);

  async function loadStatus() {
    try {
      const s = await api<Status>('/whatsapp/status');
      setStatus(s);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Falha ao consultar status');
    } finally {
      setLoading(false);
    }
  }

  // Polling a cada 2s SE estiver desconectado ou esperando QR
  useEffect(() => {
    loadStatus();
    pollRef.current = setInterval(() => {
      loadStatus();
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, []);

  // Quando conectar, reduz polling (não precisa fazer a cada 2s se tudo OK)
  useEffect(() => {
    if (status?.connected) {
      clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        loadStatus();
      }, 15000);
    }
  }, [status?.connected]);

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      await api('/whatsapp/connect', { method: 'POST' });
      // Espera o backend gerar o QR; o polling pega ele
      await new Promise((r) => setTimeout(r, 800));
      await loadStatus();
    } catch (e: any) {
      setError(e?.message || 'Falha ao iniciar conexão');
    } finally {
      setConnecting(false);
    }
  }

  async function handleLogout() {
    if (!window.confirm('Desconectar o WhatsApp? A sessão será apagada e você precisará escanear um novo QR.')) return;
    setLoggingOut(true);
    try {
      await api('/whatsapp/logout', { method: 'POST' });
      await loadStatus();
    } catch (e: any) {
      setError(e?.message || 'Falha ao desconectar');
    } finally {
      setLoggingOut(false);
    }
  }

  async function handleTestSend() {
    if (!testNumber || !testText) return;
    setTestSending(true);
    setTestResult(null);
    try {
      const r = await api<{ ok: boolean; error?: string }>('/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify({ number: testNumber, text: testText }),
      });
      setTestResult(r.ok ? '✓ Mensagem enviada' : `✗ ${r.error}`);
    } catch (e: any) {
      setTestResult(`✗ ${e?.message || e}`);
    } finally {
      setTestSending(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Smartphone className="w-8 h-8 text-emerald-600" />
          <h1 className="text-2xl font-bold text-slate-800">WhatsApp</h1>
        </div>
        <p className="text-slate-600 text-sm">
          Conecte um celular uma vez e o sistema dispara mensagens das lojas automaticamente —
          sem abrir abas do navegador.
        </p>
      </header>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-red-800">{error}</div>
        </div>
      )}

      {loading && !status && (
        <div className="text-center py-12 text-slate-500">
          <Loader2 className="w-6 h-6 animate-spin inline mr-2" />
          Consultando status…
        </div>
      )}

      {status?.connected && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="bg-emerald-100 p-3 rounded-full">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
            </div>
            <div className="flex-1">
              <div className="text-lg font-semibold text-slate-800">Conectado</div>
              <div className="text-sm text-slate-600 mt-1">
                Número: <span className="font-mono text-slate-800">+{status.phoneNumber}</span>
              </div>
              {status.connectedAt && (
                <div className="text-xs text-slate-500 mt-1">
                  Sessão desde{' '}
                  {new Date(status.connectedAt).toLocaleString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              )}
            </div>
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="px-4 py-2 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg flex items-center gap-2 disabled:opacity-50"
            >
              {loggingOut ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
              Desconectar
            </button>
          </div>

          {/* Caixa de teste de envio */}
          <div className="mt-6 pt-6 border-t border-slate-200">
            <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
              <Send className="w-4 h-4" /> Teste de envio
            </h3>
            <div className="flex flex-wrap gap-2">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-slate-600 block mb-1">Número (com DDD, ex: 13999998888)</label>
                <input
                  type="text"
                  value={testNumber}
                  onChange={(e) => setTestNumber(e.target.value)}
                  placeholder="13999998888"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                />
              </div>
              <div className="flex-[2] min-w-[250px]">
                <label className="text-xs text-slate-600 block mb-1">Texto</label>
                <input
                  type="text"
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={handleTestSend}
                  disabled={testSending || !testNumber || !testText}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 flex items-center gap-2"
                >
                  {testSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Enviar
                </button>
              </div>
            </div>
            {testResult && (
              <div className={`mt-2 text-sm ${testResult.startsWith('✓') ? 'text-emerald-700' : 'text-red-700'}`}>
                {testResult}
              </div>
            )}
          </div>
        </div>
      )}

      {!status?.connected && status?.qr && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <div className="flex flex-col items-center">
            <h2 className="text-lg font-semibold text-slate-800 mb-2">Escaneie o QR Code</h2>
            <p className="text-sm text-slate-600 mb-4 text-center max-w-md">
              No celular: WhatsApp → Menu → <strong>Aparelhos conectados</strong> →{' '}
              <strong>Conectar um aparelho</strong> → aponta a câmera pra tela.
            </p>
            <div className="bg-white p-4 rounded-lg border-2 border-dashed border-slate-300">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={status.qr} alt="QR Code WhatsApp" className="w-64 h-64" />
            </div>
            <div className="mt-4 text-xs text-slate-500 flex items-center gap-2">
              <RefreshCw className="w-3 h-3 animate-spin" />
              QR renova sozinho se expirar
            </div>
          </div>
        </div>
      )}

      {!status?.connected && !status?.qr && (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center">
          <QrCode className="w-16 h-16 text-slate-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-800 mb-2">Conectar WhatsApp</h2>
          <p className="text-sm text-slate-600 mb-6 max-w-md mx-auto">
            Clique abaixo pra gerar um QR code. Ele só precisa ser escaneado uma vez —
            a sessão fica ativa semanas.
          </p>
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg disabled:opacity-50 flex items-center gap-2 mx-auto"
          >
            {connecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <QrCode className="w-5 h-5" />}
            Gerar QR Code
          </button>
        </div>
      )}

      {/* Aviso sobre número dedicado */}
      <div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg flex gap-3 text-sm text-amber-900">
        <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-semibold mb-1">Use um número dedicado</div>
          <div className="text-amber-800">
            Evite conectar seu número pessoal. Compre um chip só pra isso — custa ~R$20 e
            protege você contra qualquer bloqueio eventual do Meta.
          </div>
        </div>
      </div>

      {/* Dica de uso */}
      <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg flex gap-3 text-sm text-blue-900">
        <Phone className="w-5 h-5 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-semibold mb-1">Depois de conectado</div>
          <div className="text-blue-800">
            Nas telas de Separação, o botão <strong>Disparar WhatsApp</strong> envia tudo
            direto por aqui — sem abrir abas. Uma mensagem a cada ~3s pra evitar ser
            identificado como spam.
          </div>
        </div>
      </div>
    </div>
  );
}
