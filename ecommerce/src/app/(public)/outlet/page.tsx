import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { CategoryListing } from '@/components/commerce/CategoryListing';
import { fetchPrimeiraPagina } from '@/services/vitrine';
import { breadcrumbSchema, buildMetadata, jsonLdGraph } from '@/lib/seo';

/**
 * OUTLET — tudo que está com desconto (dono 07/08).
 *
 * ⚠️ A rota NÃO EXISTIA: "Outlet" é o sexto item do menu principal e caía em
 * 404 — medido em produção (15ms, zero produto). Junto com `/categoria`, era
 * o segundo item de menu quebrado do site.
 *
 * O CRITÉRIO MUDOU EM 15/08: entra quem tem DESCONTO DE VERDADE, não quem tem
 * a marquinha de promoção. A marca vinha do `on_sale` do WooCommerce e o preço
 * promocional não veio junto — medido em produção: **49 peças aqui e 1 com
 * "de/por"**. O preço sai da mesma campanha que o caixa aplica na loja — até
 * 15/09/2026 os 50% do "liquida antigos", desde então a campanha por termo da
 * retaguarda (hoje "Inverno 30%", `backend/src/common/promo-por-termo.ts`) —
 * mais o "de/por" de quando a loja baixa o preço.
 *
 * ⚠️ A cópia desta página NÃO fala em porcentagem: o % é da campanha, que a
 * matriz troca sem deploy. Com o "Até 50% OFF" antigo, a troca pro inverno
 * 30% deixaria a página anunciando um desconto que não existe mais.
 *
 * Não é vitrine por faixa de preço: outlet é a peça que a loja baixou, não a
 * peça barata. Preço teto já existe em `/ate/59-90` e `/ate/99-90`.
 *
 * A página 1 vem pronta do servidor — sem isso a cliente olha esqueleto
 * enquanto o navegador baixa o JS e faz duas viagens à API.
 */

/** 60 s (era 3600) — ver `REVALIDATE_VITRINE` em `services/vitrine.ts`. */
export const revalidate = 60;

export const metadata = buildMetadata({
  title: 'Outlet — peças com desconto',
  description:
    'Peças com desconto na Lurd’s Plus Size, do 44 ao 60 — o mesmo preço do caixa das lojas. Enquanto durar o estoque.',
  path: '/outlet',
  keywords: ['outlet plus size', 'promoção plus size', 'desconto plus size', 'desconto roupa plus size'],
});

const trail = [
  { name: 'Início', path: '/' },
  { name: 'Outlet', path: '/outlet' },
];

export default async function OutletPage() {
  const primeiraPagina = await fetchPrimeiraPagina({ soPromocao: true, perPage: 24 });

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
          eyebrow="Enquanto durar o estoque"
          title="Outlet"
          description="Peças com desconto, do 44 ao 60 — o mesmo preço que vale no caixa das lojas. O que sai daqui não volta pelo mesmo preço."
          as="h1"
        />
      </Section>

      <Container width="wide">
        <CategoryListing
          category=""
          categoryName="Outlet"
          soPromocao
          primeiraPagina={primeiraPagina}
        />
      </Container>
    </>
  );
}
