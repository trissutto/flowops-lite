'use client';

/**
 * /configuracoes — Hub de Administração/Manutenção.
 *
 * Juntou as 4 telas que antes viviam separadas no TopNav:
 *   - Usuários
 *   - Lojas
 *   - Logs
 *   - Auditoria SKU
 *
 * São telas de uso esporádico (admin/manutenção), então faz mais sentido
 * ficarem agrupadas num único ponto de entrada.
 *
 * Cada aba renderiza o componente default da tela original, sem refatoração.
 * As URLs antigas (/usuarios, /lojas, /logs, /auditoria-sku) continuam
 * funcionando — o TopNav agora aponta só pra /configuracoes.
 *
 * Aba ativa persiste via query param ?tab= pra funcionar com back/forward
 * do browser e permitir compartilhar link direto pra uma aba específica.
 */

import { Suspense, useMemo } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { Users, Store, FileText, ShieldCheck } from 'lucide-react';

// Reaproveita os componentes default das telas existentes.
import UsuariosPage from '../usuarios/page';
import LojasPage from '../lojas/page';
import AuditoriaSkuPage from '../auditoria-sku/page';

// NOTA: /logs/page.tsx estava untrackeado no git (caiu no gitignore `logs/`)
// e quebrava o build no Vercel. Inlinado aqui temporariamente até o arquivo
// ser forçado pro remote com `git add -f frontend/src/app/logs/page.tsx`.
function LogsPage() {
  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-4">Logs de integração</h1>
      <p className="text-slate-600">
        Em breve: tabela com eventos in/out do WooCommerce e ERP, filtros por data e
        destaque para erros.
      </p>
    </div>
  );
}

type TabKey = 'usuarios' | 'lojas' | 'logs' | 'auditoria';

const TABS: { key: TabKey; label: string; icon: typeof Users }[] = [
  { key: 'usuarios',  label: 'Usuários',      icon: Users },
  { key: 'lojas',     label: 'Lojas',         icon: Store },
  { key: 'logs',      label: 'Logs',          icon: FileText },
  { key: 'auditoria', label: 'Auditoria SKU', icon: ShieldCheck },
];

function ConfiguracoesHubInner() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const raw = params?.get('tab') ?? 'usuarios';
  const active: TabKey = useMemo(() => {
    return (TABS.find((t) => t.key === raw)?.key ?? 'usuarios') as TabKey;
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
        {active === 'usuarios'  && <UsuariosPage />}
        {active === 'lojas'     && <LojasPage />}
        {active === 'logs'      && <LogsPage />}
        {active === 'auditoria' && <AuditoriaSkuPage />}
      </div>
    </div>
  );
}

export default function ConfiguracoesHub() {
  return (
    <Suspense fallback={<div className="p-8 text-slate-400">Carregando…</div>}>
      <ConfiguracoesHubInner />
    </Suspense>
  );
}
