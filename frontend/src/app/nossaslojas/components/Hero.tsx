'use client';

import { motion } from 'framer-motion';
import { MapPin, ChevronDown } from 'lucide-react';
import EditorialVisual from './EditorialVisual';

interface Props {
  onFindStore: () => void;
}

export default function Hero({ onFindStore }: Props) {
  return (
    <section className="relative flex min-h-[100svh] items-center justify-center overflow-hidden">
      {/* Fundo editorial — arte em tons champagne com grain (troca por foto em /public/lojas/hero.webp via EditorialVisual) */}
      <EditorialVisual variant="hero" className="absolute inset-0" />
      <div className="absolute inset-0 bg-gradient-to-b from-[rgba(253,251,247,0.15)] via-transparent to-[var(--lj-ivory)]" />

      <div className="relative z-10 mx-auto max-w-4xl px-6 text-center">
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.1 }}
          className="text-[11px] font-medium uppercase tracking-[0.35em] text-[var(--lj-gold-strong)]"
        >
          Lurd&apos;s Plus Size · desde sempre com você
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.25 }}
          className="lojas-serif mt-6 text-4xl font-medium leading-[1.1] sm:text-6xl lg:text-7xl"
        >
          Encontre a Lurds
          <br />
          <span className="italic text-[var(--lj-gold-strong)]">mais perto</span> de você
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.4 }}
          className="mx-auto mt-6 max-w-xl text-base font-light leading-relaxed text-[var(--lj-ink-soft)] sm:text-lg"
        >
          Moda plus size elegante, atendimento acolhedor e peças que valorizam o corpo de verdade —
          em 14 lojas por São Paulo e região.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.55 }}
          className="mt-10"
        >
          <button
            onClick={onFindStore}
            className="group inline-flex items-center gap-3 rounded-full bg-[var(--lj-ink)] px-8 py-4 text-sm font-medium uppercase tracking-[0.18em] text-[var(--lj-ivory)] transition-all hover:bg-[var(--lj-gold-strong)]"
          >
            <MapPin className="h-4 w-4 text-[var(--lj-gold-soft)] transition-colors group-hover:text-[var(--lj-ivory)]" />
            Encontrar minha loja
          </button>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.4, duration: 1 }}
        className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2"
      >
        <ChevronDown className="h-6 w-6 animate-bounce text-[var(--lj-gold-strong)]" aria-hidden />
      </motion.div>
    </section>
  );
}
