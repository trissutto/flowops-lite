import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, Inter } from 'next/font/google';
import './globals.css';
import TopBreadcrumb from '@/components/TopBreadcrumb';
import NewOrderAlert from '@/components/NewOrderAlert';
import SupplyRequestAlert from '@/components/SupplyRequestAlert';
import PwaInstallBanner from '@/components/PwaInstallBanner';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import PushSubscriptionManager from '@/components/PushSubscriptionManager';
import ContadorGuard from '@/components/ContadorGuard';

// Cormorant Garamond — serif fina e sofisticada (300/400 disponíveis).
// Trocamos Playfair porque ela pedia peso maior pra ficar legível; Cormorant
// tem um traço mais leve que combina com o design "boutique de luxo".
const display = Cormorant_Garamond({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['300', '400', '500', '600'],
  style: ['normal', 'italic'],
  display: 'swap',
});

// Inter com pesos thin/extralight pra UI minimalista.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  weight: ['200', '300', '400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LURDS ORDER ONE',
  description: 'Gestão operacional Lurd\'s Plus Size — PDV, transferências, imobiliário',
  // PWA — quando vendedora clica em "Instalar app" no Chrome, esses metadados
  // dão o nome, ícone e cores corretos do app instalado na home screen.
  manifest: '/manifest.webmanifest',
  applicationName: 'LURDS ORDER ONE',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Order One',
  },
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
};

// Viewport separado (Next 14 best practice — não vai mais dentro do Metadata).
// theme-color = barra superior do Android quando o PWA tá aberto.
export const viewport: Viewport = {
  themeColor: '#7c3aed',
  width: 'device-width',
  initialScale: 1,
  // Permite pinch-zoom até 5x — fallback de acessibilidade caso ainda
  // tenha algum lugar pequeno que não dê pra ler. Antes estava travado
  // em 1x (maximumScale: 1, userScalable: false), o que impedia até a
  // ampliação manual quando o layout era pequeno demais.
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover', // notch do iPhone respeitado
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${display.variable} ${inter.variable}`}>
      <body className="font-sans">
        <ContadorGuard />
        <TopBreadcrumb />
        {children}
        <NewOrderAlert />
        <SupplyRequestAlert />
        <PwaInstallBanner />
        <PushSubscriptionManager />
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
