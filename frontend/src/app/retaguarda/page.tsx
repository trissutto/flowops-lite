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
  Settings, Store, UserCog, Activity, Shield, Receipt, ArrowRightLeft,
} from 'lucide-react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';
import CircleNav, { type CircleNavItem } from '@/components/CircleNav';

const RETAGUARDA_ITEMS: CircleNavItem[] = [
  { href: '/configuracoes',            label: 'Configurações', subtitle: 'Prioridades, integrações', icon: Settings,       tone: 'lavender' },
  { href: '/lojas',                    label: 'Lojas',         subtitle: 'Cadastro da rede',         icon: Store,          tone: 'rose'     },
  { href: '/usuarios',                 label: 'Usuários',      subtitle: 'Acesso e permissões',      icon: UserCog,        tone: 'sky'      },
  { href: '/retaguarda/trocas-site',   label: 'Trocas Site',   subtitle: 'Devolução pedidos WC',     icon: ArrowRightLeft, tone: 'mint'     },
  { href: '/retaguarda/nfce-config',   label: 'NFC-e',         subtitle: 'Certificado A1 + CSC',     icon: Receipt,        tone: 'rose'     },
  { href: '/logs',                     label: 'Logs',          subtitle: 'Eventos do sistema',       icon: Activity,       tone: 'mint'     },
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
