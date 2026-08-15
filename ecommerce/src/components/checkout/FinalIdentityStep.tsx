'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { isValidCpf, maskCpf, onlyDigits } from './masks';
import type { CheckoutContact, CustomerIdentity } from '@/types/checkout';
import { trackCheckoutValidationError } from '@/lib/tracking';

const schema = z.object({
  name: z.string().trim().min(5, 'Digite seu nome completo.')
    .refine((v) => v.trim().split(/\s+/).length >= 2, 'Digite nome e sobrenome.'),
  email: z.email('Digite um e-mail válido.'),
  cpf: z.string().refine(isValidCpf, 'Confira o CPF — esse número não confere.'),
});

type FormValues = z.infer<typeof schema>;

export function FinalIdentityStep({ contact, defaults, onDone }: {
  contact: CheckoutContact;
  defaults?: CustomerIdentity | null;
  onDone: (customer: CustomerIdentity) => void;
}) {
  const { register, handleSubmit, setValue, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: defaults?.name ?? contact.name, email: defaults?.email ?? '', cpf: defaults?.cpf ? maskCpf(defaults.cpf) : '' },
    mode: 'onTouched',
  });

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={handleSubmit((values) => onDone({
      name: values.name.trim(), email: values.email.trim().toLowerCase(), cpf: onlyDigits(values.cpf), phone: contact.phone,
    }), (invalid) => trackCheckoutValidationError('identification', Object.keys(invalid)[0] ?? 'unknown'))}>
      <div>
        <h3 className="font-display text-h4 text-ink">Dados da nota e confirmação</h3>
        <p className="mt-1 text-small text-ink-muted">Últimos dados antes de conferir e finalizar. Nada é cobrado agora.</p>
      </div>
      <Input label="Nome completo" autoComplete="name" enterKeyHint="next" hint="Como está no seu documento."
        error={errors.name?.message} {...register('name')} />
      <Input label="E-mail" type="email" autoComplete="email" inputMode="email" enterKeyHint="next"
        placeholder="voce@email.com" hint="A confirmação e o rastreio chegam por aqui."
        error={errors.email?.message} {...register('email')} />
      <Input label="CPF" inputMode="numeric" enterKeyHint="done" autoComplete="off"
        placeholder="000.000.000-00" hint="Usado somente no pedido e na nota fiscal."
        error={errors.cpf?.message} {...register('cpf', { onChange: (e) => setValue('cpf', maskCpf(e.target.value)) })} />
      <Button type="submit" block>Revisar meu pedido</Button>
    </form>
  );
}
