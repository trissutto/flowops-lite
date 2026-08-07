import { api, ApiError } from '@/lib/api';
import { homeHero } from '@/data/content';

/**
 * BANNERS DA VITRINE — servidor.
 *
 * O conteúdo editorial (hero da home, faixas, tarja do topo) vem do cadastro
 * da retaguarda (`/retaguarda/banners`), não mais de constante no código.
 *
 * REGRA DE SEGURANÇA DESTA CAMADA: banner é enfeite; a home não pode cair por
 * causa dele. Backend fora do ar, env não configurada ou slot vazio → cai no
 * conteúdo estático de `data/content.ts`, que é o que está no ar hoje.
 * Ver [[migracao-giga-3-causas]]: "vazio tratado como resposta" já derrubou
 * tela nesta casa.
 */

export interface Banner {
  id: string;
  slot: string;
  eyebrow: string | null;
  titulo: string | null;
  destaque: string | null;
  subtitulo: string | null;
  imagemUrl: string | null;
  imagemMobileUrl: string | null;
  alt: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  cta2Label: string | null;
  cta2Href: string | null;
  ordem: number;
}

/** Uma hora: a mesma revalidação da home. Campanha entra na virada da hora. */
const REVALIDATE = 3600;

export async function getBanners(slot: string): Promise<Banner[]> {
  try {
    const lista = await api<Banner[]>(`/public/loja/banners?slot=${encodeURIComponent(slot)}`, {
      revalidate: REVALIDATE,
      tags: ['banners', `banners:${slot}`],
    });
    return Array.isArray(lista) ? lista : [];
  } catch (e) {
    const detalhe = e instanceof ApiError ? `${e.status} ${e.path}` : String(e);
    console.error(`[banners] slot "${slot}" indisponível — usando o estático: ${detalhe}`);
    return [];
  }
}

/** O que o `<Hero>` da home precisa, já resolvido com o fallback estático. */
export interface HeroDaHome {
  image: { src: string; alt: string };
  /** Recorte vertical do banner, quando a retaguarda subiu um. */
  imageMobile?: { src: string; alt: string };
  eyebrow: string;
  lead: string;
  emphasis: string;
  subtitle: string;
  primaria: { label: string; href: string };
  secundaria: { label: string; href: string };
  /**
   * Veio da retaguarda = ARTE FECHADA (campanha com texto e logo embutidos).
   * A home usa isto pra deixar a arte mandar na altura, em vez de recortar
   * pra encher a tela — recorte comeu o "Indomável" nas duas pontas (07/08).
   * O hero estático é foto editorial: recortar ali não custa nada.
   */
  daRetaguarda: boolean;
}

const HERO_ESTATICO: HeroDaHome = {
  image: homeHero.image,
  eyebrow: homeHero.eyebrow,
  lead: homeHero.lead,
  emphasis: homeHero.emphasis,
  subtitle: homeHero.subtitle,
  primaria: { label: 'Conheça a coleção', href: '/novidades' },
  secundaria: { label: 'Encontrar uma loja', href: '/lojas' },
  daRetaguarda: false,
};

export async function getHeroDaHome(): Promise<HeroDaHome> {
  const [banner] = await getBanners('home-hero');
  // Sem foto o hero não existe — título sobre fundo vazio é pior que o
  // estático. Por isso a imagem é a condição, não o título.
  if (!banner?.imagemUrl) return HERO_ESTATICO;

  return {
    daRetaguarda: true,
    image: { src: banner.imagemUrl, alt: banner.alt || banner.titulo || HERO_ESTATICO.image.alt },
    ...(banner.imagemMobileUrl
      ? { imageMobile: { src: banner.imagemMobileUrl, alt: banner.alt || banner.titulo || '' } }
      : {}),
    eyebrow: banner.eyebrow || '',
    lead: banner.titulo || '',
    emphasis: banner.destaque || '',
    subtitle: banner.subtitulo || '',
    primaria: banner.ctaLabel && banner.ctaHref
      ? { label: banner.ctaLabel, href: banner.ctaHref }
      : HERO_ESTATICO.primaria,
    secundaria: banner.cta2Label && banner.cta2Href
      ? { label: banner.cta2Label, href: banner.cta2Href }
      : HERO_ESTATICO.secundaria,
  };
}

/** Frases da tarja preta do topo. Vazio = as frases padrão do código. */
export async function getTarjaDoTopo(): Promise<{ label: string; href: string }[]> {
  const linhas = await getBanners('tarja-topo');
  return linhas
    .filter((b) => b.titulo)
    .map((b) => ({ label: b.titulo!, href: b.ctaHref || '/' }));
}
