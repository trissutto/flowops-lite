import type { Metadata, Viewport } from 'next';

/**
 * Layout de /minha-loja/ponto-celular — troca o manifest PWA pelo DEDICADO
 * do ponto (manifest-ponto.webmanifest, start_url nesta tela, ícone próprio
 * de relógio dourado). Assim, quando a loja faz "Adicionar à tela inicial"
 * A PARTIR DESTA PÁGINA, nasce um app "Ponto" que abre direto na câmera —
 * separado do app geral "Order One" (que continua com o manifest da raiz).
 */
export const metadata: Metadata = {
  title: "Ponto Lurd's",
  manifest: '/manifest-ponto.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Ponto',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  themeColor: '#0f172a',
};

export default function PontoCelularLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Captura o beforeinstallprompt ANTES do React hidratar. O Chrome
          dispara esse evento cedo — se só o useEffect da página escutasse,
          perdia o evento em celular lento e o botão "Instalar" nunca
          aparecia (bug relatado 29/07). Guarda em window.__pontoBip e avisa
          a página via CustomEvent caso ela já esteja montada. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__pontoBip=e;try{window.dispatchEvent(new CustomEvent('ponto:bip'))}catch(x){}});`,
        }}
      />
      {children}
    </>
  );
}
