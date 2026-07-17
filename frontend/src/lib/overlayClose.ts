import type { MouseEvent } from 'react';

/**
 * Handlers pro BACKDROP (overlay) de um modal fechar SÓ num clique de verdade
 * no fundo — NUNCA quando o usuário arrasta o mouse.
 *
 * Bug que isso corrige: o overlay fechava no `onClick`. Mas o evento `click`
 * dispara quando o mousedown começa DENTRO do modal (ex: selecionar texto,
 * arrastar da direita pra esquerda) e o mouseup cai no overlay — o alvo do
 * click vira o overlay e a tela fechava, perdendo a seleção.
 *
 * Aqui a tela só fecha quando o mousedown E o mouseup acontecem no PRÓPRIO
 * overlay (`e.target === e.currentTarget` nos dois). Arrastar de dentro pra
 * fora não fecha mais.
 *
 * Uso — troca `onClick={onClose}` por spread no MESMO div do overlay:
 *   <div className="fixed inset-0 ..." {...overlayClose(onClose)}>
 *     <div onClick={(e) => e.stopPropagation()}> ...conteúdo... </div>
 *   </div>
 *
 * (o `stopPropagation` do conteúdo pode ficar — é redundante com o check de
 * target, mas inofensivo.)
 */
export function overlayClose(onClose: () => void) {
  return {
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      (e.currentTarget as any).__downOnBackdrop = e.target === e.currentTarget;
    },
    onMouseUp: (e: MouseEvent<HTMLElement>) => {
      const started = (e.currentTarget as any).__downOnBackdrop === true;
      (e.currentTarget as any).__downOnBackdrop = false;
      if (started && e.target === e.currentTarget) onClose();
    },
  };
}
