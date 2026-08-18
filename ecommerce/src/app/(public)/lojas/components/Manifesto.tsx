'use client';

import { motion } from 'framer-motion';
import { site } from '../lib';

/** Seção institucional — tradição, acolhimento e os números da rede (tudo do JSON). */
export default function Manifesto() {
  return (
    <section className="bg-[var(--lj-cream)] px-6 py-12 sm:py-16">
      <div className="mx-auto max-w-4xl text-center">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.8 }}
        >
          <p className="text-[11px] font-medium uppercase tracking-[0.35em] text-[var(--lj-gold-strong)]">
            Nossa história
          </p>
          <h2 className="lojas-serif mt-3 text-2xl font-medium leading-tight sm:text-4xl">
            {site.manifesto.title}
          </h2>
          <div className="lojas-rule mx-auto mt-3 w-20" />
          <p className="mx-auto mt-4 max-w-2xl text-sm font-light leading-relaxed text-[var(--lj-ink-soft)] sm:text-base">
            {site.manifesto.text}
          </p>
        </motion.div>

        <div className="mt-7 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4">
          {site.manifesto.stats.map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.6, delay: i * 0.12 }}
            >
              <p className="lojas-serif text-3xl font-medium text-[var(--lj-gold-strong)] sm:text-4xl">
                {stat.value}
              </p>
              <p className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--lj-ink-soft)]">
                {stat.label}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
