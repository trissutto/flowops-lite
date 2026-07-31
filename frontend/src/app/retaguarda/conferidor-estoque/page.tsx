'use client';

/**
 * /retaguarda/conferidor-estoque — CONFERIDOR FLOW × GIGA (só admin).
 *
 * O Flow é a fonte do estoque desde 14/07 e o Giga não sobrescreve mais nada.
 * Isso protege a verdade do Flow, mas faz a divergência ficar INVISÍVEL quando
 * alguém mexe no Wincred desktop ou uma réplica falha. Esta tela mostra, SKU a
 * SKU e loja a loja, só o que discorda — com o histórico do movimento ao lado
 * e um botão pra puxar o valor do Giga quando ele for o certo.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, Loader2, AlertTriangle, Download, History,
  ArrowDownToLine, Check, X, Search,
} from 'lucide-react';
import { api } from '@/lib/api';

type Linha = {
  codigo: string;
  loja: string;
  flow: number;
  giga: number;
  diferenca: number;
  tipo: 'DIFERENTE' | 'SO_NO_FLOW' | 'SO_NO_GIGA';
  descricao: string | null;
  ref: string | null;
};

type Resultado = {
  geradoEm: string;
  resumo: {
    linhasFlow: number; linhasGiga: number; conferidas: number; iguais: number;
    divergentes: number; diferentes: number; soNoFlow: number; soNoGiga: number;
    pecasAMais: number; pecasAMenos: number; negativosFlow: number; negativosGiga: number;
  };
  porLoja: Array<{ loja: string; divergentes: number; pecasAMais: number; pecasAMenos: number; negativosFlow: number; negativosGiga: number }>;
  linhas: Linha[];
  truncado: boolean;
};

const FILTROS = [
  { id: 'todas', label: 'Todas as divergências' },
  { id: 'diferente', label: 'Saldo diferente' },
  { id: 'so_flow', label: 'Só existe no Flow' },
  { id: 'so_giga', label: 'Só existe no Giga' },
  { id: 'negativo', label: 'Negativo em algum lado' },
];

export default function ConferidorEstoquePage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<Resultado | null>(null);

  const [loja, setLoja] = useState('');
  const [filtro, setFiltro] = useState('todas');
  const [minDif, setMinDif] = useState('1');
  const [q, setQ] = useState('');

  const [lojas, setLojas] = useState<Array<{ code: string; name: string }>>([]);
  const [puxando, setPuxando] = useState<string | null>(null);
  const [corrigidas, setCorrigidas] = useState<Set<string>>(new Set());

  const [hist, setHist] = useState<{ codigo: string; loja: string } | null>(null);
  const [histData, setHistData] = useState<any>(null);

  useEffect(() => {
    api<{ role: string }>('/auth/me')
      .then((me) => {
        if (me.role !== 'admin') { router.push('/'); return; }
        setAllowed(true);
      })
      .catch(() => router.push('/login'));
    api<Array<{ code: string; name: string }>>('/stores').then(setLojas).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const conferir = async () => {
    setBusy(true); setErr(''); setRes(null); setCorrigidas(new Set());
    try {
      const p = new URLSearchParams();
      if (loja) p.set('loja', loja);
      p.set('filtro', filtro);
      p.set('minDiferenca', minDif || '1');
      p.set('limite', '2000');
      const r = await api<Resultado>(`/stock-conferidor/conferir?${p.toString()}`);
      setRes(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha na conferência');
    } finally {
      setBusy(false);
    }
  };

  // Passivo negativo que o Giga tem e o Flow nunca viu (os dois filtros que
  // escondiam negativo caíram em 31/07, mas só valem daqui pra frente).
  const [impBusy, setImpBusy] = useState(false);
  const [impRes, setImpRes] = useState<any>(null);

  const importarNegativos = async (simular: boolean) => {
    if (impBusy) return;
    if (!simular && !confirm(
      `Trazer ${impRes?.encontrados ?? 'os'} negativo(s) do Giga pro Flow?\n\n` +
      'Só mexe em SKU/loja que está NEGATIVO no Giga e não bate no Flow.\n' +
      'Nada positivo é tocado. Tudo fica registrado no histórico.',
    )) return;
    setImpBusy(true);
    try {
      const r = await api<any>('/stock-conferidor/importar-negativos', {
        method: 'POST',
        body: JSON.stringify({ loja: loja || undefined, simular }),
      });
      setImpRes(r);
      if (!simular) await conferir();
    } catch (e: any) {
      setErr(e?.message || 'Falha na importação');
    } finally {
      setImpBusy(false);
    }
  };

  const puxar = async (l: Linha) => {
    const k = `${l.codigo}|${l.loja}`;
    setPuxando(k);
    try {
      await api('/stock-conferidor/puxar-giga', {
        method: 'POST',
        body: JSON.stringify({ codigo: l.codigo, loja: l.loja }),
      });
      setCorrigidas((prev) => new Set(prev).add(k));
    } catch (e: any) {
      setErr(e?.message || 'Falha ao puxar do Giga');
    } finally {
      setPuxando(null);
    }
  };

  const abrirHist = async (l: Linha) => {
    setHist({ codigo: l.codigo, loja: l.loja });
    setHistData(null);
    try {
      const d = await api<any>(`/stock-conferidor/historico?codigo=${l.codigo}&loja=${l.loja}`);
      setHistData(d);
    } catch (e: any) {
      setHistData({ erro: e?.message || 'Falha', movimentos: [], vendasGiga: [] });
    }
  };

  const nomeLoja = (code: string) =>
    lojas.find((s) => String(s.code).padStart(2, '0') === code)?.name || `Loja ${code}`;

  const visiveis = useMemo(() => {
    if (!res) return [];
    const t = q.trim().toLowerCase();
    if (!t) return res.linhas;
    return res.linhas.filter(
      (l) =>
        l.codigo.includes(t) ||
        (l.ref || '').toLowerCase().includes(t) ||
        (l.descricao || '').toLowerCase().includes(t),
    );
  }, [res, q]);

  const baixarCsv = () => {
    if (!res) return;
    const head = 'codigo;ref;descricao;loja;flow;giga;diferenca;tipo';
    const body = res.linhas
      .map((l) => [l.codigo, l.ref || '', (l.descricao || '').replace(/;/g, ','), l.loja, l.flow, l.giga, l.diferenca, l.tipo].join(';'))
      .join('\n');
    const blob = new Blob([`﻿${head}\n${body}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `conferencia-estoque-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  if (!allowed) return null;

  const r = res?.resumo;

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex items-center gap-3">
          <Link href="/retaguarda" className="rounded-lg border bg-white p-2 hover:bg-slate-100">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Conferidor de estoque · Flow × Giga</h1>
            <p className="text-sm text-slate-500">
              Lista só o que diverge. O Flow continua sendo a fonte — puxar do Giga é correção manual, item a item.
            </p>
          </div>
        </div>

        {/* Filtros */}
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border bg-white p-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Loja</label>
            <select value={loja} onChange={(e) => setLoja(e.target.value)} className="rounded-lg border px-3 py-2 text-sm">
              <option value="">Todas</option>
              {lojas.map((s) => (
                <option key={s.code} value={String(s.code).padStart(2, '0')}>
                  {String(s.code).padStart(2, '0')} · {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Mostrar</label>
            <select value={filtro} onChange={(e) => setFiltro(e.target.value)} className="rounded-lg border px-3 py-2 text-sm">
              {FILTROS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Diferença mínima</label>
            <input
              type="number" min={1} value={minDif} onChange={(e) => setMinDif(e.target.value)}
              className="w-28 rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={conferir} disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {busy ? 'Conferindo…' : 'Conferir agora'}
          </button>
          {res && (
            <button onClick={baixarCsv} className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm hover:bg-slate-100">
              <Download className="h-4 w-4" /> CSV
            </button>
          )}
          {busy && (
            <span className="text-xs text-slate-500">
              Lê a tabela `estoque` inteira do Giga — pode levar ~1 min.
            </span>
          )}
        </div>

        {err && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {err}
          </div>
        )}

        {/* Passivo negativo do Giga que o Flow nunca enxergou */}
        <div className="mb-4 rounded-xl border-2 border-amber-200 bg-amber-50/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <div className="font-bold text-amber-900">Negativos que o Flow nunca viu</div>
              <p className="text-xs text-amber-800">
                O espelho descartava linha negativa e o write-through gravava 0 — por isso a tela
                mostrava “·” onde a loja devia peça. Os dois filtros caíram, mas só valem daqui pra
                frente. Isso traz o passivo antigo. Só mexe no que está negativo no Giga.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => importarNegativos(true)} disabled={impBusy}
                className="rounded-lg border border-amber-400 px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                {impBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Simular'}
              </button>
              <button
                onClick={() => importarNegativos(false)} disabled={impBusy}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                Importar negativos
              </button>
            </div>
          </div>
          {impRes && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-white p-3 text-sm">
              <b>{impRes.encontrados}</b> negativo(s) no Giga ·{' '}
              <b>{impRes.jaBatiam}</b> já batiam no Flow ·{' '}
              <b className="text-amber-700">
                {impRes.simulado ? `${impRes.encontrados - impRes.jaBatiam} a importar` : `${impRes.importados} importados`}
              </b>
              {impRes.amostra?.length > 0 && (
                <div className="mt-2 max-h-40 overflow-y-auto font-mono text-xs text-slate-600">
                  {impRes.amostra.map((a: any, i: number) => (
                    <div key={i}>
                      {a.codigo} · loja {a.loja} · Flow {a.flow} → <b className="text-red-600">{a.giga}</b>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {r && (
          <>
            {/* Placar */}
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
              {[
                { l: 'SKUs conferidos', v: r.conferidas.toLocaleString('pt-BR'), c: 'text-slate-900' },
                { l: 'Batem', v: r.iguais.toLocaleString('pt-BR'), c: 'text-emerald-600' },
                { l: 'Divergentes', v: r.divergentes.toLocaleString('pt-BR'), c: r.divergentes ? 'text-red-600' : 'text-emerald-600' },
                { l: 'Peças a MAIS no Flow', v: r.pecasAMais.toLocaleString('pt-BR'), c: 'text-amber-600' },
                { l: 'Peças a MENOS no Flow', v: r.pecasAMenos.toLocaleString('pt-BR'), c: 'text-amber-600' },
                { l: 'Negativos (Flow / Giga)', v: `${r.negativosFlow} / ${r.negativosGiga}`, c: 'text-slate-700' },
              ].map((k) => (
                <div key={k.l} className="rounded-xl border bg-white p-3">
                  <div className="text-xs text-slate-500">{k.l}</div>
                  <div className={`text-xl font-bold tabular-nums ${k.c}`}>{k.v}</div>
                </div>
              ))}
            </div>

            {/* Por loja */}
            {res!.porLoja.length > 0 && (
              <div className="mb-4 overflow-x-auto rounded-xl border bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Loja</th>
                      <th className="px-3 py-2 text-right">Divergentes</th>
                      <th className="px-3 py-2 text-right">A mais no Flow</th>
                      <th className="px-3 py-2 text-right">A menos no Flow</th>
                      <th className="px-3 py-2 text-right">Neg. Flow</th>
                      <th className="px-3 py-2 text-right">Neg. Giga</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res!.porLoja.map((l) => (
                      <tr key={l.loja} className="border-t">
                        <td className="px-3 py-2 font-medium">{l.loja} · {nomeLoja(l.loja)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">{l.divergentes}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-amber-700">{l.pecasAMais || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-amber-700">{l.pecasAMenos || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{l.negativosFlow || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{l.negativosGiga || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Lista */}
            <div className="mb-3 flex items-center gap-2">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder="Filtrar por SKU, REF ou descrição…"
                  className="w-full rounded-lg border py-2 pl-9 pr-3 text-sm"
                />
              </div>
              <span className="text-xs text-slate-500">
                {visiveis.length.toLocaleString('pt-BR')} linha(s)
                {res!.truncado && ' · lista cortada no limite — use os filtros'}
              </span>
            </div>

            <div className="overflow-x-auto rounded-xl border bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">SKU</th>
                    <th className="px-3 py-2 text-left">REF</th>
                    <th className="px-3 py-2 text-left">Descrição</th>
                    <th className="px-3 py-2 text-left">Loja</th>
                    <th className="px-3 py-2 text-right">Flow</th>
                    <th className="px-3 py-2 text-right">Giga</th>
                    <th className="px-3 py-2 text-right">Dif.</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((l) => {
                    const k = `${l.codigo}|${l.loja}`;
                    const ok = corrigidas.has(k);
                    return (
                      <tr key={k} className={`border-t ${ok ? 'bg-emerald-50' : ''}`}>
                        <td className="px-3 py-2 font-mono text-xs">{l.codigo}</td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-500">{l.ref || '—'}</td>
                        <td className="max-w-xs truncate px-3 py-2">{l.descricao || '—'}</td>
                        <td className="px-3 py-2 text-xs">{l.loja} · {nomeLoja(l.loja)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums font-semibold ${l.flow < 0 ? 'text-red-600' : ''}`}>{l.flow}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${l.giga < 0 ? 'text-red-600' : ''}`}>{l.giga}</td>
                        <td className={`px-3 py-2 text-right tabular-nums font-bold ${l.diferenca > 0 ? 'text-amber-600' : 'text-blue-600'}`}>
                          {l.diferenca > 0 ? `+${l.diferenca}` : l.diferenca}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => abrirHist(l)} title="Histórico" className="rounded p-1.5 hover:bg-slate-100">
                              <History className="h-3.5 w-3.5" />
                            </button>
                            {ok ? (
                              <span className="flex items-center gap-1 rounded px-2 py-1 text-xs text-emerald-700">
                                <Check className="h-3.5 w-3.5" /> corrigido
                              </span>
                            ) : (
                              <button
                                onClick={() => puxar(l)} disabled={puxando === k}
                                title="Gravar o valor do Giga no Flow"
                                className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                              >
                                {puxando === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />}
                                puxar Giga
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!visiveis.length && (
                    <tr><td colSpan={8} className="px-3 py-10 text-center text-slate-500">Nenhuma divergência com esses filtros.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {!res && !busy && !err && (
          <div className="rounded-xl border bg-white p-10 text-center text-slate-500">
            Clique em <b>Conferir agora</b> pra comparar os dois estoques.
          </div>
        )}
      </div>

      {/* Histórico */}
      {hist && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 md:items-center md:p-6" onClick={() => setHist(null)}>
          <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-5 md:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="font-bold text-slate-900">Histórico · SKU {hist.codigo}</h2>
                <p className="text-xs text-slate-500">Loja {hist.loja} · {nomeLoja(hist.loja)}</p>
              </div>
              <button onClick={() => setHist(null)} className="rounded p-1 hover:bg-slate-100"><X className="h-4 w-4" /></button>
            </div>
            {!histData ? (
              <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
            ) : (
              <div className="space-y-5">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Movimentos registrados no Flow</h3>
                  {histData.movimentos?.length ? (
                    <ul className="space-y-1 text-sm">
                      {histData.movimentos.map((m: any, i: number) => (
                        <li key={i} className="flex items-baseline gap-2 border-b py-1.5">
                          <span className="w-32 shrink-0 text-xs text-slate-500">
                            {new Date(m.createdAt).toLocaleString('pt-BR')}
                          </span>
                          <span className={`w-12 shrink-0 text-right font-semibold tabular-nums ${m.delta > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {m.delta > 0 ? `+${m.delta}` : m.delta}
                          </span>
                          <span className="w-20 shrink-0 text-xs tabular-nums text-slate-400">{m.qtyBefore}→{m.qtyAfter}</span>
                          <span className="text-xs">{m.reason}{m.note ? ` · ${m.note}` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-500">Nenhum movimento registrado no Flow.</p>
                  )}
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Vendas no Giga (caixa)</h3>
                  {histData.vendasGiga?.length ? (
                    <ul className="space-y-1 text-sm">
                      {histData.vendasGiga.map((v: any, i: number) => (
                        <li key={i} className="flex items-baseline gap-3 border-b py-1.5">
                          <span className="w-24 shrink-0 text-xs text-slate-500">
                            {String(v.data).slice(0, 10).split('-').reverse().join('/')}
                          </span>
                          <span className="tabular-nums">{v.qtd} un</span>
                          <span className="text-xs text-slate-400">vend. {v.vendedor}{v.obs ? ` · ${v.obs}` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-500">Nenhuma venda desse SKU nessa loja.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
