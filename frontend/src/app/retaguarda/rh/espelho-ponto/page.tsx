'use client';

/**
 * /retaguarda/rh/espelho-ponto
 *
 * Espelho de ponto admin — visão por funcionária.
 *  - Filtros: vendedora (autocomplete) + mês/ano
 *  - Tabela dias × batidas com:
 *      - 4 horários (entrada / saída almoço / volta / saída)
 *      - horas trabalhadas vs previstas vs saldo
 *      - badge "falta", "incompleto", "justificado"
 *  - Botão "Lançar manual" pra esquecimentos (POST /ponto/manual)
 *  - Botão "Justificar" em cada batida
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, FileText, Calendar, CheckCircle2, AlertTriangle,
  Edit3, Plus, Clock,
} from 'lucide-react';
import { api } from '@/lib/api';

type Seller = {
  id: string;
  name: string;
  active: boolean;
  cargo?: string;
  responsibleStoreId?: string | null;
};

type Espelho = {
  seller: { id: string; name: string; cargo: string };
  periodo: any;
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
    batidas: number;
    completo: boolean;
    justificado: boolean;
  }>;
  totais: {
    minTrabalhado: number;
    minPrevisto: number;
    saldoMin: number;
  };
};

const fmtHora = (iso: string | null) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
};

const fmtMin = (min: number) => {
  if (min === 0) return '0h';
  const sign = min < 0 ? '-' : '';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h${String(m).padStart(2, '0')}`;
};

const fmtData = (iso: string) => {
  try {
    const d = new Date(iso + 'T00:00:00');
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  } catch {
    return iso;
  }
};

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

export default function EspelhoPontoPage() {
  const now = new Date();
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [sellerId, setSellerId] = useState<string>('');
  const [ano, setAno] = useState(now.getFullYear());
  const [mes, setMes] = useState(now.getMonth() + 1);
  const [espelho, setEspelho] = useState<Espelho | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api<Seller[]>('/sellers?includeInactive=0')
      .then((arr) =>
        setSellers(arr.sort((a, b) => a.name.localeCompare(b.name))),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!sellerId) return;
    setLoading(true);
    api<Espelho>(`/ponto/espelho?sellerId=${sellerId}&ano=${ano}&mes=${mes}`)
      .then(setEspelho)
      .catch(() => setEspelho(null))
      .finally(() => setLoading(false));
  }, [sellerId, ano, mes]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-brand text-white shadow sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda/vendedoras" className="p-2 hover:bg-white/10 rounded">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-lg font-bold">Espelho de Ponto</h1>
            <p className="text-xs text-white/80">RH · Lurd's</p>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto p-4 space-y-4">
        {/* Filtros */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
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
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Mês
            </label>
            <select
              value={mes}
              onChange={(e) => setMes(Number(e.target.value))}
              className="w-full px-3 py-2 border rounded text-sm"
            >
              {MESES.map((m, i) => (
                <option key={i} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Ano
            </label>
            <select
              value={ano}
              onChange={(e) => setAno(Number(e.target.value))}
              className="w-full px-3 py-2 border rounded text-sm"
            >
              {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(
                (y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ),
              )}
            </select>
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="text-center py-8">
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-emerald-600" />
          </div>
        )}

        {/* Espelho */}
        {!loading && espelho && (
          <>
            {/* Resumo */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatBox
                label="Previsto"
                value={fmtMin(espelho.totais.minPrevisto)}
                color="slate"
              />
              <StatBox
                label="Trabalhado"
                value={fmtMin(espelho.totais.minTrabalhado)}
                color="emerald"
              />
              <StatBox
                label="Saldo"
                value={fmtMin(espelho.totais.saldoMin)}
                color={espelho.totais.saldoMin >= 0 ? 'emerald' : 'rose'}
              />
            </div>

            {/* Tabela */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr className="text-left text-xs uppercase font-bold">
                      <th className="px-3 py-2">Dia</th>
                      <th className="px-3 py-2">Entrada</th>
                      <th className="px-3 py-2">Saída Almoço</th>
                      <th className="px-3 py-2">Volta Almoço</th>
                      <th className="px-3 py-2">Saída</th>
                      <th className="px-3 py-2 text-right">Trab.</th>
                      <th className="px-3 py-2 text-right">Prev.</th>
                      <th className="px-3 py-2 text-right">Saldo</th>
                      <th className="px-3 py-2 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {espelho.dias.map((d) => {
                      const isFalta =
                        !d.folga && d.minPrevisto > 0 && d.minTrabalhado === 0;
                      const isIncompleto =
                        !d.folga &&
                        d.batidas > 0 &&
                        d.batidas < (d.entrada && d.saida ? 2 : 4);
                      return (
                        <tr
                          key={d.data}
                          className={`border-t ${
                            d.folga
                              ? 'bg-slate-50'
                              : isFalta
                                ? 'bg-rose-50'
                                : ''
                          }`}
                        >
                          <td className="px-3 py-2 font-bold">
                            {fmtData(d.data)} <span className="text-slate-400 text-xs">{d.diaSemana}</span>
                          </td>
                          <td className="px-3 py-2 font-mono">{fmtHora(d.entrada)}</td>
                          <td className="px-3 py-2 font-mono">{fmtHora(d.saidaAlmoco)}</td>
                          <td className="px-3 py-2 font-mono">{fmtHora(d.voltaAlmoco)}</td>
                          <td className="px-3 py-2 font-mono">{fmtHora(d.saida)}</td>
                          <td className="px-3 py-2 text-right font-bold">
                            {fmtMin(d.minTrabalhado)}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-500">
                            {fmtMin(d.minPrevisto)}
                          </td>
                          <td
                            className={`px-3 py-2 text-right font-bold ${
                              d.saldoMin >= 0 ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                          >
                            {fmtMin(d.saldoMin)}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {d.folga ? (
                              <span className="text-xs text-slate-400">Folga</span>
                            ) : d.justificado ? (
                              <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">
                                Justific.
                              </span>
                            ) : isFalta ? (
                              <span className="text-xs bg-rose-100 text-rose-700 px-2 py-0.5 rounded font-bold">
                                FALTA
                              </span>
                            ) : isIncompleto ? (
                              <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">
                                Incompl.
                              </span>
                            ) : d.minTrabalhado > 0 ? (
                              <CheckCircle2 className="w-4 h-4 text-emerald-600 mx-auto" />
                            ) : (
                              <span className="text-xs text-slate-300">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Legenda */}
            <div className="text-xs text-slate-500 flex flex-wrap gap-3">
              <span><b className="text-emerald-700">✓</b> dia completo</span>
              <span><b className="text-rose-700">FALTA</b> previsto mas não bateu</span>
              <span><b className="text-amber-700">Incompl.</b> bateu mas não fechou</span>
              <span><b className="text-amber-700">Justific.</b> corrigido pelo admin</span>
            </div>
          </>
        )}

        {!loading && !espelho && sellerId && (
          <div className="text-center py-8 text-slate-500 text-sm">
            Sem registros de ponto para este período.
          </div>
        )}

        {!sellerId && (
          <div className="bg-white border border-dashed border-slate-300 rounded-xl p-8 text-center">
            <Calendar className="w-10 h-10 mx-auto text-slate-400 mb-2" />
            <p className="text-sm text-slate-600">
              Selecione uma funcionária pra ver o espelho mensal
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: 'slate' | 'emerald' | 'rose';
}) {
  const colorMap = {
    slate: 'bg-slate-100 text-slate-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
  };
  return (
    <div className={`border rounded-xl p-3 text-center ${colorMap[color]}`}>
      <p className="text-xs font-bold uppercase opacity-80">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}
