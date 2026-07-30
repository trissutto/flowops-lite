'use client';

import { motion } from 'framer-motion';
import { stores, type Store } from '../lib';
import StoreCard from './StoreCard';
import MapPanel from './MapPanel';

interface Props {
  selected: Store;
  nearestSlug: string | null;
  onSelect: (slug: string, scroll?: boolean) => void;
  onOpen: (slug: string) => void;
}

export default function StoresSection({ selected, nearestSlug, onSelect, onOpen }: Props) {
  return (
    <section id="lojas" className="scroll-mt-8 px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7 }}
          className="text-center"
        >
          <p className="text-[11px] font-medium uppercase tracking-[0.35em] text-[var(--lj-gold-strong)]">
            Nossas lojas
          </p>
          <h2 className="lojas-serif mt-4 text-3xl font-medium sm:text-4xl">
            {stores.length} endereços, o mesmo acolhimento
          </h2>
          <div className="lojas-rule mx-auto mt-5 w-24" />
        </motion.div>

        <div className="mt-16 grid gap-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
          {/* Cards — selecionar um card sincroniza o mapa ao lado */}
          <div className="order-2 grid gap-6 sm:grid-cols-2 lg:order-1">
            {stores.map((s, i) => (
              <StoreCard
                key={s.slug}
                store={s}
                index={i}
                isSelected={s.slug === selected.slug}
                isNearest={s.slug === nearestSlug}
                onSelect={() => onSelect(s.slug, false)}
                onOpen={() => onOpen(s.slug)}
              />
            ))}
          </div>

          {/* Mapa sincronizado — sticky no desktop, acima dos cards no mobile */}
          <div className="order-1 lg:order-2 lg:sticky lg:top-6">
            <MapPanel store={selected} />
          </div>
        </div>
      </div>
    </section>
  );
}
