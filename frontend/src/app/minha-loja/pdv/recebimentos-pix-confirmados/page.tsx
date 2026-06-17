'use client';

/**
 * /minha-loja/pdv/recebimentos-pix-confirmados — Lista PIX confirmados.
 *
 * Pra quando o cliente paga por LINK PIX (remoto) e a tela de Recebimentos
 * não estava aberta na hora — comprovante não imprimiu automatico.
 *
 * Mostra todos os pagamentos PIX confirmados nas últimas 24h da loja com:
 *  - Cliente, valor, hora
 *  - Status: ✓ COMPROVANTE IMPRESSO  |  ⚠ AINDA NÃO IMPRESSO
 *  - Botão "Imprimir agora"
 *  - Auto-refresh a cada 5s
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Printer, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

type Baixa = {
  id: string;
  customerName: string | null;
  customerCpf: string | null;
  totalPago: number;
  paidAt: string | null;
  status: string;
  formaPagamento: string;
  origem?: string | null;
  reciboImpressoAt?: string | null; // não existe ainda no schema, simulado no client
};

const BRL = (v: number) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtTime = (iso: string | null) => {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export default function PixConfirmadosPage() {
  const [items, setItems] = useState<Baixa[]>([]);
  const [loading, setLoading] = useState(true);
  const [printedIds, setPrintedIds] = useState<Set<string>>(() => {
    // Persiste localmente quais já foram impressos
    if (typeof window === 'undefined') return new Set();
    try {
      return new Set(JSON.parse(localStorage.getItem('rec_pix_impressos') || '[]'));
    } catch {
      return new Set();
    }
  });

  async function load() {
    try {
      // Últimas 24h
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const r = await api<Baixa[]>(`/crediarios/baixa/recentes-pagas?since=${encodeURIComponent(since)}`);
      setItems(Array.isArray(r) ? r : []);
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  function imprimir(baixaId: string) {
    const url = `/minha-loja/pdv/recebimentos/recibo/${baixaId}?autoprint=1`;
    window.open(url, '_blank', 'width=400,height=600');
    // Marca local como impresso
    setPrintedIds((s) => {
      const novo = new Set(s);
      novo.add(baixaId);
      try {
        localStorage.setItem('rec_pix_impressos', JSON.stringify(Array.from(novo)));
      } catch {}
      return novo;
    });
  }

  const naoImpressos = items.filter((it) => !printedIds.has(it.id));
  const impressos = items.filter((it) => printedIds.has(it.id));

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b sticky top-0 z-10 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/minha-loja/pdv" className="p-2 hover:bg-slate-100 rounded">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-slate-800">PIX Crediário · Confirmados</h1>
            <p className="text-xs text-slate-500">Últimas 24h · auto-refresh 5s</p>
          </div>
          <button onClick={load} className="p-2 hover:bg-slate-100 rounded" title="Atualizar agora">
            <RefreshCw className={`w-5 h-5 text-slate-600 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4 space-y-4">
        {loading && items.length === 0 && (
          <div className="text-center py-10 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin inline-block mr-2" /> Carregando...
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="text-center py-16 text-slate-500 bg-white rounded-xl border-2 border-dashed">
            <CheckCircle2 className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p className="text-sm">Nenhum PIX confirmado nas últimas 24h.</p>
          </div>
        )}

        {/* Alertas — pagamentos confirmados mas SEM comprovante impresso */}
        {naoImpressos.length > 0 && (
          <section>
            <h2 className="text-xs font-black uppercase text-rose-700 tracking-wider mb-2">
              ⚠ {naoImpressos.length} {naoImpressos.length === 1 ? 'pagamento sem comprovante' : 'pagamentos sem comprovante'}
            </h2>
            <div className="space-y-2">
              {naoImpressos.map((it) => (
                <Card key={it.id} baixa={it} onPrint={() => imprimir(it.id)} alert />
              ))}
            </div>
          </section>
        )}

        {/* Já impressos */}
        {impressos.length > 0 && (
          <section>
            <h2 className="text-xs font-bold uppercase text-emerald-700 tracking-wider mb-2 mt-6">
              ✓ {impressos.length} {impressos.length === 1 ? 'comprovante impresso' : 'comprovantes impressos'}
            </h2>
            <div className="space-y-2">
              {impressos.map((it) => (
                <Card key={it.id} baixa={it} onPrint={() => imprimir(it.id)} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function Card({ baixa, onPrint, alert }: { baixa: Baixa; onPrint: () => void; alert?: boolean }) {
  return (
    <div
      className={`bg-white border-2 rounded-xl p-3 flex items-center gap-3 ${
        alert ? 'border-rose-300 bg-rose-50' : 'border-slate-200'
      }`}
    >
      <div
        className={`p-2 rounded-lg ${
          alert ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'
        }`}
      >
        {alert ? <AlertCircle className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-sm text-slate-800 truncate">
          {baixa.customerName || 'Cliente'}
        </div>
        <div className="text-[11px] text-slate-500">
          {baixa.formaPagamento?.toUpperCase()} · {fmtTime(baixa.paidAt)}
          {baixa.origem === 'link' && <span className="ml-1 bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded font-bold">LINK</span>}
        </div>
      </div>
      <div className="text-right">
        <div className="font-black text-emerald-700 tabular-nums">{BRL(baixa.totalPago)}</div>
      </div>
      <button
        onClick={onPrint}
        className={`px-3 py-2 rounded-lg font-bold text-xs flex items-center gap-1 ${
          alert
            ? 'bg-rose-600 hover:bg-rose-700 text-white'
            : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
        }`}
      >
        <Printer className="w-4 h-4" /> Imprimir
      </button>
    </div>
  );
}
