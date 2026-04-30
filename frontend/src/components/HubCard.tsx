'use client';

/**
 * HubCard — Card colorido grande pra navegação entre módulos.
 *
 * Mesmo estilo dos KpiCards (gradient + glow no canto), mas voltado pra
 * navegação (link). 8 tons disponíveis pra dar variedade visual em hubs
 * com muitos itens (Site, Loja, etc).
 *
 * Uso:
 *   <HubCard
 *     href="/separacao"
 *     label="Pedidos"
 *     subtitle="E-COMMERCE"
 *     description="Separação e envio"
 *     tone="teal"
 *     icon={ClipboardList}
 *   />
 */

import Link from 'next/link';
import { ArrowUpRight, type LucideIcon } from 'lucide-react';

export type HubTone = 'teal' | 'green' | 'orange' | 'purple' | 'rose' | 'sky' | 'amber' | 'slate';

/**
 * Paleta unificada do sistema. Reusada em qualquer lugar que precise dos
 * mesmos tons (PDV, /site, /loja, /retaguarda, /config).
 */
export const HUB_TONES: Record<HubTone, { from: string; to: string }> = {
  teal:   { from: '#0e7e87', to: '#0a5a62' },
  green:  { from: '#5b9b3e', to: '#3f7029' },
  orange: { from: '#d68a3c', to: '#b66a1f' },
  purple: { from: '#8a5cb6', to: '#5f3e8a' },
  rose:   { from: '#c95a78', to: '#9a3f59' },
  sky:    { from: '#3b82a8', to: '#1f5f80' },
  amber:  { from: '#c9a96e', to: '#8a7340' },
  slate:  { from: '#64748b', to: '#3a4555' },
};

interface HubCardProps {
  href: string;
  label: string;
  subtitle?: string;
  description?: string;
  tone?: HubTone;
  icon?: LucideIcon;
  external?: boolean;
}

export default function HubCard({
  href, label, subtitle, description, tone = 'teal', icon: Icon, external,
}: HubCardProps) {
  const t = HUB_TONES[tone];
  const Comp: any = external ? 'a' : Link;
  const linkProps: any = external
    ? { href, target: '_blank', rel: 'noopener noreferrer' }
    : { href };

  return (
    <Comp
      {...linkProps}
      className="relative overflow-hidden rounded-2xl px-5 py-5 text-white shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 transition flex flex-col gap-2"
      style={{ background: `linear-gradient(135deg, ${t.from} 0%, ${t.to} 100%)` }}
    >
      {/* Glow decorativo */}
      <div
        className="absolute -top-8 -right-8 w-32 h-32 rounded-full opacity-15"
        style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }}
      />
      <div className="relative flex items-center justify-between">
        {Icon && <Icon className="w-6 h-6 opacity-90" strokeWidth={1.7} />}
        <ArrowUpRight className="w-4 h-4 opacity-70" />
      </div>
      <div className="relative">
        {subtitle && (
          <div className="text-[11px] font-bold tracking-wider uppercase opacity-90">
            {subtitle}
          </div>
        )}
        <div className="text-2xl font-bold leading-tight mt-0.5">{label}</div>
        {description && (
          <div className="text-[11px] opacity-80 mt-1.5 leading-snug">{description}</div>
        )}
      </div>
    </Comp>
  );
}
