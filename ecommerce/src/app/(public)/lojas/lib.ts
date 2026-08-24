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
  /**
   * Código da loja no Flow (`Store.code`) — '01', '07', '18'.
   * É a chave que casa esta loja com o estoque do ERP e com o `store_code`
   * (`LURDS-<código>`) da ficha no Google Meu Negócio. Conferido 14/14 em
   * 23/08/2026 contra /retaguarda/lojas.
   */
  codigoFlow: string;
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
  /**
   * `null` enquanto não houver foto OFICIAL da Lurds — e é o estado de hoje
   * (16/08/2026). Cada tela que usa estes campos tem o caminho sem foto
   * pronto; nenhuma depende de imagem pra ficar de pé.
   */
  heroImage: string | null;
  peopleImage: string | null;
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

/** URL remota ganha parâmetros de qualidade/corte; caminho local passa direto. */
export function imgSrc(src: string, w: number): string {
  if (!src.startsWith('http')) return src;
  return `${src}?q=80&w=${w}&auto=format&fit=crop`;
}

export function badgesFor(s: Store): string[] {
  return s.badges && s.badges.length > 0 ? s.badges : site.badgesDefault;
}

/**
 * Foto de banco de imagem (Unsplash) — NÃO é a loja de verdade.
 *
 * As URLs de stock SAÍRAM do `lojas.json` em 16/08/2026 (pedido do dono: só
 * foto oficial da Lurds no site), então hoje esta função não tem o que barrar.
 * Ela fica como TRAVA: se alguém colar de novo uma URL de banco de imagem no
 * cadastro, a capa e a galeria continuam desligadas em vez de a foto genérica
 * voltar calada pro ar. Foto própria em `image`/`gallery` liga tudo sozinho.
 */
export function isStockPhoto(src: string | null | undefined): boolean {
  return !!src && /images\.unsplash\.com/.test(src);
}

/** Fotos próprias da unidade (galeria real). Vazio = não mostra galeria. */
export function ownGalleryFor(s: Store): GalleryPhoto[] {
  const own = (s.gallery ?? []).filter((p) => !isStockPhoto(p.src));
  const cover: GalleryPhoto[] = s.image && !isStockPhoto(s.image) ? [{ src: s.image, label: 'A boutique' }] : [];
  return [...cover, ...own];
}

export interface OpenStatus {
  open: boolean;
  /** "Fecha às 18h", "Abre às 9h", "Abre sábado às 9h" */
  label: string;
}

const WEEKDAY_PT: Record<string, string> = {
  Sunday: 'domingo',
  Monday: 'segunda',
  Tuesday: 'terça',
  Wednesday: 'quarta',
  Thursday: 'quinta',
  Friday: 'sexta',
  Saturday: 'sábado',
};
const WEEK_ORDER = Object.keys(WEEKDAY_PT);

/** "09:00" → "9h" · "13:30" → "13h30" */
function prettyHour(hhmm: string): string {
  const [h, m] = hhmm.split(':');
  return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Aberto agora? Calculado no fuso da loja (America/Sao_Paulo) — o relógio do
 * visitante pode estar em qualquer lugar. Chamar só depois do mount: no SSR o
 * horário do servidor difere do da cliente e o React acusa hydration mismatch.
 */
export function openStatus(s: Store, now: Date = new Date()): OpenStatus {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const part = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = part('weekday');
  // Intl com hour12:false devolve "24" na virada da meia-noite.
  const mins = (Number(part('hour')) % 24) * 60 + Number(part('minute'));

  const blockOf = (day: string) => s.hours.schema.find((b) => b.days.includes(day));

  const today = blockOf(weekday);
  if (today) {
    if (mins < toMinutes(today.opens)) return { open: false, label: `Abre às ${prettyHour(today.opens)}` };
    if (mins < toMinutes(today.closes)) return { open: true, label: `Fecha às ${prettyHour(today.closes)}` };
  }

  // Fechada agora: procura o próximo dia com expediente.
  const start = WEEK_ORDER.indexOf(weekday);
  for (let i = 1; i <= 7; i++) {
    const day = WEEK_ORDER[(start + i) % 7];
    const block = blockOf(day);
    if (block) {
      const when = i === 1 ? 'amanhã' : WEEKDAY_PT[day];
      return { open: false, label: `Abre ${when} às ${prettyHour(block.opens)}` };
    }
  }
  return { open: false, label: 'Consulte os horários' };
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

/**
 * WHATSAPP DA UNIDADE JÁ FALANDO DA PEÇA — o CTA da página /lojas/<cidade>/<peça>.
 *
 * ⚠️ MANTÉM, PALAVRA POR PALAVRA, o trecho `loja <unidade> (vim pelo site)` do
 * `whatsappUrl` acima. Esse texto é CONTRATO DE PARSE da automação (n8n /
 * Evolution): é por ele que o fluxo reconhece de qual loja veio o lead e grava
 * a origem certa no CRM. Reescrever a frase quebra o reconhecimento sem dar
 * erro em lugar nenhum — o lead simplesmente cai sem loja.
 *
 * O que muda é só o que vem DEPOIS: a peça, e o tamanho quando a cliente
 * chegou por um tamanho específico.
 */
export function whatsappUrlPeca(
  s: Store,
  peca: { nome: string; ref: string },
  tamanho?: string | null,
): string {
  const oTamanho = tamanho ? ` no tamanho ${tamanho}` : '';

  /**
   * A REF SÓ ENTRA SE O NOME NÃO A TROUXER — o catálogo já batiza a peça como
   * "Regata Alça Larga — 138824". Concatenar sem checar produzia
   * "Regata Alça Larga — 138824 (ref 138824)", que chegava assim no WhatsApp
   * da vendedora (visto em produção em 24/08).
   */
  const jaTemRef =
    !peca.ref || peca.nome.toUpperCase().includes(peca.ref.toUpperCase());
  const aRef = jaTemRef ? '' : ` (ref ${peca.ref})`;

  const text = encodeURIComponent(
    `Olá! Quero conhecer a loja ${s.unit} (vim pelo site). ` +
      `Vi a peça ${peca.nome}${aRef}${oTamanho} e queria saber se tem aí.`,
  );
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
