import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Clock, MapPin, Store as StoreIcon } from 'lucide-react';
import { InstagramIcon as Instagram } from '@/components/ui/icons';
import {
  SITE_URL,
  badgesFor,
  directionsUrl,
  fullAddress,
  instagramUrl,
  mapEmbedUrl,
  stores,
  type Store,
} from '../lib';
import StoreCtas from './StoreCtas';

/**
 * A PÁGINA DE UMA LOJA — a landing que faltava desde a virada de 19/08/2026.
 *
 * ── POR QUE ELA EXISTE ──
 *
 * O WordPress tinha uma página por unidade (`/nossaslojas/<cidade>`, e antes
 * disso `/tree/<cidade>`, o link da bio do Instagram). O site novo tinha só a
 * `/lojas`, com as 14 numa página só — então TODA busca local caía na lista
 * genérica e a cliente tinha que se achar no meio dela.
 *
 * Não é teoria: na Search Console, 90 dias, `/nossaslojas/<cidade>` soma
 * centenas de cliques com nome de cidade (jundiai 36, moema 33, analiafranco
 * 27, piracicaba 24, indaiatuba 23, itanhaem 22, campinas 20…), e `/tree`
 * sozinho traz ~50 cliques por semana. Quem busca "loja plus size em Santos"
 * quer o endereço de Santos, não um índice.
 *
 * ── POR QUE É SERVER PURO ──
 *
 * Só os três botões são client (`StoreCtas`), porque clique no WhatsApp é
 * lead e some do funil sem rastreio. O resto — endereço, horário, mapa,
 * dados estruturados — é HTML servido. O relatório de Core Web Vitals de
 * 21/08 aponta INP acima de 200ms em 498 das 597 URLs no celular; página de
 * loja é justamente onde a cliente chega com pressa.
 *
 * ⚠️ Sem "Aberto agora" aqui, de propósito: o cálculo depende do relógio da
 * cliente e obrigaria a rota inteira a virar client (ou a acusar hydration
 * mismatch). Os horários vão listados, que é o que ela precisa antes de sair
 * de casa. O selo "Aberta agora" continua na `/lojas` e no drawer.
 */

interface Params {
  params: { cidade: string };
}

function storeBySlug(slug: string): Store | undefined {
  return stores.find((s) => s.slug === slug);
}

/** As 14 páginas nascem no build — nenhuma consulta em request de cliente. */
export function generateStaticParams() {
  return stores.map((s) => ({ cidade: s.slug }));
}

export function generateMetadata({ params }: Params): Metadata {
  const s = storeBySlug(params.cidade);
  if (!s) return { title: 'Loja não encontrada' };

  const url = `${SITE_URL}/lojas/${s.slug}`;
  /**
   * O título mira a busca de verdade — "loja plus size em <cidade>" —, e não o
   * nome da unidade. Nome de unidade só é buscado por quem já conhece; a
   * cliente nova procura pela cidade.
   */
  const title = `Loja plus size em ${s.address.city} — Lurd's Plus Size ${s.unit}`;
  const description =
    `Lurd's Plus Size ${s.unit}: ${s.address.street}, ${s.address.neighborhood}, ` +
    `${s.address.city}/${s.address.uf}. Moda plus size do 44 ao 60, atendimento acolhedor ` +
    `e provador confortável. Veja horários, telefone e como chegar.`;

  return {
    metadataBase: new URL(SITE_URL),
    title,
    description,
    alternates: { canonical: url },
    keywords: [
      `loja plus size ${s.address.city}`,
      `moda plus size ${s.address.city}`,
      `roupas plus size ${s.address.city}`,
      `Lurds Plus Size ${s.unit}`,
      `plus size ${s.address.neighborhood}`,
    ],
    openGraph: {
      title,
      description,
      url,
      siteName: "Lurd's Plus Size",
      locale: 'pt_BR',
      type: 'website',
      // Sem foto oficial da unidade, o card sai sem imagem — banco de imagem
      // repetido nas 14 lojas promete uma loja que não existe.
    },
    twitter: { card: 'summary_large_image', title, description },
    robots: { index: true, follow: true, 'max-image-preview': 'large' },
  };
}

/**
 * ClothingStore da unidade — com `@id` e `url` DESTA página.
 *
 * A `/lojas` também emite os 14 nós, mas todos apontando `url` pra ela mesma.
 * Aqui cada nó aponta pra própria landing: é isso que deixa o Google associar
 * o endereço à página que ele deve mostrar pra busca daquela cidade.
 */
function storeJsonLd(s: Store) {
  const url = `${SITE_URL}/lojas/${s.slug}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'ClothingStore',
    '@id': `${url}#loja`,
    name: `Lurd's Plus Size ${s.unit}`,
    description: s.description,
    url,
    telephone: `+55 ${s.phone.replace(/[()]/g, '').trim()}`,
    address: {
      '@type': 'PostalAddress',
      streetAddress: `${s.address.street} – ${s.address.neighborhood}`,
      addressLocality: s.address.city,
      addressRegion: s.address.uf,
      ...(s.address.zip ? { postalCode: s.address.zip } : {}),
      addressCountry: 'BR',
    },
    geo: { '@type': 'GeoCoordinates', latitude: s.geo.lat, longitude: s.geo.lng },
    hasMap: directionsUrl(s),
    sameAs: [instagramUrl(s)],
    openingHoursSpecification: s.hours.schema.map((b) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: b.days.map((d) => `https://schema.org/${d}`),
      opens: b.opens,
      closes: b.closes,
    })),
    parentOrganization: {
      '@type': 'Organization',
      name: "Lurd's Plus Size",
      url: SITE_URL,
    },
  };
}

function breadcrumbJsonLd(s: Store) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Início', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Nossas Lojas', item: `${SITE_URL}/lojas` },
      {
        '@type': 'ListItem',
        position: 3,
        name: `Lurd's Plus Size ${s.unit}`,
        item: `${SITE_URL}/lojas/${s.slug}`,
      },
    ],
  };
}

export default function LojaCidadePage({ params }: Params) {
  const s = storeBySlug(params.cidade);
  if (!s) notFound();

  const outras = stores.filter((o) => o.slug !== s.slug);

  return (
    <main className="bg-[var(--lj-ivory)] pb-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(storeJsonLd(s)) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd(s)) }}
      />

      {/* Capa editorial — tipografia como protagonista, igual ao drawer da listagem */}
      <header className="lojas-grain bg-[var(--lj-ink)] px-5 pb-10 pt-8 sm:px-8 sm:pt-12">
        <div className="mx-auto max-w-3xl">
          <nav aria-label="Você está em" className="text-[10px] uppercase tracking-[0.2em] text-white/60">
            <Link href="/" className="hover:text-white">
              Início
            </Link>
            <span className="px-1.5" aria-hidden>
              ·
            </span>
            <Link href="/lojas" className="hover:text-white">
              Nossas lojas
            </Link>
          </nav>

          <p className="mt-6 text-[11px] font-light uppercase tracking-[0.22em] text-[var(--lj-gold-soft)]">
            {s.address.city} · {s.address.uf}
          </p>
          <h1 className="lojas-serif mt-2 text-[2rem] font-semibold uppercase leading-[1.08] tracking-[0.03em] text-white sm:text-[2.6rem]">
            Lurd&apos;s Plus Size {s.unit}
          </h1>
          <div className="lojas-rule mt-5 opacity-70" />
          <p className="lojas-serif mt-5 text-[15px] font-light italic leading-relaxed text-white/80">
            {s.description}
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-5 sm:px-8">
        <ul className="mt-6 flex flex-wrap gap-1.5" aria-label="Diferenciais da loja">
          {badgesFor(s).map((b) => (
            <li
              key={b}
              className="rounded-full border border-[var(--lj-gold)]/30 bg-white px-3 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--lj-gold-strong)]"
            >
              {b}
            </li>
          ))}
        </ul>

        <StoreCtas store={s} />

        <dl className="mt-8 space-y-4 border-t border-[var(--lj-line)] pt-7">
          <div className="flex gap-3">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} aria-hidden />
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--lj-ink-soft)]">
                Endereço
              </dt>
              <dd className="mt-1 text-[15px] leading-relaxed text-[var(--lj-ink)]">{fullAddress(s)}</dd>
            </div>
          </div>

          <div className="flex gap-3">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} aria-hidden />
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--lj-ink-soft)]">
                Horários
              </dt>
              <dd className="mt-1 text-[15px] leading-relaxed text-[var(--lj-ink)]">
                {s.hours.display.map((line) => (
                  <span key={line} className="block">
                    {line}
                  </span>
                ))}
              </dd>
            </div>
          </div>

          <div className="flex gap-3">
            <Instagram className="mt-0.5 h-4 w-4 shrink-0 text-[var(--lj-gold-strong)]" strokeWidth={1.75} aria-hidden />
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--lj-ink-soft)]">
                Instagram
              </dt>
              <dd className="mt-1 text-[15px] text-[var(--lj-ink)]">
                <a
                  href={instagramUrl(s)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  @{s.instagram}
                </a>
              </dd>
            </div>
          </div>
        </dl>

        <section className="mt-9" aria-labelledby="mapa-titulo">
          <h2
            id="mapa-titulo"
            className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--lj-ink-soft)]"
          >
            Onde estamos
          </h2>
          <div className="relative mt-4 overflow-hidden rounded-2xl border border-[var(--lj-line)] shadow-[0_10px_40px_-30px_rgba(33,28,24,0.5)]">
            <iframe
              src={mapEmbedUrl(s)}
              title={`Mapa — Lurd's Plus Size ${s.unit}`}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className="h-72 w-full border-0"
            />
          </div>
        </section>

        <section className="mt-10 rounded-2xl border border-[var(--lj-line)] bg-white p-6" aria-labelledby="online-titulo">
          <h2 id="online-titulo" className="lojas-serif text-[1.3rem] font-semibold text-[var(--lj-ink)]">
            Prefere comprar sem sair de casa?
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-[var(--lj-ink-soft)]">
            A mesma curadoria da loja de {s.address.city}, do 44 ao 60, com entrega para todo o Brasil.
          </p>
          <Link
            href="/novidades"
            className="mt-4 inline-flex items-center justify-center rounded-full bg-[var(--lj-ink)] px-6 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-white transition hover:brightness-125"
          >
            Ver as novidades
          </Link>
        </section>

        {/* As outras unidades — ajuda quem errou a cidade e dá ao Google o
            caminho pras 13 páginas irmãs a partir de qualquer uma delas. */}
        <section className="mt-10 border-t border-[var(--lj-line)] pt-7" aria-labelledby="outras-titulo">
          <h2
            id="outras-titulo"
            className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--lj-ink-soft)]"
          >
            <StoreIcon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden /> Outras lojas Lurd&apos;s
          </h2>
          <ul className="mt-4 flex flex-wrap gap-2">
            {outras.map((o) => (
              <li key={o.slug}>
                <Link
                  href={`/lojas/${o.slug}`}
                  className="inline-block rounded-full border border-[var(--lj-line)] bg-white px-3.5 py-1.5 text-[12px] text-[var(--lj-ink)] transition hover:border-[var(--lj-ink)]"
                >
                  {o.unit}
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href="/lojas"
            className="mt-5 inline-block text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--lj-gold-strong)] hover:underline"
          >
            Ver as 14 lojas no mapa
          </Link>
        </section>
      </div>
    </main>
  );
}
