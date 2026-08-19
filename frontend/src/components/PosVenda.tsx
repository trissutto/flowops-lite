'use client';

/**
 * <PosVenda />
 *
 * A aba PÓS-VENDA da tela de separação — o que acontece DEPOIS que a peça
 * chegou na casa da cliente.
 *
 * O ciclo do pedido terminava na entrega e ninguém olhava mais. Esta tela
 * mostra as três coisas que existem daí em diante e que somem em silêncio:
 *
 *   1. **Entrega que já pode virar convite** (D+5). O cron manda sozinho; a
 *      linha existe pro caso em que ele não alcança — pedido sem telefone,
 *      entrega antiga, cliente que pediu o link no WhatsApp.
 *   2. **Convite que saiu e ninguém respondeu.** Sem esta coluna, "ninguém
 *      avalia" e "ninguém foi chamado" viram o mesmo número — e são problemas
 *      opostos: um é de mensagem, o outro é de produto.
 *   3. **Avaliação esperando aprovação.** Nada entra na página do produto sem
 *      alguém ler (decisão do dono, 19/08) — foto de cliente vai direto pra
 *      vitrine.
 *
 * O BADGE DA ABA conta só 1 e 3: o que exige gente. Contar "entregues no mês"
 * faria um número grande e permanente, que é como se ensina a operação a
 * ignorar a fila (a lição da tarefa "Gerar etiqueta", removida em 11/08).
 *
 * Fonte: GET /pos-venda?de&ate&situacao&busca
 * SEM wrapper de página — o layout é do parent, igual ao <EnviadosByStore />.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Star, Camera, Check, X, Send, Copy, RefreshCw, Loader2, Search,
  MessageSquare, Award, Clock, PackageCheck, ExternalLink,
} from 'lucide-react';
import { api } from '@/lib/api';

// ===========================================================================
// Types — espelham o que `PosVendaService.fila()` devolve
// ===========================================================================

interface AvaliacaoRow {
  id: string;
  refBase: string;
  cor: string | null;
  tamanho: string | null;
  produto: string | null;
  nota: number;
  comentario: string | null;
  foto: string | null;
  status: 'pending' | 'approved' | 'rejected';
  pontos: number;
  data: string | null;
}

type Situacao = 'aguardando_prazo' | 'a_enviar' | 'convidada' | 'a_moderar' | 'concluida';

interface LinhaPosVenda {
  orderId: string;
  pedido: string | null;
  cliente: string | null;
  telefone: string | null;
  temCpf: boolean;
  origem: string;
  total: number | null;
  entregueEm: string | null;
  convidarEm: string | null;
  conviteId: string | null;
  link: string | null;
  enviadoEm: string | null;
  abertoEm: string | null;
  respondidoEm: string | null;
  tentativas: number;
  situacao: Situacao;
  pendentes: number;
  avaliacoes: AvaliacaoRow[];
}

interface Resposta {
  config: {
    ativo: boolean;
    diasAposEntrega: number;
    pontosPorAvaliacao: number;
    multiplicadorFoto: number;
    pontosPorReal: number;
    minimoResgate: number;
  };
  resumo: {
    entregues: number;
    aEnviar: number;
    convidadas: number;
    aModerar: number;
    concluidas: number;
    respondidas: number;
  };
  linhas: LinhaPosVenda[];
}

// ===========================================================================
// Helpers
// ===========================================================================

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

type Preset = 'hoje' | 'ontem' | '7d' | '30d' | 'custom';

function presetToRange(preset: Preset): { de: string; ate: string } {
  const hoje = new Date();
  if (preset === 'hoje') return { de: toDateInput(hoje), ate: toDateInput(hoje) };
  if (preset === 'ontem') {
    const y = new Date(hoje.getTime() - 86400000);
    return { de: toDateInput(y), ate: toDateInput(y) };
  }
  const dias = preset === '7d' ? 6 : 29;
  return { de: toDateInput(new Date(hoje.getTime() - dias * 86400000)), ate: toDateInput(hoje) };
}

function diasAtras(iso: string | null): string {
  if (!iso) return '—';
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (dias <= 0) return 'hoje';
  if (dias === 1) return 'ontem';
  return `há ${dias} dias`;
}

const SITUACOES: Array<{ slug: Situacao | ''; label: string; cor: string }> = [
  { slug: '',                 label: 'Todas',        cor: 'bg-slate-100 text-slate-700' },
  { slug: 'a_moderar',        label: 'A aprovar',    cor: 'bg-amber-100 text-amber-800' },
  { slug: 'a_enviar',         label: 'A convidar',   cor: 'bg-rose-100 text-rose-700' },
  { slug: 'convidada',        label: 'Sem resposta', cor: 'bg-sky-100 text-sky-800' },
  { slug: 'concluida',        label: 'Concluídas',   cor: 'bg-emerald-100 text-emerald-800' },
  { slug: 'aguardando_prazo', label: 'No prazo',     cor: 'bg-slate-100 text-slate-500' },
];

function Estrelas({ nota }: { nota: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`${nota} de 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`w-3.5 h-3.5 ${n <= nota ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`}
        />
      ))}
    </span>
  );
}

// ===========================================================================
// Componente
// ===========================================================================

export default function PosVenda() {
  const [preset, setPreset] = useState<Preset>('30d');
  const [de, setDe] = useState(() => presetToRange('30d').de);
  const [ate, setAte] = useState(() => presetToRange('30d').ate);
  const [situacao, setSituacao] = useState<Situacao | ''>('');
  const [buscaInput, setBuscaInput] = useState('');
  const [busca, setBusca] = useState('');

  const [dados, setDados] = useState<Resposta | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<Record<string, boolean>>({});
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set());
  const [copiado, setCopiado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const q = new URLSearchParams({ de, ate });
      if (situacao) q.set('situacao', situacao);
      if (busca) q.set('busca', busca);
      setDados(await api<Resposta>(`/pos-venda?${q}`));
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar o pós-venda.');
    } finally {
      setLoading(false);
    }
  }, [de, ate, situacao, busca]);

  useEffect(() => { carregar(); }, [carregar]);

  function aplicarPreset(p: Preset) {
    setPreset(p);
    if (p === 'custom') return;
    const r = presetToRange(p);
    setDe(r.de);
    setAte(r.ate);
  }

  const cfg = dados?.config;
  const pontosComFoto = cfg ? cfg.pontosPorAvaliacao * cfg.multiplicadorFoto : 0;

  const pendentesVisiveis = useMemo(
    () =>
      (dados?.linhas ?? [])
        .flatMap((l) => l.avaliacoes)
        .filter((a) => a.status === 'pending')
        .map((a) => a.id),
    [dados],
  );

  async function convidar(linha: LinhaPosVenda) {
    const chave = `convite:${linha.orderId}`;
    setOcupado((o) => ({ ...o, [chave]: true }));
    try {
      const r = linha.conviteId
        ? await api<{ ok: boolean }>(`/pos-venda/convites/${linha.conviteId}/reenviar`, { method: 'POST' })
        : await api<{ ok: boolean }>(`/pos-venda/convites/${linha.orderId}`, { method: 'POST' });
      if (!r?.ok) {
        alert(
          'O convite não saiu por nenhum canal.\n\n' +
            'Confere se o WhatsApp está conectado e se a cliente tem telefone no pedido. ' +
            'Enquanto isso dá pra copiar o link e mandar à mão.',
        );
      }
      await carregar();
    } catch (e: any) {
      alert(e?.message || 'Falhou ao enviar o convite.');
    } finally {
      setOcupado((o) => ({ ...o, [chave]: false }));
    }
  }

  async function moderar(id: string, decisao: 'approved' | 'rejected') {
    const motivo =
      decisao === 'rejected'
        ? window.prompt('Por que está reprovando? (fica só no histórico interno)') ?? undefined
        : undefined;
    setOcupado((o) => ({ ...o, [id]: true }));
    try {
      await api(`/pos-venda/avaliacoes/${id}/moderar`, {
        method: 'POST',
        body: JSON.stringify({ decisao, motivo }),
      });
      await carregar();
    } catch (e: any) {
      alert(e?.message || 'Falhou ao registrar a decisão.');
    } finally {
      setOcupado((o) => ({ ...o, [id]: false }));
    }
  }

  async function moderarLote(decisao: 'approved' | 'rejected') {
    const ids = [...selecionadas];
    if (!ids.length) return;
    const verbo = decisao === 'approved' ? 'Aprovar' : 'Reprovar';
    if (!window.confirm(`${verbo} ${ids.length} avaliação(ões)?`)) return;
    setOcupado((o) => ({ ...o, lote: true }));
    try {
      const r = await api<{ ok: number; total: number }>(`/pos-venda/avaliacoes/moderar-lote`, {
        method: 'POST',
        body: JSON.stringify({ ids, decisao }),
      });
      setSelecionadas(new Set());
      await carregar();
      if (r.ok < r.total) alert(`${r.ok} de ${r.total} deram certo.`);
    } catch (e: any) {
      alert(e?.message || 'Falhou a decisão em lote.');
    } finally {
      setOcupado((o) => ({ ...o, lote: false }));
    }
  }

  function copiarLink(linha: LinhaPosVenda) {
    if (!linha.link) return;
    navigator.clipboard?.writeText(linha.link);
    setCopiado(linha.orderId);
    setTimeout(() => setCopiado(null), 2000);
  }

  // =========================================================================

  return (
    <div>
      {/* Cabeçalho da aba */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <Award className="w-5 h-5 text-violet-600" /> Pós-venda · avaliações
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {cfg ? (
              <>
                A cliente é chamada <strong>{cfg.diasAposEntrega} dias</strong> depois da entrega
                confirmada pelo rastreio. Ela ganha <strong>{cfg.pontosPorAvaliacao} pontos</strong> por
                peça avaliada e <strong>{pontosComFoto}</strong> quando manda foto — e{' '}
                <strong>{cfg.pontosPorReal} pontos valem R$ 1,00</strong> de desconto.
              </>
            ) : (
              'Carregando as regras…'
            )}
          </p>
          {cfg && !cfg.ativo && (
            <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 mt-2 inline-block">
              O programa está <strong>desligado</strong> — nenhum convite sai enquanto isso.
            </p>
          )}
        </div>
        <button
          onClick={carregar}
          className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
        </button>
      </div>

      {/* Período — De/Até com atalhos (nunca dropdown de períodos fixos) */}
      <div className="bg-white border border-slate-200 rounded-lg p-3 mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500 font-medium mr-1">Entregues:</span>
        {(['hoje', 'ontem', '7d', '30d'] as Preset[]).map((p) => (
          <button
            key={p}
            onClick={() => aplicarPreset(p)}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition ${
              preset === p
                ? 'bg-[#0f7a82] text-white border-[#0f7a82]'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {p === 'hoje' ? 'Hoje' : p === 'ontem' ? 'Ontem' : p === '7d' ? 'Últimos 7d' : 'Últimos 30d'}
          </button>
        ))}
        <div className="flex items-center gap-1.5 ml-1">
          <input
            type="date"
            value={de}
            onChange={(e) => { setDe(e.target.value); setPreset('custom'); }}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
          />
          <span className="text-slate-400 text-sm">até</span>
          <input
            type="date"
            value={ate}
            onChange={(e) => { setAte(e.target.value); setPreset('custom'); }}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
          />
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); setBusca(buscaInput.trim()); }}
          className="relative ml-auto"
        >
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={buscaInput}
            onChange={(e) => setBuscaInput(e.target.value)}
            placeholder="Pedido, nome ou telefone…"
            className="pl-9 pr-3 py-1.5 border border-slate-200 rounded-lg text-sm w-56"
          />
        </form>
      </div>

      {/* KPIs */}
      {dados && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          {[
            { label: 'ENTREGUES', valor: dados.resumo.entregues, cor: 'border-slate-300', icone: PackageCheck },
            { label: 'A CONVIDAR', valor: dados.resumo.aEnviar, cor: 'border-rose-400', icone: Send },
            { label: 'SEM RESPOSTA', valor: dados.resumo.convidadas, cor: 'border-sky-400', icone: Clock },
            { label: 'A APROVAR', valor: dados.resumo.aModerar, cor: 'border-amber-400', icone: MessageSquare },
            { label: 'RESPONDERAM', valor: dados.resumo.respondidas, cor: 'border-emerald-500', icone: Star },
          ].map((k) => (
            <div key={k.label} className={`bg-white border-l-4 ${k.cor} border border-slate-200 rounded-lg p-3`}>
              <div className="text-[11px] font-bold text-slate-500 tracking-wide flex items-center gap-1.5">
                <k.icone className="w-3.5 h-3.5" /> {k.label}
              </div>
              <div className="text-2xl font-bold text-slate-800 mt-1">{k.valor}</div>
              {k.label === 'RESPONDERAM' && dados.resumo.entregues > 0 && (
                <div className="text-[11px] text-slate-500">
                  {Math.round((dados.resumo.respondidas / dados.resumo.entregues) * 100)}% de quem recebeu
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Filtro por situação */}
      <div className="flex flex-wrap gap-2 mb-4">
        {SITUACOES.map((s) => (
          <button
            key={s.slug || 'todas'}
            onClick={() => setSituacao(s.slug)}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition ${
              situacao === s.slug
                ? 'bg-[#0f7a82] text-white border-[#0f7a82]'
                : `${s.cor} border-transparent hover:opacity-80`
            }`}
          >
            {s.label}
          </button>
        ))}
        {selecionadas.size > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-slate-500">{selecionadas.size} selecionada(s)</span>
            <button
              onClick={() => moderarLote('approved')}
              disabled={!!ocupado.lote}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5"
            >
              {ocupado.lote ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Aprovar
            </button>
            <button
              onClick={() => moderarLote('rejected')}
              disabled={!!ocupado.lote}
              className="px-3 py-1.5 rounded-lg bg-white border border-rose-200 text-rose-700 text-sm font-semibold hover:bg-rose-50 disabled:opacity-50"
            >
              Reprovar
            </button>
          </div>
        )}
        {selecionadas.size === 0 && pendentesVisiveis.length > 0 && (
          <button
            onClick={() => setSelecionadas(new Set(pendentesVisiveis))}
            className="ml-auto text-sm text-[#0f7a82] font-semibold hover:underline"
          >
            Selecionar as {pendentesVisiveis.length} pendentes
          </button>
        )}
      </div>

      {erro && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-3 py-2 text-sm mb-4">
          {erro}
        </div>
      )}

      {loading && !dados && (
        <div className="text-slate-400 flex items-center gap-2 py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
        </div>
      )}

      {dados && dados.linhas.length === 0 && !loading && (
        <div className="bg-white border border-slate-200 rounded-lg p-8 text-center text-slate-500">
          Nenhuma entrega confirmada nesse período
          {situacao ? ' com essa situação' : ''}.
          <div className="text-sm text-slate-400 mt-1">
            O pedido só entra aqui quando o rastreio confirma a entrega.
          </div>
        </div>
      )}

      {/* Lista */}
      <div className="space-y-3">
        {(dados?.linhas ?? []).map((l) => {
          const badge = SITUACOES.find((s) => s.slug === l.situacao);
          return (
            <div key={l.orderId} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="p-3 flex flex-wrap items-center gap-3">
                <div className="min-w-[150px]">
                  <div className="font-bold text-slate-800">{l.pedido || '—'}</div>
                  <div className="text-xs text-slate-500">{l.cliente || 'Sem nome'}</div>
                </div>

                <div className="text-xs text-slate-500 min-w-[130px]">
                  <div>Entregue {diasAtras(l.entregueEm)}</div>
                  {l.enviadoEm ? (
                    <div>Convite {diasAtras(l.enviadoEm)}</div>
                  ) : l.convidarEm ? (
                    <div className="text-slate-400">
                      Convite em {new Date(l.convidarEm).toLocaleDateString('pt-BR')}
                    </div>
                  ) : null}
                </div>

                <span className={`text-xs font-bold px-2 py-1 rounded ${badge?.cor ?? 'bg-slate-100'}`}>
                  {badge?.label ?? l.situacao}
                </span>

                {!l.temCpf && (
                  <span
                    className="text-xs font-semibold px-2 py-1 rounded bg-amber-50 text-amber-800 border border-amber-200"
                    title="Sem CPF no pedido não há em quem creditar os pontos — a avaliação vale, o ponto não."
                  >
                    sem CPF · não credita
                  </span>
                )}

                {l.respondidoEm && (
                  <span className="text-xs text-emerald-700 font-semibold">
                    respondeu {diasAtras(l.respondidoEm)}
                  </span>
                )}

                <div className="ml-auto flex items-center gap-2">
                  {l.link && (
                    <button
                      onClick={() => copiarLink(l)}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 flex items-center gap-1.5"
                      title="Copiar o link de avaliação pra mandar à mão"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      {copiado === l.orderId ? 'Copiado!' : 'Link'}
                    </button>
                  )}
                  {!l.respondidoEm && (
                    <button
                      onClick={() => convidar(l)}
                      disabled={!!ocupado[`convite:${l.orderId}`]}
                      className="px-3 py-1.5 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {ocupado[`convite:${l.orderId}`] ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      {l.enviadoEm ? `Reenviar${l.tentativas ? ` (${l.tentativas})` : ''}` : 'Convidar agora'}
                    </button>
                  )}
                </div>
              </div>

              {/* Avaliações do pedido */}
              {l.avaliacoes.length > 0 && (
                <div className="border-t border-slate-100 bg-slate-50/60 divide-y divide-slate-100">
                  {l.avaliacoes.map((a) => (
                    <div key={a.id} className="p-3 flex flex-wrap gap-3 items-start">
                      {a.status === 'pending' && (
                        <input
                          type="checkbox"
                          checked={selecionadas.has(a.id)}
                          onChange={(e) => {
                            setSelecionadas((prev) => {
                              const n = new Set(prev);
                              if (e.target.checked) n.add(a.id);
                              else n.delete(a.id);
                              return n;
                            });
                          }}
                          className="mt-1"
                        />
                      )}

                      {a.foto && (
                        <a href={a.foto} target="_blank" rel="noreferrer" className="shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={a.foto}
                            alt="Foto da cliente"
                            className="w-16 h-16 object-cover rounded border border-slate-200"
                          />
                        </a>
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Estrelas nota={a.nota} />
                          <span className="text-sm font-semibold text-slate-700">
                            {a.produto || a.refBase}
                          </span>
                          <span className="text-xs text-slate-500">
                            {[a.cor, a.tamanho].filter(Boolean).join(' · ')}
                          </span>
                          {a.foto && (
                            <span className="text-[11px] font-bold text-violet-700 bg-violet-100 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                              <Camera className="w-3 h-3" /> pontos em dobro
                            </span>
                          )}
                        </div>
                        {a.comentario && (
                          <p className="text-sm text-slate-600 mt-1 whitespace-pre-wrap break-words">
                            {a.comentario}
                          </p>
                        )}
                        {a.status !== 'pending' && (
                          <div className="text-xs mt-1">
                            {a.status === 'approved' ? (
                              <span className="text-emerald-700 font-semibold">
                                No site · {a.pontos ? `${a.pontos} pontos creditados` : 'sem CPF, sem pontos'}
                              </span>
                            ) : (
                              <span className="text-rose-700 font-semibold">Reprovada · fora do site</span>
                            )}
                          </div>
                        )}
                      </div>

                      {a.status === 'pending' && (
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => moderar(a.id, 'approved')}
                            disabled={!!ocupado[a.id]}
                            className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5"
                          >
                            {ocupado[a.id] ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Check className="w-4 h-4" />
                            )}
                            Publicar
                          </button>
                          <button
                            onClick={() => moderar(a.id, 'rejected')}
                            disabled={!!ocupado[a.id]}
                            className="px-2.5 py-1.5 rounded-lg border border-rose-200 text-rose-700 text-sm font-semibold hover:bg-rose-50 disabled:opacity-50"
                            title="Reprovar — não entra na página do produto e não paga pontos"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Convidada e sem resposta: mostra o link cru pra conferência */}
              {l.enviadoEm && !l.respondidoEm && l.link && (
                <div className="border-t border-slate-100 px-3 py-2 text-xs text-slate-400 flex items-center gap-1.5">
                  <ExternalLink className="w-3 h-3" />
                  <a href={l.link} target="_blank" rel="noreferrer" className="hover:underline break-all">
                    {l.link}
                  </a>
                  {l.abertoEm && <span className="text-slate-500">· abriu {diasAtras(l.abertoEm)}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
