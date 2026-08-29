import type { Metadata } from 'next';
import { Anton, Manrope } from 'next/font/google';
import './globals.css';

const display = Anton({ weight: '400', subsets: ['latin'], variable: '--font-display' });
const body = Manrope({ subsets: ['latin'], variable: '--font-body' });

export const metadata: Metadata = {
  metadataBase: new URL('https://www.esquina013.com.br'),
  title: 'Esquina 013 | Lounge • Beach • Bar',
  description: 'Porções, drinks, música e boas histórias — do almoço ao último brinde, em Itanhaém.',
  openGraph: {
    title: 'Esquina 013 | Lounge • Beach • Bar',
    description: 'Seu ponto de encontro em Itanhaém. Porções, drinks, música e boas histórias.',
    url: 'https://www.esquina013.com.br',
    siteName: 'Esquina 013',
    locale: 'pt_BR',
    type: 'website',
    images: [{ url: '/og.png', width: 1536, height: 1024, alt: 'Esquina 013 — Lounge Beach Bar' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Esquina 013 | Lounge • Beach • Bar',
    description: 'Seu ponto de encontro em Itanhaém. Porções, drinks, música e boas histórias.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body className={`${display.variable} ${body.variable}`}>{children}</body></html>;
}
