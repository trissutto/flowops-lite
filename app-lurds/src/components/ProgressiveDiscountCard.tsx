'use client';

import { useEffect, useState } from 'react';
import { Sparkles, TrendingUp } from 'lucide-react';
import {
  getProgressiveConfig,
  type ProgressivePublicConfig,
  type ProgressiveCartItem,
  type ProgressiveDiscountResult,
} from '@/lib/api';
import { calcProgressiveLocal } from '@/lib/progressive';

const CACHE_KEY = 'lurds_progressive_cfg';
const CACHE_TTL = 5 * 60 * 1000; // 5min

/**
 * Card de Desconto Progressivo no carrinho.
 *
 * Cliente vê em tempo real:
 *   - Tiers disponíveis (2 = 10%, 3 = 15%, etc)
 *   - Quanto está economizando agora
 *   - Próximo tier (gatilho de upsell)
 *   - Aviso "PIX não acumula"
 */
export default function ProgressiveDiscountCard({
  items,
  onDiscountChange,
}: {
  items: ProgressiveCartItem[];
  onDiscountChange?: (r: ProgressiveDiscountResult | null) => void;
}) {
  const [cfg, setCfg] = useState<ProgressivePublicConfig | null>(null);
  const [result, setResult] = useState<ProgressiveDiscountResult | null>(null);

  // Carrega config (com cache local 5min)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Cache local
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.savedAt && Date.now() - parsed.savedAt < CACHE_TTL) {
            if (!cancelled) setCfg(parsed.cfg);
          }
        }
        const fresh = await getProgressiveConfig();
        if (cancelled) return;
        setCfg(fresh);
        localStorage.setItem(CACHE_KEY, JSON.stringify({ cfg: fresh, savedAt: Date.now() }));
      } catch {
        // Sem config: campanha desligada, não mostra card
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recalcula sempre que items mudam
  useEffect(() => {
    if (!cfg || !cfg.enabled) {
      setResult(null);
      onDiscountChange?.(null);
      return;
    }
    const r = calcProgressiveLocal(cfg, items);
    setResult(r);
    onDiscountChange?.(r);
  }, [items, cfg, onDiscountChange]);

  if (!cfg || !cfg.enabled || !cfg.tiers.length) return null;

  const fmtBrl = (v: number) =>
    v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const sortedTiers = [...cfg.tiers].sort((a, b) => a.minPieces - b.minPieces);
  const currentPct = result?.tierPct || 0;

  return (
    <div className="card-gold-border bg-gradient-to-br from-gold/15 via-ink-800 to-ink-900 p-4">
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp className="w-4 h-4 text-gold" />
        <span className="text-[11px] font-black uppercase tracking-widest text-gold">
          Desconto Progressivo
        </span>
      </div>

      {/* Tabela de tiers */}
      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {sortedTiers.map((t) => {
          const active = currentPct === t.discountPct;
          const reached = (result?.eligiblePieces || 0) >= t.minPieces;
          return (
            <div
              key={t.minPieces}
              className={`text-center rounded-lg py-2 px-1 border ${
                active
                  ? 'bg-gold text-ink border-gold shadow-gold'
                  : reached
                    ? 'bg-emerald-900/30 text-emerald-300 border-emerald-700/50'
                    : 'bg-ink-900/50 text-cream/50 border-ink-600'
              }`}
            >
              <div className="text-[10px] font-bold uppercase">
                {t.minPieces}+ pç
              </div>
              <div className="font-serif text-lg font-black tabular-nums">
                {t.discountPct}%
              </div>
            </div>
          );
        })}
      </div>

      {/* Resultado dinâmico */}
      {result?.applied ? (
        <div className="rounded-xl bg-gold/10 border border-gold/40 px-3 py-2.5 flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-gold shrink-0 mt-0.5" />
          <div className="flex-1 text-xs leading-relaxed">
            <div className="font-bold text-gold">
              {result.tierLabel} aplicado!
            </div>
            <div className="text-cream/80 mt-0.5">
              Economia: <span className="font-bold text-emerald-300">{fmtBrl(result.discountValue)}</span>
            </div>
            {result.nextTier && (
              <div className="text-cream/70 mt-1 text-[11px]">
                💡 +{result.nextTier.piecesToGo} peça{result.nextTier.piecesToGo > 1 ? 's' : ''} variada{result.nextTier.piecesToGo > 1 ? 's' : ''} = +{result.nextTier.extraPct}% OFF
              </div>
            )}
          </div>
        </div>
      ) : result?.nextTier ? (
        <div className="rounded-xl bg-ink-900 border border-ink-600 px-3 py-2.5 text-xs text-cream/80">
          💡 Adicione mais <strong className="text-gold">{result.nextTier.piecesToGo} peça{result.nextTier.piecesToGo > 1 ? 's variadas' : ''}</strong> e ganhe <strong className="text-gold">{result.nextTier.nextPct}% OFF</strong>
        </div>
      ) : (
        <div className="rounded-xl bg-ink-900 border border-ink-600 px-3 py-2.5 text-xs text-cream/60">
          Adicione peças variadas pra ativar o desconto
        </div>
      )}

      {/* Avisos importantes */}
      <div className="mt-2.5 text-[10px] text-cream/40 leading-relaxed">
        {cfg.excludePromoItems !== false && '• Produtos em promo não entram no desconto progressivo'}
        {cfg.excludePromoItems !== false && cfg.blocksPixDiscount !== false && <br />}
        {cfg.blocksPixDiscount !== false && '• Não acumula com desconto PIX'}
      </div>
    </div>
  );
}
