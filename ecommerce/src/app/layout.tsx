import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, Inter, Playfair_Display } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { buildMetadata, jsonLdGraph, organizationSchema, websiteSchema } from '@/lib/seo';
import { consentBootstrapSnippet } from '@/lib/tracking/consent';

/**
 * Playfair Display — títulos. Pesos 400/500/600 e itálico (a palavra de ênfase
 * dos títulos é sempre itálica). `display: swap` pra não bloquear o LCP.
 */
const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-playfair',
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  display: 'swap',
});

/** Cormorant Garamond — assinatura editorial exclusiva das vitrines da home. */
const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  variable: '--font-cormorant',
  weight: ['500'],
  style: ['normal'],
  display: 'swap',
  // Usada nos títulos das prateleiras, sempre abaixo da primeira dobra.
  preload: false,
});

/** Inter — UI e corpo. Light (300) é o peso padrão do texto da marca. */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['300', '400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = buildMetadata({
  title: "Lurd's Plus Size — Moda plus size elegante do 44 ao 60",
  path: '/',
});

export const viewport: Viewport = {
  themeColor: '#fcfaf7',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${playfair.variable} ${cormorant.variable} ${inter.variable}`}>
      <head>
        {/* CONSENT MODE V2 — PRECISA ser o primeiro script da página. O Google
            exige que o estado `default: denied` chegue ANTES do gtag.js; se
            esta ordem inverter, ele assume consentimento concedido e a
            conformidade com a LGPD vira ficção. Não mover daqui. */}
        <script dangerouslySetInnerHTML={{ __html: consentBootstrapSnippet() }} />
        {/* JSON-LD global: Organization + WebSite (SearchAction). Nós de página
            são injetados pela própria página. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdGraph(organizationSchema(), websiteSchema()) }}
        />
      </head>
      <body>
        {/* Skip link — primeiro tabbable da página (WCAG 2.4.1) */}
        <a
          href="#conteudo"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[90] focus:rounded-sm focus:bg-ink focus:px-4 focus:py-2 focus:text-small focus:text-light"
        >
          Pular para o conteúdo
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
