import type { Metadata, Viewport } from 'next';
import { Inter, Playfair_Display } from 'next/font/google';
import Script from 'next/script';
import './globals.css';
import { CartProvider } from '@/contexts/CartContext';

// Tipografia — combina logo cursivo (serif) com botões legíveis (sans)
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});
const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
  style: ['normal', 'italic'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://app.lurds.com.br'),
  title: {
    default: "Lurd's Plus Size — Moda Plus com Cashback",
    template: "%s · Lurd's",
  },
  description:
    "Promoções exclusivas, cashback que volta, lives ao vivo e pedidos diretos. Instala o app Lurd's Plus Size e ganhe R$ 20 na primeira compra.",
  applicationName: "Lurd's Plus Size",
  appleWebApp: {
    capable: true,
    title: "Lurd's",
    statusBarStyle: 'black-translucent',
  },
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
    shortcut: '/favicon.ico',
  },
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    siteName: "Lurd's Plus Size",
    title: "Lurd's Plus Size — Moda Plus com Cashback",
    description:
      'Promoções exclusivas, cashback, lives e pedidos no app. R$ 20 grátis na 1ª compra.',
    images: [{ url: '/icons/icon-512.png', width: 512, height: 512 }],
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0A0A0A',
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${playfair.variable}`}>
      <head>
        {/* iOS PWA splash hint */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Lurd's" />
      </head>
      <body>
        <CartProvider>
          <div className="app-container">{children}</div>
        </CartProvider>

        {/* Registra Service Worker depois do load (não bloqueia first paint) */}
        <Script id="register-sw" strategy="afterInteractive">
          {`
            if ('serviceWorker' in navigator) {
              window.addEventListener('load', () => {
                navigator.serviceWorker.register('/sw.js', { scope: '/' })
                  .then((reg) => console.log('[SW] registrado:', reg.scope))
                  .catch((err) => console.warn('[SW] falhou:', err));
              });
            }
          `}
        </Script>
      </body>
    </html>
  );
}
