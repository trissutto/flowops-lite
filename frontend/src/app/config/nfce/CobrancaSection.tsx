'use client';

/**
 * Seção "Cobrança (PIX)" do painel por loja — renderizada na tela de config
 * NFC-e abaixo do formulário fiscal, pra a MESMA loja selecionada.
 *
 * Permite:
 *   - Escolher o provedor PIX da loja (auto | pagbank | pagarme)
 *   - Cadastrar credenciais PagBank por loja (cascata: loja → matriz)
 *   - Cadastrar credenciais Pagar.me por loja (cascata: loja → matriz)
 *
 * Endpoints (admin):
 *   GET/POST /stores/by-code/:code/pix-provider
 *   GET/POST /pagbank/store-config/:code  (+ /remove)
 *   GET/POST /pagarme/store-config/:code  (+ /remove)
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Save, Trash2, QrCode, CreditCard, Check, FlaskConical } from 'lucide-react';

type Provider = 'auto' | 'pagbank' | 'pagarme';

interface PagbankStore {
  ambiente: string;
  email: string | null;
  enabled: boolean;
  hasToken: boolean;
  hasWebhookSecret: boolean;
  contaLabel: string | null;
}
interface PagarmeStore {
  ambiente: string;
  enabled: boolean;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  recipientId: string | null;
  contaLabel: string | null;
  detectedFromKey?: string | null;
}

export default function CobrancaSection({ storeCode }: { storeCode: string }) {
  const [provider, setProvider] = useState<Provider>('auto');
  const [pb, setPb] = useState<PagbankStore | null>(null);
  const [pm, setPm] = useState<PagarmeStore | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // campos editáveis (sensíveis só enviam se preenchidos)
  const [pbForm, setPbForm] = useState({ ambiente: 'production', email: '', contaLabel: '', bearerToken: '', enabled: false });
  const [pmForm, setPmForm] = useState({ ambiente: 'live', recipientId: '', contaLabel: '', apiKey: '', enabled: false });
  const [savingPb, setSavingPb] = useState(false);
  const [savingPm, setSavingPm] = useState(false);
  const [savingProv, setSavingProv] = useState(false);
  const [testingPb, setTestingPb] = useState(false);
  const [testingPm, setTestingPm] = useState(false);
  const [pbTest, setPbTest] = useState<any>(null);
  const [pmTest, setPmTest] = useState<any>(null);

  const load = useCallback(async () => {
    if (!storeCode) return;
    setLoading(true);
    setMsg(null);
    try {
      const [prov, pbCfg, pmCfg] = await Promise.all([
        api<{ provider: Provider }>(`/stores/by-code/${storeCode}/pix-provider`).catch(() => ({ provider: 'auto' as Provider })),
        api<PagbankStore | null>(`/pagbank/store-config/${storeCode}`).catch(() => null),
        api<PagarmeStore | null>(`/pagarme/store-config/${storeCode}`).catch(() => null),
      ]);
      setProvider(prov?.provider || 'auto');
      setPb(pbCfg);
      setPm(pmCfg);
      setPbForm({
        ambiente: pbCfg?.ambiente || 'production',
        email: pbCfg?.email || '',
        contaLabel: pbCfg?.contaLabel || '',
        bearerToken: '',
        enabled: !!pbCfg?.enabled,
      });
      setPmForm({
        ambiente: pmCfg?.ambiente || 'live',
        recipientId: pmCfg?.recipientId || '',
        contaLabel: pmCfg?.contaLabel || '',
        apiKey: '',
        enabled: !!pmCfg?.enabled,
      });
    } catch (e: any) {
      setMsg({ kind: 'err', text: 'Falha ao carregar cobrança: ' + (e?.message || e) });
    } finally {
      setLoading(false);
    }
  }, [storeCode]);

  useEffect(() => { load(); }, [load]);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    if (kind === 'ok') setTimeout(() => setMsg(null), 3000);
  };

  async function saveProvider(p: Provider) {
    setProvider(p);
    setSavingProv(true);
    try {
      await api(`/stores/by-code/${storeCode}/pix-provider`, { method: 'POST', body: JSON.stringify({ provider: p }) });
      flash('ok', 'Provedor salvo.');
    } catch (e: any) {
      flash('err', 'Falha ao salvar provedor: ' + (e?.message || e));
    } finally {
      setSavingProv(false);
    }
  }

  async function savePagbank() {
    setSavingPb(true);
    try {
      const body: any = {
        ambiente: pbForm.ambiente,
        email: pbForm.email,
        contaLabel: pbForm.contaLabel,
        enabled: pbForm.enabled,
      };
      if (pbForm.bearerToken.trim()) body.bearerToken = pbForm.bearerToken.trim();
      await api(`/pagbank/store-config/${storeCode}`, { method: 'POST', body: JSON.stringify(body) });
      flash('ok', 'PagBank da loja salvo.');
      load();
    } catch (e: any) {
      flash('err', 'Falha ao salvar PagBank: ' + (e?.message || e));
    } finally {
      setSavingPb(false);
    }
  }

  async function savePagarme() {
    setSavingPm(true);
    try {
      const body: any = {
        ambiente: pmForm.ambiente,
        recipientId: pmForm.recipientId,
        contaLabel: pmForm.contaLabel,
        enabled: pmForm.enabled,
      };
      if (pmForm.apiKey.trim()) body.apiKey = pmForm.apiKey.trim();
      await api(`/pagarme/store-config/${storeCode}`, { method: 'POST', body: JSON.stringify(body) });
      flash('ok', 'Pagar.me da loja salvo.');
      load();
    } catch (e: any) {
      flash('err', 'Falha ao salvar Pagar.me: ' + (e?.message || e));
    } finally {
      setSavingPm(false);
    }
  }

  async function testStore(which: 'pagbank' | 'pagarme') {
    const setTesting = which === 'pagbank' ? setTestingPb : setTestingPm;
    const setResult = which === 'pagbank' ? setPbTest : setPmTest;
    setTesting(true);
    setResult(null);
    try {
      const r = await api<any>(`/${which}/store-config/${storeCode}/test`, { method: 'POST' });
      setResult(r);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setTesting(false);
    }
  }

  function TestResult({ r }: { r: any }) {
    if (!r) return null;
    return (
      <div className={`rounded-lg p-2 text-xs ${r.ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
        {r.ok ? (
          <span className="font-bold">✓ Credenciais OK (HTTP {r.httpStatus}) {r.source ? `· conta: ${r.source === 'store' ? 'própria' : 'matriz'}` : ''}</span>
        ) : (
          <>
            <span className="font-bold">✗ Falhou{r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}</span>
            <div>{r.error}</div>
            {r.hint && <div className="text-[11px] mt-0.5 opacity-80">💡 {r.hint}</div>}
          </>
        )}
      </div>
    );
  }

  async function removeStore(which: 'pagbank' | 'pagarme') {
    if (!confirm(`Remover a config ${which === 'pagbank' ? 'PagBank' : 'Pagar.me'} desta loja? Ela volta a usar a conta da matriz (global).`)) return;
    try {
      await api(`/${which}/store-config/${storeCode}/remove`, { method: 'POST' });
      flash('ok', 'Config removida — loja volta pra matriz.');
      load();
    } catch (e: any) {
      flash('err', 'Falha ao remover: ' + (e?.message || e));
    }
  }

  if (!storeCode) return null;

  const radio = (val: Provider, label: string, desc: string) => (
    <label className={`flex items-start gap-2 p-3 rounded-xl border-2 cursor-pointer ${provider === val ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200'}`}>
      <input type="radio" name="pixprov" checked={provider === val} onChange={() => saveProvider(val)} disabled={savingProv} className="mt-1 accent-indigo-600" />
      <span>
        <span className="font-bold text-slate-800 text-sm">{label}</span>
        <span className="block text-xs text-slate-500">{desc}</span>
      </span>
    </label>
  );

  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-4 mt-4 space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center">💳</div>
        <div>
          <h2 className="font-bold text-slate-800">Cobrança (PIX) — loja {storeCode}</h2>
          <p className="text-xs text-slate-500">Provedor + credenciais por loja. Sem config própria, usa a conta da matriz.</p>
        </div>
      </div>

      {loading ? (
        <div className="text-slate-400 text-sm py-4">Carregando…</div>
      ) : (
        <>
          {msg && (
            <div className={`rounded-lg p-2 text-sm font-semibold ${msg.kind === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
              {msg.text}
            </div>
          )}

          {/* Provedor */}
          <div>
            <div className="font-bold text-slate-700 text-sm mb-2">Provedor PIX desta loja</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {radio('auto', 'Automático', 'PagBank e, se falhar, Pagar.me')}
              {radio('pagbank', 'Só PagBank', 'Usa só a conta PagBank')}
              {radio('pagarme', 'Só Pagar.me', 'Usa só a conta Pagar.me')}
            </div>
          </div>

          {/* PagBank */}
          <div className="rounded-xl border border-slate-200 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <QrCode className="w-4 h-4 text-emerald-600" />
              <span className="font-bold text-slate-800 text-sm">PagBank</span>
              {pb ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">conta própria</span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">usa matriz</span>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-slate-600">Rótulo da conta
                <input value={pbForm.contaLabel} onChange={(e) => setPbForm({ ...pbForm, contaLabel: e.target.value })} placeholder="ex: Lurds Plus Size" className="w-full border-2 rounded px-2 py-1.5 mt-0.5" />
              </label>
              <label className="text-xs text-slate-600">Ambiente
                <select value={pbForm.ambiente} onChange={(e) => setPbForm({ ...pbForm, ambiente: e.target.value })} className="w-full border-2 rounded px-2 py-1.5 mt-0.5">
                  <option value="production">Produção</option>
                  <option value="sandbox">Sandbox</option>
                </select>
              </label>
              <label className="text-xs text-slate-600">E-mail
                <input value={pbForm.email} onChange={(e) => setPbForm({ ...pbForm, email: e.target.value })} className="w-full border-2 rounded px-2 py-1.5 mt-0.5" />
              </label>
              <label className="text-xs text-slate-600">Bearer Token {pb?.hasToken && <span className="text-emerald-600">✓ cadastrado</span>}
                <input type="password" value={pbForm.bearerToken} onChange={(e) => setPbForm({ ...pbForm, bearerToken: e.target.value })} placeholder={pb?.hasToken ? '(preencha pra trocar)' : 'cole o token'} className="w-full border-2 rounded px-2 py-1.5 mt-0.5" />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={pbForm.enabled} onChange={(e) => setPbForm({ ...pbForm, enabled: e.target.checked })} className="w-4 h-4 accent-emerald-600" />
              Habilitar PagBank nesta loja
            </label>
            <div className="flex gap-2">
              <button onClick={savePagbank} disabled={savingPb} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg flex items-center gap-1 disabled:opacity-50">
                <Save className="w-4 h-4" /> {savingPb ? 'Salvando…' : 'Salvar PagBank'}
              </button>
              <button onClick={() => testStore('pagbank')} disabled={testingPb} className="px-3 py-2 bg-slate-800 hover:bg-slate-900 text-white text-sm font-bold rounded-lg flex items-center gap-1 disabled:opacity-50">
                <FlaskConical className="w-4 h-4" /> {testingPb ? 'Testando…' : 'Testar'}
              </button>
              {pb && (
                <button onClick={() => removeStore('pagbank')} className="px-3 py-2 bg-slate-100 hover:bg-red-100 text-slate-600 hover:text-red-700 text-sm font-bold rounded-lg flex items-center gap-1">
                  <Trash2 className="w-4 h-4" /> Usar matriz
                </button>
              )}
            </div>
            <TestResult r={pbTest} />
          </div>

          {/* Pagar.me */}
          <div className="rounded-xl border border-slate-200 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-violet-600" />
              <span className="font-bold text-slate-800 text-sm">Pagar.me</span>
              {pm ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">conta própria</span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">usa matriz</span>
              )}
              {pm?.detectedFromKey && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">key: {pm.detectedFromKey}</span>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-slate-600">Rótulo da conta
                <input value={pmForm.contaLabel} onChange={(e) => setPmForm({ ...pmForm, contaLabel: e.target.value })} placeholder="ex: T.O Rissutto" className="w-full border-2 rounded px-2 py-1.5 mt-0.5" />
              </label>
              <label className="text-xs text-slate-600">Recipient ID (split)
                <input value={pmForm.recipientId} onChange={(e) => setPmForm({ ...pmForm, recipientId: e.target.value })} placeholder="rp_xxx ou ba_xxx (opcional)" className="w-full border-2 rounded px-2 py-1.5 mt-0.5" />
              </label>
              <label className="text-xs text-slate-600 sm:col-span-2">API Key {pm?.hasApiKey && <span className="text-emerald-600">✓ cadastrada</span>}
                <input type="password" value={pmForm.apiKey} onChange={(e) => setPmForm({ ...pmForm, apiKey: e.target.value })} placeholder={pm?.hasApiKey ? '(preencha pra trocar)' : 'sk_... (test ou live)'} className="w-full border-2 rounded px-2 py-1.5 mt-0.5" />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={pmForm.enabled} onChange={(e) => setPmForm({ ...pmForm, enabled: e.target.checked })} className="w-4 h-4 accent-violet-600" />
              Habilitar Pagar.me nesta loja
            </label>
            <div className="flex gap-2">
              <button onClick={savePagarme} disabled={savingPm} className="px-3 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold rounded-lg flex items-center gap-1 disabled:opacity-50">
                <Save className="w-4 h-4" /> {savingPm ? 'Salvando…' : 'Salvar Pagar.me'}
              </button>
              <button onClick={() => testStore('pagarme')} disabled={testingPm} className="px-3 py-2 bg-slate-800 hover:bg-slate-900 text-white text-sm font-bold rounded-lg flex items-center gap-1 disabled:opacity-50">
                <FlaskConical className="w-4 h-4" /> {testingPm ? 'Testando…' : 'Testar'}
              </button>
              {pm && (
                <button onClick={() => removeStore('pagarme')} className="px-3 py-2 bg-slate-100 hover:bg-red-100 text-slate-600 hover:text-red-700 text-sm font-bold rounded-lg flex items-center gap-1">
                  <Trash2 className="w-4 h-4" /> Usar matriz
                </button>
              )}
            </div>
            <TestResult r={pmTest} />
          </div>

          <p className="text-[11px] text-slate-400 flex items-center gap-1">
            <Check className="w-3 h-3" /> A chave PIX da conta certa é resolvida por loja na hora de cobrar. Sem config própria aqui, a loja usa a conta global (matriz).
          </p>
        </>
      )}
    </section>
  );
}
