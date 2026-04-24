'use client';

/**
 * DEPRECATED — Tela de PDF removida no pivot #168..#172.
 *
 * O realinhamento agora é 100% in-app: a matriz confirma e a loja origem
 * recebe um alerta no /minha-loja com a tela de separação. Sem PDF,
 * sem WhatsApp. Essa rota existe só como redirect de compatibilidade
 * pra quem tinha bookmark antigo.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function DeprecatedImprimirRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/retaguarda/realinhamento');
  }, [router]);
  return (
    <div className="max-w-xl mx-auto p-8 text-center text-sm text-slate-600">
      Essa tela foi descontinuada. Redirecionando pro módulo de realinhamento...
    </div>
  );
}
