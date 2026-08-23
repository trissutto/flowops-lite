'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

/**
 * O CAMPO DE BUSCA DA PÁGINA DE ERRO.
 *
 * Componente próprio, e não o `SearchOverlay` do header, por um motivo de
 * comportamento: o overlay é uma CAMADA que abre por cima da página. Aqui a
 * busca não é atalho — é a única coisa que a cliente tem pra fazer, e um campo
 * que já está na tela, com o cursor podendo entrar direto, vale mais que um
 * ícone que abre outra coisa.
 *
 * Sem `autoFocus` de propósito: no celular ele levanta o teclado por cima do
 * texto que explica o que aconteceu, e a pessoa perde o contexto antes de ler.
 */
export function BuscaDaPaginaPerdida({ className }: { className?: string }) {
  const router = useRouter();
  const [termo, setTermo] = useState('');

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = termo.trim();
        // Campo vazio manda pra busca sem termo, que é uma página de convite
        // com os termos-guia — nunca um resultado vazio.
        router.push(q ? `/busca?q=${encodeURIComponent(q)}` : '/busca');
      }}
      className={cn('flex flex-col gap-2.5 sm:flex-row', className)}
    >
      <label htmlFor="busca-404" className="sr-only">
        O que você procurava?
      </label>
      <div className="relative flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-primary-strong"
          strokeWidth={1.5}
          aria-hidden
        />
        <input
          id="busca-404"
          type="search"
          value={termo}
          onChange={(e) => setTermo(e.target.value)}
          enterKeyHint="search"
          placeholder="Vestido, blusa, 54, VLM-222…"
          className="h-12 w-full rounded-pill border border-border bg-surface pr-4 pl-11 text-body text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none"
        />
      </div>
      <Button type="submit" size="lg">
        Procurar
      </Button>
    </form>
  );
}
