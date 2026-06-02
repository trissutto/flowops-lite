'use client';

/**
 * /clientes — DEPRECATED
 *
 * Essa tela antiga agregava clientes a partir da tabela Order (WooCommerce)
 * — sem perfil, cashback ou tier. Foi substituída pelo CRM completo em
 * /clientes-crm que tem todos esses dados + Giga + cadastros PDV unificados.
 *
 * Aqui só redireciona automaticamente. URL antiga mantida pra não quebrar
 * links salvos em favoritos.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Users, ArrowRight, Loader2 } from 'lucide-react';
import Link from 'next/link';

export default function ClientesLegacyRedirect() {
  const router = useRouter();

  useEffect(() => {
    // Auto-redirect após 1.5s (dá tempo do user ler a mensagem)
    const t = setTimeout(() => {
      router.replace('/clientes-crm');
    }, 1500);
    return () => clearTimeout(t);
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center">
        <div className="w-16 h-16 rounded-full bg-purple-100 flex items-center justify-center mx-auto mb-4">
          <Users className="w-8 h-8 text-purple-700" />
        </div>

        <h1 className="text-2xl font-bold text-slate-900 mb-2">
          Migramos a tela de clientes
        </h1>

        <p className="text-sm text-slate-600 mb-6">
          O CRM completo está em <code className="bg-slate-100 px-1.5 py-0.5 rounded text-purple-700 font-mono">/clientes-crm</code> com perfil,
          cashback, tier, histórico unificado (Giga + Site + PDV) e segmentação.
        </p>

        <div className="flex items-center justify-center gap-2 text-xs text-slate-500 mb-5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Redirecionando…
        </div>

        <Link
          href="/clientes-crm"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-purple-700 hover:bg-purple-800 text-white font-bold text-sm rounded-lg"
        >
          Ir agora <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </div>
  );
}
