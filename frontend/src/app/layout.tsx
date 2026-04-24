import type { Metadata } from 'next';
import { Playfair_Display, Inter } from 'next/font/google';
import './globals.css';
import TopBreadcrumb from '@/components/TopBreadcrumb';
import NewOrderAlert from '@/components/NewOrderAlert';

// Playfair Display — serif "chique" pra títulos (Bem-vindo, nomes dos cards).
// Inter — sans-serif pra tudo o que é UI, números e labels.
// Ambas via next/font (CSS variables) pra eu poder usar Tailwind normal com
// `font-serif` mapeando pra Playfair.
const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LURDS ORDER ONE',
  description: 'Gestão operacional de pedidos — LURDS',
};

/**
 * RootLayout — sem sidebar lateral fixa.
 *
 * Fontes:
 *   - Playfair Display (serif) → títulos (font-display)
 *   - Inter (sans) → UI geral (padrão do body)
 *
 * Mudança importante: removi SideNav + TopNav antigos. A nav passou pra:
 *   - Home (/) com cards grandes (launchpad premium, sem header próprio)
 *   - TopBreadcrumb nas rotas internas: logo + breadcrumb + home + sair
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${playfair.variable} ${inter.variable}`}>
      <body className="font-sans">
        <TopBreadcrumb />
        {children}
        <NewOrderAlert />
      </body>
    </html>
  );
}
