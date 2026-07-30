'use client';

import { useMemo, useRef, useState } from 'react';
// Sem AnimatePresence aqui: o unmount pós-exit não dispara com o React do
// Next 14.1 (dropdown/banner ficavam órfãos no DOM) — animamos só a entrada.
import { motion } from 'framer-motion';
import { LocateFixed, Search, MapPin, MessageCircle, Instagram, Loader2 } from 'lucide-react';
import { stores, whatsappUrl, instagramUrl, directionsUrl, type Store } from '../lib';
import type { GeoState } from '../NossasLojasClient';

function normalize(v: string): string {
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

interface Props {
  geoState: GeoState;
  nearest: { store: Store; km: number } | null;
  onLocate: () => void;
  onPick: (slug: string) => void;
}

export default function SearchLocate({ geoState, nearest, onLocate, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return [];
    return stores.filter((s) =>
      [s.unit, s.city, s.address.neighborhood].some((f) => normalize(f).includes(q)),
    );
  }, [query]);

  function pick(s: Store) {
    setQuery(`${s.unit} — ${s.city}/${s.uf}`);
    setOpen(false);
    onPick(s.slug);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <section id="buscar" className="scroll-mt-8 border-t border-[var(--lj-line)] px-6 pb-10 pt-20 sm:pt-24">
      <div className="mx-auto max-w-3xl text-center">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7 }}
        >
          <h2 className="lojas-serif text-3xl font-medium sm:text-4xl">Qual cidade é a sua?</h2>
          <div className="lojas-rule mx-auto mt-5 w-24" />
          <p className="mt-5 text-sm font-light text-[var(--lj-ink-soft)]">
            Busque pela cidade ou deixe a gente encontrar a unidade mais próxima de você.
          </p>
        </motion.div>

        <div className="mx-auto mt-8 flex max-w-xl flex-col gap-3 sm:flex-row">
          {/* Autocomplete de cidade */}
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--lj-gold-strong)]" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded={open && results.length > 0}
              aria-controls="lojas-autocomplete"
              aria-label="Buscar loja por cidade"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                setActive(0);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              onKeyDown={onKeyDown}
              placeholder="Busque por cidade ou bairro…"
              className="w-full rounded-full border border-[var(--lj-line)] bg-white py-3.5 pl-11 pr-4 text-sm outline-none transition-shadow placeholder:text-[var(--lj-ink-soft)]/60 focus:border-[var(--lj-gold)] focus:shadow-[0_0_0_3px_rgba(184,145,43,0.12)]"
            />
            {open && results.length > 0 && (
                <motion.ul
                  id="lojas-autocomplete"
                  role="listbox"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18 }}
                  className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-2xl border border-[var(--lj-line)] bg-white text-left shadow-xl shadow-black/5"
                >
                  {results.map((s, i) => (
                    <li key={s.slug} role="option" aria-selected={i === active}>
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pick(s)}
                        onMouseEnter={() => setActive(i)}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-sm transition-colors ${
                          i === active ? 'bg-[var(--lj-cream)]' : 'bg-white'
                        }`}
                      >
                        <MapPin className="h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" />
                        <span className="font-medium">{s.unit}</span>
                        <span className="text-[var(--lj-ink-soft)]">
                          {s.address.neighborhood} · {s.city}/{s.uf}
                        </span>
                      </button>
                    </li>
                  ))}
                </motion.ul>
            )}
          </div>

          {/* Geolocalização */}
          <button
            onClick={onLocate}
            disabled={geoState === 'loading'}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--lj-gold)] px-6 py-3.5 text-sm font-medium text-[var(--lj-gold-strong)] transition-colors hover:bg-[#FBF6E6] disabled:opacity-60"
          >
            {geoState === 'loading' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LocateFixed className="h-4 w-4" />
            )}
            Usar minha localização
          </button>
        </div>

        {geoState === 'error' && (
          <p className="mt-3 text-xs text-[var(--lj-ink-soft)]">
            Não conseguimos acessar sua localização — busque pela cidade acima. 💛
          </p>
        )}

        {/* Banner da loja mais próxima — a experiência de 1 clique */}
        {nearest && (
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.5 }}
              className="mx-auto mt-10 max-w-2xl rounded-3xl border border-[var(--lj-gold)]/40 bg-white p-8 shadow-[0_20px_60px_-30px_rgba(140,115,37,0.4)]"
            >
              <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-[var(--lj-gold-strong)]">
                Mais perto de você
              </p>
              <h3 className="lojas-serif mt-3 text-2xl font-medium sm:text-3xl">
                Lurds {nearest.store.unit}
              </h3>
              <p className="mt-2 text-sm font-light text-[var(--lj-ink-soft)]">
                A cerca de <strong className="font-semibold">{formatKm(nearest.km)}</strong> de onde
                você está · {nearest.store.address.street}, {nearest.store.address.neighborhood}
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <a
                  href={directionsUrl(nearest.store)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--lj-ink)] px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-[var(--lj-gold-strong)]"
                >
                  <MapPin className="h-4 w-4" /> Como chegar
                </a>
                <a
                  href={whatsappUrl(nearest.store)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-[#2E7D46] px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-[#256538]"
                >
                  <MessageCircle className="h-4 w-4" /> Chamar no WhatsApp
                </a>
                <a
                  href={instagramUrl(nearest.store)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--lj-gold)] px-5 py-3.5 text-sm font-medium text-[var(--lj-gold-strong)] transition-colors hover:bg-[#FBF6E6]"
                >
                  <Instagram className="h-4 w-4" /> Ver Instagram
                </a>
              </div>
            </motion.div>
        )}
      </div>
    </section>
  );
}

function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(km < 10 ? 1 : 0).replace('.', ',')} km`;
}
