import { SearchX } from 'lucide-react';
import { Section } from '@/components/layout/Section';
import { EmptyState } from '@/components/feedback/EmptyState';
import { buildMetadata } from '@/lib/seo';

export const metadata = buildMetadata({
  title: 'Página não encontrada',
  path: '/404',
  noIndex: true,
});

export default function NotFound() {
  return (
    <Section space="lg" width="text">
      <EmptyState
        icon={<SearchX strokeWidth={1.5} />}
        title="Essa página saiu de coleção."
        description="O endereço que você abriu não existe mais — mas a gente te ajuda a encontrar o que procura."
        action={{ label: 'Voltar ao início', href: '/' }}
        secondaryAction={{ label: 'Ver nossas lojas', href: '/lojas' }}
      />
    </Section>
  );
}
