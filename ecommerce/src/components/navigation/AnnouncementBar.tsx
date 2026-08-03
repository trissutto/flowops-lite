'use client';

import { useEffect, useState } from 'react';
import { AppLink as Link } from '@/components/ui/AppLink';
import { motion } from 'framer-motion';
import { announcements as padrao } from '@/data/navigation';
import { transition } from '@/lib/motion';

/**
 * AnnouncementBar — 36px, discreta, mensagens rotativas.
 *
 * As frases vêm do cadastro de banners da retaguarda (slot 'tarja-topo'),
 * entregues pelo layout. Lista vazia = cai nas frases padrão de
 * `data/navigation.ts` — a tarja nunca fica em branco.
 */
export function AnnouncementBar({ itens }: { itens?: { label: string; href: string }[] }) {
  const announcements = itens?.length ? itens : padrao;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (announcements.length <= 1) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % announcements.length), 5000);
    return () => clearInterval(timer);
  }, [announcements.length]);

  const current = announcements[index];

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
            className="eyebrow text-[0.625rem] text-light/85 transition-colors hover:text-primary-soft"
          >
            {current.label}
          </Link>
        </motion.div>
      </div>
    </div>
  );
}
