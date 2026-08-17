'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { isValidCpf, maskCpf, onlyDigits } from './masks';
import type { CheckoutContact, CustomerIdentity } from '@/types/checkout';
import { trackCheckoutValidationError } from '@/lib/tracking';

/**
 * NOME E SOBRENOME EM CAMPOS SEPARADOS (dono, 17/08).
 *
 * Era um campo só, "Nome completo", com a regra escondida: só depois de
 * ela digitar "Thiago" e clicar é que aparecia "Digite nome e sobrenome"
 * numa linha vermelha pequena embaixo do campo.
 *
 * Medição de 14 dias: o campo `name` reprovou 10 PESSOAS — mais que CPF
 * (1), e-mail (3) e bairro (1) somados, sendo o campo mais simples do
 * formulário. E errar sai caro: 1 tentativa converte 71%, 2 convertem 25%,
 * 3 ou mais convertem ZERO.
 *
 * Dois campos vazios pedem duas coisas sem precisar de aviso nenhum. A
 * regra deixa de ser pegadinha e vira o próprio formulário.
 *
 * Pro pedido e pra nota os dois voltam a ser UM no submit — o gateway e a
 * NF-e querem o nome como está no CPF.
 */
const schema = z.object({
  firstName: z.string().trim().min(2, 'Digite seu nome.'),
  lastName: z.string().trim().min(2, 'Digite seu sobrenome.'),
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
    // Nome já conhecido (etapa 1, ou uma volta atrás) entra dividido: a
    // primeira palavra no nome, o resto no sobrenome.
    defaultValues: {
      firstName: ((defaults?.name ?? contact.name ?? '').trim().split(/\s+/)[0]) ?? '',
      lastName: (defaults?.name ?? contact.name ?? '').trim().split(/\s+/).slice(1).join(' '),
      email: defaults?.email ?? '',
      cpf: defaults?.cpf ? maskCpf(defaults.cpf) : '',
    },
    mode: 'onTouched',
  });

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={handleSubmit((values) => onDone({
      name: [values.firstName.trim(), values.lastName.trim()].join(' '), email: values.email.trim().toLowerCase(), cpf: onlyDigits(values.cpf), phone: contact.phone,
    }), (invalid) => trackCheckoutValidationError('identification', Object.keys(invalid)[0] ?? 'unknown'))}>
      <div>
        <h3 className="font-display text-h4 text-ink">Dados da nota e confirmação</h3>
        <p className="mt-1 text-small text-ink-muted">Últimos dados antes de conferir e finalizar. Nada é cobrado agora.</p>
      </div>
      {/* Lado a lado: ocupam a mesma altura de antes e já dizem, sozinhos,
          que se espera duas coisas. */}
      <div className="grid grid-cols-2 gap-3">
        <Input label="Nome" autoComplete="given-name" enterKeyHint="next"
          error={errors.firstName?.message} {...register('firstName')} />
        <Input label="Sobrenome" autoComplete="family-name" enterKeyHint="next"
          error={errors.lastName?.message} {...register('lastName')} />
      </div>
      <p className="-mt-3 text-small text-ink-muted">Como está no seu documento.</p>
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
