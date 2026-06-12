'use client';
import { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * /login — DEPRECATED. Redireciona pro novo fluxo unificado /entrar.
 * Mantida pra não quebrar links externos antigos.
 */
export default function LoginRedirect() {
  return (
    <Suspense fallback={<div className="min-h-dvh flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-gold" /></div>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const search = useSearchParams();
  useEffect(() => {
    const next = search.get('next');
    router.replace(`/entrar${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  }, [router, search]);
  return (
    <div className="min-h-dvh flex items-center justify-center">
      <Loader2 className="w-8 h-8 animate-spin text-gold" />
    </div>
  );
}
