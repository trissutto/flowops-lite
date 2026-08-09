import type { LucideIcon } from 'lucide-react';
import HubCard, { type HubTone } from '@/components/HubCard';

export interface ModuleHubItem {
  href: string;
  label: string;
  subtitle: string;
  description: string;
  tone: HubTone;
  icon: LucideIcon;
}

interface ModuleHubProps {
  eyebrow: string;
  title: string;
  description: string;
  items: ModuleHubItem[];
  note?: string;
}

export default function ModuleHub({ eyebrow, title, description, items, note }: ModuleHubProps) {
  return (
    <div className="mx-auto max-w-[1440px] px-3 py-6 sm:px-5 lg:px-7 lg:py-8">
      <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="text-[11px] font-black uppercase tracking-[0.18em] text-teal-700">{eyebrow}</div>
        <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-900">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">{description}</p>
        {note && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold leading-5 text-amber-900">
            {note}
          </div>
        )}
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => (
          <HubCard
            key={item.href}
            href={item.href}
            label={item.label}
            subtitle={item.subtitle}
            description={item.description}
            tone={item.tone}
            icon={item.icon}
          />
        ))}
      </section>
    </div>
  );
}
