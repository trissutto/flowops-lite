'use client';

/**
 * /retaguarda/ordem-vitrine — A ORDEM DA VITRINE, CATEGORIA POR CATEGORIA.
 *
 * Dono, 20/08/2026: "como coloco os produtos na ordem que eu quiser?" — depois
 * que cada cor virou um card no site, a sequência das FAMÍLIAS virou decisão
 * de vitrine. Esta tela mostra as peças da categoria NA ORDEM em que o site as
 * mostra e deixa arrastar (ou usar as setas). Salvar grava uma `SiteColecao`
 * de slug `ordem-categoria-<categoria>` — o mesmo mecanismo da "Mais Top da
 * Semana" — e a listagem pública passa a abrir por ela; peça não posicionada
 * segue atrás, na ordem automática de sempre.
 *
 * A ordem é por REF (família): as cores de cada peça continuam juntas no site,
 * então arrastar a família move o bloco inteiro — ninguém arrasta 8 cards de
 * uma blusa de 8 cores.
 *
 * A ordem manual SÓ vale na ordenação padrão da categoria: se a cliente pedir
 * "menor preço", a escolha dela manda (regra no `loja-catalog.service`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, LayoutGrid, Loader2, RefreshCw, Check, Save, AlertTriangle,
  ArrowUp, ArrowDown, GripVertical,
} from 'lucide-react';
import { api } from '@/lib/api';

interface CardProduto {
  ref: string;
  nome: string;
  imagens?: Array<{ src: string }> | null;
  disponivel?: boolean;
}
interface Item {
  ref: string;
  nome: string;
  imagem: string | null;
  /** REF gravada na ordem mas fora da vitrine agora (esgotada/despublicada). */
  foraDaVitrine: boolean;
}

/** Mesma normalização do backend (`refKey`): UPPER/TRIM/sem espaço. */
function refKey(r: unknown): string {
  return String(r ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

export default function OrdemVitrinePage() {
  const [categorias, setCategorias] = useState<Array<{ valor: string; qtd: number }>>([]);
  const [categoria, setCategoria] = useState('');
  const [lista, setLista] = useState<Item[]>([]);
  const [salvoRefs, setSalvoRefs] = useState<string[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  // Categorias reais do site (as que têm peça publicada), com contagem.
  useEffect(() => {
    api<{ categorias?: Array<{ valor: string; qtd: number }> }>('/public/loja/filtros')
      .then((r) => setCategorias(r?.categorias ?? []))
      .catch(() => setErro('Não consegui listar as categorias'));
  }, []);

  const slugDaOrdem = categoria ? `ordem-categoria-${categoria}` : '';

  const carregar = useCallback(async () => {
    if (!categoria) return;
    setCarregando(true);
    setErro('');
    setAviso('');
    try {
      /**
       * DUAS FONTES, UMA LISTA: a ordem GRAVADA (refs da coleção) abre a
       * lista; as demais peças da categoria — na ordem automática em que o
       * site as mostra hoje — completam atrás. O resultado na tela é
       * exatamente a vitrine que a cliente vê.
       */
      const [salva, atual] = await Promise.all([
        api<{ refs?: string[] }>(`/loja-catalog/curadoria/${slugDaOrdem}`),
        api<{ itens?: CardProduto[] }>(
          `/public/loja/produtos?categoria=${encodeURIComponent(categoria)}&perPage=100&ordenar=relevancia`,
        ),
      ]);
      const pecas = atual?.itens ?? [];
      const porRef = new Map<string, CardProduto>();
      for (const p of pecas) porRef.set(refKey(p.ref), p);

      const posicionadas: Item[] = (salva?.refs ?? []).map((ref) => {
        const k = refKey(ref);
        const card = porRef.get(k);
        return {
          ref: k,
          nome: card?.nome ?? '',
          imagem: card?.imagens?.[0]?.src ?? null,
          foraDaVitrine: !card,
        };
      });
      const jaTem = new Set(posicionadas.map((i) => i.ref));
      const restantes: Item[] = pecas
        .filter((p) => !jaTem.has(refKey(p.ref)))
        .map((p) => ({
          ref: refKey(p.ref),
          nome: p.nome,
          imagem: p.imagens?.[0]?.src ?? null,
          foraDaVitrine: false,
        }));

      const montada = [...posicionadas, ...restantes];
      setLista(montada);
      // Sujo = qualquer diferença em relação ao que está gravado, comparando a
      // lista INTEIRA: salvar grava a sequência completa da categoria.
      setSalvoRefs((salva?.refs ?? []).map(refKey));
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar a categoria');
    } finally {
      setCarregando(false);
    }
  }, [categoria, slugDaOrdem]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const refsAtuais = useMemo(() => lista.map((i) => i.ref), [lista]);
  const sujo = useMemo(() => {
    if (!lista.length) return false;
    // Já existe ordem gravada? Compara com ela. Nunca gravou? Qualquer arrasto
    // (detectado pelo botão) marca — aqui basta comparar com o prefixo salvo.
    return JSON.stringify(refsAtuais) !== JSON.stringify(salvoRefs);
  }, [refsAtuais, salvoRefs, lista.length]);

  const mover = (idx: number, dir: -1 | 1) => {
    setLista((prev) => {
      const destino = idx + dir;
      if (destino < 0 || destino >= prev.length) return prev;
      const nova = [...prev];
      [nova[idx], nova[destino]] = [nova[destino], nova[idx]];
      return nova;
    });
  };

  // Drag & drop (HTML5) — reordena ao vivo enquanto arrasta.
  const arrastando = useRef<number | null>(null);
  const aoArrastarSobre = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    const de = arrastando.current;
    if (de === null || de === idx) return;
    setLista((prev) => {
      const nova = [...prev];
      const [m] = nova.splice(de, 1);
      nova.splice(idx, 0, m);
      return nova;
    });
    arrastando.current = idx;
  };

  const salvar = async () => {
    setSalvando(true);
    setErro('');
    setAviso('');
    try {
      const refs = lista.map((i) => i.ref);
      await api(`/loja-catalog/curadoria/${slugDaOrdem}`, {
        method: 'PUT',
        body: JSON.stringify({ refs, nome: `Ordem da vitrine — ${categoria}` }),
      });
      setSalvoRefs(refs.slice(0, 100));
      setAviso(`Salvo — a vitrine de "${categoria}" segue esta ordem (site atualiza em ~1 min).`);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* ── CABEÇALHO ── */}
      <div className="flex items-center gap-3">
        <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <LayoutGrid className="w-5 h-5 text-[#B8912B]" /> Ordem da vitrine
          </h1>
          <p className="text-sm text-slate-500">
            Escolha a categoria e arraste as peças pra ordem que o site deve mostrar. As cores de
            cada peça andam juntas com ela.
          </p>
        </div>
        <button
          onClick={carregar}
          disabled={!categoria}
          className="px-3 py-2 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-600 disabled:opacity-40"
          title="Recarregar"
        >
          <RefreshCw className={`w-4 h-4 ${carregando ? 'animate-spin' : ''}`} />
        </button>
        <button
          onClick={salvar}
          disabled={salvando || !sujo || !categoria}
          className="px-4 py-2 rounded-lg bg-[#B8912B] text-white text-sm font-semibold hover:bg-[#8C7325] disabled:opacity-50 flex items-center gap-1.5"
        >
          {salvando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {sujo ? 'Salvar ordem' : 'Salvo'}
        </button>
      </div>

      {/* ── CATEGORIA ── */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 flex flex-wrap items-center gap-3">
        <label htmlFor="cat" className="text-sm font-semibold text-slate-600">
          Categoria
        </label>
        <select
          id="cat"
          value={categoria}
          onChange={(e) => setCategoria(e.target.value)}
          className="border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm min-w-[260px] bg-white"
        >
          <option value="">Escolha…</option>
          {categorias.map((c) => (
            <option key={c.valor} value={c.valor}>
              {c.valor} ({c.qtd})
            </option>
          ))}
        </select>
        {lista.length > 100 && (
          <span className="text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-3 py-1.5 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            {lista.length} peças — a ordem manual guarda as 100 primeiras; o resto segue automático.
          </span>
        )}
      </div>

      {erro && (
        <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {erro}
        </p>
      )}
      {aviso && (
        <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center gap-2">
          <Check className="w-4 h-4" /> {aviso}
        </p>
      )}

      {/* ── LISTA ORDENADA ── */}
      {categoria && (
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>
            {lista.length} peça(s) em <b>{categoria}</b> · <b>arraste</b> pra ordenar
          </span>
          {sujo && <span className="text-amber-700 font-medium">alterações não salvas</span>}
        </div>
      )}

      {!categoria ? (
        <p className="text-sm text-slate-500 p-8 text-center border border-dashed border-[#E7E2D8] rounded-xl">
          Escolha uma categoria acima pra ver e ordenar a vitrine dela.
        </p>
      ) : carregando && !lista.length ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm p-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
        </div>
      ) : !lista.length ? (
        <p className="text-sm text-slate-500 p-8 text-center border border-dashed border-[#E7E2D8] rounded-xl">
          Nenhuma peça publicada nesta categoria.
        </p>
      ) : (
        <div className="space-y-2">
          {lista.map((item, i) => (
            <div
              key={item.ref}
              draggable
              onDragStart={() => { arrastando.current = i; }}
              onDragOver={(e) => aoArrastarSobre(e, i)}
              onDragEnd={() => { arrastando.current = null; }}
              className={`flex items-center gap-3 bg-white border rounded-xl px-3 py-2 ${
                item.foraDaVitrine ? 'border-amber-300 bg-amber-50/40' : 'border-[#E7E2D8]'
              }`}
            >
              <GripVertical className="w-4 h-4 text-slate-300 shrink-0 cursor-grab active:cursor-grabbing" />
              <span className="w-7 text-center text-sm font-bold text-[#B8912B] tabular-nums shrink-0">
                {i + 1}
              </span>
              {item.imagem ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.imagem} alt="" className="w-10 h-14 object-cover rounded bg-slate-100 shrink-0" />
              ) : (
                <span className="w-10 h-14 rounded bg-slate-100 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-slate-700 font-mono">{item.ref}</div>
                {item.foraDaVitrine ? (
                  <div className="text-xs text-amber-700">fora da vitrine agora</div>
                ) : (
                  <div className="text-xs text-slate-500 truncate">{item.nome}</div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => mover(i, -1)}
                  disabled={i === 0}
                  className="p-1.5 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-600 disabled:opacity-30"
                  title="Subir"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => mover(i, 1)}
                  disabled={i === lista.length - 1}
                  className="p-1.5 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-600 disabled:opacity-30"
                  title="Descer"
                >
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
