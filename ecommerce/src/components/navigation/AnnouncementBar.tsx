'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppLink as Link } from '@/components/ui/AppLink';
import { motion } from 'framer-motion';
import { announcements as padrao } from '@/data/navigation';
import { useLojaConfig } from '@/hooks/useLojaConfig';
import { transition } from '@/lib/motion';
import { formatPrice } from '@/lib/utils';

/**
 * AnnouncementBar — 36px, discreta, mensagens rotativas.
 *
 * As frases vêm do cadastro de banners da retaguarda (slot 'tarja-topo'),
 * entregues pelo layout. Lista vazia = cai nas frases padrão de
 * `data/navigation.ts` — a tarja nunca fica em branco.
 *
 * `{FRETE_GRATIS}` vira o valor da régua vigente (dono, 12/08). O marcador
 * existe pra que o número apareça na barra sem nunca ser escrito à mão em
 * lugar nenhum: quem sabe a régua é a config, e ela muda na retaguarda. Se o
 * frete grátis estiver desligado, a frase inteira sai de cena — melhor uma
 * mensagem a menos do que uma promessa que o checkout não cumpre.
 *
 * Vale pras frases do cadastro também: quem escrever `{FRETE_GRATIS}` num
 * banner da retaguarda ganha a mesma substituição.
 */
export function AnnouncementBar({ itens }: { itens?: { label: string; href: string }[] }) {
  const { freteGratis } = useLojaConfig();
  const announcements = useMemo(() => {
    const base = itens?.length ? itens : padrao;
    return base
      .filter((a) => !(a.label.includes('{FRETE_GRATIS}') && !freteGratis.ativo))
      .map((a) =>
        a.label.includes('{FRETE_GRATIS}')
          ? { ...a, label: a.label.replace('{FRETE_GRATIS}', formatPrice(freteGratis.minimo)) }
          : a,
      );
  }, [itens, freteGratis.ativo, freteGratis.minimo]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (announcements.length <= 1) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % announcements.length), 5000);
    return () => clearInterval(timer);
  }, [announcements.length]);

  // A lista encolhe quando o frete grátis é desligado: sem isto o índice
  // ficaria fora do array e a barra sumiria até o próximo giro.
  const current = announcements[index % Math.max(1, announcements.length)];
  if (!current) return null;

  return (
    <div className="relative h-9 overflow-hidden bg-ink text-light">
      {/* aria-live off: mensagem promocional não deve interromper leitor de tela */}
      <div className="mx-auto flex h-full max-w-wide items-center justify-center px-gutter">
        <motion.div
          key={index}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transition.base}
        >
          <Link
            href={current.href}
            className="block max-w-[calc(100vw-2rem)] truncate text-center text-[0.625rem] font-medium tracking-[0.16em] text-light/90 uppercase transition-colors hover:text-primary-soft sm:tracking-[0.28em]"
          >
            {current.label}
          </Link>
        </motion.div>
      </div>
    </div>
  );
}
