'use client';

/**
 * KpiCard — Card colorido com gradient pra KPIs no estilo dashboard SaaS.
 *
 * 4 tons base: teal, green, orange, purple (como a referência ObraFácil).
 * Extra: sky, rose, slate.
 *
 * Uso:
 *   <KpiCard tone="teal" label="VENDAS HOJE" value="R$ 4.520,00" />
 */

import { type LucideIcon } from 'lucide-react';

export type KpiTone = 'teal' | 'green' | 'orange' | 'purple' | 'sky' | 'rose' | 'slate';

const TONES: Record<KpiTone, { from: string; to: string; ring: string }> = {
  teal:   { from: '#0e7e87', to: '#0a5a62', ring: 'rgba(255,255,255,0.18)' },
  green:  { from: '#5b9b3e', to: '#3f7029', ring: 'rgba(255,255,255,0.18)' },
  orange: { from: '#d68a3c', to: '#b66a1f', ring: 'rgba(255,255,255,0.18)' },
  purple: { from: '#8a5cb6', to: '#5f3e8a', ring: 'rgba(255,255,255,0.18)' },
  sky:    { from: '#3b82a8', to: '#1f5f80', ring: 'rgba(255,255,255,0.18)' },
  rose:   { from: '#c95a78', to: '#9a3f59', ring: 'rgba(255,255,255,0.18)' },
  slate:  { from: '#64748b', to: '#3a4555', ring: 'rgba(255,255,255,0.18)' },
};

interface KpiCardProps {
  tone?: KpiTone;
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  loading?: boolean;
  onClick?: () => void;
}

export default function KpiCard({
  tone = 'teal',
  label,
  value,
  hint,
  icon: Icon,
  loading,
  onClick,
}: KpiCardProps) {
  const t = TONES[tone];
  const Comp: any = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={`relative overflow-hidden rounded-2xl px-5 py-4 text-white shadow-sm text-left w-full transition ${
        onClick ? 'hover:shadow-md hover:-translate-y-0.5 active:translate-y-0' : ''
      }`}
      style={{
        background: `linear-gradient(135deg, ${t.from} 0%, ${t.to} 100%)`,
      }}
    >
      {/* Glow decorativo */}
      <div
        className="absolute -top-8 -right-8 w-32 h-32 rounded-full opacity-20"
        style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }}
      />
      <div className="relative">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[11px] font-bold tracking-wider uppercase opacity-90">{label}</div>
          {Icon && <Icon className="w-4 h-4 opacity-80" />}
        </div>
        <div className="text-[26px] sm:text-[28px] font-bold leading-tight">
          {loading ? <span className="opacity-50">—</span> : value}
        </div>
        {hint && (
          <div className="text-[11px] opacity-80 mt-1 truncate">{hint}</div>
        )}
      </div>
    </Comp>
  );
}
