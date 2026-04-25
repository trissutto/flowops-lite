'use client';

/**
 * /retaguarda — Hub de retaguarda (visual pastel + botões circulares).
 *
 * Tela intermediária entre a home e os módulos individuais. Mantém o mesmo
 * conjunto de módulos, agora apresentados como um launchpad pastel estilo
 * tablet (HS-Net inspired).
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileSearch, CheckCircle2, Package2, Boxes, Globe, Smartphone,
  Database, Users, Shuffle, Layers,
} from 'lucide-react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';
import CircleNav, { type CircleNavItem } from '@/components/CircleNav';

const RETAGUARDA_ITEMS: CircleNavItem[] = [
  { href: '/retaguarda/baixas-log',      label: 'Log de Baixas',     subtitle: 'Auditoria ERP',      icon: FileSearch,    tone: 'rose' },
  { href: '/retaguarda/venda-certa',     label: 'Venda Certa',       subtitle: 'Anti-malandragem',   icon: CheckCircle2,  tone: 'mint' },
  { href: '/retaguarda/materiais',       label: 'Materiais',         subtitle: 'Pedidos das filiais', icon: Package2,     tone: 'peach' },
  { href: '/retaguarda/almoxarifado',    label: 'Almoxarifado',      subtitle: 'Estoque interno',    icon: Boxes,         tone: 'lavender' },
  { href: '/retaguarda/publicar-site',   label: 'Publicar no Site',  subtitle: 'Cadastros via IA',   icon: Globe,         tone: 'sky' },
  { href: '/retaguarda/whatsapp',        label: 'WhatsApp',          subtitle: 'Conexão + bulk',     icon: Smartphone,    tone: 'mint' },
  { href: '/retaguarda/diagnostico-erp', label: 'Diagnóstico ERP',   subtitle: 'Auditoria SKU',      icon: Database,      tone: 'yellow' },
  { href: '/retaguarda/vendedoras',      label: 'Vendedoras',        subtitle: 'Karine, Manu…',      icon: Users,         tone: 'coral' },
  { href: '/retaguarda/realinhamento',   label: 'Realinhamento',     subtitle: 'Rebalancear estoque', icon: Shuffle,      tone: 'cream' },
];

export default function RetaguardaHub() {
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
      title="Retaguarda"
      subtitle="Materiais · baixas · ERP · site · WhatsApp"
      icon={Layers}
      tone="peach"
      backHref="/"
      withPanel
    >
      <CircleNav items={RETAGUARDA_ITEMS} size="lg" />
    </PastelShell>
  );
}
