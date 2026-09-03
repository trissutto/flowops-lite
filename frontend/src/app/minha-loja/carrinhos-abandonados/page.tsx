'use client';

/**
 * /minha-loja/carrinhos-abandonados — REDIRECT pra aba Carrinhos da /separacao.
 *
 * A tela antiga lia o plugin Cart Abandonment Recovery do WordPress (site
 * velho). O WordPress foi desligado — a lista ficava em "0 carrinhos" pra
 * sempre, parecendo que ninguém abandonava carrinho. A fonte NATIVA é a aba
 * Carrinhos do fluxo de recuperação (/separacao?tab=carrinhos), que lê o
 * e-commerce novo direto do banco do Flow.
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function CarrinhosAbandonadosRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/separacao?tab=carrinhos'); }, [router]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <p className="text-sm text-slate-500">
        Esta tela mudou de lugar — os carrinhos abandonados agora vivem na{' '}
        <Link href="/separacao?tab=carrinhos" className="font-bold text-rose-700 underline">
          aba Carrinhos da Separação
        </Link>. Levando você pra lá…
      </p>
    </div>
  );
}
