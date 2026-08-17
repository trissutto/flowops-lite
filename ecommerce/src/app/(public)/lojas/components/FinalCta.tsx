'use client';

import { motion } from 'framer-motion';
import { MapPin, MessageCircle } from 'lucide-react';
import { trackStoreLocator, trackWhatsAppClick } from '@/lib/tracking';
import { whatsappUrl, directionsUrl, type Store } from '../lib';

interface Props {
  /** Loja mais próxima quando a visitante liberou a localização; senão, a selecionada. */
  store: Store;
}

export default function FinalCta({ store }: Props) {
  return (
    <section className="relative overflow-hidden px-6 py-14 sm:py-20">
      <div className="lojas-grain absolute inset-0 bg-gradient-to-br from-[var(--lj-champagne)] via-[var(--lj-ivory)] to-[var(--lj-cream)]" />
      <div className="relative z-10 mx-auto max-w-3xl text-center">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7 }}
        >
          <h2 className="lojas-serif text-3xl font-medium leading-tight sm:text-4xl">
            Sua próxima peça favorita
            <br />
            <span className="italic text-[var(--lj-gold-strong)]">está te esperando</span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm font-light leading-relaxed text-[var(--lj-ink-soft)] sm:text-base">
            Passa na Lurds {store.unit} pra experimentar com calma — a gente te recebe com um
            sorriso e um provador só seu.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={directionsUrl(store)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackStoreLocator(store.city, store.unit, 'final_cta')}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--lj-ink)] px-8 py-4 text-sm font-medium uppercase tracking-[0.15em] text-white transition-colors hover:bg-[var(--lj-gold-strong)] sm:w-auto"
            >
              <MapPin className="h-4 w-4" /> Como chegar
            </a>
            <a
              href={whatsappUrl(store)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackWhatsAppClick('final_cta', store.unit)}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#2E7D46] px-8 py-4 text-sm font-medium uppercase tracking-[0.15em] text-white transition-colors hover:bg-[#256538] sm:w-auto"
            >
              <MessageCircle className="h-4 w-4" /> Falar com a loja
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
