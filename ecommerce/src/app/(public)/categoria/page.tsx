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

/**
 * ISR DE VOLTA (06/09/2026) — ver o comentário longo em
 * `categoria/[slug]/page.tsx`. O caso desta página ("subi a foto da
 * categoria e ela não trocou", 10/08) hoje é coberto por evento: salvar
 * categoria, subir ou remover imagem na retaguarda dispara
 * `revalidateTag('categorias')` (`site-categorias.service.ts` →
 * `avisarVitrine`), que derruba exatamente o fetch abaixo. Os 60s são só a
 * rede de segurança.
 */
export const revalidate = 60;

export const metadata: Metadata = buildMetadata({
  title: 'Categorias — todas as peças do 44 ao 60',
  description:
    'Vestidos, blusas, calças, conjuntos e mais: navegue por categoria e encontre a peça certa pro seu corpo.',
  path: '/categoria',
  keywords: ['categorias plus size', 'vestidos plus size', 'blusas plus size', 'moda plus size'],
});

export default async function CategoriasPage() {
  // Categoria DESTACADA (estrela da retaguarda) vive como ABA própria no topo
  // do site — o card junto duplicava a entrada, e foi a queixa do dono em
  // 13/08 ("tire o Conforto daqui"). A estrela MOVE: dos cards pra barra.
  // Sem `fresco` (revalidate 0 derrubaria a rota pro dinâmico) — a foto nova
  // chega por evento, ver o bloco de comentário do `revalidate` acima.
  const categorias = (await getCategorias()).filter((c) => !c.destaque);

  return (
    <>
      {/* UM SÓ Section (dono 07/08): breadcrumb e título viviam em dois
          <Section> separados, e `space` aplica padding em CIMA e EMBAIXO —
          dois blocos empilhados somavam os dois paddings e abriam um vão
          enorme entre o breadcrumb e "Nossas categorias". */}
      <Section width="wide" space="lg" aria-labelledby="categorias-titulo">
        <Breadcrumb
          items={[
            { label: 'Início', href: '/' },
            { label: 'Categorias' },
          ]}
        />
        <SectionTitle
          className="mt-8"
          id="categorias-titulo"
          eyebrow="Encontre seu look ideal"
          title="Nossas categorias"
          description="Do 44 ao 60, em modelagens pensadas pro corpo real."
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
          // 5 por linha no desktop (dono 07/08) — 9 categorias viram 5+4.
          <div className="mt-12 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5 lg:gap-4">
            {categorias.map((c, index) => (
              <CategoriaCard
                key={c.slug}
                index={index}
                data={{
                  slug: c.slug, nome: c.nome, imagemUrl: c.imagemUrl, alt: c.alt,
                  focoX: c.focoX, focoY: c.focoY, focoZoom: c.focoZoom,
                }}
              />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
