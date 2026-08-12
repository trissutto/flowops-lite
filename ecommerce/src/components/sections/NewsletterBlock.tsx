'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Container } from '@/components/layout/Container';
import { cn } from '@/lib/utils';
import { fadeUp, reveal } from '@/lib/motion';

/**
 * NEWSLETTER — bloco de seção: um campo só (e-mail), muito espaço em branco,
 * e a promessa é de curadoria, não de desconto.
 *
 * ⚠️ Dizia aqui "NUNCA popup". Mudou em 12/08/2026, por decisão do dono: o
 * site ganhou o `CupomBoasVindas`, que troca nome/celular/e-mail por 10% na
 * primeira compra. Não é este bloco virando popup — são duas conversas: aqui
 * é quem rolou até o rodapé e quer curadoria; lá é quem ainda não comprou e
 * responde a uma oferta. O popup carrega as regras (rolagem + 15s, uma vez
 * por pessoa, nunca no checkout) que evitam justamente o comportamento
 * agressivo que esta linha queria barrar.
 *
 * ⚠️ EXCEÇÃO CONSCIENTE ao padrão de formulários do projeto (react-hook-form
 * + Zod). Este bloco fecha a HOME, e arrastar as três bibliotecas
 * (react-hook-form, zod e @hookform/resolvers) pra dentro do bundle da página
 * mais visitada do site custava ~80 kB — por UM campo de e-mail. O checkout,
 * que tem formulário de verdade, continua no padrão. Se este bloco algum dia
 * ganhar mais campos, volte pro react-hook-form.
 */

/** Suficiente pra um campo de newsletter: o servidor valida de novo. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const isDark = tone === 'dark';

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = email.trim();
    const problema = !value
      ? 'Informe seu e-mail'
      : !EMAIL.test(value)
        ? 'Confira o e-mail digitado'
        : undefined;

    setError(problema);
    if (problema) return;

    setSubmitting(true);
    try {
      await onSubscribe?.(value);
      setDone(true);
    } catch {
      setError('Não deu pra cadastrar agora. Tente de novo em instantes.');
    } finally {
      setSubmitting(false);
    }
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
              onSubmit={submit}
              className="mx-auto mt-10 flex max-w-md flex-col gap-3 sm:flex-row"
              noValidate
            >
              <Input
                name="email"
                type="email"
                label="Seu e-mail"
                hideLabel
                placeholder="seu@email.com"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  // Some com o erro assim que ela começa a corrigir.
                  if (error) setError(undefined);
                }}
                error={error}
                className="flex-1 text-left"
              />
              <Button type="submit" disabled={submitting} className="sm:w-auto" block>
                {submitting ? 'Enviando…' : 'Quero receber'}
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
