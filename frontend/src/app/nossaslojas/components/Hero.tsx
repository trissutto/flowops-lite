'use client';

import Image from 'next/image';
import { motion } from 'framer-motion';
import { MapPin, LocateFixed, ChevronDown } from 'lucide-react';
import { site, imgSrc, BLUR_DATA_URL } from '../lib';

interface Props {
  onFindStore: () => void;
  onLocate: () => void;
}

export default function Hero({ onFindStore, onLocate }: Props) {
  return (
    <section className="relative flex min-h-[100svh] items-center justify-center overflow-hidden">
      {/* Fotografia editorial com zoom-out lento na entrada */}
      <motion.div
        initial={{ scale: 1.06 }}
        animate={{ scale: 1 }}
        transition={{ duration: 2.2, ease: [0.22, 1, 0.36, 1] }}
        className="absolute inset-0"
      >
        <Image
          src={imgSrc(site.heroImage, 2000)}
          alt="Mulheres plus size em produção editorial de moda — Lurds Plus Size"
          fill
          priority
          sizes="100vw"
          placeholder="blur"
          blurDataURL={BLUR_DATA_URL}
          className="object-cover object-center"
        />
      </motion.div>
      {/* Gradiente leve só pra ancorar o texto — a foto continua protagonista */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/25 to-black/55" />

      <div className="relative z-10 mx-auto max-w-4xl px-6 text-center text-white">
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="text-[11px] font-medium uppercase tracking-[0.4em] text-[var(--lj-gold-soft)]"
        >
          Lurd&apos;s Plus Size
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: 26 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.35 }}
          className="lojas-serif mt-7 text-4xl font-medium leading-[1.08] sm:text-6xl lg:text-7xl"
        >
          Encontre a Lurds
          <br />
          <span className="italic text-[var(--lj-gold-soft)]">mais próxima</span> de você
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 26 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.5 }}
          className="mx-auto mt-8 max-w-2xl text-base font-light leading-relaxed text-white/85 sm:text-lg"
        >
          Mais do que lojas. Espaços criados para acolher mulheres reais, com atendimento
          especializado, provadores confortáveis e moda plus size feita para vestir autoestima.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 26 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.65 }}
          className="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4"
        >
          <button
            onClick={onFindStore}
            className="group inline-flex w-full items-center justify-center gap-3 rounded-full bg-white px-9 py-4 text-sm font-medium uppercase tracking-[0.18em] text-[var(--lj-ink)] transition-all duration-300 hover:bg-[var(--lj-gold-soft)] sm:w-auto"
          >
            <MapPin className="h-4 w-4 text-[var(--lj-gold-strong)] transition-colors group-hover:text-[var(--lj-ink)]" />
            Encontrar minha loja
          </button>
          <button
            onClick={onLocate}
            className="inline-flex w-full items-center justify-center gap-3 rounded-full border border-white/60 px-9 py-4 text-sm font-medium uppercase tracking-[0.18em] text-white transition-all duration-300 hover:border-white hover:bg-white/10 sm:w-auto"
          >
            <LocateFixed className="h-4 w-4" />
            Usar minha localização
          </button>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.6, duration: 1 }}
        className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2"
      >
        <ChevronDown className="h-6 w-6 animate-bounce text-white/80" aria-hidden />
      </motion.div>
    </section>
  );
}
