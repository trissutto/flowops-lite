'use client';

import { MessageCircle, Navigation, Phone } from 'lucide-react';
import { trackPhoneClick, trackStoreLocator, trackWhatsAppClick } from '@/lib/tracking';
import { directionsUrl, whatsappUrl, type Store } from '../lib';

/**
 * Os três botões da página de loja — e a ÚNICA parte dela que é client.
 *
 * O resto da página é server puro de propósito: o relatório de Core Web Vitals
 * de 21/08/2026 aponta INP acima de 200ms em 498 das 597 URLs no celular, e
 * quem chega aqui vem de "loja plus size em Santos" com o dedo já no botão.
 * Menos JS na rota = menos fila na thread na hora do toque.
 *
 * Mas o clique no WhatsApp é LEAD: some do funil se o link for um <a> pelado.
 * Por isso os CTAs — e só eles — carregam o rastreio, com o mesmo vocabulário
 * de evento do drawer da listagem (`store_page`, em vez de `store_drawer`,
 * pra dar pra separar quem veio da landing da cidade).
 */
export default function StoreCtas({ store }: { store: Store }) {
  return (
    <div className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
      <a
        href={whatsappUrl(store)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => trackWhatsAppClick('store_page', store.unit)}
        className="inline-flex items-center justify-center gap-2 rounded-full bg-[#2E7D46] px-5 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-white transition hover:brightness-110"
      >
        <MessageCircle className="h-4 w-4" strokeWidth={1.75} aria-hidden /> Falar no WhatsApp
      </a>
      <a
        href={directionsUrl(store)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => trackStoreLocator(store.city, store.unit, 'store_page')}
        className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--lj-ink)] px-5 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--lj-ink)] transition hover:bg-[var(--lj-ink)] hover:text-white"
      >
        <Navigation className="h-4 w-4" strokeWidth={1.75} aria-hidden /> Como chegar
      </a>
      <a
        href={`tel:+55${store.whatsapp.slice(2)}`}
        onClick={() => trackPhoneClick(store.unit, 'store_page')}
        className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--lj-line)] bg-white px-5 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--lj-ink)] transition hover:border-[var(--lj-ink)]"
      >
        <Phone className="h-4 w-4" strokeWidth={1.75} aria-hidden /> {store.phone}
      </a>
    </div>
  );
}
