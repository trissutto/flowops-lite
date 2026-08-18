'use client';

import { useCallback, useMemo, useState } from 'react';
import { stores, nearestStore, type Store } from './lib';
import Hero from './components/Hero';
import Manifesto from './components/Manifesto';
import SearchLocate from './components/SearchLocate';
import StoresSection from './components/StoresSection';
import StoreDrawer from './components/StoreDrawer';
import InstagramCta from './components/InstagramCta';
import FinalCta from './components/FinalCta';
import OnlineShoppingSection from './components/OnlineShoppingSection';
import CampaignMobileBar from './components/CampaignMobileBar';
import { trackStoresOnlineCta } from '@/lib/tracking';
import { withCampaignParams } from '@/lib/campaign-links';
import type { Product } from '@/types';

export type GeoState = 'idle' | 'loading' | 'ok' | 'error';

export default function NossasLojasClient({
  heroImagem,
  products,
  campaignQuery,
}: {
  heroImagem?: string | null;
  products: Product[];
  campaignQuery: string;
}) {
  const [selectedSlug, setSelectedSlug] = useState<string>(stores[0].slug);
  const [drawerSlug, setDrawerSlug] = useState<string | null>(null);
  const [nearest, setNearest] = useState<{ store: Store; km: number } | null>(null);
  const [geoState, setGeoState] = useState<GeoState>('idle');
  const [hasSelectedStore, setHasSelectedStore] = useState(false);
  const campaignParams = useMemo(() => new URLSearchParams(campaignQuery), [campaignQuery]);
  const onlineHref = useMemo(() => withCampaignParams('/novidades', campaignParams), [campaignParams]);

  const selected = useMemo(
    () => stores.find((s) => s.slug === selectedSlug) ?? stores[0],
    [selectedSlug],
  );
  const drawerStore = useMemo(
    () => stores.find((s) => s.slug === drawerSlug) ?? null,
    [drawerSlug],
  );

  const scrollToId = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const selectStore = useCallback((slug: string, scroll = true) => {
    setSelectedSlug(slug);
    setHasSelectedStore(true);
    if (scroll) {
      // Centraliza o card selecionado — o mapa (sincronizado) troca sozinho.
      document
        .getElementById(`loja-${slug}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  const locate = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGeoState('error');
      return;
    }
    setGeoState('loading');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const found = nearestStore(pos.coords.latitude, pos.coords.longitude);
        setNearest(found);
        setSelectedSlug(found.store.slug);
        setHasSelectedStore(true);
        setGeoState('ok');
        document.getElementById('buscar')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
      () => setGeoState('error'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  }, []);

  return (
    <main>
      <Hero
        onFindStore={() => scrollToId('buscar')}
        onlineHref={onlineHref}
        onOnlineClick={() => trackStoresOnlineCta('hero', hasSelectedStore ? selected.unit : undefined)}
        imagem={heroImagem}
      />
      <SearchLocate
        geoState={geoState}
        nearest={nearest}
        onLocate={locate}
        onPick={(slug) => selectStore(slug)}
      />
      <StoresSection
        selected={selected}
        nearestSlug={nearest?.store.slug ?? null}
        onSelect={selectStore}
        onOpen={(slug) => setDrawerSlug(slug)}
      />
      <StoreDrawer store={drawerStore} onClose={() => setDrawerSlug(null)} />
      <OnlineShoppingSection
        products={products}
        campaignParams={campaignParams}
        storeUnit={hasSelectedStore ? selected.unit : undefined}
      />
      <Manifesto />
      <InstagramCta store={selected} />
      <FinalCta store={nearest?.store ?? selected} />
      <CampaignMobileBar
        campaignParams={campaignParams}
        selectedStore={hasSelectedStore ? selected : null}
      />
      <footer className="border-t border-[var(--lj-line)] bg-[var(--lj-cream)] px-6 py-7 text-center">
        <p className="lojas-serif text-lg tracking-wide">Lurd&apos;s Plus Size</p>
        <p className="mt-3 text-xs uppercase tracking-[0.2em] text-[var(--lj-ink-soft)]">
          Moda plus size elegante · {stores.length} lojas em São Paulo e região ·{' '}
          <a href="https://www.lurds.com.br" className="underline decoration-[var(--lj-gold)] underline-offset-4">
            lurds.com.br
          </a>
        </p>
      </footer>
    </main>
  );
}
