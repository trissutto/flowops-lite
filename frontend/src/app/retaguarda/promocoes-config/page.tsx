'use client';

/**
 * /retaguarda/promocoes-config — admin configura as promoções do PDV.
 *
 * Lê e grava em /admin/promo-config (AppConfig do Postgres).
 * Mudanças têm efeito IMEDIATO no PDV (próxima venda / recálculo).
 *
 * As promoções em si (50% liquida-antigos e 4 leva 3) continuam no código
 * do PdvService; aqui ficam só os ajustes que a matriz controla.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ArrowLeft, Save, RefreshCcw, AlertCircle, Check, Percent, Tag } from 'lucide-react';

interface PromoConfig {
  /** 50% (YEAR_BASED): não aplicar o desconto nas peças BÁSICO. */
  excluirBasicoNa50: boolean;
}

const PADRAO: PromoConfig = {
  excluirBasicoNa50: true,
};

export default function PromocoesConfigPage() {
  const [cfg, setCfg] = useState<PromoConfig>(PADRAO);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api<PromoConfig>('/admin/promo-config');
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
      const r = await api<PromoConfig>('/admin/promo-config', {
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

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center text-xl">
            🏷️
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-slate-800">Promoções do PDV</h1>
            <p className="text-xs text-slate-500">Configuração das campanhas — mudanças têm efeito imediato</p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4 space-y-4">
        {loading ? (
          <div className="bg-white rounded-xl p-8 text-center text-slate-400">Carregando…</div>
        ) : (
          <>
            {/* Promoção 50% (YEAR_BASED) */}
            <section className="bg-white rounded-2xl border-2 border-amber-200 overflow-hidden">
              <div className="bg-amber-50 px-4 py-3 flex items-center gap-2 border-b border-amber-200">
                <Percent className="w-5 h-5 text-amber-600" />
                <div>
                  <div className="font-bold text-slate-800">Promoção 50% (liquida antigos)</div>
                  <div className="text-xs text-slate-500">
                    Peças cadastradas até 31/12/2023 saem com 50% de desconto.
                  </div>
                </div>
              </div>

              <div className="p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cfg.excluirBasicoNa50}
                    onChange={(e) => setCfg({ ...cfg, excluirBasicoNa50: e.target.checked })}
                    className="w-6 h-6 accent-amber-600 mt-0.5"
                  />
                  <div>
                    <div className="font-bold text-slate-800">
                      Não aplicar 50% nas peças <span className="text-amber-700">BÁSICO</span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Quando ligado, peças classificadas como <b>Básico</b> ficam fora da promoção
                      e saem por preço cheio — mesmo sendo antigas. A classificação Básico/Moda é
                      feita na tela <b>Produtos Loja → Classificação</b>.
                    </div>
                  </div>
                </label>

                <div className="mt-3 flex items-start gap-2 bg-slate-50 border border-slate-200 rounded p-2 text-xs text-slate-600">
                  <Tag className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                  <span>
                    {cfg.excluirBasicoNa50 ? (
                      <>No PDV, a peça básica antiga aparece com a etiqueta <b>“Básico · sem promo”</b> e preço cheio.</>
                    ) : (
                      <>Todas as peças antigas (Básico e Moda) recebem os 50%.</>
                    )}
                  </span>
                </div>
              </div>
            </section>

            {/* Promoção 4 leva 3 — informativo (sem ajustes por enquanto) */}
            <section className="bg-white rounded-2xl border border-slate-200 p-4">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-base">🛍️</div>
                <div>
                  <div className="font-bold text-slate-800">Promoção 4 leva 3</div>
                  <div className="text-xs text-slate-500">
                    Levando 4 ou mais peças, a de menor preço sai grátis. Sem ajustes configuráveis.
                  </div>
                </div>
              </div>
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
                className="flex-1 px-4 py-3 bg-amber-600 hover:bg-amber-700 text-white font-black rounded-xl flex items-center justify-center gap-2 disabled:opacity-50"
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
