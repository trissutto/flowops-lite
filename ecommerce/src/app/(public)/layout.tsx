import { Header } from '@/components/navigation/Header';
import { Footer } from '@/components/layout/Footer';
import { MiniCart } from '@/components/commerce/MiniCart';

/**
 * Layout do grupo (public) — todas as páginas de vitrine compartilham
 * header e footer. Grupos (account) e (checkout) terão chrome próprio.
 * O mini-cart mora aqui (montado uma vez) e se controla sozinho pelo uiStore.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header />
      <main id="conteudo">{children}</main>
      <Footer />
      <MiniCart />
    </>
  );
}
