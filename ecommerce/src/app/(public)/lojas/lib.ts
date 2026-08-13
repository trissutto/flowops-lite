import data from '@/data/lojas.json';
import { SITE } from '@/lib/seo';

/**
 * Camada de acesso aos dados de /nossaslojas.
 * Tudo vem de src/data/lojas.json — adicionar loja nova lá é o suficiente.
 */

export interface StoreHours {
  display: string[];
  schema: { days: string[]; opens: string; closes: string }[];
}

export interface GalleryPhoto {
  src: string;
  label: string;
}

export interface Store {
  slug: string;
  unit: string;
  city: string;
  uf: string;
  description: string;
  address: {
    street: string;
    neighborhood: string;
    city: string;
    uf: string;
    zip: string | null;
  };
  phone: string;
  whatsapp: string;
  instagram: string;
  hours: StoreHours;
  mapsQuery: string;
  geo: { lat: number; lng: number };
  image: string | null;
  /** Opcionais por loja — sem eles a página usa site.badgesDefault/galleryDefaults. */
  badges?: string[];
  gallery?: GalleryPhoto[];
}

export interface Testimonial {
  quote: string;
  author: string;
  city: string;
}

export interface SiteConfig {
  heroImage: string;
  peopleImage: string;
  manifesto: {
    title: string;
    text: string;
    stats: { value: string; label: string }[];
  };
  badgesDefault: string[];
  galleryDefaults: GalleryPhoto[];
}

export const stores: Store[] = data.stores as Store[];
export const testimonials: Testimonial[] = data.testimonials as Testimonial[];
export const site: SiteConfig = data.site as SiteConfig;

/**
 * Esta página veio da landing que já roda em lurdsplussize.com.br/nossaslojas
 * (mesmo JSON de lojas, mesmos componentes). O que muda aqui é o domínio: no
 * site novo o canonical tem que apontar pro próprio site, senão as duas cópias
 * disputam a mesma URL no Google.
 */
export const SITE_URL = SITE.url;

/**
 * Placeholder de blur em tom champagne — evita "pulo" branco no carregamento
 * das fotos remotas (que não têm blur estático gerado em build).
 */
export const BLUR_DATA_URL =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#efe6d6"/><rect width="8" height="3" y="3" fill="#e6d3b3" opacity=".6"/></svg>',
  );

/** URLs do Unsplash ganham parâmetros de qualidade/corte; caminhos locais passam direto. */
export function imgSrc(src: string, w: number): string {
  if (!src.startsWith('http')) return src;
  return `${src}?q=80&w=${w}&auto=format&fit=crop`;
}

export function badgesFor(s: Store): string[] {
  return s.badges && s.badges.length > 0 ? s.badges : site.badgesDefault;
}

/** Galeria do drawer: foto principal da loja + fotos próprias ou padrão da rede. */
export function galleryFor(s: Store): GalleryPhoto[] {
  const own = s.gallery && s.gallery.length > 0 ? s.gallery : site.galleryDefaults;
  const cover: GalleryPhoto[] = s.image ? [{ src: s.image, label: 'A boutique' }] : [];
  return [...cover, ...own];
}

export function fullAddress(s: Store): string {
  const zip = s.address.zip ? ` · CEP ${s.address.zip}` : '';
  return `${s.address.street} – ${s.address.neighborhood}, ${s.address.city}/${s.address.uf}${zip}`;
}

export function whatsappUrl(s: Store): string {
  /**
   * A UNIDADE VAI CARIMBADA NA MENSAGEM — "loja Suzano (vim pelo site)".
   *
   * Não é cosmético: é o que permite à automação (n8n/Evolution) reconhecer
   * de qual loja veio o lead e gravar no CRM com a origem certa. O formato
   * `loja <unidade> (vim pelo site)` é o contrato de parse do fluxo — mudar o
   * texto quebra o reconhecimento sem dar erro em lugar nenhum.
   */
  const text = encodeURIComponent(`Olá! Quero conhecer a loja ${s.unit} (vim pelo site).`);
  return `https://api.whatsapp.com/send?phone=${s.whatsapp}&text=${text}`;
}

export function instagramUrl(s: Store): string {
  return `https://www.instagram.com/${s.instagram}/`;
}

export function directionsUrl(s: Store): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(s.mapsQuery)}`;
}

/** Embed keyless do Google Maps — trocar o src recentraliza o mapa. */
export function mapEmbedUrl(s: Store): string {
  return `https://www.google.com/maps?q=${encodeURIComponent(s.mapsQuery)}&z=16&output=embed`;
}

/** Distância haversine em km — suficiente pra ranquear a loja mais próxima. */
export function distanceKm(lat: number, lng: number, s: Store): number {
  const R = 6371;
  const dLat = ((s.geo.lat - lat) * Math.PI) / 180;
  const dLng = ((s.geo.lng - lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat * Math.PI) / 180) * Math.cos((s.geo.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function nearestStore(lat: number, lng: number): { store: Store; km: number } {
  let best = stores[0];
  let bestKm = distanceKm(lat, lng, best);
  for (const s of stores.slice(1)) {
    const km = distanceKm(lat, lng, s);
    if (km < bestKm) {
      best = s;
      bestKm = km;
    }
  }
  return { store: best, km: bestKm };
}
