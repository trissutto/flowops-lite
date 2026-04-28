'use client';

/**
 * /retaguarda/crediario-juros — admin
 *
 * Configuração de juros pra cobrança de parcelas atrasadas no fluxo
 * RECEBIMENTOS do PDV.
 *
 *  - diasCarencia: após quantos dias de atraso começa a correr juros
 *    (0 = juros desde o 1º dia)
 *  - taxaMensalPercent: % ao mês — calculado dia a dia (taxa/30)
 *  - enabled: liga/desliga cobrança
 *
 * Fórmula:
 *   diasAtraso = hoje - vencimento
 *   se diasAtraso > diasCarencia E enabled:
 *     juros = valorParcela × (taxaMensal / 30 / 100) × (diasAtraso - diasCarencia)
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Save, Power, Calculator, FileWarning, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';

type Config = {
  diasCarencia: number;
  taxaMensalPercent: number;
  enabled: boolean;
};

export default function CrediarioJurosConfigPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [cfg, setCfg] = useState<Config>({
    diasCarencia: 0,
    taxaMensalPercent: 0,
    enabled: false,
  });

  // Simulação ao vivo
  const [simValor, setSimValor] = useState('100,00');
  const [simDias, setSimDias] = useState('30');

  useEffect(() => {
    (async () => {
      try {
        const data = await api<Config>('/crediarios/baixa/config');
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
      const updated = await api<Config>('/crediarios/baixa/config', {
        method: 'POST',
        body: JSON.stringify(cfg),
      });
      setCfg(updated);
      setMsg({ kind: 'ok', text: 'Configuração salva ✓' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: 'Erro ao salvar: ' + (e?.message || e) });
    } finally {
      setSaving(false);
    }
  }

  // Cálculo da simulação
  const valorN = Number(simValor.replace(/\./g, '').replace(',', '.')) || 0;
  const diasN = Number(simDias) || 0;
  const diasComJuros = Math.max(0, diasN - cfg.diasCarencia);
  const jurosDia = (cfg.taxaMensalPercent / 30) / 100;
  const jurosCalc = cfg.enabled && diasN > cfg.diasCarencia
    ? Math.round(valorN * jurosDia * diasComJuros * 100) / 100
    : 0;
  const totalCalc = Math.round((valorN + jurosCalc) * 100) / 100;
  const brl = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (loading) {
    return (
      <div className="min-h-screen bg-rose-50 p-6 flex items-center justify-center">
        <div className="text-rose-700">Carregando…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-rose-50 to-pink-50 p-4 md:p-6">
      <div className="max-w-3xl mx-auto">
        <Link
          href="/retaguarda"
          className="inline-flex items-center gap-2 text-amber-800 hover:text-amber-950 mb-4"
        >
          <ArrowLeft size={18} /> Voltar
        </Link>

        <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-black bg-gradient-to-r from-amber-700 to-rose-600 bg-clip-text text-transparent">
              Juros de Crediário
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Configuração aplicada na tela <b>RECEBIMENTOS</b> do PDV. Cobrança mensal calculada dia a dia.
            </p>
          </div>
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full font-bold text-sm ${
              cfg.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-700'
            }`}
          >
            <Power size={14} /> {cfg.enabled ? 'COBRANDO JUROS' : 'SEM COBRANÇA'}
          </div>
        </div>

        {msg && (
          <div
            className={`mb-4 rounded-lg p-3 text-sm font-medium ${
              msg.kind === 'ok' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
            }`}
          >
            {msg.text}
          </div>
        )}

        <div className="space-y-5">
          {/* TOGGLE GLOBAL */}
          <div className="bg-white rounded-2xl shadow-sm p-5">
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
                    Cobrar juros {cfg.enabled ? 'LIGADO' : 'DESLIGADO'}
                  </div>
                  <div className="text-xs opacity-70">
                    {cfg.enabled
                      ? 'PDV calcula juros automático nas parcelas atrasadas'
                      : 'PDV cobra só o valor da parcela (sem juros)'}
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
          </div>

          {/* CARÊNCIA */}
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <h2 className="text-lg font-bold text-amber-900 mb-1">Carência</h2>
            <p className="text-xs text-gray-500 mb-3">
              Após quantos dias de atraso começa a cobrar juros. <b>0</b> = juros desde o 1º dia.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={0}
                max={365}
                value={cfg.diasCarencia}
                onChange={(e) => setCfg({ ...cfg, diasCarencia: Math.max(0, Number(e.target.value || 0)) })}
                className="w-32 p-3 border-2 rounded-lg text-center text-2xl font-bold tabular-nums"
              />
              <span className="text-gray-700">dias de tolerância</span>
            </div>
          </div>

          {/* TAXA */}
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <h2 className="text-lg font-bold text-amber-900 mb-1">Taxa mensal</h2>
            <p className="text-xs text-gray-500 mb-3">
              Percentual ao mês. O sistema divide por 30 e cobra dia a dia. Ex: 8% ao mês = 0.267% ao dia.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="number"
                step={0.01}
                min={0}
                max={100}
                value={cfg.taxaMensalPercent}
                onChange={(e) => setCfg({ ...cfg, taxaMensalPercent: Math.max(0, Number(e.target.value || 0)) })}
                className="w-32 p-3 border-2 rounded-lg text-center text-2xl font-bold tabular-nums"
              />
              <span className="text-gray-700">% ao mês</span>
            </div>
            <div className="mt-2 text-xs text-gray-500">
              Ao dia: <b>{((cfg.taxaMensalPercent / 30) || 0).toFixed(4)}%</b>
            </div>
          </div>

          {/* SIMULADOR */}
          <div className="bg-white rounded-2xl shadow-sm p-5 border-2 border-amber-200">
            <h2 className="text-lg font-bold text-amber-900 mb-3 flex items-center gap-2">
              <Calculator size={18} /> Simulador
            </h2>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="text-xs font-bold uppercase text-gray-700">Valor parcela (R$)</label>
                <input
                  type="text"
                  value={simValor}
                  onChange={(e) => setSimValor(e.target.value)}
                  className="w-full p-2.5 border rounded-lg tabular-nums"
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-gray-700">Dias atraso</label>
                <input
                  type="number"
                  value={simDias}
                  onChange={(e) => setSimDias(e.target.value)}
                  className="w-full p-2.5 border rounded-lg tabular-nums"
                />
              </div>
            </div>
            <div className="bg-amber-50 rounded-lg p-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span>Valor original:</span>
                <b className="tabular-nums">R$ {brl(valorN)}</b>
              </div>
              <div className="flex justify-between">
                <span>Dias com juros:</span>
                <b className="tabular-nums">{diasComJuros}</b>
              </div>
              <div className="flex justify-between text-rose-700">
                <span>Juros calculado:</span>
                <b className="tabular-nums">R$ {brl(jurosCalc)}</b>
              </div>
              <div className="border-t border-amber-300 pt-1.5 flex justify-between text-lg">
                <span className="font-bold">TOTAL A PAGAR:</span>
                <b className="tabular-nums text-emerald-700">R$ {brl(totalCalc)}</b>
              </div>
            </div>
          </div>

          {/* SAVE */}
          <div className="sticky bottom-3 bg-white shadow-lg rounded-2xl p-4 flex items-center justify-between gap-4">
            <div className="text-xs text-gray-600">
              {cfg.enabled ? (
                <span className="text-emerald-700 font-bold">
                  <CheckCircle2 size={14} className="inline mr-1" />
                  Configuração ativa
                </span>
              ) : (
                <span className="text-amber-700 font-bold">
                  <FileWarning size={14} className="inline mr-1" />
                  Cobrança desligada
                </span>
              )}
            </div>
            <button
              onClick={save}
              disabled={saving}
              className="bg-gradient-to-br from-amber-500 to-rose-500 hover:from-amber-600 hover:to-rose-600 disabled:opacity-50 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 shadow-md"
            >
              <Save size={18} />
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
