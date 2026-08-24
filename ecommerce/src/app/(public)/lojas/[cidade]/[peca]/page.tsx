import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Clock, MapPin } from 'lucide-react';
import { Container } from '@/components/layout/Container';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { fetchPeca } from '@/services/peca';
import { apiSafe } from '@/lib/api';
import { buildMetadata, jsonLdGraph, breadcrumbSchema } from '@/lib/seo';
import {
  BLUR_DATA_URL,
  SITE_URL,
  fullAddress,
  openStatus,
  stores,
  type Store,
} from '../../lib';
import PecaNaLojaCtas from './PecaNaLojaCtas';

/**
 * A PEÇA NESTA LOJA — a página que fecha o ciclo da busca local (23/08/2026).
 *
 * ── O BURACO QUE ELA TAPA ──
 *
 * O inventário local do Google faz a peça aparecer na ficha da loja no Maps.
 * Mas o clique caía em `/produto/<peça>`, que é a página de COMPRAR ONLINE:
 * frete, prazo de entrega, sacola. A cliente buscou "vestido plus size perto
 * de mim", viu que tem em Campinas, clicou — e recebeu uma resposta de
 * e-commerce, sem endereço, sem horário, sem o WhatsApp da unidade.
 * É a mesma desconexão do `/tree` corrigido hoje, um nível mais fundo.
 *
 * ── A REGRA QUE MANDA AQUI (decisão do dono, 23/08) ──
 *
 * **Tamanho que falta nesta loja, a loja pede pra outra.** Por isso a página
 * mostra a GRADE INTEIRA da rede e separa em dois grupos — "tem aqui hoje" e
 * "a gente traz" —, em vez de escrever "indisponível" e perder a cliente que
 * já estava a caminho. Nada nesta página diz que a peça acabou.
 *
 * ── POR QUE SERVER PURO ──
 *
 * Só os dois CTAs são client (`PecaNaLojaCtas`), porque clique de WhatsApp é
 * lead e some do funil sem rastreio. O resto é HTML servido: quem chega aqui
 * vem do Maps, no celular, com pressa — e o Core Web Vitals de 21/08 aponta
 * INP acima de 200ms em 498 das 597 URLs no mobile.
 */

export const revalidate = 300;

interface Params {
  /** Next 15: params chega como Promise em rota dinamica async. */
  params: Promise<{ cidade: string; peca: string }>;
}

interface LinhaEstoque {
  loja: string;
  cor: string | null;
  tamanho: string | null;
  estoque: number;
}

const lojaPorSlug = (slug: string): Store | undefined => stores.find((s) => s.slug === slug);

/**
 * Ordena tamanho como número quando dá, e como texto quando não dá (P/M/G,
 * "ÚNICO"). `sort()` puro colocaria 10 antes de 46 e o 60 no meio da grade.
 */
function ordenarTamanhos(a: string, b: string): number {
  const na = Number(a.replace(',', '.'));
  const nb = Number(b.replace(',', '.'));
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  if (Number.isFinite(na)) return -1;
  if (Number.isFinite(nb)) return 1;
  return a.localeCompare(b, 'pt-BR');
}

const dinheiro = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * As páginas nascem sob demanda, não no build.
 *
 * 14 lojas × ~950 peças = ~13 mil rotas. Pré-renderizar tudo faria o build da
 * Vercel estourar por um ganho que não existe: o Google entra numa peça por
 * vez, vindo da ficha. `revalidate` de 5 min mantém o estoque honesto.
 */
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

async function carregar(cidade: string, pecaSlug: string) {
  const loja = lojaPorSlug(cidade);
  if (!loja) return null;

  const peca = await fetchPeca(pecaSlug);
  if (!peca?.product) return null;

  const ref = peca.product.sku || peca.editorIdentity?.ref || '';
  const estoque = ref
    ? await apiSafe<LinhaEstoque[]>(`/public/loja/estoque-peca/${encodeURIComponent(ref)}`, [], {
        revalidate: 300,
        tags: ['catalogo', `produto:${pecaSlug}`],
        timeoutMs: 8000,
      })
    : [];

  return { loja, peca, ref, estoque };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { cidade, peca: pecaSlug } = await params;
  const dados = await carregar(cidade, pecaSlug);
  if (!dados) return { title: 'Peça não encontrada' };
  const { loja, peca } = dados;

  /**
   * O título mira a busca real: "<peça> em <cidade>". Quem pesquisa assim já
   * decidiu que quer ver de perto — o nome da unidade só interessa a quem já
   * é cliente.
   */
  return buildMetadata({
    title: `${peca.product.name} em ${loja.city} — Lurd's ${loja.unit}`,
    description:
      `${peca.product.name} na loja Lurd's ${loja.unit}, ${fullAddress(loja)}. ` +
      `Veja os tamanhos disponíveis, fale no WhatsApp da loja e venha provar.`,
    path: `/lojas/${loja.slug}/${peca.product.slug}`,
  });
}

export default async function PecaNaLojaPage({ params }: Params) {
  const { cidade, peca: pecaSlug } = await params;
  const dados = await carregar(cidade, pecaSlug);
  if (!dados) notFound();
  const { loja, peca, ref, estoque } = dados;
  const p = peca.product;

  const aqui = estoque.filter((e) => e.loja === loja.codigoFlow && e.estoque > 0);
  const naRede = estoque.filter((e) => e.estoque > 0);

  const tamanhosAqui = [...new Set(aqui.map((e) => e.tamanho).filter(Boolean) as string[])].sort(
    ordenarTamanhos,
  );
  const tamanhosRede = [...new Set(naRede.map((e) => e.tamanho).filter(Boolean) as string[])].sort(
    ordenarTamanhos,
  );
  const tamanhosTrazemos = tamanhosRede.filter((t) => !tamanhosAqui.includes(t));

  /** Quantas OUTRAS unidades têm a peça — vira a frase de "a gente traz". */
  const outrasUnidades = new Set(
    naRede.map((e) => e.loja).filter((c) => c !== loja.codigoFlow),
  ).size;

  const temAqui = tamanhosAqui.length > 0;
  const status = openStatus(loja);
  const foto = p.images?.[0];
  const preco = p.price;
  const de = p.compareAtPrice && p.compareAtPrice > preco ? p.compareAtPrice : null;

  const url = `${SITE_URL}/lojas/${loja.slug}/${p.slug}`;

  /**
   * Schema.org com a LOJA como vendedora e o endereço dela na oferta — é o que
   * diz ao Google que esta página é sobre a peça NAQUELE ponto, e não mais uma
   * cópia da página nacional (que seria conteúdo duplicado).
   */
  const schema = jsonLdGraph(
    breadcrumbSchema([
      { name: 'Lojas', path: '/lojas' },
      { name: loja.unit, path: `/lojas/${loja.slug}` },
      { name: p.name, path: `/lojas/${loja.slug}/${p.slug}` },
    ]),
    {
      '@type': 'Product',
      name: p.name,
      sku: ref || undefined,
      image: foto?.src ? [foto.src] : undefined,
      description: peca.descricaoCurta || peca.descricao || undefined,
      offers: {
        '@type': 'Offer',
        url,
        price: preco.toFixed(2),
        priceCurrency: 'BRL',
        availability: temAqui
          ? 'https://schema.org/InStock'
          : 'https://schema.org/LimitedAvailability',
        availableAtOrFrom: {
          '@type': 'Place',
          name: `Lurd's Plus Size ${loja.unit}`,
          address: {
            '@type': 'PostalAddress',
            streetAddress: loja.address.street,
            addressLocality: loja.address.city,
            addressRegion: loja.address.uf,
            postalCode: loja.address.zip || undefined,
            addressCountry: 'BR',
          },
        },
      },
    },
  );

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: schema }}
      />

      <Container className="py-6 sm:py-10">
        <Breadcrumb
          items={[
            { label: 'Lojas', href: '/lojas' },
            { label: loja.unit, href: `/lojas/${loja.slug}` },
            { label: p.name },
          ]}
        />

        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
          {/* ---------------------------------------------------------- foto */}
          <div className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-[var(--lj-sand,#F2EEE6)]">
            {foto?.src ? (
              <Image
                src={foto.src}
                alt={foto.alt || p.name}
                fill
                sizes="(max-width: 1024px) 100vw, 440px"
                className="object-cover"
                placeholder="blur"
                blurDataURL={BLUR_DATA_URL}
                priority
              />
            ) : null}
          </div>

          {/* --------------------------------------------------------- coluna */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--lj-muted,#6E6A61)]">
              Na loja de {loja.unit}
            </p>
            <h1 className="mt-2 text-[26px] leading-tight sm:text-[32px]">{p.name}</h1>

            <p className="mt-3 flex items-baseline gap-3">
              <span className="text-[24px] font-semibold">{dinheiro(preco)}</span>
              {de ? (
                <span className="text-[15px] text-[var(--lj-muted,#6E6A61)] line-through">
                  {dinheiro(de)}
                </span>
              ) : null}
            </p>

            {/* ------------------------------------------------ a grade real */}
            {tamanhosRede.length > 0 ? (
              <div className="mt-7">
                {temAqui ? (
                  <>
                    <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#25683B]">
                      Pronto pra provar hoje
                    </p>
                    <ul className="mt-2.5 flex flex-wrap gap-2">
                      {tamanhosAqui.map((t) => (
                        <li
                          key={t}
                          className="rounded-lg border border-[#25683B] bg-[#E0EDE4] px-3.5 py-2 text-[14px] font-semibold text-[#25683B]"
                        >
                          {t}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="rounded-xl border border-[var(--lj-line,#DDD6C7)] bg-[var(--lj-sand,#F2EEE6)] px-4 py-3 text-[14px]">
                    Esta peça não está nesta loja hoje —{' '}
                    <strong>a gente traz de outra unidade pra você provar aqui.</strong>
                  </p>
                )}

                {tamanhosTrazemos.length > 0 ? (
                  <div className="mt-5">
                    <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--lj-muted,#6E6A61)]">
                      A gente traz pra você
                    </p>
                    <ul className="mt-2.5 flex flex-wrap gap-2">
                      {tamanhosTrazemos.map((t) => (
                        <li
                          key={t}
                          className="rounded-lg border border-dashed border-[var(--lj-line,#DDD6C7)] px-3.5 py-2 text-[14px] text-[var(--lj-ink,#1A1815)]"
                        >
                          {t}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-[13px] text-[var(--lj-muted,#6E6A61)]">
                      {outrasUnidades > 0
                        ? `Disponível em outra${outrasUnidades > 1 ? 's' : ''} ${outrasUnidades} unidade${outrasUnidades > 1 ? 's' : ''} da rede. Peça no WhatsApp que a loja traz.`
                        : 'Fale com a loja pra confirmar o prazo.'}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}

            <PecaNaLojaCtas
              store={loja}
              peca={{ nome: p.name, ref: ref || String(p.sku ?? '') }}
              tamanho={!temAqui && tamanhosRede.length === 1 ? tamanhosRede[0] : null}
            />

            {/* ------------------------------------------------------- a loja */}
            <div className="mt-7 rounded-2xl border border-[var(--lj-line,#DDD6C7)] p-4">
              <p className="flex items-start gap-2 text-[14px]">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
                <span>{fullAddress(loja)}</span>
              </p>
              <p className="mt-2.5 flex items-start gap-2 text-[14px]">
                <Clock className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
                <span>
                  <strong className={status.open ? 'text-[#25683B]' : undefined}>
                    {status.label}
                  </strong>
                  <br />
                  {loja.hours.display.join(' · ')}
                </span>
              </p>
              <Link
                href={`/lojas/${loja.slug}`}
                className="mt-3 inline-block text-[13px] font-semibold underline underline-offset-4"
              >
                Ver a página da loja {loja.unit}
              </Link>
            </div>

            {/* Comprar online é a alternativa, não o objetivo desta página. */}
            <p className="mt-5 text-[13px] text-[var(--lj-muted,#6E6A61)]">
              Prefere receber em casa?{' '}
              <Link href={`/produto/${p.slug}`} className="font-semibold underline underline-offset-4">
                Comprar esta peça no site
              </Link>
            </p>
          </div>
        </div>
      </Container>
    </>
  );
}
