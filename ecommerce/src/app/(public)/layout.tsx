import { Header } from '@/components/navigation/Header';
import { Footer } from '@/components/layout/Footer';
import { MiniCart } from '@/components/commerce/MiniCart';
import { QuickAddSheet } from '@/components/commerce/QuickAddSheet';
import { AssistenteWidget } from '@/components/chat/AssistenteWidget';
import { getTarjaDoTopo } from '@/services/banners';
import { getNavegacao } from '@/services/categorias-menu';

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
  const [tarja, navegacao] = await Promise.all([getTarjaDoTopo(), getNavegacao()]);

  return (
    <>
      <Header tarja={tarja} navegacao={navegacao} />
      <main id="conteudo">{children}</main>
      <Footer />
      <MiniCart />
      {/* Uma instância só: o botão da sacolinha nasce em todo card (vitrine,
          carrossel, busca) e todos falam com este mesmo store. */}
      <QuickAddSheet />
      {/* Atendimento: bolha fixa em todas as páginas da vitrine. */}
      <AssistenteWidget />
    </>
  );
}
