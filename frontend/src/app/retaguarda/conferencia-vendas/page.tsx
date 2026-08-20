'use client';

/**
 * CONFERÊNCIA DE VENDAS — /retaguarda/conferencia-vendas (20/08/2026).
 *
 * A venda online do PDV pode fechar por "PIX recebido" ou "Link externo" — a
 * PALAVRA da vendedora, sem nenhum gateway conferindo. Ontem (ON-000049) uma
 * cliente recebeu "recebemos seu pagamento" sem ter pago, e o pedido foi
 * marcado ENVIADO na mão. Medido: 24 de 52 pedidos sem nenhuma prova de
 * pagamento (R$ 5.419).
 *
 * Esta tela é a conferência humana da matriz: cada pedido ON- com sua prova
 * (ou a falta dela), e o carimbo "dinheiro conferido no extrato". O que fica
 * vermelho é exatamente o que ninguém provou: sem gateway e sem carimbo.
 *
 * Só leitura + carimbo — nada aqui mexe em estoque, envio ou caixa.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { AlertTriangle, Check, Loader2, ShieldCheck, X } from 'lucide-react';

type Row = {
  orderId: string;
  numero: string;
  wcOrderId: number;
  criadoEm: string | null;
  status: string;
  loja: { code: string | null; name: string };
  cliente: { nome: string | null; telefone: string | null };
  total: number | string;
  fechadoComo: string[];
  prova: boolean;
  conferida: { em: string; por: string | null } | null;
  entrega: string | null;
  rastreio: { codigo: string; transportadora: string } | null;
  quemFechou: string | null;
  enviadoSemSeparacao: boolean;
  separacao: string[];
};

type Resumo = {
  total: number;
  comProva: number;
  semProva: number;
  semProvaValor: number;
  pendentes: number;
  pendentesValor: number;
};

const brl = (n: number | string) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dataHora = (d: string | null) =>
  d
    ? new Date(d).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : '—';

/**
 * O status do pedido no idioma da operação — os mesmos nomes que a fila da
 * loja usa, pra matriz não precisar traduzir de cabeça.
 */
const SITUACAO: Record<string, { label: string; cor: string }> = {
  processing: { label: 'NA MATRIZ', cor: 'text-slate-600' },
  separating: { label: 'SEPARANDO', cor: 'text-amber-700' },
  shipped: { label: 'ENVIADO', cor: 'text-sky-700' },
  delivered: { label: 'ENTREGUE', cor: 'text-emerald-700' },
  cancelled: { label: 'CANCELADO', cor: 'text-slate-400 line-through' },
};

/**
 * "Fechado como" diz QUEM garantiu o dinheiro: âmbar = a palavra da vendedora
 * (nenhum gateway conferiu), verde = o gateway confirma sozinho. É a coluna
 * que explica por que a linha está vermelha.
 */
const BADGE_MANUAL = new Set(['PIX recebido', 'Link externo']);
const BADGE_GATEWAY = new Set(['Link Pagar.me', 'PIX gerado']);

type Chip = 'todos' | 'sem-prova' | 'pendentes';

export default function ConferenciaVendasPage() {
  // Default: últimos 7 dias — o recorte que cobre a semana de trabalho da
  // conferência sem afogar a tela com histórico.
  const hoje = new Date();
  const seteAtras = new Date(hoje);
  seteAtras.setDate(seteAtras.getDate() - 6);

  const [de, setDe] = useState(iso(seteAtras));
  const [ate, setAte] = useState(iso(hoje));
  const [chip, setChip] = useState<Chip>('todos');

  const [rows, setRows] = useState<Row[]>([]);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  /** orderId da linha cujo carimbo está indo pro servidor (loading no botão). */
  const [carimbando, setCarimbando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const q = new URLSearchParams();
      if (de) q.set('de', de);
      if (ate) q.set('ate', ate);
      const r = await api<{ rows: Row[]; resumo: Resumo }>(
        `/pdv/conferencia-vendas?${q.toString()}`,
      );
      setRows(r?.rows || []);
      setResumo(r?.resumo || null);
    } catch (e: unknown) {
      setErro((e as Error)?.message?.replace(/^\d+:\s*/, '') || 'Não consegui carregar');
    } finally {
      setCarregando(false);
    }
  }, [de, ate]);

  useEffect(() => { void carregar(); }, [carregar]);

  /** Atalhos de período — convenção da casa: De/Até + Hoje/Ontem/7 dias/Mês. */
  const atalho = (tipo: 'hoje' | 'ontem' | '7d' | 'mes') => {
    const h = new Date();
    if (tipo === 'hoje') { setDe(iso(h)); setAte(iso(h)); return; }
    if (tipo === 'ontem') {
      const o = new Date(h); o.setDate(o.getDate() - 1);
      setDe(iso(o)); setAte(iso(o)); return;
    }
    if (tipo === '7d') {
      const i = new Date(h); i.setDate(i.getDate() - 6);
      setDe(iso(i)); setAte(iso(h)); return;
    }
    setDe(iso(new Date(h.getFullYear(), h.getMonth(), 1))); setAte(iso(h));
  };

  /**
   * O carimbo NÃO é otimista de propósito: conferência que aparece na tela sem
   * ter chegado no servidor é pior que nenhuma — recarrega a lista depois do
   * sucesso e o que a matriz vê é o que está gravado.
   */
  const carimbar = useCallback(async (orderId: string, desfazer: boolean) => {
    setCarimbando(orderId);
    try {
      await api(`/pdv/conferencia-vendas/${orderId}/conferir`, {
        method: 'POST',
        body: JSON.stringify(desfazer ? { desfazer: true } : {}),
      });
      await carregar();
    } catch (e: unknown) {
      alert(
        (e as Error)?.message?.replace(/^\d+:\s*/, '') ||
          'Não consegui gravar a conferência. Tente de novo.',
      );
    } finally {
      setCarimbando(null);
    }
  }, [carregar]);

  const visiveis = useMemo(() => {
    if (chip === 'sem-prova') return rows.filter((r) => !r.prova);
    if (chip === 'pendentes') return rows.filter((r) => !r.prova && !r.conferida);
    return rows;
  }, [rows, chip]);

  const th = 'px-3 py-2 text-left text-[11px] font-bold uppercase text-slate-500 whitespace-nowrap';
  const td = 'px-3 py-2 text-sm whitespace-nowrap';

  return (
    <div className="max-w-[1600px] mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-emerald-600" /> Conferência de vendas online
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          Cada pedido ON- com sua prova de pagamento. <b>PIX recebido</b> e <b>Link externo</b> são
          a palavra da vendedora — o dinheiro só vira prova quando a matriz olha o extrato e
          carimba aqui.
        </p>
      </div>

      {/* ── FILTRO DE PERÍODO ── */}
      <div className="bg-white rounded-lg shadow border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">De</label>
            <input type="date" value={de} onChange={(e) => setDe(e.target.value)}
              className="px-2 py-2 border rounded text-sm" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Até</label>
            <input type="date" value={ate} onChange={(e) => setAte(e.target.value)}
              className="px-2 py-2 border rounded text-sm" />
          </div>
          <div className="flex flex-wrap gap-1 pb-1">
            {([['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', '7 dias'], ['mes', 'Mês']] as const)
              .map(([k, rotulo]) => (
                <button key={k} type="button" onClick={() => atalho(k)}
                  className="px-2.5 py-1.5 rounded-full border text-xs hover:bg-slate-50">
                  {rotulo}
                </button>
              ))}
          </div>
        </div>
      </div>

      {/* ── RESUMO ── */}
      {resumo && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-lg border p-3">
            <p className="text-[10px] font-bold uppercase text-slate-400">Pedidos no período</p>
            <p className="text-xl font-black text-slate-800">{resumo.total}</p>
          </div>
          <div className="bg-white rounded-lg border p-3">
            <p className="text-[10px] font-bold uppercase text-slate-400">Com prova (gateway)</p>
            <p className="text-xl font-black text-emerald-700">{resumo.comProva}</p>
          </div>
          <div className="bg-white rounded-lg border border-rose-200 p-3">
            <p className="text-[10px] font-bold uppercase text-rose-500">Sem prova</p>
            <p className="text-xl font-black text-rose-700">
              {resumo.semProva}
              <span className="text-sm font-bold text-rose-500 ml-2">{brl(resumo.semProvaValor)}</span>
            </p>
          </div>
          <div className="bg-white rounded-lg border border-amber-200 p-3">
            <p className="text-[10px] font-bold uppercase text-amber-600">Pendentes de conferência</p>
            <p className="text-xl font-black text-amber-700">
              {resumo.pendentes}
              <span className="text-sm font-bold text-amber-600 ml-2">{brl(resumo.pendentesValor)}</span>
            </p>
          </div>
        </div>
      )}

      {/* ── CHIPS ── */}
      <div className="flex flex-wrap gap-1.5">
        {([
          ['todos', 'Todos'],
          ['sem-prova', 'Só sem prova'],
          ['pendentes', 'Sem prova e não conferidos'],
        ] as const).map(([k, rotulo]) => (
          <button key={k} type="button" onClick={() => setChip(k)}
            className={`px-3 py-1.5 rounded-full border text-xs font-bold ${
              chip === k
                ? 'bg-slate-800 border-slate-800 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-50'
            }`}>
            {rotulo}
          </button>
        ))}
      </div>

      {erro && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 font-semibold">
          {erro}
        </div>
      )}

      {/* ── TABELA ── */}
      <div className="bg-white rounded-lg shadow border overflow-x-auto">
        {carregando ? (
          <div className="p-12 text-center text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin mx-auto" />
          </div>
        ) : !visiveis.length ? (
          <div className="p-10 text-center text-slate-400 text-sm">
            Nenhum pedido {chip === 'todos' ? 'no período' : 'com esse filtro no período'}.
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-slate-50 border-b">
              <tr>
                <th className={th}>Pedido</th>
                <th className={th}>Data</th>
                <th className={th}>Loja</th>
                <th className={th}>Cliente</th>
                <th className={`${th} text-right`}>Valor</th>
                <th className={th}>Fechado como</th>
                <th className={th}>Prova</th>
                <th className={th}>Conferência</th>
                <th className={th}>Situação</th>
                <th className={th}>Envio</th>
                <th className={th}>Rastreio</th>
                <th className={th}>Quem fechou</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visiveis.map((r) => {
                const situacao = SITUACAO[r.status] || { label: r.status.toUpperCase(), cor: 'text-slate-600' };
                /* Vermelho = ninguém provou (sem gateway E sem carimbo).
                   Carimbada, a linha volta ao neutro: a pendência acabou. */
                const alerta = !r.prova && !r.conferida;
                return (
                  <tr key={r.orderId}
                    className={alerta ? 'bg-rose-50/70 hover:bg-rose-50' : 'hover:bg-slate-50'}>
                    <td className={td}>
                      <Link href={`/pedidos/wc/${r.wcOrderId}`}
                        className="font-mono font-bold text-violet-700 hover:underline">
                        {r.numero}
                      </Link>
                    </td>
                    <td className={`${td} text-slate-500 tabular-nums`}>{dataHora(r.criadoEm)}</td>
                    <td className={`${td} text-slate-700`}>{r.loja.name}</td>
                    <td className={td}>
                      <p className="font-medium text-slate-800">{r.cliente.nome || '—'}</p>
                      {r.cliente.telefone && (
                        <p className="text-[11px] text-slate-400 tabular-nums">{r.cliente.telefone}</p>
                      )}
                    </td>
                    <td className={`${td} text-right font-bold text-slate-800`}>{brl(r.total)}</td>
                    <td className={td}>
                      {r.fechadoComo.length ? (
                        <div className="flex flex-wrap gap-1">
                          {r.fechadoComo.map((f, i) => (
                            <span key={`${f}-${i}`}
                              className={`rounded border px-1.5 py-0.5 text-[11px] font-bold ${
                                BADGE_GATEWAY.has(f)
                                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                                  : BADGE_MANUAL.has(f)
                                    ? 'border-amber-300 bg-amber-50 text-amber-800'
                                    : 'border-slate-200 bg-slate-50 text-slate-500'
                              }`}>
                              {f}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className={td}>
                      {r.prova ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-bold text-xs">
                          <Check className="w-3.5 h-3.5" /> gateway pago
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-rose-700 font-bold text-xs">
                          <X className="w-3.5 h-3.5" /> sem prova
                        </span>
                      )}
                    </td>
                    <td className={td}>
                      {r.conferida ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-emerald-700 font-semibold">
                            ✓ por {r.conferida.por || 'matriz'} em {dataHora(r.conferida.em)}
                          </span>
                          {/* Desfazer é discreto de propósito: existe pro carimbo
                              errado, não pra virar rotina. */}
                          <button type="button" disabled={carimbando === r.orderId}
                            onClick={() => void carimbar(r.orderId, true)}
                            className="text-[11px] text-slate-400 underline hover:text-slate-600 disabled:opacity-40">
                            {carimbando === r.orderId ? '…' : 'desfazer'}
                          </button>
                        </div>
                      ) : !r.prova ? (
                        <button type="button" disabled={carimbando === r.orderId}
                          onClick={() => void carimbar(r.orderId, false)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
                          {carimbando === r.orderId
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Check className="w-3.5 h-3.5" />}
                          Conferir
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className={td}>
                      <span className={`text-xs font-bold ${situacao.cor}`}>{situacao.label}</span>
                      {/* O caso ON-000049: marcado ENVIADO na mão com o card de
                          separação ainda intocado. Isso é denúncia, não status. */}
                      {r.enviadoSemSeparacao && (
                        <span className="ml-1.5 inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">
                          <AlertTriangle className="w-3 h-3" /> ENVIADO SEM SEPARAÇÃO
                        </span>
                      )}
                    </td>
                    <td className={`${td} text-xs text-slate-600`}>{r.entrega || '—'}</td>
                    <td className={td}>
                      {r.rastreio ? (
                        <a
                          href={`https://rastreamento.correios.com.br/app/index.php?objeto=${r.rastreio.codigo}`}
                          target="_blank" rel="noreferrer"
                          className="font-mono text-xs text-sky-700 hover:underline"
                          title={r.rastreio.transportadora}>
                          {r.rastreio.codigo}
                        </a>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className={`${td} text-xs text-slate-600`}>{r.quemFechou || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
