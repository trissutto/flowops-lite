import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { EditorialProductGrid } from '@/components/commerce/EditorialProductGrid';
import { EmptyState } from '@/components/feedback/EmptyState';
import { fetchColecao } from '@/services/colecoes';
import { breadcrumbSchema, buildMetadata, itemListSchema, jsonLdGraph } from '@/lib/seo';

/**
 * /colecao/<slug> — a página de UMA coleção pontual ("Coleção Resort").
 *
 * Irmã genérica da `/mais-top-da-semana` (dono, 26/08: a vaga de coleção do
 * menu deixou de ser fixa): a retaguarda cria a coleção, escolhe e ORDENA as
 * peças, e esta página renderiza os `itens` na ordem que o backend mandou —
 * sem filtro, sem scroll infinito, sem reordenação (curadoria não é catálogo).
 *
 * A "Mais Top da Semana" continua na rota histórica dela; chegar aqui pelo
 * slug dela redireciona (308) em vez de abrir a MESMA lista em duas URLs —
 * conteúdo duplicado é o Google escolhendo qual das duas rebaixar.
 */

/** 60 s — a mesma janela das outras vitrines (`REVALIDATE_VITRINE`). */
export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  // O mesmo fetch do corpo da página — o cache do Next dedupa, não paga dobrado.
  const colecao = await fetchColecao(slug);
  if (!colecao) {
    return buildMetadata({ title: 'Coleção', path: `/colecao/${slug}` });
  }
  return buildMetadata({
    title: colecao.nome,
    description:
      colecao.descricao ||
      `${colecao.nome} na Lurd’s Plus Size, do 46 ao 60 — peças escolhidas a dedo.`,
    path: `/colecao/${colecao.slug}`,
    keywords: [colecao.nome, `${colecao.nome} plus size`, 'coleção plus size'],
  });
}

export default async function ColecaoPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (slug === 'mais-top-da-semana') permanentRedirect('/mais-top-da-semana');

  const colecao = await fetchColecao(slug);
  if (!colecao) notFound();

  const trail = [
    { name: 'Início', path: '/' },
    { name: colecao.nome, path: `/colecao/${colecao.slug}` },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdGraph(
            breadcrumbSchema(trail),
            ...(colecao.produtos.length ? [itemListSchema(colecao.produtos, colecao.nome)] : []),
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
          eyebrow="Coleção"
          title={colecao.nome}
          description={
            colecao.descricao ||
            'Uma seleção especial, escolhida a dedo — do 46 ao 60.'
          }
          as="h1"
        />
      </Section>

      <Container width="wide">
        {colecao.produtos.length > 0 ? (
          <div className="py-12">
            {/* Ordem = a da curadoria; grade limpa, sem interrupções. */}
            <EditorialProductGrid products={colecao.produtos} />
          </div>
        ) : (
          <EmptyState
            icon={<Sparkles strokeWidth={1.5} />}
            title="Esta coleção está sendo preparada."
            description="As peças já já aparecem por aqui. Enquanto isso, veja o que acabou de chegar."
            action={{ label: 'Ver novidades', href: '/novidades' }}
            secondaryAction={{ label: 'Ver o outlet', href: '/outlet' }}
          />
        )}
      </Container>
    </>
  );
}
