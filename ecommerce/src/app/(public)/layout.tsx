import { Header } from '@/components/navigation/Header';
import { Footer } from '@/components/layout/Footer';
import { DeferredCommerceOverlays } from '@/components/commerce/DeferredCommerceOverlays';
import { DeferredAssistenteWidget } from '@/components/chat/DeferredAssistenteWidget';
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
      {/* Uma instância de cada overlay, carregada depois do LCP ou na primeira
          intenção de uso. Os stores continuam compartilhados por todo card. */}
      <DeferredCommerceOverlays />
      {/* Atendimento: bolha fixa em todas as páginas da vitrine. */}
      <DeferredAssistenteWidget />
      {/* Cupom de boas-vindas REMOVIDO do ar (20/08 — travava a tela em
          produção). Os componentes seguem em components/marketing/ caso o
          dono queira reativar depois de corrigir. */}
    </>
  );
}
