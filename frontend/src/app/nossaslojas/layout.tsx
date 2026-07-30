import { Playfair_Display } from 'next/font/google';
import './lojas.css';

// Playfair Display só nesta rota — o resto do app segue com Cormorant.
const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-playfair',
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  display: 'swap',
});

export default function NossasLojasLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${playfair.variable} lojas-root`}>{children}</div>;
}
