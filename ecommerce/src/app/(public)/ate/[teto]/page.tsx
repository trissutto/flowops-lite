import { notFound } from 'next/navigation';
import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { CategoryListing } from '@/components/commerce/CategoryListing';
import { breadcrumbSchema, buildMetadata, jsonLdGraph } from '@/lib/seo';

/**
 * VITRINES POR FAIXA DE PREÇO — "Até R$ 59,90" e "Até R$ 99,90".
 *
 * Pedido do dono em 06/08. Preço é o primeiro corte que a cliente faz na
 * cabeça antes de olhar peça, e no plus size ele é o argumento mais forte que
 * a Lurd's tem: a concorrência cobra caro porque "é tamanho grande".
 *
 * Uma rota só, com whitelist: faixa que não está em `FAIXAS` cai em 404 em vez
 * de virar uma vitrine vazia em `/ate/qualquer-coisa` — que o Google
 * indexaria.
 *
 * O teto NÃO é um filtro (ver `ProductQuery.tetoDePreco`): filtro a cliente
 * limpa, e "Até R$ 59,90" mostrando peça de R$ 400 quebra a única promessa
 * que a página faz.
 */

/** 60 s (era 3600) — ver `REVALIDATE_VITRINE` em `services/vitrine.ts`. */
export const revalidate = 60;

interface Faixa {
  teto: number;
  rotulo: string;
  titulo: string;
  descricao: string;
  chamada: string;
}

const FAIXAS: Record<string, Faixa> = {
  '59-90': {
    teto: 59.9,
    rotulo: 'Até R$ 59,90',
    titulo: 'Tudo até R$ 59,90',
    descricao:
      'Peças do 44 ao 60 por até R$ 59,90 — o preço que a gente pratica na loja, sem taxa de tamanho grande.',
    chamada: 'Preço fechado',
  },
  '99-90': {
    teto: 99.9,
    rotulo: 'Até R$ 99,90',
    titulo: 'Tudo até R$ 99,90',
    descricao:
      'Do 44 ao 60 por até R$ 99,90 — inclusive as peças que acabaram de chegar.',
    chamada: 'Preço fechado',
  },
};

export function generateStaticParams() {
  return Object.keys(FAIXAS).map((teto) => ({ teto }));
}

export async function generateMetadata({ params }: { params: Promise<{ teto: string }> }) {
  const { teto } = await params;
  const faixa = FAIXAS[teto];
  if (!faixa) return buildMetadata({ title: 'Faixa não encontrada', path: `/ate/${teto}` });

  return buildMetadata({
    title: faixa.titulo,
    description: faixa.descricao,
    path: `/ate/${teto}`,
    keywords: [
      `roupa plus size ${faixa.rotulo.toLowerCase()}`,
      'roupa plus size barata',
      'plus size do 44 ao 60',
    ],
  });
}

export default async function FaixaDePrecoPage({
  params,
}: {
  params: Promise<{ teto: string }>;
}) {
  const { teto } = await params;
  const faixa = FAIXAS[teto];
  if (!faixa) notFound();

  const trail = [
    { name: 'Início', path: '/' },
    { name: faixa.rotulo, path: `/ate/${teto}` },
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
          eyebrow={faixa.chamada}
          title={faixa.titulo}
          description={faixa.descricao}
          as="h1"
        />
      </Section>

      <Container width="wide">
        <CategoryListing
          category=""
          categoryName={faixa.rotulo}
          tetoDePreco={faixa.teto}
          ordemPadrao="novidades"
        />
      </Container>
    </>
  );
}
