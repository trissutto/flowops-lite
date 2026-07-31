'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/feedback/ToastProvider';
import { TrackingProvider } from '@/components/tracking/TrackingProvider';

/**
 * Providers globais do app.
 * QueryClient criado com useState para não ser compartilhado entre requests
 * no SSR (cada request precisa do seu cache).
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Catálogo muda pouco dentro de uma sessão de navegação.
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        {/* Envolve tudo: o tracking também vale pro checkout e pra conta, que
            terão chrome próprio mas o mesmo funil. */}
        <TrackingProvider>{children}</TrackingProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
