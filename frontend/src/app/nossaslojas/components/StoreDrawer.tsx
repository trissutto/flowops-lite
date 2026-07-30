'use client';

import { useEffect, useRef } from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { X, MapPin, MessageCircle, Instagram, Clock, Phone } from 'lucide-react';
import {
  fullAddress,
  whatsappUrl,
  instagramUrl,
  directionsUrl,
  mapEmbedUrl,
  galleryFor,
  imgSrc,
  BLUR_DATA_URL,
  type Store,
} from '../lib';

interface Props {
  store: Store | null;
  onClose: () => void;
}

/**
 * Drawer-galeria da unidade — desliza da direita (~40% da tela no desktop,
 * tela cheia no mobile). Fecha com Esc, clique no backdrop ou no X.
 *
 * NÃO usa AnimatePresence: o unmount pós-exit não dispara com o React
 * embutido do Next 14.1 (elemento ficava órfão no DOM). O drawer fica
 * sempre montado após a 1ª abertura e anima por estado; `visibility`
 * entra no fim da transição pra sumir da árvore de acessibilidade/tab.
 */
export default function StoreDrawer({ store, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  // Mantém a última loja renderizada durante o slide-out (conteúdo não some no meio).
  const lastStoreRef = useRef<Store | null>(null);
  if (store) lastStoreRef.current = store;
  const shown = store ?? lastStoreRef.current;
  const open = !!store;

  // Drawer fechado fica fora da ordem de tab e da árvore de acessibilidade.
  useEffect(() => {
    if (asideRef.current) asideRef.current.inert = !open;
  }, [open]);

  useEffect(() => {
    if (!store) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [store, onClose]);

  if (!shown) return null;
  const s = shown;

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: open ? 1 : 0 }}
        transition={{ duration: 0.3 }}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        aria-hidden
      />
      <motion.aside
        ref={asideRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Loja Lurds ${s.unit}`}
        aria-hidden={!open}
        initial={{ x: '100%' }}
        animate={{ x: open ? '0%' : '100%' }}
        transition={{ type: 'tween', duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-[var(--lj-ivory)] shadow-2xl sm:w-[min(560px,92vw)] lg:w-[42vw]"
        style={{ pointerEvents: open ? 'auto' : 'none' }}
      >
        {/* Capa */}
        <div className="relative h-56 shrink-0 sm:h-64">
          {s.image ? (
            <Image
              src={imgSrc(s.image, 1200)}
              alt={`Editorial da Lurds ${s.unit}`}
              fill
              sizes="(max-width: 640px) 100vw, 42vw"
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className="object-cover"
            />
          ) : (
            <div className="h-full w-full bg-[var(--lj-champagne)]" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent" />
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Fechar"
            className="absolute right-4 top-4 rounded-full bg-white/90 p-2.5 text-[var(--lj-ink)] shadow-lg transition-colors hover:bg-white"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
          <div className="absolute bottom-5 left-6 right-6 text-white">
            <p className="text-[10px] font-medium uppercase tracking-[0.32em] text-[var(--lj-gold-soft)]">
              {s.city} · {s.uf}
            </p>
            <h2 className="lojas-serif mt-1 text-3xl font-medium">Lurds {s.unit}</h2>
          </div>
        </div>

        {/* Conteúdo rolável */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-7 sm:px-8">
          <p className="text-sm font-light leading-relaxed text-[var(--lj-ink-soft)]">
            {s.description}
          </p>

          <ul className="mt-6 space-y-3 text-[13px] leading-snug text-[var(--lj-ink-soft)]">
            <li className="flex gap-2.5">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} />
              <span>{fullAddress(s)}</span>
            </li>
            <li className="flex gap-2.5">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} />
              <span>{s.hours.display.join(' · ')}</span>
            </li>
            <li className="flex gap-2.5">
              <Phone className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} />
              <a href={`tel:+55${s.whatsapp.slice(2)}`} className="hover:underline">
                {s.phone}
              </a>
            </li>
            <li className="flex gap-2.5">
              <Instagram className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} />
              <a
                href={instagramUrl(s)}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                @{s.instagram}
              </a>
            </li>
          </ul>

          {/* Galeria */}
          <h3 className="mt-9 text-[11px] font-medium uppercase tracking-[0.3em] text-[var(--lj-gold-strong)]">
            Um pedacinho da loja
          </h3>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {galleryFor(s).map((photo, i) => (
              <figure
                key={`${photo.src}-${i}`}
                className={`group relative overflow-hidden rounded-2xl ${i === 0 ? 'col-span-2 aspect-[16/9]' : 'aspect-square'}`}
              >
                <Image
                  src={imgSrc(photo.src, i === 0 ? 1100 : 640)}
                  alt={`${photo.label} — Lurds ${s.unit}`}
                  fill
                  sizes="(max-width: 640px) 50vw, 21vw"
                  placeholder="blur"
                  blurDataURL={BLUR_DATA_URL}
                  className="object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]"
                />
                <figcaption className="absolute bottom-2 left-3 text-[10px] font-medium uppercase tracking-[0.18em] text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)]">
                  {photo.label}
                </figcaption>
              </figure>
            ))}
          </div>

          {/* Mapa da unidade */}
          <h3 className="mt-9 text-[11px] font-medium uppercase tracking-[0.3em] text-[var(--lj-gold-strong)]">
            Onde estamos
          </h3>
          <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--lj-line)]">
            <iframe
              src={mapEmbedUrl(s)}
              title={`Mapa — Lurds Plus Size ${s.unit}`}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className="h-52 w-full border-0"
            />
          </div>
        </div>

        {/* CTAs fixos no rodapé do drawer */}
        <div className="shrink-0 border-t border-[var(--lj-line)] bg-white/95 px-6 py-4 backdrop-blur sm:px-8">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <a
              href={directionsUrl(s)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--lj-ink)] px-3 py-3 text-xs font-medium text-white transition-colors hover:bg-[var(--lj-gold-strong)]"
            >
              <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} /> Como chegar
            </a>
            <a
              href={whatsappUrl(s)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2E7D46] px-3 py-3 text-xs font-medium text-white transition-colors hover:bg-[#256538]"
            >
              <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.75} /> Falar no WhatsApp
            </a>
            <a
              href={instagramUrl(s)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--lj-gold)] px-3 py-3 text-xs font-medium text-[var(--lj-gold-strong)] transition-colors hover:bg-[#FBF6E6]"
            >
              <Instagram className="h-3.5 w-3.5" strokeWidth={1.75} /> Ver Instagram
            </a>
          </div>
        </div>
      </motion.aside>
    </>
  );
}
