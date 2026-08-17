'use client';

import Image, { getImageProps } from 'next/image';
import { forwardRef } from 'react';
import { preload } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { Button, type ButtonVariant } from '@/components/ui/Button';
import { Container } from '@/components/layout/Container';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import type { Media, VideoMedia } from '@/types';

/**
 * HERO EDITORIAL — o componente mais importante da linguagem visual.
 *
 * Configurável em imagem OU vídeo, quatro alturas, três alinhamentos, dois
 * CTAs. Traz de fábrica:
 *   - zoom-out lento de 2,2s na entrada (dá "peso" cinematográfico)
 *   - parallax leve no scroll (12% de deslocamento — nunca mais que isso)
 *   - gradiente ancorando o texto sem apagar a foto
 *
 * Regra: pouquíssimo texto. Título curto, uma linha de apoio, dois botões.
 */

/**
 * `arte` = A ARTE MANDA NA ALTURA (dono 07/08).
 *
 * Os outros modos fixam a altura e recortam a foto (`object-cover`) — certo pra
 * foto editorial, onde perder um pedaço da borda não custa nada. Errado pra
 * BANNER DE CAMPANHA: a arte já vem com texto e logo dentro, e o recorte comeu
 * o "Indomável" nas duas pontas. Aqui a seção assume a proporção da imagem, e
 * a campanha aparece inteira em qualquer tela — que é o que "se adaptar ao
 * tamanho da tela" quer dizer pra quem desenhou o banner.
 */
export type HeroHeight = 'home' | 'small' | 'medium' | 'large' | 'fullscreen' | 'arte';
export type HeroAlign = 'left' | 'center' | 'right';
export type HeroOverlay = 'none' | 'soft' | 'medium' | 'strong';
export type HeroContentTone = 'light' | 'ink';

const HEIGHTS: Record<HeroHeight, string> = {
  // Proporção da capa aprovada: curta no celular para categorias e produtos
  // continuarem visíveis na primeira jornada; mais editorial no desktop.
  home: 'min-h-[18rem] sm:min-h-[26rem] lg:min-h-[34rem]',
  small: 'min-h-[42svh] lg:min-h-[46svh]',
  medium: 'min-h-[62svh] lg:min-h-[68svh]',
  large: 'min-h-[82svh] lg:min-h-[86svh]',
  fullscreen: 'min-h-[100svh]',
  arte: '',
};

const ALIGNMENTS: Record<HeroAlign, string> = {
  left: 'items-start text-left',
  center: 'items-center text-center',
  right: 'items-end text-right',
};

interface HeroAction {
  label: string;
  href: string;
  variant?: ButtonVariant;
  external?: boolean;
}

interface HeroProps {
  image?: Media;
  /** Recorte vertical pro celular (opcional) — arte dirigida. */
  imageMobile?: Media;
  video?: VideoMedia;
  eyebrow?: string;
  title: React.ReactNode;
  subtitle?: string;
  primaryAction?: HeroAction;
  secondaryAction?: HeroAction;
  height?: HeroHeight;
  align?: HeroAlign;
  /** Intensidade do véu escuro sobre a mídia. */
  overlay?: HeroOverlay;
  /** Cor do texto sobre a mídia. `ink` é usada pela capa clara da Home. */
  contentTone?: HeroContentTone;
  /** Conteúdo extra acima do título (breadcrumb, por exemplo). */
  above?: React.ReactNode;
  /** Seta de "role pra baixo". */
  showScrollHint?: boolean;
  /** Desliga o parallax (heros pequenos de topo de página). */
  parallax?: boolean;
  /** Hero acima da dobra → prioriza o carregamento da imagem (LCP). */
  priority?: boolean;
  className?: string;
}

const OVERLAYS = {
  none: '',
  soft: 'bg-gradient-to-b from-ink/25 via-ink/10 to-ink/35',
  medium: 'bg-gradient-to-b from-ink/45 via-ink/25 to-ink/55',
  strong: 'bg-gradient-to-b from-ink/60 via-ink/40 to-ink/70',
} as const;

/** Tamanho real do arquivo, quando a medição do servidor conseguiu ler. */
function medida(m?: Media): { width: number; height: number } | null {
  return m?.largura && m?.altura ? { width: m.largura, height: m.altura } : null;
}

/**
 * PRELOAD DO LCP PRO CASO `<picture>` — o `<Image>` emite sozinho, o
 * `getImageProps` NÃO (10/08/2026).
 *
 * Medido no HTML de produção: a home saía com preload de TRÊS FONTES e NENHUM
 * de imagem. O navegador só descobria o banner depois de parsear o HTML, com
 * as fontes já na frente dele na fila — FCP verde e LCP vermelho, a página
 * aparece rápido e a arte grande chega segundos depois. O `fetchPriority` do
 * `<img>` só age DEPOIS da descoberta; o atraso estava na descoberta.
 *
 * `media` casa com os `<source>`: sem ele o navegador baixaria as DUAS artes e
 * o remédio viraria veneno. `imageSrcSet` preserva a escolha de largura e
 * formato (AVIF/WebP) do otimizador.
 *
 * MORA AQUI, E SÓ AQUI (12/08/2026). Isto vivia em dois lugares — neste
 * componente e num `<HeroImagePreload>` chamado pela home — e o HTML saía com
 * QUATRO preloads pras mesmas duas imagens. O navegador dedupa pela URL, então
 * não custava banda, mas era a mesma decisão escrita duas vezes: mexer numa
 * cópia e esquecer a outra é como o hero fica sem preload de novo.
 */
interface ArtePreload {
  src: string;
  srcSet?: string;
}

function PreloadArte({ desktop, mobile }: { desktop?: ArtePreload; mobile?: ArtePreload }) {
  if (!desktop) return null;

  // A API de recursos do React envia estes hints para o <head>. O JSX <link>
  // ficava no corpo, depois de ~55 KB de HTML, e o Lighthouse media 580 ms
  // até descobrir o LCP. `media` mantém a arte móvel e a desktop mutuamente
  // exclusivas, evitando baixar as duas.
  if (mobile) {
    preload(mobile.src, {
      as: 'image',
      media: '(max-width: 1023px)',
      imageSrcSet: mobile.srcSet,
      imageSizes: '100vw',
      fetchPriority: 'high',
    });
  }
  preload(desktop.src, {
    as: 'image',
    media: mobile ? '(min-width: 1024px)' : undefined,
    imageSrcSet: desktop.srcSet,
    imageSizes: '100vw',
    fetchPriority: 'high',
  });

  return null;
}

export function Hero({
  image,
  imageMobile,
  video,
  eyebrow,
  title,
  subtitle,
  primaryAction,
  secondaryAction,
  height = 'large',
  align = 'center',
  overlay = 'medium',
  contentTone = 'light',
  above,
  showScrollHint = false,
  priority = false,
  className,
}: HeroProps) {
  // Arte fechada não faz parallax nem zoom: mover a campanha corta a arte de
  // novo — pela borda, em vez de pelo enquadramento. É a mesma perda.
  const arte = height === 'arte';
  const home = height === 'home';

  if (arte) {
    return (
      <HeroArte
        image={image}
        imageMobile={imageMobile}
        priority={priority}
        overlay={overlay}
        align={align}
        eyebrow={eyebrow}
        title={title}
        subtitle={subtitle}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        className={className}
      />
    );
  }

  return (
    <section
      className={cn('relative flex items-center overflow-hidden', HEIGHTS[height], className)}
    >
      {/* Mídia */}
      <div className="absolute inset-0">
        <div
          // `relative` é obrigatório: a mídia usa <Image fill>, que precisa de
          // um pai posicionado. Sem isto o next/image reclama no console e a
          // foto passa a se ancorar no avô — funcionava por coincidência de
          // tamanho, não por desenho.
          className={cn(
            'relative size-full',
            // O hero prioritário é o LCP: pinta no primeiro frame. A entrada
            // com zoom fica só para heros secundários, onde é decoração.
            !priority && 'animate-[hero-media-enter_2.2s_cubic-bezier(0.22,1,0.36,1)_both]',
          )}
        >
          {video ? (
            <>
              {/* Poster pelo next/image, nunca pelo atributo `poster` do
                  <video> — ver o aviso no VideoBlock: o atributo baixa o
                  original cru (megabytes) sem passar pelo otimizador. */}
              <Image
                src={video.poster}
                alt={video.alt}
                fill
                priority={priority}
                fetchPriority={priority ? 'high' : undefined}
                sizes="100vw"
                placeholder="blur"
                blurDataURL={BLUR_DATA_URL}
                className="object-cover object-center"
              />
              <video
                src={video.src}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                aria-label={video.alt}
                className="relative size-full object-cover"
              />
            </>
          ) : image && imageMobile ? (
            /**
             * ARTE DIRIGIDA — foto horizontal no computador, recorte vertical
             * no celular.
             *
             * `<picture>` com `getImageProps` em vez de dois `<Image>` com
             * `hidden`: imagem escondida por CSS **continua sendo baixada**
             * pelo navegador, e o hero é o LCP da home — pagar duas vezes ali
             * é o oposto do que a sprint de performance fez.
             *
             * O `<source media>` faz o navegador escolher UM, e o
             * `getImageProps` mantém o srcset otimizado (AVIF/WebP, largura
             * certa) dos dois lados.
             */
            (() => {
              const comum = {
                alt: image.alt,
                fill: true,
                priority,
                sizes: '100vw',
                placeholder: 'blur' as const,
                blurDataURL: BLUR_DATA_URL,
                className: 'object-cover object-center',
              };
              const desktop = getImageProps({ ...comum, src: image.src });
              const mobile = getImageProps({ ...comum, src: imageMobile.src });
              return (
                <>
                  {priority && (
                    <PreloadArte
                      desktop={{ src: desktop.props.src, srcSet: desktop.props.srcSet }}
                      mobile={{ src: mobile.props.src, srcSet: mobile.props.srcSet }}
                    />
                  )}
                  <picture>
                    <source media="(max-width: 1023px)" srcSet={mobile.props.srcSet} />
                    <source media="(min-width: 1024px)" srcSet={desktop.props.srcSet} />
                    {/* eslint-disable-next-line jsx-a11y/alt-text */}
                    <img {...desktop.props} fetchPriority={priority ? 'high' : undefined} />
                  </picture>
                </>
              );
            })()
          ) : image ? (
            <Image
              src={image.src}
              alt={image.alt}
              fill
              priority={priority}
              // `priority` sozinho emite o <link rel=preload> SEM
              // fetchpriority (conferido no fonte do next/image 15.5). Sem
              // isto o hero disputa banda em pé de igualdade com todo o resto
              // e o LCP desaba — era o caso da home.
              fetchPriority={priority ? 'high' : undefined}
              sizes="100vw"
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className="object-cover object-center"
            />
          ) : (
            <div className="grain size-full bg-gradient-to-br from-champagne via-surface-alt to-background" />
          )}
        </div>
      </div>

      {overlay !== 'none' && <div className={cn('absolute inset-0', OVERLAYS[overlay])} />}

      {/* Conteúdo */}
      <Container width="page" className={cn('relative z-10', home ? 'py-8 sm:py-12 lg:py-20' : 'py-20')}>
        <div className={cn('flex flex-col', ALIGNMENTS[align], home && 'max-w-[54%] lg:max-w-[48%]')}>
          {above && (
            <div
              className="mb-8 animate-[widget-enter_900ms_cubic-bezier(0.22,1,0.36,1)_both]"
              style={{ animationDelay: '100ms' }}
            >
              {above}
            </div>
          )}

          {eyebrow && (
            <p
              className={cn(
                'eyebrow animate-[widget-enter_900ms_cubic-bezier(0.22,1,0.36,1)_both]',
                contentTone === 'ink' ? 'text-primary-strong' : 'text-primary-soft',
              )}
              style={{ animationDelay: '200ms' }}
            >
              {eyebrow}
            </p>
          )}

          <h1
            className={cn(
              'max-w-3xl animate-[widget-enter_900ms_cubic-bezier(0.22,1,0.36,1)_both] text-display',
              eyebrow ? 'mt-6' : 'mt-0',
              home && 'text-[clamp(1.9rem,5vw,4.75rem)] leading-[0.98]',
              contentTone === 'ink' ? 'text-ink' : 'text-light',
            )}
            style={{ animationDelay: '320ms' }}
          >
            {title}
          </h1>

          {subtitle && (
            <p
              className={cn(
                'max-w-xl animate-[widget-enter_900ms_cubic-bezier(0.22,1,0.36,1)_both] font-light',
                home ? 'mt-4 text-sm leading-snug sm:mt-6 sm:text-lg' : 'mt-7 text-body-lg',
                contentTone === 'ink' ? 'text-ink/80' : 'text-light/85',
              )}
              style={{ animationDelay: '460ms' }}
            >
              {subtitle}
            </p>
          )}

          {(primaryAction || secondaryAction) && (
            <div
              className={cn(
                'flex animate-[widget-enter_900ms_cubic-bezier(0.22,1,0.36,1)_both] gap-3 sm:w-auto sm:flex-row sm:gap-4',
                home ? 'mt-6 w-auto flex-row' : 'mt-11 w-full flex-col',
                align === 'center' && 'sm:justify-center',
                align === 'right' && 'sm:justify-end',
              )}
              style={{ animationDelay: '600ms' }}
            >
              {primaryAction && (
                <Button
                  href={primaryAction.href}
                  external={primaryAction.external}
                  variant={primaryAction.variant ?? 'light'}
                  size={home ? 'md' : 'lg'}
                  className={cn('sm:w-auto', home && '!rounded-sm px-7')}
                  block={!home}
                >
                  {primaryAction.label}
                </Button>
              )}
              {secondaryAction && (
                <Button
                  href={secondaryAction.href}
                  external={secondaryAction.external}
                  variant={secondaryAction.variant ?? 'outlineLight'}
                  size={home ? 'md' : 'lg'}
                  className={cn('sm:w-auto', home && '!rounded-sm px-7')}
                  block={!home}
                >
                  {secondaryAction.label}
                </Button>
              )}
            </div>
          )}
        </div>
      </Container>

      {showScrollHint && (
        <div
          className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 animate-[widget-enter_1s_cubic-bezier(0.22,1,0.36,1)_both]"
          style={{ animationDelay: '1.6s' }}
        >
          <ChevronDown className="size-6 animate-bounce text-light/75" aria-hidden />
        </div>
      )}
    </section>
  );
}

/**
 * HERO DE ARTE FECHADA — a imagem entra em FLUXO (`w-full h-auto`), então a
 * seção tem exatamente a altura da arte na largura da tela. Sem recorte, sem
 * faixa preta, em qualquer proporção que a retaguarda subir.
 *
 * O texto e os botões continuam existindo (o dono pode querer os dois), mas
 * ficam SOBREPOSTOS em absoluto — nunca esticam a seção. Em tela estreita, o
 * `min-h` do conteúdo garante que os botões não amassem em cima da arte.
 */
const HeroArte = forwardRef<HTMLElement, {
  image?: Media;
  imageMobile?: Media;
  priority?: boolean;
  overlay?: HeroOverlay;
  align?: HeroAlign;
  eyebrow?: string;
  title?: React.ReactNode;
  subtitle?: string;
  primaryAction?: HeroAction;
  secondaryAction?: HeroAction;
  className?: string;
}>(function HeroArte(
  { image, imageMobile, priority, overlay = 'none', align = 'center',
    eyebrow, title, subtitle, primaryAction, secondaryAction, className },
  ref,
) {
  const temTexto = !!(eyebrow || title || subtitle);
  const temBotao = !!(primaryAction || secondaryAction);

  /**
   * A ALTURA RESERVADA VEM DO ARQUIVO, NÃO DE UM CHUTE (12/08/2026).
   *
   * Aqui a imagem entra em fluxo (`w-full h-auto`), então o `width`/`height`
   * que declaramos É a altura que o navegador reserva antes de a arte chegar.
   * Estava fixo em 2400×1350 (16:9) e a campanha no ar é 2216×709 (3,13:1):
   * medido em tela de 1350px, ele reservava 751px, a arte ocupava 427px e a
   * home inteira subia 324px na hora do load — CLS 0,13, o único indicador
   * vermelho do PageSpeed desktop. No celular era pior e estava escondido: o
   * recorte vertical (992×1586) herdava a mesma conta e o pulo era de 389px,
   * invisível só porque a arte chegava antes da primeira pintura.
   *
   * Chute não conserta isso porque cada campanha tem a sua proporção. O
   * tamanho real é medido no servidor (`services/medir-arte`, lê o cabeçalho
   * do arquivo) e desce em `image.largura/altura`. Sem medida, cai no 16:9 de
   * antes — pior que o certo, igual ao que já estava.
   */
  const dimDesktop = medida(image) ?? { width: 2400, height: 1350 };
  // O recorte de celular tem proporção PRÓPRIA (é vertical). Sem medida dele,
  // repetimos a do desktop: um número errado nos dois é melhor que dois.
  const dimMobile = medida(imageMobile) ?? dimDesktop;

  /**
   * Só reservamos por CSS quando a medida é REAL. Com chute, forçar a
   * proporção deixaria de ser reserva e passaria a ser distorção da arte.
   */
  const medido = !!medida(image);
  const reserva = medido
    ? ({
        '--arte-desktop': `${dimDesktop.width}/${dimDesktop.height}`,
        ...(medida(imageMobile) ? { '--arte-mobile': `${dimMobile.width}/${dimMobile.height}` } : {}),
      } as React.CSSProperties)
    : undefined;

  const comum = {
    alt: image?.alt ?? '',
    priority,
    // O hero é o LCP da home. `getImageProps` usa `decoding="async"` por
    // padrão, o que deixou a imagem já baixada esperando mais 1,36 s para ser
    // desenhada no Lighthouse mobile. Para a única imagem prioritária acima
    // da dobra, a decodificação síncrona mantém o paint no caminho crítico.
    decoding: priority ? ('sync' as const) : ('async' as const),
    sizes: '100vw',
    className: cn('w-full h-auto', medido && 'arte-reservada'),
    style: reserva,
  };
  const desktop = image ? getImageProps({ ...comum, ...dimDesktop, src: image.src }) : null;
  const mobile = imageMobile
    ? getImageProps({ ...comum, ...dimMobile, src: imageMobile.src })
    : null;

  return (
    <section ref={ref} className={cn('relative w-full', className)}>
      {/**
       * PRELOAD DO LCP NA MÃO — o `<Image>` emite sozinho, o `getImageProps`
       * NÃO (10/08/2026).
       *
       * Medido no HTML de produção: a home saía com preload de TRÊS FONTES e
       * NENHUM de imagem. O navegador só descobria o banner depois de parsear
       * o HTML, com as fontes já na frente dele na fila. É o formato exato do
       * PageSpeed de hoje — FCP 1,6s (verde) e LCP 4,3s (vermelho): a página
       * aparece rápido e a arte grande chega quase 3s depois.
       *
       * O `fetchPriority` no `<img>` abaixo só age DEPOIS da descoberta; o
       * atraso estava na descoberta.
       *
       * `media` casa com os `<source>` — sem ele o navegador baixaria as DUAS
       * artes e o remédio viraria veneno. `imageSrcSet` preserva a escolha de
       * largura e formato (AVIF/WebP) do otimizador.
       */}
      {priority && desktop && (
        <PreloadArte
          desktop={{ src: desktop.props.src, srcSet: desktop.props.srcSet }}
          mobile={mobile ? { src: mobile.props.src, srcSet: mobile.props.srcSet } : undefined}
        />
      )}

      {desktop && (
        <picture>
          {/* `width`/`height` no <source>: o recorte de celular tem proporção
              própria e é ELE que aparece ali. Sem isto o navegador reservaria
              a altura do desktop pra uma arte vertical. Navegador que ignore
              o atributo cai no tamanho do <img>, que é o de hoje. */}
          {mobile && (
            <source
              media="(max-width: 1023px)"
              srcSet={mobile.props.srcSet}
              width={dimMobile.width}
              height={dimMobile.height}
            />
          )}
          <source
            media="(min-width: 1024px)"
            srcSet={desktop.props.srcSet}
            width={dimDesktop.width}
            height={dimDesktop.height}
          />
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <img {...desktop.props} fetchPriority={priority ? 'high' : undefined} />
        </picture>
      )}

      {overlay !== 'none' && <div className={cn('absolute inset-0', OVERLAYS[overlay])} />}

      {/* PERTO DA BASE (dono 07/08). Centralizado, o botão caía em cima do
          "Indomável" — a arte já usa o meio. Embaixo ele fica sobre a área
          calma da foto e vira o último passo natural da leitura. */}
      {(temTexto || temBotao) && (
        <div className="absolute inset-0 flex items-end">
          <Container width="page" className="relative z-10 pb-6 sm:pb-8 lg:pb-12">
            <div className={cn('flex flex-col', ALIGNMENTS[align])}>
              {eyebrow && <p className="eyebrow text-primary-soft">{eyebrow}</p>}
              {title && <h1 className="mt-4 max-w-3xl text-display text-light">{title}</h1>}
              {subtitle && (
                <p className="mt-5 max-w-xl text-body-lg font-light text-light/85">{subtitle}</p>
              )}
              {temBotao && (
                <div
                  className={cn(
                    'mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:gap-4',
                    align === 'center' && 'sm:justify-center',
                    align === 'right' && 'sm:justify-end',
                  )}
                >
                  {primaryAction && (
                    <Button
                      href={primaryAction.href}
                      external={primaryAction.external}
                      variant={primaryAction.variant ?? 'light'}
                      size="lg"
                      className="sm:w-auto"
                      block
                    >
                      {primaryAction.label}
                    </Button>
                  )}
                  {secondaryAction && (
                    <Button
                      href={secondaryAction.href}
                      external={secondaryAction.external}
                      variant={secondaryAction.variant ?? 'outlineLight'}
                      size="lg"
                      className="sm:w-auto"
                      block
                    >
                      {secondaryAction.label}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Container>
        </div>
      )}
    </section>
  );
});
