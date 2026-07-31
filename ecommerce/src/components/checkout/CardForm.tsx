'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input, Select } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { formatPrice } from '@/lib/utils';
import {
  CARD_BRAND_LABEL,
  detectCardBrand,
  isValidCardNumber,
  isValidExpiry,
  maskCardNumber,
  maskExpiry,
  onlyDigits,
} from './masks';

/**
 * Formulário de cartão — CHECKOUT TRANSPARENTE Pagar.me (o modelo do plugin
 * do WordPress que a loja já usa hoje).
 *
 * ⚠️ PCI: o número do cartão NUNCA passa pelo nosso servidor. O submit chama
 * a API de tokens da Pagar.me DIRETO DO NAVEGADOR, com a Public Key (pk_) —
 * volta um token de uso único, e é SÓ ele que segue no pedido. Nosso servidor
 * vê `tok_...`, cobra com ele e joga fora. `CreateOrderInput` não tem campo
 * de número de cartão de propósito.
 *
 * Sem `NEXT_PUBLIC_PAGARME_PUBLIC_KEY` configurada, o form segue validando
 * mas envia sem token — e o server responde com a mensagem elegante de método
 * indisponível (comportamento de antes do gateway).
 */

const PAGARME_PK = process.env.NEXT_PUBLIC_PAGARME_PUBLIC_KEY;

/** Tokeniza o cartão navegador→Pagar.me. Lança em falha de rede/recusa. */
async function tokenizeCard(values: { number: string; holder: string; expiry: string; cvv: string }): Promise<string> {
  const [mes, ano] = values.expiry.split('/');
  const res = await fetch(`https://api.pagar.me/core/v5/tokens?appId=${PAGARME_PK}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'card',
      card: {
        number: onlyDigits(values.number),
        holder_name: values.holder.trim(),
        exp_month: Number(mes),
        exp_year: Number(`20${ano}`),
        cvv: values.cvv,
      },
    }),
  });
  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!res.ok || !json?.id) throw new Error('tokenização recusada');
  return json.id;
}

const schema = z.object({
  number: z.string().refine(isValidCardNumber, 'Confira o número do cartão.'),
  holder: z.string().trim().min(3, 'Digite o nome como está impresso no cartão.'),
  expiry: z.string().refine(isValidExpiry, 'Validade inválida (MM/AA).'),
  cvv: z.string().refine((v) => /^\d{3,4}$/.test(v), 'CVV de 3 ou 4 dígitos.'),
  installments: z.string().min(1),
});

type FormValues = z.infer<typeof schema>;

export const MAX_PARCELAS = 12;

interface CardFormProps {
  /** Total estimado do pedido (o server recalcula — isto é só exibição). */
  total: number;
  onDone: (payment: { method: 'card'; installments: number; cardToken?: string }) => void;
}

export function CardForm({ total, onDone }: CardFormProps) {
  const [tokenizing, setTokenizing] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { installments: '1' },
    mode: 'onTouched',
  });

  const brand = detectCardBrand(watch('number') ?? '');

  // Até 12x sem juros: o valor de cada parcela aparece na própria opção —
  // ninguém deveria precisar de calculadora pra decidir o parcelamento.
  const parcelas = Array.from({ length: MAX_PARCELAS }, (_, i) => {
    const n = i + 1;
    return {
      value: String(n),
      label: n === 1 ? `À vista · ${formatPrice(total)}` : `${n}x de ${formatPrice(total / n)} sem juros`,
    };
  });

  async function submit(values: FormValues) {
    setTokenError(null);

    // Sem Public Key não há como tokenizar — segue sem token e o server
    // responde com a mensagem de método indisponível.
    if (!PAGARME_PK) {
      onDone({ method: 'card', installments: Number(values.installments) });
      return;
    }

    setTokenizing(true);
    try {
      // Navegador → Pagar.me. O número NÃO sai daqui pra nenhum outro lugar.
      const cardToken = await tokenizeCard(values);
      onDone({ method: 'card', installments: Number(values.installments), cardToken });
    } catch {
      setTokenError('Não conseguimos validar o cartão. Confira os dados e tente de novo — ou escolha o Pix, que aprova na hora.');
    } finally {
      setTokenizing(false);
    }
  }

  return (
    <form onSubmit={handleSubmit((v) => void submit(v))} noValidate className="flex flex-col gap-5">
      <Input
        label="Número do cartão"
        inputMode="numeric"
        autoComplete="cc-number"
        placeholder="0000 0000 0000 0000"
        // A bandeira detectada aparece como hint — feedback de "entendi seu
        // cartão" sem ícone proprietário.
        hint={brand ? CARD_BRAND_LABEL[brand] : ' '}
        error={errors.number?.message}
        {...register('number', {
          onChange: (e) => setValue('number', maskCardNumber(e.target.value)),
        })}
      />
      <Input
        label="Nome impresso no cartão"
        autoComplete="cc-name"
        placeholder="Como aparece no cartão"
        error={errors.holder?.message}
        {...register('holder')}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          label="Validade"
          inputMode="numeric"
          autoComplete="cc-exp"
          placeholder="MM/AA"
          error={errors.expiry?.message}
          {...register('expiry', {
            onChange: (e) => setValue('expiry', maskExpiry(e.target.value)),
          })}
        />
        <Input
          label="CVV"
          inputMode="numeric"
          autoComplete="cc-csc"
          placeholder="123"
          maxLength={4}
          error={errors.cvv?.message}
          {...register('cvv', {
            onChange: (e) => setValue('cvv', onlyDigits(e.target.value).slice(0, 4)),
          })}
        />
      </div>
      <Select
        label="Parcelas"
        options={parcelas}
        error={errors.installments?.message}
        {...register('installments')}
      />

      {tokenError && (
        <p role="alert" className="rounded-sm border border-secondary/30 bg-secondary/5 px-4 py-3 text-small text-secondary">
          {tokenError}
        </p>
      )}

      <div className="pt-1">
        <Button type="submit" block className="sm:w-auto" disabled={tokenizing}>
          {tokenizing ? 'Validando cartão…' : 'Continuar para a revisão'}
        </Button>
      </div>
    </form>
  );
}
