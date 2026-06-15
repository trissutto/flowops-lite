'use client';

/**
 * ContadorGuard — bloqueia navegacao pra role=contador fora da tela permitida.
 *
 * Regra: contador SO pode acessar /retaguarda/relatorio-fiscal e /login.
 * Qualquer outra URL → redireciona automaticamente pra /retaguarda/relatorio-fiscal.
 *
 * Como funciona:
 *  1. Mount: chama /auth/me pra descobrir role do JWT armazenado
 *  2. Se role=contador, escuta mudancas de URL
 *  3. Em qualquer URL nao-permitida → router.replace pra /retaguarda/relatorio-fiscal
 *
 * Importante: este e um guard DE UX (impede o usuario casual de ver outras telas).
 * A protecao REAL e no backend — os endpoints fora de fiscal-report retornam 403
 * pra role=contador. Mesmo que ele bata na URL direta, nao consegue dados.
 *
 * Coloca no layout root pra cobrir todo o app.
 */

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

const ALLOWED_PATHS = [
  '/login',
  '/retaguarda/relatorio-fiscal',
];

function isAllowed(pathname: string): boolean {
  return ALLOWED_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export default function ContadorGuard() {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const [role, setRole] = useState<string | null>(null);

  // Detecta role uma vez no mount via /auth/me
  useEffect(() => {
    let cancelled = false;
    async function loadRole() {
      try {
        const token =
          typeof window !== 'undefined'
            ? window.localStorage.getItem('flowops_token') ||
              window.sessionStorage.getItem('flowops_token')
            : null;
        if (!token) {
          if (!cancelled) setRole('');
          return;
        }
        const base = process.env.NEXT_PUBLIC_API_URL || '';
        const r = await fetch(`${base}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) {
          if (!cancelled) setRole('');
          return;
        }
        const j = await r.json();
        if (!cancelled) setRole(j?.role || '');
      } catch {
        if (!cancelled) setRole('');
      }
    }
    loadRole();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sempre que role for contador E pathname nao for permitido, redireciona
  useEffect(() => {
    if (role !== 'contador') return;
    if (isAllowed(pathname)) return;
    router.replace('/retaguarda/relatorio-fiscal');
  }, [role, pathname, router]);

  return null;
}
