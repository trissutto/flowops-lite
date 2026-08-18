'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Gift, Loader2, Save, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';

type Config = {
  enabled: boolean;
  mode: 'progressive_percentage' | 'buy_4_pay_3';
  campaignCode: string;
  headline: string;
  tiers: Array<{ minPieces: number; discountPct: number }>;
  excludePromoItems: boolean;
  countMode: 'unique_sku' | 'unit';
  minCartValue: number | null;
  startsAt: string | null;
  endsAt: string | null;
  bannerText: string;
  blocksPixDiscount: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

const DEFAULT: Config = {
  enabled: false,
  mode: 'buy_4_pay_3',
  campaignCode: 'LEVE4PAGUE3',
  headline: 'Leve 4, Pague 3',
  tiers: [],
  excludePromoItems: false,
  countMode: 'unique_sku',
  minCartValue: null,
  startsAt: null,
  endsAt: null,
  bannerText: 'Leve 4, Pague 3 — a peça de menor valor é grátis',
  blocksPixDiscount: true,
  updatedAt: null,
  updatedBy: null,
};

export default function ProgressiveDiscountAdmin() {
  const [cfg, setCfg] = useState<Config>(DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    api<Config>('/admin/progressive-discount')
      .then((data) => setCfg({
        ...DEFAULT,
        ...data,
        mode: 'buy_4_pay_3',
        enabled: data.mode === 'buy_4_pay_3' && data.enabled,
      }))
      .catch((error) => setMsg({ type: 'err', text: error?.message || 'Erro ao carregar' }))
      .finally(() => setLoading(false));
  }, []);

  function changeEnabled(next: boolean) {
    if (next) {
      const confirmed = window.confirm(
        'Ligar a promoção Leve 4, Pague 3 para todo o site? A peça de menor valor ficará grátis e cupom/Pix adicional serão bloqueados.',
      );
      if (!confirmed) return;
    }
    setCfg((current) => ({ ...current, enabled: next }));
    setMsg({
      type: 'ok',
      text: next ? 'Pronto para ligar. Clique em Salvar alterações para confirmar.' : 'Pronto para desligar. Clique em Salvar alterações.',
    });
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const data = await api<Config>('/admin/progressive-discount', {
        method: 'POST',
        body: JSON.stringify({
          ...cfg,
          mode: 'buy_4_pay_3',
          excludePromoItems: false,
          countMode: 'unique_sku',
          blocksPixDiscount: true,
        }),
      });
      setCfg({ ...DEFAULT, ...data });
      setMsg({ type: 'ok', text: data.enabled ? 'Promoção ligada no site.' : 'Promoção desligada no site.' });
    } catch (error: any) {
      setMsg({ type: 'err', text: error?.message || 'Erro ao salvar' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-8"><Loader2 className="mx-auto h-5 w-5 animate-spin text-amber-700" /></div>;
  }

  return (
    <section className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5 sm:p-6">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="flex flex-1 items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-100"><Gift className="h-5 w-5 text-amber-700" /></div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Leve 4, Pague 3</h2>
            <p className="text-xs text-slate-500">Campanha única para todo o ecommerce</p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={cfg.enabled}
          onClick={() => changeEnabled(!cfg.enabled)}
          className={`flex min-h-12 items-center justify-between gap-4 rounded-xl border px-4 transition ${cfg.enabled ? 'border-emerald-300 bg-emerald-50' : 'border-slate-300 bg-white'}`}
        >
          <span className={`font-bold ${cfg.enabled ? 'text-emerald-700' : 'text-slate-600'}`}>{cfg.enabled ? 'LIGADO' : 'DESLIGADO'}</span>
          <span className={`relative h-6 w-11 rounded-full transition-colors ${cfg.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${cfg.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </span>
        </button>
      </header>

      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-2 text-sm font-bold text-slate-800"><ShieldCheck className="h-4 w-4 text-amber-700" /> Regras fixas da campanha</div>
        <ul className="mt-3 grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
          <li>• Quatro produtos diferentes</li>
          <li>• A peça de menor valor é grátis</li>
          <li>• Cores e tamanhos do mesmo produto contam uma vez</li>
          <li>• Produto em oferta participa pelo preço atual</li>
          <li>• Não acumula com cupom</li>
          <li>• Não acumula com 5% adicional no Pix</li>
          <li>• Máximo de uma peça grátis por pedido</li>
          <li>• Sem data final automática</li>
        </ul>
      </div>

      <div className="mt-5">
        <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-600">Mensagem da campanha</label>
        <input value={cfg.bannerText} maxLength={100} onChange={(event) => setCfg({ ...cfg, bannerText: event.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <p className="mt-1 text-[11px] text-slate-500">A home promocional permanece separada e não será exibida agora.</p>
      </div>

      <div className="mt-5 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
        Última alteração: {cfg.updatedAt ? new Date(cfg.updatedAt).toLocaleString('pt-BR') : 'ainda não registrada'}
        {cfg.updatedBy ? ` · ${cfg.updatedBy}` : ''}
      </div>

      {msg && (
        <div className={`mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${msg.type === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
          {msg.type === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}{msg.text}
        </div>
      )}

      <button type="button" onClick={save} disabled={saving} className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-amber-700 px-4 font-bold text-white transition hover:bg-amber-800 disabled:opacity-50">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {saving ? 'Salvando...' : 'Salvar alterações'}
      </button>
    </section>
  );
}
