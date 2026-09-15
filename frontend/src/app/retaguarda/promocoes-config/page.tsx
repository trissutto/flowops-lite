'use client';

/**
 * /retaguarda/promocoes-config — a CAMPANHA POR TERMO (dono, 15/09/2026).
 *
 * Substituiu a tela da promoção de 50% ("liquida antigos"), que saiu do ar no
 * mesmo dia. Aqui a matriz:
 *   1. liga/desliga a campanha, dá o nome e o % (hoje "Inverno 30%");
 *   2. escreve os TERMOS que separam o que entra (CASACO, CALÇA MOLETOM…) e vê
 *      o efeito ANTES de salvar — a prévia roda com o rascunho;
 *   3. confere cada modelo que entrou e tira o que não é (ou põe na mão o que
 *      nenhum termo pegou);
 *   4. vê o que as LOJAS tiraram pelo PDV ("não é inverno"), com quem, onde e
 *      por quê — e devolve com um clique se foi engano.
 *
 * A régua é uma só (`backend/src/common/promo-por-termo.ts`): o que esta tela
 * mostra é o que o caixa aplica e o que o site cobra.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  AlertCircle, ArrowLeft, Check, Loader2, Percent, Plus, RefreshCcw, Save, Search, Snowflake, Undo2, X,
} from 'lucide-react';

interface Campanha {
  ativa: boolean;
  nome: string;
  pct: number;
  termos: string[];
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

type Aba = 'entram' | 'tiradas' | 'incluidas';

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
const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const mesmoTermo = (a: string, b: string) => semAcento(a).replace(/\s+/g, ' ').trim() === semAcento(b).replace(/\s+/g, ' ').trim();

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

  const [novoTermo, setNovoTermo] = useState('');
  const [aba, setAba] = useState<Aba>('entram');
  const [busca, setBusca] = useState('');
  const [limite, setLimite] = useState(100);
  const [acaoEm, setAcaoEm] = useState<string | null>(null);
  const [tirando, setTirando] = useState<{ chave: string; motivo: string } | null>(null);
  const [incluir, setIncluir] = useState({ ref: '', motivo: '' });

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await api<{ campanha: Campanha }>('/admin/promo-config');
      setGravada(r.campanha);
      setRascunho(r.campanha);
    } catch (e: any) {
      setErro(msgErro(e));
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const alterado = useMemo(() => {
    if (!gravada || !rascunho) return false;
    return (
      gravada.ativa !== rascunho.ativa ||
      gravada.nome !== rascunho.nome ||
      Number(gravada.pct) !== Number(rascunho.pct) ||
      gravada.termos.join('|') !== rascunho.termos.join('|')
    );
  }, [gravada, rascunho]);

  const nomeMudou = !!gravada && !!rascunho && semAcento(gravada.nome).trim() !== semAcento(rascunho.nome).trim();

  /**
   * A prévia roda com o RASCUNHO (termos, nome e %), com uma folga depois da
   * última tecla. Só a resposta da ÚLTIMA chamada vale: digitar rápido dispara
   * várias, e uma lenta chegando depois pintaria a lista de termos velhos.
   */
  const seqPreview = useRef(0);
  const calcular = useCallback(async (c: Campanha) => {
    const seq = ++seqPreview.current;
    setCalculando(true);
    setErroPreview(null);
    try {
      const r = await api<Preview>('/admin/promo-config/preview', {
        method: 'POST',
        body: JSON.stringify({ campanha: { nome: c.nome, pct: Number(c.pct), termos: c.termos } }),
      });
      if (seq === seqPreview.current) setPreview(r);
    } catch (e: any) {
      if (seq === seqPreview.current) setErroPreview(msgErro(e));
    } finally {
      if (seq === seqPreview.current) setCalculando(false);
    }
  }, []);

  const chavePrevia = rascunho ? `${rascunho.nome}|${rascunho.pct}|${rascunho.termos.join('|')}` : '';
  useEffect(() => {
    if (!rascunho) return;
    const t = setTimeout(() => void calcular(rascunho), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chavePrevia, calcular]);

  const addTermo = (t: string) => {
    const termo = t.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!termo || !rascunho) return;
    if (rascunho.termos.some((x) => mesmoTermo(x, termo))) {
      setNovoTermo('');
      return;
    }
    setRascunho({ ...rascunho, termos: [...rascunho.termos, termo] });
    setNovoTermo('');
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
      setGravada(r.campanha);
      setRascunho(r.campanha);
      setAviso(`Salvo — vale agora no caixa das lojas e no site (a vitrine atualiza em até 2 minutos).`);
      setTimeout(() => setAviso(null), 6000);
      void calcular(r.campanha);
    } catch (e: any) {
      setErro(msgErro(e));
    } finally {
      setSalvando(false);
    }
  };

  const tirar = async (f: Familia, motivo: string) => {
    setAcaoEm(f.chave);
    setErro(null);
    try {
      await api('/admin/promo-config/excecoes', {
        method: 'POST',
        body: JSON.stringify({ ref: f.refs[0] || undefined, codigo: f.refs[0] ? undefined : f.chave.replace(/^#/, ''), decisao: 'fora', motivo }),
      });
      setTirando(null);
      if (rascunho) await calcular(rascunho);
    } catch (e: any) {
      setErro(msgErro(e));
    } finally {
      setAcaoEm(null);
    }
  };

  const removerExcecao = async (chave: string) => {
    setAcaoEm(chave);
    setErro(null);
    try {
      await api('/admin/promo-config/excecoes/remover', { method: 'POST', body: JSON.stringify({ chave }) });
      if (rascunho) await calcular(rascunho);
    } catch (e: any) {
      setErro(msgErro(e));
    } finally {
      setAcaoEm(null);
    }
  };

  const incluirNaMao = async () => {
    const termo = incluir.ref.trim();
    if (!termo) return;
    setAcaoEm('__incluir__');
    setErro(null);
    try {
      // Só dígitos e comprido = código de barras/código; o resto é REF.
      const ehCodigo = /^\d{8,14}$/.test(termo);
      await api('/admin/promo-config/excecoes', {
        method: 'POST',
        body: JSON.stringify({
          ...(ehCodigo ? { codigo: termo } : { ref: termo }),
          decisao: 'dentro',
          motivo: incluir.motivo.trim() || undefined,
        }),
      });
      setIncluir({ ref: '', motivo: '' });
      setAba('incluidas');
      if (rascunho) await calcular(rascunho);
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
    if (!preview) return [] as Array<{ chave: string; familia: Familia | null; excecao: Excecao | null }>;
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

              <div className="p-4 space-y-3">
                <p className="text-sm text-slate-600">
                  {rascunho.ativa ? (
                    <>
                      No PDV a vendedora escolhe a campanha <b>{rascunho.nome} {rascunho.pct}%</b> na venda (onde era
                      o &quot;Liquida antigos&quot;). No site o desconto é automático.
                    </>
                  ) : (
                    <>Desligada: nenhuma peça tem desconto, nem no caixa nem no site.</>
                  )}
                </p>

                <div>
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                    Termos ({rascunho.termos.length})
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {rascunho.termos.map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-sky-100 text-sky-900 text-sm font-semibold"
                      >
                        {t}
                        <button
                          onClick={() => setRascunho({ ...rascunho, termos: rascunho.termos.filter((x) => x !== t) })}
                          className="p-0.5 rounded-full hover:bg-sky-200"
                          aria-label={`Tirar o termo ${t}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    ))}
                    {!rascunho.termos.length && (
                      <span className="text-sm text-amber-700">
                        Sem termo nenhum: só entra o que for incluído na mão.
                      </span>
                    )}
                  </div>
                  <form
                    onSubmit={(e) => { e.preventDefault(); addTermo(novoTermo); }}
                    className="mt-2 flex gap-2 max-w-md"
                  >
                    <input
                      value={novoTermo}
                      onChange={(e) => setNovoTermo(e.target.value)}
                      placeholder="Novo termo (ex.: TRICÔ, CALÇA MOLETOM, TRIC*)"
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
                    acento, em qualquer ordem (&quot;CALÇA MOLETOM&quot; pega &quot;CALÇA JOGGER EM MOLETOM&quot;).
                    Plural conta igual (CASACOS = CASACO). Com <b>*</b> no fim pega o começo da palavra (TRIC* = TRICÔ
                    e TRICOT). A exceção vale pra peça em todas as cores.
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
                          onClick={() => addTermo(s.termo)}
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
                      Alterações não salvas — a lista abaixo já mostra como ficaria.
                    </span>
                  )}
                </div>
              </div>
            </section>

            {/* ── O QUE ENTRA ────────────────────────────────────────── */}
            <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center gap-3">
                <div className="font-bold text-slate-800">O que entra (peças com estoque na rede)</div>
                {calculando && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                <button
                  onClick={() => rascunho && void calcular(rascunho)}
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
                <>
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

                  <div className="px-4 flex flex-wrap items-center gap-2">
                    {([
                      ['entram', `Entram por termo (${fmt(contagem.entram)})`],
                      ['tiradas', `Tiradas na mão (${fmt(contagem.tiradas)})`],
                      ['incluidas', `Incluídas na mão (${fmt(contagem.incluidas)})`],
                    ] as Array<[Aba, string]>).map(([k, rot]) => (
                      <button
                        key={k}
                        onClick={() => { setAba(k); setLimite(100); }}
                        className={`px-3 py-1.5 rounded-lg text-sm font-bold border ${
                          aba === k ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                        }`}
                      >
                        {rot}
                      </button>
                    ))}
                    <div className="relative ml-auto w-full sm:w-72">
                      <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        value={busca}
                        onChange={(e) => { setBusca(e.target.value); setLimite(100); }}
                        placeholder="Filtrar por REF ou descrição"
                        className="w-full pl-8 pr-3 py-2 rounded-lg border border-slate-300 text-sm"
                      />
                    </div>
                  </div>

                  <div className="overflow-x-auto mt-3">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                        <tr>
                          <th className="px-3 py-2 text-left">REF</th>
                          <th className="px-3 py-2 text-left">Peça</th>
                          <th className="px-3 py-2 text-left">{aba === 'entram' ? 'Termo' : 'Quem · quando · por quê'}</th>
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
                                <div className="text-xs text-amber-700" title="A REF foi reaproveitada pra peças diferentes — só as que casam com o termo levam desconto">
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
                                  {f?.termos.map((t) => (
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
                                    className="px-2.5 py-1 rounded-lg border border-rose-300 text-rose-700 text-xs font-bold hover:bg-rose-50"
                                  >
                                    Tirar da campanha
                                  </button>
                                )
                              ) : ex ? (
                                <button
                                  onClick={() => void removerExcecao(ex.chave)}
                                  disabled={acaoEm === ex.chave}
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
                              {busca ? 'Nada com esse filtro.' : aba === 'entram' ? 'Nenhuma peça com estoque casa com os termos.' : 'Nenhuma peça nesta lista.'}
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
              )}
            </section>

            {/* ── INCLUIR NA MÃO ─────────────────────────────────────── */}
            <section className="bg-white rounded-2xl border border-slate-200 p-4">
              <div className="font-bold text-slate-800">Pôr uma peça na campanha na mão</div>
              <p className="text-xs text-slate-500 mt-0.5">
                Pra peça de {rascunho.nome.toLowerCase()} que nenhum termo pegou. Vale pro modelo em todas as cores.
              </p>
              <form
                onSubmit={(e) => { e.preventDefault(); void incluirNaMao(); }}
                className="mt-2 flex flex-wrap gap-2"
              >
                <input
                  value={incluir.ref}
                  onChange={(e) => setIncluir({ ...incluir, ref: e.target.value })}
                  placeholder="REF ou código da peça"
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
                  disabled={!incluir.ref.trim() || acaoEm === '__incluir__'}
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
