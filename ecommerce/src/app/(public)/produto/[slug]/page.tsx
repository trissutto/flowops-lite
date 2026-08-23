import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Container } from '@/components/layout/Container';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { Accordion, AccordionItem } from '@/components/ui/Accordion';
import { ProductGallery } from '@/components/commerce/ProductGallery';
import { BuyBox } from '@/components/commerce/BuyBox';
import { ProductPageSignals } from '@/components/commerce/ProductPageSignals';
import { DescricaoDaPeca } from '@/components/commerce/DescricaoDaPeca';
import { DescobrirFeed } from '@/components/commerce/DescobrirFeed';
import { AvaliacoesDaPeca } from '@/components/commerce/AvaliacoesDaPeca';
import { CompleteOLook } from '@/components/commerce/CompleteOLook';
import { NewsletterBlock } from '@/components/sections/NewsletterBlock';
import { getProduct } from '@/services/catalog';
import { fetchPeca } from '@/services/peca';
import { fetchIrmasDaPeca } from '@/services/vitrine';
import { EscolhaDaPeca } from '@/components/commerce/EscolhaDaPeca';
import { breadcrumbSchema, buildMetadata, jsonLdGraph, productSchema } from '@/lib/seo';
import { STORE_POLICIES } from '@/data/store-policies';
import { ProductVisualEditor } from '@/components/editor/ProductVisualEditor';

/**
 * PÁGINA DE PRODUTO — dados REAIS do catálogo (backend → WooCommerce).
 *
 * Server Component: preço, estoque, fotos e SEO renderizam no servidor.
 * Só a galeria e a buy box são client (precisam de estado).
 *
 * SEM ISR de propósito: o fetch da peça é `no-store` (ver services/peca.ts),
 * porque estoque servido do cache stale deixou tamanho esgotado comprável por
 * horas (caso VOGUE VINHO 06/08). A rota é dinâmica; o dado do catálogo sai
 * do Postgres local do backend, que aguenta uma query por visita.
 */

/** Catálogo tem milhares de SKUs — geração sob demanda, sem pré-render. */
export const dynamicParams = true;

/**
 * A COR QUE O LINK PEDIU (`?cor=`) — validada contra as cores À VENDA (20/08).
 *
 * A PDP abre ancorada nela: galeria, grade e preço daquela cor, e o BuyBox
 * confirma em vez de pedir escolha. Tolerante a acento e caixa porque o valor
 * viaja por anúncio, WhatsApp e digitação — "Poá Marrom", "POA MARROM" e
 * "poá marrom" são a mesma cor. Cor que não existe (esgotou, saiu do piso,
 * link velho) devolve null e a página abre na heurística de sempre — link
 * quebrado NUNCA pode quebrar a peça.
 */
function achaCorDaUrl<T extends { nome: string; nomeAmigavel?: string | null }>(
  cores: T[],
  cor?: string,
): T | null {
  if (!cor?.trim()) return null;
  const norm = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
  const alvo = norm(cor);
  return (
    cores.find(
      (c) => norm(c.nome) === alvo || (c.nomeAmigavel && norm(c.nomeAmigavel) === alvo),
    ) ?? null
  );
}

/**
 * DINÂMICA DE VERDADE (dono, 14/08/2026). A intenção sempre foi no-store (o
 * fetch da peça é `revalidate: 0`), MAS sem isto o Vercel guardava o HTML da
 * PÁGINA no Full Route Cache e servia preço/estoque velhos: setei o VLM-222
 * pra R$ 139,90, a API já devolvia 139,90 e a página seguia mostrando 189,90
 * (o render cacheado de antes). Preço e estoque de peça plus size mudam e
 * TÊM que aparecer na hora — força SSR a cada visita, sem route cache.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ cor?: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const { cor } = await searchParams;
  // Mesma ordem de fontes da página — título e OG têm que descrever o que a
  // cliente vai ver, não o que o catálogo antigo tinha.
  const peca = await fetchPeca(slug);
  const result = peca ?? (await getProduct(slug));

  if (!result) {
    return buildMetadata({ title: 'Produto não encontrado', path: `/produto/${slug}`, noIndex: true });
  }

  const { product } = result;
  const shortDescription =
    'descricaoCurta' in result ? result.descricaoCurta : result.shortDescription;

  /**
   * LINK COM COR: título e FOTO da variação (20/08). É o que faz a prévia do
   * WhatsApp mostrar a peça na cor da conversa — antes toda cor compartilhava
   * a capa da primeira. O `path` continua SEM a cor de propósito: o canônico
   * é um só por peça, e as URLs `?cor=` não competem entre si no Google.
   */
  const corDaUrl = peca ? achaCorDaUrl(peca.cores, cor) : null;
  const corLabel = corDaUrl ? corDaUrl.nomeAmigavel || corDaUrl.nome : null;

  return buildMetadata({
    title: corLabel ? `${product.name} — ${corLabel}` : product.name,
    description:
      shortDescription ||
      `${product.name} — moda plus size do 44 ao 60 na Lurd's. Caimento que valoriza, tecido que abraça.`,
    path: `/produto/${product.slug}`,
    image: corDaUrl?.fotos?.[0]?.src ?? product.images[0]?.src,
    keywords: [product.name, `${product.name} plus size`, product.fabric ?? '', 'plus size 44 ao 60'].filter(
      Boolean,
    ),
  });
}

export default async function ProductPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ editar?: string; cor?: string }> }) {
  const { slug } = await params;
  const { editar, cor } = await searchParams;

  // CATÁLOGO NOVO primeiro (ficha do CRM: cor com foto, grade e preço por
  // cor). A vitrine antiga do WooCommerce fica como rede enquanto a migração
  // de conteúdo não termina.
  const peca = await fetchPeca(slug);
  const result = peca ?? (await getProduct(slug));

  // Produto inexistente OU catálogo fora do ar: 404 é melhor que página quebrada.
  if (!result) notFound();

  const { product } = result;
  const description = 'descricao' in result ? result.descricao : result.description;
  const shortDescription =
    'descricaoCurta' in result ? result.descricaoCurta : result.shortDescription;
  const cores = peca?.cores ?? [];

  const categoryLabel = product.category
    .replace(/-/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

  /**
   * AS IRMÃS DA PEÇA (dono, 21/08) — a faixa que fica abaixo do botão de
   * compra. Buscada AQUI, no servidor: a PDP é a página mais visitada do
   * site e não podia ganhar mais uma chamada saindo do navegador. Catálogo
   * fora do ar devolve lista vazia e o bloco simplesmente não aparece.
   */
  const irmas = await fetchIrmasDaPeca({
    excluirId: product.id,
    categoria: product.category,
    subcategoria: product.subcategory,
    limite: 6,
  });

  const trail = [
    { name: 'Início', path: '/' },
    { name: categoryLabel, path: `/categoria/${product.category}` },
    { name: product.name, path: `/produto/${product.slug}` },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdGraph(productSchema(product), breadcrumbSchema(trail)),
        }}
      />

      {/* Caminho de migalhas encostado na foto no celular (dono, 15/08):
          `pt-8 pb-4` são 48px de ar entre o menu e a peça numa tela de 812px.
          O desktop mantém o respiro original. Em 22/08 apertou de novo
          (`pt-2 pb-1`): 44px de bloco viraram 32 e a trilha continua legível
          — no celular ela já mostra só "Início › Categoria". */}
      <Container width="wide" className="pt-2 pb-1 sm:pt-8 sm:pb-4">
        <Breadcrumb
          colapsarNoMobile
          items={trail.map((item, i) => ({
            label: item.name,
            href: i < trail.length - 1 ? item.path : undefined,
          }))}
        />
      </Container>

      {/* Galeria + decisão de compra */}
      <Container width="wide" className="pb-16">
        {cores.length > 0 ? (
          <EscolhaDaPeca
            product={product}
            cores={cores}
            look={peca?.look ?? null}
            corInicial={achaCorDaUrl(cores, cor)?.nome ?? null}
            irmas={irmas}
            irmasHref={`/categoria/${product.category}`}
            irmasLabel={`Ver tudo em ${categoryLabel}`}
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
            <div className="min-w-0">
              <ProductGallery images={product.images} name={product.name} badges={product.badges} />
            </div>
            <div className="min-w-0 lg:sticky lg:top-28 lg:self-start">
              {/* Peça de COR ÚNICA — é aqui que a faixa mais faz falta: sem
                  grade de cores, a coluna terminava no botão. */}
              <BuyBox
                product={product}
                irmas={irmas}
                irmasHref={`/categoria/${product.category}`}
                irmasLabel={`Ver tudo em ${categoryLabel}`}
              />
            </div>
          </div>
        )}
      </Container>

      {/* Detalhes */}
      <Section tone="alt" width="page" space="sm" aria-labelledby="detalhes-titulo">
        <SectionTitle
          id="detalhes-titulo"
          eyebrow="Sobre a peça"
          title="Detalhes e composição"
          align="left"
          hideRule
        />
        <div className="mt-8 grid gap-10 lg:grid-cols-2 lg:gap-16">
          {/* 4 linhas e "Ver mais": a descrição da ficha passa de 40 linhas na
              peça bem cadastrada e empurrava tamanhos, entrega e trocas pro
              fim da página. A ficha técnica é o que a IA extraiu desse mesmo
              texto — é ela que responde "estica? tem forro? é transparente?". */}
          <DescricaoDaPeca
            resumo={shortDescription}
            texto={description}
            fichaTecnica={peca?.fichaTecnica ?? []}
          />

          <Accordion>
            <AccordionItem title="Tamanhos disponíveis" defaultOpen>
              <p className="text-body font-light text-ink-soft">
                Do 44 ao 60.{' '}
                {product.sizes.filter((s) => s.available).length > 0
                  ? `Disponível agora nos tamanhos ${product.sizes
                      .filter((s) => s.available)
                      .map((s) => s.label)
                      .join(', ')}.`
                  : 'Esgotado no site — consulte as lojas.'}
              </p>
            </AccordionItem>
            <AccordionItem title="Entrega e retirada">
              {/* ⚠️ Dizia "Frete grátis acima de R$ 399" — número chumbado que
                  ficou errado no dia em que a régua virou config (hoje R$
                  499,90, editável na retaguarda). Prometer valor errado aqui é
                  pior que não prometer: o simulador logo acima já mostra o
                  frete REAL pro CEP dela, com a régua vigente. */}
              <p className="text-body font-light text-ink-soft">
                Calcule o frete e o prazo pelo seu CEP na caixa acima. Você também pode
                reservar e provar em uma das 14 lojas antes de levar — se não vestir, não
                leva e não paga nada.
              </p>
            </AccordionItem>
            <AccordionItem title="Trocas e devoluções">
              {/* O número vem de `STORE_POLICIES`: escrito à mão aqui, foi um
                  dos seis lugares que continuaram prometendo 30 dias depois
                  de a política virar 7. */}
              <p className="text-body font-light text-ink-soft">
                {STORE_POLICIES.exchangeWindowDays} dias para trocar, na loja ou pelo portal
                de trocas. Sem burocracia.
              </p>
            </AccordionItem>
            <AccordionItem title="Formas de pagamento">
              <p className="text-body font-light text-ink-soft">
                Pix com 5% de desconto, cartão em até 12x sem juros, ou crediário próprio nas
                lojas físicas.
              </p>
            </AccordionItem>
          </Accordion>
        </div>
      </Section>

      {/*
        PROVA SOCIAL · SAIU DO AR EM 06/08/2026, VOLTOU REAL EM 19/08/2026

        A versão antiga mostrava depoimentos assinados por "Cliente Lurds" com
        ALTURA, PESO e TAMANHO COMPRADO inventados, sob o título "direto de
        quem comprou" — e as mesmas quatro frases em TODAS as peças.

        O que entrou no lugar é o que faltava: avaliação amarrada a um item de
        pedido ENTREGUE, escrita pela cliente no /conta/avaliacoes. Peça sem
        avaliação não rende seção nenhuma — a página segue como estava.
      */}
      <AvaliacoesDaPeca slug={product.slug} />

      {/*
        AQUI HAVIA TRÊS CARROSSÉIS (12/08/2026).

        "Complete seu look" e "Vistos por você" mudaram pro CARRINHO (decisão
        do dono): é lá que a cliente ainda pode somar peça — pra bater o frete
        grátis, pra aproveitar o mesmo envio —, e "Complete seu look" passou a
        olhar a sacola INTEIRA em vez de uma peça só. No checkout não entram
        de propósito: distração na hora de pagar derruba conversão.

        O terceiro, "Você também pode gostar", virou o feed abaixo — a mesma
        promessa sem o teto de quatro peças.
      */}

      {/*
        A PÁGINA NÃO ACABA (dono, 12/08/2026).

        Continua na ordem que a cliente já estava seguindo: resto da
        subcategoria desta peça → resto da categoria → próximas categorias.
        A sequência é montada no servidor (`LojaCatalogService.descobrir`) —
        é o que garante que a página 7 não repita o que a página 1 mostrou.
      */}
      {/*
        COMPLETE O LOOK (dono, 13/08): as peças da MESMA foto vêm ANTES do
        feed genérico — é a sugestão mais forte que existe, porque a cliente
        está literalmente vendo a outra peça na foto que a trouxe aqui.
        Curadoria em /retaguarda/looks; peça sem look não rende bloco.
      */}
      {peca?.look && <CompleteOLook look={peca.look} />}

      <DescobrirFeed
        slug={product.slug}
        eyebrow="Combina com"
        title="Você também pode gostar"
        cta={{ label: `Ver tudo em ${categoryLabel}`, href: `/categoria/${product.category}` }}
        tone="alt"
      />

      {/* Sinais locais: últimos vistos + personalização (client, invisível) */}
      <ProductPageSignals product={product} />

      {/* Fica depois do feed porque é o fecho editorial da página, e o feed
          termina de verdade — o catálogo é grande, não infinito. */}
      <NewsletterBlock tone="champagne" />
      {editar === '1' && peca?.editorIdentity?.marca && (
        <ProductVisualEditor
          reference={peca.editorIdentity.ref}
          brand={peca.editorIdentity.marca}
          color={peca.editorIdentity.cor}
          initialName={product.name}
          initialDescription={description || ''}
        />
      )}
    </>
  );
}
