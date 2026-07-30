import type { Transition, Variants } from 'framer-motion';

/**
 * BIBLIOTECA DE ANIMAÇÕES — Lurds Plus Size
 *
 * Regra da marca: movimento serve pra guiar o olho, nunca pra chamar atenção.
 * Sem bounce, sem spring elástico, sem rotação. Duração generosa + easing
 * de saída suave ("ease-lurds") = sensação de peso e qualidade.
 *
 * Uso típico numa seção:
 *   <motion.div {...reveal()}>…</motion.div>
 *   <motion.div {...revealStagger}>{items.map(i => <motion.div variants={fadeUp} …
 *
 * Documentação: docs/animations.md
 */

/** Easing assinatura (espelha --ease-lurds do CSS). */
export const EASE_LURDS = [0.22, 1, 0.36, 1] as const;
export const EASE_SOFT = [0.4, 0, 0.2, 1] as const;

export const DURATION = {
  fast: 0.18,
  base: 0.32,
  slow: 0.56,
  editorial: 0.9,
} as const;

export const transition = {
  fast: { duration: DURATION.fast, ease: EASE_LURDS },
  base: { duration: DURATION.base, ease: EASE_LURDS },
  slow: { duration: DURATION.slow, ease: EASE_LURDS },
  editorial: { duration: DURATION.editorial, ease: EASE_LURDS },
} satisfies Record<string, Transition>;

/* ------------------------------------------------------------------ VARIANTS */

export const fade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: transition.slow },
};

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: transition.slow },
};

export const fadeDown: Variants = {
  hidden: { opacity: 0, y: -20 },
  visible: { opacity: 1, y: 0, transition: transition.slow },
};

export const slideLeft: Variants = {
  hidden: { opacity: 0, x: 32 },
  visible: { opacity: 1, x: 0, transition: transition.slow },
};

export const slideRight: Variants = {
  hidden: { opacity: 0, x: -32 },
  visible: { opacity: 1, x: 0, transition: transition.slow },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: transition.slow },
};

/** Zoom-out lento de imagem editorial na entrada (hero). */
export const zoomOutImage: Variants = {
  hidden: { scale: 1.08 },
  visible: { scale: 1, transition: { duration: 2.2, ease: EASE_LURDS } },
};

/** Reveal de texto por máscara — usado em títulos display. */
export const maskUp: Variants = {
  hidden: { y: '110%' },
  visible: { y: '0%', transition: transition.editorial },
};

/* --------------------------------------------------------------- CONTAINERS */

/** Container que escalona a entrada dos filhos. */
export function stagger(delayChildren = 0, staggerChildren = 0.08): Variants {
  return {
    hidden: {},
    visible: { transition: { delayChildren, staggerChildren } },
  };
}

export const staggerFast = stagger(0, 0.05);
export const staggerBase = stagger(0.05, 0.08);
export const staggerSlow = stagger(0.1, 0.14);

/* ----------------------------------------------------------------- HELPERS */

/**
 * Props prontas pra revelar um bloco quando entra na viewport.
 * `once: true` porque re-animar no scroll de volta parece instável.
 */
export function reveal(variants: Variants = fadeUp, margin = '-80px') {
  return {
    variants,
    initial: 'hidden' as const,
    whileInView: 'visible' as const,
    viewport: { once: true, margin },
  };
}

/** Versão container: revela o bloco escalonando os filhos. */
export function revealStagger(variants: Variants = staggerBase, margin = '-80px') {
  return {
    variants,
    initial: 'hidden' as const,
    whileInView: 'visible' as const,
    viewport: { once: true, margin },
  };
}

/** Entrada imediata (hero acima da dobra — não espera scroll). */
export function enter(variants: Variants = fadeUp, delay = 0) {
  return {
    variants,
    initial: 'hidden' as const,
    animate: 'visible' as const,
    transition: { ...transition.slow, delay },
  };
}

/* ------------------------------------------------- MICROINTERAÇÕES / OVERLAYS */

/** Hover padrão de card: sobe e aprofunda a sombra. */
export const cardHover = {
  whileHover: { y: -6, transition: transition.base },
} as const;

/** Zoom de 4% na foto do card — valor fixo da marca. */
export const IMAGE_HOVER_SCALE = 1.04;

export const overlayFade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: transition.base },
};

export const drawerRight: Variants = {
  hidden: { x: '100%' },
  visible: { x: '0%', transition: { duration: 0.45, ease: EASE_LURDS } },
};

export const drawerLeft: Variants = {
  hidden: { x: '-100%' },
  visible: { x: '0%', transition: { duration: 0.45, ease: EASE_LURDS } },
};

export const dropdownIn: Variants = {
  hidden: { opacity: 0, y: -8 },
  visible: { opacity: 1, y: 0, transition: transition.fast },
};

/** Transição entre páginas (usada no template.tsx). */
export const pageTransition: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: transition.base },
};
