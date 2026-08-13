'use client';

import { motion } from 'framer-motion';
import { MapPin, MessageCircle, Clock, Phone } from 'lucide-react';
import { InstagramIcon as Instagram } from '@/components/ui/icons';
import { trackInstagramClick, trackPhoneClick, trackStoreLocator, trackWhatsAppClick } from '@/lib/tracking';
import {
  fullAddress,
  whatsappUrl,
  instagramUrl,
  directionsUrl,
  badgesFor,
  type Store,
} from '../lib';

interface Props {
  store: Store;
  index: number;
  isSelected: boolean;
  isNearest: boolean;
  onSelect: () => void;
  /** Abre o drawer-galeria da unidade. */
  onOpen: () => void;
}

export default function StoreCard({ store, index, isSelected, isNearest, onSelect, onOpen }: Props) {
  return (
    <motion.article
      id={`loja-${store.slug}`}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.6, delay: (index % 3) * 0.07 }}
      onClick={() => {
        onSelect();
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Conhecer a loja Lurds ${store.unit}`}
      className={`group scroll-mt-24 cursor-pointer overflow-hidden rounded-3xl border bg-white transition-all duration-500 ease-out hover:-translate-y-1.5 ${
        isSelected
          ? 'border-[var(--lj-gold)] shadow-[0_24px_60px_-30px_rgba(140,115,37,0.45)]'
          : 'border-[var(--lj-line)] shadow-[0_10px_40px_-30px_rgba(33,28,24,0.35)] hover:border-[var(--lj-gold)]/50 hover:shadow-[0_32px_70px_-30px_rgba(140,115,37,0.5)]'
      }`}
    >
      <div className="p-7">
        {isNearest && (
          <div className="mb-4 flex gap-2">
            <span className="rounded-full bg-[var(--lj-ink)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--lj-gold-soft)]">
              Mais perto de você
            </span>
          </div>
        )}

        {/* Cidade/unidade é a protagonista do card — caixa alta, serif, grande */}
        <p className="text-[10px] font-medium uppercase tracking-[0.32em] text-[var(--lj-ink-soft)]">
          Lurds · {store.city}/{store.uf}
        </p>
        <h3 className="lojas-serif mt-2.5 text-3xl font-semibold uppercase leading-tight tracking-[0.05em] text-[var(--lj-ink)] sm:text-[2.1rem]">
          {store.unit}
        </h3>
        <div className="mt-4 h-[2px] w-12 bg-[var(--lj-gold)] transition-all duration-500 group-hover:w-20" />

        <p className="mt-4 text-sm font-light leading-relaxed text-[var(--lj-ink-soft)]">
          {store.description}
        </p>

        {/* Diferenciais da unidade */}
        <ul className="mt-5 flex flex-wrap gap-1.5" aria-label="Diferenciais da loja">
          {badgesFor(store).map((b) => (
            <li
              key={b}
              className="rounded-full border border-[var(--lj-gold)]/30 bg-[var(--lj-ivory)] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--lj-gold-strong)]"
            >
              {b}
            </li>
          ))}
        </ul>

        <ul className="mt-6 space-y-3 text-[13px] leading-snug text-[var(--lj-ink-soft)]">
          <li className="flex gap-2.5">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} />
            <span>{fullAddress(store)}</span>
          </li>
          <li className="flex gap-2.5">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} />
            <span>{store.hours.display.join(' · ')}</span>
          </li>
          <li className="flex gap-2.5">
            <Phone className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} />
            <a
              href={`tel:+55${store.whatsapp.slice(2)}`}
              className="hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                trackPhoneClick(store.unit, 'store_card');
              }}
            >
              {store.phone}
            </a>
          </li>
          <li className="flex gap-2.5">
            <Instagram className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} />
            <span>@{store.instagram}</span>
          </li>
        </ul>

        <div className="mt-7 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <a
            href={directionsUrl(store)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.stopPropagation();
              trackStoreLocator(store.city, store.unit, 'store_card');
            }}
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--lj-ink)] px-3 py-3 text-xs font-medium text-white transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--lj-gold-strong)] sm:py-2.5"
          >
            <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} /> Como chegar
          </a>
          <a
            href={whatsappUrl(store)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.stopPropagation();
              trackWhatsAppClick('store_card', store.unit);
            }}
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2E7D46] px-3 py-3 text-xs font-medium text-white transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#256538] sm:py-2.5"
          >
            <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.75} /> WhatsApp
          </a>
          <a
            href={instagramUrl(store)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.stopPropagation();
              trackInstagramClick('store_card', store.unit);
            }}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--lj-gold)] px-3 py-3 text-xs font-medium text-[var(--lj-gold-strong)] transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#FBF6E6] sm:py-2.5"
          >
            <Instagram className="h-3.5 w-3.5" strokeWidth={1.75} /> Instagram
          </a>
        </div>
      </div>
    </motion.article>
  );
}
