'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { isValidCpf, isValidPhone, maskCpf, maskPhone, onlyDigits } from './masks';
import type { CustomerIdentity } from '@/types/checkout';
import { trackCheckoutValidationError } from '@/lib/tracking';

/**
 * § 1 — IDENTIFICAÇÃO. Quatro campos, nada de senha: o checkout como
 * convidada é o caminho padrão — obrigar cadastro antes de pagar é a maior
 * causa de abandono de checkout que existe.
 *
 * ⚠️ AQUI MORRE O CHECKOUT INTEIRO (medido 14/08 em `site_eventos`): das 11
 * sessões que abriram o /checkout em 7 dias, **8 pararam nesta seção** — zero
 * pararam na entrega, zero no pagamento. Não é o frete nem o cartão que
 * derrubam a venda, é esta tela. Duas coisas mudaram por causa dessa medição:
 *
 *  1. **O link "Entrar" saiu.** Ele era a PRIMEIRA coisa da seção e levava
 *     pra /conta, FORA do checkout — sem volta, sem prefill (os dados daqui
 *     nunca vieram da conta) e sem sacola à vista. Uma das 8 sessões terminou
 *     exatamente ali, parada em /conta. Porta de saída no topo do funil, em
 *     troca de nada.
 *  2. **Todo campo diz pra que serve.** A cliente da Lurd's não é fluente em
 *     tecnologia: pedir CPF sem explicar, no meio de uma compra, parece
 *     cobrança de cadastro — e ela fecha a aba.
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
    <form
      onSubmit={handleSubmit(submit, (invalid) =>
        trackCheckoutValidationError('identification', Object.keys(invalid)[0] ?? 'unknown'))}
      noValidate
      className="flex flex-col gap-5"
    >
      {/* Tira o medo do "cadastro" antes do primeiro campo: quem chega aqui
          já escolheu a peça, e o que faz ela desistir agora é achar que vai
          ter que criar conta e inventar senha. */}
      <p className="text-small text-ink-soft">
        <strong className="font-medium text-ink">Não precisa criar conta nem senha.</strong>{' '}
        São quatro campos e a compra segue.
      </p>

      <Input
        label="Nome completo"
        autoComplete="name"
        enterKeyHint="next"
        placeholder="Como está no seu documento"
        hint="Nome e sobrenome, como no RG."
        error={errors.name?.message}
        {...register('name')}
      />
      <Input
        label="E-mail"
        type="email"
        autoComplete="email"
        inputMode="email"
        enterKeyHint="next"
        placeholder="voce@email.com"
        hint="A confirmação e o rastreio chegam por aqui."
        error={errors.email?.message}
        {...register('email')}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          label="CPF"
          inputMode="numeric"
          enterKeyHint="next"
          autoComplete="off"
          placeholder="000.000.000-00"
          hint="Vai só na nota fiscal do pedido."
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
          enterKeyHint="done"
          autoComplete="tel-national"
          placeholder="(11) 98765-4321"
          hint="Pra avisar quando a peça sair pra entrega."
          error={errors.phone?.message}
          {...register('phone', {
            onChange: (e) => setValue('phone', maskPhone(e.target.value)),
          })}
        />
      </div>

      <div className="flex flex-col gap-3 pt-1">
        <Button type="submit" block className="sm:w-auto">
          Continuar para a entrega
        </Button>
        {/* "Continuar" não é "comprar" — e quem não tem intimidade com site
            não sabe disso. Dizer que ainda faltam frete e pagamento é o que
            faz ela clicar sem medo de já estar sendo cobrada. */}
        <p className="text-small text-ink-muted">
          Você ainda escolhe o frete e a forma de pagamento antes de confirmar — nada é cobrado
          agora.
        </p>
      </div>
    </form>
  );
}
