'use client';

/**
 * /retaguarda/cashback-config — admin configura programa de cashback.
 *
 * Lê e grava em /admin/cashback-config (AppConfig do Postgres).
 * Mudanças têm efeito IMEDIATO no PDV (próxima venda).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ArrowLeft, Save, RefreshCcw, AlertCircle, Check } from 'lucide-react';

interface CashbackConfig {
  creditoPct: number;
  usoMaxPct: number;
  minimoUsoReais: number;
  validadeDias: number;
  tierMinimo: 'bronze' | 'prata' | 'ouro' | 'diamante';
  ativo: boolean;
}

const PADRAO: CashbackConfig = {
  creditoPct: 5,
  usoMaxPct: 30,
  minimoUsoReais: 20,
  validadeDias: 90,
  tierMinimo: 'bronze',
  ativo: true,
};

export default function CashbackConfigPage() {
  const [cfg, setCfg] = useState<CashbackConfig>(PADRAO);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api<CashbackConfig>('/admin/cashback-config');
      setCfg({ ...PADRAO, ...r });
    } catch (e: any) {
      setErr(e?.message || 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const r = await api<CashbackConfig>('/admin/cashback-config', {
        method: 'POST',
        body: JSON.stringify(cfg),
      });
      setCfg({ ...PADRAO, ...r });
      setSavedAt(new Date());
      setTimeout(() => setSavedAt(null), 3000);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  // Exemplos práticos pro user entender o impacto da config
  const exemploCompra = 100;
  const creditoEx = (exemploCompra * cfg.creditoPct) / 100;
  const usoMaxEx = (exemploCompra * cfg.usoMaxPct) / 100;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center text-xl">
            💰
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-slate-800">Configuração de Cashback</h1>
            <p className="text-xs text-slate-500">Programa de fidelidade — mudanças têm efeito imediato</p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4 space-y-4">
        {loading ? (
          <div className="bg-white rounded-xl p-8 text-center text-slate-400">Carregando…</div>
        ) : (
          <>
            {/* Ativo / Inativo */}
            <section className="bg-white rounded-2xl p-4 border-2 border-slate-200">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cfg.ativo}
                  onChange={(e) => setCfg({ ...cfg, ativo: e.target.checked })}
                  className="w-6 h-6 accent-emerald-600"
                />
                <div>
                  <div className="font-bold text-slate-800">
                    Programa {cfg.ativo ? 'ATIVO' : 'PAUSADO'}
                  </div>
                  <div className="text-xs text-slate-500">
                    Quando pausado, não credita nem deixa resgatar cashback. Saldo existente fica intocado.
                  </div>
                </div>
              </label>
            </section>

            {/* % Crédito */}
            <section className="bg-white rounded-2xl p-4 border border-slate-200 space-y-2">
              <label className="block">
                <div className="font-bold text-slate-800 mb-1">% de cashback por compra</div>
                <div className="text-xs text-slate-500 mb-2">
                  Quanto da venda volta como cashback pro cliente.
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={cfg.creditoPct}
                    onChange={(e) => setCfg({ ...cfg, creditoPct: Number(e.target.value) || 0 })}
                    className="w-24 border-2 rounded px-3 py-2 text-lg font-bold text-center"
                  />
                  <span className="text-2xl font-bold text-slate-600">%</span>
                </div>
              </label>
              <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-xs">
                💡 Em uma compra de <b>R$ {exemploCompra.toFixed(2)}</b>, cliente recebe{' '}
                <b className="text-emerald-700">R$ {creditoEx.toFixed(2)}</b> de cashback.
              </div>
            </section>

            {/* % Uso máximo */}
            <section className="bg-white rounded-2xl p-4 border border-slate-200 space-y-2">
              <label className="block">
                <div className="font-bold text-slate-800 mb-1">% máximo de uso por compra</div>
                <div className="text-xs text-slate-500 mb-2">
                  Cliente pode pagar até essa % da compra com cashback.
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    value={cfg.usoMaxPct}
                    onChange={(e) => setCfg({ ...cfg, usoMaxPct: Number(e.target.value) || 0 })}
                    className="w-24 border-2 rounded px-3 py-2 text-lg font-bold text-center"
                  />
                  <span className="text-2xl font-bold text-slate-600">%</span>
                </div>
              </label>
              <div className="bg-violet-50 border border-violet-200 rounded p-2 text-xs">
                💡 Em uma compra de <b>R$ {exemploCompra.toFixed(2)}</b>, cliente pode usar no máximo{' '}
                <b className="text-violet-700">R$ {usoMaxEx.toFixed(2)}</b> de cashback.
              </div>
            </section>

            {/* Saldo mínimo */}
            <section className="bg-white rounded-2xl p-4 border border-slate-200 space-y-2">
              <label className="block">
                <div className="font-bold text-slate-800 mb-1">Saldo mínimo pra usar</div>
                <div className="text-xs text-slate-500 mb-2">
                  Cliente só consegue resgatar quando saldo ≥ esse valor.
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold text-slate-600">R$</span>
                  <input
                    type="number"
                    min={0}
                    step={5}
                    value={cfg.minimoUsoReais}
                    onChange={(e) => setCfg({ ...cfg, minimoUsoReais: Number(e.target.value) || 0 })}
                    className="w-24 border-2 rounded px-3 py-2 text-lg font-bold text-center"
                  />
                </div>
              </label>
            </section>

            {/* Validade */}
            <section className="bg-white rounded-2xl p-4 border border-slate-200 space-y-2">
              <label className="block">
                <div className="font-bold text-slate-800 mb-1">Validade do cashback</div>
                <div className="text-xs text-slate-500 mb-2">
                  Cashback creditado expira após esse prazo.
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    step={15}
                    value={cfg.validadeDias}
                    onChange={(e) => setCfg({ ...cfg, validadeDias: Number(e.target.value) || 1 })}
                    className="w-24 border-2 rounded px-3 py-2 text-lg font-bold text-center"
                  />
                  <span className="text-base font-bold text-slate-600">dias</span>
                  <span className="text-xs text-slate-400 ml-2">
                    (~{(cfg.validadeDias / 30).toFixed(1)} meses)
                  </span>
                </div>
              </label>
            </section>

            {/* Tier mínimo */}
            <section className="bg-white rounded-2xl p-4 border border-slate-200 space-y-2">
              <label className="block">
                <div className="font-bold text-slate-800 mb-1">Tier mínimo pra ganhar cashback</div>
                <div className="text-xs text-slate-500 mb-2">
                  Só clientes nesse tier ou superior recebem cashback. <b>bronze</b> = todos.
                </div>
                <select
                  value={cfg.tierMinimo}
                  onChange={(e) => setCfg({ ...cfg, tierMinimo: e.target.value as any })}
                  className="w-full border-2 rounded px-3 py-2 text-base font-bold capitalize"
                >
                  <option value="bronze">🥉 Bronze (todos)</option>
                  <option value="prata">🥈 Prata e acima</option>
                  <option value="ouro">🥇 Ouro e acima</option>
                  <option value="diamante">💎 Só Diamante</option>
                </select>
              </label>
            </section>

            {/* Erros / status */}
            {err && (
              <div className="bg-red-50 border-2 border-red-300 rounded-xl p-3 flex items-start gap-2 text-sm">
                <AlertCircle className="w-5 h-5 text-red-600 mt-0.5" />
                <div>
                  <div className="font-bold text-red-800">Erro</div>
                  <div className="text-red-700">{err}</div>
                </div>
              </div>
            )}
            {savedAt && (
              <div className="bg-emerald-50 border-2 border-emerald-400 rounded-xl p-3 flex items-center gap-2 text-sm">
                <Check className="w-5 h-5 text-emerald-700" />
                <span className="font-bold text-emerald-800">
                  Salvo às {savedAt.toLocaleTimeString('pt-BR')} — efeito imediato no PDV.
                </span>
              </div>
            )}

            {/* Ações */}
            <div className="flex gap-2 sticky bottom-0 bg-slate-50 pt-2 pb-4">
              <button
                onClick={load}
                disabled={saving}
                className="px-4 py-3 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl flex items-center gap-2 disabled:opacity-50"
              >
                <RefreshCcw className="w-4 h-4" /> Recarregar
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex-1 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <Save className="w-5 h-5" />
                {saving ? 'Salvando...' : 'Salvar configuração'}
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
