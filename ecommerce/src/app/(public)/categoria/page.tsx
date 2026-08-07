import type { Metadata } from 'next';
import Link from 'next/link';
import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { CategoriaCard } from '@/components/cards/CategoriaCard';
import { getCategorias } from '@/services/categorias-menu';
import { buildMetadata } from '@/lib/seo';

/**
 * ÍNDICE DE CATEGORIAS — /categoria
 *
 * ⚠️ ESTA PÁGINA NÃO EXISTIA (07/08). "Categorias" é o segundo item do menu
 * principal e o destino do "Ver tudo em Categorias" do mega menu — os dois
 * caíam em "Página não encontrada". A cliente clicava no item mais óbvio do
 * menu e batia num 404.
 *
 * As categorias são as do CRM (só o que tem peça publicada) e a foto de cada
 * card é a da PEÇA MAIS NOVA daquela categoria: a vitrine se renova sozinha
 * conforme a loja cadastra, sem depender de alguém subir arte toda semana.
 */

export const revalidate = 3600;

export const metadata: Metadata = buildMetadata({
  title: 'Categorias — todas as peças do 46 ao 60',
  description:
    'Vestidos, blusas, calças, conjuntos e mais: navegue por categoria e encontre a peça certa pro seu corpo.',
  path: '/categoria',
  keywords: ['categorias plus size', 'vestidos plus size', 'blusas plus size', 'moda plus size'],
});

export default async function CategoriasPage() {
  const categorias = await getCategorias();

  return (
    <>
      <Section space="sm" width="wide">
        <Breadcrumb
          items={[
            { label: 'Início', href: '/' },
            { label: 'Categorias' },
          ]}
        />
      </Section>

      <Section width="wide" space="lg" aria-labelledby="categorias-titulo">
        <SectionTitle
          id="categorias-titulo"
          eyebrow="Encontre seu look ideal"
          title="Nossas categorias"
          description="Do 46 ao 60, em modelagens pensadas pro corpo real."
        />

        {categorias.length === 0 ? (
          /* Catálogo sem categoria classificada: texto honesto em vez de grade
             vazia — a cliente precisa saber pra onde ir. */
          <Container width="text" className="mt-12">
            <p className="text-center text-body text-ink-soft">
              Estamos organizando as categorias. Enquanto isso, veja{' '}
              <Link href="/novidades" className="link-underline text-ink">
                as novidades da semana
              </Link>
              .
            </p>
          </Container>
        ) : (
          <div className="mt-12 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6 lg:gap-4">
            {categorias.map((c, index) => (
              <CategoriaCard
                key={c.slug}
                index={index}
                data={{ slug: c.slug, nome: c.nome, imagemUrl: c.imagemUrl, alt: c.alt }}
              />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
