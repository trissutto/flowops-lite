'use client';

import Image from 'next/image';
import { motion } from 'framer-motion';
import { MapPin, MessageCircle, Instagram, Clock, Phone } from 'lucide-react';
import {
  fullAddress,
  whatsappUrl,
  instagramUrl,
  directionsUrl,
  badgesFor,
  imgSrc,
  BLUR_DATA_URL,
  type Store,
} from '../lib';
import EditorialVisual from './EditorialVisual';

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
      transition={{ duration: 0.6, delay: (index % 2) * 0.08 }}
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
      {/* Fotografia editorial — zoom suave de 4% no hover */}
      <div className="relative aspect-[4/3] w-full overflow-hidden">
        {store.image ? (
          <Image
            src={imgSrc(store.image, 900)}
            alt={`Moda plus size na Lurds ${store.unit} — editorial`}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            placeholder="blur"
            blurDataURL={BLUR_DATA_URL}
            className="object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]"
          />
        ) : (
          <EditorialVisual seed={index} initial={store.unit.charAt(0)} className="h-full w-full" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-transparent" />
        <div className="absolute left-4 top-4 flex gap-2">
          {isNearest && (
            <span className="rounded-full bg-[var(--lj-ink)]/90 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--lj-gold-soft)] backdrop-blur-sm">
              Mais perto de você
            </span>
          )}
          {isSelected && (
            <span className="rounded-full bg-[var(--lj-gold-strong)]/95 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white backdrop-blur-sm">
              No mapa
            </span>
          )}
        </div>
      </div>

      <div className="p-7">
        <p className="text-[10px] font-medium uppercase tracking-[0.32em] text-[var(--lj-gold-strong)]">
          {store.city} · {store.uf}
        </p>
        <h3 className="lojas-serif mt-2.5 text-[1.7rem] font-medium leading-snug">
          Lurds {store.unit}
        </h3>
        <p className="mt-3 text-sm font-light leading-relaxed text-[var(--lj-ink-soft)]">
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
              onClick={(e) => e.stopPropagation()}
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
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--lj-ink)] px-3 py-3 text-xs font-medium text-white transition-all duration-300 hover:-translate-y-0.5 hover:bg-[var(--lj-gold-strong)] sm:py-2.5"
          >
            <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} /> Como chegar
          </a>
          <a
            href={whatsappUrl(store)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2E7D46] px-3 py-3 text-xs font-medium text-white transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#256538] sm:py-2.5"
          >
            <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.75} /> WhatsApp
          </a>
          <a
            href={instagramUrl(store)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--lj-gold)] px-3 py-3 text-xs font-medium text-[var(--lj-gold-strong)] transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#FBF6E6] sm:py-2.5"
          >
            <Instagram className="h-3.5 w-3.5" strokeWidth={1.75} /> Instagram
          </a>
        </div>
      </div>
    </motion.article>
  );
}
