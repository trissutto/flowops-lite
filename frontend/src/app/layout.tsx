import type { Metadata } from 'next';
import './globals.css';
import TopNav from '@/components/TopNav';
import NewOrderAlert from '@/components/NewOrderAlert';

export const metadata: Metadata = {
  title: 'FlowOps',
  description: 'Gestão operacional de pedidos',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <TopNav />
        {children}
        <NewOrderAlert />
      </body>
    </html>
  );
}
