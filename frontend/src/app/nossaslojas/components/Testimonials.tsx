'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { testimonials } from '../lib';

export default function Testimonials() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % testimonials.length), 6000);
    return () => clearInterval(t);
  }, [paused]);

  const current = testimonials[index];

  return (
    <section
      className="px-6 py-20 sm:py-24"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.35em] text-[var(--lj-gold-strong)]">
          Quem já visitou
        </p>

        <div className="relative mt-10 min-h-[200px] sm:min-h-[170px]">
          <AnimatePresence mode="wait">
            <motion.blockquote
              key={index}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.45 }}
            >
              <p className="lojas-serif text-2xl font-medium italic leading-snug sm:text-3xl">
                “{current.quote}”
              </p>
              <footer className="mt-6 text-xs font-medium uppercase tracking-[0.25em] text-[var(--lj-ink-soft)]">
                {current.author} · {current.city}
              </footer>
            </motion.blockquote>
          </AnimatePresence>
        </div>

        <div className="mt-8 flex items-center justify-center gap-6">
          <button
            onClick={() => setIndex((i) => (i - 1 + testimonials.length) % testimonials.length)}
            aria-label="Depoimento anterior"
            className="rounded-full border border-[var(--lj-line)] p-2 transition-colors hover:border-[var(--lj-gold)] hover:bg-[#FBF6E6]"
          >
            <ChevronLeft className="h-4 w-4 text-[var(--lj-gold-strong)]" />
          </button>
          <div className="flex gap-2">
            {testimonials.map((_, i) => (
              <button
                key={i}
                onClick={() => setIndex(i)}
                aria-label={`Ver depoimento ${i + 1}`}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === index ? 'w-8 bg-[var(--lj-gold-strong)]' : 'w-1.5 bg-[var(--lj-line)]'
                }`}
              />
            ))}
          </div>
          <button
            onClick={() => setIndex((i) => (i + 1) % testimonials.length)}
            aria-label="Próximo depoimento"
            className="rounded-full border border-[var(--lj-line)] p-2 transition-colors hover:border-[var(--lj-gold)] hover:bg-[#FBF6E6]"
          >
            <ChevronRight className="h-4 w-4 text-[var(--lj-gold-strong)]" />
          </button>
        </div>
      </div>
    </section>
  );
}
