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
 *
 * ── OS ATALHOS (10/08/2026) ──
 *
 * O nome do produto JÁ diz a resposta: "Blusa Manga Curta", "Regata Alcinha",
 * "Biquini Com Bojo", "Saída de Praia Longa". Então o mutirão que o dono pediu
 * — separar blusas por manga e criar Moda praia — é filtro + seleção em bloco,
 * não peça a peça.
 *
 * O que os atalhos NÃO fazem: marcar sozinhos. Decisão do dono ("só filtra, eu
 * marco"). O nome acerta a maioria, e a minoria que erra ("Conjunto Blusa
 * Manga Curta + Calça" não é blusa) é justamente a que não pode passar batida.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Loader2, AlertCircle, Check, Tags, Search, Plus, X, Zap } from 'lucide-react';

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

/**
 * ATALHOS — um clique arma filtro E destino.
 *
 * `excluir` é o que faz o atalho valer: "Manga 3/4" existe em blusa, vestido E
 * macacão, e "Conjunto Blusa Manga Curta + Calça" tem a palavra "blusa" sem ser
 * uma. Sem os termos negativos, o filtro viria contaminado e a seleção em bloco
 * perderia a razão de existir — voltaria a ser conferir peça por peça.
 *
 * Fica editável na tela de propósito: catálogo tem nome que ninguém previu, e
 * ajustar a palavra na hora é mais rápido que pedir deploy.
 */
const NAO_E_BLUSA = 'conjunto vestido macacao macaquinho saia calca short camisola pijama';
const ATALHOS: Array<{
  categoria: string;
  rotulo: string;
  itens: Array<{ nome: string; slug: string; busca: string; excluir?: string }>;
}> = [
  {
    categoria: 'blusas',
    rotulo: 'Blusas',
    itens: [
      { nome: 'Manga curta', slug: 'manga-curta', busca: 'manga curta', excluir: NAO_E_BLUSA },
      { nome: 'Manga longa', slug: 'manga-longa', busca: 'manga longa', excluir: NAO_E_BLUSA },
      { nome: 'Manga 3/4', slug: 'manga-3-4', busca: 'manga 3/4', excluir: NAO_E_BLUSA },
      { nome: 'Regata', slug: 'regata', busca: 'regata', excluir: NAO_E_BLUSA },
    ],
  },
  {
    categoria: 'moda-praia',
    rotulo: 'Moda praia',
    itens: [
      { nome: 'Biquíni', slug: 'biquini', busca: 'biquini' },
      { nome: 'Maiô', slug: 'maio', busca: 'maio' },
      { nome: 'Saída de praia', slug: 'saida-de-praia', busca: 'saida de praia' },
    ],
  },
];

export default function ClassificarProdutosPage() {
  const [arvore, setArvore] = useState<Arvore>({ categorias: [], subcategorias: [] });
  const [progresso, setProgresso] = useState<Progresso | null>(null);
  const [lista, setLista] = useState<Lista | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [aplicando, setAplicando] = useState(false);
  const [marcandoTodas, setMarcandoTodas] = useState(false);

  // ── filtros ──
  const [publicado, setPublicado] = useState<'1' | '0' | ''>('1'); // publicados primeiro
  const [semCategoria, setSemCategoria] = useState(true);
  const [semSubcategoria, setSemSubcategoria] = useState(false);
  const [catFiltro, setCatFiltro] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAtiva, setBuscaAtiva] = useState('');
  const [excluir, setExcluir] = useState('');
  const [excluirAtivo, setExcluirAtivo] = useState('');
  const [perPage, setPerPage] = useState(60);
  const [page, setPage] = useState(1);

  // ── seleção e destino ──
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [destCategoria, setDestCategoria] = useState('');
  const [destSubcategoria, setDestSubcategoria] = useState('');
  const [manterCategoria, setManterCategoria] = useState(false);
  const [novaSub, setNovaSub] = useState('');
  const [novaCat, setNovaCat] = useState('');
  /** Âncora do shift+clique — marcar um intervalo inteiro sem clicar 40 vezes. */
  const ancora = useRef<number | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  /** Os filtros viram query em UM lugar só: a lista e o "marcar todas" precisam ser o MESMO filtro. */
  function queryFiltros(): URLSearchParams {
    const q = new URLSearchParams();
    if (publicado) q.set('publicado', publicado);
    if (semCategoria) q.set('semCategoria', '1');
    if (semSubcategoria) q.set('semSubcategoria', '1');
    if (catFiltro) q.set('categoria', catFiltro);
    if (buscaAtiva.trim().length >= 2) q.set('busca', buscaAtiva.trim());
    if (excluirAtivo.trim()) q.set('excluir', excluirAtivo.trim());
    return q;
  }

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
      const q = queryFiltros();
      q.set('page', String(page));
      q.set('perPage', String(perPage));
      setLista(await api<Lista>(`/loja-catalog/classificacao?${q}`));
      /**
       * A seleção NÃO é limpa ao trocar de página: com 138 peças no filtro e 60
       * por página, limpar aqui obrigaria a aplicar três vezes — e é aí que se
       * perde a conta de onde parou. Quem quiser zerar tem o "limpar".
       */
      ancora.current = null;
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { carregarArvore(); }, []);
  useEffect(() => {
    carregarLista();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [publicado, semCategoria, semSubcategoria, catFiltro, buscaAtiva, excluirAtivo, perPage, page]);

  /** Só as subcategorias da categoria escolhida — as outras não fazem sentido. */
  const subsDaCategoria = useMemo(
    () => arvore.subcategorias.filter((s) => s.pai === destCategoria),
    [arvore.subcategorias, destCategoria],
  );

  const itens = lista?.itens ?? [];
  const marcadasNaPagina = useMemo(
    () => itens.filter((p) => marcadas.has(p.ref)).length,
    [itens, marcadas],
  );

  /**
   * Clique numa linha. Com SHIFT, marca do último clique até aqui — é o gesto
   * que todo mundo já conhece de gerenciador de arquivos, e o que torna
   * "marcar 30 seguidas" um gesto em vez de trinta.
   */
  function clicarItem(indice: number, shift: boolean) {
    const alvo = itens[indice];
    if (!alvo) return;
    setMarcadas((atual) => {
      const nova = new Set(atual);
      if (shift && ancora.current !== null) {
        const [ini, fim] = [ancora.current, indice].sort((a, b) => a - b);
        // O intervalo herda a ação da PONTA: se a âncora estava sendo marcada,
        // marca tudo; se desmarcada, desmarca tudo.
        const marcar = !atual.has(alvo.ref);
        for (let i = ini; i <= fim; i++) {
          const r = itens[i]?.ref;
          if (!r) continue;
          if (marcar) nova.add(r); else nova.delete(r);
        }
      } else if (nova.has(alvo.ref)) {
        nova.delete(alvo.ref);
      } else {
        nova.add(alvo.ref);
      }
      return nova;
    });
    ancora.current = indice;
  }

  function alternarPagina() {
    const todasMarcadas = itens.length > 0 && marcadasNaPagina === itens.length;
    setMarcadas((atual) => {
      const nova = new Set(atual);
      for (const p of itens) {
        if (todasMarcadas) nova.delete(p.ref); else nova.add(p.ref);
      }
      return nova;
    });
  }

  /** Marca as N do FILTRO INTEIRO, não só as da página. */
  async function marcarFiltroInteiro() {
    setMarcandoTodas(true);
    setErro(null);
    try {
      const r = await api<{ refs: string[]; total: number; limitado: boolean }>(
        `/loja-catalog/classificacao/refs?${queryFiltros()}`,
      );
      setMarcadas((atual) => new Set([...atual, ...r.refs]));
      if (r.limitado) {
        setAviso(`Marcadas ${r.refs.length} de ${r.total} — o resto vem na próxima leva.`);
      }
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao marcar todas');
    } finally {
      setMarcandoTodas(false);
    }
  }

  /** Um clique arma filtro E destino — ver ATALHOS. */
  function usarAtalho(categoria: string, item: (typeof ATALHOS)[number]['itens'][number]) {
    setBusca(item.busca);
    setBuscaAtiva(item.busca);
    setExcluir(item.excluir ?? '');
    setExcluirAtivo(item.excluir ?? '');
    // O atalho procura a peça, esteja ela classificada ou não: metade das
    // blusas já está em "blusas" e só falta a manga.
    setSemCategoria(false);
    setSemSubcategoria(false);
    setCatFiltro('');
    setPage(1);
    setMarcadas(new Set());
    setDestCategoria(categoria);
    setManterCategoria(false);
    const existe = arvore.subcategorias.some((s) => s.slug === item.slug && s.pai === categoria);
    setDestSubcategoria(existe ? item.slug : '');
    setNovaSub(existe ? '' : item.nome);
  }

  async function criarSubcategoria(nome?: string) {
    const alvo = (nome ?? novaSub).trim();
    if (!destCategoria || !alvo) return;
    try {
      const r = await api<{ ok: boolean; slug?: string; erro?: string }>(
        '/loja-catalog/classificacao/subcategoria',
        { method: 'POST', body: JSON.stringify({ pai: destCategoria, nome: alvo }) },
      );
      if (!r.ok) throw new Error(r.erro || 'Falha ao criar');
      setNovaSub('');
      await carregarArvore();
      if (r.slug) setDestSubcategoria(r.slug);
      setAviso(`Subcategoria "${alvo}" criada.`);
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao criar subcategoria');
    }
  }

  /** Categoria de NÍVEL DE CIMA — "Linha Conforto" nasce aqui e já sai selecionada. */
  async function criarCategoria() {
    const alvo = novaCat.trim();
    if (!alvo) return;
    try {
      const r = await api<{ ok: boolean; slug?: string; erro?: string }>(
        '/loja-catalog/classificacao/categoria',
        { method: 'POST', body: JSON.stringify({ nome: alvo }) },
      );
      if (!r.ok) throw new Error(r.erro || 'Falha ao criar');
      setNovaCat('');
      await carregarArvore();
      if (r.slug) { setDestCategoria(r.slug); setDestSubcategoria(''); }
      setAviso(`Categoria "${alvo}" criada.`);
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao criar categoria');
    }
  }

  async function aplicar() {
    if (!marcadas.size) return;
    if (!manterCategoria && !destCategoria) return;
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
            categoria: manterCategoria ? null : destCategoria,
            subcategoria: destSubcategoria || null,
            manterCategoria,
          }),
        },
      );
      if (!r.ok) throw new Error(r.erro || 'Falha ao aplicar');
      setAviso(`${r.atualizadas} peça(s) classificada(s).`);
      setMarcadas(new Set());
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

  const subFaltando =
    !!destCategoria && !!novaSub.trim()
    && !arvore.subcategorias.some((s) => s.slug === destSubcategoria && s.pai === destCategoria);

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

      {/* ── ATALHOS — um clique arma filtro e destino ── */}
      <div className="mb-4 bg-white rounded-lg shadow border p-4">
        <div className="text-xs font-bold uppercase text-slate-400 mb-2 flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5" /> Atalhos
        </div>
        <div className="flex flex-col gap-2">
          {ATALHOS.map((fam) => (
            <div key={fam.categoria} className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-600 w-24 shrink-0">{fam.rotulo}</span>
              {fam.itens.map((it) => (
                <button
                  key={it.slug}
                  onClick={() => usarAtalho(fam.categoria, it)}
                  className="px-3 py-1.5 rounded-full border text-sm hover:bg-brand/10 hover:border-brand/40 transition"
                >
                  {it.nome}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

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
        <div>
          <label className="block text-xs text-slate-500 mb-1">Categoria atual</label>
          <select
            value={catFiltro}
            onChange={(e) => { setCatFiltro(e.target.value); setPage(1); }}
            className="px-3 py-2 border rounded text-sm bg-white min-w-[140px]"
          >
            <option value="">Qualquer uma</option>
            {arvore.categorias.map((c) => (
              <option key={c.slug} value={c.slug}>{c.nome}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 pb-1">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={semCategoria}
              onChange={(e) => { setSemCategoria(e.target.checked); setPage(1); }}
            />
            Só as sem categoria
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={semSubcategoria}
              onChange={(e) => { setSemSubcategoria(e.target.checked); setPage(1); }}
            />
            Só as sem subcategoria
          </label>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBuscaAtiva(busca);
            setExcluirAtivo(excluir);
            setPage(1);
          }}
          className="flex items-end gap-2 flex-1 min-w-[320px]"
        >
          <div className="flex-1">
            <label className="block text-xs text-slate-500 mb-1">
              Descrição ou REF <span className="text-slate-400">— acento não importa</span>
            </label>
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="ex: manga curta, biquini, saida de praia"
              className="w-full px-3 py-2 border rounded text-sm"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-slate-500 mb-1">
              Menos as que tiverem <span className="text-slate-400">— separe por espaço</span>
            </label>
            <input
              value={excluir}
              onChange={(e) => setExcluir(e.target.value)}
              placeholder="ex: conjunto vestido macacao"
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
        <div className="mb-4 bg-brand/5 border border-brand/30 rounded-lg p-4 flex flex-wrap items-end gap-3 sticky top-2 z-10 backdrop-blur">
          <span className="text-sm font-semibold text-slate-700 pb-2">
            {marcadas.size} marcada(s) →
          </span>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Categoria</label>
            <select
              value={destCategoria}
              onChange={(e) => { setDestCategoria(e.target.value); setDestSubcategoria(''); }}
              disabled={manterCategoria}
              className="px-3 py-2 border rounded text-sm bg-white min-w-[160px] disabled:opacity-50"
            >
              <option value="">— escolher —</option>
              {arvore.categorias.map((c) => (
                <option key={c.slug} value={c.slug}>{c.nome}</option>
              ))}
            </select>
          </div>
          {/* Categoria nova sem sair da tela — "Linha Conforto" nasce aqui,
              vazia, e só aparece no site quando tiver peça marcada dentro. */}
          {!manterCategoria && (
            <div className="flex items-end gap-1">
              <div>
                <label className="block text-xs text-slate-500 mb-1">ou criar categoria</label>
                <input
                  value={novaCat}
                  onChange={(e) => setNovaCat(e.target.value)}
                  placeholder="Linha Conforto"
                  className="px-3 py-2 border rounded text-sm w-36"
                />
              </div>
              <button
                onClick={() => criarCategoria()}
                disabled={!novaCat.trim()}
                className="px-2.5 py-2 border rounded text-sm hover:bg-white disabled:opacity-40"
                title="Criar categoria de nível de cima"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          )}
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
                  className={`px-3 py-2 border rounded text-sm w-36 ${
                    subFaltando ? 'border-amber-400 bg-amber-50' : ''
                  }`}
                />
              </div>
              <button
                onClick={() => criarSubcategoria()}
                disabled={!novaSub.trim()}
                className="px-2.5 py-2 border rounded text-sm hover:bg-white disabled:opacity-40"
                title="Criar subcategoria nesta categoria"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          )}
          {/* Categoria do lote x categoria de cada peça: a mesma busca traz
              blusa, vestido e macacão. Quem quer carimbar só a manga precisa
              poder, senão um clique manda vestido pra Blusas. */}
          <label className="flex items-center gap-2 text-sm text-slate-700 pb-2.5">
            <input
              type="checkbox"
              checked={manterCategoria}
              onChange={(e) => setManterCategoria(e.target.checked)}
            />
            Manter a categoria de cada peça
          </label>
          <button
            onClick={aplicar}
            disabled={(!manterCategoria && !destCategoria) || aplicando}
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
      ) : !itens.length ? (
        <div className="p-8 text-center text-slate-400 border border-dashed rounded">
          Nenhuma peça com esses filtros. {semCategoria && 'Talvez já esteja tudo classificado aqui.'}
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-sm text-slate-500">
            <button onClick={alternarPagina} className="text-brand hover:underline font-medium">
              {marcadasNaPagina === itens.length
                ? 'Desmarcar esta página'
                : `Marcar as ${itens.length} desta página`}
            </button>
            {(lista?.total ?? 0) > itens.length && (
              <button
                onClick={marcarFiltroInteiro}
                disabled={marcandoTodas}
                className="text-brand hover:underline font-medium flex items-center gap-1.5 disabled:opacity-50"
              >
                {marcandoTodas && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Marcar as {lista?.total} do filtro
              </button>
            )}
            {marcadas.size > 0 && (
              <button
                onClick={() => { setMarcadas(new Set()); ancora.current = null; }}
                className="text-slate-500 hover:underline flex items-center gap-1"
              >
                <X className="w-3.5 h-3.5" /> Limpar seleção ({marcadas.size})
              </button>
            )}
            <span className="ml-auto">
              {lista?.total} peça(s) no filtro · <b>shift+clique</b> marca o intervalo
            </span>
          </div>
          <div className="bg-white rounded-lg shadow border divide-y">
            {itens.map((p, i) => (
              <div
                key={p.ref}
                onClick={(e) => clicarItem(i, e.shiftKey)}
                className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer select-none hover:bg-slate-50 ${
                  marcadas.has(p.ref) ? 'bg-brand/5' : ''
                }`}
              >
                {/* readOnly + pointer-events-none: o clique é da LINHA inteira,
                    senão o shift do checkbox nativo não chegaria aqui. */}
                <input
                  type="checkbox"
                  checked={marcadas.has(p.ref)}
                  readOnly
                  tabIndex={-1}
                  className="shrink-0 pointer-events-none"
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
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            {(lista?.totalPages ?? 1) > 1 && (
              <>
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 border rounded text-sm disabled:opacity-40"
                >
                  Anterior
                </button>
                <span className="text-sm text-slate-500">
                  {page} de {lista?.totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(lista?.totalPages ?? 1, p + 1))}
                  disabled={page >= (lista?.totalPages ?? 1)}
                  className="px-3 py-1.5 border rounded text-sm disabled:opacity-40"
                >
                  Próxima
                </button>
              </>
            )}
            <select
              value={perPage}
              onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}
              className="px-2 py-1.5 border rounded text-sm bg-white text-slate-500"
            >
              <option value={60}>60 por página</option>
              <option value={120}>120 por página</option>
              <option value={200}>200 por página</option>
            </select>
          </div>
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
