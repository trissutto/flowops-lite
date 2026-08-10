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
      className="fixed inset-x-0 bottom-0 z-[80] border-t border-black/10 bg-[#fcfaf7]/98 px-3 py-3 shadow-[0_-8px_32px_rgba(0,0,0,0.08)] backdrop-blur sm:px-6 sm:py-4"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-3 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <p className="eyebrow text-primary-strong">Privacidade</p>
          <h2 id="consent-title" className="mt-0.5 font-serif text-base text-ink sm:text-lg">
            Sua privacidade, suas escolhas
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink/70 sm:text-small">
            Usamos cookies essenciais para a loja e, com sua permissão, para análise e personalização.
          </p>
        </div>

        {detalhes && (
          <fieldset className="grid gap-3 rounded-sm border border-black/10 bg-white/60 p-3 sm:grid-cols-2 lg:order-3 lg:basis-full">
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

        <div className="grid grid-cols-2 gap-2 lg:flex lg:shrink-0 lg:items-center">
          <button
            type="button"
            onClick={() => setDetalhes((v) => !v)}
            className="link-underline col-span-2 text-left text-xs text-ink/70 hover:text-ink lg:order-first lg:col-auto lg:mr-2 lg:text-small"
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
              className="min-h-11 rounded-sm border border-ink px-4 py-2 text-small font-medium text-ink transition-colors hover:bg-ink hover:text-light"
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
              className="min-h-11 rounded-sm border border-ink px-4 py-2 text-small font-medium text-ink transition-colors hover:bg-ink hover:text-light"
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
            className="min-h-11 rounded-sm bg-ink px-4 py-2 text-small font-medium text-light transition-colors hover:bg-primary-strong"
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
