'use client';

import { useEffect, useRef, useState } from 'react';
import { AppLink as Link } from '@/components/ui/AppLink';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { navigation as estatico } from '@/data/navigation';
import type { NavItem } from '@/types';
import { MegaMenu } from './MegaMenu';

/**
 * Navigation — menu principal do desktop com mega menu por hover/foco.
 *
 * Detalhes que importam:
 * - O painel abre no hover COM pequeno atraso na saída (120ms). Sem isso, o
 *   menu fecha quando o mouse atravessa o gap entre o item e o painel.
 * - Abre também por foco de teclado e fecha com Esc.
 * - O painel vive fora do <ul> (posicionado absoluto no wrapper) pra ocupar a
 *   largura inteira da viewport.
 */
export function Navigation({ itens }: { itens?: NavItem[] }) {
  // As categorias vêm do CRM pelo layout (servidor). Sem elas, o estático.
  const navigation = itens?.length ? itens : estatico;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();

  function open(index: number) {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpenIndex(index);
  }

  function scheduleClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenIndex(null), 120);
  }

  function closeNow() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpenIndex(null);
  }

  /**
   * FECHA O PAINEL EM QUALQUER TROCA DE ROTA.
   *
   * O painel abre por hover e só fechava por hover de saída ou Esc. Ao clicar
   * num link de dentro dele, a navegação acontecia e o painel FICAVA ABERTO
   * por cima da página nova — uma faixa branca cobrindo o conteúdo inteiro,
   * porque o mouse continuava parado onde o painel estava (achado 10/08 ao
   * clicar num tamanho).
   *
   * Cada link também chama `onNavigate` pra fechar na hora. Este efeito é a
   * rede de segurança: pega o que o `onNavigate` não cobre — cards
   * editoriais, atalhos do rodapé do painel, botão voltar do navegador — sem
   * precisar lembrar de passar a função pra cada componente novo.
   */
  useEffect(() => {
    closeNow();
    // Só a rota importa: incluir `closeNow` reabriria o efeito a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const activeItem = openIndex !== null ? navigation[openIndex] : null;

  return (
    <div
      onMouseLeave={scheduleClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeNow();
      }}
    >
      <nav aria-label="Navegação principal">
        <ul className="flex items-center gap-7 xl:gap-9">
          {navigation.map((item, index) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const isOpen = openIndex === index;

            return (
              <li key={item.href} onMouseEnter={() => open(index)} onFocus={() => open(index)}>
                <Link
                  href={item.href}
                  data-active={isActive || isOpen}
                  aria-expanded={item.menu ? isOpen : undefined}
                  className={cn(
                    'link-underline block py-2 text-[0.8125rem] font-light tracking-[0.02em] whitespace-nowrap transition-colors',
                    isActive || isOpen ? 'text-ink' : 'text-ink-soft hover:text-ink',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {activeItem?.menu && (
        <div className="absolute inset-x-0 top-full" onMouseEnter={() => open(openIndex!)}>
          <MegaMenu item={activeItem} onNavigate={closeNow} />
        </div>
      )}
    </div>
  );
}
