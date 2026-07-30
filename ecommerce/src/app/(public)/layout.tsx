import { Header } from '@/components/navigation/Header';
import { Footer } from '@/components/layout/Footer';

/**
 * Layout do grupo (public) — todas as páginas de vitrine compartilham
 * header e footer. Grupos (account) e (checkout) terão chrome próprio.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header />
      <main id="conteudo">{children}</main>
      <Footer />
    </>
  );
}
