'use client';

import { useEffect, useState } from 'react';

type OverlayComponents = {
  MiniCart: typeof import('@/components/commerce/MiniCart').MiniCart;
  QuickAddSheet: typeof import('@/components/commerce/QuickAddSheet').QuickAddSheet;
};

/**
 * As duas camadas nascem fechadas. Baixar e executar seus módulos antes da
 * imagem principal só aumenta o caminho crítico sem produzir um pixel útil.
 */
export function DeferredCommerceOverlays() {
  const [active, setActive] = useState(false);
  const [components, setComponents] = useState<OverlayComponents | null>(null);

  useEffect(() => {
    if (active) return;
    const activate = () => setActive(true);
    // A primeira intenção carrega as camadas. Os stores guardam o estado do
    // clique enquanto o chunk termina de chegar; sem intenção, não há motivo
    // para baixar UI fechada, nem depois de um timeout arbitrário.
    window.addEventListener('pointerdown', activate, { once: true, passive: true });
    window.addEventListener('keydown', activate, { once: true });

    return () => {
      window.removeEventListener('pointerdown', activate);
      window.removeEventListener('keydown', activate);
    };
  }, [active]);

  useEffect(() => {
    if (!active || components) return;
    let cancelled = false;
    Promise.all([
      import('@/components/commerce/MiniCart'),
      import('@/components/commerce/QuickAddSheet'),
    ]).then(([miniCart, quickAdd]) => {
      if (!cancelled) {
        setComponents({ MiniCart: miniCart.MiniCart, QuickAddSheet: quickAdd.QuickAddSheet });
      }
    });
    return () => { cancelled = true; };
  }, [active, components]);

  if (!components) return null;
  const { MiniCart, QuickAddSheet } = components;
  return (
    <>
      <MiniCart />
      <QuickAddSheet />
    </>
  );
}
