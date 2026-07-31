'use client';

import { motion } from 'framer-motion';
import { site } from '../lib';

/** Seção institucional — tradição, acolhimento e os números da rede (tudo do JSON). */
export default function Manifesto() {
  return (
    <section className="px-6 py-24 sm:py-32">
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
          <h2 className="lojas-serif mt-5 text-3xl font-medium leading-tight sm:text-5xl">
            {site.manifesto.title}
          </h2>
          <div className="lojas-rule mx-auto mt-7 w-24" />
          <p className="mx-auto mt-8 max-w-2xl text-base font-light leading-loose text-[var(--lj-ink-soft)] sm:text-lg">
            {site.manifesto.text}
          </p>
        </motion.div>

        <div className="mt-16 grid grid-cols-2 gap-x-6 gap-y-12 sm:grid-cols-4">
          {site.manifesto.stats.map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.6, delay: i * 0.12 }}
            >
              <p className="lojas-serif text-4xl font-medium text-[var(--lj-gold-strong)] sm:text-5xl">
                {stat.value}
              </p>
              <p className="mt-3 text-[11px] font-medium uppercase tracking-[0.3em] text-[var(--lj-ink-soft)]">
                {stat.label}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
