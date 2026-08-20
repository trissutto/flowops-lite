'use client';

/**
 * /retaguarda/avaliacoes — o programa de avaliação na mão da matriz.
 *
 * Duas coisas nesta tela:
 *
 * 1. **A RÉGUA DE PONTOS.** Quanto vale avaliar, escrever, fotografar e
 *    informar medidas. O dono pediu explicitamente que a pontuação fosse
 *    definida aqui e não no código — régua de programa de pontos se ajusta
 *    com o resultado, e o que exige deploy nunca é ajustado.
 * 2. **A MODERAÇÃO.** Publicar ou esconder uma avaliação. Esconder NÃO apaga:
 *    a avaliação continua no banco, some só da página do produto.
 *
 * ⚠️ Ponto se paga UMA VEZ, no envio, com a régua daquele momento. Mudar os
 * números aqui não recalcula o que já foi creditado — e é assim de propósito:
 * mexer em saldo já dado é o caminho mais curto pra cliente achar que sumiu
 * ponto dela.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ArrowLeft, Save, Star, Eye, EyeOff, AlertCircle, Check } from 'lucide-react';

interface Config {
  ativo: boolean;
  pontosEnvio: number;
  pontosTexto: number;
  minPalavras: number;
  pontosFoto: number;
  pontosMedidas: number;
  maxFotos: number;
  diasAposEntrega: number;
  diasConvite: number;
  diasAposPedido: number;
  janelaDias: number;
  moderacao: boolean;
  pontosPorReal: number;
  minimoResgate: number;
}

interface Resumo {
  total: number;
  publicadas: number;
  ocultas: number;
  comFoto: number;
  media: number;
  ultimos30: number;
  pontosDistribuidos: number;
}

interface Avaliacao {
  id: string;
  cliente: string | null;
  cpf: string | null;
  refBase: string;
  produtoNome: string | null;
  cor: string | null;
  tamanho: string | null;
  nota: number;
  texto: string | null;
  fotos: string[];
  caimento: string | null;
  alturaCm: number | null;
  pesoKg: number | null;
  publicarMedidas: boolean;
  pontos: number;
  status: string;
  data: string;
}

const PADRAO: Config = {
  ativo: true,
  pontosEnvio: 5,
  pontosTexto: 5,
  minPalavras: 20,
  pontosFoto: 10,
  pontosMedidas: 2,
  maxFotos: 5,
  diasAposEntrega: 0,
  diasConvite: 5,
  diasAposPedido: 20,
  janelaDias: 90,
  moderacao: false,
  pontosPorReal: 100,
  minimoResgate: 500,
};

const ROTULO_CAIMENTO: Record<string, string> = {
  pequeno: 'veio pequeno',
  fiel: 'fiel ao tamanho',
  grande: 'veio grande',
};

export default function AvaliacoesAdminPage() {
  const [cfg, setCfg] = useState<Config>(PADRAO);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [lista, setLista] = useState<Avaliacao[]>([]);
  const [filtro, setFiltro] = useState<'todas' | 'publicada' | 'oculta'>('todas');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const carregar = async (status = filtro) => {
    setLoading(true);
    setErr(null);
    try {
      const [c, r, l] = await Promise.all([
        api<Config>('/admin/avaliacoes/config'),
        api<Resumo>('/admin/avaliacoes/resumo'),
        api<{ avaliacoes: Avaliacao[] }>(`/admin/avaliacoes?status=${status}`),
      ]);
      setCfg({ ...PADRAO, ...c });
      setResumo(r);
      setLista(l.avaliacoes || []);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const salvar = async () => {
    setSaving(true);
    setErr(null);
    try {
      const r = await api<Config>('/admin/avaliacoes/config', {
        method: 'POST',
        body: JSON.stringify(cfg),
      });
      setCfg({ ...PADRAO, ...r });
      setSavedAt(new Date());
      setTimeout(() => setSavedAt(null), 3000);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const moderar = async (id: string, status: 'publicada' | 'oculta') => {
    try {
      await api(`/admin/avaliacoes/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      setLista((l) => l.map((a) => (a.id === id ? { ...a, status } : a)));
    } catch (e: any) {
      setErr(e?.message || 'Falha ao mudar o status');
    }
  };

  const trocarFiltro = (novo: typeof filtro) => {
    setFiltro(novo);
    carregar(novo);
  };

  /** O que uma avaliação COMPLETA vale hoje — o número que a cliente vê na tela dela. */
  const teto = cfg.pontosEnvio + cfg.pontosTexto + cfg.pontosFoto + cfg.pontosMedidas;

  const campo = (
    rotulo: string,
    ajuda: string,
    valor: number,
    onChange: (n: number) => void,
    sufixo = 'pontos',
  ) => (
    <label className="block">
      <div className="font-bold text-slate-800 mb-1">{rotulo}</div>
      <div className="text-xs text-slate-500 mb-2">{ajuda}</div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          value={valor}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
          className="w-24 border-2 rounded px-3 py-2 text-lg font-bold text-center"
        />
        <span className="text-sm font-bold text-slate-600">{sufixo}</span>
      </div>
    </label>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
            <Star className="w-5 h-5 text-amber-600" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-slate-800">Avaliações do site</h1>
            <p className="text-xs text-slate-500">
              Régua de pontos + o que aparece na página do produto
            </p>
          </div>
          <button
            onClick={salvar}
            disabled={saving || loading}
            className="flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Salvando…' : 'Salvar régua'}
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4 space-y-4">
        {err && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        {savedAt && (
          <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
            <Check className="w-4 h-4" /> Régua salva — vale da próxima avaliação em diante.
          </div>
        )}

        {loading ? (
          <div className="rounded-xl bg-white p-8 text-center text-slate-400">Carregando…</div>
        ) : (
          <>
            {resumo && (
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { rotulo: 'Avaliações', valor: resumo.total },
                  { rotulo: 'Nos 30 dias', valor: resumo.ultimos30 },
                  { rotulo: 'Com foto', valor: resumo.comFoto },
                  {
                    rotulo: 'Nota média',
                    valor: resumo.media ? resumo.media.toFixed(1).replace('.', ',') : '—',
                  },
                ].map((c) => (
                  <div key={c.rotulo} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-2xl font-bold text-slate-800">{c.valor}</div>
                    <div className="text-xs text-slate-500">{c.rotulo}</div>
                  </div>
                ))}
              </section>
            )}

            <section className="rounded-2xl border-2 border-slate-200 bg-white p-4">
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={cfg.ativo}
                  onChange={(e) => setCfg({ ...cfg, ativo: e.target.checked })}
                  className="h-6 w-6 accent-amber-600"
                />
                <div>
                  <div className="font-bold text-slate-800">
                    Programa {cfg.ativo ? 'ATIVO' : 'PAUSADO'}
                  </div>
                  <div className="text-xs text-slate-500">
                    Pausado: a cliente não vê o centro de avaliação nem ganha ponto. As
                    avaliações já publicadas continuam aparecendo na PDP.
                  </div>
                </div>
              </label>
            </section>

            <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-slate-800">Quanto vale avaliar</h2>
                <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-700">
                  até {teto} pontos por peça
                </span>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {campo(
                  'Por enviar a avaliação',
                  'Só as estrelas já valem isto. A nota NÃO muda a pontuação — se 5 estrelas pagasse mais, o programa compraria elogio.',
                  cfg.pontosEnvio,
                  (n) => setCfg({ ...cfg, pontosEnvio: n }),
                )}
                {campo(
                  'Por mandar foto',
                  'A foto de quem veste é o que mais ajuda outra cliente a decidir o tamanho.',
                  cfg.pontosFoto,
                  (n) => setCfg({ ...cfg, pontosFoto: n }),
                )}
                {campo(
                  'Por escrever',
                  `Vale quando o texto passa de ${cfg.minPalavras} palavras.`,
                  cfg.pontosTexto,
                  (n) => setCfg({ ...cfg, pontosTexto: n }),
                )}
                {campo(
                  'Mínimo de palavras',
                  'Abaixo disso o texto não paga bônus.',
                  cfg.minPalavras,
                  (n) => setCfg({ ...cfg, minPalavras: Math.max(1, n) }),
                  'palavras',
                )}
                {campo(
                  'Por informar altura e peso',
                  'É o dado que calibra o "Descubra seu tamanho" peça a peça.',
                  cfg.pontosMedidas,
                  (n) => setCfg({ ...cfg, pontosMedidas: n }),
                )}
                {campo(
                  'Máximo de fotos',
                  'Teto por avaliação.',
                  cfg.maxFotos,
                  (n) => setCfg({ ...cfg, maxFotos: Math.min(Math.max(1, n), 10) }),
                  'fotos',
                )}
              </div>

              <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                💡 Uma cliente que manda estrelas + foto + texto + medidas leva{' '}
                <b>{teto} pontos</b> por peça.
              </div>
            </section>

            <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="font-bold text-slate-800">Quando a peça libera</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {campo(
                  'Depois da entrega',
                  '0 = assim que o rastreio confirma que chegou.',
                  cfg.diasAposEntrega,
                  (n) => setCfg({ ...cfg, diasAposEntrega: n }),
                  'dias',
                )}
                {campo(
                  'Convite no WhatsApp',
                  'Quantos dias depois da entrega a gente CHAMA a cliente pra avaliar. É outro número do de cima de propósito: no dia da entrega ela ainda não vestiu, e "conta como ficou" sem ter usado vira mensagem ignorada e convite queimado.',
                  cfg.diasConvite,
                  (n) => setCfg({ ...cfg, diasConvite: Math.max(0, n) }),
                  'dias',
                )}
                {campo(
                  'Sem entrega confirmada',
                  'Retirada em loja e etiqueta de outro contrato nunca confirmam entrega. Sem este prazo, essas clientes jamais poderiam avaliar.',
                  cfg.diasAposPedido,
                  (n) => setCfg({ ...cfg, diasAposPedido: Math.max(1, n) }),
                  'dias',
                )}
                {campo(
                  'A peça some da fila depois de',
                  'Contado do pedido. Sem teto, quem compra há dois anos abre a tela com o histórico inteiro esperando resposta — e fila que não acaba ninguém começa.',
                  cfg.janelaDias,
                  (n) => setCfg({ ...cfg, janelaDias: Math.max(1, n) }),
                  'dias',
                )}
              </div>

              <label className="flex cursor-pointer items-start gap-3 border-t border-slate-100 pt-4">
                <input
                  type="checkbox"
                  checked={cfg.moderacao}
                  onChange={(e) => setCfg({ ...cfg, moderacao: e.target.checked })}
                  className="mt-0.5 h-5 w-5 accent-amber-600"
                />
                <div>
                  <div className="font-bold text-slate-800">Conferir antes de publicar</div>
                  <div className="text-xs text-slate-500">
                    Ligado: a avaliação nasce oculta e só aparece na PDP depois que alguém
                    aprovar aqui embaixo. A cliente é avisada de que passa por conferência.
                  </div>
                </div>
              </label>
            </section>

            <section className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="font-bold text-slate-800">Cotação do ponto</h2>
              <div className="text-xs text-slate-500">
                Quantos pontos equivalem a R$ 1 de desconto e a partir de quanto ela pode trocar.
                <b> O resgate está NO AR</b>: a cliente gera um cupom nominal (só o CPF dela usa,
                vale 90 dias) direto na conta. Feche esta régua com calma — mudar a cotação
                depois de a cliente juntar saldo é quebra de promessa.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={cfg.pontosPorReal}
                  onChange={(e) =>
                    setCfg({ ...cfg, pontosPorReal: Math.max(1, Number(e.target.value) || 1) })
                  }
                  className="w-28 border-2 rounded px-3 py-2 text-lg font-bold text-center"
                />
                <span className="text-sm font-bold text-slate-600">pontos = R$ 1</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={cfg.minimoResgate}
                  onChange={(e) =>
                    setCfg({ ...cfg, minimoResgate: Math.max(1, Number(e.target.value) || 1) })
                  }
                  className="w-28 border-2 rounded px-3 py-2 text-lg font-bold text-center"
                />
                <span className="text-sm font-bold text-slate-600">
                  pontos = resgate mínimo (R$ {Math.floor(cfg.minimoResgate / Math.max(cfg.pontosPorReal, 1))})
                </span>
              </div>
              <div className="rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
                Com a régua atual, {Math.ceil(cfg.pontosPorReal / Math.max(teto, 1))} peças
                avaliadas por completo viram R$ 1 de desconto — e ela precisa de{' '}
                {Math.ceil(cfg.minimoResgate / Math.max(teto, 1))} pra fazer o primeiro resgate.
                {resumo ? ` Já foram distribuídos ${resumo.pontosDistribuidos} pontos.` : ''}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
                <h2 className="font-bold text-slate-800">O que as clientes escreveram</h2>
                <div className="flex gap-1">
                  {(['todas', 'publicada', 'oculta'] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => trocarFiltro(f)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-bold ${
                        filtro === f
                          ? 'bg-slate-800 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {f === 'todas' ? 'Todas' : f === 'publicada' ? 'No site' : 'Escondidas'}
                    </button>
                  ))}
                </div>
              </div>

              {lista.length === 0 ? (
                <p className="p-8 text-center text-sm text-slate-400">
                  Nenhuma avaliação {filtro === 'todas' ? 'ainda' : 'neste filtro'}.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {lista.map((a) => (
                    <li key={a.id} className="p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-slate-800">
                              {'★'.repeat(a.nota)}
                              <span className="text-slate-300">{'★'.repeat(5 - a.nota)}</span>
                            </span>
                            <span className="text-sm text-slate-600">
                              {a.produtoNome || a.refBase}
                            </span>
                            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                              {a.refBase}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {[
                              a.cliente,
                              [a.cor, a.tamanho].filter(Boolean).join(' · ') || null,
                              a.caimento ? ROTULO_CAIMENTO[a.caimento] || a.caimento : null,
                              a.alturaCm && a.pesoKg
                                ? `${a.alturaCm}cm/${a.pesoKg}kg${a.publicarMedidas ? '' : ' (não publica)'}`
                                : null,
                              new Date(a.data).toLocaleDateString('pt-BR'),
                              `+${a.pontos} pts`,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                          {a.texto && (
                            <p className="mt-2 whitespace-pre-line text-sm text-slate-700">
                              {a.texto}
                            </p>
                          )}
                          {a.fotos.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {a.fotos.map((url) => (
                                // Foto de cliente, hospedada no nosso R2. <img> puro
                                // porque a retaguarda não usa next/image.
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  key={url}
                                  src={url}
                                  alt=""
                                  className="h-24 w-20 rounded object-cover"
                                />
                              ))}
                            </div>
                          )}
                        </div>

                        <button
                          onClick={() =>
                            moderar(a.id, a.status === 'publicada' ? 'oculta' : 'publicada')
                          }
                          className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${
                            a.status === 'publicada'
                              ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                        >
                          {a.status === 'publicada' ? (
                            <>
                              <Eye className="w-4 h-4" /> No site
                            </>
                          ) : (
                            <>
                              <EyeOff className="w-4 h-4" /> Escondida
                            </>
                          )}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
