import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { CategoryListing } from '@/components/commerce/CategoryListing';
import { SeletorTamanho } from '@/components/commerce/SeletorTamanho';
import { breadcrumbSchema, buildMetadata, jsonLdGraph } from '@/lib/seo';

/**
 * VITRINE POR TAMANHO — /tamanhos/52
 *
 * ⚠️ NÃO EXISTIA: o mega menu "Tamanhos" lista 46…60 e todos os oito números
 * caíam em 404. Era o terceiro item de menu quebrado do site (junto com
 * /categoria e /outlet), e o mais caro: a cliente plus size procura pelo
 * NÚMERO dela antes de qualquer outra coisa.
 *
 * O filtro é o mesmo da barra lateral (`numerosDaGrade` no backend), então
 * peça marcada "46/48" aparece tanto no 46 quanto no 48 — o que ela veste.
 */

const NUMEROS = [44, 46, 48, 50, 52, 54, 56, 58, 60];

export const revalidate = 3600;

export function generateStaticParams() {
  return NUMEROS.map((n) => ({ numero: String(n) }));
}

export async function generateMetadata({
  params,
}: { params: Promise<{ numero: string }> }): Promise<Metadata> {
  const { numero } = await params;
  return buildMetadata({
    title: `Tamanho ${numero} — moda plus size`,
    description: `Todas as peças disponíveis no tamanho ${numero} na Lurd’s Plus Size.`,
    path: `/tamanhos/${numero}`,
    keywords: [`roupa tamanho ${numero}`, `plus size ${numero}`, 'moda plus size'],
  });
}

export default async function TamanhoPage({
  params,
}: { params: Promise<{ numero: string }> }) {
  const { numero } = await params;
  const n = Number(numero);
  if (!NUMEROS.includes(n)) notFound();

  const trail = [
    { name: 'Início', path: '/' },
    { name: 'Tamanhos', path: '/tamanhos' },
    { name: `Tamanho ${n}`, path: `/tamanhos/${n}` },
  ];

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
          title={`Tudo no tamanho ${n}`}
          description="Só o que está disponível no seu número. Use o filtro de categoria pra ver só blusas, vestidos ou calças."
          as="h1"
        />
      </Section>

      <Section width="wide" space="sm">
        <SeletorTamanho atual={n} numeros={NUMEROS} />
      </Section>

      <Container width="wide">
        {/* `category=""` de propósito: esta listagem não é de uma categoria, é
            de um NÚMERO. É isso que faz a barra lateral mostrar o filtro de
            categoria (ver `filterGroups`) — a cliente já disse o tamanho dela,
            e o recorte que falta é o tipo de peça.
            Ordem por novidades: quem entra pelo número quer ver o que chegou
            que serve nela, não o catálogo inteiro em ordem de curadoria. */}
        <CategoryListing
          category=""
          categoryName={`Tamanho ${n}`}
          ordemPadrao="novidades"
          filtrosIniciais={{ tamanho: [String(n)] }}
        />
      </Container>
    </>
  );
}
