'use client';

/**
 * FILA DE TRABALHO DA FICHA — o que preencher primeiro (item 24).
 *
 * O gargalo do site novo não é código, é cadastro: título, descrição, tecido,
 * ocasião, modelagem, medidas e bolinha saem todos da ficha, e o catálogo tem
 * milhares de REFs. Medido em 06/08/2026 na produção: das **525 peças
 * publicadas, ZERO tinham modelagem** — o filtro "Modelagem" some da vitrine
 * por falta de dado, não de código.
 *
 * "Preencher o catálogo" é tarefa que ninguém começa. "Preencher estas 20, que
 * venderam 340 peças no trimestre e estão sem descrição" é tarefa que acaba.
 * Esta tela existe pra transformar uma coisa na outra.
 *
 * A ordem é por VENDA porque ficha vazia numa peça que ninguém procura não
 * custa venda nenhuma. Peça SEM FOTO cai pro fim: sem foto ela nem entra na
 * vitrine, então a ficha dela não muda nada hoje.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  AlertTriangle, ArrowRight, Camera, CheckCircle2, ClipboardList, Loader2, RefreshCw,
} from 'lucide-react';

type Falta = { campo: string; rotulo: string; critico: boolean };

type ItemFila = {
  ref: string;
  marca: string;
  cores: number;
  estoque: number;
  preco: number;
  temFoto: boolean;
  temFicha: boolean;
  unidadesVendidas: number;
  faltas: Falta[];
  faltamCriticos: number;
  completude: number;
};

type Fila = {
  periodo: { de: string; ate: string };
  total: number;
  comPendencia: number;
  completas: number;
  /** Publicadas sem marca — não têm ficha possível (a chave é REF+MARCA). */
  semMarca: number;
  /** Pendências que não couberam no limite escolhido. */
  naoMostradas: number;
  itens: ItemFila[];
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const hoje = () => iso(new Date());
const diasAtras = (n: number) => iso(new Date(Date.now() - n * 86400000));

export default function FichaFilaPage() {
  const [de, setDe] = useState(diasAtras(90));
  const [ate, setAte] = useState(hoje());
  const [limite, setLimite] = useState(50);
  const [dados, setDados] = useState<Fila | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const q = new URLSearchParams({ de, ate, limite: String(limite) });
      setDados(await api<Fila>(`/produto-ficha/fila?${q.toString()}`));
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar a fila');
    } finally {
      setCarregando(false);
    }
  }, [de, ate, limite]);

  useEffect(() => { void carregar(); }, [carregar]);

  const progresso = useMemo(() => {
    if (!dados?.total) return 0;
    return Math.round((dados.completas / dados.total) * 100);
  }, [dados]);

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
      <header className="flex flex-wrap items-center gap-3 mb-4">
        <ClipboardList className="w-6 h-6 text-slate-700" />
        <div className="flex-1 min-w-[240px]">
          <h1 className="font-bold text-lg">Fila da ficha</h1>
          <p className="text-xs text-slate-500">
            O que preencher primeiro pra o site parar de mostrar peça sem descrição.
          </p>
        </div>
        <button
          onClick={() => void carregar()}
          className="px-3 py-2 bg-slate-900 text-white rounded text-sm font-bold hover:bg-slate-800 flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${carregando ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </header>

      {/* Recorte de tempo: De/Até + atalhos (convenção da casa) */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex gap-3 items-end flex-wrap mb-4">
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-600 block mb-1">De</label>
          <input type="date" value={de} onChange={(e) => setDe(e.target.value)}
            className="px-3 py-2 border border-slate-300 rounded text-sm" />
        </div>
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-600 block mb-1">Até</label>
          <input type="date" value={ate} onChange={(e) => setAte(e.target.value)}
            className="px-3 py-2 border border-slate-300 rounded text-sm" />
        </div>
        <div className="flex gap-1">
          {[
            ['Hoje', () => { setDe(hoje()); setAte(hoje()); }],
            ['Ontem', () => { setDe(diasAtras(1)); setAte(diasAtras(1)); }],
            ['7 dias', () => { setDe(diasAtras(7)); setAte(hoje()); }],
            ['Mês', () => { setDe(diasAtras(30)); setAte(hoje()); }],
            ['90 dias', () => { setDe(diasAtras(90)); setAte(hoje()); }],
          ].map(([rotulo, aplicar]) => (
            <button
              key={rotulo as string}
              onClick={aplicar as () => void}
              className="px-2.5 py-2 text-xs text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
            >
              {rotulo as string}
            </button>
          ))}
        </div>
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-600 block mb-1">
            Mostrar
          </label>
          <select
            value={limite}
            onChange={(e) => setLimite(Number(e.target.value))}
            className="px-3 py-2 border border-slate-300 rounded text-sm"
          >
            {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n} peças</option>)}
          </select>
        </div>
        <p className="text-xs text-slate-500 flex-1 min-w-[200px]">
          A janela vale só pra <strong>venda</strong> — é ela que ordena a fila. A lista de
          pendências é sempre a de agora.
        </p>
      </div>

      {erro && (
        <div className="bg-rose-50 border border-rose-300 text-rose-800 p-3 rounded text-sm mb-4">
          {erro}
        </div>
      )}

      {carregando && !dados && (
        <div className="flex items-center gap-2 text-slate-500 text-sm py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Montando a fila…
        </div>
      )}

      {dados && (
        <>
          {/* Progresso — a razão de a fila existir é ver este número subir */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 mb-3">
              <p className="text-sm">
                <strong className="text-2xl tabular-nums">{dados.completas}</strong>
                <span className="text-slate-500"> de {dados.total} peças publicadas com a ficha completa</span>
              </p>
              <p className="text-sm text-slate-500">
                <strong className="text-rose-700 tabular-nums">{dados.comPendencia}</strong> ainda faltando
              </p>
            </div>
            <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${progresso}%` }}
              />
            </div>
            <p className="text-xs text-slate-400 mt-1.5 tabular-nums">{progresso}% pronto</p>

            {/* Nada de corte silencioso: o que ficou de fora aparece. */}
            {(dados.naoMostradas > 0 || dados.semMarca > 0) && (
              <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-500 space-y-1">
                {dados.naoMostradas > 0 && (
                  <p>
                    Mais <strong className="tabular-nums">{dados.naoMostradas}</strong> peça(s) com
                    pendência fora deste recorte — aumente o “mostrar” pra ver.
                  </p>
                )}
                {dados.semMarca > 0 && (
                  <p className="text-amber-700">
                    <strong className="tabular-nums">{dados.semMarca}</strong> peça(s) publicada(s)
                    sem marca no cadastro: não têm ficha possível (a chave é REF + marca) e ficam
                    fora da fila até alguém corrigir o cadastro.
                  </p>
                )}
              </div>
            )}
          </div>

          {dados.itens.length === 0 ? (
            <div className="bg-emerald-50 border border-emerald-300 text-emerald-900 p-6 rounded-xl text-center">
              <CheckCircle2 className="w-6 h-6 mx-auto mb-2" />
              <p className="font-bold">Nenhuma pendência.</p>
              <p className="text-sm">Todas as peças publicadas têm ficha completa.</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[860px]">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr className="text-left text-xs uppercase tracking-wider text-slate-600">
                      <th className="px-4 py-3 font-bold">#</th>
                      <th className="px-4 py-3 font-bold">Peça</th>
                      <th className="px-4 py-3 font-bold text-right">Vendeu</th>
                      <th className="px-4 py-3 font-bold text-right">Estoque</th>
                      <th className="px-4 py-3 font-bold">O que falta</th>
                      <th className="px-4 py-3 font-bold text-right">Pronta</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {dados.itens.map((it, i) => (
                      <tr
                        key={`${it.ref}|${it.marca}`}
                        className={`border-b border-slate-100 ${it.temFoto ? '' : 'bg-slate-50/60'}`}
                      >
                        <td className="px-4 py-3 tabular-nums text-slate-400">{i + 1}</td>
                        <td className="px-4 py-3">
                          <p className="font-bold tabular-nums">{it.ref}</p>
                          <p className="text-xs text-slate-500">
                            {it.marca} · {it.cores} cor{it.cores === 1 ? '' : 'es'}
                          </p>
                          {!it.temFoto && (
                            <p className="text-[11px] text-amber-700 flex items-center gap-1 mt-0.5">
                              <Camera className="w-3 h-3" /> sem foto — não aparece na vitrine
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {it.unidadesVendidas > 0 ? (
                            <strong>{it.unidadesVendidas}</strong>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-500">{it.estoque}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {it.faltas.map((f) => (
                              <span
                                key={f.campo}
                                className={`px-1.5 py-0.5 rounded text-[11px] ${
                                  f.critico
                                    ? 'bg-rose-50 text-rose-800 border border-rose-200'
                                    : 'bg-slate-100 text-slate-600'
                                }`}
                              >
                                {f.rotulo}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          <span className={it.faltamCriticos > 0 ? 'text-rose-700 font-bold' : 'text-slate-500'}>
                            {it.completude}%
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {/* Um clique e a peça já está aberta na master, buscada
                              pela REF — a fila só serve se levar ao trabalho. */}
                          <Link
                            href={`/retaguarda/produto-master?busca=${encodeURIComponent(it.ref)}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-900 text-white rounded text-xs font-bold hover:bg-slate-800 whitespace-nowrap"
                          >
                            Preencher <ArrowRight className="w-3 h-3" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-xs text-slate-400 mt-4 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              A venda é somada por REF, não por REF+marca (o item de venda não guarda marca).
              Quando a mesma REF foi reciclada entre dois fornecedores, as duas fichas herdam o
              total das duas — ordena uma delas um pouco pra cima, e é por isso que a coluna diz
              “vendeu”, não é relatório de vendas.
            </span>
          </p>
        </>
      )}
    </div>
  );
}
