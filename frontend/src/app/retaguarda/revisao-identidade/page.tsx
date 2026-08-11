'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Check, Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api } from '@/lib/api';

type Candidate = {
  id: string; personId: string | null; name: string | null; email: string | null;
  cpfMasked: string | null; phoneMasked: string | null; instagram: string | null;
  originSource: string | null; store: { code: string; name: string } | null;
  firstRegistrationAt: string; ltvCents: number; orderCount: number;
};
type Suggestion = {
  key: string; type: 'phone' | 'instagram'; matchMasked: string;
  participantCount: number; unlinkedCount: number; existingPersonCount: number;
  totalLtvCents: number; totalOrders: number; candidates: Candidate[];
};

const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function RevisaoIdentidadePage() {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await api<{ total: number; items: Suggestion[] }>('/customers-crm/identity-review?limit=100');
      setItems(result.items); setTotal(result.total);
    } catch (e: any) { setError(e?.message || 'Não foi possível carregar a fila'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const decide = async (decision: 'confirm' | 'reject') => {
    if (!selected || reason.trim().length < 3) { setError('Informe um motivo com pelo menos 3 caracteres.'); return; }
    setActing(decision); setError(null);
    try {
      await api(`/customers-crm/identity-review/${encodeURIComponent(selected.key)}/${decision}`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      });
      setSelected(null); setReason(''); await load();
    } catch (e: any) { setError(e?.message || 'A decisão não pôde ser salva'); }
    finally { setActing(null); }
  };

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link href="/retaguarda" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"><ArrowLeft className="h-4 w-4" /> Voltar</Link>
            <h1 className="flex items-center gap-2 text-2xl font-black text-slate-900"><ShieldCheck className="h-6 w-6 text-violet-600" /> Revisão de identidade</h1>
            <p className="text-sm text-slate-600">Sugestões por telefone ou Instagram. Nenhuma compra, parcela ou marcado é movimentado.</p>
          </div>
          <button onClick={load} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm font-bold"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar</button>
        </header>

        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><b>{total} sugestões pendentes.</b> Confirme apenas quando os cadastros forem claramente da mesma pessoa.</div>
        {error && <div className="flex items-center gap-2 rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900"><AlertTriangle className="h-4 w-4" />{error}</div>}
        {loading && <div className="flex justify-center p-12"><Loader2 className="h-7 w-7 animate-spin text-violet-600" /></div>}
        {!loading && items.length === 0 && <div className="rounded-xl border bg-white p-10 text-center text-slate-600">Fila limpa: nenhuma sugestão pendente.</div>}

        <section className="space-y-4">
          {items.map((group) => (
            <article key={group.key} className="overflow-hidden rounded-xl border bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-slate-50 px-4 py-3">
                <div><span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-black uppercase text-violet-800">{group.type === 'phone' ? 'Telefone' : 'Instagram'}</span> <b className="ml-2">{group.matchMasked}</b></div>
                <div className="text-xs text-slate-600">{group.totalOrders} compras · {money(group.totalLtvCents)} no histórico · {group.unlinkedCount} sem pessoa</div>
              </div>
              <div className="grid gap-px bg-slate-200 md:grid-cols-2 lg:grid-cols-3">
                {group.candidates.map((c) => (
                  <div key={c.id} className="bg-white p-4">
                    <div className="font-black text-slate-900">{c.name || 'Sem nome'}</div>
                    <div className="mt-1 space-y-0.5 text-xs text-slate-600"><div>{c.cpfMasked || 'CPF não informado'}</div><div>{c.phoneMasked || c.instagram || 'Contato não informado'}</div><div>{c.email || 'E-mail não informado'}</div></div>
                    <div className="mt-3 text-xs"><b>Origem:</b> {c.store ? `${c.store.code} · ${c.store.name}` : c.originSource || 'não informada'}</div>
                    <div className="mt-1 text-xs"><b>Histórico:</b> {c.orderCount} compras · {money(c.ltvCents)}</div>
                    <div className={`mt-2 text-[11px] font-bold ${c.personId ? 'text-emerald-700' : 'text-amber-700'}`}>{c.personId ? 'Já ligada a uma pessoa' : 'Ainda sem pessoa'}</div>
                  </div>
                ))}
              </div>
              <div className="flex justify-end border-t px-4 py-3"><button onClick={() => { setSelected(group); setReason(''); }} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-bold text-white hover:bg-violet-700">Revisar decisão</button></div>
            </article>
          ))}
        </section>
      </div>

      {selected && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
          <h2 className="text-lg font-black">Registrar decisão</h2>
          <p className="mt-1 text-sm text-slate-600">{selected.participantCount} cadastros coincidem por {selected.type === 'phone' ? 'telefone' : 'Instagram'} ({selected.matchMasked}).</p>
          {selected.existingPersonCount > 1 && <div className="mt-3 rounded-lg bg-rose-50 p-3 text-sm font-bold text-rose-800">Conflito: existem pessoas diferentes neste grupo. A confirmação será bloqueada.</div>}
          <label className="mt-4 block text-sm font-bold">Motivo obrigatório</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} className="mt-1 w-full rounded-lg border-2 border-slate-300 p-3 text-sm focus:border-violet-500 focus:outline-none" placeholder="Ex.: nome, contato e histórico conferidos pela matriz" />
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button onClick={() => setSelected(null)} disabled={!!acting} className="rounded-lg border px-3 py-2 text-sm font-bold">Cancelar</button>
            <button onClick={() => decide('reject')} disabled={!!acting} className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"><X className="h-4 w-4" /> Não é a mesma pessoa</button>
            <button onClick={() => decide('confirm')} disabled={!!acting || selected.existingPersonCount > 1} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">{acting === 'confirm' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirmar vínculo</button>
          </div>
        </div>
      </div>}
    </main>
  );
}
