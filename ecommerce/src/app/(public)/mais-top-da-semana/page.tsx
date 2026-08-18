import { Sparkles } from 'lucide-react';
import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { EditorialProductGrid } from '@/components/commerce/EditorialProductGrid';
import { EmptyState } from '@/components/feedback/EmptyState';
import { fetchMaisTopDaSemana } from '@/services/vitrine';
import { breadcrumbSchema, buildMetadata, itemListSchema, jsonLdGraph } from '@/lib/seo';

/**
 * MAIS TOP DA SEMANA — a vitrine CURADA da semana.
 *
 * Diferente de `/novidades` e `/outlet`, esta lista NÃO é o catálogo
 * reordenado: é uma seleção de ~20 peças escolhidas e ORDENADAS na retaguarda
 * (o mesmo dado que marca o selo `topSemana` no feed). Por isso não tem filtro,
 * scroll infinito nem reordenação — renderiza os `itens` na ordem que o backend
 * mandou, com o mesmo card da vitrine (`EditorialProductGrid` → `ProductCard`).
 *
 * A lista é curta e vem inteira do servidor: sem `CategoryListing`, que existe
 * pra paginar catálogo grande. Vazia sem curadoria publicada — mostra o estado
 * vazio em vez de página quebrada.
 */

/** 60 s (era 3600) — mesma janela das outras vitrines (ver `REVALIDATE_VITRINE`). */
export const revalidate = 60;

export const metadata = buildMetadata({
  title: 'Mais Top da Semana',
  description:
    'A seleção da semana da Lurd’s Plus Size, do 46 ao 60 — as peças mais desejadas, escolhidas a dedo.',
  path: '/mais-top-da-semana',
  keywords: ['mais vendidos plus size', 'destaques plus size', 'seleção da semana plus size'],
});

const trail = [
  { name: 'Início', path: '/' },
  { name: 'Mais Top da Semana', path: '/mais-top-da-semana' },
];

export default async function MaisTopDaSemanaPage() {
  const produtos = await fetchMaisTopDaSemana();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdGraph(
            breadcrumbSchema(trail),
            ...(produtos.length ? [itemListSchema(produtos, 'Mais Top da Semana')] : []),
          ),
        }}
      />

      <Section width="text" space="sm">
        <Breadcrumb
          items={trail.map((item, i) => ({
            label: item.name,
            href: i < trail.length - 1 ? item.path : undefined,
          }))}
        />
        <SectionTitle
          eyebrow="A seleção da semana"
          title="Mais Top da Semana"
          description="As peças mais desejadas, escolhidas a dedo — do 46 ao 60. Atualizamos toda semana."
          as="h1"
        />
      </Section>

      <Container width="wide">
        {produtos.length > 0 ? (
          <div className="py-12">
            {/* Ordem = a da curadoria; sem interrupções, o grid degrada pra
                grade limpa (ver `EditorialProductGrid`). */}
            <EditorialProductGrid products={produtos} />
          </div>
        ) : (
          <EmptyState
            icon={<Sparkles strokeWidth={1.5} />}
            title="A seleção da semana está sendo preparada."
            description="Ainda não temos os destaques desta semana. Enquanto isso, veja o que acabou de chegar."
            action={{ label: 'Ver novidades', href: '/novidades' }}
            secondaryAction={{ label: 'Ver o outlet', href: '/outlet' }}
          />
        )}
      </Container>
    </>
  );
}
