'use client';

/**
 * HorarioGrid — turno por dia da semana (com intervalo de almoço).
 *
 * Layout: UMA LINHA POR DIA
 *   [Dia] [Folga] | Entrada | Saída almoço | Volta almoço | Saída | horas
 *
 * SEG é o "molde" — ao editar SEG, demais dias acompanham automaticamente
 * (campo a campo, só onde ainda não foi customizado).
 *
 * Sem almoço: deixe Saída almoço = Volta almoço (mesmo horário) que o
 * intervalo é zerado no cálculo.
 *
 * Estrutura JSON salva em sellers.horarioTrabalho:
 *   [
 *     { dia: 'SEG', inicio: '09:00', fim: '18:00',
 *       almocoInicio: '12:00', almocoFim: '13:00', folga: false },
 *     { dia: 'DOM', folga: true }
 *   ]
 */

import { useEffect, useState } from 'react';

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
  almocoInicio?: string;
  almocoFim?: string;
  /** Mantido por compat retroativa; UI ignora — usa diferença das datas. */
  temAlmoco?: boolean;
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
  return DIAS.map((d) => {
    const existing = turnos.find((t) => t.dia === d.key);
    if (existing) {
      return {
        almocoInicio: '12:00',
        almocoFim: '13:00',
        ...existing,
      };
    }
    return {
      dia: d.key,
      inicio: '09:00',
      fim: '18:00',
      almocoInicio: '12:00',
      almocoFim: '13:00',
      folga: false,
    };
  });
}

const toMin = (s?: string): number => {
  if (!s) return 0;
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

function calcMinutos(t: Turno): number {
  if (t.folga) return 0;
  let m = toMin(t.fim) - toMin(t.inicio);
  const almoco = toMin(t.almocoFim) - toMin(t.almocoInicio);
  if (almoco > 0) m -= almoco;
  return Math.max(0, m);
}

function fmtHoras(min: number): string {
  if (min <= 0) return '0h';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
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

  /**
   * Update inteligente: SEG (idx 0) é molde.
   * Ao editar SEG, propaga os campos pros dias que ainda estão com
   * o mesmo valor antigo do SEG (per-campo). Folga nunca propaga.
   */
  function update(idx: number, patch: Partial<Turno>) {
    const next = turnos.map((t, i) => (i === idx ? { ...t, ...patch } : t));

    if (idx === 0) {
      const patchKeys = Object.keys(patch).filter((k) => k !== 'dia');
      const isFolgaOnly =
        patchKeys.length === 1 && patchKeys[0] === 'folga';

      if (!isFolgaOnly) {
        const oldSeg = turnos[0];
        for (let i = 1; i < next.length; i++) {
          if (next[i].folga) continue;
          for (const k of patchKeys) {
            if (k === 'folga') continue;
            const wasPristineForKey =
              (turnos[i] as any)[k] === (oldSeg as any)[k];
            if (wasPristineForKey) {
              (next[i] as any)[k] = (patch as any)[k];
            }
          }
        }
      }
    }

    setTurnos(next);
    onChange(next);
  }

  function aplicarPadrao() {
    const padrao = DIAS.map((d) => ({
      dia: d.key,
      inicio: '09:00',
      fim: '18:00',
      almocoInicio: '12:00',
      almocoFim: '13:00',
      folga: d.key === 'DOM',
    }));
    setTurnos(padrao);
    onChange(padrao);
  }

  const totalSemanaMin = turnos.reduce((acc, t) => acc + calcMinutos(t), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <p className="text-xs text-slate-500">
          Edite <b className="text-emerald-700">Segunda</b> — os outros dias
          copiam automaticamente. Para tirar almoço, deixe os dois horários iguais.
        </p>
        <button
          type="button"
          onClick={aplicarPadrao}
          className="text-xs text-emerald-700 font-bold hover:underline"
        >
          Aplicar padrão (9-18, almoço 12-13, dom folga)
        </button>
      </div>

      {/* Header de colunas (apenas desktop) */}
      <div className="hidden md:grid grid-cols-[110px_70px_1fr_1fr_1fr_1fr_60px] gap-2 px-2 pb-1 text-[10px] font-bold uppercase text-slate-500">
        <div>Dia</div>
        <div></div>
        <div>Entrada</div>
        <div className="text-amber-700">Saída almoço</div>
        <div className="text-amber-700">Volta almoço</div>
        <div>Saída</div>
        <div className="text-right">Horas</div>
      </div>

      <div className="space-y-1">
        {turnos.map((t, idx) => {
          const dia = DIAS.find((d) => d.key === t.dia);
          const isSeg = idx === 0;
          const horas = fmtHoras(calcMinutos(t));

          return (
            <div
              key={t.dia}
              className={`grid grid-cols-2 md:grid-cols-[110px_70px_1fr_1fr_1fr_1fr_60px] gap-2 items-center p-2 rounded border ${
                t.folga
                  ? 'bg-slate-50 border-slate-200'
                  : isSeg
                    ? 'bg-emerald-50/40 border-emerald-300'
                    : 'bg-white border-slate-200'
              }`}
            >
              {/* Dia + badge MOLDE */}
              <div className="flex items-center gap-1.5 col-span-1">
                <span className="font-bold text-sm text-slate-700">
                  {dia?.label}
                </span>
                {isSeg && (
                  <span
                    title="Edita aqui — os outros dias copiam"
                    className="text-[9px] font-bold uppercase bg-emerald-600 text-white px-1 py-0.5 rounded"
                  >
                    Molde
                  </span>
                )}
              </div>

              {/* Folga */}
              <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!t.folga}
                  onChange={(e) => update(idx, { folga: e.target.checked })}
                  className="w-3.5 h-3.5"
                />
                Folga
              </label>

              {/* Inputs ou "Dia de folga" */}
              {!t.folga ? (
                <>
                  <input
                    type="time"
                    value={t.inicio || '09:00'}
                    onChange={(e) => update(idx, { inicio: e.target.value })}
                    className="w-full px-2 py-1 border rounded text-sm"
                  />
                  <input
                    type="time"
                    value={t.almocoInicio || '12:00'}
                    onChange={(e) => update(idx, { almocoInicio: e.target.value })}
                    className="w-full px-2 py-1 border rounded text-sm bg-amber-50/50"
                  />
                  <input
                    type="time"
                    value={t.almocoFim || '13:00'}
                    onChange={(e) => update(idx, { almocoFim: e.target.value })}
                    className="w-full px-2 py-1 border rounded text-sm bg-amber-50/50"
                  />
                  <input
                    type="time"
                    value={t.fim || '18:00'}
                    onChange={(e) => update(idx, { fim: e.target.value })}
                    className="w-full px-2 py-1 border rounded text-sm"
                  />
                  <div className="text-right text-xs font-bold text-emerald-700">
                    {horas}
                  </div>
                </>
              ) : (
                <>
                  <div className="col-span-4 text-xs text-slate-500 italic">
                    — dia de folga
                  </div>
                  <div className="text-right text-xs text-slate-400">—</div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Total semanal */}
      <div className="mt-3 flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-lg p-3">
        <span className="text-sm font-bold text-emerald-800">
          Carga horária semanal
        </span>
        <span className="text-lg font-bold text-emerald-700">
          {fmtHoras(totalSemanaMin)}
        </span>
      </div>
    </div>
  );
}
