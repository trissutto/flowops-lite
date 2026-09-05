'use client';

/**
 * LIMPEZA DE CLIENTES — /retaguarda/clientes-limpeza (20/08/2026).
 *
 * Painel da matriz pras duas sujeiras herdadas do Wincred que quebram o balcão
 * (casos Jessica e Rafaela, do mesmo dia):
 *
 * 1. DUPLICATAS: mesma pessoa (CPF) com 2+ fichas na MESMA loja. O grupo
 *    aparece lado a lado, o backend SUGERE qual manter (movimento + avaliação
 *    + dados) e um clique arquiva as outras — nada é apagado, e o que a
 *    perdedora tiver de melhor (avaliação, limite) é copiado pra mantida.
 *
 * 2. SEM CPF: ficha sem CPF é negada no marcado mesmo com avaliação e limite
 *    (o cruzamento venda→ficha é por CPF). O painel casa a ficha com a pessoa
 *    do CRM (telefone = forte, nome = confira antes) e copia o CPF em 1 clique.
 *
 * Só matriz. Nada aqui toca estoque, venda ou caixa.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  ArrowLeft, BadgeCheck, Check, ChevronLeft, ChevronRight,
  Loader2, Phone, Sparkles, UserRound,
} from 'lucide-react';

type FichaDuplicata = {
  codigo: string;
  nome: string | null;
  avaliacao: string | null;
  limite: number;
  bloqueado: string | null;
  ultCompra: string | null;
  marcadosAtivos: number;
  temDados: boolean;
  score: number;
};

type GrupoDuplicata = {
  loja: string;
  cpf: string;
  sugerida: string;
  fichas: FichaDuplicata[];
};

type CandidatoCrm = {
  customerId: string;
  nome: string | null;
  cpfMascarado: string;
  telefone: string | null;
  via: string; // 'telefone' (forte) | 'nome' (confira antes)
};

type FichaSemCpf = {
  loja: string;
  codigo: string;
  nome: string | null;
  fone: string | null;
  ultCompra: string | null;
  avaliacao: string | null;
  limite: number;
  candidatos: CandidatoCrm[];
};

const brl = (n: number | string) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCpf = (cpf: string) => {
  const d = String(cpf || '').replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : cpf;
};
/** ULTCOMPRA vem do rawJson da ficha — formata se parsear como data, senão mostra cru. */
const fmtData = (v: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('pt-BR');
};
const fmtInt = (n: number) => Number(n || 0).toLocaleString('pt-BR');

type Aba = 'duplicatas' | 'sem-cpf';

export default function ClientesLimpezaPage() {
  const [aba, setAba] = useState<Aba>('duplicatas');

  // ── Aba DUPLICATAS ──
  const [grupos, setGrupos] = useState<GrupoDuplicata[]>([]);
  const [dupCarregando, setDupCarregando] = useState(true);
  const [dupErro, setDupErro] = useState<string | null>(null);
  /** "loja/codigo" da ficha cujo "Manter esta" está indo pro servidor. */
  const [resolvendo, setResolvendo] = useState<string | null>(null);

  const carregarDuplicatas = useCallback(async () => {
    setDupCarregando(true);
    setDupErro(null);
    try {
      const r = await api<{ grupos: GrupoDuplicata[] }>('/admin/clientes-giga/limpeza/duplicatas');
      setGrupos(r?.grupos || []);
    } catch (e: unknown) {
      setDupErro((e as Error)?.message?.replace(/^\d+:\s*/, '') || 'Não consegui carregar');
    } finally {
      setDupCarregando(false);
    }
  }, []);

  useEffect(() => { void carregarDuplicatas(); }, [carregarDuplicatas]);

  const resolver = useCallback(async (grupo: GrupoDuplicata, manterCodigo: string) => {
    const outras = grupo.fichas.filter((f) => f.codigo !== manterCodigo).map((f) => f.codigo);
    const ok = confirm(
      `Manter a ficha ${manterCodigo} da loja ${grupo.loja}?\n\n` +
        `As outras (${outras.join(', ')}) serão ARQUIVADAS — não apagadas: saem das buscas ` +
        `e do marcado, mas o histórico continua legível. O que elas tiverem de melhor ` +
        `(avaliação, limite maior) é copiado pra ficha mantida antes.`,
    );
    if (!ok) return;
    setResolvendo(`${grupo.loja}/${manterCodigo}`);
    try {
      await api('/admin/clientes-giga/limpeza/duplicatas/resolver', {
        method: 'POST',
        body: JSON.stringify({ loja: grupo.loja, cpf: grupo.cpf, manterCodigo }),
      });
      await carregarDuplicatas();
    } catch (e: unknown) {
      alert((e as Error)?.message?.replace(/^\d+:\s*/, '') || 'Não consegui resolver o grupo. Tente de novo.');
    } finally {
      setResolvendo(null);
    }
  }, [carregarDuplicatas]);

  // ── Aba SEM CPF ──
  const [rows, setRows] = useState<FichaSemCpf[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [porPagina, setPorPagina] = useState(50);
  const [semCarregando, setSemCarregando] = useState(true);
  const [semErro, setSemErro] = useState<string | null>(null);
  /** "loja/codigo" da ficha cujo "Copiar CPF" está indo pro servidor. */
  const [copiando, setCopiando] = useState<string | null>(null);

  const carregarSemCpf = useCallback(async (p: number) => {
    setSemCarregando(true);
    setSemErro(null);
    try {
      const r = await api<{ rows: FichaSemCpf[]; total: number; page: number; porPagina: number }>(
        `/admin/clientes-giga/limpeza/sem-cpf?page=${p}`,
      );
      setRows(r?.rows || []);
      setTotal(r?.total || 0);
      setPorPagina(r?.porPagina || 50);
    } catch (e: unknown) {
      setSemErro((e as Error)?.message?.replace(/^\d+:\s*/, '') || 'Não consegui carregar');
    } finally {
      setSemCarregando(false);
    }
  }, []);

  useEffect(() => { void carregarSemCpf(page); }, [carregarSemCpf, page]);

  const copiarCpf = useCallback(async (ficha: FichaSemCpf, cand: CandidatoCrm) => {
    const aviso = cand.via === 'nome'
      ? '\n\n⚠️ Esse candidato casou só pelo NOME — confira antes: nome igual não garante que é a mesma pessoa.'
      : '';
    const ok = confirm(
      `Copiar o CPF ${cand.cpfMascarado} de "${cand.nome || 'pessoa do CRM'}" ` +
        `pra ficha ${ficha.codigo} da loja ${ficha.loja} (${ficha.nome || 'sem nome'})?` + aviso,
    );
    if (!ok) return;
    setCopiando(`${ficha.loja}/${ficha.codigo}`);
    try {
      await api('/admin/clientes-giga/limpeza/copiar-cpf', {
        method: 'POST',
        body: JSON.stringify({ loja: ficha.loja, codigo: ficha.codigo, customerId: cand.customerId }),
      });
      // A ficha ganhou CPF — sai da lista local (o total do header segue o servidor
      // até a próxima página, mas a linha resolvida não pode continuar na tela).
      setRows((cur) => cur.filter((r) => !(r.loja === ficha.loja && r.codigo === ficha.codigo)));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e: unknown) {
      alert((e as Error)?.message?.replace(/^\d+:\s*/, '') || 'Não consegui copiar o CPF. Tente de novo.');
    } finally {
      setCopiando(null);
    }
  }, []);

  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
  const totalFichasDup = grupos.reduce((s, g) => s + g.fichas.length, 0);

  const th = 'px-3 py-2 text-left text-[11px] font-bold uppercase text-slate-500 whitespace-nowrap';
  const td = 'px-3 py-2 text-sm whitespace-nowrap align-top';

  return (
    <div className="max-w-[1400px] mx-auto p-4 space-y-4">
      <div className="flex items-start gap-3">
        <Link href="/retaguarda/clientes" className="mt-1 text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-[#B8912B]" /> Limpeza de Clientes
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Duas sujeiras herdadas do sistema antigo: a mesma pessoa com 2+ fichas na mesma loja, e
            ficha sem CPF (que o marcado nega). Arquivar nunca apaga — o histórico continua legível.
          </p>
        </div>
      </div>

      {/* ── ABAS ── */}
      <div className="flex gap-1.5 border-b border-slate-200">
        {([
          ['duplicatas', `Duplicatas${!dupCarregando ? ` (${grupos.length})` : ''}`],
          ['sem-cpf', `Sem CPF${!semCarregando ? ` (${fmtInt(total)})` : ''}`],
        ] as const).map(([k, rotulo]) => (
          <button key={k} type="button" onClick={() => setAba(k)}
            className={`px-4 py-2 rounded-t-lg text-sm font-bold border border-b-0 -mb-px ${
              aba === k
                ? 'bg-white border-slate-200 text-slate-800'
                : 'bg-slate-50 border-transparent text-slate-500 hover:text-slate-700'
            }`}>
            {rotulo}
          </button>
        ))}
      </div>

      {/* ════════════════ ABA DUPLICATAS ════════════════ */}
      {aba === 'duplicatas' && (
        <div className="space-y-3">
          {!dupCarregando && (
            <p className="text-sm font-bold text-slate-600">
              {fmtInt(grupos.length)} grupos · {fmtInt(totalFichasDup)} fichas
            </p>
          )}

          {dupErro && (
            <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 font-semibold">
              {dupErro}
            </div>
          )}

          {dupCarregando ? (
            <div className="p-12 text-center text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin mx-auto" />
            </div>
          ) : !grupos.length ? (
            <div className="bg-white rounded-lg border p-10 text-center text-slate-400 text-sm">
              Nenhuma duplicata viva — a base está limpa. 🎉
            </div>
          ) : (
            grupos.map((g) => (
              <div key={`${g.loja}|${g.cpf}`} className="bg-white rounded-lg shadow border p-4">
                <p className="text-sm font-black text-slate-800 mb-3">
                  LJ{g.loja} · CPF {fmtCpf(g.cpf)}
                </p>
                <div className="flex flex-wrap gap-3">
                  {g.fichas.map((f) => {
                    const sugerida = f.codigo === g.sugerida;
                    const chave = `${g.loja}/${f.codigo}`;
                    return (
                      <div key={f.codigo}
                        className={`w-64 rounded-lg border p-3 space-y-1.5 ${
                          sugerida ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200'
                        }`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono font-bold text-slate-800">{f.codigo}</span>
                          {sugerida && (
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-black text-white">
                              <BadgeCheck className="w-3 h-3" /> SUGERIDA MANTER
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-medium text-slate-800 truncate" title={f.nome || ''}>
                          {f.nome || '—'}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className={`rounded border px-1.5 py-0.5 font-bold ${
                            String(f.avaliacao || '').trim()
                              ? 'border-sky-300 bg-sky-50 text-sky-800'
                              : 'border-slate-200 bg-slate-50 text-slate-400'
                          }`}>
                            {String(f.avaliacao || '').trim() ? `Avaliação ${f.avaliacao}` : 'sem avaliação'}
                          </span>
                          {f.bloqueado && String(f.bloqueado).trim().toUpperCase() !== 'N' && (
                            <span className="rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 font-bold text-rose-700">
                              bloqueada
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-600 space-y-0.5">
                          <p>Limite: <b className="text-slate-800">{brl(f.limite)}</b></p>
                          <p>Última compra: <b className="text-slate-800">{fmtData(f.ultCompra)}</b></p>
                          {f.marcadosAtivos > 0 && (
                            <p className="text-amber-700 font-bold">{f.marcadosAtivos} marcado(s) ativo(s)</p>
                          )}
                          {f.temDados && (
                            <p className="text-emerald-700 font-semibold">dados completos ✓</p>
                          )}
                        </div>
                        <button type="button" disabled={resolvendo !== null}
                          onClick={() => void resolver(g, f.codigo)}
                          className={`w-full mt-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50 ${
                            sugerida
                              ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                              : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
                          }`}>
                          {resolvendo === chave
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Check className="w-3.5 h-3.5" />}
                          Manter esta
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ════════════════ ABA SEM CPF ════════════════ */}
      {aba === 'sem-cpf' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            Ficha sem CPF é <b>negada no marcado</b> mesmo com avaliação e limite (caso Rafaela 20/08).
          </div>

          <div className="flex items-center justify-between gap-3">
            {!semCarregando && (
              <p className="text-sm font-bold text-slate-600">{fmtInt(total)} fichas sem CPF</p>
            )}
            <div className="flex items-center gap-2 ml-auto">
              <button type="button" disabled={page <= 1 || semCarregando}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                <ChevronLeft className="w-3.5 h-3.5" /> Anterior
              </button>
              <span className="text-xs text-slate-500 tabular-nums">{page} / {fmtInt(totalPaginas)}</span>
              <button type="button" disabled={page >= totalPaginas || semCarregando}
                onClick={() => setPage((p) => p + 1)}
                className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                Próxima <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {semErro && (
            <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 font-semibold">
              {semErro}
            </div>
          )}

          <div className="bg-white rounded-lg shadow border overflow-x-auto">
            {semCarregando ? (
              <div className="p-12 text-center text-slate-400">
                <Loader2 className="w-6 h-6 animate-spin mx-auto" />
              </div>
            ) : !rows.length ? (
              <div className="p-10 text-center text-slate-400 text-sm">
                Nenhuma ficha sem CPF nesta página.
              </div>
            ) : (
              <table className="w-full">
                <thead className="bg-slate-50 border-b">
                  <tr>
                    <th className={th}>Loja</th>
                    <th className={th}>Código</th>
                    <th className={th}>Nome</th>
                    <th className={th}>Fone</th>
                    <th className={th}>Última compra</th>
                    <th className={th}>Avaliação / limite</th>
                    <th className={th}>Candidato do CRM</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => {
                    const chave = `${r.loja}/${r.codigo}`;
                    return (
                      <tr key={chave} className="hover:bg-slate-50">
                        <td className={`${td} text-slate-700`}>{r.loja}</td>
                        <td className={`${td} font-mono font-bold text-slate-800`}>{r.codigo}</td>
                        <td className={`${td} text-slate-800`}>{r.nome || '—'}</td>
                        <td className={`${td} text-slate-600 tabular-nums`}>{r.fone || '—'}</td>
                        <td className={`${td} text-slate-600 tabular-nums`}>{fmtData(r.ultCompra)}</td>
                        <td className={td}>
                          <span className="text-xs text-slate-700">
                            {String(r.avaliacao || '').trim() || '—'}
                            {' · '}
                            {r.limite > 0 ? brl(r.limite) : 'sem limite'}
                          </span>
                        </td>
                        <td className={`${td} !whitespace-normal`}>
                          {r.candidatos.length ? (
                            <div className="flex flex-col items-start gap-1.5">
                              {r.candidatos.map((c) => (
                                <div key={c.customerId} className="space-y-0.5">
                                  <button type="button" disabled={copiando !== null}
                                    onClick={() => void copiarCpf(r, c)}
                                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold disabled:opacity-50 ${
                                      c.via === 'telefone'
                                        ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                                        : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                                    }`}
                                    title={`${c.nome || ''}${c.telefone ? ` · ${c.telefone}` : ''}`}>
                                    {copiando === chave
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : c.via === 'telefone'
                                        ? <Phone className="w-3.5 h-3.5" />
                                        : <UserRound className="w-3.5 h-3.5" />}
                                    Copiar CPF {c.cpfMascarado} (casou por {c.via})
                                  </button>
                                  {c.via === 'nome' && (
                                    <p className="text-[10px] font-bold text-amber-700">⚠️ confira antes — casou só pelo nome</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">— nenhum candidato</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
