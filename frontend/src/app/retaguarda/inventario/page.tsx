'use client';

/**
 * /retaguarda/inventario — as contagens das lojas.
 *
 * A matriz abre a contagem aqui e entra na sessão pra conferir a diferença.
 * A loja não abre inventário sozinha: duas contagens abertas na mesma loja
 * dividiriam o contado em duas e cada uma acharia que faltou metade da loja.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ArrowLeft, Loader2, PackageSearch, Plus, AlertTriangle } from 'lucide-react';

type Sessao = {
  id: string;
  storeCode: string;
  storeName: string | null;
  status: string;
  abertaEm: string;
  abertaPor: string | null;
  encerradaEm: string | null;
  aplicadaEm: string | null;
  pecasContadas: number;
  nota: string | null;
};

type Loja = { code: string; name: string };

const data = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

const CHIP: Record<string, string> = {
  aberta: 'bg-amber-100 text-amber-800 border-amber-300',
  encerrada: 'bg-blue-100 text-blue-800 border-blue-300',
  aplicada: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  cancelada: 'bg-slate-100 text-slate-600 border-slate-300',
};

const ROTULO: Record<string, string> = {
  aberta: 'Contando',
  encerrada: 'Esperando a conferência',
  aplicada: 'Ajuste aplicado',
  cancelada: 'Cancelada',
};

export default function InventariosPage() {
  const [sessoes, setSessoes] = useState<Sessao[]>([]);
  const [lojas, setLojas] = useState<Loja[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [abrindo, setAbrindo] = useState(false);
  const [novaLoja, setNovaLoja] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const [s, l] = await Promise.all([
        api<Sessao[]>('/inventario'),
        api<Loja[]>('/stores').catch(() => [] as Loja[]),
      ]);
      setSessoes(Array.isArray(s) ? s : []);
      setLojas(Array.isArray(l) ? l : []);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar os inventários');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const abrir = useCallback(async () => {
    if (!novaLoja) return;
    setAbrindo(true);
    setErro(null);
    try {
      await api('/inventario/abrir', {
        method: 'POST',
        body: JSON.stringify({ storeCode: novaLoja }),
      });
      setNovaLoja('');
      await carregar();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui abrir o inventário');
    } finally {
      setAbrindo(false);
    }
  }, [novaLoja, carregar]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 hover:bg-slate-100 rounded-lg">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <PackageSearch className="w-5 h-5 text-slate-700" />
          <h1 className="font-black text-slate-800 uppercase tracking-wide text-sm">Inventário</h1>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 space-y-4">
        <section className="bg-white border border-slate-200 rounded-2xl p-4">
          <div className="text-[11px] font-black uppercase tracking-wider text-slate-500 mb-3">
            Abrir uma contagem
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1">Loja</label>
              <select
                value={novaLoja}
                onChange={(e) => setNovaLoja(e.target.value)}
                className="h-11 px-3 border-2 border-slate-300 rounded-xl font-bold text-sm min-w-[240px]"
              >
                <option value="">escolha a loja…</option>
                {lojas.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.code} · {l.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={() => void abrir()}
              disabled={!novaLoja || abrindo}
              className="h-11 px-5 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white rounded-xl font-bold text-sm flex items-center gap-2"
            >
              {abrindo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Abrir
            </button>
          </div>
          <p className="text-[12px] text-slate-500 mt-3 max-w-2xl">
            A loja passa a bipar em <b>Minha Loja → Inventário</b> e{' '}
            <b>continua vendendo normalmente</b>: o bipe não mexe no estoque. O que vai pro estoque é
            a <b>diferença</b>, e só quando você aplicar aqui.
          </p>
        </section>

        {erro && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-300 rounded-xl px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div className="text-sm text-red-800 font-medium">{erro}</div>
          </div>
        )}

        <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          {carregando ? (
            <div className="p-6 flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
            </div>
          ) : sessoes.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Nenhum inventário ainda. Escolha a loja acima pra começar.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {sessoes.map((s) => (
                <Link
                  key={s.id}
                  href={`/retaguarda/inventario/${s.id}`}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-black text-slate-800">
                      {s.storeCode} · {s.storeName || 'loja'}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      aberto {data(s.abertaEm)}
                      {s.abertaPor ? ` por ${s.abertaPor}` : ''}
                      {s.aplicadaEm ? ` · aplicado ${data(s.aplicadaEm)}` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">peças</div>
                    <div className="font-mono font-black text-slate-800">{s.pecasContadas}</div>
                  </div>
                  <span
                    className={`shrink-0 px-2.5 py-1 rounded-full border text-[11px] font-black uppercase tracking-wide ${
                      CHIP[s.status] || CHIP.cancelada
                    }`}
                  >
                    {ROTULO[s.status] || s.status}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
