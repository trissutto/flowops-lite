import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * ⚠️ O merge PRECISA conhecer nossos tokens — senão come classe boa.
 *
 * `text-*` no Tailwind serve pra DUAS coisas: tamanho de fonte (`text-button`)
 * e cor (`text-light`). O tailwind-merge separa as duas pelo nome, mas só
 * conhece os nomes DELE: diante de dois tokens nossos ele assume que são do
 * mesmo grupo e mantém só o último.
 *
 * Resultado real (medido em produção, 03/08): o botão "Adicionar à sacola"
 * saía `bg-ink text-light` do componente e chegava ao DOM como `bg-ink` +
 * `text-button` — texto preto sobre fundo preto, um retângulo cego. Valia
 * pra TODO botão com cor própria, não só esse.
 *
 * Declarando os grupos, `text-button` e `text-light` voltam a conviver.
 */
const FONT_SIZES = ['display', 'h1', 'h2', 'h3', 'h4', 'body', 'body-lg', 'button', 'small', 'caption'];
const CORES = [
  'ink', 'ink-soft', 'ink-muted', 'light', 'dark', 'background', 'surface', 'surface-alt',
  'border', 'border-strong', 'champagne', 'primary', 'primary-soft', 'primary-strong',
  'primary-wash', 'secondary', 'secondary-soft', 'secondary-wash', 'accent', 'accent-wash',
  'success', 'success-strong', 'warning', 'danger', 'info', 'muted',
];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: FONT_SIZES }],
      'text-color': [{ text: CORES }],
    },
  },
});

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

/**
 * "1 peça" / "3 peças" — a contagem que a cliente lê.
 *
 * Existia solta em cada tela, e o botão da sacola (o elemento mais visto do
 * site, em TODAS as páginas) ficou anunciando "Sacola (1 itens)" enquanto a
 * página da sacola dizia "1 peça" logo abaixo. Uma função só, um resultado só.
 */
export function contarPecas(n: number): string {
  return `${n} ${n === 1 ? 'peça' : 'peças'}`;
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
