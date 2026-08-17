'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input, Select } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { formatPrice } from '@/lib/utils';
import { trackCheckoutValidationError } from '@/lib/tracking';
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
 * validade, CVV) e TOKENIZAÇÃO no navegador.
 *
 * ⚠️ PCI-DSS, a regra que não se negocia: número, CVV e validade NUNCA saem
 * deste navegador. Eles vão direto pra API de tokens da Pagar.me (chave
 * PÚBLICA, `NEXT_PUBLIC_PAGARME_PUBLIC_KEY`), que devolve um `card_token`. Só
 * o token viaja pro nosso BFF e, dele, pro backend FlowOps — que cobra. Nem o
 * servidor do site nem o backend jamais veem o PAN.
 *
 * Sem a chave pública configurada o form segue funcionando (validação e UX
 * intactas) mas não gera token: o BFF recusa cartão sem token com a mensagem
 * elegante de "estamos finalizando este meio de pagamento". Melhor isso do que
 * uma tela que finge cobrar.
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

/** Endpoint público de tokenização da Pagar.me (v5) — autentica pela chave `pk_`. */
const PAGARME_TOKENS_URL = 'https://api.pagar.me/core/v5/tokens';

interface CardFormProps {
  /** Total estimado do pedido (o server recalcula — isto é só exibição). */
  total: number;
  onDone: (payment: { method: 'card'; installments: number; cardToken?: string }) => void;
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

  const [tokenizando, setTokenizando] = useState(false);
  const [erroToken, setErroToken] = useState<string | null>(null);

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

  /**
   * Troca os dados do cartão por um token. O `fetch` vai do NAVEGADOR direto
   * pra Pagar.me — não passa pelo nosso servidor de propósito (é literalmente
   * o ponto do PCI). A chave é pública: ela só cria token, não movimenta nada.
   */
  async function tokenizar(values: FormValues): Promise<string> {
    const publicKey = process.env.NEXT_PUBLIC_PAGARME_PUBLIC_KEY;
    if (!publicKey) throw new Error('sem chave pública');

    const [mm, yy] = values.expiry.split('/');
    const res = await fetch(`${PAGARME_TOKENS_URL}?appId=${encodeURIComponent(publicKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'card',
        card: {
          number: onlyDigits(values.number),
          holder_name: values.holder.trim(),
          exp_month: Number(mm),
          exp_year: Number(yy),
          cvv: values.cvv,
        },
      }),
    });

    if (!res.ok) throw new Error(`pagarme respondeu ${res.status}`);
    const data = (await res.json()) as { id?: string };
    if (!data?.id) throw new Error('resposta sem token');
    return data.id;
  }

  async function submit(values: FormValues) {
    setErroToken(null);
    const installments = Number(values.installments);

    // Sem chave configurada: segue sem token. O server recusa com elegância —
    // e a cliente não fica presa num botão que não faz nada.
    if (!process.env.NEXT_PUBLIC_PAGARME_PUBLIC_KEY) {
      onDone({ method: 'card', installments });
      return;
    }

    setTokenizando(true);
    try {
      const cardToken = await tokenizar(values);
      onDone({ method: 'card', installments, cardToken });
    } catch (err) {
      // Log sem NENHUM dado do cartão — só o motivo técnico.
      console.error('[checkout] tokenização do cartão falhou:', err instanceof Error ? err.message : err);
      setErroToken(
        'Não conseguimos validar esse cartão agora. Confira os dados e tente de novo — ou finalize com Pix (com 5% off).',
      );
    } finally {
      setTokenizando(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit(submit, (invalid) => {
        const field = Object.keys(invalid)[0] ?? 'unknown';
        trackCheckoutValidationError('card', field === 'number' ? 'card_number' : field);
      })}
      noValidate
      className="flex flex-col gap-5"
    >
      <Input
        label="Número do cartão"
        inputMode="numeric"
        enterKeyHint="next"
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
        enterKeyHint="next"
        placeholder="Como aparece no cartão"
        error={errors.holder?.message}
        {...register('holder')}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          label="Validade"
          inputMode="numeric"
          enterKeyHint="next"
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
          enterKeyHint="done"
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

      {erroToken && (
        <p role="alert" className="text-small text-danger">
          {erroToken}
        </p>
      )}

      <div className="pt-1">
        <Button type="submit" block className="sm:w-auto" disabled={tokenizando}>
          {/* O clique aqui É a compra (17/08). "Continuar" prometia um
              passo a mais que não existe. */}
          {tokenizando ? 'Validando cartão…' : `Pagar ${formatPrice(total)} com cartão`}
        </Button>
      </div>
    </form>
  );
}
