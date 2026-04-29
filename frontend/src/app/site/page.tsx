'use client';

/**
 * /site — Hub SITE (e-commerce online).
 *
 * Reúne tudo que é tocado pelo time/canal online: pedidos do WC, marketing,
 * vendedoras (atribuição de venda), publicação de produto novo, catálogo WC,
 * baixas (auditoria ERP→WC), WhatsApp e a vitrine pública.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  ClipboardList, Megaphone, Users, Globe, ShoppingBag,
  FileSearch, MessageCircle, Store, Globe2, ArrowRightLeft,
} from 'lucide-react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';
import CircleNav, { type CircleNavItem } from '@/components/CircleNav';

const SITE_ITEMS: CircleNavItem[] = [
  { href: '/separacao',             label: 'Pedidos',         subtitle: 'Separação e envio',     icon: ClipboardList, tone: 'rose'     },
  { href: '/marketing',             label: 'Marketing',       subtitle: 'CRM + recuperação',     icon: Megaphone,     tone: 'sky'      },
  { href: '/retaguarda/vendedoras', label: 'Vendedoras',      subtitle: 'Atribuição de venda',   icon: Users,         tone: 'coral'    },
  { href: '/retaguarda/publicar-site', label: 'Publicar no Site', subtitle: 'Cadastros via IA',  icon: Globe,         tone: 'mint'     },
  { href: '/produtos',              label: 'Produtos Site',   subtitle: 'Catálogo WooCommerce',  icon: ShoppingBag,   tone: 'lavender' },
  { href: '/retaguarda/baixas-log', label: 'Log de Baixas',   subtitle: 'Auditoria ERP→WC',      icon: FileSearch,    tone: 'peach'    },
  { href: '/site/trocas',           label: 'Trocas Site',     subtitle: 'Devolução pedidos WC',  icon: ArrowRightLeft, tone: 'rose'    },
  { href: '/config/whatsapp',       label: 'WhatsApp',        subtitle: 'Conexão + bulk',        icon: MessageCircle, tone: 'mint'     },
  { href: '/vitrine',               label: 'Vitrine',         subtitle: 'Vitrine pública',       icon: Store,         tone: 'cream'    },
];

export default function SiteHub() {
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
      title="Site"
      subtitle="E-commerce · marketing · WhatsApp · vitrine"
      icon={Globe2}
      tone="sky"
      backHref="/"
      withPanel
    >
      <CircleNav items={SITE_ITEMS} size="lg" />
    </PastelShell>
  );
}
