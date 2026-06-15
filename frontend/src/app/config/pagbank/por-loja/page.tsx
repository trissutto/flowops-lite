'use client';

/**
 * /config/pagbank/por-loja
 *
 * Config PagBank por loja. Cada loja com CNPJ proprio tem sua conta
 * PagBank e token independente. Quando o PDV cria um PIX, o backend
 * resolve:
 *   1. PagbankStoreConfig WHERE storeCode = X AND enabled
 *   2. fallback: PagbankConfig singleton (matriz)
 *
 * Tela mostra cards das 15 lojas. Cada card:
 *   - Badge verde "Configurada" se tem token proprio + enabled
 *   - Badge cinza "Usa matriz" se nao tem config (fallback singleton)
 *   - Botao "Configurar" abre modal de edicao
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Store as StoreIcon, Check, X, Loader2, Save, Trash2,
  Building2, AlertTriangle, Eye, EyeOff,
} from 'lucide-react';
import { api } from '@/lib/api';

type Store = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  expectedCnpj?: string | null;
  expectedRazaoSocial?: string | null;
};

type StoreConfig = {
  storeCode: string;
  ambiente: 'sandbox' | 'production';
  email: string | null;
  enabled: boolean;
  hasToken: boolean;
  hasWebhookSecret: boolean;
  contaLabel: string | null;
};

export default function PagbankPorLojaPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [configs, setConfigs] = useState<Record<string, StoreConfig>>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Store | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [storesRes, cfgsRes] = await Promise.all([
        api<Store[]>('/stores'),
        api<StoreConfig[]>('/pagbank/store-configs'),
      ]);
      setStores(storesRes.filter((s) => s.active).sort((a, b) => a.code.localeCompare(b.code)));
      const map: Record<string, StoreConfig> = {};
      for (const c of cfgsRes) map[c.storeCode] = c;
      setConfigs(map);
    } catch (e: any) {
      alert('Erro ao carregar: ' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <Link
          href="/config/pagbank"
          className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"
          title="Voltar pra config matriz"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shadow">
          <Building2 className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">PagBank por Loja</h1>
          <p className="text-sm text-slate-500">
            Cada loja com CNPJ proprio pode ter token PagBank independente. Sem config, usa a matriz.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-10 text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
          Carregando...
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {stores.map((store) => {
            const cfg = configs[store.code];
            const status: 'ok' | 'partial' | 'fallback' = cfg
              ? cfg.enabled && cfg.hasToken
                ? 'ok'
                : 'partial'
              : 'fallback';
            return (
              <div
                key={store.id}
                className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition cursor-pointer"
                onClick={() => setEditing(store)}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                      {store.code}
                    </span>
                    <StoreIcon className="w-4 h-4 text-slate-400" />
                  </div>
                  {status === 'ok' && (
                    <span className="text-xs font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded flex items-center gap-1">
                      <Check className="w-3 h-3" />
                      Propria
                    </span>
                  )}
                  {status === 'partial' && (
                    <span className="text-xs font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      Incompleta
                    </span>
                  )}
                  {status === 'fallback' && (
                    <span className="text-xs font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded">
                      Usa matriz
                    </span>
                  )}
                </div>
                <div className="font-bold text-slate-800 truncate">{store.name}</div>
                {cfg?.contaLabel && (
                  <div className="text-xs text-slate-500 mt-1 truncate">
                    Conta: <span className="font-semibold">{cfg.contaLabel}</span>
                  </div>
                )}
                {cfg && (
                  <div className="text-xs mt-2 flex gap-2 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded ${cfg.ambiente === 'production' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                      {cfg.ambiente}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded ${cfg.hasToken ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-500'}`}>
                      {cfg.hasToken ? 'Token ✓' : 'sem token'}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded ${cfg.hasWebhookSecret ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-500'}`}>
                      {cfg.hasWebhookSecret ? 'Secret ✓' : 'sem secret'}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <EditModal
          store={editing}
          currentCfg={configs[editing.code] || null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function EditModal({
  store,
  currentCfg,
  onClose,
  onSaved,
}: {
  store: Store;
  currentCfg: StoreConfig | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [ambiente, setAmbiente] = useState<'sandbox' | 'production'>(
    currentCfg?.ambiente || 'production',
  );
  const [email, setEmail] = useState(currentCfg?.email || '');
  const [contaLabel, setContaLabel] = useState(currentCfg?.contaLabel || '');
  const [bearerToken, setBearerToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [enabled, setEnabled] = useState(currentCfg?.enabled ?? true);
  const [showToken, setShowToken] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const body: any = { ambiente, email, contaLabel, enabled };
      if (bearerToken.trim()) body.bearerToken = bearerToken.trim();
      if (webhookSecret.trim()) body.webhookSecret = webhookSecret.trim();
      await api(`/pagbank/store-config/${store.code}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onSaved();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!window.confirm(`Remover config PagBank da loja ${store.code}? Loja volta a usar matriz.`)) return;
    setSaving(true);
    try {
      await api(`/pagbank/store-config/${store.code}/remove`, { method: 'POST' });
      onSaved();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white">
          <div>
            <h2 className="font-bold text-slate-800">
              PagBank — Loja {store.code}
            </h2>
            <p className="text-xs text-slate-500">{store.name}</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="font-bold text-sm">Loja usa PagBank PROPRIO (nao matriz)</span>
          </label>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Ambiente
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAmbiente('sandbox')}
                className={`flex-1 py-2 rounded-lg text-sm font-bold ${
                  ambiente === 'sandbox'
                    ? 'bg-amber-100 text-amber-800 border-2 border-amber-400'
                    : 'bg-slate-100 text-slate-500 border-2 border-transparent'
                }`}
              >
                Sandbox
              </button>
              <button
                type="button"
                onClick={() => setAmbiente('production')}
                className={`flex-1 py-2 rounded-lg text-sm font-bold ${
                  ambiente === 'production'
                    ? 'bg-red-100 text-red-800 border-2 border-red-400'
                    : 'bg-slate-100 text-slate-500 border-2 border-transparent'
                }`}
              >
                Producao
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Conta (label visual)
            </label>
            <input
              type="text"
              value={contaLabel}
              onChange={(e) => setContaLabel(e.target.value)}
              placeholder="Ex: T.O. RISSUTTO LTDA"
              className="w-full px-3 py-2 border rounded text-sm"
            />
            <p className="text-xs text-slate-400 mt-1">
              Ajuda lembrar qual conta esta vinculada a essa loja
            </p>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              E-mail PagBank
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="loja@dominio.com.br"
              className="w-full px-3 py-2 border rounded text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1 flex items-center justify-between">
              <span>
                Bearer Token {currentCfg?.hasToken && <span className="text-emerald-600">(ja cadastrado)</span>}
              </span>
              <button type="button" onClick={() => setShowToken(!showToken)}>
                {showToken ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </label>
            <input
              type={showToken ? 'text' : 'password'}
              value={bearerToken}
              onChange={(e) => setBearerToken(e.target.value)}
              placeholder={currentCfg?.hasToken ? 'Deixe vazio pra manter o atual' : 'Cola o token aqui'}
              className="w-full px-3 py-2 border rounded text-sm font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1 flex items-center justify-between">
              <span>
                Webhook Secret {currentCfg?.hasWebhookSecret && <span className="text-emerald-600">(ja cadastrado)</span>}
              </span>
              <button type="button" onClick={() => setShowSecret(!showSecret)}>
                {showSecret ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </label>
            <input
              type={showSecret ? 'text' : 'password'}
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={currentCfg?.hasWebhookSecret ? 'Deixe vazio pra manter o atual' : 'Opcional — secret HMAC'}
              className="w-full px-3 py-2 border rounded text-sm font-mono"
            />
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between sticky bottom-0 bg-white">
          {currentCfg ? (
            <button
              onClick={handleRemove}
              disabled={saving}
              className="text-xs text-red-600 hover:bg-red-50 px-3 py-2 rounded flex items-center gap-1 disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" />
              Remover (volta pra matriz)
            </button>
          ) : (
            <div />
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold px-5 py-2 rounded flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
