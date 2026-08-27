'use client';

/**
 * 🛡️ ANÁLISE DE RISCO — o painel do item 8, dentro da tela do pedido.
 *
 * REGRAS DE TELA QUE VÊM DO DOCUMENTO:
 *
 *  · Nunca um nível sem MOTIVO (item 24). Se não houver motivo, não há painel
 *    colorido: aparece uma linha discreta dizendo que não há relação.
 *  · Nunca a palavra "fraude". O painel mostra RELAÇÃO e INDÍCIO.
 *  · A informação importante fica visível de cara (item 25); o técnico
 *    (chaves, relações sem ocorrência) fica atrás de um clique.
 *
 * E a regra que veio do dono em 27/08: **este painel não bloqueia pedido**.
 * "Marcar suspeito" carimba a ANÁLISE — o pedido segue o fluxo normal. Cancelar
 * continua sendo pelo botão de cancelamento do pedido, que sabe lidar com peça
 * já bipada. O texto do botão diz isso, pra ninguém clicar achando que travou.
 *
 * Fica FECHADO quando o risco é baixo: quem abre um pedido está separando peça,
 * não investigando ninguém — e um painel gritando em pedido normal é o caminho
 * mais curto pra todo mundo aprender a ignorar o painel.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, API_URL, getAuthToken } from '@/lib/api';
import {
  ShieldAlert,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  Loader2,
  FileText,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';

type Cor = 'vermelho' | 'laranja' | 'amarelo';
type Nivel = 'baixo' | 'moderado' | 'alto' | 'critico';

interface Motivo {
  chave: string;
  cor: Cor;
  texto: string;
  peso: number;
  pedidos: string[];
}

interface Relacionado {
  id: string;
  /** Id numérico — é ele que abre `/pedidos/wc/[id]`. */
  wcOrderId: number | null;
  numero: string;
  data: string | null;
  cliente: string | null;
  valor: number | null;
  relacao: string[];
  situacao: 'chargeback' | 'cancelado' | 'nao_pago' | 'pago';
  situacaoTexto: string;
}

interface Analise {
  ativo: boolean;
  orderId: string;
  numero: string | null;
  score: number;
  nivel: Nivel;
  resumo: string;
  motivos: Motivo[];
  relacionados: Relacionado[];
  chargebacksRelacionados: number;
  chaves: Array<{ tipo: string; rotulo: string }>;
  chavesIgnoradas: string[];
  status: string;
  responsavel: string | null;
  observacao: string | null;
}

const NIVEL: Record<Nivel, { rotulo: string; emoji: string; barra: string; texto: string; borda: string; fundo: string }> = {
  baixo:    { rotulo: 'BAIXO',    emoji: '🟢', barra: 'bg-emerald-500', texto: 'text-emerald-800', borda: 'border-emerald-300', fundo: 'bg-emerald-50' },
  moderado: { rotulo: 'MODERADO', emoji: '🟡', barra: 'bg-amber-400',   texto: 'text-amber-900',   borda: 'border-amber-300',   fundo: 'bg-amber-50' },
  alto:     { rotulo: 'ALTO',     emoji: '🟠', barra: 'bg-orange-500',  texto: 'text-orange-900',  borda: 'border-orange-300',  fundo: 'bg-orange-50' },
  critico:  { rotulo: 'CRÍTICO',  emoji: '🔴', barra: 'bg-red-600',     texto: 'text-red-900',     borda: 'border-red-400',     fundo: 'bg-red-50' },
};

const BOLINHA: Record<Cor, string> = { vermelho: '🔴', laranja: '🟠', amarelo: '🟡' };

const STATUS_ANALISE: Array<{ v: string; label: string; ajuda: string }> = [
  { v: 'em_analise', label: 'Em análise',           ajuda: 'Alguém está olhando este pedido agora.' },
  { v: 'liberado',   label: 'Liberado',             ajuda: 'Conferido — pode seguir normalmente.' },
  { v: 'suspeito',   label: 'Marcar suspeito',      ajuda: 'Registra a suspeita. NÃO bloqueia o pedido — pede senha de gerente.' },
  { v: 'revisar',    label: 'Revisar depois',       ajuda: 'Fica na fila pra alguém voltar nele.' },
];

export default function PainelRisco({ pedidoRef }: { pedidoRef: string | number }) {
  const [a, setA] = useState<Analise | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState(false);
  const [detalhe, setDetalhe] = useState(false);
  const [salvando, setSalvando] = useState<string | null>(null);
  const [obs, setObs] = useState('');
  const [baixandoDossie, setBaixandoDossie] = useState(false);

  const carregar = useCallback(
    async (recalcular = false) => {
      setErro(null);
      try {
        const r = recalcular
          ? await api<Analise>(`/admin/risco/pedido/${pedidoRef}/recalcular`, { method: 'POST' })
          : await api<Analise>(`/admin/risco/pedido/${pedidoRef}`);
        setA(r);
        setObs(r.observacao || '');
        // Risco relevante abre sozinho. Baixo fica fechado — ver o comentário
        // do topo: painel que grita em pedido normal ensina a ignorar painel.
        if (r.nivel === 'alto' || r.nivel === 'critico') setAberto(true);
      } catch (e: any) {
        setErro(e?.message || 'Não foi possível carregar a análise de risco.');
      } finally {
        setCarregando(false);
      }
    },
    [pedidoRef],
  );

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const decidir = async (status: string) => {
    const item = STATUS_ANALISE.find((s) => s.v === status);
    let senha: string | undefined;
    let motivo: string | undefined;
    if (status === 'suspeito') {
      motivo = window.prompt('Por que este pedido é suspeito? (fica no histórico)') || '';
      if (!motivo.trim()) return;
      senha = window.prompt('Senha de gerente ou superior:') || '';
      if (!senha) return;
    }
    setSalvando(status);
    try {
      await api(`/admin/risco/pedido/${pedidoRef}/decisao`, {
        method: 'POST',
        body: JSON.stringify({ status, observacao: obs, motivo, senha }),
      });
      await carregar();
    } catch (e: any) {
      alert(e?.message?.replace(/^\d+:\s*/, '') || `Não foi possível marcar como ${item?.label}.`);
    } finally {
      setSalvando(null);
    }
  };

  /**
   * O dossiê é PDF binário: `fetch` cru com o token no header, não o helper
   * `api()` (que faz `res.json()` e engasgaria). Token em query NÃO funciona
   * — o `JwtAuthGuard` lê o header. Mesmo caminho do DANFE nesta tela,
   * incluindo o fallback pra download quando o popup é bloqueado.
   */
  const abrirDossie = async () => {
    setBaixandoDossie(true);
    try {
      const token = getAuthToken();
      const r = await fetch(`${API_URL}/api/admin/risco/pedido/${pedidoRef}/dossie`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) {
        const msg = (await r.json().catch(() => null))?.message || `HTTP ${r.status}`;
        throw new Error(msg);
      }
      const blobUrl = URL.createObjectURL(await r.blob());
      const w = window.open(blobUrl, '_blank');
      if (!w) {
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = `dossie-chargeback-${a?.numero || pedidoRef}.pdf`;
        link.click();
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (e: any) {
      alert(`Não consegui gerar o dossiê: ${e?.message || e}`);
    } finally {
      setBaixandoDossie(false);
    }
  };

  if (carregando) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Conferindo relações com pedidos anteriores…
      </div>
    );
  }

  if (erro || !a) {
    return (
      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-500">
        Análise de risco indisponível{erro ? ` — ${erro.replace(/^\d+:\s*/, '')}` : ''}.
      </div>
    );
  }

  if (!a.ativo) return null;

  const comMotivo = a.motivos.filter((m) => m.peso > 0);
  const contexto = a.motivos.filter((m) => m.peso === 0);
  const n = NIVEL[a.nivel];

  // SEM RELAÇÃO: uma linha discreta e pronto. Sem cor, sem score grande, sem
  // barra — não há nada pra dizer, e fingir que há é o que gera desconfiança.
  if (!comMotivo.length && !a.relacionados.length) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        <span>Nenhum pedido anterior tem relação com este.</span>
        <button
          onClick={() => carregar(true)}
          className="ml-auto text-xs text-emerald-700 underline hover:text-emerald-900"
        >
          conferir de novo
        </button>
      </div>
    );
  }

  return (
    <div className={`mb-4 rounded-lg border-2 ${n.borda} ${n.fundo} overflow-hidden`}>
      {/* ── Cabeçalho: nível, score, resumo ── */}
      <button
        onClick={() => setAberto((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <ShieldAlert className={`h-5 w-5 shrink-0 ${n.texto}`} />
        <div className="min-w-0 flex-1">
          <div className={`flex flex-wrap items-center gap-2 font-bold ${n.texto}`}>
            <span>{n.emoji} ANÁLISE DE RISCO — {n.rotulo}</span>
            <span className="rounded bg-white/70 px-1.5 py-0.5 text-xs font-black tabular-nums">
              {a.score}/100
            </span>
            {a.chargebacksRelacionados > 0 && (
              <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">
                {a.chargebacksRelacionados} chargeback{a.chargebacksRelacionados > 1 ? 's' : ''} relacionado{a.chargebacksRelacionados > 1 ? 's' : ''}
              </span>
            )}
            {a.status !== 'aguardando' && (
              <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
                {a.status.replace('_', ' ')}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-slate-600">{a.resumo}</div>
          <div className="mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/70">
            <div className={`h-full ${n.barra}`} style={{ width: `${Math.min(100, a.score)}%` }} />
          </div>
        </div>
        {aberto ? <ChevronDown className="h-5 w-5 shrink-0 text-slate-400" /> : <ChevronRight className="h-5 w-5 shrink-0 text-slate-400" />}
      </button>

      {aberto && (
        <div className="border-t border-white/60 bg-white/60 px-4 py-3">
          {/* ── MOTIVOS: o item 24 em pé ── */}
          {comMotivo.length > 0 && (
            <>
              <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
                Motivos do alerta
              </div>
              <ul className="space-y-1">
                {comMotivo.map((m) => (
                  <li key={m.chave} className="flex items-start gap-2 text-sm text-slate-800">
                    <span className="shrink-0">{BOLINHA[m.cor]}</span>
                    <span className="flex-1">
                      {m.texto}
                      {m.pedidos.length > 0 && (
                        <span className="ml-1 text-xs text-slate-500">({m.pedidos.join(', ')})</span>
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums text-xs font-semibold text-slate-400">
                      +{m.peso}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* ── PEDIDOS RELACIONADOS: item 9 ── */}
          {a.relacionados.length > 0 && (
            <>
              <div className="mb-1.5 mt-4 text-xs font-bold uppercase tracking-wide text-slate-500">
                Pedidos relacionados
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="py-1 pr-2 font-semibold">Pedido</th>
                      <th className="py-1 pr-2 font-semibold">Data</th>
                      <th className="py-1 pr-2 font-semibold">Cliente</th>
                      <th className="py-1 pr-2 text-right font-semibold">Valor</th>
                      <th className="py-1 pr-2 font-semibold">Relação</th>
                      <th className="py-1 font-semibold">Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.relacionados.map((r) => (
                      <tr key={r.id} className="border-b border-slate-100 last:border-0">
                        <td className="py-1.5 pr-2">
                          {/* A rota abre pelo id NUMÉRICO, não pelo número
                              impresso: "/pedidos/wc/LP-000129" é 404. E é
                              <Link>, não <a> — `no-html-link-for-pages` é
                              ERRO no build da Vercel. */}
                          {r.wcOrderId ? (
                            <Link
                              href={`/pedidos/wc/${r.wcOrderId}`}
                              className="inline-flex items-center gap-1 font-semibold text-blue-700 hover:underline"
                            >
                              {r.numero} <ExternalLink className="h-3 w-3" />
                            </Link>
                          ) : (
                            <span className="font-semibold text-slate-700">{r.numero}</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-2 text-slate-600">
                          {r.data ? new Date(r.data).toLocaleDateString('pt-BR') : '—'}
                        </td>
                        <td className="py-1.5 pr-2 text-slate-700">{r.cliente || '—'}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-slate-700">
                          {r.valor != null
                            ? r.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
                            : '—'}
                        </td>
                        <td className="py-1.5 pr-2 text-xs text-slate-600">{r.relacao.join(' + ')}</td>
                        <td className="py-1.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                              r.situacao === 'chargeback'
                                ? 'bg-red-100 text-red-800'
                                : r.situacao === 'cancelado'
                                  ? 'bg-amber-100 text-amber-800'
                                  : r.situacao === 'nao_pago'
                                    ? 'bg-slate-100 text-slate-600'
                                    : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
                            {r.situacaoTexto}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ── DECISÃO ── */}
          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
              Decisão da análise
            </div>
            <p className="mb-2 text-xs text-slate-500">
              Marcar aqui <strong>não altera o pedido</strong> — ele continua no fluxo normal de
              separação e envio. É o registro de quem olhou e o que concluiu. Pra cancelar, use o
              cancelamento do próprio pedido.
            </p>
            <textarea
              value={obs}
              onChange={(e) => setObs(e.target.value)}
              rows={2}
              placeholder="Observação da análise — ex.: cliente confirmou os dados pelo WhatsApp."
              className="mb-2 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              {STATUS_ANALISE.map((s) => (
                <button
                  key={s.v}
                  title={s.ajuda}
                  disabled={!!salvando}
                  onClick={() => decidir(s.v)}
                  className={`rounded border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                    a.status === s.v
                      ? 'border-slate-800 bg-slate-800 text-white'
                      : s.v === 'suspeito'
                        ? 'border-red-300 bg-white text-red-700 hover:bg-red-50'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {salvando === s.v ? '…' : s.label}
                </button>
              ))}
            </div>
            {a.responsavel && (
              <div className="mt-2 text-xs text-slate-500">
                Última decisão por <strong>{a.responsavel}</strong>.
              </div>
            )}
          </div>

          {/* ── Ações e detalhe técnico ── */}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <button
              onClick={() => carregar(true)}
              className="inline-flex items-center gap-1 text-slate-600 underline hover:text-slate-900"
            >
              <RefreshCw className="h-3 w-3" /> recalcular
            </button>
            <button
              onClick={abrirDossie}
              disabled={baixandoDossie}
              className="inline-flex items-center gap-1 text-slate-600 underline hover:text-slate-900 disabled:opacity-50"
            >
              <FileText className="h-3 w-3" />
              {baixandoDossie ? 'gerando dossiê…' : 'gerar dossiê de chargeback'}
            </button>
            <button
              onClick={() => setDetalhe((v) => !v)}
              className="inline-flex items-center gap-1 text-slate-600 underline hover:text-slate-900"
            >
              {detalhe ? 'esconder' : 'ver'} detalhe técnico
            </button>
          </div>

          {detalhe && (
            <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-600">
              <div>
                <strong>Dados que este pedido consegue cruzar:</strong>{' '}
                {a.chaves.length ? a.chaves.map((c) => c.rotulo).join(', ') : 'nenhum'}
              </div>
              {a.chavesIgnoradas.length > 0 && (
                <div className="mt-1">
                  <strong>Ignorado no cruzamento:</strong> {a.chavesIgnoradas.join(' · ')}
                </div>
              )}
              {contexto.length > 0 && (
                <div className="mt-1">
                  <strong>Relações sem ocorrência</strong> (não pontuam):
                  <ul className="mt-0.5 list-disc pl-4">
                    {contexto.map((m) => (
                      <li key={m.chave}>{m.texto}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
