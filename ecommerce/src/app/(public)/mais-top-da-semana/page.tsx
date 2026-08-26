import type { Metadata } from 'next';
import { Sparkles } from 'lucide-react';
import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { EditorialProductGrid } from '@/components/commerce/EditorialProductGrid';
import { EmptyState } from '@/components/feedback/EmptyState';
import { fetchMaisTopDaSemana } from '@/services/vitrine';
import { fetchColecao } from '@/services/colecoes';
import { breadcrumbSchema, buildMetadata, itemListSchema, jsonLdGraph } from '@/lib/seo';

/**
 * MAIS TOP DA SEMANA — a vitrine CURADA fixa do site.
 *
 * Diferente de `/novidades` e `/outlet`, esta lista NÃO é o catálogo
 * reordenado: é uma seleção curta escolhida e ORDENADA na retaguarda
 * (o mesmo dado que marca o selo `topSemana` no feed). Por isso não tem filtro,
 * scroll infinito nem reordenação — renderiza os `itens` na ordem que o backend
 * mandou, com o mesmo card da vitrine (`EditorialProductGrid` → `ProductCard`).
 *
 * O TÍTULO deixou de ser fixo (26/08): o dono renomeia a coleção na tela
 * /retaguarda/colecoes ("Resort" com as peças da JOIN da semana) e o menu
 * mostra o nome novo — a página tem que dizer a MESMA coisa, senão a cliente
 * clica em "Resort" e cai numa página chamada "Mais Top da Semana". A rota
 * continua a histórica (16 meses de Google); só o texto acompanha o cadastro.
 * Backend fora do ar → os textos clássicos e a lista da curadoria, como antes.
 */

/** 60 s — mesma janela das outras vitrines (ver `REVALIDATE_VITRINE`). */
export const revalidate = 60;

const NOME_PADRAO = 'Mais Top da Semana';
const DESCRICAO_PADRAO =
  'As peças mais desejadas, escolhidas a dedo — do 46 ao 60. Atualizamos toda semana.';

export async function generateMetadata(): Promise<Metadata> {
  const colecao = await fetchColecao('mais-top-da-semana');
  const nome = colecao?.nome || NOME_PADRAO;
  return buildMetadata({
    title: nome,
    description:
      colecao?.descricao ||
      `A seleção da Lurd’s Plus Size, do 46 ao 60 — as peças mais desejadas, escolhidas a dedo.`,
    path: '/mais-top-da-semana',
    keywords: [nome, 'destaques plus size', 'seleção da semana plus size'],
  });
}

export default async function MaisTopDaSemanaPage() {
  const colecao = await fetchColecao('mais-top-da-semana');
  // Backend mudo → o caminho antigo segue de pé (título clássico + curadoria).
  const nome = colecao?.nome || NOME_PADRAO;
  const descricao = colecao?.descricao || DESCRICAO_PADRAO;
  const produtos = colecao?.produtos ?? (await fetchMaisTopDaSemana());

  const trail = [
    { name: 'Início', path: '/' },
    { name: nome, path: '/mais-top-da-semana' },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdGraph(
            breadcrumbSchema(trail),
            ...(produtos.length ? [itemListSchema(produtos, nome)] : []),
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
          title={nome}
          description={descricao}
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
