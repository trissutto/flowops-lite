'use client';

import { motion } from 'framer-motion';
import { Sparkles, HeartHandshake, Shirt, Store } from 'lucide-react';

const REASONS = [
  {
    icon: Sparkles,
    title: 'Curadoria plus size de verdade',
    text: 'Peças escolhidas pra vestir super bem — do dia a dia ao evento especial.',
  },
  {
    icon: HeartHandshake,
    title: 'Atendimento que acolhe',
    text: 'Consultoras que entendem o seu corpo e o seu estilo, sem pressa e sem julgamento.',
  },
  {
    icon: Shirt,
    title: 'Provador sem pressa',
    text: 'Experimente com calma, receba sugestões e saia segura da escolha.',
  },
  {
    icon: Store,
    title: 'Uma rede inteira com você',
    text: '14 lojas por São Paulo e região, além do site lurds.com.br.',
  },
];

export default function WhyVisit() {
  return (
    <section className="bg-[var(--lj-cream)] px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7 }}
          className="text-center"
        >
          <p className="text-[11px] font-medium uppercase tracking-[0.35em] text-[var(--lj-gold-strong)]">
            A experiência
          </p>
          <h2 className="lojas-serif mt-4 text-3xl font-medium sm:text-4xl">
            Por que visitar uma Lurds
          </h2>
          <div className="lojas-rule mx-auto mt-5 w-24" />
        </motion.div>

        <div className="mt-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {REASONS.map((r, i) => (
            <motion.div
              key={r.title}
              initial={{ opacity: 0, y: 28 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.6, delay: i * 0.1 }}
              className="text-center"
            >
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-[var(--lj-gold)]/40 bg-white">
                <r.icon className="h-6 w-6 text-[var(--lj-gold-strong)]" strokeWidth={1.5} />
              </div>
              <h3 className="lojas-serif mt-5 text-xl font-medium">{r.title}</h3>
              <p className="mt-3 text-sm font-light leading-relaxed text-[var(--lj-ink-soft)]">
                {r.text}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
