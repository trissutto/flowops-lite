'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Check, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Toast — feedback discreto no canto inferior. Nunca bloqueia a interação.
 * Uso: `const { toast } = useToast(); toast({ message: 'Adicionado à sacola' })`
 */

type ToastTone = 'success' | 'info' | 'error';

interface ToastItem {
  id: number;
  message: string;
  description?: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (input: { message: string; description?: string; tone?: ToastTone }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastTone, React.ElementType> = {
  success: Check,
  info: Info,
  error: TriangleAlert,
};

const TONES: Record<ToastTone, string> = {
  success: 'text-success',
  info: 'text-primary-strong',
  error: 'text-danger',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback<ToastContextValue['toast']>(
    ({ message, description, tone = 'success' }) => {
      const id = Date.now() + Math.floor(Math.random() * 1000);
      setItems((current) => [...current, { id, message, description, tone }]);
      setTimeout(() => dismiss(id), 4200);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Região viva — leitores de tela anunciam sem roubar o foco */}
      <div
        role="region"
        aria-live="polite"
        aria-label="Notificações"
        className="pointer-events-none fixed right-4 bottom-4 z-[var(--z-toast)] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
      >
        {items.map((item) => {
          const Icon = ICONS[item.tone];
          return (
            <div
              key={item.id}
              className="pointer-events-auto flex animate-[widget-enter_320ms_cubic-bezier(0.22,1,0.36,1)] items-start gap-3 rounded-md border border-border bg-surface p-4 shadow-md"
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', TONES[item.tone])} strokeWidth={2} />
              <div className="flex-1">
                <p className="text-small font-medium text-ink">{item.message}</p>
                {item.description && (
                  <p className="mt-1 text-small font-light text-ink-soft">{item.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label="Fechar notificação"
                className="text-ink-muted transition-colors hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast precisa estar dentro de <ToastProvider>');
  return context;
}
