import type { ReactNode } from 'react';
import ProdutoEstoqueShell from '@/features/produto-estoque/components/ProdutoEstoqueShell';

export default function ProdutoEstoqueLayout({ children }: { children: ReactNode }) {
  return <ProdutoEstoqueShell>{children}</ProdutoEstoqueShell>;
}
