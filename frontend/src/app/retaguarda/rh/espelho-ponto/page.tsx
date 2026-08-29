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
  Edit3, Plus, Clock, Users, RefreshCw, Search, Smartphone, Monitor,
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
    // Evento de RH que explica o dia (atestado, férias, treinamento).
    eventos?: Array<{ tipo: string; label: string }>;
    minAbonado?: number;
    abonado?: boolean;
    faltaInjustificada?: boolean;
  }>;
  totais: {
    minTrabalhado: number;
    minPrevisto: number;
    saldoMin: number;
    minAbonado?: number;
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

// ── TELA DO DIA (dono 30/07): batidas de todas em tempo real ──
type DiaFunc = {
  sellerId: string;
  nome: string;
  nomeCompleto: string | null;
  cargo: string | null;
  storeCode: string;
  storeName: string;
  status: 'trabalhando' | 'almoco' | 'saiu' | 'incompleto';
  ultimaHora: string | null;
  batidas: Array<{ id: string; tipo: string; hora: string; source: string; justificado: boolean }>;
};
type DiaView = {
  data: string;
  geradoEm: string;
  totais: { funcionarias: number; trabalhando: number; almoco: number; sairam: number; batidas: number };
  lojas: Array<{ storeId: string; storeCode: string; storeName: string; funcionarias: DiaFunc[] }>;
};

const TIPO_LABEL: Record<string, string> = {
  entrada: 'E', saida_almoco: 'SA', volta_almoco: 'VA', saida: 'S',
};
const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  trabalhando: { label: '🟢 Trabalhando', cls: 'bg-emerald-100 text-emerald-800' },
  almoco: { label: '🍽️ Almoço', cls: 'bg-amber-100 text-amber-800' },
  saiu: { label: 'Saiu', cls: 'bg-slate-100 text-slate-600' },
  incompleto: { label: '⚠️ Incompleto', cls: 'bg-rose-100 text-rose-700' },
};

const hojeInput = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function EspelhoPontoPage() {
  const now = new Date();
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [sellerId, setSellerId] = useState<string>('');
  const [ano, setAno] = useState(now.getFullYear());
  const [mes, setMes] = useState(now.getMonth() + 1);
  const [espelho, setEspelho] = useState<Espelho | null>(null);
  const [loading, setLoading] = useState(false);

  // ── TELA DO DIA (default): todas as batidas, ao vivo ──
  const [modo, setModo] = useState<'dia' | 'mes'>('dia');
  const [diaData, setDiaData] = useState(hojeInput());
  const [dia, setDia] = useState<DiaView | null>(null);
  const [diaLoading, setDiaLoading] = useState(false);
  const [diaBusca, setDiaBusca] = useState('');

  const loadDia = () => {
    setDiaLoading(true);
    api<DiaView>(`/ponto/dia?data=${diaData}`)
      .then(setDia)
      .catch(() => setDia(null))
      .finally(() => setDiaLoading(false));
  };

  // ── Corrigir/excluir batida errada (dono 30/07) ──
  const [editBatida, setEditBatida] = useState<{
    id: string; funcNome: string; tipo: string; hora: string;
  } | null>(null);
  const [editTipo, setEditTipo] = useState('entrada');
  const [editHora, setEditHora] = useState('');
  const [editJust, setEditJust] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  const abrirEdicao = (f: DiaFunc, b: DiaFunc['batidas'][0]) => {
    const hhmm = new Date(b.hora).toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    });
    setEditBatida({ id: b.id, funcNome: f.nome, tipo: b.tipo, hora: hhmm });
    setEditTipo(b.tipo);
    setEditHora(hhmm);
    setEditJust('');
  };

  const salvarEdicao = async () => {
    if (!editBatida) return;
    if (editJust.trim().length < 3) { alert('Escreva a justificativa (mínimo 3 letras).'); return; }
    setEditBusy(true);
    try {
      // Horário editado é no dia selecionado, em horário de Brasília
      const timestamp = new Date(`${diaData}T${editHora}:00-03:00`).toISOString();
      await api(`/ponto/registro/${editBatida.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ tipo: editTipo, timestamp, justificativa: editJust.trim() }),
      });
      setEditBatida(null);
      loadDia();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const excluirBatida = async () => {
    if (!editBatida) return;
    if (editJust.trim().length < 3) { alert('Escreva o motivo da exclusão (mínimo 3 letras).'); return; }
    if (!confirm(`EXCLUIR a batida ${TIPO_LABEL[editBatida.tipo] || editBatida.tipo} ${editBatida.hora} de ${editBatida.funcNome}?`)) return;
    setEditBusy(true);
    try {
      await api(`/ponto/registro/${editBatida.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ motivo: editJust.trim() }),
      });
      setEditBatida(null);
      loadDia();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setEditBusy(false);
    }
  };
  useEffect(() => {
    if (modo !== 'dia') return;
    loadDia();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modo, diaData]);
  // Tempo real prático: repuxa a cada 30s enquanto a aba Dia está aberta
  useEffect(() => {
    if (modo !== 'dia') return;
    const t = setInterval(loadDia, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modo, diaData]);

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
        {/* Abas: Dia (ao vivo) × Espelho mensal */}
        <div className="flex gap-2">
          <button
            onClick={() => setModo('dia')}
            className={`px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 ${
              modo === 'dia' ? 'bg-emerald-600 text-white shadow' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Clock className="w-4 h-4" /> Dia (ao vivo)
          </button>
          <button
            onClick={() => setModo('mes')}
            className={`px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 ${
              modo === 'mes' ? 'bg-emerald-600 text-white shadow' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Calendar className="w-4 h-4" /> Espelho mensal
          </button>
        </div>

        {/* ── TELA DO DIA ── */}
        {modo === 'dia' && (
          <>
            <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center gap-3">
              <input
                type="date"
                value={diaData}
                onChange={(e) => setDiaData(e.target.value)}
                className="px-3 py-2 border rounded text-sm"
              />
              <button
                onClick={() => setDiaData(hojeInput())}
                className="px-3 py-2 rounded border border-slate-200 text-sm font-bold text-slate-600 hover:bg-slate-50"
              >
                Hoje
              </button>
              <div className="relative flex-1 min-w-[180px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  value={diaBusca}
                  onChange={(e) => setDiaBusca(e.target.value)}
                  placeholder="Buscar funcionária ou loja…"
                  className="w-full pl-8 pr-3 py-2 border rounded text-sm"
                />
              </div>
              <button
                onClick={loadDia}
                className="p-2 rounded border border-slate-200 hover:bg-slate-50"
                title="Atualizar agora (atualiza sozinho a cada 30s)"
              >
                <RefreshCw className={`w-4 h-4 text-slate-600 ${diaLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {dia && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatBox label="Bateram ponto" value={String(dia.totais.funcionarias)} color="slate" />
                <StatBox label="🟢 Trabalhando" value={String(dia.totais.trabalhando)} color="emerald" />
                <StatBox label="🍽️ No almoço" value={String(dia.totais.almoco)} color="slate" />
                <StatBox label="Já saíram" value={String(dia.totais.sairam)} color="slate" />
              </div>
            )}

            {diaLoading && !dia && (
              <div className="text-center py-8">
                <Loader2 className="w-6 h-6 animate-spin mx-auto text-emerald-600" />
              </div>
            )}

            {dia && dia.lojas.length === 0 && (
              <div className="bg-white border border-dashed border-slate-300 rounded-xl p-8 text-center text-sm text-slate-500">
                Nenhuma batida registrada neste dia (ainda).
              </div>
            )}

            {dia && dia.lojas
              .map((l) => ({
                ...l,
                funcionarias: l.funcionarias.filter((f) => {
                  const q = diaBusca.trim().toUpperCase();
                  if (!q) return true;
                  return (
                    f.nome.toUpperCase().includes(q) ||
                    (f.nomeCompleto || '').toUpperCase().includes(q) ||
                    l.storeName.toUpperCase().includes(q) ||
                    l.storeCode.toUpperCase().includes(q)
                  );
                }),
              }))
              .filter((l) => l.funcionarias.length > 0)
              .map((l) => (
                <div key={l.storeId} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-2 bg-slate-100 border-b border-slate-200 flex items-center gap-2">
                    <Users className="w-4 h-4 text-slate-600" />
                    <span className="font-bold text-sm text-slate-800">
                      {l.storeCode} {l.storeName}
                    </span>
                    <span className="text-xs text-slate-500">({l.funcionarias.length})</span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {l.funcionarias.map((f) => (
                      <div
                        key={f.sellerId}
                        className="px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 hover:bg-slate-50 cursor-pointer"
                        title="Clique pra abrir o espelho mensal"
                        onClick={() => { setSellerId(f.sellerId); setModo('mes'); }}
                      >
                        <div className="min-w-[160px]">
                          <span className="font-bold text-sm text-slate-800">{f.nome}</span>
                          {f.cargo && f.cargo !== 'VENDEDORA' && (
                            <span className="ml-2 text-[10px] uppercase text-slate-400">{f.cargo}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 font-mono text-xs">
                          {f.batidas.map((b) => (
                            <button
                              key={b.id}
                              type="button"
                              title={`${b.tipo} · ${b.source}${b.justificado ? ' · justificado' : ''} — clique pra corrigir/excluir`}
                              onClick={(e) => { e.stopPropagation(); abrirEdicao(f, b); }}
                              className={`px-1.5 py-0.5 rounded border hover:ring-2 hover:ring-slate-300 ${
                                b.tipo === 'entrada'
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                  : b.tipo === 'saida'
                                    ? 'border-slate-200 bg-slate-50 text-slate-600'
                                    : 'border-amber-200 bg-amber-50 text-amber-800'
                              }`}
                            >
                              {TIPO_LABEL[b.tipo] || b.tipo} {fmtHora(b.hora)}
                              {b.source === 'pwa_selfie' ? ' 📱' : b.source === 'manual_admin' ? ' ✍️' : ''}
                              {b.justificado ? ' *' : ''}
                            </button>
                          ))}
                        </div>
                        <span className={`ml-auto text-[11px] font-bold px-2 py-0.5 rounded-full ${STATUS_PILL[f.status]?.cls || ''}`}>
                          {STATUS_PILL[f.status]?.label || f.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

            {dia && (
              <p className="text-[11px] text-slate-400 text-right">
                Atualiza sozinho a cada 30s · clique numa batida pra corrigir/excluir · E entrada · SA saída almoço · VA volta · S saída · 📱 celular · ✍️ manual · * corrigida
              </p>
            )}

            {/* Modal corrigir/excluir batida */}
            {editBatida && (
              <div
                className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
                onClick={() => !editBusy && setEditBatida(null)}
              >
                <div
                  className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-5 space-y-3"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="font-black text-slate-800 flex items-center gap-2">
                    <Edit3 className="w-4 h-4 text-slate-600" />
                    Corrigir batida — {editBatida.funcNome}
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Tipo</label>
                      <select
                        value={editTipo}
                        onChange={(e) => setEditTipo(e.target.value)}
                        className="w-full px-3 py-2 border rounded text-sm"
                      >
                        <option value="entrada">Entrada</option>
                        <option value="saida_almoco">Saída almoço</option>
                        <option value="volta_almoco">Volta almoço</option>
                        <option value="saida">Saída</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Horário</label>
                      <input
                        type="time"
                        value={editHora}
                        onChange={(e) => setEditHora(e.target.value)}
                        className="w-full px-3 py-2 border rounded text-sm font-mono"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                      Justificativa / motivo <span className="text-rose-600">*</span>
                    </label>
                    <textarea
                      value={editJust}
                      onChange={(e) => setEditJust(e.target.value)}
                      rows={2}
                      placeholder="Ex.: bateu duas vezes sem querer / horário errado"
                      className="w-full px-3 py-2 border rounded text-sm"
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={excluirBatida}
                      disabled={editBusy}
                      className="px-3 py-2 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 font-bold text-sm disabled:opacity-50"
                    >
                      Excluir
                    </button>
                    <button
                      onClick={() => setEditBatida(null)}
                      disabled={editBusy}
                      className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 font-bold text-sm disabled:opacity-50"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={salvarEdicao}
                      disabled={editBusy}
                      className="flex-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm disabled:opacity-50"
                    >
                      {editBusy ? '...' : 'Salvar'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {modo === 'mes' && (
        <>
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
                      // Dia com evento que abona NÃO é falta. O abono parcial
                      // (atestado de meio período) deixa previsto > 0, então o
                      // `!d.abonado` é o que segura — sem ele a tela voltaria a
                      // chamar de FALTA quem estava com atestado até meio-dia.
                      const isFalta =
                        !d.folga && d.minPrevisto > 0 && d.minTrabalhado === 0 && !d.abonado;
                      const evento = d.eventos?.[0];
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
                                : evento
                                  ? 'bg-sky-50'
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
                            ) : evento ? (
                              // O evento vem ANTES da falta: a razão do dia
                              // vazio é a notícia, não o vazio.
                              <span
                                className="text-xs bg-sky-100 text-sky-800 px-2 py-0.5 rounded font-bold"
                                title={
                                  d.minAbonado
                                    ? `Abonado ${fmtMin(d.minAbonado)}`
                                    : undefined
                                }
                              >
                                {evento.label.toUpperCase()}
                                {d.eventos && d.eventos.length > 1
                                  ? ` +${d.eventos.length - 1}`
                                  : ''}
                              </span>
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
        </>
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
