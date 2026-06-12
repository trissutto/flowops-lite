'use client';
import { useEffect, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * /cadastro — DEPRECATED. Redireciona pro novo fluxo unificado /entrar.
 * Mantida pra não quebrar links antigos.
 */
export default function CadastroRedirect() {
  return (
    <Suspense fallback={<div className="min-h-dvh flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-gold" /></div>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/entrar');
  }, [router]);
  return (
    <div className="min-h-dvh flex items-center justify-center">
      <Loader2 className="w-8 h-8 animate-spin text-gold" />
    </div>
  );
}
