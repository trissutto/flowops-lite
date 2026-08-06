import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { CategoryListing } from '@/components/commerce/CategoryListing';
import { breadcrumbSchema, buildMetadata, jsonLdGraph } from '@/lib/seo';

/**
 * NOVIDADES — a rota que TODO CTA do site já apontava e que não existia.
 *
 * Achado em 06/08: `/novidades` era linkada em oito lugares — sacola vazia,
 * mini-carrinho, busca sem resultado, lista de desejos, home, checkout — e
 * **todas caíam em 404**. É o pior 404 possível: acontece exatamente quando a
 * cliente não achou o que queria e a gente ofereceu uma saída.
 *
 * Ordena por NOVIDADES em vez de filtrar pela flag `lancamento`: a flag
 * depende de alguém marcar peça por peça, e vitrine de novidades vazia por
 * falta de cadastro é pior do que não ter a página. Ordenando, ela sempre tem
 * conteúdo e ainda assim mostra o que entrou por último.
 *
 * Sem categoria fixa — é o catálogo inteiro, do mais novo pro mais antigo.
 */

export const revalidate = 3600;

export const metadata = buildMetadata({
  title: 'Novidades',
  description:
    'As peças que acabaram de chegar na Lurd’s Plus Size, do 46 ao 60. Atualizamos toda semana.',
  path: '/novidades',
  keywords: ['novidades plus size', 'lançamentos plus size', 'roupa plus size nova'],
});

const trail = [
  { name: 'Início', path: '/' },
  { name: 'Novidades', path: '/novidades' },
];

export default function NovidadesPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdGraph(breadcrumbSchema(trail)) }}
      />

      <Section width="text" space="sm">
        <Breadcrumb
          items={trail.map((item, i) => ({
            label: item.name,
            href: i < trail.length - 1 ? item.path : undefined,
          }))}
        />
        <SectionTitle
          eyebrow="Acabou de chegar"
          title="Novidades"
          description="O que entrou por último na loja, do 46 ao 60. Atualizamos toda semana."
          as="h1"
        />
      </Section>

      <Container width="wide">
        <CategoryListing category="" categoryName="Novidades" ordemPadrao="novidades" />
      </Container>
    </>
  );
}
