'use client';

/**
 * /retaguarda/colecoes — AS COLEÇÕES DO SITE (fixa + pontuais).
 *
 * Dono, 26/08/2026: "trocar a Mais Top da Semana por coleção mais pontual —
 * recebemos esta semana produtos da JOIN, poderíamos separar como Coleção
 * Resort". Esta tela generaliza a antiga /retaguarda/top-da-semana: cria
 * coleção, cura a lista ORDENADA de REFs e decide QUEM ocupa a vaga de
 * coleção do MENU do site.
 *
 * Como funciona a vaga do menu: cada coleção tem o interruptor "no menu".
 * O site mostra as marcadas NO LUGAR do item fixo "Mais Top da Semana" — e
 * só as que têm peça no ar (menu pra vitrine vazia não sai). Desmarcar a
 * Mais Top e marcar a Resort é exatamente o "trocar" que o dono pediu.
 *
 * Cada coleção pontual ganha página própria no site: /colecao/<slug>. A
 * fixa segue na rota histórica /mais-top-da-semana (e no selo do feed).
 *
 * ADICIONAR PEÇA tem dois caminhos:
 *   · REF/nome — a mesma busca do mutirão de classificação;
 *   · POR MARCA — as peças da marca com as mais NOVAS primeiro e o botão
 *     "Adicionar todas": é o caminho "chegou a remessa da JOIN, vira coleção".
 *
 * A coleção NÃO mexe na categoria real da peça (a Regata continua em
 * "Blusas"). Peça fora do ar fica guardada e marcada "fora da vitrine agora".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Trophy, Loader2, Plus, RefreshCw, X, Search,
  ArrowUp, ArrowDown, GripVertical, Check, Save, AlertTriangle,
  Sparkles, Trash2, Tag, ExternalLink,
} from 'lucide-react';
import { api } from '@/lib/api';

const SLUG_FIXA = 'mais-top-da-semana';
/** Ideal editorial da vitrine fixa — aviso, não trava. */
const IDEAL_FIXA = 20;
/** Acima disso o backend CORTA em silêncio — aqui vira aviso vermelho. */
const TETO_DURO = 100;

/** Resumo de cada coleção (GET /loja-catalog/colecoes). */
interface ColecaoResumo {
  slug: string;
  nome: string;
  descricao: string | null;
  noMenu: boolean;
  fixa: boolean;
  refsTotal: number;
  noArTotal: number;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
}

/** Cartão da vitrine devolvido pelo endpoint de curadoria (só os campos usados). */
interface CardProduto {
  ref: string;
  nome: string;
  imagens?: Array<{ src: string }> | null;
}
interface CuradoriaResp {
  slug: string;
  refs: string[];
  itens: CardProduto[];
}

/** Peça devolvida pelas buscas (por REF/nome ou por marca). */
interface PecaBusca {
  ref: string;
  nome: string;
  capa: string | null;
  publicado: boolean;
}

/** Forma normalizada que a lista de trabalho usa. */
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

export default function ColecoesPage() {
  const [colecoes, setColecoes] = useState<ColecaoResumo[]>([]);
  const [slugAtivo, setSlugAtivo] = useState<string>(SLUG_FIXA);

  // ── curadoria da coleção ativa ──
  const [lista, setLista] = useState<Item[]>([]);
  /** Ordem salva no servidor — base pra saber se há mudança pendente. */
  const [salvoRefs, setSalvoRefs] = useState<string[]>([]);

  // ── meta da coleção ativa (nome / subtítulo / vaga no menu) ──
  const [nome, setNome] = useState('');
  const [descricao, setDescricao] = useState('');
  const [noMenu, setNoMenu] = useState(false);

  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');

  // ── criar coleção ──
  const [criando, setCriando] = useState(false);
  const [novoNome, setNovoNome] = useState('');
  const [criandoBusy, setCriandoBusy] = useState(false);

  // ── busca por REF/nome ──
  const [busca, setBusca] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [resultados, setResultados] = useState<PecaBusca[]>([]);
  const [buscou, setBuscou] = useState(false);

  // ── busca por marca (o caminho "chegou a remessa da JOIN") ──
  const [marcas, setMarcas] = useState<Array<{ valor: string; qtd: number }>>([]);
  const [marcaSel, setMarcaSel] = useState('');
  const [buscandoMarca, setBuscandoMarca] = useState(false);
  const [resultadosMarca, setResultadosMarca] = useState<PecaBusca[]>([]);
  const [buscouMarca, setBuscouMarca] = useState(false);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  /** Hidrata o painel de meta a partir do resumo (a fonte é a lista de coleções). */
  const hidratarMeta = useCallback((slug: string, listaColecoes: ColecaoResumo[]) => {
    const c = listaColecoes.find((x) => x.slug === slug);
    setNome(c?.nome ?? '');
    setDescricao(c?.descricao ?? '');
    setNoMenu(c?.noMenu ?? false);
  }, []);

  const carregarColecoes = useCallback(async (): Promise<ColecaoResumo[]> => {
    const r = await api<ColecaoResumo[]>('/loja-catalog/colecoes');
    const linhas = Array.isArray(r) ? r : [];
    setColecoes(linhas);
    return linhas;
  }, []);

  const carregarCuradoria = useCallback(async (slug: string) => {
    const r = await api<CuradoriaResp>(`/loja-catalog/curadoria/${slug}`);
    // A ORDEM e a MEMBRESIA vêm de `refs` (fonte da verdade); `itens` só
    // enriquece com foto/nome as que estão na vitrine agora.
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
  }, []);

  /** Carga completa de UMA coleção (resumos + curadoria + meta). */
  const carregar = useCallback(
    async (slug: string) => {
      setCarregando(true);
      setErro('');
      try {
        const [linhas] = await Promise.all([carregarColecoes(), carregarCuradoria(slug)]);
        hidratarMeta(slug, linhas);
      } catch (e: any) {
        setErro(e?.message || 'Não consegui carregar as coleções');
      } finally {
        setCarregando(false);
      }
    },
    [carregarColecoes, carregarCuradoria, hidratarMeta],
  );

  useEffect(() => {
    carregar(slugAtivo);
    // Recarrega tudo quando troca a coleção ativa.
  }, [slugAtivo, carregar]);

  const ativa = useMemo(
    () => colecoes.find((c) => c.slug === slugAtivo) ?? null,
    [colecoes, slugAtivo],
  );

  const refsAtuais = useMemo(() => lista.map((i) => i.ref), [lista]);
  const refsSet = useMemo(() => new Set(refsAtuais), [refsAtuais]);
  const refsSujo = useMemo(
    () => JSON.stringify(refsAtuais) !== JSON.stringify(salvoRefs),
    [refsAtuais, salvoRefs],
  );
  const metaSujo = useMemo(() => {
    if (!ativa) return false;
    return (
      nome.trim() !== (ativa.nome ?? '') ||
      descricao.trim() !== (ativa.descricao ?? '') ||
      noMenu !== ativa.noMenu
    );
  }, [ativa, nome, descricao, noMenu]);
  const sujo = refsSujo || metaSujo;

  const urlDoSite = slugAtivo === SLUG_FIXA ? '/mais-top-da-semana' : `/colecao/${slugAtivo}`;

  /** Trocar de coleção com alteração pendente descarta — só com confirmação. */
  const trocar = (slug: string) => {
    if (slug === slugAtivo) return;
    if (sujo && !window.confirm('Há alterações não salvas nesta coleção. Descartar?')) return;
    setBusca(''); setResultados([]); setBuscou(false);
    setResultadosMarca([]); setBuscouMarca(false);
    setAviso('');
    setSlugAtivo(slug);
  };

  // ── CRIAR ──
  const criar = async () => {
    const n = novoNome.trim();
    if (n.length < 2) return;
    setCriandoBusy(true);
    setErro('');
    try {
      const r = await api<{ slug: string }>('/loja-catalog/colecoes', {
        method: 'POST',
        body: JSON.stringify({ nome: n }),
      });
      setNovoNome('');
      setCriando(false);
      setAviso(`Coleção "${n}" criada — agora é só adicionar as peças.`);
      setSlugAtivo(r.slug); // o efeito recarrega tudo
    } catch (e: any) {
      setErro(e?.message || 'Não consegui criar a coleção');
    } finally {
      setCriandoBusy(false);
    }
  };

  // ── EXCLUIR (só as pontuais) ──
  const excluir = async () => {
    if (!ativa || ativa.fixa) return;
    const ok = window.confirm(
      `Apagar a coleção "${ativa.nome}"?\n\nA página /colecao/${ativa.slug} sai do ar e ela some do menu e da home. As peças não são afetadas.`,
    );
    if (!ok) return;
    setSalvando(true);
    setErro('');
    try {
      await api(`/loja-catalog/colecoes/${ativa.slug}`, { method: 'DELETE' });
      setAviso(`Coleção "${ativa.nome}" apagada.`);
      setSlugAtivo(SLUG_FIXA);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui apagar');
    } finally {
      setSalvando(false);
    }
  };

  // ── BUSCA por REF/nome (mesma máquina do mutirão de classificação) ──
  const buscar = async () => {
    const termo = busca.trim();
    if (termo.length < 2) return;
    setBuscando(true);
    setErro('');
    setBuscou(true);
    try {
      const q = new URLSearchParams({ busca: termo, perPage: '30' });
      const r = await api<{ itens: PecaBusca[] }>(`/loja-catalog/classificacao?${q}`);
      setResultados(r.itens ?? []);
    } catch (e: any) {
      setErro(e?.message || 'Falha na busca');
    } finally {
      setBuscando(false);
    }
  };

  // ── BUSCA por MARCA — mais novas primeiro ──
  const abrirMarcas = async () => {
    if (marcas.length) return;
    try {
      const r = await api<{ marcas?: Array<{ valor: string; qtd: number }> }>('/public/loja/filtros');
      setMarcas(r?.marcas ?? []);
    } catch {
      /* o select fica vazio; a busca por REF continua funcionando */
    }
  };

  const buscarMarca = async (marca: string) => {
    if (!marca) return;
    setBuscandoMarca(true);
    setErro('');
    setBuscouMarca(true);
    try {
      // A vitrine pública com `ordenar=novidades`: o que CHEGOU primeiro no
      // catálogo aparece primeiro — é a remessa da semana no topo.
      const q = new URLSearchParams({ marca, ordenar: 'novidades', perPage: '60' });
      const r = await api<{ itens: Array<{ ref: string; nome: string; imagens?: Array<{ src: string }> }> }>(
        `/public/loja/produtos?${q}`,
      );
      setResultadosMarca(
        (r?.itens ?? []).map((p) => ({
          ref: p.ref,
          nome: p.nome,
          capa: p.imagens?.[0]?.src ?? null,
          publicado: true,
        })),
      );
    } catch (e: any) {
      setErro(e?.message || 'Falha na busca por marca');
    } finally {
      setBuscandoMarca(false);
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

  /** O lote inteiro da marca de uma vez — respeitando o teto duro de 100. */
  const adicionarTodas = () => {
    setLista((prev) => {
      const vistos = new Set(prev.map((i) => i.ref));
      const novos: Item[] = [];
      for (const p of resultadosMarca) {
        const k = refKey(p.ref);
        if (vistos.has(k)) continue;
        if (prev.length + novos.length >= TETO_DURO) break;
        vistos.add(k);
        novos.push({ ref: k, nome: p.nome, imagem: p.capa, foraDaVitrine: false });
      }
      return [...prev, ...novos];
    });
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

  /** UM salvar pra tudo: meta (se mudou) + a lista ordenada de REFs. */
  const salvar = async () => {
    setSalvando(true);
    setErro('');
    setAviso('');
    try {
      if (metaSujo) {
        await api(`/loja-catalog/colecoes/${slugAtivo}`, {
          method: 'PATCH',
          body: JSON.stringify({ nome: nome.trim(), descricao: descricao.trim(), noMenu }),
        });
      }
      if (refsSujo) {
        await api(`/loja-catalog/curadoria/${slugAtivo}`, {
          method: 'PUT',
          body: JSON.stringify({ refs: lista.map((i) => i.ref) }),
        });
      }
      setAviso(`Salvo — ${lista.length} peça(s) na "${nome.trim() || slugAtivo}".`);
      // Recarrega pra reconciliar (peça esgotada vira "fora da vitrine").
      await carregar(slugAtivo);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  };

  const acimaIdeal = ativa?.fixa ? lista.length - IDEAL_FIXA : 0;
  const acimaTeto = lista.length - TETO_DURO;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* ── CABEÇALHO ── */}
      <div className="flex items-center gap-3">
        <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-[#B8912B]" /> Coleções do site
          </h1>
          <p className="text-sm text-slate-500">
            Crie coleções pontuais (ex.: Resort com as peças da JOIN) e escolha qual ocupa o menu do site.
          </p>
        </div>
        <button
          onClick={() => carregar(slugAtivo)}
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

      {/* ── AS COLEÇÕES (pílulas) + criar ── */}
      <div className="flex flex-wrap items-center gap-2">
        {colecoes.map((c) => {
          const ativaPill = c.slug === slugAtivo;
          return (
            <button
              key={c.slug}
              onClick={() => trocar(c.slug)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition ${
                ativaPill
                  ? 'border-[#B8912B] bg-[#FBF6E6] text-[#8C7325] font-semibold'
                  : 'border-[#E7E2D8] bg-white text-slate-600 hover:bg-[#FBF6E6]'
              }`}
              title={c.noMenu ? 'Está no menu do site' : 'Fora do menu do site'}
            >
              {c.fixa ? <Trophy className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
              {c.nome}
              <span className="text-xs text-slate-400 tabular-nums">{c.noArTotal}</span>
              {c.noMenu && (
                <span className="text-[10px] uppercase tracking-wide bg-[#B8912B]/10 text-[#8C7325] rounded px-1 py-0.5">
                  menu
                </span>
              )}
            </button>
          );
        })}

        {criando ? (
          <form
            onSubmit={(e) => { e.preventDefault(); criar(); }}
            className="flex items-center gap-1.5"
          >
            <input
              autoFocus
              value={novoNome}
              onChange={(e) => setNovoNome(e.target.value)}
              placeholder='Nome (ex.: "Coleção Resort")'
              className="border border-[#E7E2D8] rounded-full px-3 py-1.5 text-sm w-52"
            />
            <button
              type="submit"
              disabled={criandoBusy || novoNome.trim().length < 2}
              className="px-3 py-1.5 rounded-full bg-[#B8912B] text-white text-sm font-semibold hover:bg-[#8C7325] disabled:opacity-50 flex items-center gap-1"
            >
              {criandoBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Criar
            </button>
            <button
              type="button"
              onClick={() => { setCriando(false); setNovoNome(''); }}
              className="p-1.5 rounded-full border border-[#E7E2D8] text-slate-500 hover:bg-[#FBF6E6]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </form>
        ) : (
          <button
            onClick={() => setCriando(true)}
            className="flex items-center gap-1 rounded-full border border-dashed border-[#B8912B]/50 px-3 py-1.5 text-sm text-[#8C7325] hover:bg-[#FBF6E6]"
          >
            <Plus className="w-3.5 h-3.5" /> Nova coleção
          </button>
        )}
      </div>

      {/* ── META DA COLEÇÃO ATIVA ── */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex-1 min-w-[220px] text-sm">
            <span className="block text-xs font-semibold text-slate-500 mb-1">Nome (o que sai no menu e na página)</span>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              className="w-full border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <div className="text-sm text-slate-500 pb-2 flex items-center gap-1.5">
            <ExternalLink className="w-3.5 h-3.5" />
            <span className="font-mono text-xs">{urlDoSite}</span>
          </div>
          {!ativa?.fixa && (
            <button
              onClick={excluir}
              disabled={salvando}
              className="px-3 py-2 rounded-lg border border-[#E7E2D8] text-slate-500 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-sm flex items-center gap-1.5"
              title="Apagar esta coleção (as peças não são afetadas)"
            >
              <Trash2 className="w-4 h-4" /> Apagar
            </button>
          )}
        </div>

        <label className="block text-sm">
          <span className="block text-xs font-semibold text-slate-500 mb-1">
            Subtítulo da página (opcional)
          </span>
          <input
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            placeholder="Ex.: Peças leves pra temporada — a coleção Resort da JOIN, do 46 ao 60."
            className="w-full border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm"
          />
        </label>

        <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={noMenu}
            onChange={(e) => setNoMenu(e.target.checked)}
            className="mt-0.5 accent-[#B8912B]"
          />
          <span>
            <b>Mostrar no menu do site</b>
            <span className="block text-xs text-slate-500">
              As coleções marcadas ocupam a vaga que era fixa da &quot;Mais Top da Semana&quot; — pra
              trocar, desmarque uma e marque a outra. Coleção sem peça no ar não sai no menu.
            </span>
          </span>
        </label>
      </div>

      {/* ── ADICIONAR PEÇA ── */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 space-y-4">
        <div className="text-sm font-semibold text-slate-600">Adicionar peça</div>

        {/* por REF/nome */}
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
          <ResultadosBusca resultados={resultados} refsSet={refsSet} adicionar={adicionar} />
        )}

        {/* por MARCA — o caminho "chegou a remessa da JOIN" */}
        <div className="border-t border-dashed border-[#E7E2D8] pt-3 space-y-2">
          <div className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
            <Tag className="w-3.5 h-3.5" /> Por marca — as que chegaram por último primeiro
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <select
              value={marcaSel}
              onFocus={abrirMarcas}
              onChange={(e) => {
                setMarcaSel(e.target.value);
                if (e.target.value) buscarMarca(e.target.value);
              }}
              className="border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm min-w-[220px] bg-white"
            >
              <option value="">Escolha a marca…</option>
              {marcas.map((m) => (
                <option key={m.valor} value={m.valor}>
                  {m.valor} ({m.qtd})
                </option>
              ))}
            </select>
            {buscandoMarca && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
            {resultadosMarca.length > 0 && (
              <button
                onClick={adicionarTodas}
                className="px-3 py-2 rounded-lg bg-[#FBF6E6] border border-[#B8912B]/40 text-[#8C7325] text-sm font-semibold hover:bg-[#B8912B]/10 flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                Adicionar todas ({resultadosMarca.filter((p) => !refsSet.has(refKey(p.ref))).length})
              </button>
            )}
          </div>
          {buscouMarca && !buscandoMarca && !resultadosMarca.length && (
            <p className="text-sm text-slate-400">Nenhuma peça publicada dessa marca.</p>
          )}
          {resultadosMarca.length > 0 && (
            <ResultadosBusca resultados={resultadosMarca} refsSet={refsSet} adicionar={adicionar} />
          )}
        </div>
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

      {/* Ideal de 20 só na fixa (vitrine editorial); teto duro de 100 pra todas. */}
      {acimaTeto > 0 ? (
        <p className="text-sm text-red-800 bg-red-50 border border-red-300 rounded-lg px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {lista.length} peças — acima de {TETO_DURO} o sistema corta as últimas {acimaTeto} ao salvar.
        </p>
      ) : acimaIdeal > 0 ? (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {lista.length} peças na lista — {acimaIdeal} acima do ideal de {IDEAL_FIXA}. Dá pra salvar,
          mas a vitrine fica melhor com {IDEAL_FIXA}.
        </p>
      ) : null}

      {/* ── LISTA ORDENADA ── */}
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>
          {lista.length} peça(s) · <b>arraste</b> pra ordenar — a ordem daqui é a ordem no site
        </span>
        {sujo && <span className="text-amber-700 font-medium">alterações não salvas</span>}
      </div>

      {carregando && !lista.length ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm p-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
        </div>
      ) : !lista.length ? (
        <p className="text-sm text-slate-500 p-8 text-center border border-dashed border-[#E7E2D8] rounded-xl">
          Nenhuma peça ainda — busque acima (por REF ou por marca) e monte a coleção.
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

/**
 * Grade de resultados de busca — compartilhada pelos dois caminhos (REF/nome e
 * marca). Componente de MÓDULO, não definido dentro da página: componente
 * dentro de componente remonta a cada tecla e come o foco do input.
 */
function ResultadosBusca({
  resultados,
  refsSet,
  adicionar,
}: {
  resultados: PecaBusca[];
  refsSet: Set<string>;
  adicionar: (p: PecaBusca) => void;
}) {
  return (
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
  );
}
