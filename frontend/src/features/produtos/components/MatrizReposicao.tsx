'use client';

/**
 * MATRIZ DE REPOSIÇÃO — o que comprar desta cor, tamanho a tamanho.
 *
 * Desenho do dono (24/08/2026): tamanhos em cima, cinco linhas embaixo.
 *
 *   1 TENHO HOJE  soma das lojas que vendem
 *   2 JÁ VENDEU   série histórica, líquido de devolução
 *   3 MÍNIMO      o que não pode faltar na rede        ← digitado
 *   4 IDEAL       grade cheia pra vender sem furo      ← digitado
 *   5 COMPRAR     ideal − tenho, nunca negativo
 *
 * É a OUTRA METADE da grade que fica logo acima na mesma tela: aquela responde
 * "onde a peça está", esta responde "quanto falta comprar". Por isso convivem
 * como modos e nenhuma substitui a outra.
 *
 * ── UMA UNIDADE SÓ: PEÇA NA REDE ──
 *
 * As cinco linhas falam a MESMA língua — peça inteira, somando a rede toda.
 *
 * A primeira versão pedia mínimo e ideal POR LOJA e multiplicava por 14; o
 * dono corrigiu no mesmo dia ("é para trabalhar com total"). Junto com o
 * número foi embora o botão REDE/POR LOJA: com o alvo digitado em total, as
 * linhas 3, 4 e 5 não têm versão "por loja", e um botão que dividisse só as
 * linhas 1 e 2 deixaria a tabela com duas unidades ao mesmo tempo — que é
 * exatamente a confusão que a correção veio desfazer. A cota de cada arara
 * sobrou como DICA embaixo do campo ("≈ 1,4/loja"), que informa sem virar
 * outro número pra conferir.
 *
 * ── De onde vem cada linha (e por que não vem tudo do mesmo lugar) ──
 *
 * O TENHO é somado AQUI, das mesmas `skus` e da mesma lista de lojas que a
 * grade de cima usa (`lojasDaGrade`). Buscar esse total num endpoint próprio
 * seria mais limpo de ler e daria, cedo ou tarde, um número diferente do TOT
 * exibido três centímetros acima — a casa já pagou caro por dois estoques da
 * mesma peça na mesma tela.
 *
 * O VENDEU vem de `/intelligence/vendas-produto/grade`, que já existia e já
 * alimenta a cascata de /retaguarda/vendas-por-produto. Uma segunda query com
 * regra própria acabaria divergindo do relatório da rede.
 *
 * O MÍNIMO e o IDEAL vêm de `/produto-ficha/reposicao` — os únicos dois
 * números que ninguém consegue calcular, porque são decisão de compra.
 *
 * ── Linha 5 ──
 *
 * `IDEAL − TENHO`, nunca negativo (decisão do dono, 24/08). Sobra não vira
 * pedido negativo: peça sobrando é assunto do realinhamento, não da compra.
 * Sem IDEAL configurado a célula fica vazia — chutar zero faria a matriz
 * afirmar "não precisa comprar nada" sobre uma peça que ninguém configurou.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { api } from '@/lib/api';
import { ordemTamanho } from '@/lib/ordem-tamanho';
import type { SkuRow } from '../types';
import { lojasDaGrade } from '../lojas-grade';

type LinhaVendaGrade = { tamanho: string; pecas: number; devolvidas: number };
type LinhaCfg = { tamanho: string; minimoTotal: number | null; idealTotal: number | null };

/** Rascunho da célula. String, e não número: "" precisa ser "em branco". */
type Rascunho = { minimo?: string; ideal?: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);

function mesesAtras(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return iso(d);
}

/**
 * A GRADE DA CASA é 46–60 (decisão do dono, 06/08) — mais as numerações
 * duplas, que `ordemTamanho` já resolve ("46/48" vira 46.48).
 *
 * `42`, `44`, `G`, `GG`, `P` são rótulo herdado do ERP: 2,0% do catálogo. O
 * tamanho aparece na matriz quando a peça TEM histórico ou saldo nele — some
 * do relatório seria pior —, mas fica apagado e não entra no pedido.
 */
function daCasa(tamanho: string): boolean {
  const n = ordemTamanho(tamanho);
  return n >= 46 && n < 61;
}

/** Cota por arara, só como dica. "1,4" lê melhor que "1.4". */
const porLoja = (total: number, lojas: number) =>
  (lojas > 0 ? total / lojas : 0).toFixed(1).replace('.', ',');

/**
 * Soma que PRESERVA o "não sei": nulo quando nenhuma célula tem número.
 * Com um valor que seja, os nulos restantes contam como zero — aí eles são
 * de fato "este tamanho não entra na conta", e não "a coluna inteira é uma
 * incógnita".
 */
const somaOuNulo = (vs: Array<number | null>): number | null =>
  vs.some((v) => v !== null) ? vs.reduce((s: number, v) => s + (v ?? 0), 0) : null;

export default function MatrizReposicao({
  ref_,
  marca,
  cor,
  skus,
  lojaNomes,
}: {
  /** REF-base do grupo — a mesma chave da ficha e das fotos. */
  ref_: string;
  marca: string;
  cor: string;
  skus: SkuRow[];
  lojaNomes: Map<string, string>;
}) {
  /**
   * Janela do VENDEU. Começa em 12 meses e não no mês corrente (o padrão da
   * casa): decisão de compra de peça que gira 2 por mês não cabe num mês —
   * a matriz nasceria com a linha 2 quase toda zerada.
   */
  const [de, setDe] = useState(() => mesesAtras(12));
  const [ate, setAte] = useState(() => iso(new Date()));

  const [vendas, setVendas] = useState<Map<string, LinhaVendaGrade> | null>(null);
  const [cfg, setCfg] = useState<Map<string, LinhaCfg>>(new Map());
  const [rascunhos, setRascunhos] = useState<Record<string, Rascunho>>({});
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [vendasErro, setVendasErro] = useState(false);
  const [cfgErro, setCfgErro] = useState(false);

  const lojas = useMemo(() => lojasDaGrade(skus, lojaNomes), [skus, lojaNomes]);
  const nLojas = lojas.length;

  /**
   * O VENDEU é buscado pela REF COMO ESTÁ NO CATÁLOGO, não pela REF-base.
   *
   * A cascata agrupa por base ("VLM-222 MA" cai em "VLM-222"), mas o
   * relatório de vendas casa a ref inteira — pedir a base devolveria zero.
   * Quando o grupo juntou mais de uma ref crua, soma as duas.
   */
  const refsCru = useMemo(
    () => [...new Set(skus.map((s) => String(s.ref || '').trim().toUpperCase()).filter(Boolean))],
    [skus],
  );

  const carregarVendas = useCallback(async () => {
    setVendasErro(false);
    try {
      const partes = await Promise.all(
        refsCru.map((r) => {
          const qs = new URLSearchParams({ ref: r, cor: cor === 'ÚNICA' ? '' : cor, de, ate });
          return api<{ tamanhos?: LinhaVendaGrade[] }>(`/intelligence/vendas-produto/grade?${qs}`);
        }),
      );
      const mapa = new Map<string, LinhaVendaGrade>();
      for (const p of partes) {
        for (const t of p?.tamanhos ?? []) {
          const chave = String(t.tamanho || '').trim().toUpperCase();
          if (!chave) continue;
          const atual = mapa.get(chave) ?? { tamanho: chave, pecas: 0, devolvidas: 0 };
          atual.pecas += Number(t.pecas) || 0;
          atual.devolvidas += Number(t.devolvidas) || 0;
          mapa.set(chave, atual);
        }
      }
      setVendas(mapa);
    } catch {
      /* Sem venda a matriz ainda serve: o TENHO e o IDEAL já decidem o pedido.
         Marca o erro pra linha 2 dizer "não deu pra carregar" em vez de
         mostrar zero — zero aqui seria lido como "essa peça nunca vendeu". */
      setVendas(new Map());
      setVendasErro(true);
    }
  }, [refsCru, cor, de, ate]);

  const carregarCfg = useCallback(async () => {
    setCfgErro(false);
    try {
      const qs = new URLSearchParams({ ref: ref_, marca, cor });
      const r = await api<{ tamanhos?: LinhaCfg[] }>(`/produto-ficha/reposicao?${qs}`);
      setCfg(new Map((r?.tamanhos ?? []).map((t) => [t.tamanho.toUpperCase(), t])));
    } catch {
      /**
       * ⚠️ FALHAR NÃO É "NADA CONFIGURADO".
       *
       * Engolir o erro e seguir com o mapa vazio desenha a matriz inteira em
       * branco — indistinguível de uma cor que ninguém configurou. Pior: os
       * campos ficariam editáveis e um Salvar por cima APAGARIA no banco a
       * grade que a tela só não conseguiu ler. Marca o erro; a faixa avisa e
       * os campos travam.
       */
      setCfg(new Map());
      setCfgErro(true);
    }
  }, [ref_, marca, cor]);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    void Promise.all([carregarVendas(), carregarCfg()]).finally(() => {
      if (vivo) setCarregando(false);
    });
    return () => { vivo = false; };
  }, [carregarVendas, carregarCfg]);

  /**
   * As colunas: todo tamanho que a peça TEM, que já VENDEU ou que alguém
   * configurou. Tamanho que vendeu e zerou é o caso mais importante da tela —
   * montar as colunas só pelo estoque de hoje esconderia exatamente ele.
   */
  const tamanhos = useMemo(() => {
    const s = new Set<string>();
    for (const r of skus) if (r.tamanho) s.add(String(r.tamanho).trim().toUpperCase());
    for (const t of vendas?.keys() ?? []) s.add(t);
    for (const t of cfg.keys()) s.add(t);
    return [...s].sort((a, b) => ordemTamanho(a) - ordemTamanho(b));
  }, [skus, vendas, cfg]);

  /** Só o que está na arara das lojas que vendem — igual à coluna TOT de cima. */
  const tenhoDe = useCallback(
    (tamanho: string) =>
      skus
        .filter((r) => String(r.tamanho || '').trim().toUpperCase() === tamanho)
        .reduce((s, r) => s + lojas.reduce((x, l) => x + (r.estoqueLojas?.[l] ?? 0), 0), 0),
    [skus, lojas],
  );

  /** Valor vigente da célula: o rascunho ganha do que está gravado. */
  const valorCfg = useCallback(
    (tamanho: string, campo: 'minimo' | 'ideal'): number | null => {
      const rasc = rascunhos[tamanho]?.[campo];
      if (rasc !== undefined) return rasc === '' ? null : Number(rasc);
      const salvo = cfg.get(tamanho);
      const v = campo === 'minimo' ? salvo?.minimoTotal : salvo?.idealTotal;
      return v ?? null;
    },
    [rascunhos, cfg],
  );

  const linhas = useMemo(
    () =>
      tamanhos.map((t) => {
        const v = vendas?.get(t);
        const minimo = valorCfg(t, 'minimo');
        const ideal = valorCfg(t, 'ideal');
        const tenho = tenhoDe(t);
        return {
          tamanho: t,
          casa: daCasa(t),
          tenho,
          vendeu: Math.max(0, (v?.pecas ?? 0) - (v?.devolvidas ?? 0)),
          devolvidas: v?.devolvidas ?? 0,
          minimo,
          ideal,
          // Sem ideal não há alvo — e sem alvo não existe pedido. Nulo, não zero.
          comprar: ideal === null ? null : Math.max(0, ideal - tenho),
        };
      }),
    [tamanhos, vendas, valorCfg, tenhoDe],
  );

  /** Uma unidade só (peça na rede), então um total só por linha. */
  const totais = useMemo(
    () => ({
      tenho: linhas.reduce((s, l) => s + l.tenho, 0),
      vendeu: linhas.reduce((s, l) => s + l.vendeu, 0),
      /**
       * NULO, e não zero, quando NENHUM tamanho tem o número.
       *
       * A regra "sem valor a célula fica vazia" valia só pras células; os TOT
       * somavam `?? 0` e imprimiam **0** — no caso do COMPRAR, em negrito
       * sobre violeta, o número mais destacado da matriz — dizendo "não
       * precisa comprar nada" sobre uma cor que ninguém configurou. E esse é
       * o estado de TODAS as cores logo depois deste deploy, porque a
       * renomeação da coluna esvazia o que havia; é também o que a tela mostra
       * quando a leitura do mínimo/ideal FALHA. Zero é uma afirmação; nesses
       * dois casos a verdade é "não sei".
       */
      minimo: somaOuNulo(linhas.map((l) => l.minimo)),
      ideal: somaOuNulo(linhas.map((l) => l.ideal)),
      comprar: somaOuNulo(linhas.map((l) => l.comprar)),
    }),
    [linhas],
  );

  const maiorVenda = useMemo(
    () => Math.max(1, ...linhas.map((l) => l.vendeu)),
    [linhas],
  );

  const temRascunho = Object.keys(rascunhos).length > 0;

  function digitar(tamanho: string, campo: 'minimo' | 'ideal', valor: string) {
    setErro(null);
    setRascunhos((p) => ({ ...p, [tamanho]: { ...p[tamanho], [campo]: valor } }));
  }

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const qs = new URLSearchParams({ ref: ref_, marca, cor });
      // Manda a grade INTEIRA: o backend apaga o que voltar em branco, e é
      // assim que "limpar o 60" vira de fato limpar, e não ficar como estava.
      const corpo = {
        tamanhos: linhas.map((l) => ({
          tamanho: l.tamanho,
          minimoTotal: l.minimo,
          idealTotal: l.ideal,
        })),
      };
      const r = await api<{ tamanhos?: LinhaCfg[] }>(`/produto-ficha/reposicao?${qs}`, {
        method: 'PUT',
        body: JSON.stringify(corpo),
      });
      setCfg(new Map((r?.tamanhos ?? []).map((t) => [t.tamanho.toUpperCase(), t])));
      setRascunhos({});
    } catch (e: any) {
      /**
       * `e.body` antes de `e.message`: o `api()` monta a mensagem como
       * `400: {"message":"..."}`, e a recusa daqui é uma frase escrita pra
       * ser lida ("Tamanho 48: o ideal não pode ser menor que o mínimo").
       * Mostrar o JSON cru joga fora a única parte útil.
       */
      setErro(e?.body?.message || e?.message || 'Não deu pra salvar o mínimo e o ideal.');
    } finally {
      setSalvando(false);
    }
  }

  /* ─────────────────────────────── estilos ─────────────────────────────── */

  const CEL = 'px-2 py-1.5 text-center tabular-nums';
  const ROT = 'px-2.5 py-1.5 text-left';
  /** `w-14`: o campo agora recebe o total da rede, que chega a três dígitos. */
  const CAIXA =
    'w-14 px-1 py-1 text-center text-xs tabular-nums font-bold rounded border ' +
    'border-amber-300 bg-amber-50 text-amber-900 focus:outline-none focus:ring-2 focus:ring-amber-400';

  /**
   * Semáforo do TENHO. Sem mínimo configurado não há régua — fica neutro.
   *
   * ⚠️ IDEAL ZERO NÃO É VERDE. "Não quero carregar este tamanho" com peça na
   * arara é encalhe, e verde ali diria "está tudo certo" sobre a peça que
   * ninguém vai vender — que é justamente o que a matriz existe pra mostrar.
   */
  function semaforoTenho(l: (typeof linhas)[number]): { classe: string; dica?: string } {
    if (l.tenho <= 0 && l.vendeu > 0) {
      return { classe: 'bg-rose-50 text-rose-700', dica: 'Vendeu e zerou' };
    }
    if (l.ideal === 0 && l.tenho > 0) {
      return {
        classe: 'bg-slate-100 text-slate-500',
        dica: `Ideal zerado pra este tamanho, mas ainda tem ${l.tenho} na rede — é encalhe, não reposição`,
      };
    }
    if (l.minimo !== null && l.tenho < l.minimo) {
      return { classe: 'bg-amber-50 text-amber-800', dica: `Abaixo do mínimo (${l.minimo})` };
    }
    if (l.ideal && l.tenho >= l.ideal) {
      return { classe: 'bg-green-50 text-green-700', dica: 'No ideal ou acima' };
    }
    return { classe: 'text-slate-700' };
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
      {/* Cabeçalho: só o recorte de tempo do VENDEU. A unidade não é escolha —
          a matriz inteira é peça na rede. */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-violet-50/60 border-b border-violet-100">
        <h4 className="text-[11px] font-bold uppercase tracking-wide text-violet-800">
          O que comprar desta cor
        </h4>

        <span className="text-[10px] font-bold uppercase text-slate-400 ml-1">vendeu de</span>
        <input
          type="date"
          value={de}
          onChange={(e) => setDe(e.target.value)}
          className="text-[11px] border border-slate-300 rounded px-1.5 py-0.5 tabular-nums"
        />
        <span className="text-[10px] font-bold uppercase text-slate-400">até</span>
        <input
          type="date"
          value={ate}
          onChange={(e) => setAte(e.target.value)}
          className="text-[11px] border border-slate-300 rounded px-1.5 py-0.5 tabular-nums"
        />

        {/* Atalhos LONGOS de propósito. Hoje/Ontem/7 dias, os da casa, não
            dizem nada sobre o que comprar de uma peça que gira 2 por mês. */}
        {([['Tudo', ''], ['24 meses', mesesAtras(24)], ['12 meses', mesesAtras(12)], ['6 meses', mesesAtras(6)], ['3 meses', mesesAtras(3)]] as const).map(
          ([texto, valor]) => (
            <button
              key={texto}
              type="button"
              onClick={() => { setDe(valor); setAte(iso(new Date())); }}
              className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                de === valor
                  ? 'bg-violet-600 border-violet-600 text-white'
                  : 'bg-white border-violet-200 text-violet-700 hover:bg-violet-50'
              }`}
            >
              {texto}
            </button>
          ),
        )}

        <span className="ml-auto text-[10px] font-bold uppercase tracking-wide text-slate-400">
          peças na rede · {nLojas} lojas
        </span>
      </div>

      {/* Falha de leitura do mínimo/ideal: avisa em vez de deixar a tela
          parecer "ninguém configurou". Os campos ficam travados enquanto
          isso — Salvar por cima apagaria o que existe no banco. */}
      {cfgErro && !carregando && (
        <p className="px-3 py-2 text-[11px] font-bold text-rose-800 bg-rose-50 border-b border-rose-200">
          Não deu pra carregar o mínimo e o ideal desta cor. Os campos estão travados pra não
          gravar por cima do que já está lá — recarregue a página pra tentar de novo.
        </p>
      )}

      {carregando ? (
        <p className="px-3 py-6 text-xs text-slate-400 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Montando a matriz…
        </p>
      ) : !tamanhos.length ? (
        <p className="px-3 py-6 text-xs text-slate-400">
          Esta cor não tem tamanho nenhum no cadastro.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-xs min-w-full">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-bold w-44">Tamanho</th>
                {linhas.map((l) => (
                  <th
                    key={l.tamanho}
                    title={l.casa ? undefined : 'Fora da grade da casa (46–60) — rótulo herdado do ERP'}
                    className={`px-2 py-1.5 font-bold whitespace-nowrap ${
                      l.casa ? 'text-slate-700' : 'text-slate-300'
                    }`}
                  >
                    {l.tamanho}
                  </th>
                ))}
                <th className="px-2 py-1.5 font-bold border-l border-slate-200 bg-slate-100">TOT</th>
              </tr>
            </thead>
            <tbody>
              {/* 1 — TENHO */}
              <tr className="border-t border-slate-100">
                <td className={ROT}>
                  <div className="text-[11px] font-bold text-slate-800">1 · TENHO HOJE</div>
                  <div className="text-[9.5px] text-slate-400">soma das {nLojas} lojas</div>
                </td>
                {linhas.map((l) => {
                  const { classe, dica } = semaforoTenho(l);
                  return (
                    <td key={l.tamanho} title={dica} className={`${CEL} font-bold ${classe}`}>
                      {l.tenho}
                    </td>
                  );
                })}
                <td className={`${CEL} font-bold border-l border-slate-200 bg-slate-50`}>
                  {totais.tenho}
                </td>
              </tr>

              {/* 2 — VENDEU */}
              <tr className="border-t border-slate-100">
                <td className={ROT}>
                  <div className="text-[11px] font-bold text-slate-800">2 · JÁ VENDEU</div>
                  <div className="text-[9.5px] text-slate-400">
                    {vendasErro ? 'não deu pra carregar' : 'no período · líquido de devolução'}
                  </div>
                </td>
                {linhas.map((l) => (
                  <td key={l.tamanho} className={CEL}>
                    {vendasErro ? (
                      <span className="text-slate-300">?</span>
                    ) : (
                      <>
                        <span className={l.vendeu ? 'font-bold text-slate-700' : 'text-slate-300'}>
                          {l.vendeu}
                        </span>
                        {l.devolvidas > 0 && (
                          <span className="text-[9px] text-rose-600" title={`${l.devolvidas} devolvida(s)`}>
                            {' '}−{l.devolvidas}
                          </span>
                        )}
                        {/* A barrinha mostra o MIX da grade num relance: é o
                            que diz qual tamanho merece peça, não o número
                            solto. */}
                        <span
                          className="block h-[3px] rounded-sm bg-violet-500/50 mx-auto mt-0.5"
                          style={{ width: `${Math.round((l.vendeu / maiorVenda) * 100)}%` }}
                        />
                      </>
                    )}
                  </td>
                ))}
                <td className={`${CEL} font-bold border-l border-slate-200 bg-slate-50`}>
                  {vendasErro ? '?' : totais.vendeu}
                </td>
              </tr>

              {/* 3 e 4 — o que se digita: PEÇA NA REDE, a mesma unidade da
                  linha 1 logo acima. A cota da arara vira dica embaixo do
                  campo, pra dar a noção sem virar um segundo número. */}
              {(['minimo', 'ideal'] as const).map((campo) => (
                <tr key={campo} className="border-t border-slate-100 bg-amber-50/30">
                  <td className={ROT}>
                    <div className="text-[11px] font-bold text-slate-800">
                      {campo === 'minimo' ? '3 · MÍNIMO' : '4 · IDEAL'}
                    </div>
                    <div className="text-[9.5px] text-slate-400">
                      {campo === 'minimo'
                        ? 'o que não pode faltar na rede'
                        : 'grade cheia na rede'}
                    </div>
                  </td>
                  {linhas.map((l) => {
                    const valor = campo === 'minimo' ? l.minimo : l.ideal;
                    return (
                      <td key={l.tamanho} className="px-1 py-1 text-center">
                        <input
                          type="number"
                          min={0}
                          max={999}
                          value={valor ?? ''}
                          placeholder="—"
                          disabled={cfgErro}
                          aria-label={`${campo === 'minimo' ? 'Mínimo' : 'Ideal'} na rede do tamanho ${l.tamanho}`}
                          onChange={(e) => digitar(l.tamanho, campo, e.target.value)}
                          className={`${CAIXA} disabled:bg-slate-100 disabled:border-slate-200 disabled:text-slate-400`}
                        />
                        {/* ZERO tem dizer próprio. `valor ? …` deixaria o
                            0 (decisão gravada: "a rede não carrega este
                            tamanho") com a faixa vazia, igualzinho ao nunca
                            configurado — apagando NULO≠ZERO na única tela
                            cuja regra central é essa. */}
                        <span className="block text-[9px] font-bold text-amber-700/70">
                          {valor === null
                            ? ''
                            : valor === 0
                              ? <em className="not-italic text-slate-400">não carrega</em>
                              : `≈ ${porLoja(valor, nLojas)}/loja`}
                        </span>
                      </td>
                    );
                  })}
                  <td className={`${CEL} font-bold border-l border-slate-200 bg-slate-50`}>
                    {(campo === 'minimo' ? totais.minimo : totais.ideal) ?? (
                      <span className="text-slate-300" title="Nenhum tamanho configurado">—</span>
                    )}
                  </td>
                </tr>
              ))}

              {/* 5 — COMPRAR */}
              <tr className="bg-slate-900">
                <td className={`${ROT} bg-slate-900`}>
                  <div className="text-[11px] font-bold text-white">5 · COMPRAR</div>
                  <div className="text-[9.5px] text-slate-400">ideal − tenho</div>
                </td>
                {linhas.map((l) => (
                  <td key={l.tamanho} className={`${CEL} py-2.5`}>
                    {l.comprar === null ? (
                      <span
                        className="text-slate-600"
                        title="Sem ideal configurado — nada a pedir enquanto ninguém disser quanto quer ter"
                      >
                        —
                      </span>
                    ) : (
                      <span className={l.comprar > 0 ? 'text-white font-bold text-sm' : 'text-slate-500'}>
                        {l.comprar}
                      </span>
                    )}
                  </td>
                ))}
                <td className={`${CEL} py-2.5 border-l border-violet-800 bg-violet-600`}>
                  {totais.comprar === null ? (
                    <span
                      className="text-violet-200"
                      title="Nenhum tamanho tem ideal configurado — não dá pra dizer quanto comprar"
                    >
                      —
                    </span>
                  ) : (
                    <span className="text-white font-bold text-sm">{totais.comprar}</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Rodapé: a régua da conta, o estado do rascunho e a legenda. */}
      <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-t border-slate-200 bg-slate-50/70">
        <span className="text-[11px] text-slate-500">
          Linha 5 = <b className="text-slate-700">ideal − tenho</b>, nunca negativo. Peça sobrando
          não vira pedido — vira realinhamento.
        </span>
        {erro && <span className="text-[11px] font-bold text-rose-700">{erro}</span>}
        {temRascunho && (
          <button
            type="button"
            onClick={() => void salvar()}
            disabled={salvando}
            className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {salvando ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Salvar mínimo e ideal
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-1.5 text-[10px] text-slate-500 border-t border-slate-100">
        <span><i className="inline-block w-2.5 h-2.5 rounded-sm bg-rose-100 mr-1 align-[-1px]" />vendeu e zerou</span>
        <span><i className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-100 mr-1 align-[-1px]" />abaixo do mínimo</span>
        <span><i className="inline-block w-2.5 h-2.5 rounded-sm bg-green-100 mr-1 align-[-1px]" />no ideal ou acima</span>
        <span><i className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-200 mr-1 align-[-1px]" />encalhe (ideal zerado e ainda tem)</span>
        <span className="text-slate-400">tamanho apagado = fora da grade da casa (46–60)</span>
      </div>
    </div>
  );
}
