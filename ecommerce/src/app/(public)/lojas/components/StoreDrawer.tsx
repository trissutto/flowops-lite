'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { X, MapPin, MessageCircle, Clock, Phone, Navigation } from 'lucide-react';
import { InstagramIcon as Instagram } from '@/components/ui/icons';
import { trackInstagramClick, trackPhoneClick, trackStoreLocator, trackWhatsAppClick } from '@/lib/tracking';
import {
  fullAddress,
  whatsappUrl,
  instagramUrl,
  directionsUrl,
  mapEmbedUrl,
  badgesFor,
  ownGalleryFor,
  isStockPhoto,
  openStatus,
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
 *
 * CAPA: sem foto de banco de imagem como protagonista. As 14 lojas apontam
 * pro mesmo punhado de fotos genéricas de Unsplash (modelo cortada no torso,
 * repetida entre unidades) — isso não mostra a loja e ainda promete uma coisa
 * que a cliente não vai encontrar. Enquanto não houver foto própria, a capa é
 * editorial (monograma + tipografia da marca) e a foto stock fica só como
 * textura. Foto real no lojas.json volta a virar capa sozinha (`isStockPhoto`).
 */
export default function StoreDrawer({ store, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  // Mantém a última loja renderizada durante o slide-out (conteúdo não some no meio).
  const lastStoreRef = useRef<Store | null>(null);
  if (store) lastStoreRef.current = store;
  const shown = store ?? lastStoreRef.current;
  const open = !!store;

  // "Aberto agora" só depois do mount — no SSR o relógio do servidor
  // divergiria do da cliente e daria hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const status = useMemo(
    () => (mounted && shown ? openStatus(shown) : null),
    // A abertura do drawer serve de gatilho pra reavaliar o horário.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mounted, shown, open],
  );

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
  const hasRealCover = !!s.image && !isStockPhoto(s.image);
  const gallery = ownGalleryFor(s);

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
        {/* Capa editorial — tipografia é a protagonista, foto é textura */}
        <header className="lojas-grain relative shrink-0 overflow-hidden bg-[var(--lj-ink)] px-6 pb-7 pt-8 sm:px-8">
          {hasRealCover && (
            <Image
              src={imgSrc(s.image as string, 1200)}
              alt=""
              fill
              sizes="(max-width: 640px) 100vw, 42vw"
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className="object-cover opacity-30"
              aria-hidden
            />
          )}
          {/* Halo dourado no canto — dá profundidade sem depender de imagem */}
          <div
            className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full opacity-40 blur-3xl"
            style={{ background: 'radial-gradient(circle, var(--lj-gold) 0%, transparent 70%)' }}
            aria-hidden
          />

          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Fechar"
            className="absolute right-4 top-4 z-10 rounded-full border border-white/20 bg-white/10 p-2.5 text-white backdrop-blur-sm transition-colors hover:bg-white/25"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>

          <div className="relative flex items-start gap-4 pr-12">
            {/* Monograma da casa */}
            <span className="lojas-serif mt-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--lj-gold)]/60 text-xl font-semibold italic text-[var(--lj-gold-soft)]">
              L
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-[0.32em] text-[var(--lj-gold-soft)]">
                {s.city} · {s.uf}
              </p>
              <h2 className="lojas-serif mt-1.5 text-[1.75rem] font-semibold uppercase leading-[1.1] tracking-[0.04em] text-white sm:text-[2.1rem]">
                {s.unit}
              </h2>
            </div>
          </div>

          <div className="lojas-rule relative mt-5 opacity-70" />

          {/* Aberto agora — a informação que a cliente mais procura antes de sair de casa */}
          <div className="relative mt-4 flex flex-wrap items-center gap-2">
            {status && (
              <span
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] ${
                  status.open ? 'bg-[#2E7D46] text-white' : 'bg-white/10 text-white/80'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${status.open ? 'bg-white' : 'bg-white/60'}`}
                  aria-hidden
                />
                {status.open ? 'Aberta agora' : 'Fechada agora'}
              </span>
            )}
            {status && (
              <span className="text-[11px] font-light uppercase tracking-[0.14em] text-white/70">
                {status.label}
              </span>
            )}
          </div>
        </header>

        {/* Conteúdo rolável */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-7 sm:px-8">
          <p className="lojas-serif text-[15px] font-light italic leading-relaxed text-[var(--lj-ink-soft)]">
            {s.description}
          </p>

          {/* Diferenciais da unidade — mesmo vocabulário do card da listagem */}
          <ul className="mt-5 flex flex-wrap gap-1.5" aria-label="Diferenciais da loja">
            {badgesFor(s).map((b) => (
              <li
                key={b}
                className="rounded-full border border-[var(--lj-gold)]/30 bg-white px-3 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--lj-gold-strong)]"
              >
                {b}
              </li>
            ))}
          </ul>

          {/* Dados da loja em blocos — respiram melhor que a lista corrida */}
          <dl className="mt-7 space-y-2.5">
            <InfoRow icon={<MapPin className="h-4 w-4" strokeWidth={1.75} />} term="Endereço">
              {fullAddress(s)}
            </InfoRow>
            <InfoRow icon={<Clock className="h-4 w-4" strokeWidth={1.75} />} term="Horários">
              {s.hours.display.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </InfoRow>
            <InfoRow icon={<Phone className="h-4 w-4" strokeWidth={1.75} />} term="Telefone">
              <a
                href={`tel:+55${s.whatsapp.slice(2)}`}
                className="hover:underline"
                onClick={() => trackPhoneClick(s.unit, 'store_drawer')}
              >
                {s.phone}
              </a>
            </InfoRow>
            <InfoRow icon={<Instagram className="h-4 w-4" strokeWidth={1.75} />} term="Instagram">
              <a
                href={instagramUrl(s)}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
                onClick={() => trackInstagramClick('store_drawer_arroba', s.unit)}
              >
                @{s.instagram}
              </a>
            </InfoRow>
          </dl>

          {/* Galeria — SÓ com foto própria da unidade. Sem foto real a seção
              some inteira: banco de imagem repetido nas 14 lojas engana. */}
          {gallery.length > 0 && (
            <>
              <SectionTitle>Um pedacinho da loja</SectionTitle>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {gallery.map((photo, i) => (
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
            </>
          )}

          {/* Mapa da unidade — com a galeria fake fora, é ele que mostra a loja */}
          <SectionTitle>Onde estamos</SectionTitle>
          <div className="relative mt-4 overflow-hidden rounded-2xl border border-[var(--lj-line)] shadow-[0_10px_40px_-30px_rgba(33,28,24,0.5)]">
            <iframe
              src={mapEmbedUrl(s)}
              title={`Mapa — Lurds Plus Size ${s.unit}`}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className="h-64 w-full border-0"
            />
            {/* Selo da unidade sobre o mapa */}
            <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-full bg-[var(--lj-ink)]/90 py-1 pl-1 pr-3 shadow-lg backdrop-blur-sm">
              <span className="lojas-serif flex h-6 w-6 items-center justify-center rounded-full bg-[var(--lj-gold-soft)] text-xs font-semibold italic text-[var(--lj-ink)]">
                L
              </span>
              <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-white">
                Lurds {s.unit}
              </span>
            </div>
          </div>

          <a
            href={directionsUrl(s)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackStoreLocator(s.city, s.unit, 'store_drawer_map')}
            className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--lj-gold-strong)] hover:underline"
          >
            <Navigation className="h-3.5 w-3.5" strokeWidth={1.75} /> Traçar rota no Google Maps
          </a>
        </div>

        {/* CTAs fixos no rodapé do drawer */}
        <div className="shrink-0 border-t border-[var(--lj-line)] bg-white/95 px-6 py-4 backdrop-blur sm:px-8">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <a
              href={directionsUrl(s)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackStoreLocator(s.city, s.unit, 'store_drawer')}
              className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--lj-ink)] px-3 py-3 text-xs font-medium text-white transition-colors hover:bg-[var(--lj-gold-strong)]"
            >
              <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} /> Como chegar
            </a>
            <a
              href={whatsappUrl(s)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackWhatsAppClick('store_drawer', s.unit)}
              className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2E7D46] px-3 py-3 text-xs font-medium text-white transition-colors hover:bg-[#256538]"
            >
              <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.75} /> Falar no WhatsApp
            </a>
            <a
              href={instagramUrl(s)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackInstagramClick('store_drawer', s.unit)}
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-9 flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.3em] text-[var(--lj-gold-strong)]">
      {children}
      <span className="h-px flex-1 bg-[var(--lj-line)]" aria-hidden />
    </h3>
  );
}

function InfoRow({
  icon,
  term,
  children,
}: {
  icon: React.ReactNode;
  term: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 rounded-2xl border border-[var(--lj-line)] bg-white px-4 py-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--lj-cream)] text-[var(--lj-gold-strong)]">
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--lj-ink-soft)]/60">
          {term}
        </dt>
        <dd className="mt-0.5 text-[13px] leading-snug text-[var(--lj-ink-soft)]">{children}</dd>
      </div>
    </div>
  );
}
