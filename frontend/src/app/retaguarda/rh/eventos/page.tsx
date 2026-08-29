'use client';

/**
 * /retaguarda/rh/eventos — atestado, falta, férias, treinamento, advertência.
 *
 * QUEM LANÇA É A SUPERVISÃO (decisão do dono, 28/08/2026). Não há pedir e
 * aprovar: lançou, vale, e o espelho de ponto muda no mesmo instante.
 *
 * O que a tela deliberadamente NÃO faz: perguntar se o evento desconta, se
 * abona ou se mexe no DSR. Quem responde isso é o TIPO, na régua única do
 * backend (`common/eventos-rh.ts`) — a tela só MOSTRA o efeito escolhido. Se
 * fosse campo, dois atestados iguais valeriam coisas diferentes e nenhum
 * relatório de RH fecharia.
 *
 * Recorte de tempo no padrão da casa: De/Até + atalhos, nunca dropdown de
 * período fixo.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, CalendarDays, Loader2, Plus, X, AlertTriangle, Ban,
  FileText, Clock, Info, RefreshCw,
} from 'lucide-react';
import { api } from '@/lib/api';

type Tipo = {
  codigo: string;
  label: string;
  grupo: string;
  exigeDocumento: boolean;
  admiteParcial: boolean;
  abonaJornada: boolean;
  descontaSalario: boolean;
  descontaDSR: boolean;
  contaArt130: boolean;
  limiteDias: number | null;
  esocial: string | null;
  nota: string | null;
};

type Evento = {
  id: string;
  sellerId: string;
  tipo: string;
  tipoLabel: string;
  grupo: string | null;
  dataInicio: string;
  dataFim: string;
  diaInteiro: boolean;
  horaInicio: string | null;
  horaFim: string | null;
  observacoes: string | null;
  lancadoByNome: string | null;
  canceladoAt: string | null;
  canceladoMotivo: string | null;
  abonaJornada: boolean;
  descontaSalario: boolean;
  descontaDSR: boolean;
  contaArt130: boolean;
  seller?: { id: string; name: string; apelido: string | null };
  store?: { id: string; code: string; name: string } | null;
  documento?: { id: string; titulo: string; fileUrl: string } | null;
};

type Seller = { id: string; name: string; active: boolean };

const ymd = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const fmtData = (iso: string) => {
  try {
    // Coluna Date volta como 00:00Z — cortar a string evita o fuso puxar o dia
    // pra véspera, que é como a data "some" um dia na tela.
    const [a, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  } catch {
    return iso;
  }
};

const GRUPO_COR: Record<string, string> = {
  ausencia: 'bg-rose-100 text-rose-800',
  saude: 'bg-sky-100 text-sky-800',
  legal: 'bg-violet-100 text-violet-800',
  programado: 'bg-emerald-100 text-emerald-800',
  parcial: 'bg-amber-100 text-amber-800',
  disciplinar: 'bg-orange-100 text-orange-800',
  presente: 'bg-teal-100 text-teal-800',
};

export default function EventosRhPage() {
  const hoje = useMemo(() => new Date(), []);
  const inicioMes = useMemo(() => new Date(hoje.getFullYear(), hoje.getMonth(), 1), [hoje]);

  const [de, setDe] = useState(ymd(inicioMes));
  const [ate, setAte] = useState(ymd(hoje));
  const [sellerId, setSellerId] = useState('');
  const [tipoFiltro, setTipoFiltro] = useState('');

  const [tipos, setTipos] = useState<Tipo[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [abrirForm, setAbrirForm] = useState(false);

  useEffect(() => {
    api<Tipo[]>('/rh/eventos/tipos').then(setTipos).catch(() => setTipos([]));
    api<Seller[]>('/sellers?includeInactive=0').then(setSellers).catch(() => setSellers([]));
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const qs = new URLSearchParams({ de, ate });
      if (sellerId) qs.set('sellerId', sellerId);
      if (tipoFiltro) qs.set('tipo', tipoFiltro);
      setEventos(await api<Evento[]>(`/rh/eventos?${qs}`));
    } catch (e: any) {
      // Erro SOBE: tela de RH que devolve lista vazia em silêncio vira "não
      // tem nada lançado" e alguém lança o atestado de novo.
      setErro(e?.message || 'Não consegui carregar os eventos.');
      setEventos([]);
    } finally {
      setCarregando(false);
    }
  }, [de, ate, sellerId, tipoFiltro]);

  useEffect(() => { void carregar(); }, [carregar]);

  const atalho = (dias: number) => {
    const fim = new Date();
    const ini = new Date();
    ini.setDate(ini.getDate() - dias);
    setDe(ymd(ini));
    setAte(ymd(fim));
  };

  const cancelar = async (ev: Evento) => {
    const motivo = window.prompt(`Cancelar "${ev.tipoLabel}" de ${ev.seller?.name}?\n\nPor quê?`);
    if (!motivo?.trim()) return;
    try {
      await api(`/rh/eventos/${ev.id}/cancelar`, {
        method: 'POST',
        body: JSON.stringify({ motivo: motivo.trim() }),
      });
      void carregar();
    } catch (e: any) {
      alert(e?.message || 'Não consegui cancelar.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 text-white">
        <div className="max-w-7xl mx-auto px-4 py-5 flex items-center gap-3">
          <Link href="/retaguarda/rh" className="p-2 rounded-lg hover:bg-white/10 transition">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-2xl font-bold leading-tight">Eventos de RH</h1>
            <p className="text-white/70 text-sm">
              Atestado · falta · férias · treinamento — quem lança é a supervisão
            </p>
          </div>
          <button
            onClick={() => setAbrirForm(true)}
            className="flex items-center gap-2 bg-white text-slate-800 font-bold px-4 py-2 rounded-lg hover:bg-slate-100 transition"
          >
            <Plus className="w-4 h-4" /> Lançar evento
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {/* Recorte De/Até — padrão da casa, nunca dropdown de período fixo */}
        <div className="bg-white rounded-xl border p-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">De</label>
            <input type="date" value={de} onChange={(e) => setDe(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Até</label>
            <input type="date" value={ate} onChange={(e) => setAte(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="flex gap-1">
            {[['Hoje', 0], ['Ontem', 1], ['7 dias', 7], ['30 dias', 30]].map(([rot, d]) => (
              <button key={String(rot)} onClick={() => atalho(Number(d))}
                className="text-xs px-3 py-2 rounded-lg border hover:bg-slate-50 font-semibold">
                {rot}
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Funcionária</label>
            <select value={sellerId} onChange={(e) => setSellerId(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">Todas</option>
              {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="min-w-[180px]">
            <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Tipo</label>
            <select value={tipoFiltro} onChange={(e) => setTipoFiltro(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">Todos</option>
              {tipos.map((t) => <option key={t.codigo} value={t.codigo}>{t.label}</option>)}
            </select>
          </div>
          <button onClick={() => void carregar()}
            className="p-2 border rounded-lg hover:bg-slate-50" title="Recarregar">
            <RefreshCw className={`w-4 h-4 ${carregando ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {erro && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-xl p-4 flex gap-2 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0" /> {erro}
          </div>
        )}

        <div className="bg-white rounded-xl border overflow-hidden">
          {carregando ? (
            <div className="p-10 text-center text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin mx-auto" />
            </div>
          ) : eventos.length === 0 ? (
            <div className="p-10 text-center text-slate-400 text-sm">
              <CalendarDays className="w-8 h-8 mx-auto mb-2 opacity-40" />
              Nenhum evento nesse período.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-[11px] uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Funcionária</th>
                    <th className="px-3 py-2">Evento</th>
                    <th className="px-3 py-2">Período</th>
                    <th className="px-3 py-2">Efeito</th>
                    <th className="px-3 py-2">Lançado por</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {eventos.map((ev) => (
                    <tr key={ev.id} className={`border-t ${ev.canceladoAt ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-2 font-bold">
                        {ev.seller?.name ?? '—'}
                        {ev.store?.code && (
                          <span className="ml-2 text-[11px] text-slate-400">{ev.store.code}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-xs px-2 py-0.5 rounded font-bold ${GRUPO_COR[ev.grupo ?? ''] ?? 'bg-slate-100 text-slate-700'}`}>
                          {ev.tipoLabel}
                        </span>
                        {ev.documento && (
                          <a href={ev.documento.fileUrl} target="_blank" rel="noreferrer"
                            className="ml-2 inline-flex items-center gap-1 text-[11px] text-sky-700 underline">
                            <FileText className="w-3 h-3" /> doc
                          </a>
                        )}
                        {ev.observacoes && (
                          <div className="text-[11px] text-slate-500 mt-0.5">{ev.observacoes}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {fmtData(ev.dataInicio)}
                        {ev.dataFim.slice(0, 10) !== ev.dataInicio.slice(0, 10) && ` → ${fmtData(ev.dataFim)}`}
                        {!ev.diaInteiro && ev.horaInicio && (
                          <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-amber-700 font-bold">
                            <Clock className="w-3 h-3" />{ev.horaInicio}–{ev.horaFim}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[11px] space-x-1">
                        {ev.abonaJornada && <span className="text-emerald-700 font-semibold">abona</span>}
                        {ev.descontaSalario && <span className="text-rose-700 font-semibold">desconta</span>}
                        {ev.descontaDSR && <span className="text-rose-700 font-semibold">-DSR</span>}
                        {ev.contaArt130 && <span className="text-orange-700 font-semibold">art.130</span>}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-slate-500">
                        {ev.lancadoByNome ?? '—'}
                        {ev.canceladoAt && (
                          <div className="text-rose-600 font-bold">
                            CANCELADO — {ev.canceladoMotivo}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {!ev.canceladoAt && (
                          <button onClick={() => void cancelar(ev)}
                            className="p-1.5 rounded hover:bg-rose-50 text-rose-600" title="Cancelar evento">
                            <Ban className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {abrirForm && (
        <FormEvento
          tipos={tipos}
          sellers={sellers}
          onFechar={() => setAbrirForm(false)}
          onSalvo={() => { setAbrirForm(false); void carregar(); }}
        />
      )}
    </div>
  );
}

/** Formulário de lançamento. O TIPO escolhido comanda o que aparece. */
function FormEvento({
  tipos, sellers, onFechar, onSalvo,
}: {
  tipos: Tipo[];
  sellers: Seller[];
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const [sellerId, setSellerId] = useState('');
  const [tipo, setTipo] = useState('');
  const [dataInicio, setDataInicio] = useState(ymd(new Date()));
  const [dataFim, setDataFim] = useState(ymd(new Date()));
  const [diaInteiro, setDiaInteiro] = useState(true);
  const [horaInicio, setHoraInicio] = useState('08:00');
  const [horaFim, setHoraFim] = useState('12:00');
  const [observacoes, setObservacoes] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const t = tipos.find((x) => x.codigo === tipo) ?? null;

  // Tipo que não admite parcial volta pro dia inteiro sozinho — senão a tela
  // mostraria campos de hora que o backend ignora, que é porta falsa.
  useEffect(() => {
    if (t && !t.admiteParcial) setDiaInteiro(true);
  }, [t]);

  const salvar = async () => {
    setSalvando(true);
    setErro(null);
    try {
      await api('/rh/eventos', {
        method: 'POST',
        body: JSON.stringify({
          sellerId, tipo, dataInicio, dataFim,
          diaInteiro: t?.admiteParcial ? diaInteiro : true,
          horaInicio: !diaInteiro ? horaInicio : null,
          horaFim: !diaInteiro ? horaFim : null,
          observacoes: observacoes || null,
        }),
      });
      onSalvo();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui lançar.');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b sticky top-0 bg-white">
          <h2 className="font-bold text-lg">Lançar evento</h2>
          <button onClick={onFechar} className="p-1.5 rounded hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Funcionária</label>
            <select value={sellerId} onChange={(e) => setSellerId(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">Escolha…</option>
              {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Tipo</label>
            <select value={tipo} onChange={(e) => setTipo(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">Escolha…</option>
              {tipos.map((x) => <option key={x.codigo} value={x.codigo}>{x.label}</option>)}
            </select>
          </div>

          {/* O efeito é MOSTRADO, nunca escolhido — vem da régua do backend. */}
          {t && (
            <div className="bg-slate-50 border rounded-lg p-3 text-xs text-slate-600 space-y-1">
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
                <div>
                  <div className="font-bold text-slate-800">
                    {t.abonaJornada ? 'Abona a jornada do dia' : 'NÃO abona — o dia fica devendo'}
                    {t.descontaSalario && ' · desconta o dia'}
                    {t.descontaDSR && ' · perde o DSR da semana'}
                    {t.contaArt130 && ' · conta pro art. 130 (férias)'}
                  </div>
                  {t.nota && <div className="mt-1">{t.nota}</div>}
                  {t.limiteDias && <div className="mt-1">Máximo de {t.limiteDias} dia(s).</div>}
                  {t.exigeDocumento && (
                    <div className="mt-1 text-amber-700 font-semibold">
                      Exige documento anexado no prontuário da funcionária.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">De</label>
              <input type="date" value={dataInicio}
                onChange={(e) => {
                  setDataInicio(e.target.value);
                  if (e.target.value > dataFim) setDataFim(e.target.value);
                }}
                className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Até</label>
              <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>

          {t?.admiteParcial && (
            <div className="border rounded-lg p-3 space-y-3">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={!diaInteiro}
                  onChange={(e) => setDiaInteiro(!e.target.checked)} />
                Só parte do dia
              </label>
              {/* Ordem do dono: abate SOMENTE as horas informadas. */}
              {!diaInteiro && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Das</label>
                      <input type="time" value={horaInicio} onChange={(e) => setHoraInicio(e.target.value)}
                        className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Às</label>
                      <input type="time" value={horaFim} onChange={(e) => setHoraFim(e.target.value)}
                        className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Abate só essas horas da jornada — o resto do dia ela deve normalmente.
                  </p>
                </>
              )}
            </div>
          )}

          <div>
            <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">Observação</label>
            <textarea value={observacoes} onChange={(e) => setObservacoes(e.target.value)}
              rows={2} className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="Opcional — ex: atestado dr. Silva, CID informado" />
          </div>

          {erro && (
            <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-3 text-sm flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {erro}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t flex justify-end gap-2 sticky bottom-0 bg-white">
          <button onClick={onFechar} className="px-4 py-2 rounded-lg border font-semibold text-sm">
            Cancelar
          </button>
          <button
            onClick={() => void salvar()}
            disabled={!sellerId || !tipo || salvando}
            className="px-4 py-2 rounded-lg bg-slate-800 text-white font-bold text-sm disabled:opacity-40 flex items-center gap-2"
          >
            {salvando && <Loader2 className="w-4 h-4 animate-spin" />}
            Lançar
          </button>
        </div>
      </div>
    </div>
  );
}
