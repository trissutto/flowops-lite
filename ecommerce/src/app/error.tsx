'use client';

import { useEffect } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Section } from '@/components/layout/Section';
import { EmptyState } from '@/components/feedback/EmptyState';

/**
 * Error boundary de rota. Mantém a identidade visual mesmo quando algo quebra
 * — a cliente nunca vê stack trace.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Em produção este ponto envia pro serviço de observabilidade.
    console.error(error);
  }, [error]);

  return (
    <Section space="lg" width="text">
      <EmptyState
        icon={<TriangleAlert strokeWidth={1.5} />}
        title="Algo não carregou como deveria."
        description="Tente novamente — se continuar, a nossa equipe já foi avisada."
        action={{ label: 'Tentar de novo', onClick: reset }}
        secondaryAction={{ label: 'Voltar ao início', href: '/' }}
      />
    </Section>
  );
}
