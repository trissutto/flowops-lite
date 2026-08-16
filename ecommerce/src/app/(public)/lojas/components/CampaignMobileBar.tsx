'use client';

import { MapPin, ShoppingBag } from 'lucide-react';
import { AppLink } from '@/components/ui/AppLink';
import { trackStoreLocator, trackStoresOnlineCta } from '@/lib/tracking';
import { isMetaCampaign, withCampaignParams } from '@/lib/campaign-links';
import { directionsUrl, type Store } from '../lib';

export default function CampaignMobileBar({
  campaignParams,
  selectedStore,
}: {
  campaignParams: URLSearchParams;
  selectedStore: Store | null;
}) {
  if (!isMetaCampaign(campaignParams)) return null;

  const onlineHref = withCampaignParams('/novidades', campaignParams);

  return (
    <aside
      aria-label="Opções da campanha"
      className="fixed inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 rounded-2xl border border-black/10 bg-white/95 p-3 shadow-2xl shadow-black/20 backdrop-blur-md lg:hidden"
    >
      {selectedStore ? (
        <div className="space-y-2">
          <p className="truncate px-1 text-xs font-medium text-[var(--lj-ink)]">
            Lurds {selectedStore.unit} selecionada
          </p>
          <div className="grid grid-cols-2 gap-2">
            <a
              href={directionsUrl(selectedStore)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackStoreLocator(selectedStore.city, selectedStore.unit, 'selected_store_bar')}
              className="inline-flex items-center justify-center gap-1 rounded-full border border-[var(--lj-line)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide"
            >
              <MapPin className="h-3.5 w-3.5" /> Como chegar
            </a>
            <AppLink
              href={onlineHref}
              onClick={() => trackStoresOnlineCta('selected_store_bar', selectedStore.unit)}
              className="inline-flex items-center justify-center gap-1 rounded-full bg-[var(--lj-ink)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-white"
            >
              <ShoppingBag className="h-3.5 w-3.5" /> Comprar online
            </AppLink>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <p className="flex-1 px-1 text-sm font-medium text-[var(--lj-ink)]">Compre também pelo site</p>
          <AppLink
            href={onlineHref}
            onClick={() => trackStoresOnlineCta('campaign_bar')}
            className="rounded-full bg-[var(--lj-ink)] px-5 py-3 text-xs font-semibold uppercase tracking-wider text-white"
          >
            Ver novidades
          </AppLink>
        </div>
      )}
    </aside>
  );
}
