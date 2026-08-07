'use client';

import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { isValidCpf, isValidPhone, maskCpf, maskPhone, onlyDigits } from './masks';
import type { CustomerIdentity } from '@/types/checkout';

/**
 * § 1 — IDENTIFICAÇÃO. Quatro campos, nada de senha: o checkout como
 * convidada é o caminho padrão. Login é um link discreto — obrigar cadastro
 * antes de pagar é a maior causa de abandono de checkout que existe.
 *
 * CPF valida dígito verificador de verdade (ver masks.ts) porque a NF-e do
 * pedido é emitida com ele — CPF errado descoberto só no faturamento vira
 * atendimento manual.
 */

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(5, 'Digite seu nome completo.')
    .refine((v) => v.trim().split(/\s+/).length >= 2, 'Digite nome e sobrenome.'),
  email: z.email('Digite um e-mail válido — é por ele que o pedido chega.'),
  cpf: z.string().refine(isValidCpf, 'Confira o CPF — esse número não confere.'),
  phone: z.string().refine(isValidPhone, 'Digite o celular com DDD.'),
});

type FormValues = z.infer<typeof schema>;

interface IdentificationStepProps {
  /** Valores já confirmados (volta da edição) — só dígitos, como no contrato. */
  defaults?: CustomerIdentity | null;
  onDone: (customer: CustomerIdentity) => void;
}

export function IdentificationStep({ defaults, onDone }: IdentificationStepProps) {
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    // Re-mascara os defaults: o contrato guarda só dígitos, a tela mostra bonito.
    defaultValues: defaults
      ? {
          name: defaults.name,
          email: defaults.email,
          cpf: maskCpf(defaults.cpf),
          phone: maskPhone(defaults.phone),
        }
      : undefined,
    mode: 'onTouched',
  });

  function submit(values: FormValues) {
    // O contrato (CustomerIdentity) pede só dígitos em cpf/phone.
    onDone({
      name: values.name.trim(),
      email: values.email.trim().toLowerCase(),
      cpf: onlyDigits(values.cpf),
      phone: onlyDigits(values.phone),
    });
  }

  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="flex flex-col gap-5">
      {/* Login opcional — NUNCA obrigatório. */}
      <p className="text-small text-ink-muted">
        Já tem conta?{' '}
        <Link href="/conta" className="link-underline font-medium text-primary-strong">
          Entrar
        </Link>{' '}
        — ou siga sem cadastro mesmo.
      </p>

      <Input
        label="Nome completo"
        autoComplete="name"
        placeholder="Como está no seu documento"
        error={errors.name?.message}
        {...register('name')}
      />
      <Input
        label="E-mail"
        type="email"
        autoComplete="email"
        inputMode="email"
        placeholder="voce@email.com"
        hint="A confirmação e o rastreio chegam por aqui."
        error={errors.email?.message}
        {...register('email')}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          label="CPF"
          inputMode="numeric"
          autoComplete="off"
          placeholder="000.000.000-00"
          error={errors.cpf?.message}
          {...register('cpf', {
            // setValue depois do handler interno do RHF = o form guarda o
            // valor já mascarado (a máscara é idempotente, ver masks.ts).
            onChange: (e) => setValue('cpf', maskCpf(e.target.value)),
          })}
        />
        <Input
          label="Celular"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          placeholder="(11) 98765-4321"
          error={errors.phone?.message}
          {...register('phone', {
            onChange: (e) => setValue('phone', maskPhone(e.target.value)),
          })}
        />
      </div>

      <div className="pt-1">
        <Button type="submit" block className="sm:w-auto">
          Continuar para a entrega
        </Button>
      </div>
    </form>
  );
}
