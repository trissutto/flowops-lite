'use client';

/**
 * /retaguarda/campanhas — GASTO → RECEITA → ROAS por campanha (De/Até).
 *
 * Fonte: GET /orders/report/campanhas?from=YYYY-MM-DD&to=YYYY-MM-DD, que junta
 * quatro coisas casadas por `campaign.id`: gasto dos espelhos Meta/Google,
 * receita dos pedidos PAGOS, sessões do site e a venda ASSISTIDA (carrinho
 * largado que fechou pelo WhatsApp/PDV).
 *
 * Três regras que a tela existe pra respeitar:
 *
 *  1. **PEDIDO = PAGO.** Antes dizia "não cancelados" e somava cartão recusado
 *     e PIX nunca pago — 24,7% do total do site novo em 30 dias.
 *  2. **ROAS sem gasto casado é "—", nunca 0,00x.** Ausência de dado não é
 *     desempenho ruim, e confundir os dois desliga campanha lucrativa.
 *  3. **O que não casou aparece.** Buraco que a tela esconde vira decisão
 *     errada; por isso a faixa de reconciliação embaixo, com o motivo.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import {
  Megaphone, Calendar, Download, Loader2, TrendingUp, ShoppingBag,
  DollarSign, AlertTriangle, Users, Wallet, MessageCircle,
} from 'lucide-react';

type MotivoSemGasto = 'direto' | 'sem_id' | 'id_nao_casa' | null;

interface CampanhaRow {
  campanhaId: string | null;
  campanha: string;
  rede: string | null;
  comUtm: boolean;
  source: string | null;
  medium: string | null;
  origemPct: number;
  origensDistintas: number;

  pedidos: number;
  receita: number;
  ticketMedio: number;
  naoPagos: number;
  naoPagosReceita: number;
  /** Tentativa que não pagou mas a pessoa fechou depois, pelo atendimento. */
  recuperados: number;
  recuperadosValor: number;
  /** Pagou depois sem ninguém chamar — não é perda, mas não é mérito. */
  voltouSozinha: number;
  voltouSozinhaValor: number;
  cancelados: number;

  gasto: number | null;
  cliques: number | null;
  impressoes: number | null;
  roas: number | null;
  roasComAssistida: number | null;
  custoPorPedido: number | null;

  sessoes: number;
  conversao: number | null;
  conversaoSuspeita: boolean;

  pedidosOffline: number;
  receitaOffline: number;

  motivoSemGasto: MotivoSemGasto;
}

interface CampanhasReport {
  from: string;
  to: string;
  totalPedidos: number;
  totalReceita: number;
  totalNaoPagos: number;
  totalNaoPagosReceita: number;
  totalRecuperados?: number;
  totalRecuperadosValor?: number;
  totalVoltouSozinha?: number;
  totalVoltouSozinhaValor?: number;
  totalCancelados: number;
  ticketMedioGeral: number;
  totalGasto?: number;
  totalReceitaOffline?: number;
  totalPedidosOffline?: number;
  roas: number | null;
  roasComAssistida: number | null;
  totalSessoes?: number;
  conversaoGeral: number | null;
  reconciliacao?: {
    receitaSemGasto: number;
    linhasSemGasto: number;
    gastoSemReceita: number;
    linhasGastoSemReceita: number;
    semId: number;
    idNaoCasa: number;
  };
  campanhas: CampanhaRow[];
}

/**
 * ⚠️ Todo formatador aceita `undefined`.
 *
 * O Vercel publica em segundos e o Railway leva minutos — em TODO deploy existe
 * uma janela em que esta tela (nova) conversa com a API (velha), que não manda
 * `gasto`/`roas`/`sessoes`. Com `v.toLocaleString` cru isso vira TypeError no
 * meio do render e a tela inteira some, em vez de mostrar o que já tem.
 */
function fmtMoney(v: number | null | undefined) {
  return v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtInt(v: number | null | undefined) {
  return v == null ? '—' : v.toLocaleString('pt-BR');
}
function fmtRoas(v: number | null | undefined) {
  return v == null ? '—' : `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x`;
}
function fmtPct(v: number | null | undefined) {
  return v == null ? '—' : `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}
function todayIso() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

/** Verde só quando o anúncio se paga. 1x é empate, não vitória. */
function corRoas(v: number | null) {
  if (v == null) return 'text-slate-400';
  if (v >= 2) return 'text-emerald-700 font-semibold';
  if (v >= 1) return 'text-amber-700';
  return 'text-rose-700 font-semibold';
}

const MOTIVO_TEXTO: Record<Exclude<MotivoSemGasto, null>, { curto: string; longo: string }> = {
  direto: {
    curto: 'sem anúncio',
    longo: 'Tráfego direto, orgânico ou indicação — não tem gasto porque não teve anúncio. É receita de graça.',
  },
  sem_id: {
    curto: 'anúncio não manda o id',
    longo: 'O pedido chegou sem utm_id, então não existe a que gasto ligar. Era o caso de TODO o Google até 24/08 (corrigido no final_url_suffix da conta — vale só pra clique novo).',
  },
  id_nao_casa: {
    curto: 'id de conjunto, não de campanha',
    longo: 'O anúncio manda {{adset.id}} no lugar de {{campaign.id}} — o id chega mas não existe no espelho de gasto. Conserto no Gerenciador do Meta: Editar → Rastreamento → Parâmetros de URL.',
  },
};

const REDES = [
  { id: 'todas', rotulo: 'Todas' },
  { id: 'meta', rotulo: 'Meta' },
  { id: 'google', rotulo: 'Google' },
  { id: 'direto', rotulo: 'Direto / orgânico' },
] as const;

export default function CampanhasPage() {
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [data, setData] = useState<CampanhasReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rede, setRede] = useState<string>('todas');

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  async function carregar(e?: React.FormEvent) {
    e?.preventDefault();
    if (!from || !to) {
      setError('Escolhe o período (de / até) antes de gerar.');
      return;
    }
    if (from > to) {
      setError('Data inicial não pode ser maior que a final.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ from, to });
      const res = await api<CampanhasReport>(`/orders/report/campanhas?${q}`);
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? 'Falha ao carregar');
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  function setAtalho(dias: number) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (dias - 1));
    const fmt = (d: Date) => {
      const o = d.getTimezoneOffset() * 60000;
      return new Date(d.getTime() - o).toISOString().slice(0, 10);
    };
    setFrom(fmt(start));
    setTo(fmt(end));
  }

  function setMesAtual() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const fmt = (d: Date) => {
      const o = d.getTimezoneOffset() * 60000;
      return new Date(d.getTime() - o).toISOString().slice(0, 10);
    };
    setFrom(fmt(start));
    setTo(fmt(now));
  }

  function exportCSV() {
    if (!data) return;
    const lines: string[] = [];
    lines.push(`Campanhas — ${data.from} até ${data.to}`);
    lines.push('');
    lines.push([
      'Campanha', 'Rede', 'Origem', 'Gasto', 'Receita paga', 'ROAS',
      'Receita assistida', 'ROAS c/ assistida', 'Pedidos pagos', 'Ticket medio',
      'Sessoes', 'Conversao %', 'Recuperados (atendimento)', 'Valor recuperado', 'Voltou sozinha', 'Valor voltou sozinha', 'Nao pagos', 'Valor nao pago', 'Cancelados', 'Motivo sem gasto',
    ].join(';'));
    // Aceita undefined: a API velha não manda gasto/ROAS/sessões.
    const v = (x: number | null | undefined) => (x == null ? '' : x.toFixed(2).replace('.', ','));
    for (const c of data.campanhas) {
      lines.push([
        c.campanha, c.rede ?? '', c.source ?? '',
        v(c.gasto), v(c.receita), v(c.roas),
        v(c.receitaOffline), v(c.roasComAssistida),
        c.pedidos, v(c.ticketMedio),
        c.sessoes, v(c.conversao),
        c.recuperados, v(c.recuperadosValor),
        c.voltouSozinha, v(c.voltouSozinhaValor),
        c.naoPagos, v(c.naoPagosReceita), c.cancelados,
        c.motivoSemGasto ? MOTIVO_TEXTO[c.motivoSemGasto].curto : '',
      ].join(';'));
    }
    lines.push('');
    lines.push(`TOTAL;;;${v(data.totalGasto)};${v(data.totalReceita)};${v(data.roas)};${v(data.totalReceitaOffline)};${v(data.roasComAssistida)};${data.totalPedidos};${v(data.ticketMedioGeral)};${data.totalSessoes};${v(data.conversaoGeral)};${data.totalRecuperados};${v(data.totalRecuperadosValor)};${data.totalVoltouSozinha};${v(data.totalVoltouSozinhaValor)};${data.totalNaoPagos};${v(data.totalNaoPagosReceita)};${data.totalCancelados};`);
    const csv = lines.join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `campanhas_${data.from}_a_${data.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const linhas = useMemo(() => {
    if (!data) return [];
    if (rede === 'todas') return data.campanhas;
    if (rede === 'direto') return data.campanhas.filter((c) => c.rede === 'direto' || c.rede === 'outro' || !c.rede);
    return data.campanhas.filter((c) => c.rede === rede);
  }, [data, rede]);

  const maxBarra = useMemo(
    () => Math.max(...linhas.map((c) => Math.max(c.receita, c.gasto ?? 0)), 1),
    [linhas],
  );

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Megaphone className="w-6 h-6" /> Campanhas — gasto, receita e ROAS
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Dinheiro que saiu contra dinheiro que entrou, casados pelo <b>id da campanha</b>.
          Receita é pedido <b>pago</b> — não o número modelado do Gerenciador.
        </p>
      </div>

      {/* Seletor de período */}
      <form
        onSubmit={carregar}
        className="bg-white rounded-lg shadow border p-4 mb-4 flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="block text-xs text-slate-500 mb-1">De</label>
          <input
            type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            max={todayIso()} className="px-3 py-2 border rounded text-sm" required
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Até</label>
          <input
            type="date" value={to} onChange={(e) => setTo(e.target.value)}
            max={todayIso()} className="px-3 py-2 border rounded text-sm" required
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <button type="button" onClick={() => setAtalho(1)} className="px-3 py-2 text-xs text-slate-600 border rounded hover:bg-slate-50">Hoje</button>
          <button type="button" onClick={() => setAtalho(2)} className="px-3 py-2 text-xs text-slate-600 border rounded hover:bg-slate-50">Ontem+Hoje</button>
          <button type="button" onClick={() => setAtalho(7)} className="px-3 py-2 text-xs text-slate-600 border rounded hover:bg-slate-50">7 dias</button>
          <button type="button" onClick={setMesAtual} className="px-3 py-2 text-xs text-slate-600 border rounded hover:bg-slate-50">Mês</button>
        </div>
        <button
          type="submit" disabled={loading || !from || !to}
          className="px-4 py-2 bg-brand text-white rounded hover:bg-brand-dark text-sm font-semibold disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calendar className="w-4 h-4" />}
          Gerar
        </button>
        {data && (
          <button
            type="button" onClick={exportCSV}
            className="px-3 py-2 bg-white border rounded text-sm hover:bg-slate-50 flex items-center gap-2 ml-auto"
          >
            <Download className="w-4 h-4" /> CSV
          </button>
        )}
      </form>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}

      {/* A API velha não tem `totalGasto`. Dizer isso é melhor que mostrar a
          tela pela metade e deixar o dono achar que o ROAS não foi feito. */}
      {data && data.totalGasto == null && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <b>O servidor ainda está subindo a versão nova.</b> Gasto, ROAS, conversão e
          recuperação vão aparecer assim que ele terminar (leva alguns minutos depois
          do deploy). A receita abaixo já está certa — recarregue a página em seguida.
        </div>
      )}

      {data && (
        <>
          {/* ── A LINHA DO DINHEIRO ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <div className="bg-white rounded-lg shadow border p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs"><Wallet className="w-4 h-4" /> Gasto em anúncio</div>
              <div className="text-2xl font-bold mt-1 text-slate-800">{fmtMoney(data.totalGasto)}</div>
              <div className="text-[11px] text-slate-400 mt-1">só as contas de ecomm</div>
            </div>
            <div className="bg-white rounded-lg shadow border p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs"><DollarSign className="w-4 h-4" /> Receita recebida</div>
              <div className="text-2xl font-bold mt-1 text-emerald-700">{fmtMoney(data.totalReceita)}</div>
              <div className="text-[11px] text-slate-400 mt-1">{fmtInt(data.totalPedidos)} pedidos pagos · com frete</div>
            </div>
            <div className="bg-white rounded-lg shadow border p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs"><TrendingUp className="w-4 h-4" /> ROAS</div>
              <div className={`text-2xl font-bold mt-1 ${corRoas(data.roas)}`}>{fmtRoas(data.roas)}</div>
              <div className="text-[11px] text-slate-400 mt-1">
                {(data.totalReceitaOffline ?? 0) > 0
                  ? `${fmtRoas(data.roasComAssistida)} contando a venda assistida`
                  : 'receita paga ÷ gasto'}
              </div>
            </div>
            <div className="bg-white rounded-lg shadow border p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs"><Users className="w-4 h-4" /> Conversão</div>
              <div className="text-2xl font-bold mt-1">{fmtPct(data.conversaoGeral)}</div>
              <div className="text-[11px] text-slate-400 mt-1">{fmtInt(data.totalSessoes)} sessões de anúncio</div>
            </div>
          </div>

          {/* ── O QUE SAIU DO TOTAL ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <div className={`rounded-lg shadow border p-4 ${data.totalNaoPagos > 0 ? 'bg-amber-50 border-amber-300' : 'bg-white'}`}>
              <div className="flex items-center gap-2 text-slate-600 text-xs font-semibold">
                <AlertTriangle className={`w-4 h-4 ${data.totalNaoPagos > 0 ? 'text-amber-600' : ''}`} /> Não pagos (fora do total)
              </div>
              <div className="mt-1 text-sm">
                <b className={data.totalNaoPagos > 0 ? 'text-amber-800' : 'text-slate-400'}>
                  {fmtInt(data.totalNaoPagos)} pedidos · {fmtMoney(data.totalNaoPagosReceita)}
                </b>
                <span className="text-slate-500"> — cartão recusado, PIX vencido ou link não aberto.</span>
                {/* Sem esta linha, tentativa que o atendimento salvou continuava
                    contando como perda e a campanha levava a culpa. */}
                {(data.totalRecuperados ?? 0) > 0 && (
                  <span className="text-slate-500">
                    {' '}<b className="text-emerald-700">{fmtInt(data.totalRecuperados)} ({fmtMoney(data.totalRecuperadosValor)})</b>{' '}
                    o time RECUPEROU: alguém assumiu na aba Carrinhos e a venda saiu.
                  </span>
                )}
                {/* Voltou sozinha ≠ recuperada. Contar junto daria ao time
                    crédito por venda que aconteceu sem ninguém chamar. */}
                {(data.totalVoltouSozinha ?? 0) > 0 && (
                  <span className="text-slate-500">
                    {' '}Outras <b>{fmtInt(data.totalVoltouSozinha)} ({fmtMoney(data.totalVoltouSozinhaValor)})</b>{' '}
                    a cliente voltou e pagou <b>sozinha</b>, sem ninguém chamar.
                  </span>
                )}
                {data.totalCancelados > 0 && (
                  <span className="text-slate-500"> Mais {fmtInt(data.totalCancelados)} cancelado(s).</span>
                )}
              </div>
            </div>
            <div className={`rounded-lg shadow border p-4 ${(data.totalReceitaOffline ?? 0) > 0 ? 'bg-violet-50 border-violet-300' : 'bg-white'}`}>
              <div className="flex items-center gap-2 text-slate-600 text-xs font-semibold">
                <MessageCircle className={`w-4 h-4 ${(data.totalReceitaOffline ?? 0) > 0 ? 'text-violet-600' : ''}`} /> Venda assistida (offline)
              </div>
              <div className="mt-1 text-sm">
                <b className={(data.totalReceitaOffline ?? 0) > 0 ? 'text-violet-800' : 'text-slate-400'}>
                  {fmtInt(data.totalPedidosOffline)} pedidos · {fmtMoney(data.totalReceitaOffline)}
                </b>
                <span className="text-slate-500">
                  {' '}— veio do anúncio, largou o carrinho e fechou pelo WhatsApp/PDV.
                  Só entra quem <b>não</b> trouxe a própria campanha, pra não contar duas vezes.
                </span>
              </div>
            </div>
          </div>

          {/* ── CASCATA: filtro por rede ── */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-xs text-slate-500">Rede:</span>
            {REDES.map((r) => {
              const n = r.id === 'todas'
                ? data.campanhas.length
                : r.id === 'direto'
                  ? data.campanhas.filter((c) => c.rede === 'direto' || c.rede === 'outro' || !c.rede).length
                  : data.campanhas.filter((c) => c.rede === r.id).length;
              return (
                <button
                  key={r.id} type="button" onClick={() => setRede(r.id)}
                  className={`px-3 py-1.5 text-xs rounded-full border transition ${
                    rede === r.id
                      ? 'bg-violet-600 text-white border-violet-600'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {r.rotulo} <span className="opacity-70">({n})</span>
                </button>
              );
            })}
          </div>

          {/* ── TABELA ── */}
          <div className="bg-white rounded-lg shadow border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 text-xs uppercase">
                    <th className="text-left px-4 py-2">Campanha</th>
                    <th className="text-right px-4 py-2">Gasto</th>
                    <th className="text-right px-4 py-2">Receita</th>
                    <th className="text-right px-4 py-2">ROAS</th>
                    <th className="text-right px-4 py-2">Assistida</th>
                    <th className="text-right px-4 py-2">Pedidos</th>
                    <th className="text-right px-4 py-2">Sessões</th>
                    <th className="text-right px-4 py-2">Conversão</th>
                    <th className="text-right px-4 py-2">Recuperado</th>
                    <th className="text-right px-4 py-2">Voltou só</th>
                    <th className="text-right px-4 py-2">Não pagos</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.length === 0 && (
                    <tr><td colSpan={11} className="px-4 py-6 text-center text-slate-400">Nenhuma campanha no período.</td></tr>
                  )}
                  {linhas.map((c, i) => (
                    // O índice entra na chave porque duas linhas podem partilhar
                    // rótulo (campanha sem id no espelho) — chave repetida faz o
                    // React reaproveitar a linha errada ao trocar de filtro.
                    <tr key={`${c.campanhaId ?? c.campanha}#${i}`} className="border-t hover:bg-slate-50 align-top">
                      <td className="px-4 py-2 min-w-[260px]">
                        <div className="flex items-start gap-2">
                          {c.comUtm ? (
                            <span className="inline-flex items-start gap-1 text-violet-700 font-semibold">
                              <Megaphone className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {c.campanha}
                            </span>
                          ) : (
                            <span className="text-slate-500">{c.campanha}</span>
                          )}
                          {c.rede && c.rede !== 'direto' && c.rede !== 'outro' && (
                            <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0">{c.rede}</span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {c.source ? `${c.source}${c.medium ? ` / ${c.medium}` : ''}` : '—'}
                          {/* O balde "Direto" junta origens diferentes. Sem este aviso a
                              linha parece dizer que TODOS vieram dali. */}
                          {c.origensDistintas > 1 && ` · ${c.origemPct}% · +${c.origensDistintas - 1} outra${c.origensDistintas > 2 ? 's' : ''}`}
                        </div>
                        {/* Barra: receita contra o maior valor da tela */}
                        <div className="mt-1 h-1.5 bg-slate-100 rounded overflow-hidden max-w-[240px]">
                          <div className="h-full bg-violet-400" style={{ width: `${Math.max(1, (c.receita / maxBarra) * 100)}%` }} />
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right text-slate-700 whitespace-nowrap">
                        {c.gasto == null ? <span className="text-slate-300">—</span> : fmtMoney(c.gasto)}
                        {c.custoPorPedido != null && (
                          <span className="block text-[11px] text-slate-400">{fmtMoney(c.custoPorPedido)}/pedido</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold text-emerald-700 whitespace-nowrap">{fmtMoney(c.receita)}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <span className={corRoas(c.roas)}>{fmtRoas(c.roas)}</span>
                        {/* Sem gasto casado NÃO é ROAS zero — a linha diz por quê. */}
                        {c.roas == null && c.motivoSemGasto && (
                          <span
                            className="block text-[11px] text-slate-400 max-w-[130px] ml-auto leading-tight"
                            title={MOTIVO_TEXTO[c.motivoSemGasto].longo}
                          >
                            {MOTIVO_TEXTO[c.motivoSemGasto].curto}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {c.receitaOffline > 0 ? (
                          <span className="text-violet-700" title={`${c.pedidosOffline} venda(s) recuperada(s) no WhatsApp/PDV`}>
                            {fmtMoney(c.receitaOffline)}
                            {c.roasComAssistida != null && (
                              <span className="block text-[11px] text-violet-500">→ {fmtRoas(c.roasComAssistida)}</span>
                            )}
                          </span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {fmtInt(c.pedidos)}
                        {c.pedidos > 0 && <span className="block text-[11px] text-slate-400">{fmtMoney(c.ticketMedio)}</span>}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-600">{c.sessoes > 0 ? fmtInt(c.sessoes) : <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <span className={c.conversaoSuspeita ? 'text-amber-700' : ''}>{fmtPct(c.conversao)}</span>
                        {c.conversaoSuspeita && (
                          <span
                            className="block text-[11px] text-amber-600 leading-tight"
                            title="Mais pedidos que sessões no período. Não é erro: a origem do pedido vale 30 dias de último clique, mas a sessão só conta dentro do período escolhido."
                          >
                            fora da janela
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {c.recuperados > 0 ? (
                          <span className="text-emerald-700" title={`${c.recuperados} tentativa(s) que não pagaram e a pessoa fechou depois — o atendimento salvou`}>
                            {fmtInt(c.recuperados)}
                            <span className="block text-[11px] text-emerald-600/80">{fmtMoney(c.recuperadosValor)}</span>
                          </span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {c.voltouSozinha > 0 ? (
                          <span className="text-slate-600" title="Pagou depois sem ninguém chamar — retentativa espontânea, não recuperação">
                            {fmtInt(c.voltouSozinha)}
                            <span className="block text-[11px] text-slate-400">{fmtMoney(c.voltouSozinhaValor)}</span>
                          </span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {c.naoPagos > 0 ? (
                          <span className="text-amber-700" title={`${fmtMoney(c.naoPagosReceita)} tentados e não pagos`}>
                            {fmtInt(c.naoPagos)}
                            <span className="block text-[11px] text-amber-600/80">{fmtMoney(c.naoPagosReceita)}</span>
                          </span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {linhas.length > 0 && rede === 'todas' && (
                  <tfoot>
                    <tr className="border-t-2 bg-slate-50 font-bold">
                      <td className="px-4 py-2">TOTAL</td>
                      <td className="px-4 py-2 text-right">{fmtMoney(data.totalGasto)}</td>
                      <td className="px-4 py-2 text-right text-emerald-700">{fmtMoney(data.totalReceita)}</td>
                      <td className={`px-4 py-2 text-right ${corRoas(data.roas)}`}>{fmtRoas(data.roas)}</td>
                      <td className="px-4 py-2 text-right text-violet-700">{fmtMoney(data.totalReceitaOffline)}</td>
                      <td className="px-4 py-2 text-right">{fmtInt(data.totalPedidos)}</td>
                      <td className="px-4 py-2 text-right">{fmtInt(data.totalSessoes)}</td>
                      <td className="px-4 py-2 text-right">{fmtPct(data.conversaoGeral)}</td>
                      <td className="px-4 py-2 text-right text-emerald-700">{(data.totalRecuperados ?? 0) > 0 ? fmtInt(data.totalRecuperados) : '—'}</td>
                      <td className="px-4 py-2 text-right text-slate-600">{(data.totalVoltouSozinha ?? 0) > 0 ? fmtInt(data.totalVoltouSozinha) : '—'}</td>
                      <td className="px-4 py-2 text-right text-amber-700">{data.totalNaoPagos > 0 ? fmtInt(data.totalNaoPagos) : '—'}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* ── RECONCILIAÇÃO: o que NÃO casou ──
              Fica embaixo da tabela de propósito. Enquanto isso não aparecia, o
              ROAS parecia pior do que é e ninguém descobria por quê. */}
          {data.reconciliacao && (data.reconciliacao.linhasSemGasto > 0 || data.reconciliacao.linhasGastoSemReceita > 0) && (
            <div className="mt-4 rounded-lg border border-slate-300 bg-slate-50 p-4 text-xs text-slate-600">
              <div className="font-semibold text-slate-700 mb-2 flex items-center gap-2">
                <ShoppingBag className="w-4 h-4" /> O que não casou neste período
              </div>
              <ul className="space-y-1">
                {data.reconciliacao.linhasSemGasto > 0 && (
                  <li>
                    <b>{fmtMoney(data.reconciliacao.receitaSemGasto)}</b> de receita em{' '}
                    {data.reconciliacao.linhasSemGasto} campanha(s) <b>sem gasto casado</b> — entra na receita, fica fora do ROAS.
                    {data.reconciliacao.semId > 0 && ` ${data.reconciliacao.semId} porque o anúncio não manda utm_id.`}
                    {data.reconciliacao.idNaoCasa > 0 && ` ${data.reconciliacao.idNaoCasa} porque manda id de conjunto no lugar do id de campanha.`}
                  </li>
                )}
                {data.reconciliacao.linhasGastoSemReceita > 0 && (
                  <li>
                    <b>{fmtMoney(data.reconciliacao.gastoSemReceita)}</b> de gasto em{' '}
                    {data.reconciliacao.linhasGastoSemReceita} campanha(s) <b>sem nenhum pedido pago</b> — pode ser campanha ruim,
                    ou pode ser a receita dela caindo numa linha sem id. Conferir antes de desligar.
                  </li>
                )}
              </ul>
              <div className="mt-2 pt-2 border-t border-slate-200 text-slate-500">
                O ROAS acima usa <b>só o que casou pelo id da campanha</b>. Gasto vem das contas de
                ecomm do Meta e do Google; a origem do pedido vale 30 dias de último clique.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
