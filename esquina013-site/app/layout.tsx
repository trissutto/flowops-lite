import type { Metadata } from 'next';
import { Anton, Manrope } from 'next/font/google';
import './globals.css';

const display = Anton({ weight: '400', subsets: ['latin'], variable: '--font-display' });
const body = Manrope({ subsets: ['latin'], variable: '--font-body' });

export const metadata: Metadata = {
  metadataBase: new URL('https://www.esquina013.com.br'),
  title: 'Esquina 013 | Lounge • Beach • Bar',
  description: 'Gastronomia, drinks e música em uma experiência urbana com alma de praia, em Itanhaém.',
  openGraph: {
    title: 'Esquina 013 | Lounge • Beach • Bar',
    description: 'A noite começa na esquina. Gastronomia, drinks e música em Itanhaém.',
    url: 'https://www.esquina013.com.br',
    siteName: 'Esquina 013',
    locale: 'pt_BR',
    type: 'website',
    images: [{ url: '/og.png', width: 1536, height: 1024, alt: 'Esquina 013 — Lounge Beach Bar' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Esquina 013 | Lounge • Beach • Bar',
    description: 'A noite começa na esquina. Gastronomia, drinks e música em Itanhaém.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body className={`${display.variable} ${body.variable}`}>{children}</body></html>;
}
