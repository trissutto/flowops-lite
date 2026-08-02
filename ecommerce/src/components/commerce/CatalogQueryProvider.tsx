'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * QueryClient do CATÁLOGO — escopo local de propósito.
 *
 * Este provider já morou no layout raiz, e por isso o react-query entrava no
 * bundle compartilhado de TODAS as páginas: a home, que não faz uma única
 * query, pagava ~35 kB por ele. Hoje só a listagem de categoria usa
 * `useQuery`/`useInfiniteQuery`, então o provider desce junto com ela e o Next
 * consegue separar o pedaço.
 *
 * Precisa de react-query numa tela nova? Envolva a tela com este componente —
 * não devolva o provider pro layout raiz.
 */
export function CatalogQueryProvider({ children }: { children: React.ReactNode }) {
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

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
