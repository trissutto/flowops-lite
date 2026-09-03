'use client';

/**
 * /retaguarda/categorias-mapa — DE-PARA de categorias WooCommerce → site.
 *
 * ── POR QUE ESTA TELA EXISTE ──
 *
 * A categoria de cada peça vinha de um mapa FIXO no código
 * ("vestido"→vestidos, "blusa"→blusas). Categoria do WooCommerce fora desse
 * mapa não resolvia, e a peça caía no palpite pelo NOME — que foi onde
 * "Conjunto Lingerie" ia parar em Conjuntos, junto com conjunto de blusa e
 * calça (achado do dono, 10/08/2026). Corrigir exigia mexer no código e fazer
 * deploy.
 *
 * Agora a decisão é sua e vale na hora. O sync consulta este de-para ANTES
 * do mapa do código.
 *
 * ── O QUE ELA MOSTRA ──
 *
 * Toda categoria que o sync viu no WooCommerce, com quantas peças vieram em
 * cada. As SEM DESTINO aparecem primeiro: são as que estão fazendo peça
 * sumir da vitrine agora. Sem esta lista, categoria nova no WooCommerce faria
 * a peça desaparecer sem ninguém saber por quê.
 *
 * 09/26 — o botão "Atualizar catálogo" (POST /loja-catalog/importar) saiu: o
 * host do WordPress foi apagado em 27/08/2026. O de-para continua valendo, e
 * agora vale na hora: não há mais reimportação pra esperar.
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Loader2, AlertCircle, Check, Tags, RefreshCw } from 'lucide-react';

interface Origem {
  origem: string;
  rotulo: string;
  /** null = esperando decisão · '' = ignorar de propósito · slug = destino */
  destino: string | null;
  pecas: number;
  vistoEm: string;
}
interface Mapa {
  origens: Origem[];
  destinos: string[];
}

const ROTULO: Record<string, string> = {
  calcas: 'Calças',
  macacoes: 'Macacões',
  'moda-praia': 'Moda praia',
};
function bonito(slug: string) {
  if (ROTULO[slug]) return ROTULO[slug];
  const s = slug.replace(/[-_]+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function CategoriasMapaPage() {
  const [data, setData] = useState<Mapa | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState<string | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  async function carregar() {
    setLoading(true);
    setErro(null);
    try {
      setData(await api<Mapa>('/loja-catalog/categorias-mapa'));
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { carregar(); }, []);

  // O botão "Atualizar catálogo" saiu em 09/26: importava do site antigo
  // (WooCommerce) e o host do WordPress foi apagado em 27/08/2026. O vínculo
  // escolhido aqui vale na hora — não depende mais de reimportar nada.

  async function salvar(origem: string, destino: string | null) {
    setSalvando(origem);
    try {
      await api(`/loja-catalog/categorias-mapa/${encodeURIComponent(origem)}`, {
        method: 'PATCH',
        body: JSON.stringify({ destino }),
      });
      setData((d) =>
        d ? { ...d, origens: d.origens.map((o) => (o.origem === origem ? { ...o, destino } : o)) } : d,
      );
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao salvar');
    } finally {
      setSalvando(null);
    }
  }

  // Sem destino primeiro: é o que está fazendo peça sumir da vitrine agora.
  const ordenadas = data
    ? [...data.origens].sort((a, b) => {
        const aPend = a.destino === null ? 0 : 1;
        const bPend = b.destino === null ? 0 : 1;
        if (aPend !== bPend) return aPend - bPend;
        return b.pecas - a.pecas;
      })
    : [];
  const pendentes = ordenadas.filter((o) => o.destino === null);
  const pecasParadas = pendentes.reduce((s, o) => s + o.pecas, 0);

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Tags className="w-6 h-6" /> Categorias do site
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            De onde vem × onde aparece. O que você escolher aqui vale mais que a regra automática.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={carregar}
            className="px-3 py-2 border rounded text-sm hover:bg-slate-50 flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" /> Recarregar
          </button>
        </div>
      </div>

      {pendentes.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <b>{pendentes.length} categoria{pendentes.length > 1 ? 's' : ''} sem destino</b>
          {pecasParadas > 0 && (
            <> — <b>{pecasParadas} peça{pecasParadas > 1 ? 's' : ''}</b> que o site não sabe onde mostrar.</>
          )}{' '}
          Escolha o destino de cada uma abaixo.
        </div>
      )}

      <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        A escolha vale <b>na hora</b>. Escolher <b>Ignorar</b> serve pra categoria que não é tipo de
        peça — “Promoções”, “Novidades” — e faz o site procurar a classificação nas outras categorias
        da peça.
      </div>

      {erro && (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {erro}
        </div>
      )}

      {loading ? (
        <div className="p-12 text-center text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mx-auto" />
        </div>
      ) : ordenadas.length === 0 ? (
        <div className="p-8 text-center text-slate-400 border border-dashed rounded">
          Nenhuma categoria registrada ainda.
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-slate-600 text-xs uppercase">
                <th className="text-left px-4 py-2">No WooCommerce</th>
                <th className="text-right px-4 py-2">Peças</th>
                <th className="text-left px-4 py-2 w-64">Aparece no site como</th>
              </tr>
            </thead>
            <tbody>
              {ordenadas.map((o) => {
                const pendente = o.destino === null;
                return (
                  <tr key={o.origem} className={`border-t ${pendente ? 'bg-amber-50/50' : ''}`}>
                    <td className="px-4 py-2">
                      <span className="font-medium">{o.rotulo}</span>
                      {pendente && (
                        <span className="ml-2 text-[10px] uppercase font-bold text-amber-700">
                          sem destino
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{o.pecas}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <select
                          value={o.destino ?? '__pendente__'}
                          onChange={(e) => {
                            const v = e.target.value;
                            salvar(o.origem, v === '__pendente__' ? null : v);
                          }}
                          className="flex-1 px-2 py-1.5 border rounded text-sm bg-white"
                        >
                          <option value="__pendente__">— escolher —</option>
                          <option value="">Ignorar esta categoria</option>
                          {data!.destinos.map((d) => (
                            <option key={d} value={d}>{bonito(d)}</option>
                          ))}
                        </select>
                        {salvando === o.origem ? (
                          <Loader2 className="w-4 h-4 animate-spin text-slate-400 shrink-0" />
                        ) : !pendente ? (
                          <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                        ) : (
                          <span className="w-4 shrink-0" />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
