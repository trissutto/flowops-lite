'use client';

/**
 * /retaguarda/inventario/[id] — a conferência da matriz.
 *
 * A tela é ordenada pelo DINHEIRO, não pelo código: 1 peça de R$ 180 importa
 * mais que 4 de R$ 9, e é por aí que a recontagem começa.
 *
 * Três coisas que esta tela precisa dizer com clareza, porque cada uma já
 * causou um estrago quando ficou implícita:
 *
 *  1. SOBRA COM MOTIVO. Peça marcada, card do site já bipado e caixa de
 *     remessa fechada saem do saldo com a peça ainda na arara. Contar essas
 *     peças gera sobra, e aplicar a sobra devolve ao estoque peça que já é de
 *     alguém. Quando há explicação, a linha diz qual é.
 *  2. NÃO CONTADO NÃO ZERA SOZINHO. Fica numa lista à parte, por decisão do
 *     dono: arara que ninguém contou tem a mesma cara de peça que sumiu.
 *  3. O AJUSTE É DELTA. O texto do botão diz isso, porque quem opera precisa
 *     saber que a venda feita durante a contagem não vai ser desfeita.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import {
  ArrowLeft, Loader2, AlertTriangle, CheckCircle2, RotateCcw, PackageSearch, Trash2, Info,
} from 'lucide-react';

type Sessao = {
  id: string;
  storeCode: string;
  status: string;
  abertaEm: string;
  abertaPor: string | null;
  encerradaEm: string | null;
  aplicadaEm: string | null;
  aplicadaPor: string | null;
  nota: string | null;
};

type ForaDoSaldo = { marcado: number; cardBipado: number; remessa: number } | null;

type Divergencia = {
  sku: string;
  rotulo: string | null;
  contado: number;
  esperado: number;
  delta: number;
  situacao: 'faltou' | 'sobrou' | 'confere';
  pecas: number;
  valor: number | null;
  recontar: boolean;
  recontarPedidoEm: string | null;
  rodada: number;
  congeladoEm: string | null;
  jaAjustado: boolean;
  foraDoSaldo: ForaDoSaldo;
  sobraExplicada: boolean;
};

type NaoContado = {
  sku: string;
  rotulo: string | null;
  saldo: number;
  custo: number | null;
  valor: number | null;
};

type Ajuste = {
  id: string;
  sku: string;
  rotulo: string | null;
  contado: number;
  esperado: number;
  delta: number;
  tipo: string;
  antes: number | null;
  depois: number | null;
  aplicado: boolean;
  erro: string | null;
  criadoEm: string;
  criadoPor: string | null;
};

type Relatorio = {
  sessao: Sessao;
  resumo: {
    skus: number;
    pecasContadas: number;
    skusConferem: number;
    skusFaltou: number;
    pecasFaltou: number;
    valorFaltou: number;
    skusSobrou: number;
    pecasSobrou: number;
    valorSobrou: number;
    pecasLiquido: number;
    valorLiquido: number;
    semCusto: number;
    naoContadosSkus: number;
    naoContadosPecas: number;
    naoContadosValor: number;
    naoCadastrados: number;
    pedidosDeRecontagem: number;
  };
  divergencias: Divergencia[];
  naoContados: NaoContado[];
  naoCadastrados: Array<{ sku: string; contado: number }>;
  vistasDivergentes: Array<{ sku: string; rotulo: string | null; base: number; vitrine: number }>;
  ajustes: Ajuste[];
};

const brl = (v: number | null) =>
  v == null
    ? '—'
    : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });

const data = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

type Aba = 'divergencias' | 'naoContados' | 'semCadastro' | 'ajustes';

export default function InventarioDetalhePage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id || '');

  const [rel, setRel] = useState<Relatorio | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [aba, setAba] = useState<Aba>('divergencias');
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [marcadosZerar, setMarcadosZerar] = useState<Set<string>>(new Set());
  const [ocupado, setOcupado] = useState(false);
  const [confirmar, setConfirmar] = useState<'aplicar' | 'zerar' | null>(null);
  const [motivoZerar, setMotivoZerar] = useState('');

  const carregar = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api<Relatorio>(`/inventario/${id}`);
      setRel(r);
      setErro(null);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar o inventário');
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const acao = useCallback(
    async (caminho: string, body?: unknown, sucesso?: string) => {
      setOcupado(true);
      setErro(null);
      setAviso(null);
      try {
        const r = await api<{
          aplicados?: number;
          total?: number;
          falhas?: number;
          pulados?: number;
          erro?: string | null;
          zerados?: number;
          pedidos?: number;
          mensagem?: string;
        }>(`/inventario/${id}${caminho}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
        setMarcados(new Set());
        setMarcadosZerar(new Set());
        setConfirmar(null);
        await carregar();
        const espera = r?.pulados
          ? ` ${r.pulados} código(s) ficaram de fora porque estão esperando a recontagem da loja.`
          : '';
        if (r?.falhas) {
          setAviso(
            `${r.aplicados} de ${r.total} ajustes entraram. ${r.falhas} não entraram (${r.erro || 'motivo não informado'}) — clique em Aplicar de novo pra tentar só esses.${espera}`,
          );
        } else if (r?.mensagem) {
          setAviso(r.mensagem);
        } else if (sucesso) {
          setAviso(sucesso + espera);
        }
      } catch (e: any) {
        setErro(e?.message || 'Não consegui completar a operação');
      } finally {
        setOcupado(false);
      }
    },
    [id, carregar],
  );

  const pendentes = useMemo(
    () => (rel?.divergencias || []).filter((d) => !d.jaAjustado && d.delta !== 0),
    [rel],
  );

  if (carregando) {
    return (
      <div className="min-h-screen bg-slate-50 p-6 flex items-center gap-2 text-slate-500 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
      </div>
    );
  }
  if (!rel) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="max-w-xl bg-red-50 border border-red-300 rounded-xl p-4 text-sm text-red-800">
          {erro || 'Inventário não encontrado'}
        </div>
      </div>
    );
  }

  const s = rel.sessao;
  const r = rel.resumo;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <Link href="/retaguarda/inventario" className="p-2 hover:bg-slate-100 rounded-lg">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <PackageSearch className="w-5 h-5 text-slate-700" />
          <div>
            <h1 className="font-black text-slate-800 uppercase tracking-wide text-sm">
              Inventário · loja {s.storeCode}
            </h1>
            <div className="text-[11px] text-slate-500">
              aberto {data(s.abertaEm)} · {s.status === 'aberta' ? 'a loja ainda está contando' : s.status === 'encerrada' ? 'contagem encerrada' : s.status === 'aplicada' ? `ajuste aplicado ${data(s.aplicadaEm)}` : 'cancelada'}
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            {s.status === 'aberta' && (
              <button
                onClick={() => void acao('/encerrar', {}, 'Contagem encerrada.')}
                disabled={ocupado}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white rounded-xl font-bold text-sm"
              >
                Encerrar a contagem
              </button>
            )}
            {s.status === 'encerrada' && (
              <>
                <button
                  onClick={() => void acao('/reabrir', {}, 'Contagem reaberta — a loja pode bipar.')}
                  disabled={ocupado}
                  className="px-4 py-2 bg-white border-2 border-slate-300 hover:bg-slate-50 disabled:opacity-40 rounded-xl font-bold text-sm text-slate-700"
                >
                  Voltar a contar
                </button>
                <button
                  onClick={() => setConfirmar('aplicar')}
                  disabled={ocupado || !pendentes.length}
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-40 text-white rounded-xl font-bold text-sm"
                >
                  Aplicar o ajuste ({pendentes.length})
                </button>
              </>
            )}
            {s.status === 'aplicada' && pendentes.length > 0 && (
              <button
                onClick={() => setConfirmar('aplicar')}
                disabled={ocupado}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white rounded-xl font-bold text-sm"
              >
                Tentar de novo os {pendentes.length} que faltaram
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 space-y-4">
        {erro && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-300 rounded-xl px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div className="text-sm text-red-800 font-medium">{erro}</div>
          </div>
        )}
        {aviso && (
          <div className="flex items-start gap-2 bg-blue-50 border border-blue-300 rounded-xl px-4 py-3">
            <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
            <div className="text-sm text-blue-900 font-medium">{aviso}</div>
          </div>
        )}

        {/* Resumo */}
        <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Cartao titulo="Peças contadas" valor={String(r.pecasContadas)} rodape={`${r.skus} códigos`} />
          <Cartao
            titulo="Faltou"
            valor={`${r.pecasFaltou} peças`}
            rodape={brl(r.valorFaltou)}
            tom="vermelho"
          />
          <Cartao
            titulo="Sobrou"
            valor={`${r.pecasSobrou} peças`}
            rodape={brl(r.valorSobrou)}
            tom="ambar"
          />
          <Cartao
            titulo="Diferença líquida"
            valor={`${r.pecasLiquido > 0 ? '+' : ''}${r.pecasLiquido} peças`}
            rodape={brl(r.valorLiquido)}
            tom={r.valorLiquido < 0 ? 'vermelho' : 'verde'}
          />
          <Cartao
            titulo="Não apareceu no bipe"
            valor={`${r.naoContadosPecas} peças`}
            rodape={`${r.naoContadosSkus} códigos · ${brl(r.naoContadosValor)}`}
          />
        </section>

        {s.status === 'aberta' && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900">
              A loja <b>ainda está contando</b>. A lista de &quot;não apareceu no bipe&quot; só é
              calculada depois de encerrar — agora ela seria a loja inteira.
            </div>
          </div>
        )}

        {r.semCusto > 0 && (
          <div className="text-[12px] text-slate-500">
            {r.semCusto} código(s) sem custo no cadastro — o valor em R$ está incompleto por eles.
          </div>
        )}

        {/* Abas */}
        <div className="flex gap-1 flex-wrap">
          {([
            ['divergencias', `Diferenças (${rel.divergencias.length})`],
            ['naoContados', `Não apareceu no bipe (${rel.naoContados.length})`],
            ['semCadastro', `Sem cadastro (${rel.naoCadastrados.length})`],
            ['ajustes', `Ajustes (${rel.ajustes.length})`],
          ] as Array<[Aba, string]>).map(([chave, rotulo]) => (
            <button
              key={chave}
              onClick={() => setAba(chave)}
              className={`px-3.5 py-2 rounded-xl font-bold text-[13px] border-2 ${
                aba === chave
                  ? 'bg-slate-800 border-slate-800 text-white'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {rotulo}
            </button>
          ))}
        </div>

        {aba === 'divergencias' && (
          <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-3 flex-wrap">
              <div className="text-[11px] font-black uppercase tracking-wider text-slate-500">
                Ordenado pelo dinheiro
              </div>
              {marcados.size > 0 && (
                <button
                  onClick={() =>
                    void acao(
                      '/recontagem',
                      { skus: Array.from(marcados) },
                      `Recontagem pedida pra ${marcados.size} código(s) — a tela da loja já mostra a lista.`,
                    )
                  }
                  disabled={ocupado}
                  className="ml-auto flex items-center gap-2 px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white rounded-lg font-bold text-[13px]"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Pedir recontagem ({marcados.size})
                </button>
              )}
            </div>
            {rel.divergencias.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {r.skus === 0
                  ? 'Nada contado ainda.'
                  : 'Nenhuma diferença: tudo que foi contado bate com o sistema.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-3 py-2 w-8"></th>
                      <th className="px-3 py-2 text-left">Peça</th>
                      <th className="px-3 py-2 text-right">Contou</th>
                      <th className="px-3 py-2 text-right">Sistema</th>
                      <th className="px-3 py-2 text-right">Diferença</th>
                      <th className="px-3 py-2 text-right">R$</th>
                      <th className="px-3 py-2 text-left">Observação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rel.divergencias.map((d) => (
                      <tr key={d.sku} className={d.jaAjustado ? 'opacity-50' : ''}>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={marcados.has(d.sku)}
                            onChange={(e) => {
                              const novo = new Set(marcados);
                              if (e.target.checked) novo.add(d.sku);
                              else novo.delete(d.sku);
                              setMarcados(novo);
                            }}
                            className="w-4 h-4"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-bold text-slate-800">{d.rotulo || d.sku}</div>
                          <div className="font-mono text-[11px] text-slate-400">
                            {d.sku}
                            {d.rodada > 1 && (
                              <span className="ml-2 text-amber-700 font-bold">
                                {d.rodada}ª contagem
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-bold">{d.contado}</td>
                        <td className="px-3 py-2 text-right font-mono text-slate-500">{d.esperado}</td>
                        <td
                          className={`px-3 py-2 text-right font-mono font-black ${
                            d.delta < 0 ? 'text-red-600' : 'text-amber-700'
                          }`}
                        >
                          {d.delta > 0 ? `+${d.delta}` : d.delta}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{brl(d.valor)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1.5">
                            {d.jaAjustado && (
                              <Chip tom="verde">
                                <CheckCircle2 className="w-3 h-3" /> ajustado
                              </Chip>
                            )}
                            {d.recontar && !d.jaAjustado && <Chip tom="ambar">recontar antes</Chip>}
                            {d.recontarPedidoEm && <Chip tom="azul">recontagem pedida</Chip>}
                            {d.foraDoSaldo && (
                              <Chip tom={d.sobraExplicada ? 'azul' : 'cinza'}>
                                {[
                                  d.foraDoSaldo.marcado ? `${d.foraDoSaldo.marcado} em marcado` : '',
                                  d.foraDoSaldo.cardBipado
                                    ? `${d.foraDoSaldo.cardBipado} em card bipado`
                                    : '',
                                  d.foraDoSaldo.remessa ? `${d.foraDoSaldo.remessa} em remessa` : '',
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </Chip>
                            )}
                            {d.sobraExplicada && (
                              <span className="text-[11px] text-slate-500">
                                a sobra se explica — não ajuste
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {aba === 'naoContados' && (
          <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100">
              <div className="text-[13px] text-slate-700">
                Estes códigos <b>têm saldo na loja e não apareceram em nenhum bipe</b>. Eles{' '}
                <b>não zeram sozinhos</b>: se a loja parou de contar no meio, zerar aqui apagaria
                estoque bom. Confira e zere só o que você tem certeza que não existe mais.
              </div>
              {marcadosZerar.size > 0 && (
                <button
                  onClick={() => setConfirmar('zerar')}
                  disabled={ocupado}
                  className="mt-3 flex items-center gap-2 px-3.5 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white rounded-lg font-bold text-[13px]"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Zerar {marcadosZerar.size} selecionado(s)
                </button>
              )}
            </div>
            {rel.naoContados.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {s.status === 'aberta'
                  ? 'A contagem ainda está aberta — esta lista é calculada no encerramento.'
                  : 'Todo código com saldo apareceu na contagem.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-3 py-2 w-8"></th>
                      <th className="px-3 py-2 text-left">Peça</th>
                      <th className="px-3 py-2 text-right">Saldo no sistema</th>
                      <th className="px-3 py-2 text-right">R$</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rel.naoContados.map((n) => (
                      <tr key={n.sku}>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={marcadosZerar.has(n.sku)}
                            onChange={(e) => {
                              const novo = new Set(marcadosZerar);
                              if (e.target.checked) novo.add(n.sku);
                              else novo.delete(n.sku);
                              setMarcadosZerar(novo);
                            }}
                            className="w-4 h-4"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-bold text-slate-800">{n.rotulo || n.sku}</div>
                          <div className="font-mono text-[11px] text-slate-400">{n.sku}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-bold">{n.saldo}</td>
                        <td className="px-3 py-2 text-right font-mono">{brl(n.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {aba === 'semCadastro' && (
          <section className="bg-white border border-slate-200 rounded-2xl p-4">
            <div className="text-[13px] text-slate-700 mb-3">
              Códigos bipados que <b>não existem no cadastro</b>. Eles contam na tela da loja (a fila
              não trava), mas <b>ficam fora do ajuste</b> — criar saldo de um código inexistente é
              inventar peça. Cadastre a peça e conte num inventário novo.
            </div>
            {rel.naoCadastrados.length === 0 ? (
              <div className="text-sm text-slate-500">Nenhum.</div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {rel.naoCadastrados.map((n) => (
                  <div
                    key={n.sku}
                    className="flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2"
                  >
                    <span className="font-mono font-bold text-slate-800">{n.sku}</span>
                    <span className="font-mono text-slate-500">{n.contado}×</span>
                  </div>
                ))}
              </div>
            )}

            {rel.vistasDivergentes.length > 0 && (
              <div className="mt-6">
                <div className="text-[11px] font-black uppercase tracking-wider text-slate-500 mb-2">
                  Os dois espelhos de estoque divergem nestes códigos
                </div>
                <div className="text-[12px] text-slate-600 mb-2">
                  O inventário é o único lugar que lê os dois. A conta usa a base do movimento; a
                  coluna &quot;vitrine&quot; é o número que o site e o PDV mostram.
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Peça</th>
                        <th className="px-3 py-2 text-right">Base do movimento</th>
                        <th className="px-3 py-2 text-right">Vitrine / PDV</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rel.vistasDivergentes.map((v) => (
                        <tr key={v.sku}>
                          <td className="px-3 py-2">
                            <div className="font-bold text-slate-800">{v.rotulo || v.sku}</div>
                            <div className="font-mono text-[11px] text-slate-400">{v.sku}</div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{v.base}</td>
                          <td className="px-3 py-2 text-right font-mono">{v.vitrine}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

        {aba === 'ajustes' && (
          <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            {rel.ajustes.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Nenhum ajuste aplicado ainda.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Peça</th>
                      <th className="px-3 py-2 text-right">Delta</th>
                      <th className="px-3 py-2 text-right">Antes</th>
                      <th className="px-3 py-2 text-right">Depois</th>
                      <th className="px-3 py-2 text-left">Quando</th>
                      <th className="px-3 py-2 text-left">Situação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rel.ajustes.map((a) => (
                      <tr key={a.id}>
                        <td className="px-3 py-2">
                          <div className="font-bold text-slate-800">{a.rotulo || a.sku}</div>
                          <div className="font-mono text-[11px] text-slate-400">{a.sku}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-black">
                          {a.delta > 0 ? `+${a.delta}` : a.delta}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-500">
                          {a.antes ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{a.depois ?? '—'}</td>
                        <td className="px-3 py-2 text-[12px] text-slate-500">
                          {data(a.criadoEm)}
                          {a.criadoPor ? ` · ${a.criadoPor}` : ''}
                        </td>
                        <td className="px-3 py-2">
                          {a.aplicado ? (
                            <Chip tom="verde">
                              {a.tipo === 'zerado_nao_contado' ? 'zerado' : 'aplicado'}
                            </Chip>
                          ) : (
                            <Chip tom="vermelho">não entrou: {a.erro || 'erro'}</Chip>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>

      {confirmar === 'aplicar' && (
        <Modal
          titulo="Aplicar o ajuste no estoque?"
          onFechar={() => setConfirmar(null)}
          acao={
            <button
              onClick={() => void acao('/aplicar', {}, 'Ajuste aplicado.')}
              disabled={ocupado}
              className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-40 text-white rounded-lg font-bold text-sm"
            >
              {ocupado ? 'Aplicando…' : 'Aplicar agora'}
            </button>
          }
        >
          <p className="text-sm text-slate-700">
            Vão entrar <b>{pendentes.length}</b> movimentos: entrada onde a loja contou mais, saída
            onde contou menos.
          </p>
          <p className="text-sm text-slate-700">
            O que vai pro estoque é a <b>diferença</b> contra o saldo congelado no primeiro bipe de
            cada código — as vendas feitas durante a contagem <b>não são desfeitas</b>.
          </p>
          <p className="text-sm text-slate-600">
            Tudo fica registrado no histórico da peça e some da lista de peça extraviada. Códigos que
            você mandou recontar continuam na lista até a loja recontar.
          </p>
        </Modal>
      )}

      {confirmar === 'zerar' && (
        <Modal
          titulo={`Zerar ${marcadosZerar.size} código(s)?`}
          onFechar={() => setConfirmar(null)}
          acao={
            <button
              onClick={() =>
                void acao(
                  '/zerar-nao-contados',
                  { skus: Array.from(marcadosZerar), motivo: motivoZerar },
                  'Códigos zerados.',
                )
              }
              disabled={ocupado || !motivoZerar.trim()}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white rounded-lg font-bold text-sm"
            >
              {ocupado ? 'Zerando…' : 'Zerar'}
            </button>
          }
        >
          <p className="text-sm text-slate-700">
            O saldo desses códigos na loja {s.storeCode} vai a zero. Some da Consulta, do balcão e do
            site.
          </p>
          <label className="block text-xs font-bold text-slate-600 mt-2 mb-1">
            Por quê? (fica no histórico)
          </label>
          <input
            value={motivoZerar}
            onChange={(e) => setMotivoZerar(e.target.value)}
            placeholder="ex.: loja contou a arara inteira, peça não existe mais"
            className="w-full h-10 px-3 border-2 border-slate-300 rounded-lg text-sm"
          />
        </Modal>
      )}
    </div>
  );
}

function Cartao({
  titulo,
  valor,
  rodape,
  tom = 'neutro',
}: {
  titulo: string;
  valor: string;
  rodape?: string;
  tom?: 'neutro' | 'vermelho' | 'ambar' | 'verde';
}) {
  const cor =
    tom === 'vermelho'
      ? 'text-red-700'
      : tom === 'ambar'
        ? 'text-amber-700'
        : tom === 'verde'
          ? 'text-emerald-700'
          : 'text-slate-800';
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-3">
      <div className="text-[10px] font-black uppercase tracking-wider text-slate-500">{titulo}</div>
      <div className={`font-black text-xl mt-0.5 ${cor}`}>{valor}</div>
      {rodape && <div className="text-[11px] text-slate-500 font-mono">{rodape}</div>}
    </div>
  );
}

function Chip({
  children,
  tom,
}: {
  children: React.ReactNode;
  tom: 'verde' | 'ambar' | 'azul' | 'vermelho' | 'cinza';
}) {
  const cores: Record<string, string> = {
    verde: 'bg-emerald-50 border-emerald-300 text-emerald-800',
    ambar: 'bg-amber-50 border-amber-300 text-amber-800',
    azul: 'bg-blue-50 border-blue-300 text-blue-800',
    vermelho: 'bg-red-50 border-red-300 text-red-800',
    cinza: 'bg-slate-50 border-slate-300 text-slate-600',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold ${cores[tom]}`}
    >
      {children}
    </span>
  );
}

function Modal({
  titulo,
  children,
  acao,
  onFechar,
}: {
  titulo: string;
  children: React.ReactNode;
  acao: React.ReactNode;
  onFechar: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl max-w-lg w-full p-5 space-y-2">
        <div className="font-black text-slate-800 text-lg">{titulo}</div>
        {children}
        <div className="flex gap-2 justify-end pt-3">
          <button
            onClick={onFechar}
            className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg font-bold text-sm"
          >
            Cancelar
          </button>
          {acao}
        </div>
      </div>
    </div>
  );
}
