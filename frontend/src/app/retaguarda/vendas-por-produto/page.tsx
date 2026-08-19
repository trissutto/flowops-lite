'use client';

/**
 * VENDAS POR PRODUTO (REF + COR) — pedido do dono em 18/08/2026.
 *
 * "No outro sistema tínhamos relatório de vendas por produto (referência), por
 * marca, e podíamos escolher data." O que existia aqui era um TOP 20 fixo
 * dentro da Inteligência de Vendas, sem busca, sem marca e — pior — lendo só o
 * caixa do ERP antigo, sem descontar a réplica do PDV (ver o cabeçalho do
 * `VendasProdutoService`, que traz os números medidos).
 *
 * Decisões dele, respondidas antes de eu escrever uma linha:
 *   · linha = REF **+ COR** (a cor é o que ele recompra, não a peça abstrata);
 *   · período = **desde sempre** por padrão, antigo + novo juntos;
 *   · devolução ABATE · marcado FORA · treino FORA · site conta quando PAGO;
 *   · serve pra **comprar de novo** e **avaliar se foi bem** — daí as colunas
 *     de estoque atual, peças/mês e % de devolução, que não existiriam num
 *     relatório de faturamento puro.
 *
 * A busca imita a da tela Consultar do PDV, que é a que eles têm no dedo:
 * palavras em qualquer ordem, pedaço de palavra vale, Enter força, Esc limpa.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  AlertTriangle, ChevronDown, ChevronRight, Download, Loader2, Package, Search, TrendingUp, X,
} from 'lucide-react';
import { ordemTamanho } from '@/lib/ordem-tamanho';

type Item = {
  ref: string;
  cor: string | null;
  nome: string | null;
  marca: string | null;
  pecas: number;
  devolvidas: number;
  devolucaoPct: number;
  valor: number;
  precoMedio: number;
  estoque: number;
  primeiraVenda: string | null;
  ultimaVenda: string | null;
  pecasPorMes: number;
};

type Resposta = {
  total: number;
  limitado: boolean;
  page: number;
  perPage: number;
  totalPages: number;
  resumo: { pecas: number; valor: number; devolvidas: number };
  itens: Item[];
};

type Grade = {
  ref: string;
  cor: string | null;
  tamanhos: Array<{
    tamanho: string;
    pecas: number;
    devolvidas: number;
    estoque: number;
    /** Digitados por ele, valendo pra rede. `null` = ainda sem meta. */
    minimo: number | null;
    ideal: number | null;
    /** `ideal - estoque` — o que entraria na ordem de compra. */
    repor: number;
    abaixoDoMinimo: boolean;
  }>;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (n: number) => Number(n || 0).toLocaleString('pt-BR');
const dia = (d: string | null) => (d ? new Date(d).toLocaleDateString('pt-BR') : '—');

/** Atalhos de período. `null` nos dois = desde sempre, que é o padrão do dono. */
function atalho(qual: 'tudo' | 'hoje' | 'ontem' | '7' | 'mes' | 'ano'): [string, string] {
  const hoje = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (qual === 'tudo') return ['', ''];
  if (qual === 'hoje') return [iso(hoje), iso(hoje)];
  if (qual === 'ontem') {
    const o = new Date(hoje);
    o.setDate(o.getDate() - 1);
    return [iso(o), iso(o)];
  }
  if (qual === '7') {
    const i = new Date(hoje);
    i.setDate(i.getDate() - 6);
    return [iso(i), iso(hoje)];
  }
  if (qual === 'mes') return [iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), iso(hoje)];
  return [iso(new Date(hoje.getFullYear(), 0, 1)), iso(hoje)];
}

export default function VendasPorProdutoPage() {
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [loja, setLoja] = useState('');
  const [marca, setMarca] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAtiva, setBuscaAtiva] = useState('');
  const [ordenar, setOrdenar] = useState<'pecas' | 'valor' | 'ultima'>('pecas');
  const [page, setPage] = useState(1);

  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [lojas, setLojas] = useState<Array<{ code: string; name: string }>>([]);
  const [marcas, setMarcas] = useState<string[]>([]);
  const campo = useRef<HTMLInputElement>(null);
  /** Qual linha está aberta (`REF|COR`) e a grade dela, já carregada. */
  const [aberta, setAberta] = useState<string | null>(null);
  const [grades, setGrades] = useState<Record<string, Grade | 'carregando'>>({});

  /**
   * A grade é carregada SOB DEMANDA, uma peça por vez: são 4 fontes de venda
   * cruzadas com o estoque, e trazer isso pras 50 linhas da página de uma vez
   * seria 50× a consulta mais cara da tela pra mostrar o que ninguém pediu.
   * Uma vez carregada fica em memória — reabrir não vai ao servidor de novo.
   */
  const abrirGrade = useCallback(async (item: Item) => {
    const chave = `${item.ref}|${item.cor ?? ''}`;
    if (aberta === chave) { setAberta(null); return; }
    setAberta(chave);
    if (grades[chave]) return;
    setGrades((g) => ({ ...g, [chave]: 'carregando' }));
    try {
      const q = new URLSearchParams({ ref: item.ref, cor: item.cor ?? '' });
      if (de) q.set('de', de);
      if (ate) q.set('ate', ate);
      if (loja) q.set('loja', loja);
      const r = await api<Grade>(`/intelligence/vendas-produto/grade?${q.toString()}`);
      setGrades((g) => ({ ...g, [chave]: r }));
    } catch {
      // Falhou a grade, a linha de cima continua válida: tira o "carregando"
      // e deixa a cascata dizer que não veio, sem derrubar o relatório.
      setGrades((g) => {
        const copia = { ...g };
        delete copia[chave];
        return copia;
      });
      setAberta(null);
    }
  }, [aberta, grades, de, ate, loja]);

  // Trocar filtro invalida o que estava aberto: a grade é do período/loja que
  // estavam valendo quando ela foi buscada.
  useEffect(() => { setAberta(null); setGrades({}); }, [de, ate, loja, marca, buscaAtiva]);

  useEffect(() => {
    api<Array<{ code: string; name: string }>>('/stores').then(setLojas).catch(() => {});
    api<string[]>('/intelligence/vendas-produto/marcas').then(setMarcas).catch(() => {});
  }, []);

  /**
   * Debounce de 450ms igual ao da Consultar. Enter força na hora (o `onKeyDown`
   * embaixo), porque quem digita REF inteira não quer esperar.
   */
  useEffect(() => {
    const t = setTimeout(() => {
      setBuscaAtiva(busca);
      setPage(1);
    }, 450);
    return () => clearTimeout(t);
  }, [busca]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const q = new URLSearchParams();
      if (de) q.set('de', de);
      if (ate) q.set('ate', ate);
      if (loja) q.set('loja', loja);
      if (marca) q.set('marca', marca);
      if (buscaAtiva.trim()) q.set('busca', buscaAtiva.trim());
      q.set('ordenar', ordenar);
      q.set('page', String(page));
      q.set('perPage', '50');
      setDados(await api<Resposta>(`/intelligence/vendas-produto?${q.toString()}`));
    } catch (e: unknown) {
      setErro((e as Error)?.message?.replace(/^\d+:\s*/, '') || 'Não consegui carregar');
    } finally {
      setCarregando(false);
    }
  }, [de, ate, loja, marca, buscaAtiva, ordenar, page]);

  useEffect(() => { void carregar(); }, [carregar]);

  /**
   * Grava o mínimo/ideal de UM tamanho ao sair do campo.
   *
   * Salva na hora, sem botão: ele digita o número da grade inteira de uma vez,
   * e um "salvar" no fim seria o clique que ele esqueceria depois de sair da
   * linha. A resposta do servidor volta pra grade pra o "repor" e o alerta
   * serem os que o backend calculou — não uma conta paralela do navegador.
   */
  const salvarMeta = useCallback(
    async (chave: string, ref: string, cor: string | null, tamanho: string, minimo: number, ideal: number) => {
      try {
        await api('/intelligence/vendas-produto/meta', {
          method: 'POST',
          body: JSON.stringify({ ref, cor: cor ?? '', tamanho, minimo, ideal }),
        });
        const q = new URLSearchParams({ ref, cor: cor ?? '' });
        if (de) q.set('de', de);
        if (ate) q.set('ate', ate);
        if (loja) q.set('loja', loja);
        const r = await api<Grade>(`/intelligence/vendas-produto/grade?${q.toString()}`);
        setGrades((g) => ({ ...g, [chave]: r }));
      } catch {
        // Deu erro? A grade fica como está e ele vê o número não mudar —
        // melhor que fingir que salvou.
      }
    },
    [de, ate, loja],
  );

  /**
   * O CSV sai do que está NA TELA, não de uma segunda consulta: relatório que
   * exporta números diferentes dos que a pessoa acabou de ver destrói a
   * confiança na ferramenta inteira.
   */
  function baixarCsv() {
    const itens = dados?.itens ?? [];
    if (!itens.length) return;
    const cab = ['REF', 'Cor', 'Produto', 'Marca', 'Peças', 'Devolvidas', '% devolução',
      'Valor', 'Preço médio', 'Estoque hoje', 'Peças/mês', 'Primeira venda', 'Última venda'];
    const linhas = itens.map((i) => [
      i.ref, i.cor ?? '', (i.nome ?? '').replace(/;/g, ','), i.marca ?? '',
      i.pecas, i.devolvidas, String(i.devolucaoPct).replace('.', ','),
      String(i.valor).replace('.', ','), String(i.precoMedio).replace('.', ','),
      i.estoque, String(i.pecasPorMes).replace('.', ','), dia(i.primeiraVenda), dia(i.ultimaVenda),
    ].join(';'));
    const blob = new Blob(['﻿' + [cab.join(';'), ...linhas].join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vendas-por-produto-${de || 'inicio'}-a-${ate || 'hoje'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const periodoLabel = useMemo(() => {
    if (!de && !ate) return 'desde sempre';
    if (de && ate) return `${dia(de)} a ${dia(ate)}`;
    return de ? `de ${dia(de)}` : `até ${dia(ate)}`;
  }, [de, ate]);

  const th = 'px-3 py-2 text-left text-[11px] font-bold uppercase text-slate-500 whitespace-nowrap';
  const td = 'px-3 py-2 text-sm whitespace-nowrap';

  return (
    <div className="max-w-[1400px] mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
          <TrendingUp className="w-5 h-5" /> Vendas por produto
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          Uma linha por <b>REF + cor</b>, somando loja física, site e live — <b>desde sempre</b> se
          você não escolher data. Devolução abate; marcado e treinamento ficam de fora.
        </p>
      </div>

      {/* ── FILTROS ── */}
      <div className="bg-white rounded-lg shadow border p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">De</label>
            <input type="date" value={de} onChange={(e) => { setDe(e.target.value); setPage(1); }}
              className="px-2 py-2 border rounded text-sm" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Até</label>
            <input type="date" value={ate} onChange={(e) => { setAte(e.target.value); setPage(1); }}
              className="px-2 py-2 border rounded text-sm" />
          </div>
          <div className="flex flex-wrap gap-1 pb-1">
            {([['tudo', 'Desde sempre'], ['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7', '7 dias'],
               ['mes', 'Este mês'], ['ano', 'Este ano']] as const).map(([k, rotulo]) => (
              <button key={k} type="button"
                onClick={() => { const [i, f] = atalho(k); setDe(i); setAte(f); setPage(1); }}
                className="px-2.5 py-1.5 rounded-full border text-xs hover:bg-slate-50">
                {rotulo}
              </button>
            ))}
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Loja</label>
            <select value={loja} onChange={(e) => { setLoja(e.target.value); setPage(1); }}
              className="px-2 py-2 border rounded text-sm bg-white min-w-[150px]">
              <option value="">Rede inteira</option>
              {/* Site/live é CANAL, não loja: o pedido do site tem loja que
                  retira, que vende e que envia — fingir uma só daria número
                  que não bate com nada. */}
              <option value="SITE">Site + Live (online)</option>
              {lojas.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Marca</label>
            <select value={marca} onChange={(e) => { setMarca(e.target.value); setPage(1); }}
              className="px-2 py-2 border rounded text-sm bg-white min-w-[150px]">
              <option value="">Todas</option>
              <option value="(sem marca)">(sem marca cadastrada)</option>
              {marcas.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[280px]">
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">
              Buscar <span className="text-slate-400 normal-case font-normal">
                — REF, descrição ou cor. Palavras em qualquer ordem, igual à Consultar do PDV
              </span>
            </label>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={campo}
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { setBuscaAtiva(busca); setPage(1); }
                  if (e.key === 'Escape') { setBusca(''); setBuscaAtiva(''); }
                }}
                placeholder="ex: vlm-222, vestido midi azul, bmm"
                className="w-full pl-8 pr-8 py-2 border rounded text-sm"
              />
              {busca && (
                <button type="button" onClick={() => { setBusca(''); setBuscaAtiva(''); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Ordenar por</label>
            <select value={ordenar} onChange={(e) => { setOrdenar(e.target.value as any); setPage(1); }}
              className="px-2 py-2 border rounded text-sm bg-white">
              <option value="pecas">Peças vendidas</option>
              <option value="valor">Valor vendido</option>
              <option value="ultima">Venda mais recente</option>
            </select>
          </div>
          <button type="button" onClick={baixarCsv} disabled={!dados?.itens.length}
            className="px-3 py-2 border rounded text-sm hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-40">
            <Download className="w-4 h-4" /> CSV desta página
          </button>
        </div>
      </div>

      {/* ── RESUMO ── */}
      {dados && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            ['Peças vendidas', num(dados.resumo.pecas), 'text-slate-800'],
            ['Valor', brl(dados.resumo.valor), 'text-emerald-700'],
            ['Devolvidas', num(dados.resumo.devolvidas), 'text-rose-700'],
            ['Linhas (REF + cor)', num(dados.total), 'text-slate-800'],
          ].map(([rotulo, valor, cor]) => (
            <div key={rotulo} className="bg-white rounded-lg border p-3">
              <p className="text-[10px] font-bold uppercase text-slate-400">{rotulo}</p>
              <p className={`text-xl font-black ${cor}`}>{valor}</p>
            </div>
          ))}
        </div>
      )}

      {erro && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 font-semibold">
          {erro}
        </div>
      )}

      {/* O teto existe pra consulta gigante não derrubar a tela — mas ele é
          DITO, não escondido: relatório que corta calado vira decisão errada. */}
      {dados?.limitado && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Bateu no teto de <b>5.000 linhas</b> e o resto foi cortado. A ordem é por{' '}
            {ordenar === 'valor' ? 'valor' : ordenar === 'ultima' ? 'data' : 'peças'}, então o topo
            está certo — mas <b>o total acima não é o da rede inteira</b>. Estreite por data, loja,
            marca ou busca pra ver um número fechado.
          </span>
        </div>
      )}

      {/* ── TABELA ── */}
      <div className="bg-white rounded-lg shadow border overflow-x-auto">
        {carregando ? (
          <div className="p-12 text-center text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin mx-auto" />
          </div>
        ) : !dados?.itens.length ? (
          <div className="p-10 text-center text-slate-400 text-sm">
            <Package className="w-6 h-6 mx-auto mb-2" />
            Nenhuma venda com esses filtros ({periodoLabel}).
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-slate-50 border-b">
              <tr>
                <th className={`${th} w-8`} />
                <th className={th}>REF · cor</th>
                <th className={th}>Produto</th>
                <th className={th}>Marca</th>
                <th className={`${th} text-right`}>Peças</th>
                <th className={`${th} text-right`}>Devolvidas</th>
                <th className={`${th} text-right`}>Valor</th>
                <th className={`${th} text-right`}>Preço médio</th>
                <th className={`${th} text-right`}>Estoque hoje</th>
                <th className={`${th} text-right`}>Peças/mês</th>
                <th className={th}>Última venda</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {dados.itens.map((i) => {
                const chave = `${i.ref}|${i.cor ?? ''}`;
                const grade = grades[chave];
                return (
                <Fragment key={chave}>
                <tr
                  className="hover:bg-slate-50 cursor-pointer"
                  onClick={() => void abrirGrade(i)}
                  title="Ver a grade: quanto vendeu e quanto tem, por tamanho"
                >
                  <td className="pl-3 text-slate-400">
                    {aberta === chave ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </td>
                  <td className={td}>
                    <span className="font-mono font-bold text-violet-700">{i.ref}</span>
                    {i.cor && <span className="text-slate-500"> · {i.cor}</span>}
                  </td>
                  <td className={`${td} max-w-[280px] truncate text-slate-700`} title={i.nome ?? ''}>
                    {i.nome ?? '—'}
                  </td>
                  <td className={`${td} text-slate-500`}>{i.marca ?? '—'}</td>
                  <td className={`${td} text-right font-bold`}>{num(i.pecas)}</td>
                  <td className={`${td} text-right`}>
                    {i.devolvidas > 0 ? (
                      <span className="text-rose-700">
                        {num(i.devolvidas)}{' '}
                        <span className="text-[10px]">({String(i.devolucaoPct).replace('.', ',')}%)</span>
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className={`${td} text-right`}>{brl(i.valor)}</td>
                  <td className={`${td} text-right text-slate-500`}>{brl(i.precoMedio)}</td>
                  {/* Estoque ZERO com venda boa é o caso que ele quer ver: peça
                      que vende e acabou. Por isso ele grita em vermelho. */}
                  <td className={`${td} text-right font-semibold ${
                    i.estoque <= 0 ? 'text-rose-700' : i.estoque < 10 ? 'text-amber-700' : 'text-slate-700'
                  }`}>
                    {num(i.estoque)}
                  </td>
                  <td className={`${td} text-right text-slate-600`}>
                    {String(i.pecasPorMes).replace('.', ',')}
                  </td>
                  <td className={`${td} text-slate-500`}>{dia(i.ultimaVenda)}</td>
                </tr>

                {aberta === chave && (
                  <tr className="bg-slate-50/70">
                    <td colSpan={11} className="px-6 py-3">
                      {grade === 'carregando' || !grade ? (
                        <span className="text-xs text-slate-400 flex items-center gap-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Montando a grade…
                        </span>
                      ) : (
                        <div className="overflow-x-auto">
                          {/**
                            * VENDIDAS e ESTOQUE na MESMA grade, uma linha embaixo
                            * da outra (pedido do dono): "vendeu 30 e tem 81" não
                            * decide nada; "vendeu 5 no 52 e tem 0 no 52" decide.
                            */}
                          <table className="text-sm">
                            <thead>
                              <tr>
                                <th className="px-2 py-1 text-left text-[10px] font-bold uppercase text-slate-400">
                                  Tamanho
                                </th>
                                {[...grade.tamanhos]
                                  .sort((a, b) => ordemTamanho(a.tamanho) - ordemTamanho(b.tamanho))
                                  .map((t) => (
                                    <th key={t.tamanho} className="px-3 py-1 text-center font-bold text-slate-700 tabular-nums">
                                      {t.tamanho}
                                    </th>
                                  ))}
                              </tr>
                            </thead>
                            <tbody>
                              <tr>
                                <td className="px-2 py-1 text-[11px] font-bold uppercase text-slate-500">Vendidas</td>
                                {[...grade.tamanhos]
                                  .sort((a, b) => ordemTamanho(a.tamanho) - ordemTamanho(b.tamanho))
                                  .map((t) => (
                                    <td key={t.tamanho} className="px-3 py-1 text-center tabular-nums font-semibold text-slate-800">
                                      {t.pecas}
                                      {t.devolvidas > 0 && (
                                        <span className="text-[10px] text-rose-600"> (-{t.devolvidas})</span>
                                      )}
                                    </td>
                                  ))}
                              </tr>
                              <tr>
                                <td className="px-2 py-1 text-[11px] font-bold uppercase text-slate-500">Estoque hoje</td>
                                {[...grade.tamanhos]
                                  .sort((a, b) => ordemTamanho(a.tamanho) - ordemTamanho(b.tamanho))
                                  .map((t) => (
                                    /* Tamanho que VENDEU e zerou é o que ele abriu
                                       a cascata pra achar — por isso grita. */
                                    <td
                                      key={t.tamanho}
                                      className={`px-3 py-1 text-center tabular-nums font-semibold ${
                                        t.estoque <= 0
                                          ? 'text-rose-700 bg-rose-50 rounded'
                                          : t.estoque < 5
                                            ? 'text-amber-700'
                                            : 'text-slate-600'
                                      }`}
                                      title={t.estoque <= 0 && t.pecas > 0 ? 'Vendeu e acabou' : undefined}
                                    >
                                      {t.estoque}
                                    </td>
                                  ))}
                              </tr>
                                {/**
                                * MÍNIMO e IDEAL, digitados (decisão dele,
                                * 18/08): "mínimo 10 no 46, ideal sempre ter 30
                                * no 46 em todas as lojas; quando chegar em 10 o
                                * sistema avisa e põe 20 na ordem de compra".
                                * Por isso são campos, e não conta automática.
                                */}
                              {([['minimo', 'Estoque mínimo'], ['ideal', 'Ideal']] as const).map(
                                ([campoMeta, rotulo]) => (
                                  <tr key={campoMeta}>
                                    <td className="px-2 py-1 text-[11px] font-bold uppercase text-slate-500">
                                      {rotulo}
                                    </td>
                                    {[...grade.tamanhos]
                                      .sort((a, b) => ordemTamanho(a.tamanho) - ordemTamanho(b.tamanho))
                                      .map((t) => (
                                        <td key={t.tamanho} className="px-1 py-1 text-center">
                                          <input
                                            type="number"
                                            min={0}
                                            defaultValue={t[campoMeta] ?? ''}
                                            placeholder="—"
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                            }}
                                            onBlur={(e) => {
                                              const v = Math.max(0, Number(e.target.value) || 0);
                                              const atual = t[campoMeta] ?? 0;
                                              if (v === atual) return;
                                              void salvarMeta(
                                                chave, i.ref, i.cor, t.tamanho,
                                                campoMeta === 'minimo' ? v : (t.minimo ?? 0),
                                                campoMeta === 'ideal' ? v : (t.ideal ?? 0),
                                              );
                                            }}
                                            className="w-14 rounded border border-slate-300 px-1 py-0.5 text-center text-sm tabular-nums focus:border-violet-500 focus:outline-none"
                                          />
                                        </td>
                                      ))}
                                  </tr>
                                ),
                              )}

                              {/* A ORDEM DE COMPRA que ele descreveu: só
                                  aparece onde o estoque bateu no mínimo, e o
                                  número é `ideal - estoque`, calculado no
                                  servidor pra não divergir da reposição
                                  automática quando ela vier. */}
                              {grade.tamanhos.some((t) => t.abaixoDoMinimo && t.repor > 0) && (
                                <tr>
                                  <td className="px-2 py-1 text-[11px] font-bold uppercase text-rose-700">
                                    Repor
                                  </td>
                                  {[...grade.tamanhos]
                                    .sort((a, b) => ordemTamanho(a.tamanho) - ordemTamanho(b.tamanho))
                                    .map((t) => (
                                      <td key={t.tamanho} className="px-3 py-1 text-center tabular-nums">
                                        {t.abaixoDoMinimo && t.repor > 0 ? (
                                          <span className="rounded bg-rose-600 px-1.5 py-0.5 text-xs font-bold text-white">
                                            +{t.repor}
                                          </span>
                                        ) : (
                                          <span className="text-slate-300">—</span>
                                        )}
                                      </td>
                                    ))}
                                </tr>
                              )}
                          </tbody>
                          </table>
                          <p className="mt-2 text-[11px] text-slate-400">
                            Vendidas no período escolhido{loja ? ' e na loja escolhida' : ''} · estoque é o de
                            hoje, na rede inteira.
                          </p>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {dados && dados.totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="px-3 py-1.5 border rounded disabled:opacity-40 hover:bg-slate-50">
            Anterior
          </button>
          <span className="text-slate-500">
            página {dados.page} de {dados.totalPages}
          </span>
          <button type="button" disabled={page >= dados.totalPages} onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1.5 border rounded disabled:opacity-40 hover:bg-slate-50">
            Próxima
          </button>
        </div>
      )}
    </div>
  );
}
