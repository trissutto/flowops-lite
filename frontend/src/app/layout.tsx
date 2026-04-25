import type { Metadata } from 'next';
import { Cormorant_Garamond, Inter } from 'next/font/google';
import './globals.css';
import TopBreadcrumb from '@/components/TopBreadcrumb';
import NewOrderAlert from '@/components/NewOrderAlert';

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
  description: 'Gestão operacional de pedidos — LURDS',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${display.variable} ${inter.variable}`}>
      <body className="font-sans">
        <TopBreadcrumb />
        {children}
        <NewOrderAlert />
      </body>
    </html>
  );
}
