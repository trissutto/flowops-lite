'use client';

/**
 * /loja — Hub LOJA (operação física + ERP Gigasistemas).
 *
 * Reúne os módulos que tratam estoque físico, transferências entre filiais,
 * crediário, almoxarifado e materiais (suprimentos das lojas).
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Shuffle, Database, CreditCard, Boxes, CheckCircle2, Package2, Store, FileSearch, Truck, BarChart3,
} from 'lucide-react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';
import CircleNav, { type CircleNavItem } from '@/components/CircleNav';

const LOJA_ITEMS: CircleNavItem[] = [
  { href: '/retaguarda/inteligencia-estoque', label: 'Inteligência',   subtitle: 'Estoque + venda em real-time', icon: BarChart3,    tone: 'lavender' },
  { href: '/retaguarda/realinhamento', label: 'Realinhamento',  subtitle: 'Rebalancear estoque',   icon: Shuffle,      tone: 'coral'    },
  { href: '/retaguarda/remessas',      label: 'Remessas',       subtitle: 'Caixas em trânsito',    icon: Truck,        tone: 'sky'      },
  { href: '/auditoria-sku',            label: 'Produtos Loja',  subtitle: 'Gigasistemas (ERP)',    icon: Database,     tone: 'yellow'   },
  { href: '/retaguarda/crediario',     label: 'Crediário',      subtitle: 'Cobrança + parcelas',   icon: CreditCard,   tone: 'rose'     },
  { href: '/retaguarda/almoxarifado',  label: 'Almoxarifado',   subtitle: 'Estoque interno',       icon: Boxes,        tone: 'lavender' },
  { href: '/retaguarda/venda-certa',   label: 'Venda Certa',    subtitle: 'Anti-malandragem',      icon: CheckCircle2, tone: 'mint'     },
  { href: '/retaguarda/materiais',     label: 'Materiais',      subtitle: 'Pedidos das filiais',   icon: Package2,     tone: 'peach'    },
  { href: '/relatorios/giga',          label: 'Giga Explorer',  subtitle: 'SQL ERP em tempo real', icon: FileSearch,   tone: 'yellow'   },
];

export default function LojaHub() {
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
      title="Loja"
      subtitle="Estoque · ERP · crediário · almoxarifado"
      icon={Store}
      tone="peach"
      backHref="/"
      withPanel
    >
      <CircleNav items={LOJA_ITEMS} size="lg" />
    </PastelShell>
  );
}
