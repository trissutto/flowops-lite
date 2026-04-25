'use client';

/**
 * /sistema — Hub de sistema (visual pastel + botões circulares).
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Settings, Store, UserCog, Shield, Activity,
} from 'lucide-react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';
import CircleNav, { type CircleNavItem } from '@/components/CircleNav';

const SISTEMA_ITEMS: CircleNavItem[] = [
  { href: '/configuracoes', label: 'Configurações', subtitle: 'Prioridades, integrações', icon: Settings, tone: 'lavender' },
  { href: '/lojas',         label: 'Lojas',          subtitle: 'Cadastro da rede',        icon: Store,    tone: 'rose' },
  { href: '/usuarios',      label: 'Usuários',       subtitle: 'Acesso e permissões',     icon: UserCog,  tone: 'sky' },
  { href: '/admin',         label: 'Admin',          subtitle: 'Ações avançadas',         icon: Shield,   tone: 'coral' },
  { href: '/logs',          label: 'Logs',           subtitle: 'Eventos do sistema',      icon: Activity, tone: 'mint' },
];

export default function SistemaHub() {
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
      title="Sistema"
      subtitle="Configurações · lojas · usuários · logs"
      icon={Settings}
      tone="lavender"
      backHref="/"
      withPanel
    >
      <CircleNav items={SISTEMA_ITEMS} size="lg" />
    </PastelShell>
  );
}
