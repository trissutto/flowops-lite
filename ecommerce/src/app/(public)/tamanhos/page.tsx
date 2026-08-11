import Link from 'next/link';
import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { SeletorTamanho } from '@/components/commerce/SeletorTamanho';
import { CategoryListing } from '@/components/commerce/CategoryListing';
import { fetchPrimeiraPagina } from '@/services/vitrine';
import { breadcrumbSchema, buildMetadata, jsonLdGraph } from '@/lib/seo';

/**
 * TAMANHOS — a régua da casa e a porta pra vitrine do número da cliente.
 *
 * ⚠️ A rota não existia: "Tamanhos" é o quarto item do menu e caía em 404,
 * junto com os oito números do mega menu. Pra loja plus size é o pior lugar
 * pra ter buraco — o número é a primeira pergunta da cliente.
 */

const NUMEROS = [44, 46, 48, 50, 52, 54, 56, 58, 60];

export const revalidate = 3600;

export const metadata = buildMetadata({
  title: 'Tamanhos — do 44 ao 60',
  description:
    'Escolha sua numeração e veja tudo que temos no seu tamanho. Do 44 ao 60, com guia de medidas.',
  path: '/tamanhos',
  keywords: ['tamanhos plus size', 'numeração plus size', 'roupa 44 ao 60'],
});

const trail = [
  { name: 'Início', path: '/' },
  { name: 'Tamanhos', path: '/tamanhos' },
];

export default async function TamanhosPage() {
  const primeiraPagina = await fetchPrimeiraPagina({ perPage: 24, ordenar: 'novidades' });

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
          eyebrow="Do 44 ao 60"
          title="Escolha sua numeração"
          description="Clique no seu número e veja só o que está disponível pra você."
          as="h1"
        />
      </Section>

      <Section width="wide" space="sm">
        <SeletorTamanho numeros={NUMEROS} />
        <p className="mt-5 text-small text-ink-soft">
          Em dúvida entre dois tamanhos?{' '}
          <Link href="/tamanhos/guia" className="link-underline text-ink">
            Veja o guia de medidas
          </Link>
          .
        </p>
      </Section>

      <Container width="wide">
        <CategoryListing
          category=""
          categoryName="Todas as peças"
          ordemPadrao="novidades"
          primeiraPagina={primeiraPagina}
        />
      </Container>
    </>
  );
}
