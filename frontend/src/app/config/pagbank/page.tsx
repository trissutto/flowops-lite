'use client';

/**
 * /retaguarda/pagbank-config — admin
 *
 * Configura integração PagBank (PIX automático no PDV via Order API).
 *
 * Conta ÚNICA Lurd's (CNPJ matriz) → config global, não por loja.
 * Toda venda PIX no PDV cai na mesma conta — conciliação por loja é
 * feita via reference_id da Order que carrega storeCode.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Save, Lock, Unlock, FileWarning, CheckCircle2, Eye, EyeOff,
  Power, AlertTriangle,
} from 'lucide-react';
import { api } from '@/lib/api';

type ConfigState = {
  ambiente: 'sandbox' | 'production';
  email: string | null;
  enabled: boolean;
  hasToken: boolean;
  hasWebhookSecret: boolean;
};

export default function PagbankConfigPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [cfg, setCfg] = useState<ConfigState>({
    ambiente: 'sandbox',
    email: '',
    enabled: false,
    hasToken: false,
    hasWebhookSecret: false,
  });

  // Sensíveis: write-only
  const [bearerToken, setBearerToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  // Testar conexão
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseResult, setDiagnoseResult] = useState<any>(null);
  // PIX teste sandbox — evidência pra homologação Nathalia
  const [testingPix, setTestingPix] = useState(false);
  const [testPixResult, setTestPixResult] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  async function runTestPixSandbox() {
    setTestingPix(true);
    setTestPixResult(null);
    setCopied(false);
    try {
      const r = await api<any>('/pagbank/pix/test-sandbox', { method: 'POST' });
      setTestPixResult(r);
    } catch (e: any) {
      setTestPixResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setTestingPix(false);
    }
  }

  function copyEvidence() {
    if (!testPixResult) return;
    // Formato idêntico ao que a Nathalia enviou como exemplo
    // (Chamado 1360753759): "Request" + JSON, depois "RESPONSE" + JSON.
    const txt =
`Olá Nathalia, segue evidência de teste real em Sandbox conforme solicitado.

Chamado: 1360753759
Conta: matriz@lurds.com.br
Endpoint: ${testPixResult.request?.method} ${testPixResult.request?.url}
HTTP Status retornado: ${testPixResult.status}

Request
${JSON.stringify(testPixResult.request?.body, null, 4)}

RESPONSE
${JSON.stringify(testPixResult.response, null, 4)}

Atenciosamente,
Thiago Rissutto — Lurd's Plus Size`;
    navigator.clipboard.writeText(txt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    });
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api<any>('/pagbank/test', { method: 'POST' });
      setTestResult(r);
    } catch (e: any) {
      setTestResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function deepDiagnose() {
    setDiagnosing(true);
    setDiagnoseResult(null);
    try {
      const r = await api<any>('/pagbank/diagnose', { method: 'POST' });
      setDiagnoseResult(r);
    } catch (e: any) {
      setDiagnoseResult({ error: e?.message || String(e) });
    } finally {
      setDiagnosing(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const data = await api<ConfigState>('/pagbank/config');
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
        email: cfg.email || '',
        enabled: cfg.enabled,
      };
      if (bearerToken.trim()) body.bearerToken = bearerToken.trim();
      if (webhookSecret.trim()) body.webhookSecret = webhookSecret.trim();

      const updated = await api<ConfigState>('/pagbank/config', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setCfg(updated);
      setBearerToken('');
      setWebhookSecret('');
      setMsg({ kind: 'ok', text: 'Configuração salva ✓' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: 'Erro ao salvar: ' + (e?.message || e) });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-rose-50 p-6 flex items-center justify-center">
        <div className="text-rose-700">Carregando…</div>
      </div>
    );
  }

  const isReady = cfg.hasToken && cfg.enabled;

  return (
    <div className="min-h-screen bg-gradient-to-br from-rose-50 via-pink-50 to-fuchsia-50 p-4 md:p-6">
      <div className="max-w-3xl mx-auto">
        <Link
          href="/retaguarda"
          className="inline-flex items-center gap-2 text-rose-700 hover:text-rose-900 mb-4"
        >
          <ArrowLeft size={18} /> Voltar
        </Link>

        <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-black bg-gradient-to-r from-rose-700 to-pink-600 bg-clip-text text-transparent">
              PagBank — PIX
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Integração com Order API (Bearer Token). PIX gerado pelo PDV cai direto na sua conta PagBank.
            </p>
          </div>
          <StatusBadge enabled={cfg.enabled} ready={isReady} ambiente={cfg.ambiente} />
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
          <Card title="Ambiente" subtitle="Comece em SANDBOX. Só vire produção depois de testar 5-10 PIX.">
            <div className="grid grid-cols-2 gap-3">
              <RadioBox
                checked={cfg.ambiente === 'sandbox'}
                onChange={() => setCfg({ ...cfg, ambiente: 'sandbox' })}
                title="SANDBOX"
                sub="Testes — QR fake"
                color="amber"
              />
              <RadioBox
                checked={cfg.ambiente === 'production'}
                onChange={() => setCfg({ ...cfg, ambiente: 'production' })}
                title="PRODUÇÃO"
                sub="PIX real cai conta"
                color="rose"
              />
            </div>
            {cfg.ambiente === 'production' && !cfg.hasToken && (
              <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-xs text-amber-900">
                <AlertTriangle size={12} className="inline mr-1" />
                Em produção você precisa de Bearer Token de produção (não o de sandbox).
              </div>
            )}
          </Card>

          {/* EMAIL CADASTRADO NO PAGBANK */}
          <Card
            title="E-mail cadastrado no PagBank"
            subtitle="Mesmo e-mail que aparece no portaldev.pagbank.com.br/tokens (ex: matriz@lurds.com.br)"
          >
            <input
              type="email"
              value={cfg.email || ''}
              onChange={(e) => setCfg({ ...cfg, email: e.target.value })}
              placeholder="matriz@lurds.com.br"
              className="w-full p-2.5 border-2 border-rose-200 rounded-lg focus:border-rose-400 focus:outline-none"
            />
          </Card>

          {/* BEARER TOKEN */}
          <Card
            title="Bearer Token"
            subtitle="Token UUID gerado em portaldev.pagbank.com.br → Tokens. Formato: 8-4-4-4-12 caracteres hex (ex: b803a327-7ec9-...)"
          >
            <div className="mb-3">
              <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
                Status
              </label>
              <div
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold ${
                  cfg.hasToken
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                {cfg.hasToken ? (
                  <>
                    <CheckCircle2 size={14} /> Token cadastrado
                  </>
                ) : (
                  <>
                    <Lock size={14} /> Nenhum token
                  </>
                )}
              </div>
            </div>

            <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
              {cfg.hasToken ? 'Trocar token' : 'Bearer Token'}
            </label>
            <div className="relative">
              <textarea
                value={bearerToken}
                onChange={(e) => setBearerToken(e.target.value)}
                placeholder={cfg.hasToken ? '(deixe vazio pra manter o atual)' : 'Cola o Bearer Token aqui'}
                rows={3}
                className="w-full p-2.5 pr-10 border rounded-lg font-mono text-xs"
                style={
                  showToken
                    ? undefined
                    : ({ WebkitTextSecurity: 'disc' } as React.CSSProperties)
                }
              />
              <button
                type="button"
                onClick={() => setShowToken((s) => !s)}
                className="absolute right-2 top-2 text-gray-500"
              >
                {showToken ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Token salvo criptografado. NUNCA é exibido depois de salvo.
            </p>
          </Card>

          {/* WEBHOOK SECRET */}
          <Card
            title="Webhook Secret (opcional)"
            subtitle="Pra validar HMAC dos webhooks recebidos. Se vazio, aceita qualquer chamada (não recomendado em produção)."
          >
            <div className="mb-3">
              <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
                Status
              </label>
              <div
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold ${
                  cfg.hasWebhookSecret
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                {cfg.hasWebhookSecret ? (
                  <>
                    <CheckCircle2 size={14} /> Secret configurado
                  </>
                ) : (
                  <>
                    <Lock size={14} /> Nenhum secret
                  </>
                )}
              </div>
            </div>

            <label className="block text-xs font-bold text-gray-700 mb-1 uppercase">
              {cfg.hasWebhookSecret ? 'Trocar webhook secret' : 'Webhook Secret'}
            </label>
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder={cfg.hasWebhookSecret ? '(deixe vazio pra manter o atual)' : 'Secret HMAC'}
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

          {/* WEBHOOK URL */}
          <Card
            title="URL do Webhook (cadastrar no PagBank)"
            subtitle="Cole esta URL no PagBank: minhaconta.pagbank.com.br → Notificação de transação"
          >
            <div className="bg-rose-50 border border-rose-200 rounded-lg p-3">
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm font-mono text-rose-900 break-all select-all">
                  https://flowops-lite-production.up.railway.app/pagbank/webhook
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(
                      'https://flowops-lite-production.up.railway.app/pagbank/webhook',
                    );
                    setMsg({ kind: 'ok', text: 'URL copiada!' });
                    setTimeout(() => setMsg(null), 2000);
                  }}
                  className="text-xs px-3 py-1.5 rounded bg-rose-600 text-white font-bold hover:bg-rose-700"
                >
                  Copiar
                </button>
              </div>
            </div>
          </Card>

          {/* HABILITAR */}
          <Card
            title="Habilitar PagBank no PDV"
            subtitle="Quando ligado, o botão PIX no PDV gera QR via PagBank. Quando desligado, fallback no modo PIX local."
          >
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
                    PagBank {cfg.enabled ? 'LIGADO' : 'DESLIGADO'}
                  </div>
                  <div className="text-xs opacity-70">
                    {cfg.enabled
                      ? 'PDV usa PagBank pra gerar PIX'
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

          {/* TESTAR CONEXÃO */}
          <Card title="Testar conexão" subtitle="Faz uma chamada ao PagBank pra validar token + ambiente.">
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={testConnection}
                disabled={testing || !cfg.hasToken}
                className="p-3 rounded-xl bg-rose-100 hover:bg-rose-200 text-rose-900 font-bold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {testing ? 'Testando…' : 'Teste rápido'}
              </button>
              <button
                onClick={deepDiagnose}
                disabled={diagnosing || !cfg.hasToken}
                className="p-3 rounded-xl bg-amber-100 hover:bg-amber-200 text-amber-900 font-bold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {diagnosing ? 'Diagnosticando…' : 'Diagnóstico amplo'}
              </button>
            </div>

            {diagnoseResult && (
              <div className="mt-3 bg-slate-50 border border-slate-300 rounded-lg p-3 text-xs space-y-2">
                {diagnoseResult.error ? (
                  <div className="text-red-600">{diagnoseResult.error}</div>
                ) : (
                  <>
                    <div>
                      <b>Token:</b> {diagnoseResult.token?.format} ({diagnoseResult.token?.length} chars)
                    </div>
                    <div>
                      <b>Ambiente:</b> {diagnoseResult.ambiente}
                    </div>
                    <div>
                      <b>Email:</b> {diagnoseResult.email || '(não cadastrado)'}
                    </div>
                    <div className="border-t border-slate-300 pt-2">
                      <b>Endpoints testados:</b>
                    </div>
                    {diagnoseResult.endpoints?.map((e: any, i: number) => (
                      <div
                        key={i}
                        className={`p-2 rounded font-mono ${
                          e.ok ? 'bg-emerald-100' : 'bg-red-50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold">{e.name}</span>
                          <span>
                            {e.ok ? '✓' : '✗'} HTTP {e.status}
                          </span>
                        </div>
                        <div className="opacity-70 break-all mt-0.5">
                          {e.method} {e.url}
                        </div>
                        {e.response && (
                          <div className="opacity-60 mt-1 break-all">{e.response}</div>
                        )}
                      </div>
                    ))}
                    <div className="bg-rose-100 border-2 border-rose-300 p-2 rounded text-rose-900 font-bold">
                      💡 {diagnoseResult.recommendation}
                    </div>
                  </>
                )}
              </div>
            )}

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
                    Ambiente: <b className="uppercase">{testResult.ambiente}</b>
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
                    Token autenticado. Pode usar PIX no PDV.
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* EVIDÊNCIA SANDBOX — homologação PagBank (Chamado 1360753759) */}
          <Card
            title="Gerar evidência sandbox"
            subtitle="Cria PIX REAL de R$ 1,00 em sandbox → captura Request + Response pra enviar pra Nathalia (Chamado 1360753759)."
          >
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-xs text-amber-900 mb-3">
              <b>Pré-requisito:</b> ambiente precisa estar em <b>SANDBOX</b> com token sandbox salvo + integração LIGADA.
              Só funciona se cfg.ambiente = sandbox.
            </div>
            <button
              onClick={runTestPixSandbox}
              disabled={testingPix || !cfg.hasToken || cfg.ambiente !== 'sandbox' || !cfg.enabled}
              className="w-full p-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {testingPix ? 'Gerando…' : '🔧 Gerar PIX real (R$ 1,00) em sandbox'}
            </button>

            {testPixResult && (
              <div className="mt-3 space-y-2">
                <div
                  className={`rounded-lg p-3 text-sm ${
                    testPixResult.ok
                      ? 'bg-emerald-50 border border-emerald-300 text-emerald-900'
                      : 'bg-red-50 border border-red-300 text-red-900'
                  }`}
                >
                  <div className="font-bold mb-1 flex items-center justify-between">
                    <span>
                      {testPixResult.ok ? '✓ PIX gerado' : '✗ Falhou'} — HTTP {testPixResult.status}
                    </span>
                    {testPixResult.pagbankOrderId && (
                      <span className="text-[10px] font-mono opacity-70">{testPixResult.pagbankOrderId}</span>
                    )}
                  </div>
                  {testPixResult.error && (
                    <div className="text-xs mt-1"><b>Erro:</b> {testPixResult.error}</div>
                  )}
                  {testPixResult.hint && (
                    <div className="text-xs mt-1 italic">💡 {testPixResult.hint}</div>
                  )}
                  {testPixResult.qrCodeText && (
                    <div className="mt-2 text-[10px] font-mono break-all bg-white border border-emerald-200 rounded p-2">
                      <b>QR Code copia-e-cola:</b><br />{testPixResult.qrCodeText}
                    </div>
                  )}
                </div>

                <button
                  onClick={copyEvidence}
                  className="w-full p-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm"
                >
                  {copied ? '✓ Copiado!' : '📋 Copiar evidência completa pra Nathalia'}
                </button>

                <details className="bg-slate-900 text-slate-100 rounded-lg overflow-hidden">
                  <summary className="px-3 py-2 cursor-pointer font-mono text-xs hover:bg-slate-800">
                    📥 Request (clique pra expandir)
                  </summary>
                  <pre className="text-[10px] overflow-x-auto p-3 max-h-80">{JSON.stringify(testPixResult.request, null, 2)}</pre>
                </details>

                <details className="bg-slate-900 text-slate-100 rounded-lg overflow-hidden" open>
                  <summary className="px-3 py-2 cursor-pointer font-mono text-xs hover:bg-slate-800">
                    📤 Response (HTTP {testPixResult.status})
                  </summary>
                  <pre className="text-[10px] overflow-x-auto p-3 max-h-80">{JSON.stringify(testPixResult.response, null, 2)}</pre>
                </details>
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
                  {!cfg.hasToken ? 'Falta o Bearer Token' : 'Falta habilitar'}
                </span>
              )}
            </div>
            <button
              onClick={save}
              disabled={saving}
              className="bg-gradient-to-br from-rose-500 to-pink-600 hover:from-rose-600 hover:to-pink-700 disabled:opacity-50 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 shadow-md"
            >
              <Save size={18} />
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>

          {/* INSTRUÇÕES */}
          <div className="bg-white rounded-2xl shadow-sm p-5 mt-6 text-sm text-gray-700">
            <h3 className="font-bold text-rose-900 mb-2">Roteiro pra primeiro teste:</h3>
            <ol className="list-decimal pl-5 space-y-1.5">
              <li>Marca <b>SANDBOX</b> + cola o Bearer Token de sandbox + clica <b>LIGAR</b> + Salvar</li>
              <li>Clica em <b>Gerar PIX real (R$ 1,00) em sandbox</b> acima → copia evidência → manda pra Nathalia</li>
              <li>Quando Nathalia liberar PROD, troca pra <b>PRODUÇÃO</b> com Bearer Token de produção</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Subcomponentes ────────────────────────────────────────────────────

function StatusBadge({ enabled, ready, ambiente }: { enabled: boolean; ready: boolean; ambiente: string }) {
  if (!ready) {
    return (
      <div className="flex items-center gap-2 bg-gray-200 text-gray-800 px-3 py-1.5 rounded-full font-bold text-sm">
        <Lock size={14} /> NÃO CONFIGURADO
      </div>
    );
  }
  if (ambiente === 'production') {
    return (
      <div className="flex items-center gap-2 bg-emerald-100 text-emerald-800 px-3 py-1.5 rounded-full font-bold text-sm">
        <Unlock size={14} /> PRODUÇÃO
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 bg-amber-100 text-amber-800 px-3 py-1.5 rounded-full font-bold text-sm">
      <Unlock size={14} /> SANDBOX
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <h2 className="text-lg font-bold text-rose-900 mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mb-3">{subtitle}</p>}
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function RadioBox({ checked, onChange, title, sub, color }: { checked: boolean; onChange: () => void; title: string; sub: string; color: 'amber' | 'rose' }) {
  const activeClass =
    color === 'amber'
      ? 'bg-amber-100 border-amber-400 text-amber-900'
      : 'bg-rose-100 border-rose-400 text-rose-900';
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
