import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `cn()` — junta classes e resolve conflito de Tailwind (a última vence).
 *
 * ⚠️ POR QUE O `extendTailwindMerge` NÃO É OPCIONAL
 *
 * No Tailwind, `text-*` serve pra DUAS coisas: tamanho de fonte (`text-sm`) e
 * cor (`text-ink`). O tailwind-merge só conhece os tokens que a gente declara.
 * Diante de dois nomes customizados ele assume que são do mesmo grupo e mantém
 * só o ÚLTIMO — a classe de cor some no caminho.
 *
 * Isso já queimou no ecommerce em 03/08/2026: `bg-ink text-light` + `text-button`
 * chegava no DOM como `bg-ink text-button`, e TODO botão com cor própria virava
 * um retângulo preto sem texto. Nenhuma inspeção de estilo mostra isso — só
 * lendo `element.className` no DOM.
 *
 * ESTADO DE HOJE: a trava é PREVENTIVA, não está consertando bug ativo. Com os
 * tokens atuais o tailwind-merge acertaria sozinho, porque todo tamanho de
 * fonte aqui é built-in (`text-sm`) ou arbitrário (`text-[13px]`), e ele
 * classifica esses casos direito. A armadilha arma no dia em que alguém puser
 * um `fontSize` CUSTOM no `tailwind.config.ts` — aí `text-titulo` e `text-ink`
 * viram dois nomes desconhecidos do mesmo prefixo, e um come o outro.
 *
 * REGRA — quando mexer no `tailwind.config.ts`:
 *  · cor nova em `colors`   → acrescentar em CORES, abaixo;
 *  · tamanho novo em `fontSize` → criar aqui um grupo `'font-size'` listando
 *    os tamanhos custom, senão a cor volta a sumir.
 * O teste `tests/tokens-no-cn.test.mjs` guarda a primeira metade dessa regra.
 */
const CORES = [
  'ground',
  'surface',
  'surface-2',
  'ink',
  'ink-soft',
  'ink-faint',
  'line',
  'line-soft',
  'action',
  'action-ink',
  'crit',
  'crit-soft',
  'warn',
  'warn-soft',
  'ok',
  'ok-soft',
  'brand',
  'brand-light',
  'brand-dark',
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'text-color': [{ text: [...CORES] }],
      'bg-color': [{ bg: [...CORES] }],
      'border-color': [{ border: [...CORES] }],
      rounded: [{ rounded: ['card', 'field'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
