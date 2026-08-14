'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { MessageCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/store/chat';

const AssistenteWidget = dynamic(
  () => import('@/components/chat/AssistenteWidget').then((module) => module.AssistenteWidget),
  { loading: () => <ConsultoraLauncher loading /> },
);

function ConsultoraLauncher({ loading = false }: { loading?: boolean }) {
  const pathname = usePathname();
  const abrir = useChatStore((state) => state.abrir);
  const onProduct = pathname?.startsWith('/produto/');

  return (
    <button
      type="button"
      onClick={() => abrir()}
      aria-label={loading ? 'Abrindo consultora virtual' : 'Falar com a consultora virtual'}
      aria-busy={loading}
      className={cn(
        'fixed right-4 z-[60] flex size-14 items-center justify-center rounded-pill bg-ink text-light shadow-lg transition-transform hover:scale-105 lg:right-6 lg:bottom-6',
        onProduct ? 'bottom-24' : 'bottom-4',
      )}
    >
      <MessageCircle className="size-6" strokeWidth={1.5} />
    </button>
  );
}

export function DeferredAssistenteWidget() {
  const pathname = usePathname();
  const aberto = useChatStore((state) => state.aberto);
  const [activated, setActivated] = useState(false);

  useEffect(() => {
    if (aberto) setActivated(true);
  }, [aberto]);

  if (pathname?.startsWith('/checkout')) return null;
  if (activated) return <AssistenteWidget />;
  return <ConsultoraLauncher />;
}
