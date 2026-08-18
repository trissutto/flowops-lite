'use client';

import Image from 'next/image';
import { CreditCard, MapPin, PackageCheck, RefreshCw, WalletCards } from 'lucide-react';
import { AppLink } from '@/components/ui/AppLink';
import { trackStoreLocator, trackViewCollection } from '@/lib/tracking';
import { cn } from '@/lib/utils';

export interface HomeCategory {
  name: string;
  /**
   * Vazio = atalho novo cadastrado na retaguarda sem arte e sem foto de
   * categoria. O card sai com o nome sobre o champagne da marca em vez de
   * sumir: quem cadastrou tem que VER o que cadastrou (sumir em silêncio é o
   * que faz a pessoa mexer de novo achando que não salvou). Nunca foto de
   * banco de imagem no lugar.
   */
  image: string;
  href: string;
  alt: string;
}

export function HomeCategoryNav({ categories }: { categories: HomeCategory[] }) {
  return (
    <nav aria-labelledby="home-categories-title" className="bg-surface py-7 sm:py-10">
      <div className="mx-auto max-w-[90rem] px-4 sm:px-6 lg:px-10">
        <div className="flex items-center gap-4">
          <span className="h-px flex-1 bg-primary/35" />
          <h2 id="home-categories-title" className="text-center text-xs font-medium tracking-[0.2em] text-ink uppercase sm:text-sm">
            Compre por categoria
          </h2>
          <span className="h-px flex-1 bg-primary/35" />
        </div>

        <ul className="mt-6 flex gap-4 overflow-x-scroll pb-3 sm:mx-auto sm:flex sm:max-w-6xl sm:justify-center sm:overflow-x-auto sm:pb-3">
          {categories.map((category) => (
            <li key={category.name} className="w-[18%] shrink-0 sm:w-28">
              <AppLink
                href={category.href}
                onClick={() => trackViewCollection(`Home — ${category.name}`)}
                className="group flex min-h-11 flex-col items-center gap-2 text-center focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
              >
                <span className="relative aspect-square w-full overflow-hidden rounded-full border border-primary/20 bg-champagne shadow-[0_5px_18px_rgba(49,40,30,0.08)]">
                  {category.image ? (
                    <Image
                      src={category.image}
                      alt={category.alt}
                      fill
                      sizes="(max-width: 640px) 18vw, 150px"
                      className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                    />
                  ) : (
                    <span className="absolute inset-0 grid place-items-center px-1 text-center font-serif text-[0.6rem] leading-tight text-primary sm:text-sm">
                      {category.name}
                    </span>
                  )}
                </span>
                <span className="text-[0.62rem] font-medium tracking-[0.08em] text-ink uppercase sm:text-xs">
                  {category.name}
                </span>
              </AppLink>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

export function HomeSizeNav({ sizes }: { sizes: Array<{ size: string; href: string }> }) {
  return (
    <nav aria-labelledby="home-sizes-title" className="bg-champagne/45 py-8 sm:py-12">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <div className="text-center">
          <p className="eyebrow text-primary-strong">Encontre seu tamanho</p>
          <h2 id="home-sizes-title" className="mt-2 font-display text-h3 text-ink">Compre do 46 ao 60</h2>
        </div>
        <ul className="mt-6 grid grid-cols-4 gap-2 sm:grid-cols-8 sm:gap-3">
          {sizes.map(({ size, href }) => (
            <li key={size}>
              <AppLink
                href={href}
                className="flex min-h-12 items-center justify-center rounded-md border border-primary/25 bg-surface text-sm font-medium text-ink transition-colors hover:border-primary hover:bg-primary hover:text-light"
              >
                {size}
              </AppLink>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

const BENEFITS = [
  { icon: WalletCards, first: '5%', second: 'no Pix' },
  { icon: CreditCard, first: 'Até 12x', second: 'sem juros' },
  { icon: RefreshCw, first: 'Troca', second: 'fácil' },
  { icon: PackageCheck, first: 'Entrega', second: 'nacional' },
];

export function HomeBenefitsAndStores({ storesHref }: { storesHref: string }) {
  return (
    <div className="bg-surface px-4 pb-8 sm:px-6 sm:pb-12">
      <div className="mx-auto max-w-[90rem] border-t border-border pt-6">
        <ul className="grid grid-cols-4 divide-x divide-border" aria-label="Benefícios da compra">
          {BENEFITS.map(({ icon: Icon, first, second }) => (
            <li key={first} className="flex flex-col items-center gap-2 px-1 text-center sm:flex-row sm:justify-center sm:gap-3">
              <Icon className="size-5 shrink-0 text-primary sm:size-6" strokeWidth={1.4} aria-hidden />
              <span className="text-[0.64rem] leading-tight text-ink sm:text-sm">
                <strong className="block font-medium">{first}</strong>
                <span>{second}</span>
              </span>
            </li>
          ))}
        </ul>

        <HomeStoreCta storesHref={storesHref} className="mt-6 hidden sm:flex" />
      </div>
    </div>
  );
}

export function HomeStoreCta({ storesHref, className }: { storesHref: string; className?: string }) {
  return (
    <div className={cn('items-center gap-4 rounded-lg bg-champagne px-5 py-5 sm:mx-auto sm:max-w-3xl sm:px-7', className)}>
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full border border-primary/35 text-primary">
        <MapPin className="size-5" strokeWidth={1.5} aria-hidden />
      </span>
      <p className="min-w-0 flex-1 text-sm leading-snug text-ink">
        <strong className="block font-medium">Prefere provar?</strong>
        <span className="text-ink-soft">Encontre uma loja perto de você</span>
      </p>
      <AppLink
        href={storesHref}
        onClick={() => trackStoreLocator(undefined, undefined, 'home_first_journey')}
        className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-sm border border-ink px-4 text-[0.65rem] font-medium tracking-[0.1em] text-ink uppercase transition-colors hover:bg-ink hover:text-light sm:px-7 sm:text-xs"
      >
        Ver lojas
      </AppLink>
    </div>
  );
}
