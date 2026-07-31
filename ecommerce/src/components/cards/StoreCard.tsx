'use client';

import { motion } from 'framer-motion';
import { Clock, MapPin, MessageCircle } from 'lucide-react';
import { InstagramIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { fadeUp, reveal } from '@/lib/motion';
import { Button } from '@/components/ui/Button';
import type { Store } from '@/types';

/**
 * STORE CARD — unidade física.
 *
 * Decisão de design (validada com o dono na landing atual): a CIDADE é a
 * protagonista, em caixa alta e Playfair grande. Sem foto de modelo — o que a
 * cliente busca aqui é endereço e contato, e a foto competia com a informação.
 */

interface StoreCardProps {
  store: Store;
  index?: number;
  /** Destaca a unidade mais próxima quando a geolocalização foi permitida. */
  nearest?: boolean;
  /** Distância aproximada já formatada ("4,2 km"). */
  distance?: string;
  className?: string;
}

function fullAddress(store: Store): string {
  const zip = store.address.zip ? ` · CEP ${store.address.zip}` : '';
  return `${store.address.street} – ${store.address.neighborhood}, ${store.address.city}/${store.address.uf}${zip}`;
}

export function StoreCard({ store, index = 0, nearest, distance, className }: StoreCardProps) {
  const whatsapp = `https://api.whatsapp.com/send?phone=${store.whatsapp}&text=${encodeURIComponent('Olá! Quero conhecer a loja (vim pelo site).')}`;
  const instagram = `https://www.instagram.com/${store.instagram}/`;
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(store.mapsQuery)}`;

  return (
    <motion.article
      {...reveal(fadeUp, '-40px')}
      transition={{ duration: 0.56, delay: (index % 3) * 0.07 }}
      className={cn(
        'group flex flex-col rounded-lg border bg-surface p-7 transition-all duration-[560ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-1.5 hover:shadow-gold',
        nearest ? 'border-primary shadow-gold' : 'border-border shadow-sm hover:border-primary/50',
        className,
      )}
    >
      {nearest && (
        <span className="eyebrow mb-4 self-start rounded-pill bg-ink px-3 py-1 text-primary-soft">
          {distance ? `Mais perto · ${distance}` : 'Mais perto de você'}
        </span>
      )}

      <p className="eyebrow text-ink-muted">
        Lurds · {store.city}/{store.uf}
      </p>
      <h3 className="mt-2.5 font-display text-[1.75rem] leading-tight font-semibold tracking-[0.05em] text-ink uppercase sm:text-[2rem]">
        {store.unit}
      </h3>
      <div className="mt-4 h-0.5 w-12 bg-primary transition-all duration-[560ms] group-hover:w-20" />

      <p className="mt-5 text-body font-light text-ink-soft">{store.description}</p>

      <ul className="mt-6 flex flex-1 flex-col gap-3 text-small text-ink-soft">
        <li className="flex gap-2.5">
          <MapPin className="mt-0.5 size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
          <span>{fullAddress(store)}</span>
        </li>
        <li className="flex gap-2.5">
          <Clock className="mt-0.5 size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
          <span>{store.hours.display.join(' · ')}</span>
        </li>
        <li className="flex gap-2.5">
          <InstagramIcon className="mt-0.5 size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
          <a href={instagram} target="_blank" rel="noopener noreferrer" className="hover:underline">
            @{store.instagram}
          </a>
        </li>
      </ul>

      <div className="mt-7 grid gap-2 sm:grid-cols-3">
        <Button href={directions} external size="sm">
          <MapPin /> Como chegar
        </Button>
        <Button href={whatsapp} external variant="whatsapp" size="sm">
          <MessageCircle /> WhatsApp
        </Button>
        <Button href={instagram} external variant="secondary" size="sm">
          <InstagramIcon /> Instagram
        </Button>
      </div>
    </motion.article>
  );
}
