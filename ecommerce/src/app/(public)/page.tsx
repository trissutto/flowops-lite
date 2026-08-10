import { MapPin, MessageCircle } from 'lucide-react';
import { Hero } from '@/components/sections/Hero';
import { Manifesto } from '@/components/sections/Manifesto';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { ProductCarousel } from '@/components/sections/ProductCarousel';
import { VideoBlock } from '@/components/sections/VideoBlock';
import { CTABanner } from '@/components/sections/CTABanner';
import { NewsletterBlock } from '@/components/sections/NewsletterBlock';
import { FaixaTrocaFacil } from '@/components/sections/FaixaTrocaFacil';
import { CategoriaCard } from '@/components/cards/CategoriaCard';
import { StoreCard } from '@/components/cards/StoreCard';
import { InstagramCard } from '@/components/cards/InstagramCard';
import { Button } from '@/components/ui/Button';
import { manifesto, PERFIL_INSTAGRAM } from '@/data/content';
import { getInstagram } from '@/services/instagram';
import { featuredStores, stores } from '@/data/stores';
import { getHeroDaHome } from '@/services/banners';
import { getCategorias } from '@/services/categorias-menu';
import { fetchVitrine } from '@/services/vitrine';
import { buildMetadata, itemListSchema, jsonLdGraph, storeSchema } from '@/lib/seo';

/**
 * HOME — a jornada da cliente.
 *
 * A ordem não é decorativa: abre com desejo (hero), deixa ela escolher o rumo
 * (categorias), explica quem somos (manifesto), mostra o catálogo em cinco
 * vitrines, inspira (vídeo, Instagram) e fecha convidando pra loja física —
 * que é onde a conversão da Lurds acontece de verdade.
 *
 * ── O QUE SAIU EM 10/08/2026 ──
 *
 * Três seções foram desligadas de uma vez: Shop the Look, Moda por modelagem
 * e Editorial da semana. Todas tinham o mesmo defeito — eram maquete
 * apresentada como loja: foto de banco de imagem, produto inventado e botão
 * levando a página que nunca existiu. Cada uma está comentada no lugar onde
 * ficava, com o que precisa existir pra ela voltar. Decisão do dono:
 * "tudo isso vamos trazer de volta mais para frente".
 *
 * Server Component: só as seções interativas (carrosséis, cards com hover)
 * são client. Ver docs/home.md.
 */

export const metadata = buildMetadata({
  title: "Lurd's Plus Size — Moda plus size elegante do 46 ao 60",
  path: '/',
  keywords: [
    'moda plus size',
    'roupas plus size',
    'vestido plus size',
    'loja plus size',
    'plus size 46 ao 60',
  ],
});

export default async function HomePage() {
  // O hero vem do cadastro de banners da retaguarda; se não houver campanha
  // no ar (ou o backend estiver fora), volta pro estático sem quebrar a home.
  const hero = await getHeroDaHome();
  // As categorias do CRM com a foto da peça mais nova de cada uma.
  const categoriasHome = await getCategorias();
  // Posts REAIS da @lurdsplussize. Cai na grade estática se a integração não
  // estiver configurada — ver `services/instagram`.
  const posts = await getInstagram(6);

  /**
   * AS CINCO VITRINES DA HOME (dono, 10/08): Lançamentos, Blusas, Vestidos,
   * Calças e Macacões.
   *
   * A primeira é por DATA (o que chegou), as outras quatro por CATEGORIA — a
   * cliente que entra pela home sem campanha específica procura por tipo de
   * peça, e o carrossel mostra sem obrigar ela a escolher uma categoria antes.
   *
   * Os slugs têm que bater com os do CRM (`SiteCategoria.slug`): `calcas` e
   * `macacoes` são sem acento e no plural — errar o slug não dá erro, volta
   * lista vazia e a vitrine some sem ninguém perceber.
   *
   * Em paralelo de propósito: são chamadas independentes, e esperar uma pela
   * outra multiplicaria por cinco o tempo até a home renderizar.
   */
  const [chegouAgora, emDestaque, blusas, vestidos, calcas, macacoes] = await Promise.all([
    fetchVitrine({ ordenar: 'novidades', limite: 12 }),
    fetchVitrine({ ordenar: 'relevancia', limite: 12 }),
    fetchVitrine({ categoria: 'blusas', ordenar: 'novidades', limite: 12 }),
    fetchVitrine({ categoria: 'vestidos', ordenar: 'novidades', limite: 12 }),
    fetchVitrine({ categoria: 'calcas', ordenar: 'novidades', limite: 12 }),
    fetchVitrine({ categoria: 'macacoes', ordenar: 'novidades', limite: 12 }),
  ]);

  /** Categoria sem peça publicada não vira vitrine vazia — simplesmente não sai. */
  const vitrinesPorCategoria = [
    {
      slug: 'blusas',
      titulo: 'Blusas',
      eyebrow: 'Pra todo dia',
      descricao: 'Do básico que resolve a semana ao decote que pede saída à noite.',
      produtos: blusas,
    },
    {
      slug: 'vestidos',
      titulo: 'Vestidos',
      eyebrow: 'A peça que resolve',
      descricao: 'Um vestido, look pronto — trabalho, festa ou domingo.',
      produtos: vestidos,
    },
    {
      slug: 'calcas',
      titulo: 'Calças',
      eyebrow: 'Modelagem que veste',
      descricao: 'Cós que não aperta, caimento que valoriza — do jeans à alfaiataria.',
      produtos: calcas,
    },
    {
      slug: 'macacoes',
      titulo: 'Macacões e macaquinhos',
      eyebrow: 'Look inteiro numa peça',
      descricao: 'Veste em um movimento e já sai pronta — sem combinar nada.',
      produtos: macacoes,
    },
  ].filter((v) => v.produtos.length > 0);

  const jsonLd = jsonLdGraph(
    itemListSchema(
      [...chegouAgora, ...emDestaque, ...vitrinesPorCategoria.flatMap((v) => v.produtos)],
      'Destaques da home',
    ),
    ...stores.map(storeSchema),
  );

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />

      {/* 01 — HERO EDITORIAL */}
      <Hero
        image={hero.image}
        imageMobile={hero.imageMobile}
        eyebrow={hero.eyebrow}
        title={
          <>
            {hero.lead}
            {hero.emphasis && (
              <>
                <br />
                <span className="text-primary-soft italic">{hero.emphasis}</span>
              </>
            )}
          </>
        }
        subtitle={hero.subtitle}
        primaryAction={hero.primaria}
        secondaryAction={hero.secundaria}
        // Arte da retaguarda manda na altura (não recorta a campanha); a foto
        // editorial estática segue em tela cheia.
        height={hero.daRetaguarda ? 'arte' : 'fullscreen'}
        align="center"
        // Escurecer a arte da campanha estraga a cor que o designer escolheu —
        // o overlay só existe pra dar contraste ao texto do hero estático.
        overlay={hero.daRetaguarda ? 'none' : 'medium'}
        showScrollHint={!hero.daRetaguarda}
        priority
      />

      {/* 02 — NOSSAS CATEGORIAS, LOGO ABAIXO DO BANNER (dono 07/08, mockup).
          É a primeira decisão que a cliente toma depois de ver a campanha:
          "o que eu vim procurar?". Deixar isso pro meio da página obriga a
          rolar por manifesto e carrossel antes de poder escolher.
          Sem contagem de peças — número de item não ajuda a escolher e
          envelhece mal. O ícone da silhueta diz o que é antes de ler. */}
      {categoriasHome.length > 0 && (
        <Section tone="alt" width="wide" aria-labelledby="categorias-home">
          <SectionTitle
            id="categorias-home"
            eyebrow="Encontre seu look ideal"
            title="Nossas categorias"
          />
          {/* 5 por linha no desktop (dono 07/08) — 9 categorias viram 5+4. */}
          <div className="mt-12 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5 lg:gap-4">
            {categoriasHome.map((c, index) => (
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
        </Section>
      )}

      {/* 03 — MANIFESTO */}
      <Manifesto
        eyebrow={manifesto.eyebrow}
        title={manifesto.title}
        paragraphs={manifesto.paragraphs}
        stats={manifesto.stats}
      />

      {/* 03 — LANÇAMENTOS (1ª das cinco vitrines) */}
      <Section tone="alt" width="wide" aria-labelledby="novidades-titulo">
        <SectionTitle
          id="novidades-titulo"
          eyebrow="Acabou de chegar"
          title="Novidades da semana"
          description="Peças novas toda semana — nas lojas e aqui, ao mesmo tempo."
          cta={{ label: 'Ver todos os lançamentos', href: '/novidades' }}
          align="left"
        />
        <div className="mt-14">
          <ProductCarousel products={chegouAgora} ariaLabel="Novidades da semana" />
        </div>
      </Section>

      {/* ── SHOP THE LOOK: FORA DO AR ATÉ TER LOOK DE VERDADE (10/08/2026)
          ────────────────────────────────────────────────────────────────
          A seção era bonita e estava 100% em cima de dados de MAQUETE: os
          looks vinham de `data/content.ts`, montados com produtos fictícios
          (p01…p08) e fotos de banco de imagem — não do catálogo.

          Não era só enfeite errado, quebrava de três jeitos:
            · cada peça do look linkava pra `/produto/<slug-inventado>` → 404;
            · "Levar o look" jogava produto INEXISTENTE na sacola, com preço
              inventado — a cliente só descobria que não dava pra fechar lá no
              checkout, com a sacola montada;
            · "Ver todos os looks" ia pra `/looks`, que nunca existiu.

          Ligar de volta não é reativar esta seção: é ter de onde tirar look
          de verdade. Hoje não existe curadoria de look no backend (nenhuma
          tabela guarda "estas 3 REFs formam um look"), então a seção volta
          quando esse dado existir. `LookShowcase`, `LookCard` e o tipo `Look`
          continuam no código, prontos, esperando dado real. */}

      {/* 03.5 — TROCA FÁCIL (dono 10/08).
          Depois da PRIMEIRA vitrine, não antes: a cliente precisa ter visto
          peça que quer pra dúvida "e se não servir?" existir — antes disso é
          recado sobre um problema que ela ainda não tem. E antes das outras
          quatro vitrines, porque é justamente aí que ela começa a escolher. */}
      <FaixaTrocaFacil />

      {/* 04 a 07 — AS OUTRAS QUATRO VITRINES, POR CATEGORIA (dono 10/08)
          Alterna o fundo entre elas: três carrosséis seguidos com o mesmo tom
          viram uma parede só, e a cliente para de perceber onde uma acaba e a
          outra começa. */}
      {vitrinesPorCategoria.map((v, i) => (
        <Section
          key={v.slug}
          tone={i % 2 === 0 ? 'default' : 'alt'}
          width="wide"
          aria-labelledby={`vitrine-${v.slug}`}
        >
          <SectionTitle
            id={`vitrine-${v.slug}`}
            eyebrow={v.eyebrow}
            title={v.titulo}
            description={v.descricao}
            cta={{ label: `Ver tudo em ${v.titulo}`, href: `/categoria/${v.slug}` }}
            align="left"
          />
          <div className="mt-14">
            <ProductCarousel products={v.produtos} ariaLabel={`Vitrine de ${v.titulo}`} />
          </div>
        </Section>
      ))}

      {/* ── MODA POR MODELAGEM: FORA DO AR (dono, 10/08)
          ────────────────────────────────────────────────
          Os seis cards ("Valoriza a cintura", "Disfarça a barriga"…) levavam a
          `/modelagem/<slug>` — seis páginas que nunca existiram. A cliente lia
          a promessa mais persuasiva da home ("a gente organiza a vitrine pelo
          que você quer valorizar"), clicava em VER PEÇAS e caía num 404.

          Não é só a página que falta: NENHUMA peça está classificada por
          modelagem no cadastro ainda, então mesmo com a página pronta a
          vitrine viria vazia. A seção volta quando o campo estiver preenchido
          — é o mesmo motivo que tirou Ocasiões e Coleções do menu
          (ver `data/navigation.ts`). */}

      {/* ── "SELEÇÃO DA LOJA": SAIU EM 10/08.
          O dono fechou a home em CINCO vitrines (Lançamentos, Blusas,
          Vestidos, Calças, Macacões). Esta era a sexta, e ela não trazia um
          eixo novo: era o catálogo por relevância, ou seja, as mesmas peças
          das outras cinco em outra ordem. Seis carrosséis seguidos viram
          rolagem sem fim e a cliente para de olhar antes do rodapé.

          As peças continuam sendo carregadas (`emDestaque`) porque alimentam
          o JSON-LD da home — o Google lê a lista inteira mesmo sem seção. */}

      {/* ── EDITORIAL DA SEMANA: FORA DO AR (10/08)
          ────────────────────────────────────────────
          Mesmo defeito das duas seções acima, achado na mesma varredura: os
          três artigos apontavam pra `/blog/<slug>` e o card de abertura pra
          `/colecoes/atual` — nenhuma dessas páginas existe, e não há blog
          nenhum pra apontar. As fotos também eram de banco de imagem, não da
          marca.

          Volta quando existir conteúdo editorial de verdade (com foto da
          Lurd's e página pra ler). */}

      {/* 08 — VÍDEO INSTITUCIONAL: FORA DO AR (dono, 10/08)
          ───────────────────────────────────────────────
          "Por dentro da Lurds — um provador sem pressa, um atendimento que
          acolhe", ilustrado por uma foto de banco de imagem de uma loja
          MASCULINA de streetwear: tênis, bonés, mochilas e um pôster da U.S.
          Navy. Numa loja de moda plus size feminina, a imagem contava uma
          história de outra marca — e logo na seção que fala do acolhimento no
          provador, que é o argumento mais forte da Lurd's.

          Volta com vídeo ou foto REAL de uma das lojas. `VideoBlock` e
          `institutionalVideo` seguem no código, só esperando o material. */}

      {/*
        11 — DEPOIMENTOS · REMOVIDO DO AR EM 06/08/2026

        Esta seção mostrava avaliações assinadas por "Cliente Lurds", com
        ALTURA, PESO e TAMANHO COMPRADO inventados, e cinco estrelas. Não era
        placeholder de layout: estava no ar, com cara de prova social real, sob
        o título "Altura, peso e o tamanho que ela levou".

        Duas razões pra sair, e a segunda é a que pesa:

        1. É publicidade enganosa (CDC). Avaliação fabricada é infração, não
           licença poética.
        2. O dado de corpo é EXATAMENTE o que faz a cliente plus size confiar.
           Inventar justo esse número é abusar da dúvida que ela veio resolver
           — e é o tipo de coisa que, descoberta, não custa uma venda: custa a
           marca.

        A seção VOLTA quando houver depoimento de cliente de verdade. A base já
        permite pedir: todo pedido entregue tem CPF, peça e tamanho. O
        componente `TestimonialCarousel` continua no repositório, pronto — o
        que falta é o dado, não a tela.
      */}

      {/* 09 — INSTAGRAM */}
      <Section width="wide" aria-labelledby="instagram-titulo">
        <SectionTitle
          id="instagram-titulo"
          eyebrow="@lurdsplussize"
          title="No feed e no seu guarda-roupa"
          cta={{ label: 'Seguir no Instagram', href: PERFIL_INSTAGRAM }}
          align="left"
        />
        <div className="mt-14 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {posts.map((post) => (
            <InstagramCard key={post.id} post={post} />
          ))}
        </div>
      </Section>

      {/* 10 — NOSSAS LOJAS */}
      <Section tone="alt" width="wide" aria-labelledby="lojas-titulo">
        <SectionTitle
          id="lojas-titulo"
          eyebrow="Visite a Lurds"
          title="14 endereços, o mesmo acolhimento"
          description="Prove com calma, converse com uma consultora e leve na hora."
        />
        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {featuredStores.map((store, index) => (
            <StoreCard key={store.slug} store={store} index={index} />
          ))}
        </div>
        <div className="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="/lojas" size="lg">
            <MapPin /> Ver todas as lojas
          </Button>
          <Button
            href="https://api.whatsapp.com/send?phone=5513996050174"
            external
            variant="whatsapp"
            size="lg"
          >
            <MessageCircle /> Falar com uma consultora
          </Button>
        </div>
      </Section>

      {/* 11 — CTA FINAL + NEWSLETTER */}
      <CTABanner
        eyebrow="Sua próxima peça favorita"
        title="Está esperando você em uma das nossas lojas"
        description="Atendimento sem pressa, provador confortável e alguém que entende do seu corpo."
        primaryAction={{ label: 'Encontrar minha loja', href: '/lojas' }}
        secondaryAction={{
          label: 'Falar no WhatsApp',
          href: 'https://api.whatsapp.com/send?phone=5513996050174',
          external: true,
        }}
        height="md"
      />

      <NewsletterBlock tone="champagne" />

      {/* 12 — FOOTER vive no layout do grupo (public) */}
    </>
  );
}
