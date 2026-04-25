'use client';

/**
 * CircleNav — Grade de botões circulares pastel reutilizável.
 *
 * Inspirado em ScapeBuilder/HS-Net: cada item vira um círculo grande com
 * anel pastel + ícone na cor mais saturada, label embaixo. Hover sobe o card
 * com sombra mais forte. Badge opcional no canto.
 *
 * Use como hub launchpad em qualquer tela:
 *   <CircleNav items={[
 *     { href: '/x', label: 'Pedidos', icon: ClipboardList, tone: 'rose', badge: 5 },
 *     ...
 *   ]} />
 */

import Link from 'next/link';
import { type LucideIcon } from 'lucide-react';
import { TONE_MAP, type PastelTone } from './PastelShell';

export interface CircleNavItem {
  href: string;
  label: string;
  subtitle?: string;
  icon: LucideIcon;
  tone: PastelTone;
  badge?: number | string;
  external?: boolean;
}

interface CircleNavProps {
  items: CircleNavItem[];
  /** Tamanho dos círculos. 'lg' = 88-104px (hub), 'md' = 72-84px, 'sm' = 56px (utilitários) */
  size?: 'sm' | 'md' | 'lg';
  /** Mostrar legenda embaixo */
  showLabel?: boolean;
  className?: string;
}

const SIZE_CLS: Record<NonNullable<CircleNavProps['size']>, { circle: string; icon: string; border: string; label: string }> = {
  sm: { circle: 'w-14 h-14',                    icon: 'w-5 h-5',           border: '2.5px',  label: 'text-[11px]' },
  md: { circle: 'w-[72px] h-[72px] sm:w-20 sm:h-20', icon: 'w-7 h-7 sm:w-8 sm:h-8', border: '3px',    label: 'text-xs sm:text-sm' },
  lg: { circle: 'w-[88px] h-[88px] sm:w-[104px] sm:h-[104px]', icon: 'w-9 h-9 sm:w-11 sm:h-11', border: '4px', label: 'text-sm sm:text-base' },
};

export default function CircleNav({
  items,
  size = 'lg',
  showLabel = true,
  className = '',
}: CircleNavProps) {
  const cls = SIZE_CLS[size];
  const cols =
    size === 'sm' ? 'grid-cols-3 sm:grid-cols-6' :
    size === 'md' ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5' :
                    'grid-cols-2 sm:grid-cols-3 md:grid-cols-4';

  return (
    <div className={`grid ${cols} gap-y-7 gap-x-4 sm:gap-x-6 justify-items-center ${className}`}>
      {items.map((item, idx) => (
        <CircleItem key={item.href + idx} item={item} cls={cls} showLabel={showLabel} index={idx} />
      ))}
    </div>
  );
}

function CircleItem({
  item,
  cls,
  showLabel,
  index,
}: {
  item: CircleNavItem;
  cls: typeof SIZE_CLS[keyof typeof SIZE_CLS];
  showLabel: boolean;
  index: number;
}) {
  const Icon = item.icon;
  const t = TONE_MAP[item.tone];
  const linkProps = item.external ? { target: '_blank', rel: 'noopener noreferrer' } : {};

  return (
    <Link
      href={item.href}
      {...linkProps}
      className="group flex flex-col items-center gap-2 fade-up"
      style={{ animationDelay: `${0.1 + index * 0.04}s` }}
    >
      <div className="relative">
        <div
          className={`circle-ring flex items-center justify-center ${cls.circle}`}
          style={{ border: `${cls.border} solid ${t.ring}`, background: t.bg }}
        >
          <Icon
            className={`${cls.icon} transition-transform duration-500 group-hover:scale-110`}
            style={{ color: t.icon }}
            strokeWidth={1.6}
          />
        </div>
        {item.badge != null && item.badge !== 0 && item.badge !== '' && (
          <span className="circle-badge" style={{ background: t.badge }}>
            {typeof item.badge === 'number' && item.badge > 99 ? '99+' : item.badge}
          </span>
        )}
      </div>
      {showLabel && (
        <div className="text-center">
          <div className={`${cls.label} font-medium text-slate-700 group-hover:text-slate-900 transition-colors leading-tight`}>
            {item.label}
          </div>
          {item.subtitle && (
            <div className="text-[10px] text-slate-400 mt-0.5 leading-tight">{item.subtitle}</div>
          )}
        </div>
      )}
    </Link>
  );
}
