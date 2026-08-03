'use client';

import Image from 'next/image';
import { motion } from 'framer-motion';
import { Sparkles, HeartHandshake, Shirt, Store } from 'lucide-react';
import { site, imgSrc, BLUR_DATA_URL } from '../lib';

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
    <section className="bg-[var(--lj-cream)] px-6 py-24 sm:py-32">
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

        <div className="mt-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
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
              <h3 className="lojas-serif mt-6 text-xl font-medium">{r.title}</h3>
              <p className="mt-3 text-sm font-light leading-relaxed text-[var(--lj-ink-soft)]">
                {r.text}
              </p>
            </motion.div>
          ))}
        </div>

        {/* Quem te recebe — moda vende pessoas */}
        <div className="mt-24 grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <motion.div
            initial={{ opacity: 0, x: -24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.8 }}
            className="relative aspect-[4/3] overflow-hidden rounded-3xl shadow-[0_24px_60px_-35px_rgba(33,28,24,0.5)]"
          >
            <Image
              src={imgSrc(site.peopleImage, 1200)}
              alt="Consultora recebendo cliente em uma boutique — atendimento Lurds"
              fill
              sizes="(max-width: 1024px) 100vw, 50vw"
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className="object-cover"
            />
          </motion.div>
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.8 }}
          >
            <p className="text-[11px] font-medium uppercase tracking-[0.35em] text-[var(--lj-gold-strong)]">
              Quem te recebe
            </p>
            <h3 className="lojas-serif mt-5 text-3xl font-medium leading-tight sm:text-4xl">
              Você chega cliente,
              <br />
              <span className="italic text-[var(--lj-gold-strong)]">sai de casa nova</span>
            </h3>
            <p className="mt-6 text-base font-light leading-loose text-[var(--lj-ink-soft)]">
              Em cada Lurds tem uma equipe que sabe receber: consultoras treinadas em caimento e
              estilo, provadores amplos onde ninguém te apressa, e aquele cafezinho enquanto você
              decide. A gente não te empurra uma peça — te ajuda a encontrar a sua.
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
