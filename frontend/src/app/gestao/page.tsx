'use client';

/**
 * /gestao — Hub de gestão (visual pastel + botões circulares).
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  DollarSign, ShoppingBag, Users, Megaphone, TrendingUp,
} from 'lucide-react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';
import CircleNav, { type CircleNavItem } from '@/components/CircleNav';

const GESTAO_ITEMS: CircleNavItem[] = [
  { href: '/financeiro',            label: 'Financeiro',           subtitle: 'Faturamento + recebíveis', icon: DollarSign, tone: 'mint' },
  { href: '/produtos',              label: 'Produtos',             subtitle: 'Sync + variações',         icon: ShoppingBag, tone: 'rose' },
  { href: '/clientes',              label: 'Clientes',             subtitle: 'CRM + compras',            icon: Users,       tone: 'sky' },
  { href: '/marketing',             label: 'Marketing',            subtitle: 'Recuperação + campanhas',  icon: Megaphone,   tone: 'peach' },
  { href: '/relatorios/vendedoras', label: 'Vendas por Vendedora', subtitle: 'Ranking mensal + CSV',     icon: TrendingUp,  tone: 'lavender' },
];

export default function GestaoHub() {
  const router = useRouter();

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    api<{ role: string }>('/auth/me')
      .then((me) => { if (me.role === 'store') router.push('/minha-loja'); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PastelShell
      title="Gestão"
      subtitle="Financeiro · produtos · CRM · marketing"
      icon={TrendingUp}
      tone="mint"
      backHref="/"
      withPanel
    >
      <CircleNav items={GESTAO_ITEMS} size="lg" />
    </PastelShell>
  );
}
