'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, TimerReset } from 'lucide-react';
import { cn, formatPrice } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { trackCheckoutRecovered, trackPixCopied, trackPixExpired } from '@/lib/tracking';
import type { Order, OrderStatusResult } from '@/types/checkout';

/**
 * Painel do PIX — QR, copia-e-cola e contagem regressiva do pedido criado.
 *
 * ONDE ELE MORA (17/08): em `/checkout/confirmacao/:id`, reidratado pelo
 * `GET /api/checkout/:id`. Antes vivia só no estado React da página do
 * checkout — F5, "voltar" ou a aba descartada pelo celular quando a cliente
 * ia pro app do banco apagavam o QR pra sempre, e ela caía em "Sua sacola
 * está vazia" sem link, sem e-mail, sem código. Agora a URL É o estado: o
 * painel volta em qualquer recarga enquanto o pedido estiver aguardando.
 *
 * Confirmação por POLL no servidor: GET /api/checkout/:id/status a cada 5s.
 * O webhook do gateway grava o `paid` no banco; o poll só PERGUNTA — quando a
 * resposta vira `paid`, avisamos quem nos montou (`onPaid`) pra ele recarregar
 * o pedido; sem `onPaid`, navegamos pra confirmação (uso legado).
 *
 * ⚠️ NUNCA disparar `purchase` aqui (nem na página de confirmação): o evento
 * de compra é 100% do SERVIDOR, disparado pelo webhook com dedupe por
 * transaction_id — ver docs/purchase.md. Cliente que fecha a aba antes do
 * redirect continua contando a venda; recarregar a confirmação não conta duas.
 */

/** Intervalo do poll — 5s equilibra "parece instantâneo" e carga no server. */
const POLL_MS = 5_000;

interface PixPanelProps {
  order: Order;
  /**
   * Chamado quando o poll vê `paid`. A página de confirmação passa um refetch
   * do pedido — dar `router.push` pra ela mesma não refaria o fetch (o efeito
   * é chaveado em `params.id`) e ainda empilharia histórico.
   */
  onPaid?: () => void;
  /** Chamado quando o poll vê `expired`/`cancelled` — mesma ideia do `onPaid`. */
  onExpired?: () => void;
  /**
   * Embutido numa página que já tem título e número do pedido: o painel
   * rebaixa o título pra <h2> e não repete o "Pedido Nº".
   */
  embutido?: boolean;
}

export function PixPanel({ order, onPaid, onExpired, embutido = false }: PixPanelProps) {
  const router = useRouter();
  const pix = order.payment.pix;

  const [restante, setRestante] = useState(() => remainingSeconds(pix?.expiresAt));
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<'aguardando' | 'pago' | 'expirado'>('aguardando');
  // Guarda contra poll sobreposto (rede lenta > intervalo).
  const polling = useRef(false);
  const expiredTracked = useRef(false);
  const recoveredTracked = useRef(false);

  const markExpired = useCallback(() => {
    setStatus('expirado');
    if (!expiredTracked.current) {
      expiredTracked.current = true;
      trackPixExpired(order.id);
    }
  }, [order.id]);

  // Callbacks em ref: quem nos monta costuma passar closures novas a cada
  // render, e amarrá-las no `poll` reiniciaria o setInterval a cada tick.
  const onPaidRef = useRef(onPaid);
  const onExpiredRef = useRef(onExpired);
  useEffect(() => {
    onPaidRef.current = onPaid;
    onExpiredRef.current = onExpired;
  });

  /* Contagem regressiva — 1s. Zerou = expirado (o server também expira). */
  useEffect(() => {
    if (status !== 'aguardando') return;
    const timer = setInterval(() => {
      const s = remainingSeconds(pix?.expiresAt);
      setRestante(s);
      if (s <= 0) markExpired();
    }, 1_000);
    return () => clearInterval(timer);
  }, [markExpired, pix?.expiresAt, status]);

  /* Poll de status — pergunta ao server se o webhook já confirmou. */
  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const res = await fetch(`/api/checkout/${order.id}/status`);
      if (res.ok) {
        const data = (await res.json()) as OrderStatusResult;
        if (data.ok && data.status === 'paid') {
          setStatus('pago');
          if (!recoveredTracked.current) {
            recoveredTracked.current = true;
            trackCheckoutRecovered('pix', order.id);
          }
          // O purchase JÁ foi disparado pelo server nesse momento — nem o
          // callback nem a navegação carregam evento nenhum.
          if (onPaidRef.current) onPaidRef.current();
          else router.push(`/checkout/confirmacao/${order.id}`);
        } else if (data.ok && (data.status === 'expired' || data.status === 'cancelled')) {
          markExpired();
          onExpiredRef.current?.();
        }
      }
    } catch {
      // Falha de rede no poll é invisível: a próxima rodada tenta de novo.
    } finally {
      polling.current = false;
    }
  }, [markExpired, order.id, router]);

  useEffect(() => {
    if (status !== 'aguardando') return;
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [poll, status]);

  async function copiar() {
    if (!pix) return;
    try {
      await navigator.clipboard.writeText(pix.copyPaste);
      setCopied(true);
      trackPixCopied(order.id);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard bloqueado (permissão/iframe): o campo é selecionável na mão.
    }
  }

  if (!pix) return null;

  const Titulo = embutido ? 'h2' : 'h1';

  return (
    <div className="mx-auto flex w-full max-w-narrow flex-col items-center gap-6 rounded-md border border-border bg-surface px-6 py-10 text-center sm:px-10">
      <div>
        {!embutido && <p className="eyebrow text-primary-strong">Pedido {order.number}</p>}
        <Titulo className={cn('font-display text-ink', embutido ? 'text-h3' : 'mt-2 text-h2')}>
          Pague com <em className="italic">PIX</em> pra confirmar
        </Titulo>
        <p className="mt-2 text-body text-ink-soft">
          Abra o app do seu banco e escaneie o código — a confirmação aparece aqui sozinha.
        </p>
      </div>

      {status === 'expirado' ? (
        <div className="flex flex-col items-center gap-4 py-6">
          <TimerReset className="size-10 text-ink-muted" strokeWidth={1.25} />
          <p className="max-w-sm text-body text-ink-soft">
            Esse código expirou e o pedido foi liberado. Nada foi cobrado — é só montar a sacola de
            novo, leva um minutinho.
          </p>
          <Button href="/" variant="secondary">
            Voltar à loja
          </Button>
        </div>
      ) : status === 'pago' ? (
        // Entre o poll ver `paid` e a página recarregar o pedido, o QR não pode
        // continuar na tela — cliente que já pagou olhando um código "vivo"
        // liga pro WhatsApp achando que não caiu.
        <div className="flex flex-col items-center gap-3 py-6">
          <Check className="size-10 text-success" strokeWidth={1.5} />
          <p className="max-w-sm text-body text-ink">Pagamento confirmado! Atualizando seu pedido…</p>
        </div>
      ) : (
        <>
          {/* QR — dataURL do server; <img> puro com dimensão fixa (sem CLS).
              next/image não otimiza data: URI — seria só overhead. Sem QR (o
              GET não conseguiu gerar), o copia-e-cola abaixo segue valendo. */}
          {pix.qrCode ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={pix.qrCode}
              alt={`QR Code do PIX para o pedido ${order.number}`}
              width={224}
              height={224}
              className="rounded-md border border-border bg-light p-3"
            />
          ) : (
            <p className="max-w-sm text-small text-ink-muted">
              O QR não carregou — use o código copia-e-cola abaixo, ele é o mesmo pagamento.
            </p>
          )}

          <p className="tabular text-h4 font-medium text-success">{formatPrice(order.total)}</p>

          {/* Copia-e-cola */}
          <div className="flex w-full max-w-sm gap-2">
            <label htmlFor="pix-copia-cola" className="sr-only">
              Código PIX copia-e-cola
            </label>
            <input
              id="pix-copia-cola"
              readOnly
              value={pix.copyPaste}
              onFocus={(e) => e.target.select()}
              className="w-full min-w-0 flex-1 truncate rounded-md border border-border bg-surface-alt px-4 py-2.5 text-small text-ink-soft focus:border-primary focus:outline-none"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={copiar}
              className={cn('shrink-0', copied && 'border-success text-success')}
            >
              {copied ? (
                <>
                  <Check /> Copiado!
                </>
              ) : (
                <>
                  <Copy /> Copiar
                </>
              )}
            </Button>
          </div>

          {/* role=timer + aria-live off: leitor de tela não narra cada segundo. */}
          <p role="timer" aria-live="off" className="text-small text-ink-muted">
            O código expira em <span className="tabular font-medium text-ink">{formatCountdown(restante)}</span>
          </p>

          <p className="max-w-sm text-small text-ink-muted">
            Assim que o pagamento cair, esta página avança sozinha pra confirmação do seu pedido.
          </p>

          {/* O link é o seguro contra a aba descartada: quem sai pro app do
              banco e volta com a página recarregada encontra o mesmo código
              aqui — não precisa remontar sacola nenhuma. */}
          <p className="max-w-sm text-caption font-normal tracking-normal normal-case text-ink-muted">
            Saiu pro app do banco e voltou? É só abrir este mesmo link de novo — o código continua
            aqui até expirar.
          </p>
        </>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function remainingSeconds(expiresAt?: string): number {
  if (!expiresAt) return 0;
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1_000));
}

function formatCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
