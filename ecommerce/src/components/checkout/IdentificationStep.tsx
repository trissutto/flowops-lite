'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { isValidPhone, maskPhone, onlyDigits } from './masks';
import type { CheckoutContact } from '@/types/checkout';
import { trackCheckoutValidationError } from '@/lib/tracking';

/**
 * NOME E SOBRENOME AQUI, NA PRIMEIRA ETAPA (dono, 17/08).
 *
 * Eram pedidos só no fim, na antiga etapa 4, num campo único "Nome
 * completo" cuja regra só aparecia depois do erro — 10 pessoas reprovadas
 * em 14 dias, mais que CPF, e-mail e bairro somados.
 *
 * Subindo pra cá, a etapa 3 fica só com e-mail e CPF e pode gerar o PIX
 * no mesmo clique: quando o QR abre, já está tudo preenchido.
 */
const schema = z.object({
  firstName: z.string().trim().min(2, 'Digite seu nome.'),
  lastName: z.string().trim().min(2, 'Digite seu sobrenome.'),
  phone: z.string().refine(isValidPhone, 'Digite o celular com DDD.'),
  recoveryConsent: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

interface IdentificationStepProps {
  defaults?: CheckoutContact | null;
  onDone: (contact: CheckoutContact) => void;
}

export function IdentificationStep({ defaults, onDone }: IdentificationStepProps) {
  const { register, handleSubmit, setValue, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    // Nome ja conhecido (voltou pra editar) entra dividido: primeira
    // palavra no nome, o resto no sobrenome.
    defaultValues: defaults
      ? {
          // ⚠️ `/\s+/` COM A BARRA. Sem ela o regex parte na LETRA "s":
          // "Thiago Rissutto" virava "Thiago Ri" + "utto", e o nome quebrado
          // ia pro pedido E pro registro de carrinho abandonado. Pior ainda
          // em nome sem "s" ("Maria Silva"): o sobrenome saía vazio e o zod
          // travava a cliente pedindo um campo que ela já tinha preenchido.
          // TypeScript não pega — /s+/ é regex válida. Bug de 17/08.
          firstName: (defaults.name ?? '').trim().split(/\s+/)[0] ?? '',
          lastName: (defaults.name ?? '').trim().split(/\s+/).slice(1).join(' '),
          phone: maskPhone(defaults.phone),
          recoveryConsent: defaults.recoveryConsent,
        }
      : { recoveryConsent: false },
    mode: 'onTouched',
  });

  return (
    <form
      onSubmit={handleSubmit((values) => onDone({
        name: [values.firstName.trim(), values.lastName.trim()].join(' '),
        phone: onlyDigits(values.phone),
        recoveryConsent: values.recoveryConsent,
      }), (invalid) => trackCheckoutValidationError('identification', Object.keys(invalid)[0] ?? 'unknown'))}
      noValidate
      className="flex flex-col gap-5"
    >
      <p className="text-small text-ink-soft">
        <strong className="font-medium text-ink">Não precisa criar conta nem senha.</strong>{' '}
        Comece apenas com seu nome e WhatsApp.
      </p>
      {/* Dois campos vazios pedem duas coisas sozinhos — sem a regra
          escondida que só aparecia depois do erro. */}
      <div className="grid grid-cols-2 gap-3">
        <Input label="Nome" autoComplete="given-name" enterKeyHint="next"
          error={errors.firstName?.message} {...register('firstName')} />
        <Input label="Sobrenome" autoComplete="family-name" enterKeyHint="next"
          error={errors.lastName?.message} {...register('lastName')} />
      </div>
      <p className="-mt-3 text-small text-ink-muted">Como está no seu documento.</p>
      <Input label="WhatsApp" type="tel" inputMode="numeric" enterKeyHint="done"
        autoComplete="tel-national" placeholder="(11) 98765-4321"
        hint="Usaremos para avisos do pedido e para ajudar você a retomar esta compra."
        error={errors.phone?.message} {...register('phone', {
          onChange: (e) => setValue('phone', maskPhone(e.target.value)),
        })} />
      <label className="flex cursor-pointer items-start gap-3 text-small text-ink-soft">
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-primary"
          {...register('recoveryConsent')}
        />
        <span>Quero receber no WhatsApp um lembrete com link seguro se eu não terminar esta compra.</span>
      </label>
      <div className="flex flex-col gap-3 pt-1">
        <Button type="submit" block className="sm:w-auto">Continuar para a entrega</Button>
        <p className="text-small text-ink-muted">
          Você ainda escolhe o frete e a forma de pagamento antes de confirmar — nada é cobrado agora.
        </p>
      </div>
    </form>
  );
}
