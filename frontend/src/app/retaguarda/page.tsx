'use client';

/**
 * /retaguarda — Hub RETAGUARDA (admin do sistema).
 *
 * Reorganizado: agora /retaguarda é a área de configuração técnica do sistema
 * (configs, lojas cadastradas, usuários e logs). Os módulos operacionais
 * (whatsapp, baixas-log, materiais, almoxarifado, vendedoras, publicar-site,
 * realinhamento, venda-certa) continuam sendo acessados pelas suas URLs
 * /retaguarda/* — agora linkadas a partir dos hubs /site e /loja.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Shield, LayoutDashboard,
} from 'lucide-react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';
import CircleNav, { type CircleNavItem } from '@/components/CircleNav';

// REORG-F3 · "Retaguarda" foi rebrandeada pra "Gestão" (URL preservada).
// Itens de configuração/cadastro foram movidos pra /config:
//   NFC-e, PagBank, Pagar.me, Configurações, Lojas, Usuários, Logs.
// Trocas Site foi pro hub /site. Juros Crediário foi pro hub /loja.
const RETAGUARDA_ITEMS: CircleNavItem[] = [
  { href: '/retaguarda/dashboard', label: 'Dashboard',     subtitle: 'Visão geral da operação', icon: LayoutDashboard, tone: 'sky'  },
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
      subtitle="Configurações · lojas · usuários · logs"
      icon={Shield}
      tone="lavender"
      backHref="/"
      withPanel
    >
      <CircleNav items={RETAGUARDA_ITEMS} size="lg" />
    </PastelShell>
  );
}
