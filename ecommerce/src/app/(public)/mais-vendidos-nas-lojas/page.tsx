import { Trophy } from 'lucide-react';
import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { EditorialProductGrid } from '@/components/commerce/EditorialProductGrid';
import { EmptyState } from '@/components/feedback/EmptyState';
import { fetchMaisVendidosNasLojas } from '@/services/vitrine';
import { breadcrumbSchema, buildMetadata, itemListSchema, jsonLdGraph } from '@/lib/seo';

/**
 * OS MAIS VENDIDOS NAS LOJAS — a vitrine AUTOMÁTICA do caixa físico.
 *
 * Irmã da `/mais-top-da-semana`, com uma diferença de origem: lá a lista é
 * escolhida a dedo na retaguarda; aqui quem escolhe é o caixa das lojas — o
 * backend ranqueia as 30 peças mais vendidas na loja física que ainda têm
 * estoque pra aguentar o selo (≥ 30 peças e nenhum tamanho zerado). Ninguém
 * mantém esta página: peça que esgota sai sozinha, peça que repõe volta.
 *
 * Renderiza os `itens` na ordem que o backend mandou (1º lugar primeiro), sem
 * filtro nem scroll infinito — mesma anatomia da página curada.
 */

/** 60 s — mesma janela das outras vitrines (ver `REVALIDATE_VITRINE`). */
export const revalidate = 60;

export const metadata = buildMetadata({
  title: 'Os Mais Vendidos nas Lojas',
  description:
    'As 30 peças que as clientes mais levam nas lojas Lurd’s Plus Size, do 46 ao 60 — com a grade completa em estoque.',
  path: '/mais-vendidos-nas-lojas',
  keywords: ['mais vendidos plus size', 'best sellers plus size', 'queridinhas plus size'],
});

const trail = [
  { name: 'Início', path: '/' },
  { name: 'Os Mais Vendidos nas Lojas', path: '/mais-vendidos-nas-lojas' },
];

export default async function MaisVendidosNasLojasPage() {
  const produtos = await fetchMaisVendidosNasLojas();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdGraph(
            breadcrumbSchema(trail),
            ...(produtos.length ? [itemListSchema(produtos, 'Os Mais Vendidos nas Lojas')] : []),
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
          eyebrow="O que sai da loja todo dia"
          title="Os Mais Vendidos nas Lojas"
          description="As peças que as clientes mais levam nas nossas lojas, do 46 ao 60 — todas com a grade completa em estoque agora."
          as="h1"
        />
      </Section>

      <Container width="wide">
        {produtos.length > 0 ? (
          <div className="py-12">
            {/* Ordem = o ranking do caixa; o grid degrada pra grade limpa
                (ver `EditorialProductGrid`). */}
            <EditorialProductGrid products={produtos} />
          </div>
        ) : (
          <EmptyState
            icon={<Trophy strokeWidth={1.5} />}
            title="Estamos conferindo o ranking das lojas."
            description="Já já esta vitrine enche. Enquanto isso, veja o que acabou de chegar."
            action={{ label: 'Ver novidades', href: '/novidades' }}
            secondaryAction={{ label: 'Ver o outlet', href: '/outlet' }}
          />
        )}
      </Container>
    </>
  );
}
