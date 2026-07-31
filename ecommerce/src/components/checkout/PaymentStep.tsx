'use client';

import { useId, useState } from 'react';
import { Barcode, CreditCard, QrCode } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { trackAddPaymentInfo, type TrackedItem } from '@/lib/tracking';
import type { PaymentMethod } from '@/types/checkout';
import { CardForm } from './CardForm';

/**
 * § 3 — PAGAMENTO. Três abas: PIX (recomendado e primeiro — é o meio com
 * melhor conversão E menor custo pra loja), Cartão e Boleto.
 *
 * O desconto do PIX aparece como badge informativa; o VALOR real com desconto
 * quem calcula é o SERVER na criação do pedido (o client nunca inventa total
 * — mesma filosofia do cupom em lib/commerce/cupom.ts).
 *
 * `add_payment_info` dispara na ESCOLHA da aba (é aí que a decisão acontece),
 * uma vez por método — trocar de aba de novo pro mesmo método não re-dispara.
 */

export interface PaymentSelection {
  method: PaymentMethod;
  installments?: number;
  /** Token de uso único da Pagar.me (transparente) — nunca o cartão em si. */
  cardToken?: string;
}

const TABS: Array<{ method: PaymentMethod; label: string; icon: React.ElementType }> = [
  { method: 'pix', label: 'PIX', icon: QrCode },
  { method: 'card', label: 'Cartão', icon: CreditCard },
  { method: 'boleto', label: 'Boleto', icon: Barcode },
];

interface PaymentStepProps {
  /** Total estimado (subtotal − desconto + frete) — só pra exibir parcelas. */
  total: number;
  itemsTracked: TrackedItem[];
  defaults?: PaymentSelection | null;
  onDone: (payment: PaymentSelection) => void;
}

export function PaymentStep({ total, itemsTracked, defaults, onDone }: PaymentStepProps) {
  const [method, setMethod] = useState<PaymentMethod>(defaults?.method ?? 'pix');
  const [tracked, setTracked] = useState<Set<PaymentMethod>>(new Set());
  const groupId = useId();

  /** Uma vez por método por visita à seção — evita inflar o funil. */
  function ensureTracked(m: PaymentMethod) {
    if (!tracked.has(m)) {
      trackAddPaymentInfo(itemsTracked, m);
      setTracked((prev) => new Set(prev).add(m));
    }
  }

  function pick(next: PaymentMethod) {
    setMethod(next);
    ensureTracked(next);
  }

  /** Continuar: garante o evento mesmo pro método padrão (PIX sem clique). */
  function confirm(selection: PaymentSelection) {
    ensureTracked(selection.method);
    onDone(selection);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Abas — tablist ARIA com setas ←/→. */}
      <div
        role="tablist"
        aria-label="Forma de pagamento"
        className="grid grid-cols-3 gap-2"
        onKeyDown={(e) => {
          const index = TABS.findIndex((t) => t.method === method);
          if (e.key === 'ArrowRight') pick(TABS[(index + 1) % TABS.length].method);
          if (e.key === 'ArrowLeft') pick(TABS[(index - 1 + TABS.length) % TABS.length].method);
        }}
      >
        {TABS.map(({ method: m, label, icon: Icon }) => {
          const selected = m === method;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              id={`${groupId}-tab-${m}`}
              aria-selected={selected}
              aria-controls={`${groupId}-panel-${m}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => pick(m)}
              className={cn(
                'relative flex flex-col items-center gap-1.5 rounded-md border px-3 py-3.5 text-small font-medium transition-colors duration-[180ms]',
                selected
                  ? 'border-primary bg-primary-wash text-ink'
                  : 'border-border text-ink-soft hover:border-border-strong hover:text-ink',
              )}
            >
              <Icon className="size-5 text-primary-strong" strokeWidth={1.5} />
              {label}
              {m === 'pix' && (
                <span className="eyebrow text-[0.5625rem] text-primary-strong">recomendado</span>
              )}
            </button>
          );
        })}
      </div>

      {/* PIX */}
      <div
        role="tabpanel"
        id={`${groupId}-panel-pix`}
        aria-labelledby={`${groupId}-tab-pix`}
        hidden={method !== 'pix'}
      >
        {method === 'pix' && (
          <div className="flex flex-col gap-4">
            {/* Badge informativa: o desconto REAL entra no total calculado
                pelo server quando o pedido é criado (pixPrice do catálogo). */}
            <Badge tone="success" className="self-start">
              5% off já aplicado
            </Badge>
            <ul className="flex flex-col gap-2 text-body text-ink-soft">
              <li>Aprovação na hora — o QR Code aparece assim que você finalizar.</li>
              <li>Pague pelo app do seu banco, com QR Code ou copia-e-cola.</li>
              <li>O código vale por 30 minutos.</li>
            </ul>
            <div className="pt-1">
              <Button type="button" block className="sm:w-auto" onClick={() => confirm({ method: 'pix' })}>
                Continuar para a revisão
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Cartão */}
      <div
        role="tabpanel"
        id={`${groupId}-panel-card`}
        aria-labelledby={`${groupId}-tab-card`}
        hidden={method !== 'card'}
      >
        {method === 'card' && <CardForm total={total} onDone={confirm} />}
      </div>

      {/* Boleto */}
      <div
        role="tabpanel"
        id={`${groupId}-panel-boleto`}
        aria-labelledby={`${groupId}-tab-boleto`}
        hidden={method !== 'boleto'}
      >
        {method === 'boleto' && (
          <div className="flex flex-col gap-4">
            <ul className="flex flex-col gap-2 text-body text-ink-soft">
              <li>O boleto chega no seu e-mail assim que você finalizar.</li>
              <li>O pagamento compensa em até 2 dias úteis.</li>
              <li>Suas peças ficam reservadas por 3 dias enquanto isso.</li>
            </ul>
            <div className="pt-1">
              <Button type="button" block className="sm:w-auto" onClick={() => confirm({ method: 'boleto' })}>
                Continuar para a revisão
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
