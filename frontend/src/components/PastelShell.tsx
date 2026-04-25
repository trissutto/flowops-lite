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
  rose:     { ring: '#f9a8d4', bg: '#fdf2f8', icon: '#db2777', badge: '#ec4899', text: '#be185d' },
  peach:    { ring: '#fdba74', bg: '#fff7ed', icon: '#ea580c', badge: '#f97316', text: '#c2410c' },
  mint:     { ring: '#86efac', bg: '#f0fdf4', icon: '#16a34a', badge: '#22c55e', text: '#15803d' },
  sky:      { ring: '#7dd3fc', bg: '#f0f9ff', icon: '#0284c7', badge: '#0ea5e9', text: '#0369a1' },
  lavender: { ring: '#c4b5fd', bg: '#f5f3ff', icon: '#7c3aed', badge: '#8b5cf6', text: '#6d28d9' },
  yellow:   { ring: '#fde68a', bg: '#fefce8', icon: '#ca8a04', badge: '#eab308', text: '#a16207' },
  coral:    { ring: '#fca5a5', bg: '#fef2f2', icon: '#dc2626', badge: '#ef4444', text: '#b91c1c' },
  cream:    { ring: '#fcd6a5', bg: '#fffbeb', icon: '#a16207', badge: '#d97706', text: '#92400e' },
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
