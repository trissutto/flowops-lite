'use client';

import { MessageCircle, Navigation } from 'lucide-react';
import { trackStoreLocator, trackWhatsAppClick } from '@/lib/tracking';
import { directionsUrl, whatsappUrlPeca, type Store } from '../../lib';

/**
 * Os dois botões da página da peça na loja — e a única parte dela que é client.
 *
 * Mesma escolha da página da loja: o resto é server puro porque quem chega
 * aqui vem de "vestido plus size perto de mim" com pressa, e o relatório de
 * Core Web Vitals de 21/08/2026 aponta INP acima de 200ms em 498 das 597 URLs
 * no celular. Só o que precisa de rastreio vira JavaScript.
 *
 * E aqui o WhatsApp é O objetivo da página: não é "fale conosco", é "pergunta
 * se tem o teu tamanho". Sem o evento, esse lead some do funil — foi o buraco
 * que a `/lojas` tinha antes de 13/08 (a página inteira era muda).
 */
export default function PecaNaLojaCtas({
  store,
  peca,
  tamanho,
}: {
  store: Store;
  peca: { nome: string; ref: string };
  /** Preenchido quando a cliente chegou por um tamanho que a loja não tem hoje. */
  tamanho?: string | null;
}) {
  return (
    <div className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      <a
        href={whatsappUrlPeca(store, peca, tamanho)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => trackWhatsAppClick('store_product', store.unit)}
        className="inline-flex items-center justify-center gap-2 rounded-full bg-[#2E7D46] px-5 py-3.5 text-[12px] font-semibold uppercase tracking-[0.14em] text-white transition hover:brightness-110"
      >
        <MessageCircle className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        {tamanho ? `Pedir o ${tamanho} nesta loja` : 'Perguntar no WhatsApp'}
      </a>
      <a
        href={directionsUrl(store)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => trackStoreLocator(store.city, store.unit, 'store_product')}
        className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--lj-ink)] px-5 py-3.5 text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--lj-ink)] transition hover:bg-[var(--lj-ink)] hover:text-white"
      >
        <Navigation className="h-4 w-4" strokeWidth={1.75} aria-hidden /> Como chegar
      </a>
    </div>
  );
}
