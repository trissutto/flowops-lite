import type { Metadata } from 'next';

/**
 * Painel interno — fora do grupo (public) de propósito: sem header, sem footer,
 * sem chrome de loja. E `noindex` explícito, senão o Google indexa a tela de
 * debug e ela aparece na busca por "lurds busca". Mesma casca dark do
 * /debug/tracking — os painéis internos são UMA família visual.
 */
export const metadata: Metadata = {
  title: 'Busca · Debug',
  robots: { index: false, follow: false, nocache: true },
};

export default function DebugLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[#0f0f12] text-[#e6e6e6]">{children}</div>;
}
