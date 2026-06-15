'use client';

/**
 * HorarioGrid — turno por dia da semana.
 *
 * Estrutura armazenada (string JSON em sellers.horarioTrabalho):
 *   [
 *     { dia: 'SEG', inicio: '09:00', fim: '18:00', folga: false },
 *     { dia: 'TER', inicio: '09:00', fim: '18:00', folga: false },
 *     ...
 *     { dia: 'DOM', folga: true }
 *   ]
 *
 * Se "folga: true" → não exibe horario.
 * Onload aceita JSON parseado ou string serializada.
 */

import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';

const DIAS = [
  { key: 'SEG', label: 'Segunda' },
  { key: 'TER', label: 'Terça' },
  { key: 'QUA', label: 'Quarta' },
  { key: 'QUI', label: 'Quinta' },
  { key: 'SEX', label: 'Sexta' },
  { key: 'SAB', label: 'Sábado' },
  { key: 'DOM', label: 'Domingo' },
];

type Turno = {
  dia: string;
  inicio?: string;
  fim?: string;
  folga?: boolean;
};

function parseValue(v: any): Turno[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalize(turnos: Turno[]): Turno[] {
  // Garante 7 dias sempre
  return DIAS.map((d) => {
    const existing = turnos.find((t) => t.dia === d.key);
    if (existing) return existing;
    return { dia: d.key, inicio: '09:00', fim: '18:00', folga: false };
  });
}

export default function HorarioGrid({
  value,
  onChange,
}: {
  value: any;
  onChange: (v: Turno[]) => void;
}) {
  const [turnos, setTurnos] = useState<Turno[]>(() => normalize(parseValue(value)));

  useEffect(() => {
    setTurnos(normalize(parseValue(value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);

  function update(idx: number, patch: Partial<Turno>) {
    const next = turnos.map((t, i) => (i === idx ? { ...t, ...patch } : t));
    setTurnos(next);
    onChange(next);
  }

  function aplicarPadrao() {
    // 9-18 seg-sab, dom folga
    const padrao = DIAS.map((d) => ({
      dia: d.key,
      inicio: '09:00',
      fim: '18:00',
      folga: d.key === 'DOM',
    }));
    setTurnos(padrao);
    onChange(padrao);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-slate-500">
          Marque os dias de folga. Edite horários por turno.
        </p>
        <button
          type="button"
          onClick={aplicarPadrao}
          className="text-xs text-emerald-700 font-bold hover:underline"
        >
          Aplicar padrão (9-18, dom folga)
        </button>
      </div>

      <div className="space-y-1.5">
        {turnos.map((t, idx) => {
          const dia = DIAS.find((d) => d.key === t.dia);
          return (
            <div
              key={t.dia}
              className={`grid grid-cols-12 gap-2 items-center p-2 rounded border ${
                t.folga ? 'bg-slate-50 border-slate-200' : 'bg-white border-slate-200'
              }`}
            >
              <div className="col-span-3 text-sm font-bold text-slate-700">
                {dia?.label}
              </div>
              <div className="col-span-3">
                <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!t.folga}
                    onChange={(e) => update(idx, { folga: e.target.checked })}
                    className="w-4 h-4"
                  />
                  Folga
                </label>
              </div>
              {!t.folga ? (
                <>
                  <div className="col-span-3 flex items-center gap-1">
                    <Clock className="w-3 h-3 text-slate-400" />
                    <input
                      type="time"
                      value={t.inicio || '09:00'}
                      onChange={(e) => update(idx, { inicio: e.target.value })}
                      className="flex-1 px-2 py-1 border rounded text-sm"
                    />
                  </div>
                  <div className="col-span-3 flex items-center gap-1">
                    <span className="text-xs text-slate-400">às</span>
                    <input
                      type="time"
                      value={t.fim || '18:00'}
                      onChange={(e) => update(idx, { fim: e.target.value })}
                      className="flex-1 px-2 py-1 border rounded text-sm"
                    />
                  </div>
                </>
              ) : (
                <div className="col-span-6 text-xs text-slate-500 italic">
                  — dia de folga
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
