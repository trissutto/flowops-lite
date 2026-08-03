'use client';

import { useRouter } from 'next/navigation';

/** Derruba a sessão (apaga o cookie httpOnly no servidor) e recarrega. */
export function SairDaConta() {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={async () => {
        await fetch('/api/conta/sessao', { method: 'DELETE' });
        router.push('/');
        router.refresh();
      }}
      className="link-underline"
    >
      Sair da conta
    </button>
  );
}
