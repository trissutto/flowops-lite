'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles, ChevronRight } from 'lucide-react';
import { getProgressiveConfig, type ProgressivePublicConfig } from '@/lib/api';

const CACHE_KEY = 'lurds_progressive_cfg';
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Banner home — chama atenção pra campanha de Desconto Progressivo.
 * Só aparece quando admin liga a campanha na retaguarda.
 */
export default function ProgressiveBanner() {
  const [cfg, setCfg] = useState<ProgressivePublicConfig | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.savedAt && Date.now() - parsed.savedAt < CACHE_TTL) {
            setCfg(parsed.cfg);
          }
        }
        const fresh = await getProgressiveConfig();
        setCfg(fresh);
        localStorage.setItem(CACHE_KEY, JSON.stringify({ cfg: fresh, savedAt: Date.now() }));
      } catch {}
    })();
  }, []);

  if (!cfg || !cfg.enabled || !cfg.tiers.length) return null;

  const maxTier = [...cfg.tiers].sort((a, b) => b.discountPct - a.discountPct)[0];
  const sortedTiers = [...cfg.tiers].sort((a, b) => a.minPieces - b.minPieces);

  return (
    <Link
      href="/catalogo"
      className="block mx-4 mt-3 rounded-2xl bg-gradient-to-r from-gold via-amber-400 to-gold p-[2px] shadow-gold animate-pulse-slow"
    >
      <div className="rounded-2xl bg-gradient-to-br from-ink-900 via-ink-800 to-ink-900 px-4 py-3.5 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-gold/20 border border-gold/40 flex items-center justify-center shrink-0">
          <Sparkles className="w-5 h-5 text-gold" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-serif text-sm font-bold text-gold uppercase tracking-wide">
            {cfg.bannerText || `Até ${maxTier.discountPct}% OFF`}
          </div>
          <div className="text-[11px] text-cream/70 mt-0.5">
            {sortedTiers.map((t, i) => (
              <span key={t.minPieces}>
                {i > 0 && ' · '}
                <strong className="text-cream">{t.minPieces}pç</strong>={t.discountPct}%
              </span>
            ))}
          </div>
        </div>
        <ChevronRight className="w-5 h-5 text-gold shrink-0" />
      </div>
    </Link>
  );
}
