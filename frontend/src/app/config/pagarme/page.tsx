'use client';

/**
 * /retaguarda/pagarme-config — admin
 *
 * Pagar.me API v5. Vantagem: PIX dinâmico em produção sem homologação.
 * API Key sk_test_xxx → sandbox · sk_xxx → produção (auto-detectado).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Save, Lock, Unlock, FileWarning, CheckCircle2, Eye, EyeOff,
  Power,
} from 'lucide-react';
import { api } from '@/lib/api';

type ConfigState = {
  ambiente: 'test' | 'live';
  enabled: boolean;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  recipientId: string | null;
  detectedFromKey: 'test' | 'live' | null;
};

export default function PagarmeConfigPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [cfg, setCfg] = useState<ConfigState>({
    ambiente: 'test',
    enabled: false,
    hasApiKey: false,
    hasWebhookSecret: false,
    recipientId: null,
    detectedFromKey: null,
  });

  const [apiKey, setApiKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await api<ConfigState>('/pagarme/config');
        setCfg(data);
      } catch (e: any) {
        setMsg({ kind: 'err', text: 'Falha ao ler config: ' + (e?.message || e) });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const body: any = {
        ambiente: cfg.ambiente,
        enabled: cfg.enabled,
      };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      if (webhookSecret.trim()) body.webhookSecret = webhookSecret.trim();
      // recipientId — sempre envia (mesmo vazio) pra permitir limpar
      body.recipientId = recipientId.trim();

      const updated = await api<ConfigState>('/pagarme/config', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setCfg(updated);
      setApiKey('');
      setWebhookSecret('');
      setRecipientId('');
      setMsg({ kind: 'ok', text: 'Configuração salva ✓' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: 'Erro ao salvar: ' + (e?.message || e) });
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api<any>('/pagarme/test', { method: 'POST' });
      setTestResult(r);
    } catch (e: any) {
      setTestResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-rose-50 p-6 flex items-center justify-center">
        <div className="text-rose-700">Carregando…</div>
      </div>
    );
  }

  const isReady = cfg.hasApiKey && cfg.enabled;

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-teal-50 to-cyan-50 p-4 md:p-6">
      <div className="max-w-3xl mx-auto">
        <Link
          href="/retaguarda"
          className="inline-flex items-center gap-2 text-emerald-700 hover:text-emerald-900 mb-4"
        >
          <ArrowLeft size={18} /> Voltar
        </Link>

        <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-black bg-gradient-to-r from-emerald-700 to-teal-600 bg-clip-text text-transparent">
              Pagar.me — PIX
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Integração com Pagar.me API v5. PIX dinâmico funciona em produção sem homologação prévia.
            </p>
          </div>
          <StatusBadge enabled={cfg.enabled} ready={isReady} ambiente={cfg.detectedFromKey || cfg.ambiente} />
        </div>

        {msg && (
          <div
            className={`mb-4 rounded-lg p-3 text-sm font-medium ${
              msg.kind === 'ok'
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-red-100 text-red-800'
            }`}
          >
            {msg.text}
          </div>
        )}

        <div className="space-y-5">
          {/* AMBIENTE */}
          <Card title="Ambiente" subtitle="Detectado automaticamente pela API Key (sk_test_ = test, sk_ = live)">
            <div className="grid grid-cols-2 gap-3">
              <RadioBox
                checked={cfg.ambiente === 'test'}
                onChange={() => setCfg({ ...cfg, ambiente: 'test' })}
                title="TEST"
                sub="Sandbox"
                color="amber"
              />
              <RadioBox
                checked={cfg.ambiente === 'live'}
                onChange={() => setCfg({ ...cfg, ambiente: 'live' })}
                title="LIVE"
                sub="Produção real"
                color="emerald"
              />
            </div>
            {cfg.detectedFromKey && cfg.detectedFromKey !== cfg.ambiente && (
              <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-xs text-amber-900">
                ⚠ A API Key salva é de <b>{cfg.detectedFromKey.toUpperCase()}</b>, mas você
                marcou <b>{cfg.ambiente.toUpperCase()}</b>. O ambiente real será detectado pela key.
              </div>
            )}
          </Card>

          {/* API KEY */}
          <Card
            title="API Key Pagar.me"
            subtitle="Dashboard Pagar.me → Desenvolvedores → Chaves. Formato: sk_test_xxx (sandbox) ou sk_xxx (live)"
          >
            <div className="mb-3">
              <div
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold ${
                  cfg.hasApiKey
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                {cfg.hasApiKey ? (
                  <>
                    <CheckCircle2 size={14} /> Key cadastrada
                    {cfg.detectedFromKey && (
                      <span className="text-[10px] uppercase ml-1">
                        ({cfg.detectedFromKey})
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <Lock size={14} /> Nenhuma key
                  </>
                )}
              </div>
            </div>

            <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
              {cfg.hasApiKey ? 'Trocar API Key' : 'API Key'}
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={cfg.hasApiKey ? '(deixe vazio pra manter)' : 'sk_test_xxx ou sk_xxx'}
                className="w-full p-2.5 pr-10 border rounded-lg font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500"
              >
                {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </Card>

          {/* WEBHOOK SECRET */}
          <Card
            title="Webhook Secret (opcional)"
            subtitle="Gera no dashboard Pagar.me → Webhooks. Valida HMAC dos eventos recebidos."
          >
            <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
              {cfg.hasWebhookSecret ? 'Trocar webhook secret' : 'Webhook Secret'}
            </label>
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder={cfg.hasWebhookSecret ? '(deixe vazio pra manter)' : 'Secret HMAC'}
                className="w-full p-2.5 pr-10 border rounded-lg font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShowSecret((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500"
              >
                {showSecret ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </Card>

          {/* RECIPIENT ID — obrigatório pra contas PSP/marketplace */}
          <Card
            title="Recipient ID (split rule)"
            subtitle="OBRIGATÓRIO se sua conta Pagar.me é PSP/marketplace. Dashboard → Recebedores → copia o ID (rp_xxx ou ba_xxx). Sem isso a Pagar.me retorna 'failed' em todo charge."
          >
            <div className="mb-3">
              <div
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold ${
                  cfg.recipientId
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {cfg.recipientId ? (
                  <>
                    <CheckCircle2 size={14} /> Recipient cadastrado:{' '}
                    <code className="font-mono text-xs">{cfg.recipientId}</code>
                  </>
                ) : (
                  <>
                    <FileWarning size={14} /> Sem recipient (pode falhar se conta for PSP)
                  </>
                )}
              </div>
            </div>
            <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
              {cfg.recipientId ? 'Trocar Recipient ID' : 'Recipient ID'}
            </label>
            <input
              type="text"
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
              placeholder={cfg.recipientId ? '(deixe vazio pra manter)' : 'rp_xxx ou ba_xxx'}
              className="w-full p-2.5 border rounded-lg font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-2">
              💡 Pra limpar, digita um espaço e salva.
            </p>
          </Card>

          {/* WEBHOOK URL */}
          <Card title="URL do Webhook (cadastrar no Pagar.me)" subtitle="Dashboard Pagar.me → Webhooks → Novo. Eventos: order.paid, charge.paid, charge.payment_failed">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2">
              <code className="flex-1 text-sm font-mono text-emerald-900 break-all select-all">
                https://flowops-lite-production.up.railway.app/pagarme/webhook
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(
                    'https://flowops-lite-production.up.railway.app/pagarme/webhook',
                  );
                  setMsg({ kind: 'ok', text: 'URL copiada!' });
                  setTimeout(() => setMsg(null), 2000);
                }}
                className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white font-bold hover:bg-emerald-700"
              >
                Copiar
              </button>
            </div>
          </Card>

          {/* HABILITAR */}
          <Card title="Habilitar Pagar.me no PDV">
            <button
              onClick={() => setCfg({ ...cfg, enabled: !cfg.enabled })}
              className={`w-full p-4 rounded-xl border-2 flex items-center justify-between transition ${
                cfg.enabled
                  ? 'bg-emerald-50 border-emerald-400 text-emerald-900'
                  : 'bg-gray-50 border-gray-300 text-gray-700 hover:border-gray-400'
              }`}
            >
              <div className="flex items-center gap-3">
                <Power size={20} />
                <div className="text-left">
                  <div className="font-bold">
                    Pagar.me {cfg.enabled ? 'LIGADO' : 'DESLIGADO'}
                  </div>
                  <div className="text-xs opacity-70">
                    {cfg.enabled
                      ? 'PDV usa Pagar.me pra gerar PIX'
                      : 'PDV usa PIX local (modo fallback)'}
                  </div>
                </div>
              </div>
              <div
                className={`w-12 h-7 rounded-full p-1 transition ${
                  cfg.enabled ? 'bg-emerald-500' : 'bg-gray-300'
                }`}
              >
                <div
                  className={`w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    cfg.enabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </div>
            </button>
          </Card>

          {/* TESTAR */}
          <Card title="Testar conexão" subtitle="Faz uma chamada ao Pagar.me pra validar a API Key.">
            <button
              onClick={testConnection}
              disabled={testing || !cfg.hasApiKey}
              className="w-full p-3 rounded-xl bg-emerald-100 hover:bg-emerald-200 text-emerald-900 font-bold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {testing ? 'Testando…' : 'Testar conexão agora'}
            </button>

            {testResult && (
              <div
                className={`mt-3 rounded-lg p-3 text-sm ${
                  testResult.ok
                    ? 'bg-emerald-50 border border-emerald-300 text-emerald-900'
                    : 'bg-red-50 border border-red-300 text-red-900'
                }`}
              >
                <div className="font-bold mb-1">
                  {testResult.ok ? '✓ Conexão OK' : '✗ Falhou'}
                </div>
                {testResult.ambiente && (
                  <div className="text-xs">
                    Ambiente real: <b className="uppercase">{testResult.ambiente}</b>
                  </div>
                )}
                {testResult.httpStatus && (
                  <div className="text-xs">HTTP {testResult.httpStatus}</div>
                )}
                {testResult.error && (
                  <div className="text-xs mt-1">
                    <b>Erro:</b> {testResult.error}
                  </div>
                )}
                {testResult.hint && (
                  <div className="text-xs mt-1 italic">💡 {testResult.hint}</div>
                )}
                {testResult.ok && (
                  <div className="text-xs mt-1">
                    Pode usar PIX no PDV.
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* SAVE */}
          <div className="sticky bottom-3 bg-white shadow-lg rounded-2xl p-4 flex items-center justify-between gap-4">
            <div className="text-xs text-gray-600">
              {isReady ? (
                <span className="text-emerald-700 font-bold">
                  <CheckCircle2 size={14} className="inline mr-1" />
                  Pronto pra gerar PIX
                </span>
              ) : (
                <span className="text-amber-700 font-bold">
                  <FileWarning size={14} className="inline mr-1" />
                  {!cfg.hasApiKey ? 'Falta a API Key' : 'Falta habilitar'}
                </span>
              )}
            </div>
            <button
              onClick={save}
              disabled={saving}
              className="bg-gradient-to-br from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 disabled:opacity-50 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 shadow-md"
            >
              <Save size={18} />
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>

          {/* INSTRUÇÕES */}
          <div className="bg-white rounded-2xl shadow-sm p-5 mt-6 text-sm text-gray-700">
            <h3 className="font-bold text-emerald-900 mb-2">Como obter a API Key:</h3>
            <ol className="list-decimal pl-5 space-y-1.5">
              <li>Acessa <a href="https://dashboard.pagar.me" target="_blank" rel="noopener" className="text-emerald-700 underline">dashboard.pagar.me</a></li>
              <li>Menu <b>Desenvolvedores</b> → <b>Chaves de API</b></li>
              <li>Copia a <b>Chave Secreta</b>:
                <ul className="list-disc pl-5 mt-1">
                  <li><b>Sandbox</b>: começa com <code>sk_test_</code></li>
                  <li><b>Produção</b>: começa com <code>sk_</code> (sem test)</li>
                </ul>
              </li>
              <li>Cola aqui no campo "API Key" + Salvar + Testar</li>
              <li>Pra webhook: dashboard → <b>Webhooks</b> → criar com URL acima + eventos <code>order.paid</code> e <code>charge.paid</code></li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ enabled, ready, ambiente }: { enabled: boolean; ready: boolean; ambiente: string }) {
  if (!ready) {
    return (
      <div className="flex items-center gap-2 bg-gray-200 text-gray-800 px-3 py-1.5 rounded-full font-bold text-sm">
        <Lock size={14} /> NÃO CONFIGURADO
      </div>
    );
  }
  if (ambiente === 'live') {
    return (
      <div className="flex items-center gap-2 bg-emerald-100 text-emerald-800 px-3 py-1.5 rounded-full font-bold text-sm">
        <Unlock size={14} /> PRODUÇÃO (LIVE)
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 bg-amber-100 text-amber-800 px-3 py-1.5 rounded-full font-bold text-sm">
      <Unlock size={14} /> SANDBOX (TEST)
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <h2 className="text-lg font-bold text-emerald-900 mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mb-3">{subtitle}</p>}
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function RadioBox({ checked, onChange, title, sub, color }: { checked: boolean; onChange: () => void; title: string; sub: string; color: 'amber' | 'emerald' }) {
  const activeClass =
    color === 'amber'
      ? 'bg-amber-100 border-amber-400 text-amber-900'
      : 'bg-emerald-100 border-emerald-400 text-emerald-900';
  return (
    <button
      type="button"
      onClick={onChange}
      className={`p-3 rounded-xl border-2 text-left transition ${
        checked ? activeClass + ' shadow' : 'bg-white border-gray-200 text-gray-700 hover:border-gray-400'
      }`}
    >
      <div className="font-bold text-sm">{title}</div>
      <div className={`text-xs mt-1 ${checked ? '' : 'text-gray-500'}`}>{sub}</div>
    </button>
  );
}
