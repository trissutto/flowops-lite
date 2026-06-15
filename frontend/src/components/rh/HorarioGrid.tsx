'use client';

/**
 * HorarioGrid — turno por dia da semana com intervalo de almoço (intrajornada CLT).
 *
 * Estrutura JSON armazenada em sellers.horarioTrabalho:
 *   [
 *     {
 *       dia: 'SEG',
 *       inicio: '09:00',
 *       fim: '18:00',
 *       almocoInicio: '12:00',
 *       almocoFim: '13:00',
 *       temAlmoco: true,
 *       folga: false
 *     },
 *     { dia: 'DOM', folga: true }
 *   ]
 *
 * Default: 09-18 com almoço 12-13 (1h CLT). Folga: domingo.
 */

import { useEffect, useState } from 'react';
import { Clock, Coffee, Utensils } from 'lucide-react';

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
      // Backfill almoço default caso prontuario antigo nao tenha o campo
      return {
        temAlmoco: existing.folga ? false : existing.temAlmoco ?? true,
        almocoInicio: existing.almocoInicio || '12:00',
        almocoFim: existing.almocoFim || '13:00',
        ...existing,
      };
    }
    return {
      dia: d.key,
      inicio: '09:00',
      fim: '18:00',
      almocoInicio: '12:00',
      almocoFim: '13:00',
      temAlmoco: true,
      folga: false,
    };
  });
}

/** HH:MM → minutos */
function toMin(s?: string): number {
  if (!s) return 0;
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function calcHoras(t: Turno): string {
  if (t.folga) return '—';
  let total = toMin(t.fim) - toMin(t.inicio);
  if (t.temAlmoco) total -= toMin(t.almocoFim) - toMin(t.almocoInicio);
  if (total <= 0) return '0h';
  const h = Math.floor(total / 60);
  const m = total % 60;
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
   * Update inteligente.
   *
   * Quando o usuario edita SEG (idx=0), propaga os campos alterados pros
   * outros dias QUE AINDA ESTAO IGUAIS ao SEG antigo no campo correspondente
   * (ou seja, dias "limpos" / nao customizados). Se TER ja teve um campo
   * customizado, esse campo NAO e mais sobrescrito por SEG. Demais campos
   * de TER continuam acompanhando SEG enquanto estiverem iguais.
   *
   * Folga nunca propaga — folga e individual por dia.
   * Dias marcados como folga nao recebem propagacao de SEG.
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
    // 9-18 seg-sab, almoço 12-13, dom folga
    const padrao = DIAS.map((d) => ({
      dia: d.key,
      inicio: '09:00',
      fim: '18:00',
      almocoInicio: '12:00',
      almocoFim: '13:00',
      temAlmoco: d.key !== 'DOM',
      folga: d.key === 'DOM',
    }));
    setTurnos(padrao);
    onChange(padrao);
  }

  // Soma semanal
  const totalSemanaMin = turnos.reduce((acc, t) => {
    if (t.folga) return acc;
    let m = toMin(t.fim) - toMin(t.inicio);
    if (t.temAlmoco) m -= toMin(t.almocoFim) - toMin(t.almocoInicio);
    return acc + Math.max(0, m);
  }, 0);
  const totalHorasSemana =
    Math.floor(totalSemanaMin / 60) +
    (totalSemanaMin % 60 ? `:${String(totalSemanaMin % 60).padStart(2, '0')}` : 'h');

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <p className="text-xs text-slate-500">
          Edite <b className="text-emerald-700">Segunda</b> — os outros dias
          copiam automaticamente. Dias customizados ficam livres.
        </p>
        <button
          type="button"
          onClick={aplicarPadrao}
          className="text-xs text-emerald-700 font-bold hover:underline"
        >
          Aplicar padrão (9-18, almoço 12-13, dom folga)
        </button>
      </div>

      <div className="space-y-1.5">
        {turnos.map((t, idx) => {
          const dia = DIAS.find((d) => d.key === t.dia);
          const isSeg = idx === 0;
          return (
            <div
              key={t.dia}
              className={`p-2.5 rounded border ${
                t.folga
                  ? 'bg-slate-50 border-slate-200'
                  : isSeg
                    ? 'bg-emerald-50/40 border-emerald-300'
                    : 'bg-white border-slate-200'
              }`}
            >
              {/* Linha 1: dia + folga + horas calculadas */}
              <div className="flex items-center gap-2 mb-2">
                <div className="font-bold text-sm text-slate-700 w-20 flex items-center gap-1">
                  {dia?.label}
                  {isSeg && (
                    <span
                      title="Edita aqui — os outros dias copiam"
                      className="text-[9px] font-bold uppercase bg-emerald-600 text-white px-1 py-0.5 rounded"
                    >
                      Molde
                    </span>
                  )}
                </div>
                <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!t.folga}
                    onChange={(e) => update(idx, { folga: e.target.checked })}
                    className="w-4 h-4"
                  />
                  Folga
                </label>
                <div className="flex-1" />
                <div className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                  {calcHoras(t)}
                </div>
              </div>

              {!t.folga && (
                <>
                  {/* Linha 2: entrada e saída */}
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-slate-600">
                      <Clock className="w-3 h-3 text-slate-400 flex-shrink-0" />
                      <span className="w-12">Entra</span>
                      <input
                        type="time"
                        value={t.inicio || '09:00'}
                        onChange={(e) => update(idx, { inicio: e.target.value })}
                        className="flex-1 px-2 py-1 border rounded text-sm"
                      />
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-slate-600">
                      <Clock className="w-3 h-3 text-slate-400 flex-shrink-0" />
                      <span className="w-12">Sai</span>
                      <input
                        type="time"
                        value={t.fim || '18:00'}
                        onChange={(e) => update(idx, { fim: e.target.value })}
                        className="flex-1 px-2 py-1 border rounded text-sm"
                      />
                    </label>
                  </div>

                  {/* Linha 3: almoço */}
                  <div className="mt-2 pt-2 border-t border-dashed border-slate-200">
                    <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer mb-1.5">
                      <input
                        type="checkbox"
                        checked={!!t.temAlmoco}
                        onChange={(e) =>
                          update(idx, { temAlmoco: e.target.checked })
                        }
                        className="w-3.5 h-3.5"
                      />
                      <Utensils className="w-3 h-3 text-amber-600" />
                      <span className="font-bold">Intervalo de almoço</span>
                    </label>
                    {t.temAlmoco && (
                      <div className="grid grid-cols-2 gap-2">
                        <label className="flex items-center gap-1.5 text-xs text-slate-600">
                          <Coffee className="w-3 h-3 text-amber-600 flex-shrink-0" />
                          <span className="w-12">Saída</span>
                          <input
                            type="time"
                            value={t.almocoInicio || '12:00'}
                            onChange={(e) =>
                              update(idx, { almocoInicio: e.target.value })
                            }
                            className="flex-1 px-2 py-1 border rounded text-sm bg-amber-50/50"
                          />
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-slate-600">
                          <Coffee className="w-3 h-3 text-amber-600 flex-shrink-0" />
                          <span className="w-12">Volta</span>
                          <input
                            type="time"
                            value={t.almocoFim || '13:00'}
                            onChange={(e) =>
                              update(idx, { almocoFim: e.target.value })
                            }
                            className="flex-1 px-2 py-1 border rounded text-sm bg-amber-50/50"
                          />
                        </label>
                      </div>
                    )}
                  </div>
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
          {typeof totalHorasSemana === 'string'
            ? totalHorasSemana
            : `${totalHorasSemana}h`}
        </span>
      </div>
    </div>
  );
}
