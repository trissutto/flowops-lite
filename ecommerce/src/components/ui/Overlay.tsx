'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEscapeKey, useFocusTrap, useLockScroll } from '@/hooks';

/**
 * OVERLAY — primitivo compartilhado por Modal e Drawer.
 *
 * Decisão de arquitetura: o painel fica SEMPRE montado depois da primeira
 * abertura e anima por estado (`open`), em vez de montar/desmontar com
 * AnimatePresence. Motivo: unmount-após-exit depende de rAF e falha em
 * ambientes onde o frame não é composto (aba em background, headless),
 * deixando o painel órfão no DOM. Com `inert` + `pointer-events: none` o
 * painel fechado sai da ordem de tab e da árvore de acessibilidade, que é o
 * que realmente importa. Ver docs/animations.md.
 *
 * NO CLIENTE O OVERLAY MORA NO `<body>` (portal, 15/09). `fixed` + z-index só
 * valem dentro da camada do ancestral: a coluna de compra da PDP é
 * `lg:sticky`, e sticky SEMPRE cria camada própria — a "Tabela de medidas"
 * abria no PC POR TRÁS da galeria (que vem depois no DOM) e com o topo
 * cortado pelo cabeçalho (z 30). Dentro do portal os tokens de z valem pra
 * página inteira, seja qual for o pai de quem abre. No servidor e na
 * hidratação o overlay continua renderizando no lugar (o HTML não muda — os
 * links do menu do celular seguem no HTML) e só então muda pro `<body>`.
 */

/** Nada a assinar: o valor só separa servidor/hidratação (false) do cliente (true). */
const semAssinatura = () => () => {};

type Side = 'right' | 'left' | 'bottom' | 'center';

const PANEL_POSITION: Record<Side, string> = {
  right: 'inset-y-0 right-0 h-full',
  left: 'inset-y-0 left-0 h-full',
  bottom: 'inset-x-0 bottom-0 w-full',
  center: 'inset-0 m-auto h-fit max-h-[90vh]',
};

const HIDDEN_TRANSFORM: Record<Side, string> = {
  right: 'translate-x-full',
  left: '-translate-x-full',
  bottom: 'translate-y-full',
  center: 'translate-y-3 scale-[0.98] opacity-0',
};

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  side?: Side;
  /** Título acessível — obrigatório: vira aria-label do dialog. */
  label: string;
  /** Mostra o botão X flutuante padrão. */
  showClose?: boolean;
  className?: string;
  children: React.ReactNode;
  /** z-index token: drawer (60) ou modal (70). */
  layer?: 'drawer' | 'modal';
}

export function Overlay({
  open,
  onClose,
  side = 'right',
  label,
  showClose = true,
  className,
  children,
  layer = 'drawer',
}: OverlayProps) {
  const panelRef = useFocusTrap<HTMLDivElement>(open);
  const inertRef = useRef<HTMLDivElement | null>(null);
  const noCliente = useSyncExternalStore(semAssinatura, () => true, () => false);

  useLockScroll(open);
  useEscapeKey(open, onClose);

  // Painel fechado sai da navegação por teclado e do leitor de tela.
  // `noCliente` nas dependências: a mudança pro portal cria um painel NOVO,
  // e sem reaplicar o `inert` ele nasceria tabulável com o overlay fechado.
  useEffect(() => {
    if (inertRef.current) inertRef.current.inert = !open;
  }, [open, noCliente]);

  // O backdrop do MODAL fica ACIMA do drawer (65 > 60): quando a janelinha do
  // Quick Add abre por cima do mini-cart, o clique fora dela tem que fechar o
  // modal — não apertar um botão da sacola que está por baixo.
  const zBackdrop = layer === 'modal' ? 'z-[var(--z-modal-backdrop)]' : 'z-[var(--z-overlay)]';
  const zPanel = layer === 'modal' ? 'z-[var(--z-modal)]' : 'z-[var(--z-drawer)]';

  const conteudo = (
    <>
      <div
        aria-hidden
        onClick={onClose}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        className={cn(
          'fixed inset-0 bg-ink/40 backdrop-blur-sm transition-opacity duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
          open ? 'visible opacity-100' : 'invisible opacity-0',
          zBackdrop,
        )}
      />
      <div
        ref={(node) => {
          inertRef.current = node;
          (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-hidden={!open}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        className={cn(
          'fixed flex flex-col bg-background shadow-xl transition-[transform,opacity] duration-[450ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
          open
            ? 'visible translate-x-0 translate-y-0 scale-100 opacity-100'
            : cn('invisible', HIDDEN_TRANSFORM[side]),
          PANEL_POSITION[side],
          zPanel,
          className,
        )}
      >
        {showClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="absolute top-5 right-5 z-10 flex size-10 items-center justify-center rounded-pill bg-surface/90 text-ink shadow-sm backdrop-blur transition-colors hover:bg-surface"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        )}
        {children}
      </div>
    </>
  );

  return noCliente ? createPortal(conteudo, document.body) : conteudo;
}
