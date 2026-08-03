'use client';

import { motion } from 'framer-motion';
import { InstagramIcon as Instagram } from '@/components/ui/icons';
import { instagramUrl, type Store } from '../lib';

interface Props {
  store: Store;
}

/** Painel do Instagram da loja selecionada — acompanha a seleção do grid/mapa. */
export default function InstagramCta({ store }: Props) {
  return (
    <section className="bg-[var(--lj-ink)] px-6 py-24 text-[var(--lj-ivory)] sm:py-32">
      <div className="mx-auto max-w-3xl text-center">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7 }}
        >
          <Instagram className="mx-auto h-8 w-8 text-[var(--lj-gold-soft)]" strokeWidth={1.25} />
          <p className="mt-5 text-[11px] font-medium uppercase tracking-[0.35em] text-[var(--lj-gold-soft)]">
            Instagram da loja selecionada
          </p>
          <h2 className="lojas-serif mt-4 text-3xl font-medium sm:text-4xl">
            Os looks da Lurds {store.unit}, todo dia no seu feed
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm font-light leading-relaxed text-[var(--lj-ivory)]/70">
            Novidades da semana, provadores reais e os lançamentos que chegam primeiro na loja de{' '}
            {store.city}. Siga e chegue já sabendo o que quer provar.
          </p>
          <a
            href={instagramUrl(store)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-8 inline-flex items-center gap-3 rounded-full border border-[var(--lj-gold-soft)] px-8 py-4 text-sm font-medium uppercase tracking-[0.18em] text-[var(--lj-gold-soft)] transition-colors hover:bg-[var(--lj-gold-soft)] hover:text-[var(--lj-ink)]"
          >
            <Instagram className="h-4 w-4" />@{store.instagram}
          </a>
        </motion.div>
      </div>
    </section>
  );
}
