'use client';

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
 * Formulário de cartão — validação COMPLETA no client (Luhn, bandeira,
 * validade, CVV) pra experiência ficar pronta, MAS:
 *
 * ⚠️ NENHUM dado do cartão sai do navegador no MVP. `CreateOrderInput` nem
 * tem campo de cartão — de propósito: sem gateway tokenizando, número de
 * cartão NUNCA trafega pro nosso servidor (PCI-DSS não é opcional). Quando o
 * gateway entrar, este form chama o SDK dele pra tokenizar e só o token viaja.
 * Enquanto isso o server recusa `paymentMethod: 'card'` e a página mostra a
 * mensagem elegante de "estamos finalizando este meio de pagamento".
 *
 * O que VAI no pedido é só `{ method: 'card', installments }`.
 */

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
  onDone: (payment: { method: 'card'; installments: number }) => void;
}

export function CardForm({ total, onDone }: CardFormProps) {
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

  function submit(values: FormValues) {
    // Dados do cartão ficam AQUI (ver comentário no topo) — só método e
    // parcelas seguem pro pedido.
    onDone({ method: 'card', installments: Number(values.installments) });
  }

  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="flex flex-col gap-5">
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

      <div className="pt-1">
        <Button type="submit" block className="sm:w-auto">
          Continuar para a revisão
        </Button>
      </div>
    </form>
  );
}
