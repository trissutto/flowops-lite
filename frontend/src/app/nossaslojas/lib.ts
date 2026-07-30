import data from '@/data/lojas.json';

/**
 * Camada de acesso aos dados de /nossaslojas.
 * Tudo vem de src/data/lojas.json — adicionar loja nova lá é o suficiente.
 */

export interface StoreHours {
  display: string[];
  schema: { days: string[]; opens: string; closes: string }[];
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
}

export interface Testimonial {
  quote: string;
  author: string;
  city: string;
}

export const stores: Store[] = data.stores as Store[];
export const testimonials: Testimonial[] = data.testimonials as Testimonial[];

export const SITE_URL = 'https://www.lurdsplussize.com.br';

export function fullAddress(s: Store): string {
  const zip = s.address.zip ? ` · CEP ${s.address.zip}` : '';
  return `${s.address.street} – ${s.address.neighborhood}, ${s.address.city}/${s.address.uf}${zip}`;
}

export function whatsappUrl(s: Store): string {
  const text = encodeURIComponent('Olá! Quero conhecer a loja (vim pelo site).');
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
