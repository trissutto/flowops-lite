import { cn } from '@/lib/utils';
import { Container, type ContainerWidth } from './Container';

/**
 * Section — ritmo vertical + fundo da seção. Junto com Container, define o
 * "respiro" que é marca do projeto. Páginas NUNCA escrevem py-* na mão.
 *
 * tone: default (papel) · alt (creme) · dark (ink) · champagne
 */

export type SectionTone = 'default' | 'alt' | 'dark' | 'champagne';
export type SectionSpace = 'sm' | 'md' | 'lg' | 'none';

const TONES: Record<SectionTone, string> = {
  default: 'bg-background text-ink',
  alt: 'bg-surface-alt text-ink',
  dark: 'bg-ink text-light',
  champagne: 'bg-champagne text-ink',
};

const SPACES: Record<SectionSpace, string> = {
  none: '',
  sm: 'py-section-sm',
  md: 'py-section',
  lg: 'py-section-lg',
};

interface SectionProps {
  tone?: SectionTone;
  space?: SectionSpace;
  width?: ContainerWidth;
  /** Sem container interno — a própria seção controla o layout (full-bleed). */
  bleed?: boolean;
  id?: string;
  className?: string;
  containerClassName?: string;
  children: React.ReactNode;
  'aria-labelledby'?: string;
}

export function Section({
  tone = 'default',
  space = 'md',
  width = 'page',
  bleed = false,
  id,
  className,
  containerClassName,
  children,
  ...rest
}: SectionProps) {
  return (
    <section
      id={id}
      className={cn('relative', TONES[tone], SPACES[space], id && 'scroll-mt-24', className)}
      {...rest}
    >
      {bleed ? (
        children
      ) : (
        <Container width={width} className={containerClassName}>
          {children}
        </Container>
      )}
    </section>
  );
}
