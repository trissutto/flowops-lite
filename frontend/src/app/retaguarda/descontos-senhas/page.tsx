'use client';

/**
 * /retaguarda/descontos-senhas — matriz configura, num lugar só:
 *   1. As FAIXAS de desconto do PDV (% livre / % com senha de caixa).
 *   2. As SENHAS por nível de acesso (CAIXA, GERENTE, SUPERVISOR, MASTER, SUPREMA).
 *
 * Grava em /admin/access-policy (AppConfig no Postgres). Senhas são hasheadas no
 * banco — a tela nunca mostra a senha, só o status (Banco / Env / Não configurada)
 * e permite DEFINIR uma nova (write-only) ou LIMPAR (voltando pro valor do env).
 *
 * Efeito imediato: assim que salva, o backend passa a validar com as novas faixas
 * e senhas (sem redeploy).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  ArrowLeft, Save, RefreshCcw, AlertCircle, Check, Percent, KeyRound, ShieldCheck, Lock,
} from 'lucide-react';

type Level = 'CAIXA' | 'GERENTE' | 'SUPERVISOR' | 'MASTER' | 'SUPREMA';

interface LevelStatus {
  level: Level;
  inDb: boolean;
  inEnv: boolean;
}
interface PolicyStatus {
  freeUpToPct: number;
  caixaUpToPct: number;
  levels: LevelStatus[];
}

const LEVEL_INFO: Record<Level, { label: string; desc: string }> = {
  CAIXA:      { label: 'Caixa',      desc: 'Libera desconto na faixa do caixa' },
  GERENTE:    { label: 'Gerente',    desc: 'Libera desconto acima do limite + devoluções em dinheiro' },
  SUPERVISOR: { label: 'Supervisor', desc: 'Libera crediário acima do limite / conferência' },
  MASTER:     { label: 'Master',     desc: 'Ajustes de caixa, sangria/suprimento, estorno de venda' },
  SUPREMA:    { label: 'Suprema',    desc: 'Dono — passa em qualquer validação' },
};

export default function DescontosSenhasPage() {
  const [status, setStatus] = useState<PolicyStatus | null>(null);
  const [freeUpToPct, setFreeUpToPct] = useState(7);
  const [caixaUpToPct, setCaixaUpToPct] = useState(10);
  const [pwInputs, setPwInputs] = useState<Record<string, string>>({});
  const [toClear, setToClear] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api<PolicyStatus>('/admin/access-policy');
      setStatus(r);
      setFreeUpToPct(r.freeUpToPct);
      setCaixaUpToPct(r.caixaUpToPct);
      setPwInputs({});
      setToClear({});
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
      const passwords: Record<string, string> = {};
      for (const l of status?.levels || []) {
        if (toClear[l.level]) passwords[l.level] = '';
        else if ((pwInputs[l.level] || '').trim()) passwords[l.level] = pwInputs[l.level];
      }
      const body: any = { freeUpToPct: Number(freeUpToPct), caixaUpToPct: Number(caixaUpToPct) };
      if (Object.keys(passwords).length) body.passwords = passwords;
      const r = await api<PolicyStatus>('/admin/access-policy', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setStatus(r);
      setFreeUpToPct(r.freeUpToPct);
      setCaixaUpToPct(r.caixaUpToPct);
      setPwInputs({});
      setToClear({});
      setSavedAt(new Date());
      setTimeout(() => setSavedAt(null), 3000);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const statusBadge = (l: LevelStatus) => {
    if (toClear[l.level]) return <span className="text-[11px] font-semibold text-rose-600">→ será limpa (env)</span>;
    if ((pwInputs[l.level] || '').trim()) return <span className="text-[11px] font-semibold text-amber-600">→ nova senha</span>;
    if (l.inDb) return <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700"><ShieldCheck className="w-3.5 h-3.5" /> configurada (banco)</span>;
    if (l.inEnv) return <span className="text-[11px] font-semibold text-slate-500">usando env (Railway)</span>;
    return <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-500"><AlertCircle className="w-3.5 h-3.5" /> não configurada</span>;
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center text-xl">🔐</div>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-slate-800">Descontos &amp; Senhas</h1>
            <p className="text-xs text-slate-500">Faixas de desconto do PDV + senhas por nível — efeito imediato</p>
          </div>
          <button onClick={load} className="p-2 rounded-lg hover:bg-slate-100" title="Recarregar">
            <RefreshCcw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4 space-y-4">
        {err && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl p-8 text-center text-slate-400">Carregando…</div>
        ) : (
          <>
            {/* ── FAIXAS DE DESCONTO ── */}
            <section className="bg-white rounded-2xl border-2 border-amber-200 overflow-hidden">
              <div className="bg-amber-50 px-4 py-3 flex items-center gap-2 border-b border-amber-200">
                <Percent className="w-5 h-5 text-amber-600" />
                <div>
                  <div className="font-bold text-slate-800">Faixas de desconto (PDV)</div>
                  <div className="text-xs text-slate-500">Percentual sobre o preço cheio do item/venda</div>
                </div>
              </div>
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-xs font-semibold text-slate-600">Livre até (%) — sem senha</span>
                    <input
                      type="number" min={0} max={100} step={0.5}
                      value={freeUpToPct}
                      onChange={(e) => setFreeUpToPct(Number(e.target.value))}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-slate-600">Com senha de CAIXA até (%)</span>
                    <input
                      type="number" min={0} max={100} step={0.5}
                      value={caixaUpToPct}
                      onChange={(e) => setCaixaUpToPct(Number(e.target.value))}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
                    />
                  </label>
                </div>
                {/* Resumo dinâmico das 3 faixas */}
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700 space-y-1">
                  <div><b>0% – {freeUpToPct}%</b> → livre, sem senha</div>
                  <div><b>&gt; {freeUpToPct}% até {caixaUpToPct}%</b> → senha de <b>CAIXA</b></div>
                  <div><b>&gt; {caixaUpToPct}%</b> → senha de <b>GERENTE</b> + justificativa obrigatória</div>
                </div>
              </div>
            </section>

            {/* ── SENHAS POR NÍVEL ── */}
            <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="bg-slate-50 px-4 py-3 flex items-center gap-2 border-b border-slate-200">
                <KeyRound className="w-5 h-5 text-slate-500" />
                <div>
                  <div className="font-bold text-slate-800">Senhas por nível</div>
                  <div className="text-xs text-slate-500">Digite pra trocar. Em branco = mantém. Banco tem prioridade sobre o env.</div>
                </div>
              </div>
              <div className="divide-y divide-slate-100">
                {(status?.levels || []).map((l) => {
                  const cleared = !!toClear[l.level];
                  return (
                    <div key={l.level} className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                      <div className="sm:w-56 shrink-0">
                        <div className="flex items-center gap-2">
                          <Lock className="w-4 h-4 text-slate-400" />
                          <span className="font-bold text-slate-800">{LEVEL_INFO[l.level].label}</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">{LEVEL_INFO[l.level].desc}</div>
                        <div className="mt-1">{statusBadge(l)}</div>
                      </div>
                      <div className="flex-1 flex items-center gap-2">
                        <input
                          type="password"
                          autoComplete="new-password"
                          placeholder={cleared ? '(será limpa)' : 'Nova senha…'}
                          disabled={cleared}
                          value={pwInputs[l.level] || ''}
                          onChange={(e) => setPwInputs((s) => ({ ...s, [l.level]: e.target.value }))}
                          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none disabled:bg-slate-100"
                        />
                        {l.inDb && (
                          cleared ? (
                            <button
                              onClick={() => setToClear((s) => ({ ...s, [l.level]: false }))}
                              className="text-xs text-slate-500 hover:text-slate-700 px-2 py-2"
                            >desfazer</button>
                          ) : (
                            <button
                              onClick={() => { setToClear((s) => ({ ...s, [l.level]: true })); setPwInputs((s) => ({ ...s, [l.level]: '' })); }}
                              className="text-xs text-rose-600 hover:text-rose-700 px-2 py-2 whitespace-nowrap"
                              title="Remover a senha do banco e voltar a usar a do env (Railway)"
                            >usar env</button>
                          )
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 text-[11px] text-slate-500 flex items-start gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>Níveis são hierárquicos: uma senha de nível mais alto (ex.: Gerente) passa em validações de nível mais baixo (ex.: Caixa). As senhas ficam <b>hasheadas</b> no banco — não é possível recuperá-las, só redefinir.</span>
              </div>
            </section>

            {/* ── SALVAR ── */}
            <div className="flex items-center gap-3">
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white font-bold px-5 py-2.5 rounded-xl transition"
              >
                <Save className="w-4 h-4" /> {saving ? 'Salvando…' : 'Salvar'}
              </button>
              {savedAt && (
                <span className="inline-flex items-center gap-1 text-emerald-700 text-sm font-semibold">
                  <Check className="w-4 h-4" /> Salvo
                </span>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
