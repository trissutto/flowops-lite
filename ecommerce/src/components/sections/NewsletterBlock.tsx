'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Container } from '@/components/layout/Container';
import { cn } from '@/lib/utils';
import { fadeUp, reveal } from '@/lib/motion';

/**
 * NEWSLETTER — bloco de seção, NUNCA popup.
 *
 * Regra da marca: um campo só (e-mail), muito espaço em branco, e a promessa
 * é de curadoria, não de desconto. Pop-up interrompendo a navegação é o
 * oposto do que uma marca premium faz.
 *
 * Validação com Zod + react-hook-form (padrão de formulários do projeto).
 */

const schema = z.object({
  email: z.string().min(1, 'Informe seu e-mail').email('Confira o e-mail digitado'),
});

type FormValues = z.infer<typeof schema>;

interface NewsletterBlockProps {
  eyebrow?: string;
  title?: React.ReactNode;
  description?: string;
  tone?: 'default' | 'dark' | 'champagne';
  /** Integração real entra aqui (Brevo/Mailchimp/API do FlowOps). */
  onSubscribe?: (email: string) => Promise<void> | void;
  className?: string;
}

export function NewsletterBlock({
  eyebrow = 'Newsletter',
  title = (
    <>
      Novidades antes de todo mundo,
      <br />
      <span className="italic">sem lotar sua caixa</span>
    </>
  ),
  description = 'Uma mensagem por semana com lançamentos, editoriais e o que chegou na loja mais perto de você.',
  tone = 'champagne',
  onSubscribe,
  className,
}: NewsletterBlockProps) {
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const isDark = tone === 'dark';

  async function submit(values: FormValues) {
    await onSubscribe?.(values.email);
    setDone(true);
  }

  return (
    <section
      className={cn(
        'py-section',
        tone === 'dark' && 'bg-ink text-light',
        tone === 'champagne' && 'bg-champagne',
        tone === 'default' && 'bg-background',
        className,
      )}
    >
      <Container width="text">
        <motion.div {...reveal(fadeUp)} className="text-center">
          <p className={cn('eyebrow', isDark ? 'text-primary-soft' : 'text-primary-strong')}>
            {eyebrow}
          </p>
          <h2 className={cn('mt-5 text-h2', isDark ? 'text-light' : 'text-ink')}>{title}</h2>
          <p
            className={cn(
              'mx-auto mt-6 max-w-xl text-body font-light',
              isDark ? 'text-light/70' : 'text-ink-soft',
            )}
          >
            {description}
          </p>

          {done ? (
            <p
              className={cn(
                'mt-10 inline-flex items-center gap-2.5 text-body',
                isDark ? 'text-light' : 'text-ink',
              )}
              role="status"
            >
              <Check className="size-4 text-success" strokeWidth={2.5} />
              Pronto! Você vai receber nossa próxima seleção.
            </p>
          ) : (
            <form
              onSubmit={handleSubmit(submit)}
              className="mx-auto mt-10 flex max-w-md flex-col gap-3 sm:flex-row"
              noValidate
            >
              <Input
                {...register('email')}
                type="email"
                label="Seu e-mail"
                hideLabel
                placeholder="seu@email.com"
                autoComplete="email"
                error={errors.email?.message}
                className="flex-1 text-left"
              />
              <Button type="submit" disabled={isSubmitting} className="sm:w-auto" block>
                {isSubmitting ? 'Enviando…' : 'Quero receber'}
              </Button>
            </form>
          )}

          <p
            className={cn(
              'mx-auto mt-5 max-w-sm text-small font-light',
              isDark ? 'text-light/50' : 'text-ink-muted',
            )}
          >
            Você pode cancelar quando quiser. A gente não compartilha seu e-mail.
          </p>
        </motion.div>
      </Container>
    </section>
  );
}
