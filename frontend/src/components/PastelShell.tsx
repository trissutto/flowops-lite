'use client';

/**
 * PastelShell — Wrapper visual padrão "tablet pastel" pra qualquer tela.
 *
 * Aplica:
 *   - Background com radial glow rosa pastel + gradiente cream→pink suave
 *   - Container max-w-7xl centralizado com padding responsivo
 *   - Header amigável opcional (título + subtítulo + breadcrumb voltar)
 *   - Painel central pastel opcional (panel-pastel) que envelopa o conteúdo
 *
 * Use como: <PastelShell title="Retaguarda" subtitle="..." backHref="/">{...}</PastelShell>
 */

import Link from 'next/link';
import { ArrowLeft, type LucideIcon } from 'lucide-react';
import { ReactNode } from 'react';

export type PastelTone = 'rose' | 'peach' | 'mint' | 'sky' | 'lavender' | 'yellow' | 'coral' | 'cream';

export const TONE_MAP: Record<PastelTone, { ring: string; bg: string; icon: string; badge: string; text: string }> = {
  // Paleta BOUTIQUE sofisticada — tons fumê/poeirento. Mantém os mesmos nomes
  // de chave (rose, mint, sky…) pra não quebrar nada já existente, mas as
  // cores agora são "muted" — rosé blush, sálvia, terracota, mauve, champagne,
  // petrol, cobre, linen. Visual de loja boutique de luxo.
  rose:     { ring: '#c08081', bg: '#f5e6e3', icon: '#8b4f55', badge: '#a06469', text: '#6e3a40' }, // rosé fumê / blush
  peach:    { ring: '#c87f5e', bg: '#f3e2d6', icon: '#8b4d31', badge: '#a86747', text: '#6f3b25' }, // terracota
  mint:     { ring: '#9caf88', bg: '#e3ebd9', icon: '#5d7048', badge: '#7a8e64', text: '#475636' }, // sálvia
  sky:      { ring: '#6b8a92', bg: '#dde7ea', icon: '#3e5d6a', badge: '#557785', text: '#2e4750' }, // petrol/teal
  lavender: { ring: '#a48ba1', bg: '#ebe2eb', icon: '#6b5870', badge: '#856e88', text: '#4f4054' }, // mauve fumê
  yellow:   { ring: '#c9a96e', bg: '#f0e6cf', icon: '#8a7340', badge: '#a98e54', text: '#6a5830' }, // champagne / mostarda
  coral:    { ring: '#b87355', bg: '#ecdac9', icon: '#7d4a30', badge: '#985d3f', text: '#5e3823' }, // cobre / canela
  cream:    { ring: '#b89977', bg: '#efe5d4', icon: '#82664a', badge: '#9c7e5e', text: '#604a36' }, // nude / camelo
};

interface PastelShellProps {
  title?: string;
  subtitle?: string;
  emoji?: string;
  icon?: LucideIcon;
  tone?: PastelTone;
  backHref?: string;
  backLabel?: string;
  rightSlot?: ReactNode;
  withPanel?: boolean;
  children: ReactNode;
}

export default function PastelShell({
  title,
  subtitle,
  emoji,
  icon: Icon,
  tone = 'rose',
  backHref,
  backLabel = 'Voltar',
  rightSlot,
  withPanel = false,
  children,
}: PastelShellProps) {
  const t = TONE_MAP[tone];

  return (
    <div
      className="min-h-screen"
      style={{
        background: `radial-gradient(1100px 600px at 50% -10%, ${t.bg} 0%, transparent 60%), linear-gradient(180deg, #fef9f3 0%, #fdf2f8 100%)`,
      }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
        {/* Header */}
        {(title || backHref) && (
          <header className="flex items-center justify-between flex-wrap gap-4 mb-6 fade-up">
            <div className="flex items-center gap-4">
              {backHref && (
                <Link
                  href={backHref}
                  className="flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800 transition"
                >
                  <ArrowLeft className="w-4 h-4" />
                  {backLabel}
                </Link>
              )}
              {(title || subtitle) && backHref && <div className="h-5 w-px bg-slate-200" />}
              {Icon && (
                <div
                  className="circle-ring flex items-center justify-center w-12 h-12"
                  style={{ border: `3px solid ${t.ring}`, background: t.bg }}
                >
                  <Icon className="w-5 h-5" style={{ color: t.icon }} strokeWidth={1.7} />
                </div>
              )}
              <div>
                {title && (
                  <>
                    <div
                      className="text-[11px] uppercase tracking-[0.3em] font-semibold mb-1"
                      style={{ color: t.text }}
                    >
                      Lurds Order One
                    </div>
                    <h1 className="font-display text-3xl sm:text-4xl text-slate-800 leading-tight">
                      {title} {emoji && <span>{emoji}</span>}
                    </h1>
                    {subtitle && (
                      <div className="text-sm text-slate-500 mt-1">{subtitle}</div>
                    )}
                  </>
                )}
              </div>
            </div>
            {rightSlot && <div>{rightSlot}</div>}
          </header>
        )}

        {/* Conteúdo */}
        {withPanel ? (
          <section className="panel-pastel p-4 sm:p-8 fade-up" style={{ animationDelay: '0.1s' }}>
            {children}
          </section>
        ) : (
          <div className="fade-up" style={{ animationDelay: '0.05s' }}>{children}</div>
        )}
      </div>
    </div>
  );
}
