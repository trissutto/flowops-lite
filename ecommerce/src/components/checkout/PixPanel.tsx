'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, TimerReset } from 'lucide-react';
import { cn, formatPrice } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import type { Order, OrderStatusResult } from '@/types/checkout';

/**
 * Painel do PIX — aparece no lugar do formulário assim que o pedido é criado.
 *
 * Confirmação por POLL no servidor: GET /api/checkout/:id/status a cada 5s.
 * O webhook do gateway grava o `paid` no banco; o poll só PERGUNTA — quando a
 * resposta vira `paid`, navegamos pra confirmação.
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
}

export function PixPanel({ order }: PixPanelProps) {
  const router = useRouter();
  const pix = order.payment.pix;

  const [restante, setRestante] = useState(() => remainingSeconds(pix?.expiresAt));
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<'aguardando' | 'pago' | 'expirado'>('aguardando');
  // Guarda contra poll sobreposto (rede lenta > intervalo).
  const polling = useRef(false);

  /* Contagem regressiva — 1s. Zerou = expirado (o server também expira). */
  useEffect(() => {
    if (status !== 'aguardando') return;
    const timer = setInterval(() => {
      const s = remainingSeconds(pix?.expiresAt);
      setRestante(s);
      if (s <= 0) setStatus('expirado');
    }, 1_000);
    return () => clearInterval(timer);
  }, [pix?.expiresAt, status]);

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
          // O redirect leva pra thank you; o purchase JÁ foi disparado pelo
          // server nesse momento — a navegação não carrega evento nenhum.
          router.push(`/checkout/confirmacao/${order.id}`);
        } else if (data.ok && (data.status === 'expired' || data.status === 'cancelled')) {
          setStatus('expirado');
        }
      }
    } catch {
      // Falha de rede no poll é invisível: a próxima rodada tenta de novo.
    } finally {
      polling.current = false;
    }
  }, [order.id, router]);

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
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard bloqueado (permissão/iframe): o campo é selecionável na mão.
    }
  }

  if (!pix) return null;

  return (
    <div className="mx-auto flex w-full max-w-narrow flex-col items-center gap-6 rounded-md border border-border bg-surface px-6 py-10 text-center sm:px-10">
      <div>
        <p className="eyebrow text-primary-strong">Pedido {order.number}</p>
        <h1 className="mt-2 font-display text-h2 text-ink">
          Pague com <em className="italic">PIX</em> pra confirmar
        </h1>
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
      ) : (
        <>
          {/* QR — dataURL do server; <img> puro com dimensão fixa (sem CLS).
              next/image não otimiza data: URI — seria só overhead. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pix.qrCode}
            alt={`QR Code do PIX para o pedido ${order.number}`}
            width={224}
            height={224}
            className="rounded-md border border-border bg-light p-3"
          />

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
