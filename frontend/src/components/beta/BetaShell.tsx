'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, LogOut, Menu, Search, Store, X } from 'lucide-react';
import { api } from '@/lib/api';
import { BETA_NAV } from './beta-navigation';

type Me = { name?: string; role: string; storeId?: string | null; storeName?: string | null };
type StoreOption = { id: string; code: string; name: string };

export default function BetaShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/beta';
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState('inicio');
  const [me, setMe] = useState<Me | null>(null);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storeId, setStoreId] = useState('');

  useEffect(() => {
    const token = localStorage.getItem('flowops_token');
    if (!token) { router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`); return; }
    api<Me>('/auth/me').then((actor) => {
      setMe(actor);
      if (actor.storeId) setStoreId(actor.storeId);
    }).catch(() => router.replace('/login'));
    api<StoreOption[]>('/stores').then(setStores).catch(() => setStores([]));
  }, [pathname, router]);

  useEffect(() => {
    const active = BETA_NAV.find((group) => group.href === pathname || group.items?.some((item) => pathname === item.href || pathname.startsWith(item.href + '/')));
    if (active) setExpanded(active.key);
    setOpen(false);
  }, [pathname]);

  const storeLabel = useMemo(() => {
    if (me?.role === 'store') return me.storeName || 'Minha loja';
    if (!storeId) return `Toda a rede · ${stores.length || 15} lojas`;
    const store = stores.find((s) => s.id === storeId);
    return store ? `${store.code} · ${store.name}` : 'Toda a rede';
  }, [me, storeId, stores]);

  const logout = () => { localStorage.removeItem('flowops_token'); router.push('/login'); };

  return (
    <div className="min-h-screen bg-[#F6F6F4] text-[#24231F]">
      {open && <button aria-label="Fechar menu" className="fixed inset-0 z-40 bg-black/35 md:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-[252px] flex-col border-r border-[#DDDCD7] bg-[#EEEEEC] transition-transform md:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-16 items-center gap-3 border-b border-[#D7D5D0] px-4">
          <Link href="/beta" className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#24231F] text-xs font-bold text-white">L1</div>
            <div className="min-w-0"><div className="truncate text-sm font-semibold">LURD&apos;S FlowOps</div><div className="text-[10px] font-bold uppercase tracking-[.18em] text-[#8C7325]">Beta Shopify</div></div>
          </Link>
          <button onClick={() => setOpen(false)} className="ml-auto rounded p-1 md:hidden"><X className="h-5 w-5" /></button>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {BETA_NAV.map((group) => {
            const Icon = group.icon;
            const active = group.href === pathname || group.items?.some((item) => pathname === item.href || pathname.startsWith(item.href + '/'));
            if (group.href) return <Link key={group.key} href={group.href} className={`mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${active ? 'bg-[#DCDCD9] font-semibold' : 'hover:bg-[#E4E4E1]'}`}><Icon className="h-[18px] w-[18px]" />{group.label}</Link>;
            const isOpen = expanded === group.key;
            return <div key={group.key} className="mb-1"><button onClick={() => setExpanded(isOpen ? '' : group.key)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm ${active ? 'bg-[#DCDCD9] font-semibold' : 'hover:bg-[#E4E4E1]'}`}><Icon className="h-[18px] w-[18px]" /><span className="flex-1">{group.label}</span><ChevronRight className={`h-4 w-4 transition ${isOpen ? 'rotate-90' : ''}`} /></button>{isOpen && <div className="ml-[21px] mt-1 border-l border-[#D0CEC8] pl-2">{group.items?.map((item) => <Link key={item.href + item.label} href={item.href} className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${pathname === item.href || pathname.startsWith(item.href + '/') ? 'bg-white font-semibold text-[#24231F]' : 'text-[#68655E] hover:bg-[#E4E4E1]'}`}><span className="flex-1">{item.label}</span>{item.legacy && <span className="rounded bg-[#E2DFD8] px-1.5 py-0.5 text-[8px] font-bold uppercase text-[#777269]">Atual</span>}</Link>)}</div>}</div>;
          })}
        </nav>
        <div className="border-t border-[#D7D5D0] p-3 text-xs text-[#68655E]">Ambiente de validação<br /><strong className="text-[#24231F]">O sistema atual continua intacto</strong></div>
      </aside>

      <div className="md:pl-[252px]">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-[#DDDCD7] bg-white/95 px-4 backdrop-blur sm:px-6">
          <button onClick={() => setOpen(true)} className="rounded-lg border p-2 md:hidden"><Menu className="h-5 w-5" /></button>
          <div className="hidden min-w-[260px] items-center gap-2 rounded-lg border border-[#D8D6D0] bg-[#F8F8F7] px-3 py-2 text-sm text-[#8A867E] lg:flex"><Search className="h-4 w-4" />Buscar no FlowOps Beta</div>
          <div className="ml-auto flex items-center gap-2">
            {me?.role !== 'store' ? <label className="flex items-center gap-2 rounded-lg border border-[#D8D6D0] bg-white px-3 py-2 text-xs"><Store className="h-4 w-4 text-[#8C7325]" /><select value={storeId} onChange={(e) => setStoreId(e.target.value)} className="max-w-[180px] bg-transparent outline-none"><option value="">Toda a rede · {stores.length || 15} lojas</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></label> : <div className="rounded-lg border px-3 py-2 text-xs">{storeLabel}</div>}
            <div className="hidden text-right sm:block"><div className="text-xs font-semibold">{me?.name || 'Usuário'}</div><div className="text-[10px] uppercase text-[#8A867E]">{me?.role || '...'}</div></div>
            <button onClick={logout} title="Sair" className="rounded-lg border border-[#D8D6D0] p-2 text-[#68655E] hover:bg-[#F3F2EF]"><LogOut className="h-4 w-4" /></button>
          </div>
        </header>
        <div>{children}</div>
      </div>
    </div>
  );
}

