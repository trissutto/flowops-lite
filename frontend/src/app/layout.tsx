import type { Metadata } from 'next';
import './globals.css';
import TopNav from '@/components/TopNav';
import SideNav from '@/components/SideNav';
import NewOrderAlert from '@/components/NewOrderAlert';

export const metadata: Metadata = {
  title: 'LURDS ORDER ONE',
  description: 'Gestão operacional de pedidos — LURDS',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <SideNav />
        {/* md:pl-60 empurra o conteúdo pra não ficar por baixo da sidebar (240px) */}
        <div className="md:pl-60">
          <TopNav />
          {children}
        </div>
        <NewOrderAlert />
      </body>
    </html>
  );
}
