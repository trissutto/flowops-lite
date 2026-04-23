import type { Metadata } from 'next';
import './globals.css';
import TopBreadcrumb from '@/components/TopBreadcrumb';
import NewOrderAlert from '@/components/NewOrderAlert';

export const metadata: Metadata = {
  title: 'LURDS ORDER ONE',
  description: 'Gestão operacional de pedidos — LURDS',
};

/**
 * RootLayout — sem sidebar lateral fixa.
 *
 * Mudança importante: removi SideNav + TopNav antigos. A nav passou pra:
 *   - Home (/) com cards grandes coloridos (launchpad, sem header próprio)
 *   - TopBreadcrumb nas rotas internas: logo + breadcrumb + home + sair
 *
 * A SideNav antiga continua no repositório mas não é mais montada no layout —
 * deixei arquivada pra reverter rápido se precisar. Se quiser apagar de vez,
 * remove /components/SideNav.tsx e /components/TopNav.tsx.
 *
 * PILOTO AUTOMÁTICO: o Runner client-side foi removido — agora o backend
 * (PilotService + WcPoller) faz o disparo server-side sem depender de aba
 * aberta. Kill-switch via env PILOT_DISABLED=1 ou PATCH /pilot/toggle {on:false}.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <TopBreadcrumb />
        {children}
        <NewOrderAlert />
      </body>
    </html>
  );
}
