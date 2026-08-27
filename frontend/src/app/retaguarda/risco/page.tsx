'use client';

/**
 * /retaguarda/risco — 🛡️ CENTRAL DE RISCO.
 *
 * Reúne os itens 11 (fila de análise), 19 (painel) e 20 (relatórios) do
 * documento, mais o cadastro de chargeback e a régua do score.
 *
 * DUAS DECISÕES DE TELA QUE VALE EXPLICAR:
 *
 * 1. A FILA É A ABA DE ENTRADA, não o painel de números. Painel bonito com
 *    fila escondida atrás vira relatório que ninguém age em cima — o dono já
 *    disse isso pra /minha-loja ("tarefa clicável > menu") e vale igual aqui.
 *
 * 2. RECORTE DE TEMPO É DE/ATÉ com atalhos, nunca dropdown de período fixo —
 *    convenção da casa.
 *
 * ⚠️ Nada nesta tela bloqueia pedido. "Suspeito" é carimbo de análise; o
 * pedido continua no fluxo normal de separação e envio.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, API_URL, getAuthToken } from '@/lib/api';
import {
  ArrowLeft,
  ShieldAlert,
  Loader2,
  Download,
  Plus,
  RefreshCw,
  Trash2,
  Database,
} from 'lucide-react';

type Aba = 'fila' | 'painel' | 'chargebacks' | 'regua';

interface LinhaFila {
  orderId: string;
  /** Id numérico — é ele que abre `/pedidos/wc/[id]`. */
  wcOrderId: number | null;
  numero: string;
  cliente: string | null;
  cpf: string | null;
  telefone: string | null;
  data: string | null;
  valor: number | null;
  loja: string | null;
  score: number;
  nivel: 'baixo' | 'moderado' | 'alto' | 'critico';
  motivos: string[];
  chargebacksRelacionados: number;
  chargebackNoPedido: boolean;
  status: string;
  responsavel: string | null;
}

const CORES: Record<string, string> = {
  baixo: 'bg-emerald-100 text-emerald-800',
  moderado: 'bg-amber-100 text-amber-900',
  alto: 'bg-orange-100 text-orange-900',
  critico: 'bg-red-100 text-red-900',
};

const STATUS_CB = ['em_analise', 'contestado', 'ganho', 'perdido', 'encerrado'];

/** Hoje / Ontem / 7 dias / Mês — os atalhos padrão da casa. */
function atalho(qual: 'hoje' | 'ontem' | '7' | 'mes'): { de: string; ate: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const hoje = new Date();
  if (qual === 'hoje') return { de: iso(hoje), ate: iso(hoje) };
  if (qual === 'ontem') {
    const o = new Date(hoje.getTime() - 86400000);
    return { de: iso(o), ate: iso(o) };
  }
  if (qual === '7') return { de: iso(new Date(hoje.getTime() - 6 * 86400000)), ate: iso(hoje) };
  return { de: iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), ate: iso(hoje) };
}

export default function CentralDeRiscoPage() {
  const [aba, setAba] = useState<Aba>('fila');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-4 flex items-center gap-3">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <ShieldAlert className="h-6 w-6 text-red-600" />
          <h1 className="text-xl font-black text-slate-800">CENTRAL DE RISCO</h1>
        </div>

        <p className="mb-4 max-w-3xl text-sm text-slate-500">
          Relações entre pedidos e histórico de contestação. O sistema{' '}
          <strong>não decide nada sozinho</strong>: ele mostra o motivo e a decisão é humana.
          Marcar um pedido como suspeito aqui <strong>não bloqueia o pedido</strong> — ele segue no
          fluxo normal de separação e envio.
        </p>

        {erro && (
          <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800">
            {erro.replace(/^\d+:\s*/, '')}
          </div>
        )}

        {/* Recorte de tempo — De/Até + atalhos */}
        <div className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3">
          <label className="text-xs font-semibold text-slate-500">
            De
            <input
              type="date"
              value={de}
              onChange={(e) => setDe(e.target.value)}
              className="mt-0.5 block rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs font-semibold text-slate-500">
            Até
            <input
              type="date"
              value={ate}
              onChange={(e) => setAte(e.target.value)}
              className="mt-0.5 block rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          {(['hoje', 'ontem', '7', 'mes'] as const).map((k) => (
            <button
              key={k}
              onClick={() => {
                const r = atalho(k);
                setDe(r.de);
                setAte(r.ate);
              }}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              {k === 'hoje' ? 'Hoje' : k === 'ontem' ? 'Ontem' : k === '7' ? '7 dias' : 'Mês'}
            </button>
          ))}
          {(de || ate) && (
            <button
              onClick={() => {
                setDe('');
                setAte('');
              }}
              className="text-xs text-slate-500 underline"
            >
              limpar
            </button>
          )}
        </div>

        <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
          {(
            [
              ['fila', '🛑 Aguardando análise'],
              ['painel', '📊 Painel'],
              ['chargebacks', '💳 Chargebacks'],
              ['regua', '⚖️ Régua do score'],
            ] as Array<[Aba, string]>
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setAba(v)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${
                aba === v
                  ? 'border-red-600 text-red-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {aba === 'fila' && <AbaFila de={de} ate={ate} onErro={setErro} />}
        {aba === 'painel' && <AbaPainel de={de} ate={ate} onErro={setErro} />}
        {aba === 'chargebacks' && <AbaChargebacks de={de} ate={ate} onErro={setErro} />}
        {aba === 'regua' && <AbaRegua onErro={setErro} />}
      </div>
    </div>
  );
}

/* ═══════════════════════ FILA (item 11) ═══════════════════════ */

function AbaFila({
  de,
  ate,
  onErro,
}: {
  de: string;
  ate: string;
  onErro: (e: string | null) => void;
}) {
  const [linhas, setLinhas] = useState<LinhaFila[]>([]);
  const [carregando, setCarregando] = useState(true);
  /**
   * FALHOU ≠ VAZIO.
   *
   * Sem esta flag, backend fora do ar mostrava o erro lá em cima E o
   * "Nenhum pedido aguardando análise 🎉" aqui embaixo — as duas coisas na
   * mesma tela. Quem bate o olho lê o 🎉 e vai embora tranquilo, com a fila
   * de fraude possivelmente cheia do outro lado. Fila de risco que erra pro
   * lado do "está tudo bem" é pior do que não existir.
   */
  const [falhou, setFalhou] = useState(false);
  const [nivel, setNivel] = useState('');
  const [status, setStatus] = useState('');
  const [comCb, setComCb] = useState(false);
  const [busca, setBusca] = useState({ cpf: '', telefone: '', email: '', endereco: '' });

  const carregar = useCallback(async () => {
    setCarregando(true);
    onErro(null);
    try {
      const q = new URLSearchParams();
      if (nivel) q.set('nivel', nivel);
      if (status) q.set('status', status);
      if (de) q.set('de', de);
      if (ate) q.set('ate', ate);
      if (comCb) q.set('comChargeback', 'sim');
      for (const [k, v] of Object.entries(busca)) if (v.trim()) q.set(k, v.trim());
      const r = await api<{ pedidos: LinhaFila[] }>(`/admin/risco/fila?${q}`);
      setLinhas(r.pedidos || []);
      setFalhou(false);
    } catch (e: any) {
      setFalhou(true);
      setLinhas([]);
      onErro(e?.message || 'Falha ao carregar a fila.');
    } finally {
      setCarregando(false);
    }
  }, [nivel, status, de, ate, comCb, busca, onErro]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <select
          value={nivel}
          onChange={(e) => setNivel(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        >
          <option value="">Alto e crítico</option>
          <option value="critico">Só crítico</option>
          <option value="alto">Só alto</option>
          <option value="moderado">Só moderado</option>
          <option value="todos">Todos os níveis</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        >
          <option value="">Qualquer situação</option>
          <option value="aguardando">Aguardando análise</option>
          <option value="em_analise">Em análise</option>
          <option value="liberado">Liberado</option>
          <option value="suspeito">Suspeito</option>
          <option value="revisar">Revisar depois</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={comCb} onChange={(e) => setComCb(e.target.checked)} />
          só com chargeback
        </label>
        {(['cpf', 'telefone', 'email', 'endereco'] as const).map((k) => (
          <input
            key={k}
            value={busca[k]}
            onChange={(e) => setBusca((b) => ({ ...b, [k]: e.target.value }))}
            placeholder={k === 'endereco' ? 'endereço' : k}
            className="w-32 rounded border border-slate-300 px-2 py-1 text-sm"
          />
        ))}
        <button
          onClick={() => void carregar()}
          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw className="h-3.5 w-3.5" /> atualizar
        </button>
        <BotaoCsv tipo="alto_risco" de={de} ate={ate} extra={{ nivel, status }} />
      </div>

      {carregando ? (
        <div className="flex items-center gap-2 py-8 text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> carregando…
        </div>
      ) : falhou ? (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-6 text-center text-sm text-red-800">
          Não deu pra carregar a fila — <strong>isto não quer dizer que não há
          pedido pra analisar</strong>. Tente atualizar.
        </div>
      ) : !linhas.length ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-6 text-center text-sm text-emerald-800">
          Nenhum pedido aguardando análise com esse filtro. 🎉
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Pedido</th>
                <th className="px-3 py-2 font-semibold">Data</th>
                <th className="px-3 py-2 font-semibold">Cliente</th>
                <th className="px-3 py-2 text-right font-semibold">Valor</th>
                <th className="px-3 py-2 text-center font-semibold">Score</th>
                <th className="px-3 py-2 font-semibold">Motivos</th>
                <th className="px-3 py-2 font-semibold">Situação</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.orderId} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2">
                    {/* Id NUMÉRICO: a rota do pedido não abre pelo "LP-000129". */}
                    {l.wcOrderId ? (
                      <Link
                        href={`/pedidos/wc/${l.wcOrderId}`}
                        className="font-semibold text-blue-700 hover:underline"
                      >
                        {l.numero}
                      </Link>
                    ) : (
                      <span className="font-semibold text-slate-700">{l.numero}</span>
                    )}
                    {l.chargebackNoPedido && (
                      <span className="ml-1 rounded bg-red-600 px-1 text-[10px] font-bold text-white">
                        CB
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {l.data ? new Date(l.data).toLocaleDateString('pt-BR') : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-slate-800">{l.cliente || '—'}</div>
                    <div className="text-xs text-slate-400">{l.telefone || l.cpf || ''}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                    {l.valor != null
                      ? l.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${CORES[l.nivel]}`}>
                      {l.score}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {l.motivos.slice(0, 2).join(' · ')}
                    {l.motivos.length > 2 && ` · +${l.motivos.length - 2}`}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div className="text-slate-700">{l.status.replace('_', ' ')}</div>
                    {l.responsavel && <div className="text-slate-400">{l.responsavel}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════ PAINEL (item 19) ═══════════════════════ */

function AbaPainel({
  de,
  ate,
  onErro,
}: {
  de: string;
  ate: string;
  onErro: (e: string | null) => void;
}) {
  const [d, setD] = useState<any>(null);
  const [st, setSt] = useState<any>(null);
  const [carregando, setCarregando] = useState(true);
  const [backfill, setBackfill] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    onErro(null);
    try {
      const q = new URLSearchParams();
      if (de) q.set('de', de);
      if (ate) q.set('ate', ate);
      const [dash, status] = await Promise.all([
        api<any>(`/admin/risco/dashboard?${q}`),
        api<any>('/admin/risco/status'),
      ]);
      setD(dash);
      setSt(status);
    } catch (e: any) {
      onErro(e?.message || 'Falha ao carregar o painel.');
    } finally {
      setCarregando(false);
    }
  }, [de, ate, onErro]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const rodarBackfill = async () => {
    setBackfill(true);
    try {
      const r = await api<any>('/admin/risco/backfill', {
        method: 'POST',
        body: JSON.stringify({ lote: 500, ciclos: 10 }),
      });
      alert(
        `Backfill: ${r.processados} pedidos processados, ${r.chaves} chaves geradas. ` +
          `Faltam ${r.restantes} — rode de novo se ainda houver.`,
      );
      await carregar();
    } catch (e: any) {
      onErro(e?.message || 'Falha no backfill.');
    } finally {
      setBackfill(false);
    }
  };

  if (carregando || !d) {
    return (
      <div className="flex items-center gap-2 py-8 text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> carregando…
      </div>
    );
  }

  const cb = d.chargebacks || {};
  const reais = (n: number) =>
    Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  return (
    <div className="space-y-4">
      {/* Termômetro do backfill — sem isto ninguém sabe se o módulo enxerga a
          base inteira ou só um pedaço dela. */}
      {st && st.pedidosSemChave > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <Database className="h-4 w-4 shrink-0" />
          <span>
            <strong>{st.pedidosSemChave.toLocaleString('pt-BR')} pedidos</strong> ainda não entraram
            no cruzamento. Até rodar, o módulo enxerga só parte da base.
          </span>
          <button
            onClick={rodarBackfill}
            disabled={backfill}
            className="ml-auto rounded bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {backfill ? 'processando…' : 'processar agora'}
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card titulo="Pedidos analisados" valor={d.analisados} />
        <Card titulo="Alto risco" valor={d.altos} cor="text-orange-700" />
        <Card titulo="Crítico" valor={d.criticos} cor="text-red-700" />
        <Card titulo="Aguardando análise" valor={d.aguardando} cor="text-amber-700" />
        <Card titulo="Chargebacks" valor={cb.total || 0} cor="text-red-700" />
        <Card titulo="Em disputa" valor={reais(cb.emDisputa)} />
        <Card titulo="Valor recuperado" valor={reais(cb.valorRecuperado)} cor="text-emerald-700" />
        <Card titulo="Valor perdido" valor={reais(cb.valorPerdido)} cor="text-red-700" />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 text-sm font-bold text-slate-700">Principais fatores de risco</div>
        {!d.fatores?.length ? (
          <div className="text-sm text-slate-500">Nenhum alerta pontuado no período.</div>
        ) : (
          <ul className="space-y-1">
            {d.fatores.map((f: any) => (
              <li key={f.chave} className="flex items-center gap-2 text-sm">
                <span className="flex-1 text-slate-700">{f.texto}</span>
                <span className="tabular-nums font-semibold text-slate-500">{f.vezes}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <BotaoCsv tipo="alto_risco" de={de} ate={ate} rotulo="Pedidos de alto risco" />
        <BotaoCsv tipo="suspeitos" de={de} ate={ate} rotulo="Marcados como suspeitos" />
        <BotaoCsv tipo="liberados" de={de} ate={ate} rotulo="Liberados na análise" />
        <BotaoCsv tipo="chargebacks" de={de} ate={ate} rotulo="Chargebacks" />
      </div>
    </div>
  );
}

function Card({ titulo, valor, cor = 'text-slate-800' }: { titulo: string; valor: any; cor?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-xs text-slate-500">{titulo}</div>
      <div className={`mt-0.5 text-xl font-black ${cor}`}>{valor}</div>
    </div>
  );
}

/* ═══════════════════════ CHARGEBACKS (item 2) ═══════════════════════ */

function AbaChargebacks({
  de,
  ate,
  onErro,
}: {
  de: string;
  ate: string;
  onErro: (e: string | null) => void;
}) {
  const [linhas, setLinhas] = useState<any[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [novo, setNovo] = useState(false);
  const [form, setForm] = useState({
    numeroPedido: '',
    valor: '',
    abertoEm: new Date().toISOString().slice(0, 10),
    status: 'em_analise',
    motivo: '',
    fraude: false,
    plataforma: 'pagarme',
    transacaoId: '',
    observacoes: '',
  });

  const carregar = useCallback(async () => {
    setCarregando(true);
    onErro(null);
    try {
      const q = new URLSearchParams();
      if (de) q.set('de', de);
      if (ate) q.set('ate', ate);
      const r = await api<{ chargebacks: any[] }>(`/admin/risco/chargebacks?${q}`);
      setLinhas(r.chargebacks || []);
    } catch (e: any) {
      onErro(e?.message || 'Falha ao carregar os chargebacks.');
    } finally {
      setCarregando(false);
    }
  }, [de, ate, onErro]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const salvar = async () => {
    try {
      await api('/admin/risco/chargebacks', {
        method: 'POST',
        body: JSON.stringify({ ...form, valor: Number(String(form.valor).replace(',', '.')) }),
      });
      setNovo(false);
      setForm({ ...form, numeroPedido: '', valor: '', motivo: '', transacaoId: '', observacoes: '' });
      await carregar();
    } catch (e: any) {
      onErro(e?.message || 'Falha ao registrar o chargeback.');
    }
  };

  const mudarStatus = async (id: string, status: string) => {
    try {
      await api(`/admin/risco/chargebacks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await carregar();
    } catch (e: any) {
      onErro(e?.message || 'Falha ao atualizar.');
    }
  };

  const remover = async (id: string) => {
    if (!window.confirm('Remover este chargeback? Os scores relacionados são recalculados.')) return;
    try {
      await api(`/admin/risco/chargebacks/${id}`, { method: 'DELETE' });
      await carregar();
    } catch (e: any) {
      onErro(e?.message || 'Falha ao remover.');
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={() => setNovo((v) => !v)}
          className="inline-flex items-center gap-1 rounded bg-slate-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-900"
        >
          <Plus className="h-4 w-4" /> registrar chargeback
        </button>
        <span className="text-xs text-slate-500">
          A Pagar.me registra sozinha pelo webhook. Este cadastro é pra contestação que chega por
          e-mail, carta ou pelo painel de outro adquirente.
        </span>
      </div>

      {novo && (
        <div className="mb-4 grid gap-2 rounded-lg border border-slate-200 bg-white p-4 md:grid-cols-3">
          <label className="text-xs font-semibold text-slate-500">
            Pedido (número)
            <input
              value={form.numeroPedido}
              onChange={(e) => setForm({ ...form, numeroPedido: e.target.value })}
              placeholder="LP-000129"
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs font-semibold text-slate-500">
            Valor contestado
            <input
              value={form.valor}
              onChange={(e) => setForm({ ...form, valor: e.target.value })}
              placeholder="827,29"
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs font-semibold text-slate-500">
            Aberto em
            <input
              type="date"
              value={form.abertoEm}
              onChange={(e) => setForm({ ...form, abertoEm: e.target.value })}
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs font-semibold text-slate-500">
            Situação
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            >
              {STATUS_CB.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-500">
            Motivo informado
            <input
              value={form.motivo}
              onChange={(e) => setForm({ ...form, motivo: e.target.value })}
              placeholder="produto não recebido"
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs font-semibold text-slate-500">
            ID da transação
            <input
              value={form.transacaoId}
              onChange={(e) => setForm({ ...form, transacaoId: e.target.value })}
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="col-span-full flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.fraude}
              onChange={(e) => setForm({ ...form, fraude: e.target.checked })}
            />
            O adquirente classificou como <strong>fraude</strong>
            <span className="text-xs text-slate-400">
              (marque só se a carta disser isso — &quot;não recebi&quot; é logística, e marcar errado
              distorce o score de quem divide endereço ou telefone)
            </span>
          </label>
          <label className="col-span-full text-xs font-semibold text-slate-500">
            Observações
            <textarea
              value={form.observacoes}
              onChange={(e) => setForm({ ...form, observacoes: e.target.value })}
              rows={2}
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <div className="col-span-full flex gap-2">
            <button
              onClick={salvar}
              className="rounded bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
            >
              registrar
            </button>
            <button onClick={() => setNovo(false)} className="text-sm text-slate-500 underline">
              cancelar
            </button>
          </div>
        </div>
      )}

      {carregando ? (
        <div className="flex items-center gap-2 py-8 text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> carregando…
        </div>
      ) : !linhas.length ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          Nenhum chargeback registrado no período.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Pedido</th>
                <th className="px-3 py-2 font-semibold">Cliente</th>
                <th className="px-3 py-2 font-semibold">Aberto</th>
                <th className="px-3 py-2 text-right font-semibold">Valor</th>
                <th className="px-3 py-2 font-semibold">Motivo</th>
                <th className="px-3 py-2 font-semibold">Situação</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {linhas.map((c) => (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    {c.order?.wcOrderId ? (
                      <Link
                        href={`/pedidos/wc/${c.order.wcOrderId}`}
                        className="font-semibold text-blue-700 hover:underline"
                      >
                        {c.order.wcOrderNumber}
                      </Link>
                    ) : (
                      <span className="text-slate-400">{c.order?.wcOrderNumber || '—'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{c.order?.customerName || '—'}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {new Date(c.abertoEm).toLocaleDateString('pt-BR')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                    {Number(c.valor || 0).toLocaleString('pt-BR', {
                      style: 'currency',
                      currency: 'BRL',
                    })}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {c.motivo || '—'}
                    {c.fraude && (
                      <span className="ml-1 rounded bg-red-100 px-1 text-[10px] font-bold text-red-800">
                        fraude
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={c.status}
                      onChange={(e) => mudarStatus(c.id, e.target.value)}
                      className="rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                    >
                      {STATUS_CB.map((s) => (
                        <option key={s} value={s}>
                          {s.replace('_', ' ')}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => remover(c.id)}
                      title="remover"
                      className="text-slate-400 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════ RÉGUA DO SCORE (item 4) ═══════════════════════ */

const CAMPOS_REGUA: Array<{ chave: string; label: string; ajuda?: string }> = [
  { chave: 'cbCpf', label: 'CPF relacionado a chargeback' },
  { chave: 'cbTelefone', label: 'Telefone relacionado a chargeback' },
  { chave: 'cbEndereco', label: 'Endereço relacionado a chargeback' },
  { chave: 'cbEmail', label: 'E-mail relacionado a chargeback' },
  { chave: 'cbCartao', label: 'Cartão relacionado a chargeback' },
  { chave: 'cbTitular', label: 'Titular do cartão relacionado a chargeback' },
  { chave: 'cbAparelho', label: 'Aparelho relacionado a chargeback', ajuda: 'Mesmo navegador — sinal mais estável que o IP.' },
  { chave: 'cbIp', label: 'IP relacionado a chargeback', ajuda: 'Pesa pouco: 4G e prédio compartilham IP.' },
  { chave: 'comboTelefoneEndereco', label: 'Telefone + endereço no mesmo chargeback', ajuda: 'Substitui os dois pesos individuais — não soma em cima.' },
  { chave: 'comboCadastroNovo', label: 'Cadastro novo no mesmo telefone/endereço' },
  { chave: 'reincidenciaBonus', label: 'Bônus por chargeback adicional (%)', ajuda: 'Dois chargebacks no mesmo dado pesam mais que um.' },
  { chave: 'multiCartoes', label: 'Múltiplos cartões no mesmo telefone/endereço' },
  { chave: 'multiCpfs', label: 'Múltiplos CPFs no mesmo telefone/endereço' },
  { chave: 'multiEmails', label: 'Múltiplos e-mails no mesmo telefone/endereço' },
  { chave: 'multiMinimo', label: 'A partir de quantos valores distintos alerta' },
  { chave: 'multiJanelaDias', label: 'Janela da multiplicidade (dias)' },
  { chave: 'faixaModerado', label: 'Score mínimo pra MODERADO' },
  { chave: 'faixaAlto', label: 'Score mínimo pra ALTO' },
  { chave: 'faixaCritico', label: 'Score mínimo pra CRÍTICO' },
  { chave: 'janelaDias', label: 'Quantos dias pra trás o cruzamento olha' },
];

function AbaRegua({ onErro }: { onErro: (e: string | null) => void }) {
  const [p, setP] = useState<any>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    api<any>('/admin/risco/pesos')
      .then(setP)
      .catch((e) => onErro(e?.message || 'Falha ao carregar a régua.'));
  }, [onErro]);

  const salvar = async () => {
    setSalvando(true);
    try {
      setP(await api<any>('/admin/risco/pesos', { method: 'POST', body: JSON.stringify(p) }));
    } catch (e: any) {
      onErro(e?.message || 'Falha ao salvar.');
    } finally {
      setSalvando(false);
    }
  };

  if (!p) {
    return (
      <div className="flex items-center gap-2 py-8 text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> carregando…
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <label className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
        <input
          type="checkbox"
          checked={p.ativo}
          onChange={(e) => setP({ ...p, ativo: e.target.checked })}
        />
        Módulo de risco ligado
      </label>
      <p className="mb-4 max-w-2xl text-xs text-slate-500">
        Estes números são os <strong>sugeridos no documento</strong>, não uma verdade medida — não
        há histórico de chargeback suficiente pra calibrar ainda. Ajuste conforme a operação for
        mostrando o que é alarme útil e o que é ruído. O score muda na próxima vez que o pedido for
        analisado.
      </p>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {CAMPOS_REGUA.map((c) => (
          <label key={c.chave} className="text-xs font-semibold text-slate-600">
            {c.label}
            <input
              type="number"
              value={p[c.chave] ?? 0}
              onChange={(e) => setP({ ...p, [c.chave]: Number(e.target.value) })}
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            />
            {c.ajuda && <span className="block font-normal text-slate-400">{c.ajuda}</span>}
          </label>
        ))}
      </div>
      <button
        onClick={salvar}
        disabled={salvando}
        className="mt-4 rounded bg-slate-800 px-4 py-2 text-sm font-bold text-white hover:bg-slate-900 disabled:opacity-50"
      >
        {salvando ? 'salvando…' : 'salvar régua'}
      </button>
    </div>
  );
}

/* ═══════════════════════ CSV (item 20) ═══════════════════════ */

function BotaoCsv({
  tipo,
  de,
  ate,
  rotulo,
  extra,
}: {
  tipo: string;
  de: string;
  ate: string;
  rotulo?: string;
  extra?: Record<string, string>;
}) {
  const [baixando, setBaixando] = useState(false);

  const baixar = async () => {
    setBaixando(true);
    try {
      const q = new URLSearchParams({ tipo, formato: 'csv' });
      if (de) q.set('de', de);
      if (ate) q.set('ate', ate);
      for (const [k, v] of Object.entries(extra || {})) if (v) q.set(k, v);
      const token = getAuthToken();
      // CSV binário: `fetch` cru com o token no header — o helper `api()` faz
      // `res.json()` e engasgaria no arquivo.
      const r = await fetch(`${API_URL}/api/admin/risco/relatorio?${q}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `risco-${tipo}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      alert(`Não consegui gerar o relatório: ${e?.message || e}`);
    } finally {
      setBaixando(false);
    }
  };

  return (
    <button
      onClick={baixar}
      disabled={baixando}
      className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
    >
      <Download className="h-3.5 w-3.5" /> {baixando ? 'gerando…' : rotulo || 'CSV'}
    </button>
  );
}
