import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Concatena classes resolvendo conflitos do Tailwind
 * (a última classe do mesmo grupo vence). Use SEMPRE em componentes que
 * aceitam `className` externa, senão a prop do consumidor não sobrescreve.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Formata centavos ou reais em BRL. Preços vêm em REAIS no domínio. */
export function formatPrice(value: number): string {
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  });
}

/** "12x de R$ 24,90" — parcelamento sem juros exibido no card. */
export function formatInstallments(total: number, times = 12): string {
  return `${times}x de ${formatPrice(total / times)}`;
}

/** Desconto percentual arredondado (para etiqueta). */
export function discountPercent(from: number, to: number): number {
  if (from <= 0 || to >= from) return 0;
  return Math.round(((from - to) / from) * 100);
}

/** Normaliza texto pra busca: sem acento, minúsculo. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Slug amigável e estável para URLs (SEO). */
export function slugify(value: string): string {
  return normalize(value)
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** Placeholder blur em tom champagne — evita flash branco no next/image. */
export const BLUR_DATA_URL =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#ede3d3"/><rect width="8" height="3" y="3" fill="#e8dfd0" opacity=".7"/></svg>',
  );

/** Divide um array em N colunas equilibradas (mega menu, footer). */
export function chunkIntoColumns<T>(items: T[], columns: number): T[][] {
  const size = Math.ceil(items.length / columns);
  return Array.from({ length: columns }, (_, i) => items.slice(i * size, (i + 1) * size)).filter(
    (col) => col.length > 0,
  );
}
