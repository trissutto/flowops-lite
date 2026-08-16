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
  /**
   * CAPA: foto oficial do cadastro > arte tipográfica da marca.
   *
   * A segunda é o estado de hoje (16/08/2026): as fotos de banco de imagem
   * saíram do `lojas.json` — só foto oficial da Lurds entra no ar. Sem capa a
   * página NÃO fica sem hero: entra tinta + halo dourado + monograma, e o
   * texto branco continua legível. Preencher `site.heroImage` traz a foto.
   */
  const capa = site.heroImage ? imgSrc(site.heroImage, 2000) : null;

  return (
    <section className="relative flex min-h-[100svh] items-center justify-center overflow-hidden bg-[var(--lj-ink)]">
      {capa ? (
        /* Fotografia editorial com zoom-out lento na entrada */
        <motion.div
          initial={{ scale: 1.06 }}
          animate={{ scale: 1 }}
          transition={{ duration: 2.2, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0"
        >
          <Image
            src={capa}
            alt="Lurd's Plus Size — moda plus size elegante"
            fill
            priority
            sizes="100vw"
            placeholder="blur"
            blurDataURL={BLUR_DATA_URL}
            className="object-cover object-center"
          />
        </motion.div>
      ) : (
        <div className="lojas-grain absolute inset-0" aria-hidden>
          <div
            className="absolute -right-32 -top-40 h-[42rem] w-[42rem] rounded-full opacity-45 blur-3xl"
            style={{ background: 'radial-gradient(circle, var(--lj-gold) 0%, transparent 70%)' }}
          />
          <div
            className="absolute -bottom-48 -left-40 h-[38rem] w-[38rem] rounded-full opacity-25 blur-3xl"
            style={{ background: 'radial-gradient(circle, var(--lj-gold-soft) 0%, transparent 70%)' }}
          />
          <span className="lojas-serif absolute inset-0 flex items-center justify-center text-[52vw] font-medium italic leading-none text-white/[0.05] sm:text-[26rem]">
            L
          </span>
        </div>
      )}
      {/* Gradiente leve só pra ancorar o texto — a foto continua protagonista */}
      {capa && <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/25 to-black/55" />}

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
