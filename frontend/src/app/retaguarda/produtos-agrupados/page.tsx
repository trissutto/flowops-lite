'use client';

/**
 * /retaguarda/produtos-agrupados — MESMA PEÇA EM REFs DIFERENTES.
 *
 * ── O PROBLEMA QUE ESTA TELA RESOLVE ──
 *
 * No site antigo, cor virava REF nova: `900887` era o macaquinho preto e
 * `900887B` o mesmo macaquinho bege. A vitrine mostrava os dois lado a lado —
 * a cliente escolhendo entre o que parece ser o mesmo produto repetido
 * (achado do dono em 10/08/2026).
 *
 * O sistema junta sozinho pela RAIZ da REF (`900887B` → `900887`), mas só
 * quando as peças concordam em categoria e preço. Aqui você confere e corrige:
 * separar uma peça do grupo, ou puxar uma pra dentro dele.
 *
 * **Sua decisão trava contra o automático** — o sync não a desfaz na
 * madrugada seguinte.
 *
 * A REF nova já nasce com a cor resolvida dentro da própria peça. Esta tela é
 * dívida do catálogo legado, não desenho permanente.
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Loader2, AlertCircle, Package2, RefreshCw, Unlink, Check } from 'lucide-react';

interface Item {
  ref: string;
  nome: string;
  categoria: string | null;
  grupoRef: string;
  grupoRefManual: boolean;
}
interface Grupo {
  raiz: string;
  manual: boolean;
  itens: Item[];
}

export default function ProdutosAgrupadosPage() {
  const [grupos, setGrupos] = useState<Grupo[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [recalculando, setRecalculando] = useState(false);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  async function carregar() {
    setLoading(true);
    setErro(null);
    try {
      setGrupos(await api<Grupo[]>('/loja-catalog/grupos'));
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { carregar(); }, []);

  async function recalcular() {
    setRecalculando(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await api<{ gruposCriados: number; recusados: unknown[] }>(
        '/loja-catalog/grupos/recalcular',
        { method: 'POST' },
      );
      setAviso(
        `${r.gruposCriados} grupo(s) formado(s). ` +
          `${r.recusados?.length ?? 0} raiz(es) não agrupadas por divergirem em categoria ou preço.`,
      );
      await carregar();
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao recalcular');
    } finally {
      setRecalculando(false);
    }
  }

  /** Tira a peça do grupo — ela volta a ser um card próprio na vitrine. */
  async function separar(ref: string) {
    setOcupado(ref);
    setErro(null);
    try {
      await api(`/loja-catalog/grupos/${encodeURIComponent(ref)}`, {
        method: 'PATCH',
        body: JSON.stringify({ grupo: null }),
      });
      await carregar();
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao separar');
    } finally {
      setOcupado(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package2 className="w-6 h-6" /> Produtos agrupados
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Peças que o site mostra como <b>um produto só</b>, com as cores na bolinha.
          </p>
        </div>
        <button
          onClick={recalcular}
          disabled={recalculando}
          className="px-4 py-2 bg-brand text-white rounded text-sm font-semibold hover:bg-brand-dark disabled:opacity-50 flex items-center gap-2 shrink-0"
        >
          {recalculando ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Recalcular
        </button>
      </div>

      <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        O agrupamento é automático pela <b>raiz da REF</b> — <span className="font-mono">900887B</span> e{' '}
        <span className="font-mono">900887</span> são a mesma peça em cores diferentes. Só junta quando
        as peças concordam em <b>categoria e preço</b>; o que diverge fica separado de propósito.
        Ao <b>separar</b> uma peça na mão, sua decisão passa a valer e o sync não a desfaz.
      </div>

      {erro && (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {erro}
        </div>
      )}
      {aviso && (
        <div className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-center gap-2">
          <Check className="w-4 h-4" /> {aviso}
        </div>
      )}

      {loading ? (
        <div className="p-12 text-center text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mx-auto" />
        </div>
      ) : grupos.length === 0 ? (
        <div className="p-8 text-center text-slate-400 border border-dashed rounded">
          Nenhum produto agrupado ainda. Clique em <b>Recalcular</b> pra procurar REFs da mesma raiz.
        </div>
      ) : (
        <div className="space-y-3">
          {grupos.map((g) => (
            <div key={g.raiz} className="bg-white rounded-lg shadow border overflow-hidden">
              <div className="flex items-center justify-between gap-3 bg-slate-50 px-4 py-2 border-b">
                <span className="font-mono text-sm font-semibold">{g.raiz}</span>
                <span className="text-xs text-slate-500">
                  {g.itens.length} REFs · 1 produto na vitrine
                  {g.manual && ' · ajustado à mão'}
                </span>
              </div>
              <ul className="divide-y">
                {g.itens.map((i) => (
                  <li key={i.ref} className="flex items-center justify-between gap-4 px-4 py-2.5">
                    <div className="min-w-0">
                      <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">
                        {i.ref}
                      </span>
                      <span className="ml-2 text-sm text-slate-700">{i.nome}</span>
                    </div>
                    <button
                      onClick={() => separar(i.ref)}
                      disabled={ocupado === i.ref}
                      title="Mostrar esta REF como produto separado na vitrine"
                      className="shrink-0 px-2.5 py-1.5 border rounded text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {ocupado === i.ref ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Unlink className="w-3.5 h-3.5" />
                      )}
                      Separar
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
