'use client';

import { motion } from 'framer-motion';
import { MapPin, MessageCircle } from 'lucide-react';
import { mapEmbedUrl, whatsappUrl, directionsUrl, fullAddress, type Store } from '../lib';

interface Props {
  store: Store;
}

/**
 * Mapa Google sincronizado com o card selecionado.
 * Embed keyless (sem API key) — trocar o src recentraliza. `key` força o
 * remount do iframe pra transição limpa entre lojas.
 */
export default function MapPanel({ store }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.7 }}
      className="overflow-hidden rounded-3xl border border-[var(--lj-line)] bg-white shadow-[0_20px_60px_-40px_rgba(33,28,24,0.4)]"
    >
      <div className="relative aspect-[4/3] w-full lg:aspect-square">
        <iframe
          key={store.slug}
          src={mapEmbedUrl(store)}
          title={`Mapa — Lurds Plus Size ${store.unit}`}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
          className="absolute inset-0 h-full w-full border-0"
        />
      </div>
      <div className="border-t border-[var(--lj-line)] p-5">
        <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-[var(--lj-gold-strong)]">
          Você está vendo
        </p>
        <h3 className="lojas-serif mt-1.5 text-xl font-medium">Lurds {store.unit}</h3>
        <p className="mt-1.5 text-xs font-light leading-relaxed text-[var(--lj-ink-soft)]">
          {fullAddress(store)}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <a
            href={directionsUrl(store)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--lj-ink)] px-3 py-2.5 text-xs font-medium text-white transition-colors hover:bg-[var(--lj-gold-strong)]"
          >
            <MapPin className="h-3.5 w-3.5" /> Como chegar
          </a>
          <a
            href={whatsappUrl(store)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2E7D46] px-3 py-2.5 text-xs font-medium text-white transition-colors hover:bg-[#256538]"
          >
            <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
          </a>
        </div>
      </div>
    </motion.div>
  );
}
