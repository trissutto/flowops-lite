'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { isValidPhone, maskPhone, onlyDigits } from './masks';
import type { CheckoutContact } from '@/types/checkout';
import { trackCheckoutValidationError } from '@/lib/tracking';

const schema = z.object({
  name: z.string().trim().min(2, 'Digite seu nome.'),
  phone: z.string().refine(isValidPhone, 'Digite o celular com DDD.'),
});

type FormValues = z.infer<typeof schema>;

interface IdentificationStepProps {
  defaults?: CheckoutContact | null;
  onDone: (contact: CheckoutContact) => void;
}

export function IdentificationStep({ defaults, onDone }: IdentificationStepProps) {
  const { register, handleSubmit, setValue, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaults ? { name: defaults.name, phone: maskPhone(defaults.phone) } : undefined,
    mode: 'onTouched',
  });

  return (
    <form
      onSubmit={handleSubmit((values) => onDone({
        name: values.name.trim(),
        phone: onlyDigits(values.phone),
      }), (invalid) => trackCheckoutValidationError('identification', Object.keys(invalid)[0] ?? 'unknown'))}
      noValidate
      className="flex flex-col gap-5"
    >
      <p className="text-small text-ink-soft">
        <strong className="font-medium text-ink">Não precisa criar conta nem senha.</strong>{' '}
        Comece apenas com seu nome e WhatsApp.
      </p>
      <Input label="Seu nome" autoComplete="name" enterKeyHint="next"
        placeholder="Como podemos chamar você?" hint="O nome completo será pedido somente ao finalizar."
        error={errors.name?.message} {...register('name')} />
      <Input label="WhatsApp" type="tel" inputMode="numeric" enterKeyHint="done"
        autoComplete="tel-national" placeholder="(11) 98765-4321"
        hint="Usaremos para avisos do pedido e para ajudar você a retomar esta compra."
        error={errors.phone?.message} {...register('phone', {
          onChange: (e) => setValue('phone', maskPhone(e.target.value)),
        })} />
      <div className="flex flex-col gap-3 pt-1">
        <Button type="submit" block className="sm:w-auto">Continuar para a entrega</Button>
        <p className="text-small text-ink-muted">
          Você ainda escolhe o frete e a forma de pagamento antes de confirmar — nada é cobrado agora.
        </p>
      </div>
    </form>
  );
}
