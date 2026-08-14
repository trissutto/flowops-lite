'use client';

/**
 * BANNER DE CONSENTIMENTO (LGPD).
 *
 * Três decisões que valem registro:
 *
 * 1. "Só o necessário" tem o MESMO peso visual de "Aceitar". Recusar
 *    escondido atrás de link cinza é dark pattern, e a ANPD trata como
 *    consentimento não-livre — ou seja, inválido.
 * 2. Nada é pré-marcado. Os interruptores nascem desligados; a visitante liga
 *    o que quiser.
 * 3. Não bloqueia a loja. Quem não decidiu continua navegando, só não é
 *    rastreada por terceiro.
 *
 * ── REDESENHO 14/08 (medição: 85% das sessões SEM decisão) ──
 *
 * A faixa cinza colada no rodapé era tão discreta que 794 de 938 sessões em
 * 7 dias simplesmente a IGNORARAM — e ignorar tem o mesmo efeito de recusar:
 * o Meta/GA4 não veem nada (76% dos view_item invisíveis pro remarketing).
 * O redesenho não mexe em NENHUMA regra de consentimento — muda a
 * apresentação: vira um cartão com cara da marca, copy que explica o
 * BENEFÍCIO ("peças do seu gosto") em vez de jargão de cookie, e os dois
 * botões lado a lado com o mesmo tamanho. Continua não-bloqueante.
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
      /* bottom-24 no mobile (medição 14/08, viewport 375×812): o cartão tem
         ~280px e terminava em y=800, POR CIMA da barra fixa de compra da PDP
         (y=719, z-40 contra z-80 daqui) — cliente nova no celular não
         alcançava o "Adicionar à sacola" sem decidir o cookie primeiro.
         Consentimento nunca pode ser pedágio da compra: sobe 96px e as duas
         coisas convivem. No desktop (lg) não há barra fixa — volta pro pé. */
      className="fixed inset-x-0 bottom-24 z-[80] p-3 sm:p-5 lg:bottom-0"
    >
      {/* Cartão da marca, não faixa de sistema: borda dourada, sombra de
          elevação e largura de leitura. É pra parecer parte da loja falando —
          a faixa cinza anterior parecia aviso de navegador e sumia no rodapé. */}
      <div className="mx-auto max-w-xl rounded-md border border-primary/30 bg-[#fcfaf7] p-4 shadow-[0_12px_48px_rgba(0,0,0,0.18)] sm:p-6">
        <h2 id="consent-title" className="font-serif text-lg text-ink">
          Podemos deixar o site com a sua cara?
        </h2>
        <p className="mt-1.5 text-small leading-relaxed text-ink/75">
          Com a sua permissão, usamos cookies pra te mostrar peças do seu gosto e do seu número —
          e pra saber quais anúncios valem a pena. Você escolhe, e muda quando quiser.
        </p>

        {detalhes && (
          <fieldset className="mt-4 grid gap-3 rounded-sm border border-black/10 bg-white/60 p-3 sm:grid-cols-2">
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

        {/* HIERARQUIA (dono, 14/08): o Aceitar é O botão — largura cheia,
            alto, dourado da marca. O limite que não se cruza (ANPD): recusar
            continua sendo um BOTÃO visível de UM clique logo abaixo, não um
            link escondido — destaque visual é permitido, fricção não. */}
        <div className="mt-4 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => {
              acceptAll();
              fechar();
            }}
            className="min-h-14 w-full rounded-sm bg-primary-strong px-4 py-3 text-[1.05rem] font-semibold tracking-wide text-light shadow-[0_4px_16px_rgba(184,145,43,0.35)] transition-all duration-[180ms] hover:bg-ink hover:shadow-none"
          >
            {/* Responde a pergunta do título — "Podemos deixar o site com a sua
                cara?" → "Pode sim!". Conversa, não contrato. O rótulo só é
                honesto PORQUE a pergunta está logo acima: se o título mudar,
                este botão muda junto. */}
            Pode sim!
          </button>

          <div className="flex items-center justify-between gap-3">
            {detalhes ? (
              <button
                type="button"
                onClick={() => {
                  setConsent({ analytics, marketing, personalization });
                  fechar();
                }}
                className="min-h-10 rounded-sm border border-black/15 px-4 py-1.5 text-small text-ink/80 transition-colors hover:border-ink hover:text-ink"
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
                className="min-h-10 rounded-sm border border-black/15 px-4 py-1.5 text-small text-ink/80 transition-colors hover:border-ink hover:text-ink"
              >
                Só o necessário
              </button>
            )}

            <button
              type="button"
              onClick={() => setDetalhes((v) => !v)}
              className="link-underline text-xs text-ink/60 hover:text-ink"
            >
              {detalhes ? 'Ocultar opções' : 'Escolher o que permitir'}
            </button>
          </div>
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
