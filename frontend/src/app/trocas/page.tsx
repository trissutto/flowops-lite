'use client';

/**
 * /trocas — PORTAL DE TROCAS público (sem login) do e-commerce.
 *
 * A cliente localiza o pedido com nº + CPF/e-mail e faz tudo sozinha:
 *   1. Localizar pedido
 *   2. Selecionar peças (mostra o VALOR PAGO por item, não o preço atual)
 *   3. Motivo
 *   4. Declaração (checkboxes obrigatórios da política)
 *   5. Resultado: reversa grátis (código chega por e-mail) OU endereço
 *      de devolução + campo pra informar o rastreio.
 *
 * Também mostra o histórico/status de trocas já abertas do pedido.
 * Estilo: mesmo padrão do /cadastro-live (Tailwind puro, mobile-first,
 * paleta clara com dourado).
 */

import { useState } from 'react';
import { api } from '@/lib/api';

// ── Tipos (espelham o retorno do backend) ────────────────────────────

type OrderItem = {
  sku: string;
  productName: string;
  qty: number;
  valorOriginalUnit: number;
  valorPagoUnit: number;
  totalPago: number;
  jaSolicitado: number;
  disponivel: number;
};

type TrocaPublica = {
  id: string;
  numero: string;
  origem: string | null;
  podeNovaTroca: boolean;
  status: string;
  motivo: string;
  valorTotalPago: number;
  reversaGratis: boolean;
  reversaCodigo: string | null;
  reversaPrazo: string | null;
  clienteTrackingCode: string | null;
  createdAt: string;
  // Fase 2
  decisao: string | null;
  novaSku: string | null;
  novaProductName: string | null;
  novaCor: string | null;
  novaTamanho: string | null;
  valeCode: string | null;
  valeValidade: string | null;
  reembolsoForma: string | null;
  envioTrackingCode: string | null;
  items: Array<{ sku: string; productName: string; qty: number; totalPago: number }>;
  timeline: Array<{ tipo: string; descricao: string; statusPara: string | null; createdAt: string }>;
};

type Variacao = { sku: string; nome: string; cor: string; tamanho: string; disponivel: number };
type GradeVariacoes = {
  ok: boolean;
  motivo?: string;
  atual?: { codigo: string; cor: string | null; tamanho: string | null };
  variacoes: Variacao[];
};

type Localizado = {
  wcOrderId: number;
  wcOrderNumber: string;
  status: string;
  customerName: string | null;
  prazo: {
    prazoDias: number;
    via: 'rastreio' | 'data_pedido' | 'nao_verificado';
    entregue: boolean;
    deliveredAt: string | null;
    diasDesdeEntrega: number | null;
    dentroDoPrazo: boolean;
    trackingCode: string | null;
  };
  reversaGratisDisponivel: boolean;
  items: OrderItem[];
  motivos: string[];
  trocas: TrocaPublica[];
};

type ResultadoSolicitacao = {
  ok: boolean;
  numero: string;
  status: string;
  reversaGratis: boolean;
  valorTotalPago: number;
  enderecoDevolucao: {
    destinatario: string;
    endereco: string;
    bairro: string;
    cidadeUf: string;
    cep: string;
  } | null;
  mensagem: string;
};

const STATUS_LABEL: Record<string, string> = {
  solicitada: 'Solicitada',
  aguardando_postagem: 'Aguardando postagem',
  aguardando_envio_cliente: 'Aguardando seu envio',
  postada: 'Postada',
  em_transporte: 'Em transporte',
  recebida: 'Recebida',
  em_conferencia: 'Em conferência',
  aguardando_decisao: 'Aguardando sua decisão',
  produto_reservado: 'Produto reservado',
  aguardando_pagamento_diferenca: 'Aguardando pagamento da diferença',
  reembolso_andamento: 'Reembolso em andamento',
  finalizada: 'Finalizada',
  cancelada: 'Cancelada',
};

function brl(v: number): string {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtData(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
}

function parseErr(e: any): string {
  const raw = String(e?.message || '');
  const i = raw.indexOf(': ');
  const tail = i >= 0 ? raw.slice(i + 2) : raw;
  try {
    const j = JSON.parse(tail);
    if (j?.message) return Array.isArray(j.message) ? j.message[0] : j.message;
  } catch { /* texto puro */ }
  return 'Não consegui agora. Confira os dados e tente de novo.';
}

const inputCls =
  'w-full box-border px-3.5 py-3.5 text-base rounded-xl bg-[#FCFBF7] text-[#2A2620] ' +
  'border-[1.5px] border-[#E4DDCB] outline-none transition-colors ' +
  'focus:border-[#B8912B] focus:ring-2 focus:ring-[#EBD9A6]';
const btnCls =
  'w-full py-3.5 rounded-xl font-bold text-white text-base bg-[#B8912B] hover:bg-[#8C7325] ' +
  'transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const cardCls = 'bg-white rounded-2xl border border-[#EDE7D8] shadow-sm p-5';

const DECLARACOES = [
  'O produto não foi utilizado.',
  'O produto possui etiqueta original.',
  'O produto encontra-se em perfeitas condições.',
  'Estou ciente de que a peça passará por conferência.',
  'Estou ciente de que tenho direito a 1 (uma) logística reversa gratuita por CPF, correspondente à primeira solicitação de troca.',
  'Estou ciente de que, caso já tenha utilizado a logística reversa gratuita anteriormente, os custos de envio da devolução e do reenvio da nova peça serão de minha responsabilidade, conforme a política de trocas da Lurds Plus Size.',
];

export default function PortalTrocasPage() {
  // Identificação (mantida entre passos — é a "sessão")
  const [pedido, setPedido] = useState('');
  const [doc, setDoc] = useState('');

  const [data, setData] = useState<Localizado | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Wizard de nova troca
  const [step, setStep] = useState<'busca' | 'pedido' | 'motivo' | 'declaracao' | 'fim'>('busca');
  const [sel, setSel] = useState<Record<string, number>>({}); // sku → qty
  const [motivo, setMotivo] = useState('');
  const [motivoDetalhe, setMotivoDetalhe] = useState('');
  const [checks, setChecks] = useState<boolean[]>(DECLARACOES.map(() => false));
  const [resultado, setResultado] = useState<ResultadoSolicitacao | null>(null);

  // Informar rastreio de devolução
  const [rastreioInput, setRastreioInput] = useState<Record<string, string>>({});
  const [rastreioBusy, setRastreioBusy] = useState<string | null>(null);

  // Fase 3 — troca da troca (sobre a peça recebida)
  const [novaTrocaDe, setNovaTrocaDe] = useState<string | null>(null);
  const [ntMotivo, setNtMotivo] = useState('');
  const [ntMotivoDetalhe, setNtMotivoDetalhe] = useState('');
  const [ntChecks, setNtChecks] = useState<boolean[]>(DECLARACOES.map(() => false));
  const [ntBusy, setNtBusy] = useState(false);

  async function solicitarNovamente(troca: TrocaPublica) {
    setErr(null);
    setNtBusy(true);
    try {
      const res = await api<ResultadoSolicitacao & { origem: string }>('/public/trocas/solicitar-novamente', {
        method: 'POST',
        body: JSON.stringify({
          pedido,
          doc,
          parentTrocaId: troca.id,
          motivo: ntMotivo,
          motivoDetalhe: ntMotivo === 'Outro' ? ntMotivoDetalhe : undefined,
          declaracaoAceita: ntChecks.every(Boolean),
        }),
      });
      setNovaTrocaDe(null);
      setNtMotivo('');
      setNtMotivoDetalhe('');
      setNtChecks(DECLARACOES.map(() => false));
      setResultado(res);
      setStep('fim');
    } catch (e: any) {
      setErr(parseErr(e));
    } finally {
      setNtBusy(false);
    }
  }

  // Fase 2 — escolha da solução (por troca aguardando_decisao)
  const [decidindo, setDecidindo] = useState<string | null>(null);   // trocaId com painel aberto
  const [modoDecisao, setModoDecisao] = useState<'peca' | 'vale' | 'reembolso' | null>(null);
  const [grade, setGrade] = useState<GradeVariacoes | null>(null);
  const [gradeSel, setGradeSel] = useState<string | null>(null);     // sku escolhida
  const [chavePix, setChavePix] = useState('');
  const [decisaoBusy, setDecisaoBusy] = useState(false);
  const [decisaoMsg, setDecisaoMsg] = useState<string | null>(null);

  async function abrirTrocaPeca(troca: TrocaPublica) {
    setErr(null);
    setModoDecisao('peca');
    setDecidindo(troca.id);
    setGrade(null);
    setGradeSel(null);
    try {
      const g = await api<GradeVariacoes>('/public/trocas/variacoes', {
        method: 'POST',
        body: JSON.stringify({ pedido, doc, trocaId: troca.id }),
      });
      setGrade(g);
      if (!g.ok) {
        setModoDecisao(null);
        setErr(
          g.motivo === 'multi_itens'
            ? 'Troca com mais de uma peça: escolha vale-compras ou reembolso (ou fale com a gente no WhatsApp).'
            : 'Não achamos variações dessa peça — escolha vale-compras ou reembolso.',
        );
      }
    } catch (e: any) {
      setErr(parseErr(e));
      setModoDecisao(null);
    }
  }

  async function decidir(troca: TrocaPublica, decisao: string, novaSku?: string) {
    setErr(null);
    setDecisaoBusy(true);
    try {
      const res = await api<{ ok: boolean; mensagem: string }>('/public/trocas/decidir', {
        method: 'POST',
        body: JSON.stringify({ pedido, doc, trocaId: troca.id, decisao, novaSku, chavePix: chavePix || undefined }),
      });
      setDecisaoMsg(res.mensagem);
      setDecidindo(null);
      setModoDecisao(null);
      setChavePix('');
      await localizar();
    } catch (e: any) {
      setErr(parseErr(e));
    } finally {
      setDecisaoBusy(false);
    }
  }

  async function localizar(e?: React.FormEvent) {
    e?.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const res = await api<Localizado>('/public/trocas/localizar', {
        method: 'POST',
        body: JSON.stringify({ pedido, doc }),
      });
      setData(res);
      setStep('pedido');
      setSel({});
      setResultado(null);
    } catch (e: any) {
      setErr(parseErr(e));
    } finally {
      setLoading(false);
    }
  }

  const selecionados = data
    ? data.items.filter((it) => (sel[it.sku] || 0) > 0)
    : [];
  const totalSelecionado = selecionados.reduce(
    (s, it) => s + it.valorPagoUnit * (sel[it.sku] || 0),
    0,
  );
  const todasChecadas = checks.every(Boolean);

  async function enviarSolicitacao() {
    if (!data) return;
    setErr(null);
    setLoading(true);
    try {
      const res = await api<ResultadoSolicitacao>('/public/trocas/solicitar', {
        method: 'POST',
        body: JSON.stringify({
          pedido,
          doc,
          items: selecionados.map((it) => ({ sku: it.sku, qty: sel[it.sku] })),
          motivo,
          motivoDetalhe: motivo === 'Outro' ? motivoDetalhe : undefined,
          declaracaoAceita: todasChecadas,
        }),
      });
      setResultado(res);
      setStep('fim');
    } catch (e: any) {
      setErr(parseErr(e));
    } finally {
      setLoading(false);
    }
  }

  async function informarRastreio(troca: TrocaPublica) {
    const code = (rastreioInput[troca.id] || '').trim();
    if (code.length < 8) {
      setErr('Código de rastreio inválido.');
      return;
    }
    setErr(null);
    setRastreioBusy(troca.id);
    try {
      await api('/public/trocas/rastreio', {
        method: 'POST',
        body: JSON.stringify({ pedido, doc, trocaId: troca.id, trackingCode: code }),
      });
      await localizar(); // recarrega histórico
    } catch (e: any) {
      setErr(parseErr(e));
    } finally {
      setRastreioBusy(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#FAFAF7] px-4 py-8">
      <div className="max-w-lg mx-auto">
        {/* Cabeçalho */}
        <div className="text-center mb-6">
          <div className="text-2xl font-extrabold text-[#8C7325]">Lurd&apos;s Plus Size</div>
          <h1 className="text-lg font-bold text-[#2A2620] mt-1">Portal de Trocas</h1>
          <p className="text-sm text-[#6B6456] mt-1">
            Troque suas peças do site sem burocracia 💛
          </p>
        </div>

        {err && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-[#FDECEC] border border-[#E9B4B4] text-[#8C2B2B] text-sm">
            {err}
          </div>
        )}
        {decisaoMsg && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-[#EAF6EE] border border-[#BBDFC7] text-[#2E7D46] text-sm font-bold">
            {decisaoMsg}
          </div>
        )}

        {/* PASSO 1 — localizar pedido */}
        {step === 'busca' && (
          <form onSubmit={localizar} className={cardCls}>
            <label className="block mb-3.5">
              <span className="block text-[13px] font-bold text-[#6B6456] mb-1.5">
                Número do pedido
              </span>
              <input
                className={inputCls}
                inputMode="numeric"
                placeholder="Ex.: 12345"
                value={pedido}
                onChange={(e) => setPedido(e.target.value)}
                required
              />
            </label>
            <label className="block mb-5">
              <span className="block text-[13px] font-bold text-[#6B6456] mb-1.5">
                CPF ou e-mail usado na compra
              </span>
              <input
                className={inputCls}
                placeholder="000.000.000-00 ou email@exemplo.com"
                value={doc}
                onChange={(e) => setDoc(e.target.value)}
                required
              />
            </label>
            <button type="submit" className={btnCls} disabled={loading}>
              {loading ? 'Localizando…' : 'Localizar pedido'}
            </button>
          </form>
        )}

        {/* PASSO 2 — pedido localizado: histórico + seleção de itens */}
        {data && step === 'pedido' && (
          <div className="space-y-4">
            <div className={cardCls}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[13px] text-[#6B6456]">Pedido</div>
                  <div className="text-lg font-extrabold text-[#2A2620]">
                    #{data.wcOrderNumber}
                  </div>
                  {data.customerName && (
                    <div className="text-sm text-[#6B6456]">{data.customerName}</div>
                  )}
                </div>
                <div className="text-right">
                  {data.prazo.dentroDoPrazo ? (
                    <span className="inline-block px-3 py-1 rounded-full bg-[#EAF6EE] text-[#2E7D46] text-xs font-bold">
                      Dentro do prazo
                    </span>
                  ) : (
                    <span className="inline-block px-3 py-1 rounded-full bg-[#FDECEC] text-[#8C2B2B] text-xs font-bold">
                      Fora do prazo
                    </span>
                  )}
                  {data.prazo.via === 'rastreio' && data.prazo.deliveredAt && (
                    <div className="text-[11px] text-[#6B6456] mt-1">
                      Entregue em {fmtData(data.prazo.deliveredAt)}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Trocas já abertas (histórico) */}
            {data.trocas.length > 0 && (
              <div className={cardCls}>
                <div className="font-bold text-[#2A2620] mb-3">Suas trocas deste pedido</div>
                <div className="space-y-4">
                  {data.trocas.map((t) => (
                    <div key={t.id} className="border border-[#EDE7D8] rounded-xl p-3.5">
                      <div className="flex items-center justify-between">
                        <span className="font-extrabold text-[#8C7325]">
                          {t.numero}
                          {t.origem && (
                            <span className="ml-1.5 text-[11px] font-bold text-[#A79F8E]">
                              (troca da {t.origem})
                            </span>
                          )}
                        </span>
                        <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-[#FBF6E6] text-[#8C7325]">
                          {STATUS_LABEL[t.status] || t.status}
                        </span>
                      </div>
                      <div className="text-sm text-[#6B6456] mt-1">
                        {t.items.map((it) => `${it.qty}× ${it.productName}`).join(' · ')}
                      </div>
                      <div className="text-sm font-bold text-[#2A2620] mt-1">
                        Valor da troca: {brl(t.valorTotalPago)}
                      </div>

                      {t.reversaCodigo && (
                        <div className="mt-2 text-sm bg-[#FBF6E6] rounded-lg px-3 py-2">
                          Código de postagem: <b>{t.reversaCodigo}</b>
                          {t.reversaPrazo && <> · válido até {fmtData(t.reversaPrazo)}</>}
                        </div>
                      )}

                      {/* Envio por conta da cliente → campo de rastreio */}
                      {t.status === 'aguardando_envio_cliente' && !t.clienteTrackingCode && (
                        <div className="mt-3">
                          <div className="text-[13px] font-bold text-[#6B6456] mb-1.5">
                            Já postou? Informe o código de rastreio:
                          </div>
                          <div className="flex gap-2">
                            <input
                              className={inputCls + ' !py-2.5'}
                              placeholder="Ex.: BR123456789BR"
                              value={rastreioInput[t.id] || ''}
                              onChange={(e) =>
                                setRastreioInput((m) => ({ ...m, [t.id]: e.target.value }))
                              }
                            />
                            <button
                              className="px-4 rounded-xl font-bold text-white bg-[#B8912B] hover:bg-[#8C7325] disabled:opacity-50"
                              disabled={rastreioBusy === t.id}
                              onClick={() => informarRastreio(t)}
                            >
                              {rastreioBusy === t.id ? '…' : 'Enviar'}
                            </button>
                          </div>
                        </div>
                      )}
                      {t.clienteTrackingCode && (
                        <div className="mt-2 text-sm text-[#6B6456]">
                          Rastreio da devolução: <b>{t.clienteTrackingCode}</b>
                        </div>
                      )}

                      {/* FASE 2 — escolha da solução */}
                      {t.status === 'aguardando_decisao' && (
                        <div className="mt-3 bg-[#FBF6E6] border border-[#EBD9A6] rounded-xl p-3.5">
                          <div className="text-sm font-bold text-[#8C7325] mb-2">
                            🎉 Recebemos seu produto! Como você quer finalizar?
                          </div>

                          {decidindo !== t.id && (
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                className="py-2.5 rounded-lg text-[13px] font-bold text-white bg-[#B8912B] hover:bg-[#8C7325]"
                                onClick={() => abrirTrocaPeca(t)}
                              >
                                Trocar tamanho/cor
                              </button>
                              <button
                                className="py-2.5 rounded-lg text-[13px] font-bold text-white bg-[#B8912B] hover:bg-[#8C7325]"
                                onClick={() => { setDecidindo(t.id); setModoDecisao('vale'); }}
                              >
                                Vale-compras
                              </button>
                              <button
                                className="col-span-2 py-2.5 rounded-lg text-[13px] font-bold border border-[#B8912B] text-[#8C7325]"
                                onClick={() => { setDecidindo(t.id); setModoDecisao('reembolso'); }}
                              >
                                Solicitar reembolso
                              </button>
                            </div>
                          )}

                          {/* Grade tamanho×cor */}
                          {decidindo === t.id && modoDecisao === 'peca' && (
                            <div>
                              {!grade && <div className="text-sm text-[#6B6456]">Carregando opções…</div>}
                              {grade?.ok && (
                                <>
                                  <div className="text-[13px] text-[#6B6456] mb-2">
                                    Sua peça: <b>{grade.atual?.cor} · {grade.atual?.tamanho}</b>. Escolha a nova:
                                  </div>
                                  <div className="flex flex-wrap gap-2">
                                    {grade.variacoes
                                      .filter((v) => v.sku !== grade.atual?.codigo)
                                      .map((v) => (
                                        <button
                                          key={v.sku}
                                          className={
                                            'px-3 py-2 rounded-lg text-[13px] font-bold border ' +
                                            (gradeSel === v.sku
                                              ? 'border-[#B8912B] bg-white text-[#8C7325]'
                                              : 'border-[#E4DDCB] bg-white text-[#2A2620]')
                                          }
                                          onClick={() => setGradeSel(v.sku)}
                                        >
                                          {v.cor} · {v.tamanho}
                                        </button>
                                      ))}
                                  </div>
                                  {grade.variacoes.filter((v) => v.sku !== grade.atual?.codigo).length === 0 && (
                                    <div className="text-[13px] text-[#6B6456] mt-1">
                                      Nenhuma outra variação disponível agora — escolha vale-compras ou reembolso.
                                    </div>
                                  )}
                                  <div className="flex gap-2 mt-3">
                                    <button
                                      className="flex-1 py-2.5 rounded-lg text-[13px] font-bold border border-[#E4DDCB] text-[#6B6456]"
                                      onClick={() => { setDecidindo(null); setModoDecisao(null); }}
                                    >
                                      Voltar
                                    </button>
                                    <button
                                      className="flex-1 py-2.5 rounded-lg text-[13px] font-bold text-white bg-[#B8912B] disabled:opacity-50"
                                      disabled={!gradeSel || decisaoBusy}
                                      onClick={() => {
                                        const nova = grade.variacoes.find((v) => v.sku === gradeSel);
                                        const mudouCor = nova && nova.cor !== grade.atual?.cor;
                                        decidir(t, mudouCor ? 'trocar_cor' : 'trocar_tamanho', gradeSel!);
                                      }}
                                    >
                                      {decisaoBusy ? 'Reservando…' : 'Confirmar e reservar'}
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          )}

                          {/* Vale-compras */}
                          {decidindo === t.id && modoDecisao === 'vale' && (
                            <div>
                              <p className="text-[13px] text-[#2A2620]">
                                Você recebe um vale de <b>{brl(t.valorTotalPago)}</b>, válido por 90 dias,
                                pra usar no site ou em qualquer loja física.
                              </p>
                              <div className="flex gap-2 mt-3">
                                <button
                                  className="flex-1 py-2.5 rounded-lg text-[13px] font-bold border border-[#E4DDCB] text-[#6B6456]"
                                  onClick={() => { setDecidindo(null); setModoDecisao(null); }}
                                >
                                  Voltar
                                </button>
                                <button
                                  className="flex-1 py-2.5 rounded-lg text-[13px] font-bold text-white bg-[#2E7D46] disabled:opacity-50"
                                  disabled={decisaoBusy}
                                  onClick={() => decidir(t, 'vale')}
                                >
                                  {decisaoBusy ? 'Gerando…' : 'Quero o vale-compras'}
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Reembolso */}
                          {decidindo === t.id && modoDecisao === 'reembolso' && (
                            <div>
                              <p className="text-[13px] text-[#2A2620]">
                                Reembolso de <b>{brl(t.valorTotalPago)}</b> na forma de pagamento da compra.
                                Se você pagou via <b>PIX</b>, informe sua chave:
                              </p>
                              <input
                                className={inputCls + ' !py-2.5 mt-2'}
                                placeholder="Chave PIX (CPF, celular, e-mail…)"
                                value={chavePix}
                                onChange={(e) => setChavePix(e.target.value)}
                              />
                              <div className="flex gap-2 mt-3">
                                <button
                                  className="flex-1 py-2.5 rounded-lg text-[13px] font-bold border border-[#E4DDCB] text-[#6B6456]"
                                  onClick={() => { setDecidindo(null); setModoDecisao(null); }}
                                >
                                  Voltar
                                </button>
                                <button
                                  className="flex-1 py-2.5 rounded-lg text-[13px] font-bold text-white bg-[#B8912B] disabled:opacity-50"
                                  disabled={decisaoBusy}
                                  onClick={() => decidir(t, 'reembolso')}
                                >
                                  {decisaoBusy ? 'Enviando…' : 'Solicitar reembolso'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* FASE 2 — andamento após a decisão */}
                      {t.status === 'produto_reservado' && t.novaProductName && (
                        <div className="mt-2 text-sm bg-[#EAF6EE] rounded-lg px-3 py-2 text-[#2E7D46]">
                          ✅ Nova peça reservada: <b>{t.novaProductName}</b> ({t.novaCor} · {t.novaTamanho}).
                          Em breve enviaremos com o rastreio.
                        </div>
                      )}
                      {t.valeCode && (
                        <div className="mt-2 text-sm bg-[#FBF6E6] rounded-lg px-3 py-2">
                          🎁 Vale-compras: <b>{t.valeCode}</b> · {brl(t.valorTotalPago)}
                          {t.valeValidade && <> · válido até {fmtData(t.valeValidade)}</>}
                        </div>
                      )}
                      {t.status === 'reembolso_andamento' && (
                        <div className="mt-2 text-sm bg-[#FBF6E6] rounded-lg px-3 py-2">
                          💰 Reembolso em andamento ({(t.reembolsoForma || '').toUpperCase()}).
                        </div>
                      )}
                      {t.envioTrackingCode && (
                        <div className="mt-2 text-sm bg-[#EAF6EE] rounded-lg px-3 py-2 text-[#2E7D46]">
                          📦 Nova peça enviada! Rastreio: <b>{t.envioTrackingCode}</b>
                        </div>
                      )}

                      {/* FASE 3 — troca da troca */}
                      {t.podeNovaTroca && novaTrocaDe !== t.id && (
                        <button
                          className="mt-3 w-full py-2.5 rounded-lg text-[13px] font-bold border border-[#B8912B] text-[#8C7325] hover:bg-[#FBF6E6]"
                          onClick={() => { setNovaTrocaDe(t.id); setNtMotivo(''); setNtChecks(DECLARACOES.map(() => false)); }}
                        >
                          🔁 Trocar a peça recebida ({t.novaCor} · {t.novaTamanho})
                        </button>
                      )}
                      {novaTrocaDe === t.id && (
                        <div className="mt-3 border border-[#EBD9A6] bg-[#FBF6E6] rounded-xl p-3.5">
                          <div className="text-sm font-bold text-[#8C7325] mb-2">
                            Nova troca da peça {t.novaProductName} ({t.novaCor} · {t.novaTamanho})
                          </div>
                          <select
                            className={inputCls + ' !py-2.5 mb-2'}
                            value={ntMotivo}
                            onChange={(e) => setNtMotivo(e.target.value)}
                          >
                            <option value="">Motivo da troca…</option>
                            {(data?.motivos || []).map((m) => <option key={m} value={m}>{m}</option>)}
                          </select>
                          {ntMotivo === 'Outro' && (
                            <textarea
                              className={inputCls + ' !py-2.5 mb-2'}
                              rows={2}
                              placeholder="Conta pra gente o que aconteceu…"
                              value={ntMotivoDetalhe}
                              onChange={(e) => setNtMotivoDetalhe(e.target.value)}
                            />
                          )}
                          <div className="space-y-1.5 mb-3">
                            {DECLARACOES.map((d, i) => (
                              <label key={i} className="flex items-start gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="mt-0.5 accent-[#B8912B]"
                                  checked={ntChecks[i]}
                                  onChange={(e) => setNtChecks((c) => c.map((v, j) => (j === i ? e.target.checked : v)))}
                                />
                                <span className="text-[12px] text-[#2A2620]">{d}</span>
                              </label>
                            ))}
                          </div>
                          <div className="flex gap-2">
                            <button
                              className="flex-1 py-2.5 rounded-lg text-[13px] font-bold border border-[#E4DDCB] text-[#6B6456]"
                              onClick={() => setNovaTrocaDe(null)}
                            >
                              Cancelar
                            </button>
                            <button
                              className="flex-1 py-2.5 rounded-lg text-[13px] font-bold text-white bg-[#B8912B] disabled:opacity-50"
                              disabled={ntBusy || !ntMotivo || !ntChecks.every(Boolean) || (ntMotivo === 'Outro' && ntMotivoDetalhe.trim().length < 3)}
                              onClick={() => solicitarNovamente(t)}
                            >
                              {ntBusy ? 'Enviando…' : 'Solicitar troca'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Linha do tempo */}
                      <details className="mt-2">
                        <summary className="text-[13px] text-[#8C7325] font-bold cursor-pointer">
                          Ver histórico
                        </summary>
                        <ul className="mt-2 space-y-1.5">
                          {t.timeline.map((ev, i) => (
                            <li key={i} className="text-[13px] text-[#6B6456] flex gap-2">
                              <span className="text-[#B8912B]">•</span>
                              <span>
                                <b>{fmtData(ev.createdAt)}</b> — {ev.descricao}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Nova solicitação */}
            {data.prazo.dentroDoPrazo ? (
              <div className={cardCls}>
                <div className="font-bold text-[#2A2620] mb-1">Solicitar nova troca</div>
                <p className="text-[13px] text-[#6B6456] mb-3">
                  Selecione as peças. O valor considerado é o que você{' '}
                  <b>efetivamente pagou</b> por cada peça (com promoções e descontos).
                </p>
                <div className="space-y-3">
                  {data.items.map((it) => (
                    <div
                      key={it.sku}
                      className={
                        'border rounded-xl p-3.5 ' +
                        (it.disponivel === 0
                          ? 'border-[#EDE7D8] opacity-50'
                          : (sel[it.sku] || 0) > 0
                            ? 'border-[#B8912B] bg-[#FBF6E6]'
                            : 'border-[#EDE7D8]')
                      }
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-bold text-[#2A2620] text-sm truncate">
                            {it.productName}
                          </div>
                          <div className="text-[13px] text-[#6B6456]">
                            {it.valorPagoUnit < it.valorOriginalUnit && (
                              <span className="line-through mr-1.5">
                                {brl(it.valorOriginalUnit)}
                              </span>
                            )}
                            <b className="text-[#2A2620]">{brl(it.valorPagoUnit)}</b> pago/un
                            {it.disponivel === 0 && ' · troca em andamento'}
                          </div>
                        </div>
                        {it.disponivel > 0 && (
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              className="w-9 h-9 rounded-lg border border-[#E4DDCB] font-bold text-[#8C7325]"
                              onClick={() =>
                                setSel((m) => ({
                                  ...m,
                                  [it.sku]: Math.max(0, (m[it.sku] || 0) - 1),
                                }))
                              }
                            >
                              −
                            </button>
                            <span className="w-6 text-center font-bold">{sel[it.sku] || 0}</span>
                            <button
                              className="w-9 h-9 rounded-lg border border-[#E4DDCB] font-bold text-[#8C7325]"
                              onClick={() =>
                                setSel((m) => ({
                                  ...m,
                                  [it.sku]: Math.min(it.disponivel, (m[it.sku] || 0) + 1),
                                }))
                              }
                            >
                              +
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {selecionados.length > 0 && (
                  <div className="mt-4 flex items-center justify-between text-sm font-bold text-[#2A2620]">
                    <span>Valor elegível pra troca:</span>
                    <span className="text-[#2E7D46] text-base">{brl(totalSelecionado)}</span>
                  </div>
                )}

                <button
                  className={btnCls + ' mt-4'}
                  disabled={selecionados.length === 0}
                  onClick={() => setStep('motivo')}
                >
                  Continuar
                </button>
              </div>
            ) : (
              <div className={cardCls + ' text-center'}>
                <div className="text-3xl mb-2">😔</div>
                <p className="text-sm text-[#2A2620] font-bold">
                  Infelizmente este pedido não está mais dentro do prazo para troca.
                </p>
                <p className="text-[13px] text-[#6B6456] mt-2">
                  O prazo é de {data.prazo.prazoDias} dias corridos após o recebimento.
                  Dúvidas? Fale com a gente no WhatsApp (13) 99625-6238.
                </p>
              </div>
            )}

            <button
              className="w-full text-center text-sm text-[#6B6456] underline"
              onClick={() => { setStep('busca'); setData(null); }}
            >
              Consultar outro pedido
            </button>
          </div>
        )}

        {/* PASSO 3 — motivo */}
        {data && step === 'motivo' && (
          <div className={cardCls}>
            <div className="font-bold text-[#2A2620] mb-3">Qual o motivo da troca?</div>
            <div className="space-y-2">
              {data.motivos.map((m) => (
                <label
                  key={m}
                  className={
                    'flex items-center gap-3 border rounded-xl px-3.5 py-3 cursor-pointer ' +
                    (motivo === m ? 'border-[#B8912B] bg-[#FBF6E6]' : 'border-[#EDE7D8]')
                  }
                >
                  <input
                    type="radio"
                    name="motivo"
                    className="accent-[#B8912B]"
                    checked={motivo === m}
                    onChange={() => setMotivo(m)}
                  />
                  <span className="text-sm text-[#2A2620]">{m}</span>
                </label>
              ))}
            </div>
            {motivo === 'Outro' && (
              <textarea
                className={inputCls + ' mt-3'}
                rows={3}
                placeholder="Conta pra gente o que aconteceu…"
                value={motivoDetalhe}
                onChange={(e) => setMotivoDetalhe(e.target.value)}
              />
            )}
            <div className="flex gap-3 mt-5">
              <button
                className="flex-1 py-3.5 rounded-xl font-bold border border-[#E4DDCB] text-[#6B6456]"
                onClick={() => setStep('pedido')}
              >
                Voltar
              </button>
              <button
                className={btnCls + ' flex-1'}
                disabled={!motivo || (motivo === 'Outro' && motivoDetalhe.trim().length < 3)}
                onClick={() => setStep('declaracao')}
              >
                Continuar
              </button>
            </div>
          </div>
        )}

        {/* PASSO 4 — declaração */}
        {data && step === 'declaracao' && (
          <div className={cardCls}>
            <div className="font-bold text-[#2A2620] mb-1">Declaração</div>
            <p className="text-[13px] text-[#6B6456] mb-3">
              Antes de continuar, confirme cada item:
            </p>
            <div className="space-y-2.5">
              {DECLARACOES.map((d, i) => (
                <label key={i} className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 w-4.5 h-4.5 accent-[#B8912B]"
                    checked={checks[i]}
                    onChange={(e) =>
                      setChecks((c) => c.map((v, j) => (j === i ? e.target.checked : v)))
                    }
                  />
                  <span className="text-[13px] text-[#2A2620]">{d}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-3 mt-5">
              <button
                className="flex-1 py-3.5 rounded-xl font-bold border border-[#E4DDCB] text-[#6B6456]"
                onClick={() => setStep('motivo')}
              >
                Voltar
              </button>
              <button
                className={btnCls + ' flex-1'}
                disabled={!todasChecadas || loading}
                onClick={enviarSolicitacao}
              >
                {loading ? 'Enviando…' : 'Solicitar troca'}
              </button>
            </div>
          </div>
        )}

        {/* PASSO 5 — resultado */}
        {resultado && step === 'fim' && (
          <div className={cardCls + ' text-center'}>
            <div className="text-4xl mb-2">💛</div>
            <div className="text-lg font-extrabold text-[#2A2620]">
              Troca {resultado.numero} solicitada!
            </div>
            <p className="text-sm text-[#6B6456] mt-2">{resultado.mensagem}</p>
            <div className="mt-3 text-sm font-bold text-[#2A2620]">
              Valor elegível: <span className="text-[#2E7D46]">{brl(resultado.valorTotalPago)}</span>
            </div>

            {resultado.enderecoDevolucao && (
              <div className="mt-4 text-left bg-[#FBF6E6] border border-[#EBD9A6] rounded-xl p-4">
                <div className="text-[13px] font-bold text-[#8C7325] mb-2">
                  ⚠️ Endereço para envio (por sua conta):
                </div>
                <div className="text-sm text-[#2A2620] leading-relaxed">
                  <b>{resultado.enderecoDevolucao.destinatario}</b>
                  <br />
                  {resultado.enderecoDevolucao.endereco}
                  <br />
                  {resultado.enderecoDevolucao.bairro} — {resultado.enderecoDevolucao.cidadeUf}
                  <br />
                  CEP {resultado.enderecoDevolucao.cep}
                </div>
                <div className="text-[13px] text-[#6B6456] mt-2">
                  Depois de postar, volte aqui e informe o código de rastreio na sua troca.
                </div>
              </div>
            )}

            <button className={btnCls + ' mt-5'} onClick={() => localizar()}>
              Ver minhas trocas
            </button>
          </div>
        )}

        <p className="text-center text-[11px] text-[#A79F8E] mt-6">
          Dúvidas? WhatsApp (13) 99625-6238 · Política de trocas Lurd&apos;s Plus Size
        </p>
      </div>
    </div>
  );
}
