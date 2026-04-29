'use client';

/**
 * /config — Hub CONFIG (setup técnico do sistema).
 *
 * Concentra tudo que é cadastro/configuração e raramente muda:
 *   - Cadastros (Lojas, Usuários, Vendedoras)
 *   - Integrações fiscais e de pagamento (NFC-e, PagBank, Pagar.me)
 *   - Conexões externas (WhatsApp/Baileys)
 *   - Configurações gerais
 *
 * Substitui o antigo hub /sistema (que ficou órfão) e absorve os cards
 * de configuração que estavam misturados em /retaguarda.
 *
 * Apenas matriz (admin/operator) — backend tem @AdminOnly nos endpoints.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Settings, Store, UserCog, Activity, Receipt, CreditCard, QrCode,
  MessageCircle, Boxes, Users, Shield,
} from 'lucide-react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';
import CircleNav, { type CircleNavItem } from '@/components/CircleNav';

const CONFIG_ITEMS: CircleNavItem[] = [
  // === Cadastros estruturais ===
  { href: '/lojas',                     label: 'Lojas',         subtitle: 'Cadastro da rede',         icon: Store,          tone: 'rose'     },
  { href: '/usuarios',                  label: 'Usuários',      subtitle: 'Acesso e permissões',      icon: UserCog,        tone: 'sky'      },
  { href: '/retaguarda/vendedoras',     label: 'Vendedoras',    subtitle: 'Cadastro · admin',         icon: Users,          tone: 'coral'    },
  { href: '/retaguarda/almoxarifado',   label: 'Almoxarifado',  subtitle: 'Itens internos',           icon: Boxes,          tone: 'lavender' },

  // === Fiscal + Pagamentos (PDV) ===
  { href: '/retaguarda/nfce-config',    label: 'NFC-e',         subtitle: 'Certificado A1 + CSC',     icon: Receipt,        tone: 'rose'     },
  { href: '/retaguarda/pagarme-config', label: 'Pagar.me',      subtitle: 'PIX no PDV (recomendado)', icon: CreditCard,     tone: 'mint'     },
  { href: '/retaguarda/pagbank-config', label: 'PagBank',       subtitle: 'PIX (homologação)',        icon: QrCode,         tone: 'sky'      },

  // === Integrações ===
  { href: '/retaguarda/whatsapp',       label: 'WhatsApp',      subtitle: 'Baileys + bulk',           icon: MessageCircle,  tone: 'mint'     },

  // === Sistema ===
  { href: '/configuracoes',             label: 'Configurações', subtitle: 'Prioridades, integrações', icon: Settings,       tone: 'lavender' },
  { href: '/logs',                      label: 'Logs',          subtitle: 'Eventos do sistema',       icon: Activity,       tone: 'peach'    },
];

export default function ConfigHub() {
  const router = useRouter();

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    api<{ role: string }>('/auth/me')
      .then((me) => {
        // Filial não vê config — manda direto pro PDV
        if (me.role === 'store') router.push('/minha-loja/pdv');
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PastelShell
      title="Config"
      subtitle="Setup técnico · cadastros · integrações"
      icon={Shield}
      tone="lavender"
      backHref="/"
      withPanel
    >
      <CircleNav items={CONFIG_ITEMS} size="lg" />
    </PastelShell>
  );
}
