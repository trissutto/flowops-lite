'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, Plus, Trash2, Save, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

type Tier = { minPieces: number; discountPct: number };
type Config = {
  enabled: boolean;
  tiers: Tier[];
  excludePromoItems: boolean;
  countMode: 'unique_sku' | 'unit';
  minCartValue: number | null;
  startsAt: string | null;
  endsAt: string | null;
  bannerText: string;
  blocksPixDiscount: boolean;
};

const DEFAULT: Config = {
  enabled: false,
  tiers: [
    { minPieces: 2, discountPct: 10 },
    { minPieces: 3, discountPct: 15 },
    { minPieces: 4, discountPct: 20 },
    { minPieces: 5, discountPct: 25 },
  ],
  excludePromoItems: true,
  countMode: 'unique_sku',
  minCartValue: null,
  startsAt: null,
  endsAt: null,
  bannerText: '🎉 LEVA MAIS, PAGA MENOS — até 25% OFF no app',
  blocksPixDiscount: true,
};

/**
 * Painel admin do Desconto Progressivo (campanha do app).
 * Gerencia tiers, vigência, regras de acumulação e banner home.
 */
export default function ProgressiveDiscountAdmin() {
  const [cfg, setCfg] = useState<Config>(DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await api<Config>('/admin/progressive-discount');
        setCfg({ ...DEFAULT, ...data });
      } catch (e: any) {
        setMsg({ type: 'err', text: e?.message || 'Erro ao carregar' });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const data = await api<Config>('/admin/progressive-discount', {
        method: 'POST',
        body: JSON.stringify(cfg),
      });
      setCfg({ ...DEFAULT, ...data });
      setMsg({ type: 'ok', text: 'Configuração salva!' });
      setTimeout(() => setMsg(null), 3000);
    } catch (e: any) {
      setMsg({ type: 'err', text: e?.message || 'Erro ao salvar' });
    } finally {
      setSaving(false);
    }
  };

  const addTier = () => {
    const last = cfg.tiers[cfg.tiers.length - 1];
    setCfg({
      ...cfg,
      tiers: [...cfg.tiers, { minPieces: (last?.minPieces || 1) + 1, discountPct: (last?.discountPct || 0) + 5 }],
    });
  };

  const updateTier = (idx: number, patch: Partial<Tier>) => {
    const tiers = [...cfg.tiers];
    tiers[idx] = { ...tiers[idx], ...patch };
    setCfg({ ...cfg, tiers });
  };

  const removeTier = (idx: number) => {
    setCfg({ ...cfg, tiers: cfg.tiers.filter((_, i) => i !== idx) });
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin mx-auto" />
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5">
      <header className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
          <TrendingUp className="w-5 h-5 text-amber-700" />
        </div>
        <div className="flex-1">
          <h2 className="font-bold text-lg text-slate-900">Desconto Progressivo (App)</h2>
          <p className="text-xs text-slate-500">Cliente ganha mais % conforme adiciona peças variadas no carrinho</p>
        </div>
        {/* Toggle on/off */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-slate-300 peer-checked:bg-emerald-500 rounded-full relative transition-colors">
            <span className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform peer-checked:translate-x-5" />
          </div>
          <span className={`text-sm font-bold ${cfg.enabled ? 'text-emerald-700' : 'text-slate-500'}`}>
            {cfg.enabled ? 'LIGADO' : 'DESLIGADO'}
          </span>
        </label>
      </header>

      {/* Tiers */}
      <div className="mb-5">
        <label className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-2 block">
          Faixas de desconto
        </label>
        <div className="space-y-2">
          {cfg.tiers.map((t, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-5">
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={1}
                    value={t.minPieces}
                    onChange={(e) => updateTier(idx, { minPieces: Math.max(1, +e.target.value) })}
                    className="w-16 px-2 py-1.5 rounded-lg border border-slate-300 text-center font-bold"
                  />
                  <span className="text-sm text-slate-600">peças ou mais</span>
                </div>
              </div>
              <div className="col-span-5">
                <div className="flex items-center gap-1">
                  <span className="text-slate-600 text-sm">=</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={t.discountPct}
                    onChange={(e) => updateTier(idx, { discountPct: Math.min(100, Math.max(1, +e.target.value)) })}
                    className="w-16 px-2 py-1.5 rounded-lg border border-slate-300 text-center font-bold text-amber-700"
                  />
                  <span className="text-sm text-slate-600">% OFF</span>
                </div>
              </div>
              <div className="col-span-2 text-right">
                <button
                  onClick={() => removeTier(idx)}
                  className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg"
                  aria-label="Remover faixa"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
        <button
          onClick={addTier}
          className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-amber-700 hover:bg-amber-100 px-2 py-1 rounded-lg"
        >
          <Plus className="w-3.5 h-3.5" /> Adicionar faixa
        </button>
      </div>

      {/* Regras */}
      <div className="mb-5 space-y-2.5 bg-white rounded-xl p-4 border border-slate-200">
        <label className="text-xs font-bold uppercase tracking-wider text-slate-600 block mb-1">
          Regras
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={cfg.countMode === 'unique_sku'}
            onChange={(e) => setCfg({ ...cfg, countMode: e.target.checked ? 'unique_sku' : 'unit' })}
            className="w-4 h-4 rounded text-amber-600"
          />
          <span className="text-sm">Contar peças variadas (SKU único, não unidades)</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={cfg.excludePromoItems}
            onChange={(e) => setCfg({ ...cfg, excludePromoItems: e.target.checked })}
            className="w-4 h-4 rounded text-amber-600"
          />
          <span className="text-sm">Excluir produtos já em promoção</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={cfg.blocksPixDiscount}
            onChange={(e) => setCfg({ ...cfg, blocksPixDiscount: e.target.checked })}
            className="w-4 h-4 rounded text-amber-600"
          />
          <span className="text-sm">Bloquear desconto PIX quando progressivo ativo</span>
        </label>
        <div className="flex items-center gap-2 text-sm pt-1">
          <span>Valor mínimo do carrinho:</span>
          <span>R$</span>
          <input
            type="number"
            min={0}
            value={cfg.minCartValue ?? ''}
            placeholder="opcional"
            onChange={(e) => setCfg({ ...cfg, minCartValue: e.target.value ? +e.target.value : null })}
            className="w-24 px-2 py-1 rounded-lg border border-slate-300 text-sm"
          />
        </div>
      </div>

      {/* Vigência */}
      <div className="mb-5 grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-1 block">
            Início
          </label>
          <input
            type="datetime-local"
            value={cfg.startsAt ? cfg.startsAt.slice(0, 16) : ''}
            onChange={(e) => setCfg({ ...cfg, startsAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
            className="w-full px-2 py-1.5 rounded-lg border border-slate-300 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-1 block">
            Fim (opcional)
          </label>
          <input
            type="datetime-local"
            value={cfg.endsAt ? cfg.endsAt.slice(0, 16) : ''}
            onChange={(e) => setCfg({ ...cfg, endsAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
            className="w-full px-2 py-1.5 rounded-lg border border-slate-300 text-sm"
          />
        </div>
      </div>

      {/* Banner home */}
      <div className="mb-5">
        <label className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-1 block">
          Texto do banner (home do app)
        </label>
        <input
          type="text"
          maxLength={80}
          value={cfg.bannerText}
          onChange={(e) => setCfg({ ...cfg, bannerText: e.target.value })}
          className="w-full px-3 py-2 rounded-lg border border-slate-300"
          placeholder="🎉 LEVA MAIS, PAGA MENOS"
        />
        <p className="text-[11px] text-slate-500 mt-1">Máx 80 caracteres. Use emoji.</p>
      </div>

      {/* Mensagem de salvamento */}
      {msg && (
        <div className={`mb-3 px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${
          msg.type === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'
        }`}>
          {msg.type === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {msg.text}
        </div>
      )}

      {/* Botão salvar */}
      <button
        onClick={save}
        disabled={saving}
        className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-xl transition disabled:opacity-50"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        {saving ? 'Salvando...' : 'Salvar configuração'}
      </button>
    </section>
  );
}
