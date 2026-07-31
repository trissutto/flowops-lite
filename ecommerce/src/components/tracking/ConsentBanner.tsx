'use client';

/**
 * BANNER DE CONSENTIMENTO (LGPD).
 *
 * Três decisões que valem registro:
 *
 * 1. "Só o necessário" tem o MESMO peso visual de "Aceitar tudo". Recusar
 *    escondido atrás de link cinza é dark pattern, e a ANPD trata como
 *    consentimento não-livre — ou seja, inválido.
 * 2. Nada é pré-marcado. Os interruptores nascem desligados; a visitante liga
 *    o que quiser.
 * 3. Não bloqueia a loja. É uma faixa embaixo, não um modal com overlay: quem
 *    não decidiu continua navegando, só não é rastreada por terceiro.
 */

import { useEffect, useState } from 'react';
import { acceptAll, getConsent, hydrateConsent, needsDecision, rejectAll, setConsent } from '@/lib/tracking/consent';

export function ConsentBanner() {
  const [visivel, setVisivel] = useState(false);
  const [detalhes, setDetalhes] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [personalization, setPersonalization] = useState(false);

  // Só depois da hidratação: renderizar no servidor causaria mismatch (o
  // servidor não tem como saber o que está no localStorage da visitante).
  useEffect(() => {
    hydrateConsent();
    setVisivel(needsDecision());
    const atual = getConsent();
    setAnalytics(atual.analytics);
    setMarketing(atual.marketing);
    setPersonalization(atual.personalization);
  }, []);

  if (!visivel) return null;

  const fechar = () => setVisivel(false);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="consent-title"
      className="fixed inset-x-0 bottom-0 z-[80] border-t border-black/10 bg-[#fcfaf7] px-4 py-5 shadow-[0_-8px_32px_rgba(0,0,0,0.08)] sm:px-6"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div>
          <p className="eyebrow text-primary-strong">Privacidade</p>
          <h2 id="consent-title" className="mt-1 font-serif text-lg text-ink">
            A gente usa cookies para melhorar sua experiência
          </h2>
          <p className="mt-1.5 max-w-2xl text-small leading-relaxed text-ink/70">
            Alguns são essenciais para a loja funcionar. Os outros nos ajudam a entender o que você
            gosta e a mostrar peças que combinam com você. Você escolhe — e pode mudar de ideia
            quando quiser.
          </p>
        </div>

        {detalhes && (
          <fieldset className="grid gap-3 rounded-sm border border-black/10 bg-white/60 p-4 sm:grid-cols-2">
            <legend className="sr-only">Escolha as finalidades</legend>

            <Opcao titulo="Essenciais" descricao="Carrinho, login e segurança. Sem eles a loja não funciona." checked disabled />
            <Opcao
              titulo="Análise"
              descricao="Quais páginas funcionam e onde a navegação trava."
              checked={analytics}
              onChange={setAnalytics}
            />
            <Opcao
              titulo="Publicidade"
              descricao="Medir os anúncios que trouxeram você até aqui."
              checked={marketing}
              onChange={setMarketing}
            />
            <Opcao
              titulo="Personalização"
              descricao="Recomendações e gravação de sessão para melhorar o site."
              checked={personalization}
              onChange={setPersonalization}
            />
          </fieldset>
        )}

        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-end">
          <button
            type="button"
            onClick={() => setDetalhes((v) => !v)}
            className="link-underline mr-auto text-small text-ink/70 hover:text-ink"
          >
            {detalhes ? 'Ocultar opções' : 'Escolher o que permitir'}
          </button>

          {detalhes ? (
            <button
              type="button"
              onClick={() => {
                setConsent({ analytics, marketing, personalization });
                fechar();
              }}
              className="rounded-sm border border-ink px-6 py-2.5 text-small font-medium text-ink transition-colors hover:bg-ink hover:text-light"
            >
              Salvar escolhas
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                rejectAll();
                fechar();
              }}
              className="rounded-sm border border-ink px-6 py-2.5 text-small font-medium text-ink transition-colors hover:bg-ink hover:text-light"
            >
              Só o necessário
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              acceptAll();
              fechar();
            }}
            className="rounded-sm bg-ink px-6 py-2.5 text-small font-medium text-light transition-colors hover:bg-primary-strong"
          >
            Aceitar tudo
          </button>
        </div>
      </div>
    </div>
  );
}

function Opcao({
  titulo,
  descricao,
  checked,
  disabled,
  onChange,
}: {
  titulo: string;
  descricao: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <label className={`flex gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-primary-strong)]"
      />
      <span>
        <span className="block text-small font-medium text-ink">{titulo}</span>
        <span className="block text-xs leading-relaxed text-ink/60">{descricao}</span>
      </span>
    </label>
  );
}
