'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import { transition } from '@/lib/motion';
import { ProductBadgeTag } from '@/components/ui/Badge';
import type { Media, ProductBadge } from '@/types';

/**
 * Galeria do produto — miniaturas verticais à esquerda + foto grande, NO
 * CELULAR TAMBÉM (dono, 15/08).
 *
 * Antes a fileira de miniaturas ficava DEITADA embaixo da foto no mobile, e
 * isso custava 209px de rolagem: os 102px da própria fileira mais o respiro,
 * empurrando "Escolha o tamanho" para 1.216px (1,5 tela abaixo da foto) e o
 * botão Adicionar para 1.419px. Medido na PDP da SMILE em 375×812.
 *
 * Pior que a rolagem: em peça de várias cores essa fileira é **uma miniatura
 * por cor** e clicar nela TROCA a cor — o mesmo que a bolinha do passo "1
 * Escolha a cor" faz 435px mais abaixo. A cliente escolhia a cor em cima e o
 * site pedia a cor de novo lá embaixo, sem ela saber se a primeira valeu.
 *
 * Em pé, a coluna encosta na foto: a cor deixa de ser um bloco separado no
 * caminho e a decisão inteira sobe uma tela. O preço é a foto ficar mais
 * estreita (~259px em vez de 327px) — troca aceita pelo dono.
 *
 * A foto é o argumento de venda: proporção 3/4 e `priority` na primeira,
 * que é o LCP da página.
 */

/**
 * Miniatura POR COR (pedido do dono, 06/08): em peça com várias cores, a
 * barra lateral deixa de listar foto por foto — vira uma miniatura por cor,
 * e clicar TROCA A COR INTEIRA (galeria, preço e grade), igual à bolinha.
 * As demais fotos da cor ficam nas setas/contador da foto grande.
 */
export interface GrupoDeCor {
  nome: string;
  capa: string;
  ativa: boolean;
  onSelect: () => void;
  /**
   * Esta cor NAO tem o tamanho que ela escolheu (17/08).
   *
   * Riscada, nunca escondida: cor que some da tela parece defeito do site
   * e a cliente fica procurando. Riscada, ela entende que existe mas nao
   * no numero dela — e isso evita escolher pra levar um nao no fim.
   *
   * Continua clicavel de proposito: ela pode querer ver a peca naquela
   * cor e depois trocar de numero.
   */
  indisponivel?: boolean;
}

export function ProductGallery({
  images,
  name,
  autoPlay = false,
  grupos,
  badges,
}: {
  images: Media[];
  name: string;
  /** Passa as fotos sozinha a cada 4,5s — e para no primeiro sinal de interesse. */
  autoPlay?: boolean;
  /** Presente (2+) = barra lateral vira "uma miniatura por cor". */
  grupos?: GrupoDeCor[];
  /**
   * "Novo", "Promoção", "Últimas peças" — SOBRE a foto, canto superior
   * direito (dono, 15/08: "tem um carimbo NOVO ocupando um espaço absurdo").
   * No fluxo da coluna de compra ele custava 43px de rolagem (23 da pílula +
   * 20 de respiro) pra dizer uma palavra; sobre a foto ele não custa nada e
   * é onde a cliente já está olhando. O `Badge` sempre foi desenhado pra
   * isso — fundo opaco e `backdrop-blur`.
   */
  badges?: ProductBadge[];
}) {
  const [active, setActive] = useState(0);
  const [parado, setParado] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const safeImages = images.length > 0 ? images : [{ src: '', alt: name }];
  const current = safeImages[active];

  function step(delta: number) {
    setZoomed(false);
    setActive((i) => (i + delta + safeImages.length) % safeImages.length);
  }

  /**
   * Autoplay: mostra o caimento de vários ângulos (e as outras cores da peça)
   * sem a cliente precisar clicar.
   *
   * PARA no primeiro sinal de interesse — mouse em cima ou toque — e não
   * volta. Carrossel que continua andando enquanto a pessoa tenta olhar uma
   * foto é pior que carrossel nenhum: o automático serve pra quem está
   * passando o olho, não pra quem já parou pra decidir.
   */
  useEffect(() => {
    if (!autoPlay || parado || safeImages.length < 2) return;
    const timer = setInterval(() => {
      setActive((i) => (i + 1) % safeImages.length);
    }, 4500);
    return () => clearInterval(timer);
  }, [autoPlay, parado, safeImages.length]);

  return (
    <div
      className="flex flex-row-reverse gap-3 lg:gap-6"
      onPointerDown={() => setParado(true)}
      onMouseEnter={() => setParado(true)}
    >
      {/* Foto principal */}
      <div className="relative aspect-3/4 flex-1 overflow-hidden rounded-lg bg-surface-alt">
        {current.src ? (
          <motion.div
            key={current.src}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={transition.base}
            className="absolute inset-0"
          >
            <Image
              src={current.src}
              alt={current.alt}
              fill
              priority={active === 0}
              /**
               * QUALIDADE 90, e não o padrão 75 do Next.
               *
               * A foto do produto é o produto: é nela que a cliente decide se
               * o caimento serve. Medido em 13/08 na VLM-222 — a mesma foto em
               * AVIF sai com 11,4 KB a 75 e 15,5 KB a 90. Quatro quilobytes
               * pela textura do tecido é troca óbvia; 75 é ajuste de banner.
               */
              quality={90}
              /**
               * ⚠️ NÃO INFLAR ISTO. Tentei 70vw em 13/08 pra a lupa (que
               * amplia 1,7×) e o efeito foi a FOTO SUMIR da PDP.
               *
               * Cada largura nova é uma otimização a frio: a Vercel busca o
               * arquivo no R2 e reencoda na hora, e o domínio público do R2
               * responde **429 quando é puxado em paralelo** — a imagem falha
               * e o quadro vira texto alternativo. Com fonte de 700px ainda
               * por cima não havia ganho nenhum: w=1280, w=1920 e w=2400
               * devolvem os mesmos 21,8 KB, porque o teto é o arquivo.
               *
               * Aqui fica o tamanho REAL do quadro. Quando as fotos de
               * 1400×2000 entrarem, a nitidez vem delas — não de pedir uma
               * largura que o arquivo não tem.
               *
               * Segue 100vw no mobile mesmo depois da coluna de miniaturas
               * comer 68px (o quadro virou ~79vw em 15/08): apertar o número
               * faria o Next pedir uma largura NOVA e cair no reencode a frio
               * descrito acima. Servir alguns KB a mais é o lado barato.
               */
              sizes="(max-width: 1024px) 100vw, 45vw"
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className={cn(
                'object-cover transition-transform duration-500',
                zoomed && 'scale-[1.7] cursor-zoom-out',
              )}
            />
          </motion.div>
        ) : (
          <div className="grain size-full bg-gradient-to-br from-champagne to-surface-alt" />
        )}

        {/* Etiquetas no canto de cima à direita. A lupa, que morava aqui,
            foi pra ESQUERDA: os dois no mesmo canto se cobriam, e entre um
            selo que argumenta e um controle de zoom, quem manda no canto
            nobre é o selo. */}
        {badges && badges.length > 0 && (
          <div className="absolute top-4 right-4 z-[2] flex flex-col items-end gap-1.5">
            {badges.map((badge) => (
              <ProductBadgeTag key={badge} badge={badge} />
            ))}
          </div>
        )}

        {current.src && (
          <button
            type="button"
            onClick={() => setZoomed((value) => !value)}
            aria-label={zoomed ? 'Reduzir foto' : 'Ampliar foto'}
            aria-pressed={zoomed}
            className="absolute top-4 left-4 z-[2] flex size-11 items-center justify-center rounded-pill bg-surface/90 text-ink backdrop-blur transition-colors hover:bg-surface"
          >
            {zoomed ? <ZoomOut className="size-4" /> : <ZoomIn className="size-4" />}
          </button>
        )}

        {safeImages.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Foto anterior"
              className="absolute top-1/2 left-4 flex size-10 -translate-y-1/2 items-center justify-center rounded-pill bg-surface/85 text-ink backdrop-blur transition-colors hover:bg-surface"
            >
              <ChevronLeft className="size-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Próxima foto"
              className="absolute top-1/2 right-4 flex size-10 -translate-y-1/2 items-center justify-center rounded-pill bg-surface/85 text-ink backdrop-blur transition-colors hover:bg-surface"
            >
              <ChevronRight className="size-4" strokeWidth={1.75} />
            </button>
            <span className="tabular absolute right-4 bottom-4 rounded-pill bg-ink/70 px-3 py-1 text-[0.625rem] text-light backdrop-blur">
              {active + 1}/{safeImages.length}
            </span>
          </>
        )}
      </div>

      {/* Miniaturas: uma POR COR quando a peça tem variações; senão, por foto.

          A coluna é um trilho que ROLA DENTRO da altura da foto: o `absolute`
          tira as miniaturas do cálculo de altura, então uma peça de 8 cores
          não estica a galeria pra baixo — ela rola ali mesmo, ao lado da
          foto. Sem isso, cada cor a mais devolveria a rolagem que a mudança
          de 15/08 veio eliminar. */}
      {grupos && grupos.length > 1 ? (
        /* 64px no celular (era 56): sem as bolinhas da coluna de compra,
           esta fita virou o UNICO seletor de cor e precisa ser nitida.
           Cresce pra LARGURA de proposito — altura sairia do orcamento da
           dobra, que e o que acabou de por o botao de comprar na 1a tela. */
        <div className="relative w-16 shrink-0 lg:w-20">
          <div
            className="no-scrollbar absolute inset-0 flex flex-col gap-3 overflow-y-auto"
            role="tablist"
            aria-label="Cores da peça"
          >
            {grupos.map((g) => (
              <button
                key={g.nome}
                type="button"
                role="tab"
                aria-selected={g.ativa}
                aria-label={`Cor ${g.nome}`}
                title={g.nome}
                onClick={g.onSelect}
                className="w-full shrink-0"
              >
                <span
                  className={cn(
                    'relative block aspect-3/4 overflow-hidden rounded-md border transition-all duration-[320ms]',
                    g.indisponivel && 'opacity-45',
                    g.ativa
                      ? 'border-primary ring-2 ring-primary ring-offset-1 ring-offset-background opacity-100'
                      : 'border-transparent opacity-65 hover:opacity-100',
                  )}
                >
                  <Image
                    src={g.capa}
                    alt=""
                    aria-hidden
                    fill
                    sizes="80px"
                    placeholder="blur"
                    blurDataURL={BLUR_DATA_URL}
                    className="object-cover"
                  />
                  {/* A tarja — mesma convencao da grade de tamanhos. */}
                  {g.indisponivel && (
                    <span aria-hidden className="absolute inset-0 flex items-center justify-center">
                      <span className="h-px w-[140%] rotate-[38deg] bg-ink-soft/80" />
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    'mt-1.5 block truncate text-center text-[0.6875rem] leading-tight transition-colors',
                    g.ativa ? 'font-semibold text-ink' : 'text-ink-soft',
                  )}
                >
                  {g.nome}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : safeImages.length > 1 && (
        <div className="relative w-14 shrink-0 lg:w-20">
          <div
            className="no-scrollbar absolute inset-0 flex flex-col gap-3 overflow-y-auto"
            role="tablist"
            aria-label="Fotos do produto"
          >
            {safeImages.map((image, index) => (
              <button
                key={`${image.src}-${index}`}
                type="button"
                role="tab"
                aria-selected={index === active}
                aria-label={`Ver foto ${index + 1}`}
                onClick={() => {
                  setZoomed(false);
                  setActive(index);
                }}
                className={cn(
                  'relative aspect-3/4 w-full shrink-0 overflow-hidden rounded-md border transition-all duration-[320ms]',
                  index === active
                    ? 'border-primary opacity-100'
                    : 'border-transparent opacity-65 hover:opacity-100',
                )}
              >
                {image.src && (
                  <Image
                    src={image.src}
                    alt=""
                    aria-hidden
                    fill
                    sizes="80px"
                    placeholder="blur"
                    blurDataURL={BLUR_DATA_URL}
                    className="object-cover"
                  />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
