import { Header } from '@/components/navigation/Header';
import { Footer } from '@/components/layout/Footer';
import { MiniCart } from '@/components/commerce/MiniCart';
import { getTarjaDoTopo } from '@/services/banners';

/**
 * Layout do grupo (public) — todas as páginas de vitrine compartilham
 * header e footer. Grupos (account) e (checkout) terão chrome próprio.
 * O mini-cart mora aqui (montado uma vez) e se controla sozinho pelo uiStore.
 *
 * As frases da tarja do topo são buscadas AQUI (servidor) e descem por prop: o
 * Header é client e não pode ler o backend. Falha ou lista vazia cai nas
 * frases padrão dentro do próprio componente.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const tarja = await getTarjaDoTopo();

  return (
    <>
      <Header tarja={tarja} />
      <main id="conteudo">{children}</main>
      <Footer />
      <MiniCart />
    </>
  );
}
