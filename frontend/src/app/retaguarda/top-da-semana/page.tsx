'use client';

/**
 * /retaguarda/top-da-semana — CURADORIA "Mais Top da Semana".
 *
 * Dono, 16/08/2026: os 20 destaques da semana são escolha HUMANA. Esta tela
 * grava a lista ORDENADA de REFs de uma coleção paralela (`SiteColecao` slug
 * "mais-top-da-semana"); a vitrine e o feed do Meta obedecem essa ordem — o
 * primeiro da lista é o primeiro no site e o carimbo `custom_label_1` do feed.
 *
 * A coleção NÃO mexe na categoria real de cada peça: a Regata continua em
 * "Blusas", só ganha o selo de destaque. Peça que saiu do ar (despublicada ou
 * esgotada) some da vitrine sozinha, mas a REF fica guardada aqui e marcada
 * "fora da vitrine agora" — igual ao Looks — pra não sumir da curadoria só
 * porque acabou o estoque de um tamanho.
 *
 * BUSCA pra adicionar peça: mesma máquina do mutirão de classificação
 * (`/loja-catalog/classificacao?busca=`), que acha por REF ou nome no catálogo.
 * Adicionar joga a peça no FIM da lista. Reordenar é arrastar OU as setas ↑/↓.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Trophy, Loader2, Plus, RefreshCw, X, Search,
  ArrowUp, ArrowDown, GripVertical, Check, Save, AlertTriangle,
} from 'lucide-react';
import { api } from '@/lib/api';

const SLUG = 'mais-top-da-semana';
const TETO = 20;

/** Cartão da vitrine devolvido pelo endpoint de curadoria (só os campos usados). */
interface CardProduto {
  ref: string;
  nome: string;
  preco?: number | null;
  imagens?: Array<{ src: string }> | null;
}
interface CuradoriaResp {
  slug: string;
  refs: string[];
  itens: CardProduto[];
  total: number;
}

/** Peça devolvida pela busca de classificação (search por REF/nome). */
interface PecaBusca {
  ref: string;
  nome: string;
  capa: string | null;
  publicado: boolean;
}
interface ListaBusca {
  itens: PecaBusca[];
  total: number;
}

/** Forma normalizada que a lista de trabalho usa — vem da curadoria OU da busca. */
interface Item {
  ref: string;
  nome: string;
  imagem: string | null;
  /** true = REF guardada mas fora do catálogo publicado agora (esgotada/despublicada). */
  foraDaVitrine: boolean;
}

/** Mesma normalização do backend (`refKey`): UPPER/TRIM/sem espaço. */
function refKey(r: unknown): string {
  return String(r ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

export default function TopDaSemanaPage() {
  const [lista, setLista] = useState<Item[]>([]);
  /** Ordem salva no servidor — base pra saber se há mudança pendente. */
  const [salvoRefs, setSalvoRefs] = useState<string[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');

  // ── busca pra adicionar ──
  const [busca, setBusca] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [resultados, setResultados] = useState<PecaBusca[]>([]);
  const [buscou, setBuscou] = useState(false);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await api<CuradoriaResp>(`/loja-catalog/curadoria/${SLUG}`);
      // A ORDEM e a MEMBRESIA vêm de `refs` (fonte da verdade); `itens` só
      // enriquece com foto/nome as que estão na vitrine agora. REF sem card
      // continua na lista marcada "fora da vitrine" — não some por estar
      // esgotada.
      const porRef = new Map<string, CardProduto>();
      for (const it of r.itens ?? []) porRef.set(refKey(it.ref), it);
      const montada: Item[] = (r.refs ?? []).map((ref) => {
        const k = refKey(ref);
        const card = porRef.get(k);
        return {
          ref: k,
          nome: card?.nome ?? '',
          imagem: card?.imagens?.[0]?.src ?? null,
          foraDaVitrine: !card,
        };
      });
      setLista(montada);
      setSalvoRefs(montada.map((i) => i.ref));
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar a curadoria');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  const refsAtuais = useMemo(() => lista.map((i) => i.ref), [lista]);
  const refsSet = useMemo(() => new Set(refsAtuais), [refsAtuais]);
  const sujo = useMemo(
    () => JSON.stringify(refsAtuais) !== JSON.stringify(salvoRefs),
    [refsAtuais, salvoRefs],
  );

  // ── BUSCA (mesma máquina do mutirão de classificação) ──
  const buscar = async () => {
    const termo = busca.trim();
    if (termo.length < 2) return;
    setBuscando(true);
    setErro('');
    setBuscou(true);
    try {
      const q = new URLSearchParams({ busca: termo, perPage: '30' });
      const r = await api<ListaBusca>(`/loja-catalog/classificacao?${q}`);
      setResultados(r.itens ?? []);
    } catch (e: any) {
      setErro(e?.message || 'Falha na busca');
    } finally {
      setBuscando(false);
    }
  };

  /** Adiciona a peça no FIM da lista (dedup — clicar duas vezes não repete). */
  const adicionar = (p: PecaBusca) => {
    const k = refKey(p.ref);
    if (refsSet.has(k)) return;
    setLista((prev) => [
      ...prev,
      { ref: k, nome: p.nome, imagem: p.capa, foraDaVitrine: !p.publicado },
    ]);
  };

  const remover = (ref: string) => {
    setLista((prev) => prev.filter((i) => i.ref !== ref));
  };

  /** Setas ↑/↓ — garantia pra quem não quer arrastar. */
  const mover = (idx: number, dir: -1 | 1) => {
    setLista((prev) => {
      const destino = idx + dir;
      if (destino < 0 || destino >= prev.length) return prev;
      const nova = [...prev];
      [nova[idx], nova[destino]] = [nova[destino], nova[idx]];
      return nova;
    });
  };

  // ── drag & drop (HTML5) — reordena ao vivo enquanto arrasta ──
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
      await api(`/loja-catalog/curadoria/${SLUG}`, {
        method: 'PUT',
        body: JSON.stringify({ refs }),
      });
      setSalvoRefs(refs);
      setAviso(`Salvo — ${refs.length} peça(s) na "Mais Top da Semana".`);
      // Recarrega pra reconciliar (peça esgotada vira "fora da vitrine").
      await carregar();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  };

  const acima = lista.length - TETO;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* ── CABEÇALHO ── */}
      <div className="flex items-center gap-3">
        <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Trophy className="w-5 h-5 text-[#B8912B]" /> Mais Top da Semana
          </h1>
          <p className="text-sm text-slate-500">
            Os {TETO} destaques da vitrine, na ordem que você escolher — arraste ou use as setas.
          </p>
        </div>
        <button
          onClick={carregar}
          className="px-3 py-2 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-600"
          title="Recarregar"
        >
          <RefreshCw className={`w-4 h-4 ${carregando ? 'animate-spin' : ''}`} />
        </button>
        <button
          onClick={salvar}
          disabled={salvando || !sujo}
          className="px-4 py-2 rounded-lg bg-[#B8912B] text-white text-sm font-semibold hover:bg-[#8C7325] disabled:opacity-50 flex items-center gap-1.5"
        >
          {salvando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {sujo ? 'Salvar' : 'Salvo'}
        </button>
      </div>

      {/* ── ADICIONAR PEÇA (busca por REF/nome) ── */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 space-y-3">
        <div className="text-sm font-semibold text-slate-600">Adicionar peça</div>
        <form
          onSubmit={(e) => { e.preventDefault(); buscar(); }}
          className="flex flex-wrap gap-2"
        >
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="REF ou nome (ex.: 403048, regata alcinha)"
            className="border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm flex-1 min-w-[240px]"
          />
          <button
            type="submit"
            disabled={buscando || busca.trim().length < 2}
            className="px-4 py-2 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-700 text-sm font-semibold disabled:opacity-50 flex items-center gap-1.5"
          >
            {buscando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Buscar
          </button>
        </form>

        {buscou && !buscando && !resultados.length && (
          <p className="text-sm text-slate-400">Nenhuma peça encontrada.</p>
        )}

        {resultados.length > 0 && (
          <div className="flex flex-wrap gap-2 max-h-72 overflow-y-auto">
            {resultados.map((p) => {
              const jaTem = refsSet.has(refKey(p.ref));
              return (
                <button
                  key={p.ref}
                  onClick={() => adicionar(p)}
                  disabled={jaTem}
                  className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition ${
                    jaTem
                      ? 'border-[#E7E2D8] bg-[#FAFAF7] opacity-50 cursor-default'
                      : 'border-[#E7E2D8] hover:bg-[#FBF6E6] hover:border-[#B8912B]/40'
                  }`}
                  title={jaTem ? 'Já está na lista' : 'Adicionar ao fim da lista'}
                >
                  {p.capa ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.capa} alt="" className="w-9 h-12 object-cover rounded bg-slate-100" />
                  ) : (
                    <span className="w-9 h-12 rounded bg-slate-100" />
                  )}
                  <div className="text-xs leading-tight max-w-[160px]">
                    <div className="font-semibold text-slate-700 font-mono">{p.ref}</div>
                    <div className="text-slate-500 truncate">{p.nome}</div>
                  </div>
                  {jaTem ? (
                    <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                  ) : (
                    <Plus className="w-4 h-4 text-[#B8912B] shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
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

      {/* Teto de 20: avisa, não trava (o backend corta em 100). */}
      {acima > 0 && (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {lista.length} peças na lista — {acima} acima do ideal de {TETO}. Dá pra salvar, mas a
          vitrine fica melhor com {TETO}.
        </p>
      )}

      {/* ── LISTA ORDENADA ── */}
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>
          {lista.length} de {TETO} · <b>arraste</b> pra ordenar
        </span>
        {sujo && <span className="text-amber-700 font-medium">alterações não salvas</span>}
      </div>

      {carregando && !lista.length ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm p-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
        </div>
      ) : !lista.length ? (
        <p className="text-sm text-slate-500 p-8 text-center border border-dashed border-[#E7E2D8] rounded-xl">
          Nenhuma peça ainda — busque acima e adicione as {TETO} da semana.
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
              <span className="w-6 text-center text-sm font-bold text-[#B8912B] tabular-nums shrink-0">
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
                <button
                  onClick={() => remover(item.ref)}
                  className="p-1.5 rounded-lg border border-[#E7E2D8] hover:bg-red-50 hover:border-red-200 text-slate-400 hover:text-red-600"
                  title="Tirar da lista"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
