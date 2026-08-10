'use client';

/**
 * /retaguarda/classificar-produtos — MUTIRÃO DE CATEGORIA E SUBCATEGORIA.
 *
 * ── POR QUE ESTA TELA EXISTE ──
 *
 * Medição de 10/08/2026: das 797 peças publicadas, **345 (43%) estavam sem
 * categoria nenhuma** — no ar e fora de todo menu, achaveis só pela busca.
 * Quase metade da loja invisível pra quem navega.
 *
 * Classificar uma a uma seriam centenas de telas, e o trabalho simplesmente
 * não aconteceria. Aqui a unidade é o LOTE.
 *
 * ── O FILTRO É O RECURSO, NÃO ENFEITE ──
 *
 * Sem filtro, 773 peças é uma lista que desanima antes da segunda tela. Com
 * filtro por nome vira: buscar "VESTIDO" → marcar todas → aplicar. Dezenas
 * por vez, em minutos.
 *
 * O primeiro filtro é PUBLICADOS (pedido do dono): peça fora do ar não está
 * custando venda, então não disputa a fila.
 *
 * A árvore é a do SITE — Blusas → Manga curta —, com nome que a cliente
 * entende. Não é o grupo fiscal do Giga.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Loader2, AlertCircle, Check, Tags, Search, Plus } from 'lucide-react';

interface Peca {
  ref: string;
  nome: string;
  categoria: string | null;
  subcategoria: string | null;
  publicado: boolean;
  capa: string | null;
}
interface Lista {
  total: number; page: number; perPage: number; totalPages: number; itens: Peca[];
}
interface Arvore {
  categorias: Array<{ slug: string; nome: string; ativo: boolean }>;
  subcategorias: Array<{ slug: string; nome: string; pai: string; ativo: boolean }>;
}
interface Progresso {
  publicadas: number; semCategoria: number; semSubcategoria: number; comCategoria: number;
}

export default function ClassificarProdutosPage() {
  const [arvore, setArvore] = useState<Arvore>({ categorias: [], subcategorias: [] });
  const [progresso, setProgresso] = useState<Progresso | null>(null);
  const [lista, setLista] = useState<Lista | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [aplicando, setAplicando] = useState(false);

  // ── filtros ──
  const [publicado, setPublicado] = useState<'1' | '0' | ''>('1'); // publicados primeiro
  const [semCategoria, setSemCategoria] = useState(true);
  const [busca, setBusca] = useState('');
  const [buscaAtiva, setBuscaAtiva] = useState('');
  const [page, setPage] = useState(1);

  // ── seleção e destino ──
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [destCategoria, setDestCategoria] = useState('');
  const [destSubcategoria, setDestSubcategoria] = useState('');
  const [novaSub, setNovaSub] = useState('');

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  async function carregarArvore() {
    try {
      setArvore(await api<Arvore>('/loja-catalog/classificacao/arvore'));
      setProgresso(await api<Progresso>('/loja-catalog/classificacao/progresso'));
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao carregar categorias');
    }
  }

  async function carregarLista() {
    setLoading(true);
    setErro(null);
    try {
      const q = new URLSearchParams({ page: String(page), perPage: '60' });
      if (publicado) q.set('publicado', publicado);
      if (semCategoria) q.set('semCategoria', '1');
      if (buscaAtiva.trim().length >= 2) q.set('busca', buscaAtiva.trim());
      setLista(await api<Lista>(`/loja-catalog/classificacao?${q}`));
      setMarcadas(new Set());
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { carregarArvore(); }, []);
  useEffect(() => { carregarLista(); /* eslint-disable-next-line */ }, [publicado, semCategoria, buscaAtiva, page]);

  /** Só as subcategorias da categoria escolhida — as outras não fazem sentido. */
  const subsDaCategoria = useMemo(
    () => arvore.subcategorias.filter((s) => s.pai === destCategoria),
    [arvore.subcategorias, destCategoria],
  );

  function alternar(ref: string) {
    setMarcadas((s) => {
      const n = new Set(s);
      if (n.has(ref)) n.delete(ref); else n.add(ref);
      return n;
    });
  }
  function marcarTodas() {
    setMarcadas((s) =>
      s.size === (lista?.itens.length ?? 0) ? new Set() : new Set((lista?.itens ?? []).map((p) => p.ref)),
    );
  }

  async function criarSubcategoria() {
    if (!destCategoria || !novaSub.trim()) return;
    try {
      const r = await api<{ ok: boolean; slug?: string; erro?: string }>(
        '/loja-catalog/classificacao/subcategoria',
        { method: 'POST', body: JSON.stringify({ pai: destCategoria, nome: novaSub.trim() }) },
      );
      if (!r.ok) throw new Error(r.erro || 'Falha ao criar');
      setNovaSub('');
      await carregarArvore();
      if (r.slug) setDestSubcategoria(r.slug);
      setAviso(`Subcategoria criada.`);
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao criar subcategoria');
    }
  }

  async function aplicar() {
    if (!marcadas.size || !destCategoria) return;
    setAplicando(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await api<{ ok: boolean; atualizadas?: number; erro?: string }>(
        '/loja-catalog/classificacao',
        {
          method: 'POST',
          body: JSON.stringify({
            refs: [...marcadas],
            categoria: destCategoria,
            subcategoria: destSubcategoria || null,
          }),
        },
      );
      if (!r.ok) throw new Error(r.erro || 'Falha ao aplicar');
      setAviso(`${r.atualizadas} peça(s) classificada(s).`);
      await carregarArvore();
      await carregarLista();
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao aplicar');
    } finally {
      setAplicando(false);
    }
  }

  const nomeCat = (slug: string | null) =>
    arvore.categorias.find((c) => c.slug === slug)?.nome
    ?? arvore.subcategorias.find((c) => c.slug === slug)?.nome
    ?? slug;

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Tags className="w-6 h-6" /> Classificar produtos
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Categoria e subcategoria do site — <b>Blusas</b> → <b>Manga curta</b>. Filtre, marque
          várias e aplique de uma vez.
        </p>
      </div>

      {progresso && (
        <div className="mb-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Kpi rotulo="Publicadas" valor={progresso.publicadas} />
          <Kpi rotulo="Com categoria" valor={progresso.comCategoria} tom="ok" />
          <Kpi rotulo="Sem categoria" valor={progresso.semCategoria} tom="alerta" />
          <Kpi rotulo="Sem subcategoria" valor={progresso.semSubcategoria} />
        </div>
      )}

      {/* ── FILTROS ── */}
      <div className="mb-4 bg-white rounded-lg shadow border p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Situação</label>
          <select
            value={publicado}
            onChange={(e) => { setPublicado(e.target.value as any); setPage(1); }}
            className="px-3 py-2 border rounded text-sm bg-white"
          >
            <option value="1">Publicados</option>
            <option value="0">Não publicados</option>
            <option value="">Todos</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700 pb-2">
          <input
            type="checkbox"
            checked={semCategoria}
            onChange={(e) => { setSemCategoria(e.target.checked); setPage(1); }}
          />
          Só as sem categoria
        </label>
        <form
          onSubmit={(e) => { e.preventDefault(); setBuscaAtiva(busca); setPage(1); }}
          className="flex items-end gap-2 flex-1 min-w-[240px]"
        >
          <div className="flex-1">
            <label className="block text-xs text-slate-500 mb-1">Buscar por nome ou REF</label>
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="ex: VESTIDO, MACAQUINHO, 900887"
              className="w-full px-3 py-2 border rounded text-sm"
            />
          </div>
          <button type="submit" className="px-3 py-2 border rounded text-sm hover:bg-slate-50 flex items-center gap-2">
            <Search className="w-4 h-4" /> Buscar
          </button>
        </form>
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

      {/* ── BARRA DE AÇÃO — só aparece com peça marcada ── */}
      {marcadas.size > 0 && (
        <div className="mb-4 bg-brand/5 border border-brand/30 rounded-lg p-4 flex flex-wrap items-end gap-3">
          <span className="text-sm font-semibold text-slate-700 pb-2">
            {marcadas.size} marcada(s) →
          </span>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Categoria</label>
            <select
              value={destCategoria}
              onChange={(e) => { setDestCategoria(e.target.value); setDestSubcategoria(''); }}
              className="px-3 py-2 border rounded text-sm bg-white min-w-[160px]"
            >
              <option value="">— escolher —</option>
              {arvore.categorias.map((c) => (
                <option key={c.slug} value={c.slug}>{c.nome}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Subcategoria (opcional)</label>
            <select
              value={destSubcategoria}
              onChange={(e) => setDestSubcategoria(e.target.value)}
              disabled={!destCategoria}
              className="px-3 py-2 border rounded text-sm bg-white min-w-[160px] disabled:opacity-50"
            >
              <option value="">— nenhuma —</option>
              {subsDaCategoria.map((s) => (
                <option key={s.slug} value={s.slug}>{s.nome}</option>
              ))}
            </select>
          </div>
          {/* Criar subcategoria aqui, sem sair da tela: descobrir que falta
              "Manga curta" no meio do mutirão e ter que ir a outra tela é o
              tipo de interrupção que faz o trabalho parar. */}
          {destCategoria && (
            <div className="flex items-end gap-1">
              <div>
                <label className="block text-xs text-slate-500 mb-1">ou criar nova</label>
                <input
                  value={novaSub}
                  onChange={(e) => setNovaSub(e.target.value)}
                  placeholder="Manga curta"
                  className="px-3 py-2 border rounded text-sm w-36"
                />
              </div>
              <button
                onClick={criarSubcategoria}
                disabled={!novaSub.trim()}
                className="px-2.5 py-2 border rounded text-sm hover:bg-white disabled:opacity-40"
                title="Criar subcategoria nesta categoria"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          )}
          <button
            onClick={aplicar}
            disabled={!destCategoria || aplicando}
            className="px-4 py-2 bg-brand text-white rounded text-sm font-semibold hover:bg-brand-dark disabled:opacity-50 flex items-center gap-2 ml-auto"
          >
            {aplicando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Aplicar às {marcadas.size}
          </button>
        </div>
      )}

      {/* ── LISTA ── */}
      {loading ? (
        <div className="p-12 text-center text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mx-auto" />
        </div>
      ) : !lista?.itens.length ? (
        <div className="p-8 text-center text-slate-400 border border-dashed rounded">
          Nenhuma peça com esses filtros. {semCategoria && 'Talvez já esteja tudo classificado aqui.'}
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between text-sm text-slate-500">
            <button onClick={marcarTodas} className="text-brand hover:underline font-medium">
              {marcadas.size === lista.itens.length ? 'Desmarcar todas' : `Marcar as ${lista.itens.length} desta página`}
            </button>
            <span>{lista.total} peça(s) no filtro</span>
          </div>
          <div className="bg-white rounded-lg shadow border divide-y">
            {lista.itens.map((p) => (
              <label
                key={p.ref}
                className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-slate-50 ${
                  marcadas.has(p.ref) ? 'bg-brand/5' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={marcadas.has(p.ref)}
                  onChange={() => alternar(p.ref)}
                  className="shrink-0"
                />
                {/* Miniatura: reconhecer a peça de relance é o que permite
                    classificar rápido sem abrir cada uma. */}
                {p.capa ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.capa} alt="" className="w-10 h-12 object-cover rounded shrink-0 bg-slate-100" />
                ) : (
                  <span className="w-10 h-12 rounded bg-slate-100 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-slate-800 truncate">{p.nome}</span>
                  <span className="block text-xs text-slate-400 font-mono">{p.ref}</span>
                </span>
                <span className="shrink-0 text-xs text-slate-500 text-right">
                  {p.categoria ? (
                    <>
                      {nomeCat(p.categoria)}
                      {p.subcategoria && <span className="text-slate-400"> · {nomeCat(p.subcategoria)}</span>}
                    </>
                  ) : (
                    <span className="text-amber-700 font-medium">sem categoria</span>
                  )}
                </span>
              </label>
            ))}
          </div>

          {lista.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 border rounded text-sm disabled:opacity-40"
              >
                Anterior
              </button>
              <span className="text-sm text-slate-500">
                {page} de {lista.totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(lista.totalPages, p + 1))}
                disabled={page >= lista.totalPages}
                className="px-3 py-1.5 border rounded text-sm disabled:opacity-40"
              >
                Próxima
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({ rotulo, valor, tom }: { rotulo: string; valor: number; tom?: 'ok' | 'alerta' }) {
  const cor =
    tom === 'ok' ? 'text-emerald-700 border-emerald-200 bg-emerald-50'
    : tom === 'alerta' ? 'text-amber-800 border-amber-200 bg-amber-50'
    : 'text-slate-700 border-slate-200 bg-white';
  return (
    <div className={`rounded-lg border p-3 ${cor}`}>
      <div className="text-[10px] uppercase font-bold opacity-70">{rotulo}</div>
      <div className="text-xl font-bold tabular-nums">{valor}</div>
    </div>
  );
}
