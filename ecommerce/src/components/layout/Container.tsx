import { cn } from '@/lib/utils';

/**
 * Container — largura máxima + gutter lateral. TODA seção do site usa este
 * componente; nenhuma página define padding lateral na mão.
 *
 * narrow 640 · text 896 · page 1152 (padrão) · wide 1344 · full (sem limite)
 * Os nomes são semânticos de propósito: "text" é o que comporta um parágrafo
 * legível, "page" o conteúdo geral, "wide" as grades editoriais.
 */

export type ContainerWidth = 'narrow' | 'text' | 'page' | 'wide' | 'full';

const WIDTHS: Record<ContainerWidth, string> = {
  narrow: 'max-w-narrow',
  text: 'max-w-text',
  page: 'max-w-page',
  wide: 'max-w-wide',
  full: 'max-w-none',
};

interface ContainerProps {
  width?: ContainerWidth;
  /** Remove o gutter (usado por seções que sangram na borda). */
  bleed?: boolean;
  className?: string;
  children: React.ReactNode;
  as?: 'div' | 'section' | 'header' | 'footer' | 'nav' | 'main';
}

export function Container({
  width = 'page',
  bleed = false,
  className,
  children,
  as: Tag = 'div',
}: ContainerProps) {
  return (
    <Tag
      className={cn(
        'mx-auto w-full',
        WIDTHS[width],
        !bleed && 'px-gutter lg:px-gutter-lg',
        className,
      )}
    >
      {children}
    </Tag>
  );
}
