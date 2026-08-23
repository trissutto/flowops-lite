'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { MapPin, MessageCircle, ArrowRight } from 'lucide-react';
import { trackStoreLocator, trackWhatsAppClick } from '@/lib/tracking';
import {
  whatsappUrl,
  directionsUrl,
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
      className={`group scroll-mt-24 cursor-pointer overflow-hidden rounded-2xl border bg-white transition-all duration-300 ease-out hover:-translate-y-1 ${
        isSelected
          ? 'border-[var(--lj-gold)] shadow-[0_24px_60px_-30px_rgba(140,115,37,0.45)]'
          : 'border-[var(--lj-line)] shadow-[0_10px_40px_-30px_rgba(33,28,24,0.35)] hover:border-[var(--lj-gold)]/50 hover:shadow-[0_32px_70px_-30px_rgba(140,115,37,0.5)]'
      }`}
    >
      <div className="p-5">
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
        <h3 className="lojas-serif mt-2 text-2xl font-semibold uppercase leading-tight tracking-[0.05em] text-[var(--lj-ink)]">
          {store.unit}
        </h3>
        <div className="mt-3 h-[2px] w-10 bg-[var(--lj-gold)] transition-all duration-500 group-hover:w-16" />

        <p className="mt-3 flex gap-2 text-[13px] leading-snug text-[var(--lj-ink-soft)]">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} />
          <span>{store.address.neighborhood} · {store.address.street}</span>
        </p>

        {/**
         * LINK DE VERDADE, não texto — e isso é metade do motivo de a página
         * por cidade existir.
         *
         * O clique no card abre o drawer, que é ótimo pra quem já está aqui e
         * péssimo pro Google: o drawer só entra no DOM depois da primeira
         * abertura, então sem este `<a>` as 14 landings de cidade nasceriam
         * alcançáveis só pelo sitemap, sem um link interno no site inteiro.
         *
         * `stopPropagation` porque o card inteiro é um botão: sem ele o clique
         * navegaria E abriria o drawer no mesmo gesto.
         *
         * `<Link>` e não `<a>`: `@next/next/no-html-link-for-pages` é ERRO no
         * build da Vercel (não warning), e derruba o deploy inteiro.
         */}
        <Link
          href={`/lojas/${store.slug}`}
          onClick={(e) => e.stopPropagation()}
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[var(--lj-gold-strong)] hover:underline"
        >
          Ver a página da loja <ArrowRight className="h-3.5 w-3.5" />
        </Link>

        <div className="mt-4 grid grid-cols-2 gap-2">
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
        </div>
      </div>
    </motion.article>
  );
}
