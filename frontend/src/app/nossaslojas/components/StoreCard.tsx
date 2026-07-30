'use client';

import { motion } from 'framer-motion';
import { MapPin, MessageCircle, Instagram, Clock, Phone } from 'lucide-react';
import { fullAddress, whatsappUrl, instagramUrl, directionsUrl, type Store } from '../lib';
import EditorialVisual from './EditorialVisual';

interface Props {
  store: Store;
  index: number;
  isSelected: boolean;
  isNearest: boolean;
  onSelect: () => void;
}

export default function StoreCard({ store, index, isSelected, isNearest, onSelect }: Props) {
  return (
    <motion.article
      id={`loja-${store.slug}`}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.6, delay: (index % 2) * 0.08 }}
      onClick={onSelect}
      className={`group scroll-mt-24 cursor-pointer overflow-hidden rounded-3xl border bg-white transition-all duration-300 ${
        isSelected
          ? 'border-[var(--lj-gold)] shadow-[0_24px_60px_-30px_rgba(140,115,37,0.45)]'
          : 'border-[var(--lj-line)] shadow-[0_10px_40px_-30px_rgba(33,28,24,0.35)] hover:border-[var(--lj-gold)]/50 hover:shadow-[0_20px_50px_-30px_rgba(140,115,37,0.35)]'
      }`}
    >
      {/* Imagem lifestyle (arte editorial enquanto não há foto no JSON) */}
      <div className="relative">
        <EditorialVisual
          seed={index}
          initial={store.unit.charAt(0)}
          image={store.image}
          alt={`Loja Lurds Plus Size ${store.unit}`}
          className="aspect-[4/3] w-full"
        />
        <div className="absolute left-4 top-4 flex gap-2">
          {isNearest && (
            <span className="rounded-full bg-[var(--lj-ink)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--lj-gold-soft)]">
              Mais perto de você
            </span>
          )}
          {isSelected && (
            <span className="rounded-full bg-[var(--lj-gold-strong)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white">
              No mapa
            </span>
          )}
        </div>
      </div>

      <div className="p-6">
        <p className="text-[10px] font-medium uppercase tracking-[0.3em] text-[var(--lj-gold-strong)]">
          {store.city} · {store.uf}
        </p>
        <h3 className="lojas-serif mt-2 text-2xl font-medium">Lurds {store.unit}</h3>
        <p className="mt-2 text-sm font-light leading-relaxed text-[var(--lj-ink-soft)]">
          {store.description}
        </p>

        <ul className="mt-5 space-y-2.5 text-[13px] leading-snug text-[var(--lj-ink-soft)]">
          <li className="flex gap-2.5">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" />
            <span>{fullAddress(store)}</span>
          </li>
          <li className="flex gap-2.5">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" />
            <span>{store.hours.display.join(' · ')}</span>
          </li>
          <li className="flex gap-2.5">
            <Phone className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" />
            <a href={`tel:+55${store.whatsapp.slice(2)}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
              {store.phone}
            </a>
          </li>
          <li className="flex gap-2.5">
            <Instagram className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" />
            <span>@{store.instagram}</span>
          </li>
        </ul>

        <div className="mt-6 grid grid-cols-3 gap-2">
          <a
            href={directionsUrl(store)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--lj-ink)] px-3 py-2.5 text-xs font-medium text-white transition-colors hover:bg-[var(--lj-gold-strong)]"
          >
            <MapPin className="h-3.5 w-3.5" /> Como chegar
          </a>
          <a
            href={whatsappUrl(store)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2E7D46] px-3 py-2.5 text-xs font-medium text-white transition-colors hover:bg-[#256538]"
          >
            <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
          </a>
          <a
            href={instagramUrl(store)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--lj-gold)] px-3 py-2.5 text-xs font-medium text-[var(--lj-gold-strong)] transition-colors hover:bg-[#FBF6E6]"
          >
            <Instagram className="h-3.5 w-3.5" /> Instagram
          </a>
        </div>
      </div>
    </motion.article>
  );
}
