import type { SVGProps } from 'react';

/**
 * ÍCONES DE MARCA
 *
 * O lucide-react 1.x removeu os ícones de marcas (Instagram, WhatsApp…) por
 * questão de trademark. Como o projeto exige um único vocabulário visual de
 * ícone, estes glifos seguem exatamente a especificação do Lucide: grade
 * 24×24, `stroke="currentColor"`, `fill="none"`, linecap/linejoin redondos e
 * `strokeWidth` configurável (padrão 2, como na biblioteca).
 *
 * NÃO adicionar ícones não-marca aqui — esses vêm do lucide-react.
 */

type GlyphProps = SVGProps<SVGSVGElement> & { strokeWidth?: number | string };

const BASE = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function InstagramIcon({ strokeWidth = 2, ...props }: GlyphProps) {
  return (
    <svg {...BASE} strokeWidth={strokeWidth} aria-hidden {...props}>
      <rect width="20" height="20" x="2" y="2" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M17.5 6.5h.01" />
    </svg>
  );
}

export function WhatsAppIcon({ strokeWidth = 2, ...props }: GlyphProps) {
  return (
    <svg {...BASE} strokeWidth={strokeWidth} aria-hidden {...props}>
      <path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20.5l1.7-5.2A8.5 8.5 0 1 1 21 11.5Z" />
      <path d="M8.8 9.2c.3 2.2 2.1 4 4.3 4.3l1-1.2 1.9.8-.3 1.6c-2.9.4-6.6-2.9-7.5-6.2l1.6-.4.8 1.9-1.8-.8Z" />
    </svg>
  );
}
