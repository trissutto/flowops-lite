'use client';

/**
 * /franquias/faturamento — FASE 1 do portal de franquias (15/07).
 *
 * Todos os números de VENDA das lojas FRANQUIA (tipo=FILIAL, escopo forçado
 * no backend): bruto oficial por dia/loja (espelho do financeiro), vendas,
 * peças, ticket médio e formas de pagamento (PDV Flow), ranking entre lojas
 * e top produtos vendidos. Filtro De/Até + atalhos (padrão do projeto).
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, BarChart3, Loader2, Trophy } from 'lucide-react';
import { api } from '@/lib/api';

const brl = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (iso: string) => {
  const [y, m, d] = String(iso || '').split('-');
  return d && m ? `${d}/${m}/${y?.slice(2)}` : iso;
};
const FORMAS: Array<[string, string]> = [
  ['dinheiro', '💵 Dinheiro'], ['pix', '⚡ PIX'], ['debito', '💳 Débito'],
  ['credito', '💳 Crédito'], ['crediario', '📒 Crediário'],
];

export default function FranquiasFaturamentoPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const hoje = new Date();
  const [de, setDe] = useState(iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)));
  const [ate, setAte] = useState(iso(hoje));
  const [loja, setLoja] = useState('');
  const [lojas, setLojas] = useState<Array<{ code: string; name: string }>>([]);
  const [data, setData] = useState<any>(null);
  const [tops, setTops] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api<{ role: string }>('/auth/me')
      .then((me) => {
        if (me.role !== 'franquias' && me.role !== 'master_franquia' && me.role !== 'admin') {
          router.push('/');
          return;
        }
        setChecking(false);
      })
      .catch(() => router.push('/login'));
    api<any[]>('/franquias/lojas').then(setLojas).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const carregar = useCallback(async () => {
    if (!de || !ate) return;
    setLoading(true);
    setErro(null);
    try {
      const q = `de=${de}&ate=${ate}${loja ? `&loja=${loja}` : ''}`;
      const [fat, mv] = await Promise.all([
        api<any>(`/franquias/faturamento?${q}`),
        api<any[]>(`/franquias/mais-vendidos?${q}`),
      ]);
      setData(fat);
      setTops(mv || []);
    } catch (e: any) {
      setErro(e?.message || 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }, [de, ate, loja]);
  useEffect(() => { if (!checking) carregar(); }, [checking, carregar]);

  const atalho = (tipo: 'hoje' | 'ontem' | '7' | 'mes') => {
    const h = new Date();
    if (tipo === 'hoje') { setDe(iso(h)); setAte(iso(h)); }
    else if (tipo === 'ontem') { const o = new Date(h.getTime() - 86400000); setDe(iso(o)); setAte(iso(o)); }
    else if (tipo === '7') { setDe(iso(new Date(h.getTime() - 6 * 86400000))); setAte(iso(h)); }
    else { setDe(iso(new Date(h.getFullYear(), h.getMonth(), 1))); setAte(iso(h)); }
  };

  if (checking) {
    return <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">Carregando…</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/franquias" className="p-2 hover:bg-slate-100 rounded-lg"><ArrowLeft className="w-5 h-5" /></Link>
          <BarChart3 className="w-5 h-5 text-sky-700" />
          <div>
            <h1 className="font-extrabold text-slate-800 leading-tight">Faturamento das Franquias</h1>
            <p className="text-[11px] text-slate-500">bruto oficial (espelho) · vendas/peças/ticket/formas (PDV)</p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-4">
        {/* Filtros */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center gap-2 text-sm">
          <label className="font-semibold text-slate-500">De</label>
          <input type="date" value={de} onChange={(e) => setDe(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1" />
          <label className="font-semibold text-slate-500">Até</label>
          <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1" />
          {(['hoje', 'ontem', '7', 'mes'] as const).map((t) => (
            <button key={t} onClick={() => atalho(t)} className="px-3 py-1 rounded-full border border-slate-200 hover:bg-slate-100 font-semibold text-slate-600 capitalize">
              {t === '7' ? '7 dias' : t === 'mes' ? 'Mês' : t}
            </button>
          ))}
          <span className="mx-1 text-slate-300">|</span>
          <button onClick={() => setLoja('')} className={`px-3 py-1 rounded-full border font-semibold ${!loja ? 'bg-sky-600 border-sky-600 text-white' : 'border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
            Todas as franquias
          </button>
          {lojas.map((l) => (
            <button key={l.code} onClick={() => setLoja(l.code)} className={`px-3 py-1 rounded-full border font-semibold ${loja === l.code ? 'bg-sky-600 border-sky-600 text-white' : 'border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
              {l.code} · {l.name}
            </button>
          ))}
        </div>

        {erro && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm font-semibold">{erro}</div>}
        {loading && !data && <div className="p-10 text-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>}

        {data && (
          <>
            {/* Cards de totais */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card titulo="Faturamento bruto" valor={brl(data.totais.brutoCents)} destaque />
              <Card titulo="Vendas (PDV)" valor={String(data.totais.vendas)} />
              <Card titulo="Peças (PDV)" valor={String(data.totais.pecas)} />
              <Card titulo="Ticket médio" valor={brl(data.totais.ticketCents)} />
            </div>

            {/* Ranking por loja */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
              <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
                <Trophy className="w-4 h-4 text-amber-500" /> Ranking das franquias no período
              </div>
              <table className="w-full text-sm min-w-[760px]">
                <thead>
                  <tr className="text-[11px] uppercase text-slate-500 border-b border-slate-100">
                    <th className="text-left px-4 py-2">Loja</th>
                    <th className="text-right px-3 py-2">Bruto</th>
                    <th className="text-right px-3 py-2">Vendas</th>
                    <th className="text-right px-3 py-2">Peças</th>
                    <th className="text-right px-3 py-2">Ticket</th>
                    <th className="text-left px-4 py-2">Formas de pagamento (PDV)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.porLoja.map((l: any, i: number) => (
                    <tr key={l.storeCode} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="px-4 py-2 font-bold text-slate-800">
                        {i === 0 && data.porLoja.length > 1 ? '🥇 ' : ''}{l.storeCode} · {l.storeName}
                      </td>
                      <td className="px-3 py-2 text-right font-extrabold text-emerald-700 whitespace-nowrap">{brl(l.brutoCents)}</td>
                      <td className="px-3 py-2 text-right">{l.vendas}</td>
                      <td className="px-3 py-2 text-right">{l.pecas}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{brl(l.ticketCents)}</td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-1.5">
                          {FORMAS.filter(([k]) => l.formas?.[k]).map(([k, label]) => (
                            <span key={k} className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 whitespace-nowrap">
                              {label}: {brl(l.formas[k])}
                            </span>
                          ))}
                          {!FORMAS.some(([k]) => l.formas?.[k]) && <span className="text-slate-300 text-xs">—</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!data.porLoja.length && (
                    <tr><td colSpan={6} className="text-center text-slate-400 py-8">Sem movimento no período.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Por dia */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                  Bruto por dia
                </div>
                <div className="max-h-80 overflow-y-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {[...data.porDia].reverse().map((d: any) => (
                        <tr key={d.data} className="border-b border-slate-50">
                          <td className="px-4 py-1.5 text-slate-600">{fmtData(d.data)}</td>
                          <td className="px-4 py-1.5 text-right font-bold text-emerald-700">{brl(d.brutoCents)}</td>
                        </tr>
                      ))}
                      {!data.porDia.length && <tr><td className="text-center text-slate-400 py-6">—</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mais vendidos */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                  Produtos mais vendidos (PDV)
                </div>
                <div className="max-h-80 overflow-y-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {tops.map((t) => (
                        <tr key={t.ref} className="border-b border-slate-50">
                          <td className="px-4 py-1.5">
                            <div className="font-bold text-slate-700">{t.ref}</div>
                            <div className="text-[11px] text-slate-400 truncate max-w-[280px]">{t.descricao}</div>
                          </td>
                          <td className="px-2 py-1.5 text-right font-bold">{t.pecas} pç</td>
                          <td className="px-4 py-1.5 text-right text-emerald-700 font-semibold whitespace-nowrap">{brl(t.totalCents)}</td>
                        </tr>
                      ))}
                      {!tops.length && <tr><td className="text-center text-slate-400 py-6">Sem vendas no período.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Card({ titulo, valor, destaque }: { titulo: string; valor: string; destaque?: boolean }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{titulo}</div>
      <div className={`text-xl font-extrabold ${destaque ? 'text-emerald-700' : 'text-slate-800'}`}>{valor}</div>
    </div>
  );
}
