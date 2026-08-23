'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Play, ZoomIn, ZoomOut } from 'lucide-react';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import { transition } from '@/lib/motion';
import { youtubeCapa, youtubeEmbed } from '@/lib/youtube';
import { ProductBadgeTag } from '@/components/ui/Badge';
import type { Media, ProductBadge } from '@/types';

/**
 * Galeria do produto — SÓ a foto grande. Setas + contador navegam as fotos.
 *
 * A RÉGUA LATERAL MORREU INTEIRA AQUI (dono, 20/08 à noite, em dois atos):
 * primeiro a de CORES ("cortou as cores que temos" — em peça de 8 cores ela
 * mostrava 3 e escondia 5 atrás do "MAIS CORES"), depois a de FOTOS ("tira
 * as miniaturas laterais"). O seletor de cor é a GRADE DE CORES do
 * EscolhaDaPeca — embaixo da foto no celular, na coluna de compra no PC —
 * e as fotos extras da cor vivem nas setas + contador sobre a foto grande.
 *
 * A foto é o argumento de venda: proporção 3/4 e `priority` na primeira,
 * que é o LCP da página.
 */

/**
 * VÍDEO DA PEÇA — o último slide da galeria (19/08).
 *
 * O link é cadastrado POR COR na tela master e vinha sendo salvo desde então
 * sem nada na página que o mostrasse. Entra aqui, junto das fotos, porque é
 * onde a cliente já está olhando: no fim da página, com 81% que não rolam, o
 * vídeo seria cadastrado pra ninguém.
 */
export interface VideoDaPeca {
  /** Id do YouTube JÁ extraído — a galeria não conhece formato de URL. */
  id: string;
  /**
   * A cor DE QUEM é o vídeo, quando não é a cor escolhida. Fica escrito sobre
   * a capa pela mesma razão do aviso de foto ilustrativa: peça gravada em
   * PRETO e comprada achando que era a VINHO volta como troca.
   */
  corDoVideo?: string | null;
}

/**
 * O SLIDE DO VÍDEO — capa primeiro, player só no clique.
 *
 * O iframe do YouTube carrega ~700 KB e abre conexão com três domínios; posto
 * junto com a página, disputa banda com a foto do produto, que é o LCP da
 * PDP. Aqui o primeiro render leva só a capa (~15 KB) e o player nasce quando
 * ela pede — e morre sozinho ao trocar de slide, porque o componente desmonta
 * (é o que impede o som de continuar tocando atrás da foto).
 */
function VideoSlide({ id, corDoVideo, name }: VideoDaPeca & { name: string }) {
  const [tocando, setTocando] = useState(false);

  if (tocando) {
    return (
      /* O player OCUPA O QUADRO INTEIRO, e não um 16:9 centralizado.
         O vídeo da loja é gravado no celular, em pé — o link que chegou na
         primeira peça é um `/shorts/`. Num player 16:9 dentro de um quadro
         3/4, um vídeo vertical vira uma tirinha no meio de duas barras
         pretas. Ocupando tudo, o vertical enche a moldura e o horizontal
         fica do mesmo tamanho que ficaria: a largura é a mesma, o YouTube só
         desenha a borda por dentro. */
      <div className="absolute inset-0 bg-ink">
        <iframe
          src={youtubeEmbed(id)}
          title={`Vídeo de ${name}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          className="absolute inset-0 size-full border-0"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setTocando(true)}
      aria-label={`Ver o vídeo de ${name}`}
      className="group absolute inset-0 flex items-center justify-center bg-ink"
    >
      <Image
        src={youtubeCapa(id)}
        alt=""
        aria-hidden
        fill
        /* 640px fixo, e não a largura do quadro: a capa do YouTube tem 480px
           de largura e ponto. Declarar `100vw` fazia o Next pedir w=2400 de
           um arquivo que não tem — largura nova é transformação nova na
           Vercel, paga pra devolver exatamente os mesmos 10 KB. */
        sizes="640px"
        placeholder="blur"
        blurDataURL={BLUR_DATA_URL}
        className="object-cover opacity-75 transition-opacity duration-500 group-hover:opacity-90"
      />
      <span className="relative flex size-16 items-center justify-center rounded-pill bg-surface/90 text-ink backdrop-blur transition-transform duration-300 group-hover:scale-105">
        <Play className="size-6 translate-x-0.5 fill-current" strokeWidth={1.5} />
      </span>
      {corDoVideo && (
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/85 to-transparent px-4 pt-8 pb-4 text-center text-small text-light">
          Vídeo gravado na cor {corDoVideo}
        </span>
      )}
    </button>
  );
}

export function ProductGallery({
  images,
  name,
  autoPlay = false,
  badges,
  video,
}: {
  images: Media[];
  name: string;
  /** Passa as fotos sozinha a cada 4,5s — e para no primeiro sinal de interesse. */
  autoPlay?: boolean;
  /**
   * "Novo", "Promoção", "Últimas peças" — SOBRE a foto, canto superior
   * direito (dono, 15/08: "tem um carimbo NOVO ocupando um espaço absurdo").
   * No fluxo da coluna de compra ele custava 43px de rolagem (23 da pílula +
   * 20 de respiro) pra dizer uma palavra; sobre a foto ele não custa nada e
   * é onde a cliente já está olhando. O `Badge` sempre foi desenhado pra
   * isso — fundo opaco e `backdrop-blur`.
   */
  badges?: ProductBadge[];
  /** O vídeo da peça, quando a ficha da cor tem um. Vira o ÚLTIMO slide. */
  video?: VideoDaPeca | null;
}) {
  const [active, setActive] = useState(0);
  const [parado, setParado] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const safeImages = images.length > 0 ? images : [{ src: '', alt: name }];
  /**
   * O vídeo fica FORA de `safeImages` de propósito: aquela lista alimenta o
   * autoplay e a lupa, e nenhum dos dois faz sentido em vídeo. Aqui ele é só
   * mais um índice — `total` é o que a cliente vê no contador.
   */
  const iVideo = video ? safeImages.length : -1;
  const total = safeImages.length + (video ? 1 : 0);
  const noVideo = active === iVideo;
  /** Índice de vídeo não tem foto: sem isto, `current.src` quebra a página. */
  const current = safeImages[active] ?? safeImages[0];

  function step(delta: number) {
    setZoomed(false);
    setActive((i) => (i + delta + total) % total);
  }

  function irPara(indice: number) {
    setZoomed(false);
    setActive(indice);
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
      // Só pelas FOTOS: carrossel que entra sozinho no vídeo tira a peça da
      // frente de quem está passando o olho pra mostrar um botão de play.
      setActive((i) => (i >= safeImages.length ? i : (i + 1) % safeImages.length));
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
      {/* A FOTO NÃO PASSA DE 52% DA ALTURA DA TELA NO CELULAR (22/08).

          Medido em 390×734 na BMM-100: o quadro 3/4 dava 342×456 — 62% da
          dobra numa foto só, e o seletor de tamanho nascia em 786px, com a
          barra fixa comendo os últimos 95. O teto é em `svh` de propósito:
          em iPhone 15 (844) a foto quase não muda (439 contra 456), em tela
          curta ela cede o que precisa. O PC não tem dobra pra brigar e fica
          no 3/4 inteiro (`lg:max-h-none`).

          O catálogo tem foto 3/4 (ensaio novo) E foto quadrada (era
          WooCommerce). O corte de altura só existe pra 3/4; na quadrada o
          quadro mais baixo até MELHORA — no 3/4 ela perdia 57px de cada
          lado pra caber. */}
      <div className="relative aspect-3/4 max-h-[52svh] flex-1 overflow-hidden rounded-lg bg-surface-alt lg:max-h-none">
        {video && noVideo ? (
          <VideoSlide id={video.id} corDoVideo={video.corDoVideo} name={name} />
        ) : current.src ? (
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
              /* O CORTE PUXA PRO ALTO (25%), não pro meio: com o teto de
                 altura, a foto 3/4 perde 74px em 390×734 — centralizado,
                 metade sairia do topo e raspava o cabelo da modelo (o ensaio
                 deixa ~5% de ar acima da cabeça). Em 25% saem 18px de cima e
                 55 de baixo, onde há shorts/piso e não peça: a barra da
                 blusa termina em 79% da foto. */
              className={cn(
                'object-cover object-[center_25%] transition-transform duration-500 lg:object-center',
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

        {/* Lupa nunca sobre o vídeo: ampliar iframe não amplia nada. */}
        {current.src && !noVideo && (
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

        {/* PORTA DE ENTRADA DO VÍDEO. Existe mesmo com o trilho mostrando
            fotos, e é a ÚNICA em peça de várias cores: ali o trilho vira um
            seletor de cor (uma miniatura por cor) e não lista foto nenhuma —
            sem este botão o vídeo só apareceria pra quem clicasse a seta até
            o fim. Canto de baixo à esquerda: o de cima é da lupa, o de cima à
            direita dos selos, o de baixo à direita do contador. */}
        {video && !noVideo && (
          <button
            type="button"
            onClick={() => irPara(iVideo)}
            /* Menor no celular: a foto ali tem 251px de largura e a pílula
               de 116px comia quase metade dela. Os 44px de altura ficam —
               é o alvo mínimo de toque. */
            className="absolute bottom-3 left-3 z-[2] flex min-h-11 items-center gap-1.5 rounded-pill bg-surface/90 px-3 text-[0.6875rem] font-semibold text-ink backdrop-blur transition-colors hover:bg-surface sm:bottom-4 sm:left-4 sm:gap-2 sm:px-4 sm:text-small"
          >
            <Play className="size-4 fill-current" strokeWidth={1.5} />
            Ver vídeo
          </button>
        )}

        {total > 1 && (
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
              {active + 1}/{total}
            </span>
          </>
        )}
      </div>

      {/* AS MINIATURAS LATERAIS SAÍRAM (dono, 20/08: "tira as miniaturas
          laterais"). A navegação pelas fotos é setas + contador sobre a
          própria foto; o vídeo tem a pílula "Ver vídeo". A foto grande fica
          com a largura inteira da coluna. */}
    </div>
  );
}
