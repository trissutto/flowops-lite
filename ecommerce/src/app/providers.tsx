'use client';

import { ToastProvider } from '@/components/feedback/ToastProvider';
import { TrackingProvider } from '@/components/tracking/TrackingProvider';

/**
 * Providers globais do app — só o que TODA página precisa.
 *
 * ⚠️ Não acrescente provider de biblioteca aqui sem checar o custo: o que
 * entra neste arquivo entra no bundle compartilhado de todas as rotas. O
 * QueryClientProvider já morou aqui e fazia a home (que não dispara nenhuma
 * query) carregar o react-query inteiro; hoje ele vive em
 * `CatalogQueryProvider`, colado na única tela que usa.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      {/* Envolve tudo: o tracking também vale pro checkout e pra conta, que
          terão chrome próprio mas o mesmo funil. */}
      <TrackingProvider>{children}</TrackingProvider>
    </ToastProvider>
  );
}
