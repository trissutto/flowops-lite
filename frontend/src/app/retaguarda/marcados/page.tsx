'use client';

/**
 * /retaguarda/marcados — visão geral dos MARCADOS (provar em casa) da rede.
 *
 * Lista TUDO que está em marca (caixa do Giga, MARCADO='SIM') agrupado POR
 * CLIENTE, em cascata: clica na cliente → abre as peças dela (data, SKU,
 * descrição, valor, loja). Filtro De/Até + atalhos + loja (convenção da casa).
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Tag, Loader2, RefreshCw, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { api } from '@/lib/api';

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (s: any) => (s ? new Date(s).toLocaleDateString('pt-BR') : '—');
const iso = (d: Date) => d.toISOString().slice(0, 10);

type Row = {
  REGISTRO: number;
  DATA: string;
  CODIGO: string;
  DESCRICAO: string;
  QUANTIDADE: number;
  VALOR: number;
  VALORTOTAL: number;
  LOJA: string;
  codCliente: number | string;
  clienteNome?: string | null;
  classificacao?: string | null;
};

type Grupo = {
  key: string;
  codCliente: string;
  nome: string;
  classificacao: string;
  qtd: number;
  total: number;
  lojas: string[];
  itens: Row[];
  maisAntiga: string | null;
};

export default function RetaguardaMarcadosPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 'flow' = tabela nativa (instantâneo) · 'giga' = ao vivo no ERP (lento)
  const [fonte, setFonte] = useState<string | null>(null);
  const [truncado, setTruncado] = useState(false);
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [loja, setLoja] = useState('');
  const [lojas, setLojas] = useState<Array<{ code: string; name: string }>>([]);
  const [filtroNome, setFiltroNome] = useState('');
  const [abertos, setAbertos] = useState<Set<string>>(new Set());

  useEffect(() => { api<any[]>('/stores').then((r) => setLojas(r || [])).catch(() => {}); }, []);

  const carregar = async (pDe = de, pAte = ate, pLoja = loja) => {
    setLoading(true); setErr(null);
    try {
      const qs = new URLSearchParams({ limit: '10000' });
      if (pLoja) qs.set('loja', pLoja);
      if (pDe) qs.set('dataInicial', pDe);
      if (pAte) qs.set('dataFinal', pAte);
      const r = await api<{ rows: Row[]; total: number; truncado?: boolean; fonte?: string; error?: string }>(`/pdv/marcados?${qs.toString()}`);
      setRows(Array.isArray(r?.rows) ? r.rows : []);
      setFonte(r?.fonte || null);
      setTruncado(!!r?.truncado);
      if (r?.error) setErr(r.error);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao carregar (Giga pode estar lento) — tenta de novo');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { carregar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const atalho = (tipo: 'hoje' | 'ontem' | '7d' | 'mes' | 'tudo') => {
    const hoje = new Date();
    let nDe = '', nAte = '';
    if (tipo === 'hoje') { nDe = iso(hoje); nAte = iso(hoje); }
    if (tipo === 'ontem') { const d = new Date(hoje); d.setDate(d.getDate() - 1); nDe = iso(d); nAte = iso(d); }
    if (tipo === '7d') { const d = new Date(hoje); d.setDate(d.getDate() - 7); nDe = iso(d); nAte = iso(hoje); }
    if (tipo === 'mes') { nDe = iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)); nAte = iso(hoje); }
    setDe(nDe); setAte(nAte);
    carregar(nDe, nAte, loja);
  };

  const grupos: Grupo[] = useMemo(() => {
    const map = new Map<string, Grupo>();
    for (const r of rows) {
      const cod = String(r.codCliente ?? '').trim();
      const nome = String(r.clienteNome || '').trim() || `CLIENTE ${cod || '?'}`;
      const key = `${cod}|${nome}`;
      let g = map.get(key);
      if (!g) {
        g = { key, codCliente: cod, nome, classificacao: String(r.classificacao || '').trim().toUpperCase(), qtd: 0, total: 0, lojas: [], itens: [], maisAntiga: null };
        map.set(key, g);
      }
      g.qtd += Number(r.QUANTIDADE) || 1;
      g.total += Number(r.VALORTOTAL) || Number(r.VALOR) || 0;
      const lj = String(r.LOJA || '').trim();
      if (lj && !g.lojas.includes(lj)) g.lojas.push(lj);
      g.itens.push(r);
      const dt = r.DATA ? String(r.DATA) : null;
      if (dt && (!g.maisAntiga || dt < g.maisAntiga)) g.maisAntiga = dt;
    }
    let list = Array.from(map.values());
    const f = filtroNome.trim().toUpperCase();
    if (f) list = list.filter((g) => g.nome.toUpperCase().includes(f) || g.codCliente.includes(f));
    list.sort((a, b) => b.total - a.total);
    // Itens de cada cliente: mais novos primeiro
    for (const g of list) g.itens.sort((a, b) => String(b.DATA || '').localeCompare(String(a.DATA || '')));
    return list;
  }, [rows, filtroNome]);

  const totalGeral = grupos.reduce((s, g) => s + g.total, 0);
  const qtdGeral = grupos.reduce((s, g) => s + g.qtd, 0);

  const toggle = (key: string) => {
    setAbertos((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-[#FAFAF7] pb-16 text-slate-800">
      <header className="bg-white border-b border-[#E7E2D8] sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800"><ArrowLeft className="w-5 h-5" /></Link>
          <Tag className="w-5 h-5 text-[#B8912B]" />
          <div className="flex-1">
            <h1 className="font-bold text-lg">Marcados por cliente</h1>
            <p className="text-xs text-slate-500">Tudo que está &quot;em marca&quot; (provar em casa) na rede — clique na cliente pra abrir as peças</p>
          </div>
          <button onClick={() => carregar()} disabled={loading}
            className="rounded-lg border border-[#E7E2D8] px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5 space-y-4">
        {/* Filtros — De/Até + atalhos + loja (convenção da casa) */}
        <div className="bg-white rounded-xl border border-[#E7E2D8] p-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="text-[10px] uppercase font-bold text-slate-400 block">De</label>
            <input type="date" value={de} onChange={(e) => setDe(e.target.value)}
              className="rounded-lg border border-[#E7E2D8] px-2 py-1.5 text-sm focus:border-[#D4AF37] focus:outline-none" />
          </div>
          <div>
            <label className="text-[10px] uppercase font-bold text-slate-400 block">Até</label>
            <input type="date" value={ate} onChange={(e) => setAte(e.target.value)}
              className="rounded-lg border border-[#E7E2D8] px-2 py-1.5 text-sm focus:border-[#D4AF37] focus:outline-none" />
          </div>
          <div className="flex gap-1">
            {([['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', '7 dias'], ['mes', 'Mês'], ['tudo', 'Tudo']] as const).map(([k, l]) => (
              <button key={k} onClick={() => atalho(k)}
                className="rounded-lg border border-[#E7E2D8] px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-[#FBF6E6] hover:border-[#D4AF37]">
                {l}
              </button>
            ))}
          </div>
          <div>
            <label className="text-[10px] uppercase font-bold text-slate-400 block">Loja</label>
            <select value={loja} onChange={(e) => { setLoja(e.target.value); carregar(de, ate, e.target.value); }}
              className="rounded-lg border border-[#E7E2D8] px-2 py-1.5 text-sm focus:border-[#D4AF37] focus:outline-none">
              <option value="">Todas</option>
              {lojas.map((l) => <option key={l.code} value={l.code}>{l.code} · {l.name}</option>)}
            </select>
          </div>
          <button onClick={() => carregar()} disabled={loading}
            className="rounded-lg bg-[#B8912B] hover:bg-[#8C7325] text-white text-sm font-bold px-4 py-2 disabled:opacity-50">
            Filtrar
          </button>
          <div className="relative ml-auto">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={filtroNome} onChange={(e) => setFiltroNome(e.target.value)} placeholder="Filtrar cliente…"
              className="rounded-lg border border-[#E7E2D8] pl-8 pr-3 py-2 text-sm focus:border-[#D4AF37] focus:outline-none w-52" />
          </div>
        </div>

        {/* Resumo */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white rounded-xl border border-[#E7E2D8] p-3 text-center">
            <div className="text-[10px] uppercase font-bold text-slate-400">Clientes com marca</div>
            <div className="text-xl font-black text-slate-800">{grupos.length}</div>
          </div>
          <div className="bg-white rounded-xl border border-[#E7E2D8] p-3 text-center">
            <div className="text-[10px] uppercase font-bold text-slate-400">Peças em marca</div>
            <div className="text-xl font-black text-slate-800">{qtdGeral}</div>
          </div>
          <div className="bg-white rounded-xl border border-[#E7E2D8] p-3 text-center">
            <div className="text-[10px] uppercase font-bold text-slate-400">Valor total</div>
            <div className="text-xl font-black text-[#2E7D46]">{brl(totalGeral)}</div>
          </div>
        </div>

        {err && (
          <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-sm text-amber-800">
            ⚠️ {err}
          </div>
        )}
        {fonte === 'giga' && !err && (
          <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-xs text-amber-800">
            ⚠️ Lendo do <b>Giga ao vivo</b> (lento e sujeito a queda). Rode{' '}
            <Link href="/retaguarda/wincred-mirror" className="underline font-bold">Importar marcados do Giga</Link>{' '}
            uma vez — a tela passa a ler o Flow e responde na hora.
          </div>
        )}
        {(truncado || (fonte === 'giga' && rows.length >= 500)) && (
          <div className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-xs text-sky-800">
            Mostrando as {rows.length.toLocaleString('pt-BR')} marcações mais recentes (tem mais além dessas) — use o filtro de data/loja pra fechar o recorte.
          </div>
        )}

        {/* Cascata por cliente */}
        <div className="space-y-2">
          {loading && rows.length === 0 && (
            <div className="text-center py-10 text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
          )}
          {!loading && grupos.length === 0 && (
            <div className="text-center py-10 text-slate-400 text-sm">Nenhuma peça em marca nesse recorte.</div>
          )}
          {grupos.map((g) => {
            const aberto = abertos.has(g.key);
            return (
              <div key={g.key} className="bg-white rounded-xl border border-[#E7E2D8] overflow-hidden">
                <button onClick={() => toggle(g.key)}
                  className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-[#FBF6E6]/60 transition">
                  {aberto ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-900 truncate flex items-center gap-2">
                      {g.nome}
                      {g.classificacao === 'A' && (
                        <span className="text-[10px] font-black bg-emerald-600 text-white px-1.5 py-0.5 rounded">A</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500">
                      cód {g.codCliente || '—'} · desde {fmtData(g.maisAntiga)} ·{' '}
                      {g.lojas.map((lj) => (
                        <span key={lj} className="inline-block bg-slate-100 border border-slate-200 rounded px-1 text-[10px] font-bold mr-1">LJ {lj}</span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-black text-rose-700 tabular-nums">{brl(g.total)}</div>
                    <div className="text-[11px] text-slate-500">{g.qtd} peça(s)</div>
                  </div>
                </button>
                {aberto && (
                  <div className="border-t border-[#F1EDE3] overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[10px] uppercase text-slate-400 border-b border-[#F8F5EC]">
                          <th className="text-left px-4 py-1.5">Data</th>
                          <th className="text-left px-2 py-1.5">SKU</th>
                          <th className="text-left px-2 py-1.5">Descrição</th>
                          <th className="text-right px-2 py-1.5">Qty</th>
                          <th className="text-right px-2 py-1.5">Valor</th>
                          <th className="text-center px-4 py-1.5">Loja</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.itens.map((it) => (
                          <tr key={it.REGISTRO} className="border-b border-[#F8F5EC] last:border-b-0">
                            <td className="px-4 py-1.5 text-xs text-slate-500 whitespace-nowrap">{fmtData(it.DATA)}</td>
                            <td className="px-2 py-1.5 font-mono text-xs">{it.CODIGO}</td>
                            <td className="px-2 py-1.5 text-slate-700">{it.DESCRICAO}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{Number(it.QUANTIDADE) || 1}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums font-bold">{brl(Number(it.VALORTOTAL) || Number(it.VALOR) || 0)}</td>
                            <td className="px-4 py-1.5 text-center text-xs font-bold text-slate-500">{it.LOJA}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
