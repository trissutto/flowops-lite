'use client';

/**
 * <PosVenda />
 *
 * A aba PÓS-VENDA da tela de separação — o funil depois que a peça chegou na
 * casa da cliente: **entregue → convidada → abriu → avaliou**.
 *
 * O centro de avaliação em `/conta/avaliacoes` já existe, mas ele é PASSIVO:
 * descobre a fila quem entra na conta. A maioria compra como visitante e não
 * volta ao site. Esta tela é o outro lado — quem já pode ser chamado, quem foi
 * chamado e não respondeu, e quem respondeu.
 *
 * Sem essa lista, "ninguém avalia" e "ninguém foi convidado" viram o mesmo
 * silêncio, e são problemas opostos: um é de mensagem, o outro é de produto.
 *
 * A MODERAÇÃO NÃO MORA AQUI: ela tem tela própria em `/retaguarda/avaliacoes`,
 * junto da régua de pontos. Duas telas decidindo o que publica seria duas
 * políticas divergindo sozinhas.
 *
 * O BADGE da aba conta só "a convidar" — o que exige gente. Contar "entregues
 * no mês" faria um número grande e permanente, que é como se ensina a operação
 * a ignorar a fila (a lição da tarefa "Gerar etiqueta", removida em 11/08).
 *
 * Fonte: GET /pos-venda?de&ate&situacao&busca
 * SEM wrapper de página — o layout é do parent, igual ao <EnviadosByStore />.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Star, Camera, Send, Copy, RefreshCw, Loader2, Search, Award,
  Clock, PackageCheck, ExternalLink, Eye,
} from 'lucide-react';
import { api } from '@/lib/api';

// ===========================================================================
// Types — espelham o que `PosVendaService.fila()` devolve
// ===========================================================================

interface AvaliacaoRow {
  id: string;
  nota: number;
  texto: string | null;
  fotos: string[];
  produto: string | null;
  cor: string | null;
  tamanho: string | null;
  status: string;
  pontos: number;
}

type Situacao = 'aguardando_prazo' | 'a_enviar' | 'convidada' | 'avaliou';

interface LinhaPosVenda {
  orderId: string;
  pedido: string | null;
  cliente: string | null;
  telefone: string | null;
  temCpf: boolean;
  origem: string;
  total: number | null;
  pecas: number;
  entregueEm: string | null;
  convidarEm: string | null;
  conviteId: string | null;
  link: string | null;
  enviadoEm: string | null;
  abertoEm: string | null;
  respondidoEm: string | null;
  tentativas: number;
  situacao: Situacao;
  avaliacoes: AvaliacaoRow[];
}

interface Resposta {
  config: {
    ativo: boolean;
    diasAposEntrega: number;
    pontosEnvio: number;
    pontosTexto: number;
    pontosFoto: number;
    pontosMedidas: number;
    pontosPorReal: number;
  };
  resumo: {
    entregues: number;
    aEnviar: number;
    aguardandoPrazo: number;
    convidadas: number;
    avaliaram: number;
    abriram: number;
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
  { slug: 'a_enviar',         label: 'A convidar',   cor: 'bg-rose-100 text-rose-700' },
  { slug: 'convidada',        label: 'Sem resposta', cor: 'bg-sky-100 text-sky-800' },
  { slug: 'avaliou',          label: 'Avaliou',      cor: 'bg-emerald-100 text-emerald-800' },
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
  const teto = cfg ? cfg.pontosEnvio + cfg.pontosTexto + cfg.pontosFoto + cfg.pontosMedidas : 0;

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
            <Award className="w-5 h-5 text-violet-600" /> Pós-venda · convite pra avaliar
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {cfg ? (
              <>
                A cliente é chamada <strong>{cfg.diasAposEntrega} dia{cfg.diasAposEntrega === 1 ? '' : 's'}</strong> depois
                da entrega confirmada pelo rastreio, e ganha <strong>até {teto} pontos</strong> por peça
                ({cfg.pontosEnvio} pelas estrelas, +{cfg.pontosTexto} pelo texto, +{cfg.pontosFoto} pela
                foto, +{cfg.pontosMedidas} pelas medidas) — {cfg.pontosPorReal} pontos valem R$ 1,00.
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
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/retaguarda/avaliacoes"
            className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
          >
            <Eye className="w-4 h-4" /> Moderar e configurar
          </Link>
          <button
            onClick={carregar}
            className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
          </button>
        </div>
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

      {/* KPIs — o funil na ordem em que acontece */}
      {dados && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          {[
            { label: 'ENTREGUES', valor: dados.resumo.entregues, cor: 'border-slate-300', icone: PackageCheck },
            { label: 'A CONVIDAR', valor: dados.resumo.aEnviar, cor: 'border-rose-400', icone: Send },
            { label: 'SEM RESPOSTA', valor: dados.resumo.convidadas, cor: 'border-sky-400', icone: Clock },
            { label: 'ABRIRAM', valor: dados.resumo.abriram, cor: 'border-violet-400', icone: Eye },
            { label: 'AVALIARAM', valor: dados.resumo.avaliaram, cor: 'border-emerald-500', icone: Star },
          ].map((k) => (
            <div key={k.label} className={`bg-white border-l-4 ${k.cor} border border-slate-200 rounded-lg p-3`}>
              <div className="text-[11px] font-bold text-slate-500 tracking-wide flex items-center gap-1.5">
                <k.icone className="w-3.5 h-3.5" /> {k.label}
              </div>
              <div className="text-2xl font-bold text-slate-800 mt-1">{k.valor}</div>
              {k.label === 'AVALIARAM' && dados.resumo.entregues > 0 && (
                <div className="text-[11px] text-slate-500">
                  {Math.round((dados.resumo.avaliaram / dados.resumo.entregues) * 100)}% de quem recebeu
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
          Nenhuma entrega confirmada nesse período{situacao ? ' com essa situação' : ''}.
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

                <div className="text-xs text-slate-500 min-w-[140px]">
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
                    title="Sem CPF no pedido o link não tem onde guardar os pontos — precisa completar o cadastro antes."
                  >
                    sem CPF
                  </span>
                )}

                {l.abertoEm && !l.respondidoEm && (
                  <span className="text-xs text-violet-700 font-semibold">
                    abriu {diasAtras(l.abertoEm)} e não enviou
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
                  {l.situacao !== 'avaliou' && (
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

              {/* O que ela respondeu — leitura, não decisão. Publicar/ocultar
                  é em /retaguarda/avaliacoes. */}
              {l.avaliacoes.length > 0 && (
                <div className="border-t border-slate-100 bg-slate-50/60 divide-y divide-slate-100">
                  {l.avaliacoes.map((a) => (
                    <div key={a.id} className="p-3 flex flex-wrap gap-3 items-start">
                      {a.fotos[0] && (
                        <a href={a.fotos[0]} target="_blank" rel="noreferrer" className="shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={a.fotos[0]}
                            alt="Foto da cliente"
                            className="w-16 h-16 object-cover rounded border border-slate-200"
                          />
                        </a>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Estrelas nota={a.nota} />
                          <span className="text-sm font-semibold text-slate-700">{a.produto || '—'}</span>
                          <span className="text-xs text-slate-500">
                            {[a.cor, a.tamanho].filter(Boolean).join(' · ')}
                          </span>
                          {a.fotos.length > 0 && (
                            <span className="text-[11px] font-bold text-violet-700 bg-violet-100 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                              <Camera className="w-3 h-3" /> {a.fotos.length} foto{a.fotos.length > 1 ? 's' : ''}
                            </span>
                          )}
                          {a.status !== 'publicada' && (
                            <span className="text-[11px] font-bold text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded">
                              oculta no site
                            </span>
                          )}
                        </div>
                        {a.texto && (
                          <p className="text-sm text-slate-600 mt-1 whitespace-pre-wrap break-words">
                            {a.texto}
                          </p>
                        )}
                        <p className="text-xs text-slate-400 mt-1">{a.pontos} pontos creditados</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Convidada e sem resposta: o link cru, pra conferência */}
              {l.enviadoEm && !l.respondidoEm && l.link && (
                <div className="border-t border-slate-100 px-3 py-2 text-xs text-slate-400 flex items-center gap-1.5">
                  <ExternalLink className="w-3 h-3" />
                  <a href={l.link} target="_blank" rel="noreferrer" className="hover:underline break-all">
                    {l.link}
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
