'use client';

import { useState } from 'react';
import { AlertCircle, ArrowLeft, Check, Loader2, PackageOpen } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn, formatPrice } from '@/lib/utils';
import type { ItemTrocavel, PedidoDetalhe, PedidoResumo, TrocaResumo } from '@/lib/trocas';

/**
 * PORTAL DE TROCAS — o fluxo inteiro em uma tela, sem recarregar.
 *
 * Quatro passos, e a cliente logada pula o primeiro:
 *   1. quem é você        (só visitante — logada já vem identificada)
 *   2. qual pedido
 *   3. quais peças + por quê
 *   4. pronto — o que acontece agora
 *
 * ── DECISÕES QUE IMPORTAM ──
 *
 * **Um passo por tela.** Pedir peça, quantidade e motivo de uma vez numa
 * página só é o desenho que faz desistir. Cada tela responde uma pergunta.
 *
 * **A regra é do backend, sempre.** Prazo, direito à reversa grátis, quanto
 * de cada peça ainda pode ser trocado — tudo vem do FlowOps. Esta tela nunca
 * decide, só mostra. Recalcular aqui criaria duas políticas divergindo.
 *
 * **Erro do backend aparece como está.** Ele escreve pra cliente ("fora do
 * prazo de 7 dias"), e reescrever isso aqui só pioraria.
 */

type Passo = 'identificar' | 'pedidos' | 'itens' | 'pronto';

interface Props {
  logada: boolean;
  pedidosIniciais: PedidoResumo[];
}

interface MotivoOpcao {
  id: string;
  label: string;
}

/** O portal manda motivos como objeto OU string, dependendo da versão. */
function normalizarMotivos(motivos: PedidoDetalhe['motivos']): MotivoOpcao[] {
  return (motivos ?? []).map((m) =>
    typeof m === 'string' ? { id: m, label: m } : { id: m.id, label: m.label ?? m.id },
  );
}

async function chamar<T>(acao: string, corpo: unknown): Promise<T> {
  const r = await fetch(`/api/trocas/${acao}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok || dados?.ok === false) {
    throw new Error(dados?.error || 'Não conseguimos concluir agora. Tente em instantes. 💜');
  }
  return dados as T;
}

export function PortalTrocas({ logada, pedidosIniciais }: Props) {
  const [passo, setPasso] = useState<Passo>(
    logada && pedidosIniciais.length ? 'pedidos' : 'identificar',
  );
  const [doc, setDoc] = useState('');
  const [pedidos, setPedidos] = useState<PedidoResumo[]>(pedidosIniciais);
  const [pedido, setPedido] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<PedidoDetalhe | null>(null);
  const [escolhidos, setEscolhidos] = useState<Record<string, number>>({});
  const [motivo, setMotivo] = useState('');
  const [detalheMotivo, setDetalheMotivo] = useState('');
  const [aceite, setAceite] = useState(false);
  const [criada, setCriada] = useState<TrocaResumo | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function buscarPedidos(e?: React.FormEvent) {
    e?.preventDefault();
    setCarregando(true);
    setErro(null);
    try {
      const r = await chamar<{ pedidos: PedidoResumo[] }>('buscar', { doc });
      if (!r.pedidos?.length) {
        setErro('Não encontramos compras com esses dados. Confira e tente de novo.');
        return;
      }
      setPedidos(r.pedidos);
      setPasso('pedidos');
    } catch (e2: unknown) {
      setErro(e2 instanceof Error ? e2.message : 'Falha ao buscar.');
    } finally {
      setCarregando(false);
    }
  }

  async function abrirPedido(numero: string) {
    setCarregando(true);
    setErro(null);
    try {
      const d = await chamar<PedidoDetalhe>('localizar', { pedido: numero, doc });
      setPedido(numero);
      setDetalhe(d);
      setEscolhidos({});
      setMotivo('');
      setPasso('itens');
    } catch (e2: unknown) {
      setErro(e2 instanceof Error ? e2.message : 'Falha ao abrir o pedido.');
    } finally {
      setCarregando(false);
    }
  }

  async function enviar() {
    setCarregando(true);
    setErro(null);
    try {
      const items = Object.entries(escolhidos)
        .filter(([, qty]) => qty > 0)
        .map(([sku, qty]) => ({ sku, qty }));
      const r = await chamar<{ troca: TrocaResumo }>('solicitar', {
        pedido,
        doc,
        items,
        motivo,
        motivoDetalhe: detalheMotivo || undefined,
        declaracaoAceita: aceite,
      });
      setCriada(r.troca ?? null);
      setPasso('pronto');
    } catch (e2: unknown) {
      setErro(e2 instanceof Error ? e2.message : 'Falha ao enviar.');
    } finally {
      setCarregando(false);
    }
  }

  const motivos = normalizarMotivos(detalhe?.motivos ?? []);
  const totalEscolhido = Object.values(escolhidos).reduce((s, n) => s + n, 0);
  const podeEnviar = totalEscolhido > 0 && !!motivo && aceite && !carregando;

  return (
    <div className="pb-section-sm">
      {erro && (
        <div className="mb-6 flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger/5 p-4 text-small text-ink">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.75} />
          <span>{erro}</span>
        </div>
      )}

      {/* 1 — QUEM É VOCÊ (só visitante) */}
      {passo === 'identificar' && (
        <form onSubmit={buscarPedidos} className="flex flex-col gap-5">
          <div>
            <label htmlFor="doc" className="text-small font-medium text-ink">
              CPF, celular ou e-mail da compra
            </label>
            <p className="mt-1 text-small text-ink-soft">
              É como a gente encontra seu pedido — o mesmo dado que você usou pra comprar.
            </p>
            <input
              id="doc"
              value={doc}
              onChange={(ev) => setDoc(ev.target.value)}
              autoComplete="off"
              required
              className="mt-3 h-12 w-full rounded-md border border-border bg-surface px-4 text-body text-ink outline-none transition-colors focus:border-primary"
              placeholder="000.000.000-00"
            />
          </div>
          <Button type="submit" disabled={carregando || doc.trim().length < 5} className="self-start">
            {carregando ? <Loader2 className="animate-spin" /> : null}
            Encontrar minha compra
          </Button>
          <p className="text-small text-ink-soft">
            Tem conta na Lurd&apos;s?{' '}
            <a href="/conta" className="link-underline text-ink">
              Entre
            </a>{' '}
            e seus pedidos aparecem aqui sem digitar nada.
          </p>
        </form>
      )}

      {/* 2 — QUAL PEDIDO */}
      {passo === 'pedidos' && (
        <div className="flex flex-col gap-4">
          <p className="text-body text-ink-soft">
            {logada ? 'Suas compras. Escolha a que quer trocar:' : 'Encontramos estas compras:'}
          </p>
          <ul className="flex flex-col gap-3">
            {pedidos.map((p) => (
              <li key={p.numero}>
                <button
                  type="button"
                  onClick={() => abrirPedido(p.numero)}
                  disabled={carregando}
                  className="flex w-full items-center justify-between gap-4 rounded-md border border-border bg-surface p-4 text-left transition-colors hover:border-primary/60 hover:bg-champagne/30 disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="font-medium text-ink">Pedido {p.numero}</span>
                      <span className="eyebrow text-ink-muted">{p.origem}</span>
                    </span>
                    <span className="mt-1 block truncate text-small text-ink-soft">
                      {p.itens.join(' · ')}
                      {p.itensTotal > p.itens.length ? ` +${p.itensTotal - p.itens.length}` : ''}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-small text-ink">
                    {p.total != null ? formatPrice(p.total) : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!logada && (
            <button
              type="button"
              onClick={() => setPasso('identificar')}
              className="flex items-center gap-1.5 self-start text-small text-ink-soft hover:text-ink"
            >
              <ArrowLeft className="size-3.5" /> Usar outro documento
            </button>
          )}
        </div>
      )}

      {/* 3 — QUAIS PEÇAS E POR QUÊ */}
      {passo === 'itens' && detalhe && (
        <div className="flex flex-col gap-7">
          <button
            type="button"
            onClick={() => setPasso('pedidos')}
            className="flex items-center gap-1.5 self-start text-small text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="size-3.5" /> Outro pedido
          </button>

          {/* O prazo é regra do backend — a tela só informa o que ele decidiu. */}
          {!detalhe.prazo.dentroDoPrazo && (
            <div className="flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger/5 p-4 text-small text-ink">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.75} />
              <span>
                Este pedido está fora do prazo de {detalhe.prazo.prazoDias} dias para troca. Fale com
                a gente pelo WhatsApp que a gente vê o que dá pra fazer. 💜
              </span>
            </div>
          )}

          <div>
            <h2 className="font-display text-h3 text-ink">O que você quer trocar?</h2>
            <ul className="mt-4 flex flex-col gap-2.5">
              {detalhe.items.map((it: ItemTrocavel) => {
                const max = it.disponivel;
                const qtd = escolhidos[it.sku] ?? 0;
                const bloqueado = max <= 0;
                return (
                  <li
                    key={it.sku}
                    className={cn(
                      'flex items-center justify-between gap-4 rounded-md border p-4',
                      bloqueado ? 'border-border bg-surface-alt opacity-60' : 'border-border bg-surface',
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-body text-ink">{it.productName}</p>
                      <p className="mt-0.5 text-small text-ink-soft">
                        {bloqueado
                          ? 'Já solicitada'
                          : `${max} ${max === 1 ? 'disponível' : 'disponíveis'} para troca`}
                      </p>
                    </div>
                    {!bloqueado && (
                      <div className="flex shrink-0 items-center gap-1">
                        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() =>
                              setEscolhidos((s) => ({ ...s, [it.sku]: qtd === n ? 0 : n }))
                            }
                            aria-pressed={qtd === n}
                            className={cn(
                              'tabular size-10 rounded-md border text-small transition-colors',
                              qtd === n
                                ? 'border-primary bg-primary font-medium text-light'
                                : 'border-border bg-surface text-ink hover:border-primary/60',
                            )}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {totalEscolhido > 0 && (
            <div>
              <h2 className="font-display text-h3 text-ink">Por que está trocando?</h2>
              <div className="mt-4 flex flex-col gap-2">
                {motivos.map((m) => (
                  <label
                    key={m.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-md border p-4 transition-colors',
                      motivo === m.id
                        ? 'border-primary bg-champagne/40'
                        : 'border-border bg-surface hover:border-primary/60',
                    )}
                  >
                    <input
                      type="radio"
                      name="motivo"
                      value={m.id}
                      checked={motivo === m.id}
                      onChange={() => setMotivo(m.id)}
                      className="sr-only"
                    />
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-full border',
                        motivo === m.id ? 'border-primary bg-primary text-light' : 'border-border',
                      )}
                    >
                      {motivo === m.id && <Check className="size-3" strokeWidth={3} />}
                    </span>
                    <span className="text-body text-ink">{m.label}</span>
                  </label>
                ))}
              </div>

              <textarea
                value={detalheMotivo}
                onChange={(ev) => setDetalheMotivo(ev.target.value)}
                rows={3}
                placeholder="Quer contar mais? (opcional)"
                className="mt-4 w-full rounded-md border border-border bg-surface p-4 text-body text-ink outline-none transition-colors focus:border-primary"
              />
            </div>
          )}

          {totalEscolhido > 0 && motivo && (
            <div className="flex flex-col gap-5 border-t border-border pt-6">
              {detalhe.reversaGratisDisponivel && (
                <p className="text-small text-success">
                  A etiqueta de devolução desta troca é por nossa conta.
                </p>
              )}
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={aceite}
                  onChange={(ev) => setAceite(ev.target.checked)}
                  className="mt-1 size-4 shrink-0 accent-[var(--color-primary)]"
                />
                <span className="text-small text-ink-soft">
                  Declaro que a peça está sem uso, com etiqueta, e nas condições da{' '}
                  <a href="/politica-de-trocas" className="link-underline text-ink" target="_blank">
                    política de trocas
                  </a>
                  .
                </span>
              </label>
              <Button onClick={enviar} disabled={!podeEnviar} className="self-start">
                {carregando ? <Loader2 className="animate-spin" /> : null}
                Pedir troca
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 4 — PRONTO */}
      {passo === 'pronto' && (
        <div className="flex flex-col items-start gap-5">
          <span className="flex size-12 items-center justify-center rounded-full bg-success/10 text-success">
            <PackageOpen className="size-6" strokeWidth={1.5} />
          </span>
          <div>
            <h2 className="font-display text-h2 text-ink">Troca registrada</h2>
            {criada?.numero && (
              <p className="mt-1 text-body text-ink-soft">
                Número <span className="tabular text-ink">{criada.numero}</span>
              </p>
            )}
          </div>
          <div className="rounded-md border border-border bg-surface p-5 text-body text-ink-soft">
            <p className="font-medium text-ink">O que acontece agora</p>
            <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5">
              <li>A gente confere o pedido e te manda a etiqueta de devolução por e-mail.</li>
              <li>Você posta a peça em qualquer agência dos Correios.</li>
              <li>Assim que ela chegar, a gente confere e você escolhe: nova peça, vale ou reembolso.</li>
            </ol>
          </div>
          <p className="text-small text-ink-soft">
            Qualquer dúvida, fale com a gente pelo{' '}
            <a href="/lojas#whatsapp" className="link-underline text-ink">
              WhatsApp
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}
