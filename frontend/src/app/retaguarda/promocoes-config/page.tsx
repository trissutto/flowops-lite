'use client';

/**
 * /retaguarda/promocoes-config — a CAMPANHA POR TERMO (dono, 15/09/2026).
 *
 * Substituiu a tela da promoção de 50% ("liquida antigos"), que saiu do ar no
 * mesmo dia. Aqui a matriz:
 *   1. liga/desliga a campanha, dá o nome e o % (hoje "Inverno 30%");
 *   2. escreve os TERMOS que separam o que entra (CASACO, MOLETOM…), as
 *      PALAVRAS QUE EXCLUEM (BERMUDA, 22 DE ABRIL…) e escolhe GRUPOS/SUBGRUPOS
 *      do ERP — e vê o efeito ANTES de salvar (a prévia roda com o rascunho);
 *   3. confere cada modelo que entrou e tira o que não é (ou põe na mão o que
 *      a regra não pegou);
 *   4. BUSCA qualquer peça com estoque (dentro ou fora da campanha), filtra
 *      por grupo/subgrupo/marca e inclui ou tira VÁRIAS de uma vez;
 *   5. vê o que as LOJAS tiraram pela Consulta do PDV ("não é inverno"), com
 *      quem, onde e por quê — e devolve com um clique se foi engano.
 *
 * Quem decide, na ordem: tirada na mão > incluída na mão > palavra que exclui
 * > termo ou grupo/subgrupo > fora. A régua é uma só
 * (`backend/src/common/promo-por-termo.ts`): o que esta tela mostra é o que o
 * caixa aplica e o que o site cobra.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  AlertCircle, ArrowLeft, Ban, Check, Loader2, Percent, Plus, RefreshCcw, Save, Search, Snowflake, Undo2, X,
} from 'lucide-react';

interface Campanha {
  ativa: boolean;
  nome: string;
  pct: number;
  termos: string[];
  termosExclusao: string[];
  grupos: number[];
  subgrupos: number[];
  atualizadaEm?: string | null;
  atualizadaPor?: string | null;
}

interface Excecao {
  chave: string;
  decisao: 'fora' | 'dentro';
  motivo?: string | null;
  origem?: string | null;
  storeCode?: string | null;
  usuario?: string | null;
  refExemplo?: string | null;
  descricao?: string | null;
  em?: string | null;
}

interface Familia {
  chave: string;
  refs: string[];
  descricao: string;
  grupo: string | null;
  precoMin: number;
  precoMax: number;
  precoPromoMin: number;
  /** Peças que entram (na tirada, a família toda). */
  estoque: number;
  estoqueFamilia: number;
  codigos: number;
  codigosNaCampanha: number;
  termos: string[];
  /** Termos + grupos/subgrupos que puseram a peça. */
  origens?: string[];
  situacao: 'entra' | 'parcial' | 'tirada' | 'incluida';
  excecao: Excecao | null;
}

interface Preview {
  campanha: Campanha;
  chaveCampanha: string;
  totais: { familias: number; estoque: number; tiradas: number; incluidas: number; parciais: number };
  familias: Familia[];
  sugestoes: Array<{ termo: string; familias: number; estoque: number; exemplos: string[] }>;
  excecoes: Excecao[];
  calculadoEm: string;
}

interface Estrutura {
  grupos: Array<{ codigo: number; nome: string; codigos: number; pecas: number }>;
  subgrupos: Array<{ codigo: number; nome: string; grupo: number | null; grupoNome: string | null; codigos: number; pecas: number }>;
  marcas: Array<{ nome: string; pecas: number }>;
  pecasTotal: number;
  pecasSemGrupo: number;
}

interface ProdutoBusca {
  chave: string;
  refs: string[];
  descricao: string;
  grupo: string | null;
  subgrupo: string | null;
  marca: string | null;
  precoMin: number;
  precoMax: number;
  precoPromoMin: number;
  estoque: number;
  codigos: number;
  codigosNaCampanha: number;
  situacao: 'entra' | 'parcial' | 'fora' | 'excluida' | 'tirada' | 'incluida';
  origens: string[];
  exclusoes: string[];
  /** Tipos de peça sob a mesma REF-BASE — mais de um = REF reciclada. */
  tipos: string[];
  excecao: Excecao | null;
}

interface BuscaResp {
  total: number;
  totais: { dentro: number; fora: number };
  pagina: number;
  porPagina: number;
  produtos: ProdutoBusca[];
}

type Aba = 'entram' | 'tiradas' | 'incluidas' | 'buscar';
type Participacao = 'todos' | 'dentro' | 'fora';

const POR_PAGINA = 50;

const brl = (n: number) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = (n: number) => Number(n || 0).toLocaleString('pt-BR');
const quando = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const msgErro = (e: any) => {
  const m = e?.body?.message;
  if (Array.isArray(m)) return m.join(' · ');
  return m || e?.message || 'Falha';
};
const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const mesmoTermo = (a: string, b: string) => semAcento(a).replace(/\s+/g, ' ').trim() === semAcento(b).replace(/\s+/g, ' ').trim();
const mesmaLista = <T,>(a: T[] = [], b: T[] = []) => a.join('|') === b.join('|');

/**
 * A campanha como a tela precisa: com as listas novas SEMPRE presentes. No
 * deploy, a Vercel pode subir esta tela minutos antes do backend novo — e o
 * backend antigo não manda `termosExclusao`/`grupos`/`subgrupos`. Sem isto a
 * tela quebrava inteira nessa janela.
 */
const comListas = (c: Campanha): Campanha => ({
  ...c,
  termos: c.termos ?? [],
  termosExclusao: c.termosExclusao ?? [],
  grupos: c.grupos ?? [],
  subgrupos: c.subgrupos ?? [],
});

/** O que vai pro backend como rascunho (prévia e busca respondem por ele). */
const corpoRascunho = (c: Campanha) => ({
  nome: c.nome,
  pct: Number(c.pct),
  termos: c.termos,
  termosExclusao: c.termosExclusao,
  grupos: c.grupos,
  subgrupos: c.subgrupos,
});

const SITUACAO: Record<ProdutoBusca['situacao'], { rotulo: string; classe: string }> = {
  entra: { rotulo: 'Na campanha', classe: 'bg-sky-100 text-sky-900' },
  parcial: { rotulo: 'Parcial', classe: 'bg-amber-100 text-amber-900' },
  incluida: { rotulo: 'Incluída na mão', classe: 'bg-emerald-100 text-emerald-900' },
  fora: { rotulo: 'Fora', classe: 'bg-slate-100 text-slate-600' },
  excluida: { rotulo: 'Excluída por palavra', classe: 'bg-rose-100 text-rose-800' },
  tirada: { rotulo: 'Tirada na mão', classe: 'bg-rose-100 text-rose-800' },
};

export default function PromocoesConfigPage() {
  const [gravada, setGravada] = useState<Campanha | null>(null);
  const [rascunho, setRascunho] = useState<Campanha | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [calculando, setCalculando] = useState(false);
  const [erroPreview, setErroPreview] = useState<string | null>(null);

  const [estrutura, setEstrutura] = useState<Estrutura | null>(null);
  const [novoTermo, setNovoTermo] = useState('');
  const [novaExclusao, setNovaExclusao] = useState('');
  const [grupoEscolhido, setGrupoEscolhido] = useState('');
  const [subgrupoEscolhido, setSubgrupoEscolhido] = useState('');

  const [aba, setAba] = useState<Aba>('entram');
  const [busca, setBusca] = useState('');
  const [limite, setLimite] = useState(100);
  const [acaoEm, setAcaoEm] = useState<string | null>(null);
  const [tirando, setTirando] = useState<{ chave: string; motivo: string } | null>(null);
  const [incluir, setIncluir] = useState<{ ref: string; motivo: string; tipo: 'ref' | 'codigo' }>({ ref: '', motivo: '', tipo: 'ref' });

  // ── Buscar produtos ──
  const [filtro, setFiltro] = useState<{ busca: string; grupo: string; subgrupo: string; marca: string; participacao: Participacao }>({
    busca: '', grupo: '', subgrupo: '', marca: '', participacao: 'todos',
  });
  const [pagina, setPagina] = useState(1);
  const [resultado, setResultado] = useState<BuscaResp | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [erroBusca, setErroBusca] = useState<string | null>(null);
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [motivoLote, setMotivoLote] = useState('');
  // Famílias MISTAS já vistas na busca (REF reciclada: calça e casaco sob o
  // mesmo número) — a seleção atravessa páginas, o aviso também.
  const [mistas, setMistas] = useState<Map<string, string[]>>(new Map());

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await api<{ campanha: Campanha }>('/admin/promo-config');
      setGravada(comListas(r.campanha));
      setRascunho(comListas(r.campanha));
    } catch (e: any) {
      setErro(msgErro(e));
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  // Grupos, subgrupos e marcas com estoque — opções da escolha e dos filtros.
  useEffect(() => {
    api<Estrutura>('/admin/promo-config/estrutura')
      .then((r) => setEstrutura(r))
      .catch(() => setEstrutura(null));
  }, []);

  const alterado = useMemo(() => {
    if (!gravada || !rascunho) return false;
    return (
      gravada.ativa !== rascunho.ativa ||
      gravada.nome !== rascunho.nome ||
      Number(gravada.pct) !== Number(rascunho.pct) ||
      !mesmaLista(gravada.termos, rascunho.termos) ||
      !mesmaLista(gravada.termosExclusao, rascunho.termosExclusao) ||
      !mesmaLista(gravada.grupos, rascunho.grupos) ||
      !mesmaLista(gravada.subgrupos, rascunho.subgrupos)
    );
  }, [gravada, rascunho]);

  const nomeMudou = !!gravada && !!rascunho && semAcento(gravada.nome).trim() !== semAcento(rascunho.nome).trim();

  /**
   * A prévia roda com o RASCUNHO (termos, nome, %, exclusões e grupos), com uma
   * folga depois da última tecla. Só a resposta da ÚLTIMA chamada vale: digitar
   * rápido dispara várias, e uma lenta chegando depois pintaria a lista de
   * termos velhos.
   */
  const seqPreview = useRef(0);
  const calcular = useCallback(async (c: Campanha) => {
    const seq = ++seqPreview.current;
    setCalculando(true);
    setErroPreview(null);
    try {
      const r = await api<Preview>('/admin/promo-config/preview', {
        method: 'POST',
        body: JSON.stringify({ campanha: corpoRascunho(c) }),
      });
      if (seq === seqPreview.current) setPreview(r);
    } catch (e: any) {
      if (seq === seqPreview.current) setErroPreview(msgErro(e));
    } finally {
      if (seq === seqPreview.current) setCalculando(false);
    }
  }, []);

  const chavePrevia = rascunho
    ? JSON.stringify([rascunho.nome, rascunho.pct, rascunho.termos, rascunho.termosExclusao, rascunho.grupos, rascunho.subgrupos])
    : '';
  useEffect(() => {
    if (!rascunho) return;
    const t = setTimeout(() => void calcular(rascunho), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chavePrevia, calcular]);

  // ── Buscar produtos: mesma regra do rascunho, com os filtros da tela ──
  const seqBusca = useRef(0);
  const buscar = useCallback(async (c: Campanha, f: typeof filtro, pag: number) => {
    const seq = ++seqBusca.current;
    setBuscando(true);
    setErroBusca(null);
    try {
      const r = await api<BuscaResp>('/admin/promo-config/produtos', {
        method: 'POST',
        body: JSON.stringify({
          campanha: corpoRascunho(c),
          filtro: {
            busca: f.busca.trim() || undefined,
            grupo: f.grupo ? Number(f.grupo) : undefined,
            subgrupo: f.subgrupo ? Number(f.subgrupo) : undefined,
            marca: f.marca || undefined,
            participacao: f.participacao,
            pagina: pag,
            porPagina: POR_PAGINA,
          },
        }),
      });
      if (seq === seqBusca.current) {
        setResultado(r);
        setMistas((m) => {
          const novo = new Map(m);
          for (const p of r.produtos) if ((p.tipos || []).length > 1) novo.set(p.chave, p.tipos);
          return novo;
        });
      }
    } catch (e: any) {
      if (seq === seqBusca.current) setErroBusca(msgErro(e));
    } finally {
      if (seq === seqBusca.current) setBuscando(false);
    }
  }, []);

  const chaveBusca = JSON.stringify([filtro, pagina, chavePrevia]);
  useEffect(() => {
    if (aba !== 'buscar' || !rascunho) return;
    const t = setTimeout(() => void buscar(rascunho, filtro, pagina), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba, chaveBusca, buscar]);

  const mudarFiltro = (patch: Partial<typeof filtro>) => {
    setFiltro((f) => ({ ...f, ...patch }));
    setPagina(1);
    setSelecionados(new Set());
  };

  const addNaLista = (campo: 'termos' | 'termosExclusao', t: string) => {
    const termo = t.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!termo || !rascunho) return;
    if (!rascunho[campo].some((x) => mesmoTermo(x, termo))) {
      setRascunho({ ...rascunho, [campo]: [...rascunho[campo], termo] });
    }
    if (campo === 'termos') setNovoTermo('');
    else setNovaExclusao('');
  };

  const addEstrutura = (campo: 'grupos' | 'subgrupos', codigo: string) => {
    const n = Number(codigo);
    if (!rascunho || !codigo || !Number.isInteger(n)) return;
    if (!rascunho[campo].includes(n)) {
      setRascunho({ ...rascunho, [campo]: [...rascunho[campo], n].sort((a, b) => a - b) });
    }
    if (campo === 'grupos') setGrupoEscolhido('');
    setSubgrupoEscolhido('');
  };

  const salvar = async () => {
    if (!rascunho) return;
    setSalvando(true);
    setErro(null);
    try {
      const r = await api<{ campanha: Campanha }>('/admin/promo-config', {
        method: 'POST',
        body: JSON.stringify({ campanha: { ...rascunho, pct: Number(rascunho.pct) } }),
      });
      setGravada(comListas(r.campanha));
      setRascunho(comListas(r.campanha));
      setAviso(`Salvo — vale agora no caixa das lojas e no site (a vitrine atualiza em até 2 minutos).`);
      setTimeout(() => setAviso(null), 6000);
      void calcular(comListas(r.campanha));
    } catch (e: any) {
      setErro(msgErro(e));
    } finally {
      setSalvando(false);
    }
  };

  const recalcularTudo = async () => {
    if (!rascunho) return;
    await calcular(rascunho);
    if (aba === 'buscar') await buscar(rascunho, filtro, pagina);
  };

  const travadoPeloNome = () => {
    if (!nomeMudou) return false;
    setErro('Salve o nome da campanha antes de mexer nas peças tiradas ou incluídas.');
    return true;
  };

  const tirar = async (f: Familia, motivo: string) => {
    if (travadoPeloNome()) return;
    setAcaoEm(f.chave);
    setErro(null);
    try {
      await api('/admin/promo-config/excecoes', {
        method: 'POST',
        body: JSON.stringify({ ref: f.refs[0] || undefined, codigo: f.refs[0] ? undefined : f.chave.replace(/^#/, ''), decisao: 'fora', motivo }),
      });
      setTirando(null);
      await recalcularTudo();
    } catch (e: any) {
      setErro(msgErro(e));
    } finally {
      setAcaoEm(null);
    }
  };

  const removerExcecao = async (chave: string) => {
    if (travadoPeloNome()) return;
    setAcaoEm(chave);
    setErro(null);
    try {
      await api('/admin/promo-config/excecoes/remover', { method: 'POST', body: JSON.stringify({ chave }) });
      await recalcularTudo();
    } catch (e: any) {
      setErro(msgErro(e));
    } finally {
      setAcaoEm(null);
    }
  };

  const incluirNaMao = async () => {
    if (travadoPeloNome()) return;
    const termo = incluir.ref.trim();
    if (!termo) return;
    setAcaoEm('__incluir__');
    setErro(null);
    try {
      // REF ou código é ESCOLHA de quem digita, nunca adivinhação: "10115" é
      // código de uma calça e REF de umas meias ao mesmo tempo.
      await api('/admin/promo-config/excecoes', {
        method: 'POST',
        body: JSON.stringify({
          ...(incluir.tipo === 'codigo' ? { codigo: termo } : { ref: termo }),
          decisao: 'dentro',
          motivo: incluir.motivo.trim() || undefined,
        }),
      });
      setIncluir({ ref: '', motivo: '', tipo: incluir.tipo });
      setAba('incluidas');
      await recalcularTudo();
    } catch (e: any) {
      setErro(msgErro(e));
    } finally {
      setAcaoEm(null);
    }
  };

  /** A seleção da busca de uma vez: incluir, tirar ou devolver à regra. */
  const aplicarLote = async (decisao: 'dentro' | 'fora' | 'remover') => {
    if (travadoPeloNome() || !selecionados.size) return;
    setAcaoEm('__lote__');
    setErro(null);
    try {
      const r = await api<{ alteradas: number; ignoradas: string[] }>('/admin/promo-config/excecoes/lote', {
        method: 'POST',
        body: JSON.stringify({ chaves: [...selecionados], decisao, motivo: motivoLote.trim() || undefined }),
      });
      const verbo = decisao === 'dentro' ? 'incluídas na' : decisao === 'fora' ? 'tiradas da' : 'devolvidas à regra da';
      setAviso(
        `${fmt(r.alteradas)} ${r.alteradas === 1 ? 'peça' : 'peças'} ${verbo} campanha` +
          (r.ignoradas?.length ? ` · ${fmt(r.ignoradas.length)} sem estoque ficaram de fora` : '') +
          ' — vale no caixa e no site.',
      );
      setTimeout(() => setAviso(null), 6000);
      setSelecionados(new Set());
      setMotivoLote('');
      await recalcularTudo();
    } catch (e: any) {
      setErro(msgErro(e));
    } finally {
      setAcaoEm(null);
    }
  };

  const familiaPorChave = useMemo(
    () => new Map((preview?.familias || []).map((f) => [f.chave, f])),
    [preview],
  );

  const linhas = useMemo(() => {
    if (!preview || aba === 'buscar') return [] as Array<{ chave: string; familia: Familia | null; excecao: Excecao | null }>;
    let base: Array<{ chave: string; familia: Familia | null; excecao: Excecao | null }>;
    if (aba === 'entram') {
      base = preview.familias
        .filter((f) => f.situacao === 'entra' || f.situacao === 'parcial')
        .map((f) => ({ chave: f.chave, familia: f, excecao: null }));
    } else {
      const decisao = aba === 'tiradas' ? 'fora' : 'dentro';
      base = preview.excecoes
        .filter((e) => e.decisao === decisao)
        .map((e) => ({ chave: e.chave, familia: familiaPorChave.get(e.chave) ?? null, excecao: e }));
    }
    const q = semAcento(busca.trim());
    if (!q) return base;
    const palavras = q.split(/\s+/);
    return base.filter((l) => {
      const texto = semAcento(
        [l.chave, ...(l.familia?.refs || []), l.familia?.descricao, l.familia?.grupo, l.excecao?.descricao, l.excecao?.refExemplo]
          .filter(Boolean)
          .join(' '),
      );
      return palavras.every((p) => texto.includes(p));
    });
  }, [preview, aba, busca, familiaPorChave]);

  const contagem = {
    entram: preview ? preview.familias.filter((f) => f.situacao === 'entra' || f.situacao === 'parcial').length : 0,
    tiradas: preview ? preview.excecoes.filter((e) => e.decisao === 'fora').length : 0,
    incluidas: preview ? preview.excecoes.filter((e) => e.decisao === 'dentro').length : 0,
  };

  const nomeGrupo = useMemo(() => new Map((estrutura?.grupos || []).map((g) => [g.codigo, g])), [estrutura]);
  const nomeSubgrupo = useMemo(() => new Map((estrutura?.subgrupos || []).map((s) => [s.codigo, s])), [estrutura]);
  const subgruposDoGrupo = (grupo: string) =>
    (estrutura?.subgrupos || []).filter((s) => !grupo || String(s.grupo) === grupo);
  const pctComGrupo = estrutura?.pecasTotal
    ? Math.round(((estrutura.pecasTotal - estrutura.pecasSemGrupo) / estrutura.pecasTotal) * 100)
    : null;

  const paginaProdutos = resultado?.produtos || [];
  const todosDaPaginaMarcados = paginaProdutos.length > 0 && paginaProdutos.every((p) => selecionados.has(p.chave));
  const totalPaginas = resultado ? Math.max(1, Math.ceil(resultado.total / (resultado.porPagina || POR_PAGINA))) : 1;

  const chipLista = (
    campo: 'termos' | 'termosExclusao',
    cor: 'sky' | 'rose',
  ) =>
    rascunho![campo].map((t) => (
      <span
        key={t}
        className={`inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-sm font-semibold ${
          cor === 'sky' ? 'bg-sky-100 text-sky-900' : 'bg-rose-100 text-rose-900'
        }`}
      >
        {t}
        <button
          onClick={() => setRascunho({ ...rascunho!, [campo]: rascunho![campo].filter((x) => x !== t) })}
          className={`p-0.5 rounded-full ${cor === 'sky' ? 'hover:bg-sky-200' : 'hover:bg-rose-200'}`}
          aria-label={`Tirar ${t}`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </span>
    ));

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja" className="p-2 rounded-lg hover:bg-slate-100" aria-label="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-sky-100 flex items-center justify-center">
            <Snowflake className="w-5 h-5 text-sky-700" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-slate-800">Promoções</h1>
            <p className="text-xs text-slate-500">
              Campanha por termo — vale no caixa das lojas e no site, com o mesmo preço
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-4 space-y-4">
        {erro && (
          <div className="bg-red-50 border-2 border-red-300 rounded-xl p-3 flex items-start gap-2 text-sm">
            <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
            <div className="flex-1 text-red-800">{erro}</div>
            <button onClick={() => setErro(null)} className="p-1 text-red-500 hover:text-red-700" aria-label="Fechar">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {aviso && (
          <div className="bg-emerald-50 border-2 border-emerald-400 rounded-xl p-3 flex items-center gap-2 text-sm">
            <Check className="w-5 h-5 text-emerald-700 shrink-0" />
            <span className="font-semibold text-emerald-800">{aviso}</span>
          </div>
        )}

        {carregando || !rascunho ? (
          <div className="bg-white rounded-xl p-8 text-center text-slate-400">
            {carregando ? 'Carregando…' : 'Não consegui carregar a campanha.'}
            {!carregando && (
              <button onClick={() => void carregar()} className="ml-2 underline">Tentar de novo</button>
            )}
          </div>
        ) : (
          <>
            {/* ── A CAMPANHA ─────────────────────────────────────────── */}
            <section className="bg-white rounded-2xl border-2 border-sky-200 overflow-hidden">
              <div className="bg-sky-50 px-4 py-3 border-b border-sky-200 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rascunho.ativa}
                    onChange={(e) => setRascunho({ ...rascunho, ativa: e.target.checked })}
                    className="w-5 h-5 accent-sky-700"
                  />
                  <span className={`font-bold ${rascunho.ativa ? 'text-sky-800' : 'text-slate-500'}`}>
                    {rascunho.ativa ? 'Ligada' : 'Desligada'}
                  </span>
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">Nome</span>
                  <input
                    value={rascunho.nome}
                    maxLength={30}
                    onChange={(e) => setRascunho({ ...rascunho, nome: e.target.value })}
                    className="w-40 px-2 py-1.5 rounded-lg border border-slate-300 font-semibold text-slate-800"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">Desconto</span>
                  <input
                    type="number"
                    min={1}
                    max={90}
                    value={rascunho.pct}
                    onChange={(e) => setRascunho({ ...rascunho, pct: e.target.value === '' ? ('' as any) : Number(e.target.value) })}
                    className="w-20 px-2 py-1.5 rounded-lg border border-slate-300 font-bold text-slate-800 text-right"
                  />
                  <Percent className="w-4 h-4 text-slate-500" />
                </div>
                <div className="text-xs text-slate-500 ml-auto">
                  {gravada?.atualizadaEm
                    ? `Última alteração ${quando(gravada.atualizadaEm)}${gravada.atualizadaPor ? ` · ${gravada.atualizadaPor}` : ''}`
                    : 'Valendo o padrão (ninguém alterou ainda)'}
                </div>
              </div>

              <div className="p-4 space-y-4">
                <p className="text-sm text-slate-600">
                  {rascunho.ativa ? (
                    <>
                      No PDV a vendedora escolhe a campanha <b>{rascunho.nome} {rascunho.pct}%</b> na venda (onde era
                      o &quot;Liquida antigos&quot;), e em cada item tira ou põe na promoção com um clique — só naquela
                      venda. No site o desconto é automático.
                    </>
                  ) : (
                    <>Desligada: nenhuma peça tem desconto, nem no caixa nem no site.</>
                  )}
                </p>

                {/* TERMOS */}
                <div>
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                    Palavras que incluem ({rascunho.termos.length})
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {chipLista('termos', 'sky')}
                    {!rascunho.termos.length && (
                      <span className="text-sm text-amber-700">
                        Sem palavra nenhuma: só entra grupo/subgrupo escolhido e o que for incluído na mão.
                      </span>
                    )}
                  </div>
                  <form
                    onSubmit={(e) => { e.preventDefault(); addNaLista('termos', novoTermo); }}
                    className="mt-2 flex gap-2 max-w-md"
                  >
                    <input
                      value={novoTermo}
                      onChange={(e) => setNovoTermo(e.target.value)}
                      placeholder="Nova palavra (ex.: SOBRETUDO, CARDIGAN, TRIC*)"
                      className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-slate-300 text-sm"
                    />
                    <button
                      type="submit"
                      className="px-3 py-2 rounded-lg bg-sky-700 text-white text-sm font-bold flex items-center gap-1 hover:bg-sky-800"
                    >
                      <Plus className="w-4 h-4" /> Adicionar
                    </button>
                  </form>
                  <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">
                    Entra a peça que tiver <b>todas as palavras</b> de um termo na descrição, no grupo ou na REF — sem
                    acento, em qualquer ordem (&quot;CALÇA DE MOLETOM&quot; pega &quot;CALCA JOGGER EM MOLETOM&quot;; o
                    DE, DA, COM… não contam). Plural conta igual (CASACOS = CASACO). Com <b>*</b> no fim pega o começo
                    da palavra (TRIC* = TRICÔ e TRICOT).
                  </p>
                </div>

                {/* EXCLUSÕES */}
                <div>
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                    <Ban className="w-3.5 h-3.5" /> Palavras que excluem ({rascunho.termosExclusao.length})
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {chipLista('termosExclusao', 'rose')}
                    {!rascunho.termosExclusao.length && (
                      <span className="text-sm text-slate-400">Nenhuma — tudo que a regra pegar entra.</span>
                    )}
                  </div>
                  <form
                    onSubmit={(e) => { e.preventDefault(); addNaLista('termosExclusao', novaExclusao); }}
                    className="mt-2 flex gap-2 max-w-md"
                  >
                    <input
                      value={novaExclusao}
                      onChange={(e) => setNovaExclusao(e.target.value)}
                      placeholder="Palavra que tira (ex.: BERMUDA, 22 DE ABRIL)"
                      className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-slate-300 text-sm"
                    />
                    <button
                      type="submit"
                      className="px-3 py-2 rounded-lg bg-rose-700 text-white text-sm font-bold flex items-center gap-1 hover:bg-rose-800"
                    >
                      <Plus className="w-4 h-4" /> Adicionar
                    </button>
                  </form>
                  <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">
                    Peça com uma destas palavras <b>não entra pela regra</b>, mesmo que um termo ou grupo a pegue — e a
                    loja não consegue pôr na venda. Só a inclusão na mão da matriz passa por cima.
                  </p>
                </div>

                {/* GRUPOS / SUBGRUPOS */}
                <div>
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                    Grupos e subgrupos do cadastro ({rascunho.grupos.length + rascunho.subgrupos.length})
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {rascunho.grupos.map((g) => (
                      <span key={`g${g}`} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-indigo-100 text-indigo-900 text-sm font-semibold">
                        Grupo {nomeGrupo.get(g)?.nome || `#${g}`}
                        {nomeGrupo.get(g) && <span className="text-xs font-normal text-indigo-700">· {fmt(nomeGrupo.get(g)!.pecas)} pç</span>}
                        <button
                          onClick={() => setRascunho({ ...rascunho, grupos: rascunho.grupos.filter((x) => x !== g) })}
                          className="p-0.5 rounded-full hover:bg-indigo-200"
                          aria-label="Tirar o grupo"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    ))}
                    {rascunho.subgrupos.map((s) => {
                      const info = nomeSubgrupo.get(s);
                      return (
                        <span key={`s${s}`} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-violet-100 text-violet-900 text-sm font-semibold">
                          {info ? `${info.nome}` : `Subgrupo #${s}`}
                          {info?.grupoNome && <span className="text-xs font-normal text-violet-700">({info.grupoNome}) · {fmt(info.pecas)} pç</span>}
                          <button
                            onClick={() => setRascunho({ ...rascunho, subgrupos: rascunho.subgrupos.filter((x) => x !== s) })}
                            className="p-0.5 rounded-full hover:bg-violet-200"
                            aria-label="Tirar o subgrupo"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      );
                    })}
                    {!rascunho.grupos.length && !rascunho.subgrupos.length && (
                      <span className="text-sm text-slate-400">Nenhum — só as palavras decidem.</span>
                    )}
                  </div>
                  {estrutura ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <select
                        value={grupoEscolhido}
                        onChange={(e) => { setGrupoEscolhido(e.target.value); setSubgrupoEscolhido(''); }}
                        className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white max-w-[260px]"
                        aria-label="Grupo"
                      >
                        <option value="">Grupo…</option>
                        {estrutura.grupos.map((g) => (
                          <option key={g.codigo} value={g.codigo}>{g.nome} · {fmt(g.pecas)} pç</option>
                        ))}
                      </select>
                      <button
                        onClick={() => addEstrutura('grupos', grupoEscolhido)}
                        disabled={!grupoEscolhido}
                        className="px-3 py-2 rounded-lg border border-indigo-300 text-indigo-800 text-sm font-bold hover:bg-indigo-50 disabled:opacity-40"
                      >
                        Pôr o grupo inteiro
                      </button>
                      <select
                        value={subgrupoEscolhido}
                        onChange={(e) => setSubgrupoEscolhido(e.target.value)}
                        className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white max-w-[300px]"
                        aria-label="Subgrupo"
                      >
                        <option value="">Subgrupo{grupoEscolhido ? ' deste grupo' : ''}…</option>
                        {subgruposDoGrupo(grupoEscolhido).map((s) => (
                          <option key={s.codigo} value={s.codigo}>
                            {s.nome}{s.grupoNome && !grupoEscolhido ? ` (${s.grupoNome})` : ''} · {fmt(s.pecas)} pç
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => addEstrutura('subgrupos', subgrupoEscolhido)}
                        disabled={!subgrupoEscolhido}
                        className="px-3 py-2 rounded-lg border border-violet-300 text-violet-800 text-sm font-bold hover:bg-violet-50 disabled:opacity-40"
                      >
                        Pôr o subgrupo
                      </button>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-slate-400">Carregando grupos do cadastro…</p>
                  )}
                  <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">
                    Soma com as palavras: entra quem casa com um termo <b>ou</b> está num grupo/subgrupo escolhido.
                    {pctComGrupo != null && (
                      <> Só <b>{pctComGrupo}%</b> das peças em estoque têm grupo no cadastro (quase tudo que foi
                      cadastrado de 2025 pra cá) — por isso as palavras continuam mandando.</>
                    )}
                  </p>
                </div>

                {!!preview?.sugestoes.length && (
                  <div>
                    <div className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                      Palavras de {rascunho.nome.toLowerCase()} que ainda não entram
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {preview.sugestoes.map((s) => (
                        <button
                          key={s.termo}
                          onClick={() => addNaLista('termos', s.termo)}
                          title={`Exemplos: ${s.exemplos.join(' · ')}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-dashed border-slate-300 text-sm text-slate-700 hover:border-sky-500 hover:bg-sky-50"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <b>{s.termo}</b>
                          <span className="text-xs text-slate-500">
                            {fmt(s.familias)} {s.familias === 1 ? 'modelo' : 'modelos'} · {fmt(s.estoque)} pç
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {nomeMudou && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Trocar o nome começa uma campanha nova: as peças tiradas ou incluídas na mão em
                    &quot;{gravada?.nome}&quot; não valem pra &quot;{rascunho.nome}&quot; (e voltam se o nome voltar).
                    Tirar, devolver e incluir peça ficam travados até salvar o nome — senão mexeriam na
                    campanha que está valendo, e não na que aparece aqui.
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    onClick={() => void salvar()}
                    disabled={!alterado || salvando}
                    className="px-4 py-2.5 rounded-xl bg-sky-700 text-white font-black flex items-center gap-2 hover:bg-sky-800 disabled:opacity-40"
                  >
                    {salvando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Salvar campanha
                  </button>
                  <button
                    onClick={() => gravada && setRascunho(gravada)}
                    disabled={!alterado || salvando}
                    className="px-4 py-2.5 rounded-xl bg-slate-200 text-slate-700 font-bold flex items-center gap-2 hover:bg-slate-300 disabled:opacity-40"
                  >
                    <Undo2 className="w-4 h-4" /> Descartar
                  </button>
                  {alterado && (
                    <span className="text-xs font-semibold text-amber-700">
                      Alterações não salvas — as listas abaixo já mostram como ficaria.
                    </span>
                  )}
                </div>
              </div>
            </section>

            {/* ── O QUE ENTRA / BUSCAR ───────────────────────────────── */}
            <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center gap-3">
                <div className="font-bold text-slate-800">Peças (com estoque na rede)</div>
                {(calculando || buscando) && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                <button
                  onClick={() => void recalcularTudo()}
                  className="ml-auto text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1"
                >
                  <RefreshCcw className="w-3.5 h-3.5" /> Recalcular
                </button>
              </div>

              {erroPreview && (
                <div className="m-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
                  {erroPreview}
                </div>
              )}

              {preview && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-4">
                  <div className="rounded-xl bg-sky-50 px-3 py-2">
                    <div className="text-xs text-slate-500">Modelos na campanha</div>
                    <div className="text-2xl font-black text-sky-900">{fmt(preview.totais.familias)}</div>
                  </div>
                  <div className="rounded-xl bg-sky-50 px-3 py-2">
                    <div className="text-xs text-slate-500">Peças em estoque</div>
                    <div className="text-2xl font-black text-sky-900">{fmt(preview.totais.estoque)}</div>
                  </div>
                  <div className="rounded-xl bg-slate-50 px-3 py-2">
                    <div className="text-xs text-slate-500">Tiradas na mão</div>
                    <div className="text-2xl font-black text-slate-800">{fmt(contagem.tiradas)}</div>
                  </div>
                  <div className="rounded-xl bg-slate-50 px-3 py-2">
                    <div className="text-xs text-slate-500">Incluídas na mão</div>
                    <div className="text-2xl font-black text-slate-800">{fmt(contagem.incluidas)}</div>
                  </div>
                </div>
              )}

              <div className="px-4 pb-1 flex flex-wrap items-center gap-2">
                {([
                  ['entram', `Entram pela regra (${fmt(contagem.entram)})`],
                  ['tiradas', `Tiradas na mão (${fmt(contagem.tiradas)})`],
                  ['incluidas', `Incluídas na mão (${fmt(contagem.incluidas)})`],
                  ['buscar', 'Buscar produtos'],
                ] as Array<[Aba, string]>).map(([k, rot]) => (
                  <button
                    key={k}
                    onClick={() => { setAba(k); setLimite(100); }}
                    className={`px-3 py-1.5 rounded-lg text-sm font-bold border flex items-center gap-1 ${
                      aba === k ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                    }`}
                  >
                    {k === 'buscar' && <Search className="w-3.5 h-3.5" />}
                    {rot}
                  </button>
                ))}
                {aba !== 'buscar' && (
                  <div className="relative ml-auto w-full sm:w-72">
                    <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      value={busca}
                      onChange={(e) => { setBusca(e.target.value); setLimite(100); }}
                      placeholder="Filtrar por REF ou descrição"
                      className="w-full pl-8 pr-3 py-2 rounded-lg border border-slate-300 text-sm"
                    />
                  </div>
                )}
              </div>

              {aba === 'buscar' ? (
                <div className="mt-2">
                  {/* FILTROS — só campos que existem no cadastro */}
                  <div className="px-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                    <div className="relative lg:col-span-2">
                      <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        value={filtro.busca}
                        onChange={(e) => mudarFiltro({ busca: e.target.value })}
                        placeholder="Buscar: REF, código ou palavras da descrição"
                        className="w-full pl-8 pr-3 py-2 rounded-lg border border-slate-300 text-sm"
                      />
                    </div>
                    <select
                      value={filtro.grupo}
                      onChange={(e) => mudarFiltro({ grupo: e.target.value, subgrupo: '' })}
                      className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                      aria-label="Grupo"
                    >
                      <option value="">Grupo: todos</option>
                      {(estrutura?.grupos || []).map((g) => (
                        <option key={g.codigo} value={g.codigo}>{g.nome} · {fmt(g.pecas)} pç</option>
                      ))}
                    </select>
                    <select
                      value={filtro.subgrupo}
                      onChange={(e) => mudarFiltro({ subgrupo: e.target.value })}
                      className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                      aria-label="Subgrupo"
                    >
                      <option value="">Subgrupo: todos</option>
                      {subgruposDoGrupo(filtro.grupo).map((s) => (
                        <option key={s.codigo} value={s.codigo}>
                          {s.nome}{s.grupoNome && !filtro.grupo ? ` (${s.grupoNome})` : ''} · {fmt(s.pecas)} pç
                        </option>
                      ))}
                    </select>
                    <select
                      value={filtro.marca}
                      onChange={(e) => mudarFiltro({ marca: e.target.value })}
                      className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                      aria-label="Marca"
                    >
                      <option value="">Marca: todas</option>
                      {(estrutura?.marcas || []).slice(0, 150).map((m) => (
                        <option key={m.nome} value={m.nome}>{m.nome} · {fmt(m.pecas)} pç</option>
                      ))}
                    </select>
                    <div className="flex rounded-lg border border-slate-300 overflow-hidden text-sm lg:col-span-2">
                      {([
                        ['todos', 'Todos'],
                        ['dentro', `Na promoção${resultado ? ` (${fmt(resultado.totais.dentro)})` : ''}`],
                        ['fora', `Fora da promoção${resultado ? ` (${fmt(resultado.totais.fora)})` : ''}`],
                      ] as Array<[Participacao, string]>).map(([k, rot]) => (
                        <button
                          key={k}
                          onClick={() => mudarFiltro({ participacao: k })}
                          className={`flex-1 px-2 py-2 font-semibold ${
                            filtro.participacao === k ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {rot}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* AÇÃO EM MASSA */}
                  {selecionados.size > 0 && (
                    <div className="mx-4 mt-3 rounded-xl border-2 border-slate-800 bg-slate-50 px-3 py-2 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-slate-800">
                        {fmt(selecionados.size)} {selecionados.size === 1 ? 'modelo selecionado' : 'modelos selecionados'}
                      </span>
                      <input
                        value={motivoLote}
                        onChange={(e) => setMotivoLote(e.target.value)}
                        placeholder="Motivo (opcional)"
                        maxLength={300}
                        className="flex-1 min-w-[160px] px-2 py-1.5 rounded-lg border border-slate-300 text-sm"
                      />
                      <button
                        onClick={() => void aplicarLote('dentro')}
                        disabled={acaoEm === '__lote__' || nomeMudou}
                        className="px-3 py-1.5 rounded-lg bg-sky-700 text-white text-sm font-bold hover:bg-sky-800 disabled:opacity-40"
                      >
                        Incluir na campanha
                      </button>
                      <button
                        onClick={() => void aplicarLote('fora')}
                        disabled={acaoEm === '__lote__' || nomeMudou}
                        className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 disabled:opacity-40"
                      >
                        Tirar da campanha
                      </button>
                      <button
                        onClick={() => void aplicarLote('remover')}
                        disabled={acaoEm === '__lote__' || nomeMudou}
                        title="Apaga a inclusão/tirada na mão — a peça volta a seguir as palavras e os grupos"
                        className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-bold hover:bg-slate-100 disabled:opacity-40"
                      >
                        Devolver à regra
                      </button>
                      <button
                        onClick={() => setSelecionados(new Set())}
                        className="p-1.5 text-slate-500 hover:text-slate-800"
                        aria-label="Limpar seleção"
                      >
                        <X className="w-4 h-4" />
                      </button>
                      {(() => {
                        const n = [...selecionados].filter((c) => mistas.has(c)).length;
                        return n > 0 ? (
                          <p className="basis-full text-xs font-semibold text-amber-800">
                            ⚠️ {fmt(n)} {n === 1 ? 'selecionada tem' : 'selecionadas têm'} peças DIFERENTES na mesma REF
                            (o ERP reaproveitou o número) — incluir ou tirar vale pra todas elas.
                          </p>
                        ) : null;
                      })()}
                      <p className="basis-full text-[11px] text-slate-500">
                        Vale pro modelo em todas as cores, no caixa das lojas e no site. Tirar na mão ganha de tudo —
                        nem a loja consegue pôr a peça na venda.
                      </p>
                    </div>
                  )}

                  {erroBusca && (
                    <div className="m-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">{erroBusca}</div>
                  )}

                  <div className="overflow-x-auto mt-3">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                        <tr>
                          <th className="px-3 py-2 text-left w-8">
                            <input
                              type="checkbox"
                              checked={todosDaPaginaMarcados}
                              onChange={(e) => {
                                const s = new Set(selecionados);
                                for (const p of paginaProdutos) {
                                  if (e.target.checked) s.add(p.chave);
                                  else s.delete(p.chave);
                                }
                                setSelecionados(s);
                              }}
                              className="w-4 h-4 accent-slate-800"
                              aria-label="Selecionar a página"
                            />
                          </th>
                          <th className="px-3 py-2 text-left">REF</th>
                          <th className="px-3 py-2 text-left">Peça</th>
                          <th className="px-3 py-2 text-left">Situação</th>
                          <th className="px-3 py-2 text-right">Preço</th>
                          <th className="px-3 py-2 text-right">Peças</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {paginaProdutos.map((p) => {
                          const sit = SITUACAO[p.situacao];
                          const dentro = p.codigosNaCampanha > 0;
                          return (
                            <tr key={p.chave} className={`align-top hover:bg-slate-50 ${selecionados.has(p.chave) ? 'bg-sky-50/60' : ''}`}>
                              <td className="px-3 py-2">
                                <input
                                  type="checkbox"
                                  checked={selecionados.has(p.chave)}
                                  onChange={(e) => {
                                    const s = new Set(selecionados);
                                    if (e.target.checked) s.add(p.chave);
                                    else s.delete(p.chave);
                                    setSelecionados(s);
                                  }}
                                  className="w-4 h-4 accent-slate-800"
                                  aria-label={`Selecionar ${p.descricao}`}
                                />
                              </td>
                              <td className="px-3 py-2 font-mono text-xs text-slate-700 whitespace-nowrap">
                                {p.refs.length ? p.refs.slice(0, 3).join(', ') : p.chave}
                                {p.refs.length > 3 && <span className="text-slate-400"> +{p.refs.length - 3}</span>}
                              </td>
                              <td className="px-3 py-2 min-w-[240px]">
                                <div className="text-slate-800">{p.descricao || '—'}</div>
                                <div className="text-xs text-slate-400">
                                  {[p.grupo, p.subgrupo, p.marca].filter(Boolean).join(' · ') || 'sem grupo no cadastro'}
                                </div>
                                {(p.tipos || []).length > 1 && (
                                  <div
                                    className="mt-0.5 text-xs font-semibold text-amber-700"
                                    title="O ERP reaproveitou a REF pra peças diferentes. A regra decide cada código pela descrição dele; incluir ou tirar na mão vale pra todos."
                                  >
                                    ⚠️ REF com peças diferentes: {p.tipos.join(' · ')}
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2 text-xs">
                                <span className={`inline-block px-1.5 py-0.5 rounded font-bold ${sit.classe}`}>{sit.rotulo}</span>
                                {p.situacao === 'parcial' && (
                                  <span className="ml-1 text-amber-700">{p.codigosNaCampanha} de {p.codigos} códigos</span>
                                )}
                                {!!p.origens.length && (
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    {p.origens.map((o) => (
                                      <span key={o} className="px-1.5 py-0.5 rounded bg-sky-50 text-sky-800">{o}</span>
                                    ))}
                                  </div>
                                )}
                                {!!p.exclusoes.length && !dentro && (
                                  <div className="mt-1 text-rose-700">tem {p.exclusoes.map((x) => `"${x}"`).join(', ')}</div>
                                )}
                                {p.excecao && (
                                  <div className="mt-1 text-slate-500">
                                    {p.excecao.origem === 'pdv' ? `Loja ${p.excecao.storeCode || '?'}` : 'Matriz'}
                                    {p.excecao.usuario ? ` · ${p.excecao.usuario}` : ''} · {quando(p.excecao.em)}
                                    {p.excecao.motivo && <span className="italic"> — “{p.excecao.motivo}”</span>}
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right whitespace-nowrap">
                                {dentro ? (
                                  <span>
                                    <span className="font-mono text-xs text-slate-400 line-through mr-1">{brl(p.precoMin)}</span>
                                    <span className="font-mono font-bold text-emerald-700">{brl(p.precoPromoMin)}</span>
                                  </span>
                                ) : (
                                  <span className="font-mono text-slate-800">{brl(p.precoMin)}</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-slate-700">{fmt(p.estoque)}</td>
                            </tr>
                          );
                        })}
                        {!paginaProdutos.length && (
                          <tr>
                            <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                              {buscando ? 'Buscando…' : 'Nenhuma peça com esses filtros.'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {resultado && resultado.total > 0 && (
                    <div className="p-3 flex items-center justify-center gap-3 text-sm">
                      <button
                        onClick={() => setPagina((p) => Math.max(1, p - 1))}
                        disabled={pagina <= 1 || buscando}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 font-bold text-slate-700 disabled:opacity-40"
                      >
                        Anterior
                      </button>
                      <span className="text-slate-500">
                        Página {fmt(pagina)} de {fmt(totalPaginas)} · {fmt(resultado.total)} modelos
                      </span>
                      <button
                        onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
                        disabled={pagina >= totalPaginas || buscando}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 font-bold text-slate-700 disabled:opacity-40"
                      >
                        Próxima
                      </button>
                    </div>
                  )}
                </div>
              ) : preview ? (
                <>
                  <div className="overflow-x-auto mt-3">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                        <tr>
                          <th className="px-3 py-2 text-left">REF</th>
                          <th className="px-3 py-2 text-left">Peça</th>
                          <th className="px-3 py-2 text-left">{aba === 'entram' ? 'Termo / grupo' : 'Quem · quando · por quê'}</th>
                          <th className="px-3 py-2 text-right">Preço</th>
                          <th className="px-3 py-2 text-right">Peças</th>
                          <th className="px-3 py-2 text-right">Ação</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {linhas.slice(0, limite).map(({ chave, familia: f, excecao: ex }) => (
                          <tr key={chave} className="align-top hover:bg-slate-50">
                            <td className="px-3 py-2 font-mono text-xs text-slate-700 whitespace-nowrap">
                              {f?.refs.length ? f.refs.slice(0, 3).join(', ') : ex?.refExemplo || chave}
                              {f && f.refs.length > 3 && <span className="text-slate-400"> +{f.refs.length - 3}</span>}
                            </td>
                            <td className="px-3 py-2 min-w-[240px]">
                              <div className="text-slate-800">{f?.descricao || ex?.descricao || '—'}</div>
                              {f?.grupo && <div className="text-xs text-slate-400">{f.grupo}</div>}
                              {f?.situacao === 'parcial' && (
                                <div className="text-xs text-amber-700" title="A REF foi reaproveitada pra peças diferentes — só as que casam com a regra levam desconto">
                                  parcial: {f.codigosNaCampanha} de {f.codigos} códigos casam
                                </div>
                              )}
                              {!f && ex && (
                                <div className="text-xs text-slate-400">sem estoque na rede agora</div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs text-slate-600">
                              {aba === 'entram' ? (
                                <span className="inline-flex flex-wrap gap-1">
                                  {(f?.origens ?? f?.termos ?? []).map((t) => (
                                    <span key={t} className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 font-semibold">{t}</span>
                                  ))}
                                </span>
                              ) : ex ? (
                                <div>
                                  <div className="font-semibold text-slate-700">
                                    {ex.origem === 'pdv' ? `Loja ${ex.storeCode || '?'}` : 'Matriz'}
                                    {ex.usuario ? ` · ${ex.usuario}` : ''}
                                  </div>
                                  <div className="text-slate-400">{quando(ex.em)}</div>
                                  {ex.motivo && <div className="italic">“{ex.motivo}”</div>}
                                </div>
                              ) : null}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {f ? (
                                aba === 'tiradas' ? (
                                  <span className="font-mono text-slate-800">{brl(f.precoMin)}</span>
                                ) : (
                                  <span>
                                    <span className="font-mono text-xs text-slate-400 line-through mr-1">{brl(f.precoMin)}</span>
                                    <span className="font-mono font-bold text-emerald-700">{brl(f.precoPromoMin)}</span>
                                  </span>
                                )
                              ) : '—'}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-slate-700">
                              {f ? fmt(f.estoque) : '—'}
                              {f && f.estoqueFamilia !== f.estoque && (
                                <div className="text-[10px] text-slate-400">de {fmt(f.estoqueFamilia)}</div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {aba === 'entram' && f ? (
                                tirando?.chave === f.chave ? (
                                  <form
                                    onSubmit={(e) => { e.preventDefault(); void tirar(f, tirando.motivo); }}
                                    className="flex items-center gap-1 justify-end"
                                  >
                                    <input
                                      autoFocus
                                      value={tirando.motivo}
                                      onChange={(e) => setTirando({ chave: f.chave, motivo: e.target.value })}
                                      placeholder="Motivo (opcional)"
                                      className="w-40 px-2 py-1 rounded border border-slate-300 text-xs"
                                    />
                                    <button
                                      type="submit"
                                      disabled={acaoEm === f.chave}
                                      className="px-2 py-1 rounded bg-rose-600 text-white text-xs font-bold disabled:opacity-50"
                                    >
                                      {acaoEm === f.chave ? '…' : 'Tirar'}
                                    </button>
                                    <button type="button" onClick={() => setTirando(null)} className="p-1 text-slate-400" aria-label="Cancelar">
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  </form>
                                ) : (
                                  <button
                                    onClick={() => setTirando({ chave: f.chave, motivo: '' })}
                                    disabled={nomeMudou}
                                    title={nomeMudou ? 'Salve o nome da campanha antes' : undefined}
                                    className="px-2.5 py-1 rounded-lg border border-rose-300 text-rose-700 text-xs font-bold hover:bg-rose-50 disabled:opacity-40"
                                  >
                                    Tirar da campanha
                                  </button>
                                )
                              ) : ex ? (
                                <button
                                  onClick={() => void removerExcecao(ex.chave)}
                                  disabled={acaoEm === ex.chave || nomeMudou}
                                  title={nomeMudou ? 'Salve o nome da campanha antes' : undefined}
                                  className="px-2.5 py-1 rounded-lg border border-slate-300 text-slate-700 text-xs font-bold hover:bg-slate-100 disabled:opacity-50"
                                >
                                  {acaoEm === ex.chave ? '…' : ex.decisao === 'fora' ? 'Devolver à campanha' : 'Tirar a inclusão'}
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                        {!linhas.length && (
                          <tr>
                            <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                              {busca ? 'Nada com esse filtro.' : aba === 'entram' ? 'Nenhuma peça com estoque casa com a regra.' : 'Nenhuma peça nesta lista.'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {linhas.length > limite && (
                    <div className="p-3 text-center">
                      <button onClick={() => setLimite(limite + 200)} className="text-sm font-bold text-sky-700 hover:underline">
                        Mostrar mais ({fmt(linhas.length - limite)} restantes)
                      </button>
                    </div>
                  )}
                </>
              ) : null}
            </section>

            {/* ── INCLUIR NA MÃO ─────────────────────────────────────── */}
            <section className="bg-white rounded-2xl border border-slate-200 p-4">
              <div className="font-bold text-slate-800">Pôr uma peça na campanha na mão</div>
              <p className="text-xs text-slate-500 mt-0.5">
                Pra peça de {rascunho.nome.toLowerCase()} que a regra não pegou (até a que tem palavra que exclui). Vale
                pro modelo em todas as cores. Várias de uma vez: aba &quot;Buscar produtos&quot;.
              </p>
              <form
                onSubmit={(e) => { e.preventDefault(); void incluirNaMao(); }}
                className="mt-2 flex flex-wrap gap-2"
              >
                <select
                  value={incluir.tipo}
                  onChange={(e) => setIncluir({ ...incluir, tipo: e.target.value as 'ref' | 'codigo' })}
                  className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                  aria-label="O que está sendo digitado"
                >
                  <option value="ref">REF</option>
                  <option value="codigo">Código ou EAN</option>
                </select>
                <input
                  value={incluir.ref}
                  onChange={(e) => setIncluir({ ...incluir, ref: e.target.value })}
                  placeholder={incluir.tipo === 'ref' ? 'REF da peça' : 'Código ou EAN da etiqueta'}
                  className="w-48 px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
                <input
                  value={incluir.motivo}
                  onChange={(e) => setIncluir({ ...incluir, motivo: e.target.value })}
                  placeholder="Motivo (opcional)"
                  className="flex-1 min-w-[180px] px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
                <button
                  type="submit"
                  disabled={!incluir.ref.trim() || acaoEm === '__incluir__' || nomeMudou}
                  title={nomeMudou ? 'Salve o nome da campanha antes' : undefined}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-bold disabled:opacity-40"
                >
                  {acaoEm === '__incluir__' ? 'Incluindo…' : 'Incluir'}
                </button>
              </form>
            </section>

            {/* ── 4 LEVA 3 ───────────────────────────────────────────── */}
            <section className="bg-white rounded-2xl border border-slate-200 p-4">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-base">🛍️</div>
                <div>
                  <div className="font-bold text-slate-800">Promoção 4 leva 3</div>
                  <div className="text-xs text-slate-500">
                    Levando 4 ou mais peças, a de menor preço sai grátis. Sem ajustes configuráveis.
                  </div>
                </div>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
