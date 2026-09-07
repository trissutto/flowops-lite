import type { Metadata } from 'next';
import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { CategoryListing } from '@/components/commerce/CategoryListing';
import { ChipsSubcategoria } from '@/components/commerce/ChipsSubcategoria';
import { InstagramCard } from '@/components/cards/InstagramCard';
import { NewsletterBlock } from '@/components/sections/NewsletterBlock';
import { CATEGORY_SLUGS, categoryMeta } from '@/services/products';
import { fetchPrimeiraPagina } from '@/services/vitrine';
import { getCategorias } from '@/services/categorias-menu';
import { getInstagram } from '@/services/instagram';
import { breadcrumbSchema, buildMetadata, jsonLdGraph } from '@/lib/seo';

/**
 * PÁGINA DE CATEGORIA
 *
 * Server Component: cabeçalho, conteúdo educativo e SEO são estáticos
 * (indexáveis, rápidos); só a listagem é client (filtros e infinite scroll).
 *
 * ⚠️ SEM HERO E SEM INTERRUPÇÃO NA GRADE (dono 07/08): "retire estes banners
 * dentro das categorias, quanto mais direto for pro produto, melhor a
 * conversão". Antes a peça só aparecia depois de um hero em tela cheia +
 * texto de introdução, e a grade de produto era cortada a cada ~8 peças por
 * um card editorial, um look ou um banner de loja — três desvios do caminho
 * "entrou → viu produto → comprou". Cabeçalho agora é uma linha (breadcrumb +
 * título), e a grade não tem mais interrupção nenhuma.
 *
 * ISR DE VOLTA (06/09/2026) — mas agora com a invalidação que faltava.
 *
 * O "elimine este cache" do dono (10/08) era o sintoma de outra coisa: o ISR
 * de 1h NÃO CAÍA quando ele classificava uma peça, porque o aviso
 * retaguarda→site dependia de uma env (`REVALIDATE_SECRET`) que nunca foi
 * criada. Desde 13/08 o aviso cai no `LOJA_ORDER_TOKEN` (que o checkout já
 * usa — se o site vende, o aviso funciona; conferido em produção em 06/09:
 * `GET /api/revalidar` → `configurado: true`), e a classificação dispara
 * `categoria:<slug>` — inclusive da categoria que a peça DEIXOU.
 *
 * Então o trato agora é: classificou → o backend derruba a tag → a página
 * regenera na próxima visita. Os 60s são só a rede de segurança (o MESMO TTL
 * do cache do catálogo no backend), e a cliente ganha a página da CDN em vez
 * de pagar um SSR de ~550ms por visita — era isto que mantinha a categoria
 * fora do ar a cada deploy do Railway e alimentava o INP ruim do celular.
 *
 * ⚠️ Pra rota ficar cacheável ela NÃO PODE ler `searchParams`: o `?sub=` do
 * chip é lido no NAVEGADOR (store `subcategoria`) — o servidor entrega sempre
 * a categoria inteira, e o recorte acontece no client. Ver `ChipsSubcategoria`
 * e `store/subcategoria.ts`.
 */

export const revalidate = 60;

/**
 * Prerenderiza as categorias conhecidas no build/deploy — a primeira visita
 * depois do deploy já sai da CDN. Categoria nova (campanha, ex.:
 * linha-conforto) não está na lista e funciona igual: o primeiro acesso gera
 * e as seguintes reaproveitam (`dynamicParams` é o padrão).
 */
export async function generateStaticParams() {
  return CATEGORY_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const meta = categoryMeta(slug);

  return buildMetadata({
    title: meta.title,
    description: meta.intro,
    path: `/categoria/${slug}`,
    /**
     * A imagem do card compartilhado era uma foto de banco de imagem
     * (`meta.heroImage`, hoje `null`) — saiu em 16/08 com o resto do stock.
     * Sem foto oficial por categoria, vale a OG padrão do site.
     */
    ...(meta.heroImage ? { image: `${meta.heroImage}?q=80&w=1200&auto=format&fit=crop` } : {}),
    keywords: [meta.title, `${meta.name} plus size`, `${meta.name} 44 ao 60`, 'moda plus size'],
  });
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  /**
   * ⚠️ NADA de `searchParams` aqui — é o que mantém a rota no ISR. O
   * `?sub=manga-curta` do chip é lido no navegador (store `subcategoria`) e o
   * recorte acontece no `CategoryListing`, via react-query. O HTML do servidor
   * é sempre a categoria inteira: é ele que o Google indexa e que pinta o LCP;
   * quem chega por link com `?sub=` vê o recorte aplicar na hidratação.
   */
  const meta = categoryMeta(slug);
  // NOVIDADES é a ordem padrão de toda categoria (dono 07/08): a cliente que
  // volta toda semana precisa ver o que ENTROU, não a mesma vitrine de sempre.
  // ⚠️ Tem que casar com o `ordemPadrao` do CategoryListing abaixo — se as duas
  // divergirem, a página 1 vinda do servidor (ordenada aqui) seria exibida como
  // se fosse a ordem do cliente, e a cliente veria uma lista que não pediu.
  const primeiraPagina = await fetchPrimeiraPagina({
    categoria: slug,
    perPage: 24,
    ordenar: 'novidades',
  });

  /**
   * SUBCATEGORIAS desta categoria — "Blusas" → "Manga curta".
   *
   * O `fresco: true` (revalidate 0) saiu em 06/09: um único fetch `no-store`
   * derruba a rota inteira de volta pro dinâmico. O "classificou → o chip
   * aparece" que ele garantia agora vem por evento: a classificação dispara
   * `revalidateTag('categorias')`, que derruba exatamente este fetch.
   */
  const subcategorias =
    (await getCategorias()).find((c) => c.slug === slug)?.subcategorias ?? [];

  /**
   * OS POSTS REAIS da @lurdsplussize ("insta saiu de novo", dono 13/08 —
   * na verdade esta página NUNCA teve: ela renderizava a grade estática de
   * `data/content` enquanto só a home tinha sido ligada no feed de verdade).
   * `getInstagram` já cai na estática sozinho se a integração falhar.
   */
  const postsInstagram = await getInstagram(6);

  const trail = [
    { name: 'Início', path: '/' },
    { name: 'Categorias', path: '/categoria' },
    { name: meta.name, path: `/categoria/${slug}` },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdGraph(breadcrumbSchema(trail)) }}
      />

      {/* 01 — CABEÇALHO ENXUTO (sem hero de tela cheia — direto pro produto) */}
      <Section width="wide" space="sm">
        <Breadcrumb
          items={trail.map((item, i) => ({
            label: item.name,
            href: i < trail.length - 1 ? item.path : undefined,
          }))}
        />
        <SectionTitle eyebrow={`${meta.name} do 44 ao 60`} title={meta.title} as="h1" />
        {/* Primeira coisa depois do título: é o recorte mais previsível da
            página — ver `ChipsSubcategoria`. */}
        <ChipsSubcategoria subcategorias={subcategorias} className="mt-6 justify-center" />
      </Section>

      {/* 02 — BARRA + FILTROS + GRID, SEM INTERRUPÇÃO NENHUMA */}
      <Container width="wide">
        <CategoryListing
          category={slug}
          categoryName={meta.name}
          /* O `?sub=` vem do store no client — nada de searchParams (ISR). */
          usarSubDaUrl
          /* Mesma ordem do `fetchPrimeiraPagina` acima — ver comentário lá. */
          ordemPadrao="novidades"
          /* Página 1 pronta no servidor: a peça vem no HTML em vez de esperar
             o JS + duas viagens à API (perf, 07/08). */
          primeiraPagina={primeiraPagina}
        />
      </Container>

      {/* 03 — CONTEÚDO EDUCATIVO (SEO + permanência) — só DEPOIS da grade
          inteira, nunca interrompendo o caminho até o produto. */}
      <Section tone="alt" width="text" aria-labelledby="guia-titulo">
        <SectionTitle
          id="guia-titulo"
          eyebrow="Guia Lurds"
          title={meta.guide.title}
          align="left"
          hideRule
        />
        <div className="mt-8 flex flex-col gap-5">
          {meta.guide.paragraphs.map((paragraph) => (
            <p key={paragraph.slice(0, 24)} className="text-body-lg font-light text-ink-soft">
              {paragraph}
            </p>
          ))}
        </div>

        {/* OS DOIS CARDS EDITORIAIS SAÍRAM EM 16/08/2026 — foto de banco de
            imagem levando a `/blog/<slug>`, blog que nunca existiu. Já tinham
            saído da home em 10/08 pelo mesmo motivo; aqui haviam ficado. O
            guia acima é o conteúdo de verdade da seção. */}
      </Section>

      {/* 10 — INSTAGRAM — só com post REAL (ver home e `services/instagram`) */}
      {postsInstagram.length > 0 && (
        <Section width="wide" aria-labelledby="ig-categoria">
          <SectionTitle
            id="ig-categoria"
            eyebrow="@lurdsplussize"
            title={`${meta.name} nas clientes reais`}
            cta={{ label: 'Ver no Instagram', href: 'https://www.instagram.com/lurdsplussize' }}
            align="left"
          />
          <div className="mt-14 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {postsInstagram.map((post) => (
              <InstagramCard key={post.id} post={post} />
            ))}
          </div>
        </Section>
      )}

      {/* 11 — NEWSLETTER */}
      <NewsletterBlock
        tone="champagne"
        title={
          <>
            Avise quando chegar
            <br />
            <span className="italic">{meta.name.toLowerCase()} novo</span>
          </>
        }
        description={`Uma mensagem por semana com as novidades de ${meta.name.toLowerCase()} e o que entrou na loja mais perto de você.`}
      />

      {/* A FAIXA INSTITUCIONAL DE FECHAMENTO SAIU EM 16/08/2026.
          Era uma foto de banco de imagem em 21:9 legendada "Interior de uma
          loja Lurds Plus Size" — a mesma foto de loja MASCULINA de streetwear
          que tirou o vídeo institucional da home em 10/08. Existia só pra
          evitar o corte seco pro rodapé; o `NewsletterBlock` em champagne
          acima já faz esse fecho. Volta com foto REAL de uma das 14 lojas. */}
    </>
  );
}
