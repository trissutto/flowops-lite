'use client';

/**
 * /retaguarda/enviados-hoje (DEPRECATED)
 *
 * Tela foi promovida a aba dentro de /separacao (Emissão de Separações).
 * Esse arquivo agora só redireciona pra lá — mantém compat de bookmark/histórico.
 *
 * Componente de fato vive em `@/components/EnviadosByStore`.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function EnviadosHojeRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/separacao?tab=enviados');
  }, [router]);

  return (
    <div className="p-12 text-center text-gray-500">
      <Loader2 className="w-6 h-6 animate-spin inline-block" />
      <div className="mt-2 text-sm">
        A tela &quot;Enviados por Loja&quot; agora é uma aba em{' '}
        <span className="font-semibold">Emissão de Separações</span>. Redirecionando…
      </div>
    </div>
  );
}
