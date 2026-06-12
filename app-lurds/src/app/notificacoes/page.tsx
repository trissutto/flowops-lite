'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Bell, BellOff, Package, Sparkles, Tv, Tag, Gift,
  Loader2, Check,
} from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import {
  getNotifications, markAllNotificationsRead, isLoggedIn,
  type AppNotification,
} from '@/lib/api';

const CATEGORY_META: Record<
  AppNotification['category'],
  { icon: any; color: string; bg: string }
> = {
  order:    { icon: Package,   color: 'text-blue-300',    bg: 'bg-blue-900/30' },
  cashback: { icon: Sparkles,  color: 'text-emerald-300', bg: 'bg-emerald-900/30' },
  live:     { icon: Tv,        color: 'text-rose-300',    bg: 'bg-rose-900/30' },
  promo:    { icon: Tag,       color: 'text-gold',        bg: 'bg-gold/10' },
  system:   { icon: Gift,      color: 'text-purple-300',  bg: 'bg-purple-900/30' },
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

export default function NotificacoesPage() {
  const router = useRouter();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.push('/entrar?next=/notificacoes');
      return;
    }
    getNotifications()
      .then((r) => {
        setItems(r.notifications);
        setUnread(r.unreadCount);
        // Marca tudo como lido em background (sem bloquear UI)
        if (r.unreadCount > 0) {
          markAllNotificationsRead().catch(() => null);
        }
      })
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [router]);

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <div className="flex-1">
          <h1 className="font-serif text-xl font-bold leading-none">Notificações</h1>
          {!loading && items.length > 0 && (
            <p className="text-[11px] text-cream/50 mt-0.5">
              {items.length} {items.length === 1 ? 'mensagem' : 'mensagens'}
              {unread > 0 && (
                <> · <span className="text-gold font-bold">{unread} nova{unread > 1 ? 's' : ''}</span></>
              )}
            </p>
          )}
        </div>
      </header>

      {loading ? (
        <div className="flex justify-center mt-20">
          <Loader2 className="w-8 h-8 animate-spin text-gold" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mt-5 px-5 space-y-2">
          {items.map((n) => {
            const meta = CATEGORY_META[n.category] || CATEGORY_META.promo;
            const Icon = meta.icon;
            const Wrapper: any = n.url ? Link : 'div';
            const wrapperProps = n.url ? { href: n.url } : {};
            return (
              <Wrapper
                key={n.id}
                {...wrapperProps}
                className={`block rounded-2xl p-4 border transition active:scale-[0.98] ${
                  n.read
                    ? 'bg-ink-800/60 border-ink-600/50'
                    : 'bg-ink-800 border-gold/40'
                }`}
              >
                <div className="flex gap-3">
                  <div className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${meta.bg}`}>
                    <Icon className={`w-5 h-5 ${meta.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-0.5">
                      <h3 className={`font-bold text-sm leading-tight ${n.read ? 'text-cream/80' : 'text-white'}`}>
                        {n.title}
                      </h3>
                      <span className="text-[10px] text-cream/40 shrink-0 tabular-nums">
                        {timeAgo(n.createdAt)}
                      </span>
                    </div>
                    {n.body && (
                      <p className={`text-xs leading-relaxed ${n.read ? 'text-cream/50' : 'text-cream/80'}`}>
                        {n.body}
                      </p>
                    )}
                    {!n.read && (
                      <div className="mt-1.5 inline-block w-2 h-2 rounded-full bg-gold" />
                    )}
                  </div>
                </div>
              </Wrapper>
            );
          })}
        </div>
      )}

      <BottomNav />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-16 text-center px-8">
      <BellOff className="w-16 h-16 mx-auto text-gold/40" />
      <h2 className="font-serif text-xl font-bold mt-4">Caixa vazia</h2>
      <p className="text-sm text-cream/60 mt-2 leading-relaxed">
        Quando enviarmos uma novidade — promoção, atualização do seu pedido, cashback chegando — vai aparecer aqui pra você não perder.
      </p>
      <Link
        href="/conta/notificacoes"
        className="mt-6 inline-flex items-center gap-2 text-xs text-gold underline"
      >
        <Bell className="w-3.5 h-3.5" /> Configurar notificações
      </Link>
    </div>
  );
}
