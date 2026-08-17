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
 * SÃO 50 PEÇAS, sempre as 50 mais novas (decisão do dono, 06/08). A página
 * mostrava 525 — o catálogo inteiro reordenado por data — e a 500ª tinha meses
 * de loja. Novidade que dura o ano inteiro não é novidade: vira só mais uma
 * listagem, e a cliente que volta toda semana não percebe o que mudou.
 */

/**
 * 60 s (era 3600). Card de listagem carrega estoque, e uma hora de defasagem
 * é uma hora oferecendo peça que a loja física já vendeu. Mesmo TTL do cache
 * de catálogo do backend — ver `REVALIDATE_VITRINE` em `services/vitrine.ts`.
 */
export const revalidate = 60;

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
        <CategoryListing
          category=""
          categoryName="Novidades"
          ordemPadrao="novidades"
          limiteTotal={50}
          soNovidade
        />
      </Container>
    </>
  );
}
