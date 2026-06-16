'use client';

/**
 * /retaguarda/rh/banco-horas
 *
 * Relatório mensal de Banco de Horas + Hora Extra.
 * Base legal: CLT Art. 7º + Lei 13.467/2017 (Reforma Trabalhista).
 *
 * Mostra:
 *  - Resumo (previsto, trabalhado, saldo banco, HE 50%, HE 100%, valor R$)
 *  - Alertas de irregularidade (cadastro > 44h/sem, dia > 10h, sem almoço >6h)
 *  - Tabela detalhada por dia (com HE separado por tipo)
 *  - Botão Imprimir
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, Calendar, AlertTriangle, CheckCircle2,
  TrendingUp, TrendingDown, DollarSign, Clock, Printer,
} from 'lucide-react';
import { api } from '@/lib/api';

type Seller = { id: string; name: string; active: boolean };

type BancoHoras = {
  seller: { id: string; name: string; cargo: string };
  periodo: { ano: number; mes: number };
  cadastro: {
    minSemanaPrevisto: number;
    horasSemanaPrevisto: number;
    limiteSemanalLegal: number;
    cadastroAcima44h: boolean;
    semAlmocoObrigatorio: boolean;
  };
  salario: {
    salarioBase: number;
    valorHoraNormal: number;
    valorHoraExtra50: number;
    valorHoraExtra100: number;
  };
  totais: {
    minPrevisto: number;
    minTrabalhado: number;
    saldoBancoMin: number;
    totalHe50Min: number;
    totalHe100Min: number;
    totalHeMin: number;
    diasAcima10h: number;
    valorHe50: number;
    valorHe100: number;
    valorTotalHe: number;
  };
  dias: Array<{
    data: string;
    diaSemana: string;
    folga: boolean;
    entrada: string | null;
    saidaAlmoco: string | null;
    voltaAlmoco: string | null;
    saida: string | null;
    minTrabalhado: number;
    minPrevisto: number;
    saldoMin: number;
    heMin50: number;
    heMin100: number;
    diaAcima10h: boolean;
    valorHe50: number;
    valorHe100: number;
  }>;
};

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const fmtHora = (iso: string | null) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
};

const fmtMin = (min: number, withSign = false) => {
  if (min === 0) return '0h';
  const sign = min < 0 ? '-' : withSign ? '+' : '';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h${String(m).padStart(2, '0')}`;
};

const fmtData = (iso: string) => {
  try {
    const d = new Date(iso + 'T00:00:00');
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  } catch { return iso; }
};

const brl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function BancoHorasPage() {
  const now = new Date();
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [sellerId, setSellerId] = useState<string>('');
  const [ano, setAno] = useState(now.getFullYear());
  const [mes, setMes] = useState(now.getMonth() + 1);
  const [data, setData] = useState<BancoHoras | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api<Seller[]>('/sellers?includeInactive=0')
      .then((arr) => setSellers(arr.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!sellerId) return;
    setLoading(true);
    api<BancoHoras>(`/ponto/banco-horas?sellerId=${sellerId}&ano=${ano}&mes=${mes}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [sellerId, ano, mes]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-brand text-white shadow sticky top-0 z-10 print:hidden">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda/vendedoras" className="p-2 hover:bg-white/10 rounded">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-lg font-bold">Banco de Horas + Hora Extra</h1>
            <p className="text-xs text-white/80">CLT 44h/sem · Lei 13.467/2017</p>
          </div>
          {data && (
            <button
              onClick={() => window.print()}
              className="bg-white/10 hover:bg-white/20 px-3 py-2 rounded text-sm font-bold flex items-center gap-2"
            >
              <Printer className="w-4 h-4" />
              Imprimir
            </button>
          )}
        </div>
      </header>

      <div className="max-w-6xl mx-auto p-4 space-y-4">
        {/* Filtros */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-3 gap-3 print:hidden">
          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Funcionária
            </label>
            <select
              value={sellerId}
              onChange={(e) => setSellerId(e.target.value)}
              className="w-full px-3 py-2 border rounded text-sm"
            >
              <option value="">— selecione —</option>
              {sellers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Mês</label>
            <select
              value={mes}
              onChange={(e) => setMes(Number(e.target.value))}
              className="w-full px-3 py-2 border rounded text-sm"
            >
              {MESES.map((m, i) => (
                <option key={i} value={i + 1}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Ano</label>
            <select
              value={ano}
              onChange={(e) => setAno(Number(e.target.value))}
              className="w-full px-3 py-2 border rounded text-sm"
            >
              {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </div>

        {loading && (
          <div className="text-center py-8">
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-emerald-600" />
          </div>
        )}

        {!loading && data && (
          <>
            {/* Cabeçalho do relatório (visível no print) */}
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <h2 className="text-lg font-bold">{data.seller.name}</h2>
              <p className="text-sm text-slate-600">
                {data.seller.cargo} · {MESES[data.periodo.mes - 1]}/{data.periodo.ano}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Jornada cadastrada: <b>{data.cadastro.horasSemanaPrevisto.toFixed(1)}h/semana</b>
                {' · '}Salário base: <b>{brl(data.salario.salarioBase)}</b>
                {' · '}Hora normal: <b>{brl(data.salario.valorHoraNormal)}</b>
              </p>
            </div>

            {/* Alertas de irregularidade */}
            {(data.cadastro.cadastroAcima44h ||
              data.cadastro.semAlmocoObrigatorio ||
              data.totais.diasAcima10h > 0) && (
              <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2 font-bold text-amber-800">
                  <AlertTriangle className="w-5 h-5" />
                  Alertas de conformidade legal
                </div>
                {data.cadastro.cadastroAcima44h && (
                  <p className="text-sm text-amber-700">
                    ⚠️ <b>Cadastro acima de 44h/semana</b> ({data.cadastro.horasSemanaPrevisto.toFixed(1)}h).
                    A jornada cadastrada excede o limite legal CLT. Revise o horário.
                  </p>
                )}
                {data.cadastro.semAlmocoObrigatorio && (
                  <p className="text-sm text-amber-700">
                    ⚠️ <b>Jornada {'>'}6h sem almoço de 1h</b>. CLT Art. 71 exige intervalo
                    intrajornada mínimo de 1h pra jornadas acima de 6h.
                  </p>
                )}
                {data.totais.diasAcima10h > 0 && (
                  <p className="text-sm text-amber-700">
                    ⚠️ <b>{data.totais.diasAcima10h} dia(s)</b> com mais de 10h trabalhadas.
                    Limite legal diário é 10h (8 normais + 2 extras).
                  </p>
                )}
              </div>
            )}

            {/* Resumo financeiro */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard
                label="Previsto"
                value={fmtMin(data.totais.minPrevisto)}
                icon={<Clock />}
                color="slate"
              />
              <SummaryCard
                label="Trabalhado"
                value={fmtMin(data.totais.minTrabalhado)}
                icon={<CheckCircle2 />}
                color="emerald"
              />
              <SummaryCard
                label="Saldo Banco"
                value={fmtMin(data.totais.saldoBancoMin, true)}
                icon={data.totais.saldoBancoMin >= 0 ? <TrendingUp /> : <TrendingDown />}
                color={data.totais.saldoBancoMin >= 0 ? 'emerald' : 'rose'}
              />
              <SummaryCard
                label="Hora Extra (R$)"
                value={brl(data.totais.valorTotalHe)}
                icon={<DollarSign />}
                color="amber"
              />
            </div>

            {/* Quebra HE 50% vs HE 100% */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <p className="text-xs uppercase font-bold text-slate-500 mb-2">
                  HE 50% — Dias úteis
                </p>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-slate-800">
                    {fmtMin(data.totais.totalHe50Min)}
                  </span>
                  <span className="text-lg font-bold text-emerald-700">
                    {brl(data.totais.valorHe50)}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Hora normal × 1,5 = {brl(data.salario.valorHoraExtra50)}/h
                </p>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <p className="text-xs uppercase font-bold text-slate-500 mb-2">
                  HE 100% — Domingo / Folga
                </p>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-slate-800">
                    {fmtMin(data.totais.totalHe100Min)}
                  </span>
                  <span className="text-lg font-bold text-emerald-700">
                    {brl(data.totais.valorHe100)}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Hora normal × 2,0 = {brl(data.salario.valorHoraExtra100)}/h
                </p>
              </div>
            </div>

            {/* Tabela detalhada */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-slate-100 font-bold text-sm">
                Detalhamento diário
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-700">
                    <tr className="text-left text-xs uppercase font-bold">
                      <th className="px-3 py-2">Dia</th>
                      <th className="px-3 py-2">Ent.</th>
                      <th className="px-3 py-2">Alm. Sai</th>
                      <th className="px-3 py-2">Alm. Volta</th>
                      <th className="px-3 py-2">Saída</th>
                      <th className="px-3 py-2 text-right">Trab.</th>
                      <th className="px-3 py-2 text-right">Prev.</th>
                      <th className="px-3 py-2 text-right text-emerald-700">HE 50%</th>
                      <th className="px-3 py-2 text-right text-rose-700">HE 100%</th>
                      <th className="px-3 py-2 text-right">R$</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.dias.map((d) => (
                      <tr
                        key={d.data}
                        className={`border-t ${
                          d.diaAcima10h
                            ? 'bg-amber-50'
                            : d.folga
                              ? 'bg-slate-50'
                              : ''
                        }`}
                      >
                        <td className="px-3 py-2 font-bold">
                          {fmtData(d.data)}{' '}
                          <span className="text-slate-400 text-xs">{d.diaSemana}</span>
                          {d.diaAcima10h && (
                            <span title="Mais de 10h trabalhadas" className="ml-1 text-amber-700">
                              ⚠️
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{fmtHora(d.entrada)}</td>
                        <td className="px-3 py-2 font-mono text-xs">{fmtHora(d.saidaAlmoco)}</td>
                        <td className="px-3 py-2 font-mono text-xs">{fmtHora(d.voltaAlmoco)}</td>
                        <td className="px-3 py-2 font-mono text-xs">{fmtHora(d.saida)}</td>
                        <td className="px-3 py-2 text-right font-bold">
                          {fmtMin(d.minTrabalhado)}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-500">
                          {fmtMin(d.minPrevisto)}
                        </td>
                        <td className="px-3 py-2 text-right text-emerald-700 font-bold">
                          {d.heMin50 > 0 ? fmtMin(d.heMin50) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-rose-700 font-bold">
                          {d.heMin100 > 0 ? fmtMin(d.heMin100) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-emerald-700 font-bold">
                          {d.valorHe50 + d.valorHe100 > 0
                            ? brl(d.valorHe50 + d.valorHe100)
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-100 font-bold text-sm border-t-2 border-slate-300">
                    <tr>
                      <td colSpan={5} className="px-3 py-2">TOTAIS DO MÊS</td>
                      <td className="px-3 py-2 text-right">
                        {fmtMin(data.totais.minTrabalhado)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtMin(data.totais.minPrevisto)}
                      </td>
                      <td className="px-3 py-2 text-right text-emerald-700">
                        {fmtMin(data.totais.totalHe50Min)}
                      </td>
                      <td className="px-3 py-2 text-right text-rose-700">
                        {fmtMin(data.totais.totalHe100Min)}
                      </td>
                      <td className="px-3 py-2 text-right text-emerald-700">
                        {brl(data.totais.valorTotalHe)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Legenda CLT */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-600 space-y-1">
              <p className="font-bold text-slate-700">📜 Base legal aplicada</p>
              <p>• Jornada máxima legal: 44h/semana (CLT Art. 7º)</p>
              <p>• Limite diário: 10h máximo (8 normais + 2 extras)</p>
              <p>• HE em dia útil: +50% sobre hora normal</p>
              <p>• HE em domingo/folga: +100% sobre hora normal</p>
              <p>• Valor hora normal: salário base ÷ 220h (padrão CLT comércio)</p>
              <p>• Compensação banco de horas: até 6 meses (acordo individual) ou 1 ano (acordo coletivo)</p>
            </div>
          </>
        )}

        {!sellerId && !loading && (
          <div className="bg-white border border-dashed border-slate-300 rounded-xl p-8 text-center">
            <Calendar className="w-10 h-10 mx-auto text-slate-400 mb-2" />
            <p className="text-sm text-slate-600">
              Selecione uma funcionária pra calcular banco de horas + HE
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  color: 'slate' | 'emerald' | 'rose' | 'amber';
}) {
  const colorMap = {
    slate:   'bg-slate-50 border-slate-200 text-slate-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    rose:    'bg-rose-50 border-rose-200 text-rose-700',
    amber:   'bg-amber-50 border-amber-200 text-amber-700',
  };
  return (
    <div className={`border rounded-xl p-3 ${colorMap[color]}`}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-bold uppercase opacity-80">{label}</p>
        <div className="opacity-50">{icon}</div>
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}
