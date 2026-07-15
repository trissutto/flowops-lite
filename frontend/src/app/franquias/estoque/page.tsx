'use client';

/**
 * /franquias/estoque — FASE 2 do portal de franquias (15/07).
 *
 * Estoque das lojas FRANQUIA (tipo=FILIAL, escopo no backend, 100% espelho):
 *   - peças e VALOR A PREÇO DE VENDA por loja (sem custo/margem — dado da rede);
 *   - top grupos;
 *   - busca de produto com estoque por loja franquia (busca única do projeto).
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Package2, Search } from 'lucide-react';
import { api } from '@/lib/api';

const brl = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = (n: number) => Number(n || 0).toLocaleString('pt-BR');

export default function FranquiasEstoquePage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [data, setData] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [busca, setBusca] = useState<any>(null);

  useEffect(() => {
    api<{ role: string }>('/auth/me')
      .then((me) => {
        if (me.role !== 'franquias' && me.role !== 'master_franquia' && me.role !== 'admin') {
          router.push('/');
          return;
        }
        setChecking(false);
        api<any>('/franquias/estoque').then(setData).catch((e) => setErro(e?.message || 'Falha ao carregar'));
      })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function buscar(e?: React.FormEvent) {
    e?.preventDefault();
    const q = term.trim();
    if (q.length < 2) return;
    setBuscando(true);
    try {
      const r = await api<any>(`/franquias/estoque/busca?term=${encodeURIComponent(q)}`);
      setBusca(r);
    } catch (er: any) {
      setErro(er?.message || 'Falha na busca');
    } finally {
      setBuscando(false);
    }
  }

  if (checking) {
    return <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">Carregando…</div>;
  }

  const totalPecas = (data?.porLoja || []).reduce((s: number, l: any) => s + l.pecas, 0);
  const totalValor = (data?.porLoja || []).reduce((s: number, l: any) => s + l.valorVendaCents, 0);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/franquias" className="p-2 hover:bg-slate-100 rounded-lg"><ArrowLeft className="w-5 h-5" /></Link>
          <Package2 className="w-5 h-5 text-violet-700" />
          <div>
            <h1 className="font-extrabold text-slate-800 leading-tight">Estoque das Franquias</h1>
            <p className="text-[11px] text-slate-500">peças e valor a preço de venda · espelho (sem tocar o Giga)</p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-4">
        {erro && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm font-semibold">{erro}</div>}
        {!data && !erro && <div className="p-10 text-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>}

        {data && (
          <>
            <div className="grid grid-cols-2 gap-3 max-w-md">
              <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
                <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Peças em estoque</div>
                <div className="text-xl font-extrabold text-slate-800">{fmt(totalPecas)}</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
                <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Valor (preço de venda)</div>
                <div className="text-xl font-extrabold text-emerald-700">{brl(totalValor)}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Por loja */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                  Por loja franquia
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {data.porLoja.map((l: any) => (
                      <tr key={l.storeCode} className="border-b border-slate-50">
                        <td className="px-4 py-2 font-bold text-slate-800">{l.storeCode} · {l.storeName}</td>
                        <td className="px-3 py-2 text-right">{fmt(l.pecas)} pç</td>
                        <td className="px-4 py-2 text-right font-extrabold text-emerald-700 whitespace-nowrap">{brl(l.valorVendaCents)}</td>
                      </tr>
                    ))}
                    {!data.porLoja.length && <tr><td className="text-center text-slate-400 py-8">Sem estoque registrado.</td></tr>}
                  </tbody>
                </table>
              </div>

              {/* Por grupo */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                  Top grupos (todas as franquias)
                </div>
                <div className="max-h-96 overflow-y-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {data.grupos.map((g: any) => (
                        <tr key={g.grupo} className="border-b border-slate-50">
                          <td className="px-4 py-1.5 text-slate-700 font-semibold">{g.grupo}</td>
                          <td className="px-3 py-1.5 text-right">{fmt(g.pecas)} pç</td>
                          <td className="px-4 py-1.5 text-right text-emerald-700 font-semibold whitespace-nowrap">{brl(g.valorVendaCents)}</td>
                        </tr>
                      ))}
                      {!data.grupos.length && <tr><td className="text-center text-slate-400 py-6">—</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Busca de produto */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <form onSubmit={buscar} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Buscar produto (REF, código ou descrição) — estoque nas franquias…"
                className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300"
              />
            </div>
            <button type="submit" disabled={buscando || term.trim().length < 2} className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold disabled:opacity-50">
              {buscando ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Buscar'}
            </button>
          </form>

          {busca && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[700px]">
                <thead>
                  <tr className="text-[11px] uppercase text-slate-500 border-b border-slate-100">
                    <th className="text-left px-3 py-2">Produto</th>
                    <th className="text-right px-2 py-2">Preço</th>
                    {busca.lojas.map((l: any) => (
                      <th key={l.code} className="text-right px-2 py-2" title={l.name}>{l.code}</th>
                    ))}
                    <th className="text-right px-3 py-2">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {busca.rows.map((r: any) => (
                    <tr key={r.codigo} className="border-b border-slate-50">
                      <td className="px-3 py-1.5">
                        <div className="font-semibold text-slate-700">{r.descricao || r.ref || r.codigo}</div>
                        <div className="text-[11px] text-slate-400">{r.ref} · {r.cor || '—'} · {r.tamanho || '—'} · {r.codigo}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">{r.precoCents != null ? brl(r.precoCents) : '—'}</td>
                      {busca.lojas.map((l: any) => {
                        const norm = String(l.code).toUpperCase().replace(/^LJ/, '').padStart(2, '0');
                        const q = r.porLoja[norm] || 0;
                        return (
                          <td key={l.code} className={`px-2 py-1.5 text-right ${q > 0 ? 'font-bold text-slate-800' : 'text-slate-300'}`}>
                            {q || '—'}
                          </td>
                        );
                      })}
                      <td className="px-3 py-1.5 text-right font-extrabold">{r.total}</td>
                    </tr>
                  ))}
                  {!busca.rows.length && (
                    <tr><td colSpan={3 + busca.lojas.length} className="text-center text-slate-400 py-6">Nenhuma peça com estoque nas franquias pra essa busca.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
