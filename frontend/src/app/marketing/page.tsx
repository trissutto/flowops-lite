'use client';

/**
 * /marketing — Hub unificado de marketing/vendas.
 *
 * Juntou as 3 telas que antes viviam separadas no TopNav:
 *   - CRM (segmentação RFM)
 *   - Carrinhos abandonados
 *   - Recuperação manual WhatsApp
 *
 * Cada aba renderiza o componente default da tela original, sem refatoração.
 * As URLs antigas (/crm/segmentos, /carrinhos-abandonados, /marketing/recuperacao)
 * continuam funcionando, mas o TopNav agora aponta só pra /marketing.
 *
 * Aba ativa persiste via query param ?tab= pra funcionar com back/forward do browser
 * e compartilhar link direto pra uma aba específica.
 */

import { Suspense, useMemo } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { Users, ShoppingCart, MessageCircle, Filter } from 'lucide-react';

// Reaproveita os componentes default das telas existentes.
// Todos são 'use client' e cuidam da própria busca de dados.
import SegmentosPage from '../crm/segmentos/page';
import ListaPersonalizadaPage from '../crm/lista-personalizada/page';
import CarrinhosAbandonadosPage from '../carrinhos-abandonados/page';
import RecuperacaoPage from './recuperacao/page';

type TabKey = 'segmentos' | 'personalizada' | 'carrinhos' | 'recuperacao';

const TABS: { key: TabKey; label: string; icon: typeof Users }[] = [
  { key: 'segmentos',     label: 'Segmentos (CRM)',       icon: Users },
  { key: 'personalizada', label: 'Lista Personalizada',   icon: Filter },
  { key: 'carrinhos',     label: 'Carrinhos Abandonados', icon: ShoppingCart },
  { key: 'recuperacao',   label: 'Recuperação WhatsApp',  icon: MessageCircle },
];

function MarketingHubInner() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const raw = params?.get('tab') ?? 'segmentos';
  const active: TabKey = useMemo(() => {
    return (TABS.find((t) => t.key === raw)?.key ?? 'segmentos') as TabKey;
  }, [raw]);

  function go(tab: TabKey) {
    const qs = new URLSearchParams(params?.toString() ?? '');
    qs.set('tab', tab);
    router.replace(`${pathname}?${qs.toString()}`);
  }

  return (
    <div>
      {/* Tabs sticky abaixo do TopNav */}
      <div className="bg-white border-b shadow-sm sticky top-[72px] z-30">
        <div className="max-w-7xl mx-auto px-6 flex gap-1 overflow-x-auto">
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = active === t.key;
            return (
              <button
                key={t.key}
                onClick={() => go(t.key)}
                className={`flex items-center gap-2 px-4 py-3 text-sm whitespace-nowrap border-b-2 transition ${
                  isActive
                    ? 'border-brand text-brand font-bold'
                    : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <Icon className="w-4 h-4" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Conteúdo da aba */}
      <div>
        {active === 'segmentos'     && <SegmentosPage />}
        {active === 'personalizada' && <ListaPersonalizadaPage />}
        {active === 'carrinhos'     && <CarrinhosAbandonadosPage />}
        {active === 'recuperacao'   && <RecuperacaoPage />}
      </div>
    </div>
  );
}

export default function MarketingHub() {
  // useSearchParams precisa estar dentro de <Suspense> no Next 14 App Router.
  return (
    <Suspense fallback={<div className="p-8 text-slate-400">Carregando…</div>}>
      <MarketingHubInner />
    </Suspense>
  );
}
