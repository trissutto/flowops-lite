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
import { ArrowLeft, Save, Power, Calculator, FileWarning, CheckCircle2, Database, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

type Config = {
  diasCarencia: number;
  taxaMensalPercent: number;
  enabled: boolean;
  // Multa + teto de juros
  multaPercent: number;
  jurosMaxPercentParcela: number;
  // Limite de crédito (bloqueio no PDV)
  limiteEnabled: boolean;
  limiteMaxParcelasVencidas: number;
  limiteMaxValorEmAberto: number;
};

export default function CrediarioJurosConfigPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [cfg, setCfg] = useState<Config>({
    diasCarencia: 0,
    taxaMensalPercent: 0,
    enabled: false,
    multaPercent: 0,
    jurosMaxPercentParcela: 0,
    limiteEnabled: false,
    limiteMaxParcelasVencidas: 0,
    limiteMaxValorEmAberto: 0,
  });

  // Simulação ao vivo
  const [simValor, setSimValor] = useState('100,00');
  const [simDias, setSimDias] = useState('30');

  // Índice
  const [indexLoading, setIndexLoading] = useState(false);
  const [indexResult, setIndexResult] = useState<any>(null);

  async function createIndex() {
    if (!confirm('Criar índice composto na tabela `movimento` do Giga?\n\nFunciona como ONLINE em MySQL 5.6+ (sem travar). Em versões antigas, pode bloquear escrita por alguns minutos.\n\nRecomendado fora do horário comercial.')) return;
    setIndexLoading(true);
    setIndexResult(null);
    try {
      const r = await api<any>('/crediarios/baixa/admin/create-index-movimento', { method: 'POST' });
      setIndexResult(r);
    } catch (e: any) {
      setIndexResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setIndexLoading(false);
    }
  }

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
  // Espelha o backend calcJuros: juros diário + multa fixa, limitado pelo teto.
  let jurosCalc = 0;
  if (cfg.enabled && diasN > cfg.diasCarencia) {
    jurosCalc = valorN * jurosDia * diasComJuros;
    if (cfg.multaPercent > 0) jurosCalc += valorN * (cfg.multaPercent / 100);
    if (cfg.jurosMaxPercentParcela > 0) {
      const teto = valorN * (cfg.jurosMaxPercentParcela / 100);
      if (jurosCalc > teto) jurosCalc = teto;
    }
    jurosCalc = Math.round(jurosCalc * 100) / 100;
  }
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

          {/* MULTA + TETO */}
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <h2 className="text-lg font-bold text-amber-900 mb-1">Multa e teto de juros</h2>
            <p className="text-xs text-gray-500 mb-3">
              <b>Multa</b>: cobrada <b>uma única vez</b> quando a parcela entra em atraso (padrão BR: 2%).
              <b> Teto</b>: limita o total de juros+multa a uma % da parcela (evita juros maiores que a dívida). <b>0</b> = sem limite.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-bold uppercase text-gray-700">Multa (%)</label>
                <input
                  type="number"
                  step={0.5}
                  min={0}
                  max={100}
                  value={cfg.multaPercent}
                  onChange={(e) => setCfg({ ...cfg, multaPercent: Math.max(0, Number(e.target.value || 0)) })}
                  className="w-full p-3 border-2 rounded-lg text-center text-xl font-bold tabular-nums"
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-gray-700">Teto juros (% da parcela)</label>
                <input
                  type="number"
                  step={5}
                  min={0}
                  max={1000}
                  value={cfg.jurosMaxPercentParcela}
                  onChange={(e) => setCfg({ ...cfg, jurosMaxPercentParcela: Math.max(0, Number(e.target.value || 0)) })}
                  className="w-full p-3 border-2 rounded-lg text-center text-xl font-bold tabular-nums"
                />
              </div>
            </div>
            <div className="mt-2 text-xs text-gray-500">
              Ex: teto <b>100</b> = juros+multa nunca passam do valor da parcela.
            </div>
          </div>

          {/* LIMITE DE CRÉDITO */}
          <div className="bg-white rounded-2xl shadow-sm p-5 border-2 border-rose-200">
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 className="text-lg font-bold text-rose-900">Limite de crédito (bloqueio no PDV)</h2>
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full font-bold text-xs whitespace-nowrap ${
                  cfg.limiteEnabled ? 'bg-rose-100 text-rose-800' : 'bg-gray-200 text-gray-700'
                }`}
              >
                <Power size={12} /> {cfg.limiteEnabled ? 'BLOQUEANDO' : 'DESLIGADO'}
              </div>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              Quando ligado, o PDV <b>bloqueia novo crediário</b> pra cliente acima do limite.
              A vendedora libera com <b>senha de supervisor</b>. <b>0</b> em um campo = ignora aquele critério.
            </p>

            <button
              onClick={() => setCfg({ ...cfg, limiteEnabled: !cfg.limiteEnabled })}
              className={`w-full p-3 mb-3 rounded-xl border-2 flex items-center justify-between transition ${
                cfg.limiteEnabled
                  ? 'bg-rose-50 border-rose-400 text-rose-900'
                  : 'bg-gray-50 border-gray-300 text-gray-700 hover:border-gray-400'
              }`}
            >
              <div className="flex items-center gap-2 font-bold text-sm">
                <Power size={16} /> Bloqueio {cfg.limiteEnabled ? 'LIGADO' : 'DESLIGADO'}
              </div>
              <div className={`w-11 h-6 rounded-full p-1 transition ${cfg.limiteEnabled ? 'bg-rose-500' : 'bg-gray-300'}`}>
                <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform ${cfg.limiteEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
              </div>
            </button>

            <div className={`grid grid-cols-2 gap-3 transition ${cfg.limiteEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
              <div>
                <label className="text-xs font-bold uppercase text-gray-700">Máx. parcelas vencidas</label>
                <input
                  type="number"
                  min={0}
                  max={999}
                  value={cfg.limiteMaxParcelasVencidas}
                  onChange={(e) => setCfg({ ...cfg, limiteMaxParcelasVencidas: Math.max(0, Math.floor(Number(e.target.value || 0))) })}
                  className="w-full p-3 border-2 rounded-lg text-center text-xl font-bold tabular-nums"
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-gray-700">Máx. em aberto (R$)</label>
                <input
                  type="number"
                  step={50}
                  min={0}
                  value={cfg.limiteMaxValorEmAberto}
                  onChange={(e) => setCfg({ ...cfg, limiteMaxValorEmAberto: Math.max(0, Number(e.target.value || 0)) })}
                  className="w-full p-3 border-2 rounded-lg text-center text-xl font-bold tabular-nums"
                />
              </div>
            </div>
            <div className="mt-2 text-xs text-gray-500">
              Ex: máx <b>3</b> vencidas e <b>R$ 1.000</b> em aberto → acima disso, só com senha de supervisor.
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

          {/* ÍNDICE GIGA — performance da listagem de parcelas */}
          <div className="bg-white rounded-2xl shadow-sm p-5 border-2 border-amber-200">
            <h2 className="text-lg font-bold text-amber-900 mb-1 flex items-center gap-2">
              <Database size={18} /> Performance — Índice no Giga
            </h2>
            <p className="text-xs text-gray-600 mb-3">
              Cria índice composto <code className="bg-gray-100 px-1 rounded">(PAGO, VENCIMENTO)</code> na tabela <code className="bg-gray-100 px-1 rounded">movimento</code>.
              Acelera 10-100x as queries da tela RECEBIMENTOS.
              <br />
              <b className="text-amber-700">Recomendação:</b> rodar fora do horário comercial. Operação demora 1-5 min em tabelas grandes. Idempotente — se já existe, não faz nada.
            </p>
            <button
              onClick={createIndex}
              disabled={indexLoading}
              className="w-full px-4 py-3 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {indexLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Criando índice… (até 5 min, NÃO feche a página)
                </>
              ) : (
                <>
                  <Database size={18} />
                  Criar índice no Giga
                </>
              )}
            </button>

            {indexResult && (
              <div
                className={`mt-3 rounded-lg p-3 text-sm ${
                  indexResult.ok
                    ? 'bg-emerald-50 border border-emerald-300 text-emerald-900'
                    : 'bg-red-50 border border-red-300 text-red-900'
                }`}
              >
                {indexResult.ok ? (
                  <>
                    <div className="font-bold">
                      ✓ {indexResult.alreadyExists ? 'Índice já existia' : 'Índice criado!'}
                    </div>
                    {indexResult.durationMs != null && (
                      <div className="text-xs mt-1">
                        Tempo: {(indexResult.durationMs / 1000).toFixed(1)}s
                      </div>
                    )}
                    {indexResult.columns && (
                      <div className="text-xs mt-1">
                        Colunas: <code>{indexResult.columns.join(', ')}</code>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="font-bold">✗ Falha</div>
                    <div className="text-xs mt-1">{indexResult.error}</div>
                    {!indexResult.error?.includes('ERP_WRITE_ENABLED') && (
                      <div className="text-xs mt-2 italic">
                        Pode tentar de novo. Se erro persistir, peça pro técnico do Giga rodar manualmente:
                        <pre className="mt-1 bg-white p-2 rounded text-[10px] overflow-x-auto">
{`CREATE INDEX idx_lurdsorder_pago_vencimento
  ON movimento (PAGO, VENCIMENTO);`}
                        </pre>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
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
