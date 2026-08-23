'use client';


import Image from 'next/image';
import { AppLink as Link } from '@/components/ui/AppLink';
import { Eye, Heart, ShoppingBag } from 'lucide-react';
import { BLUR_DATA_URL, cn, discountPercent, formatInstallments, formatPrice } from '@/lib/utils';
import { ProductBadgeTag, seloDoCard } from '@/components/ui/Badge';
import { useWishlistStore } from '@/store/wishlist';
import { useQuickAddStore } from '@/store/quick-add';
import { useMounted } from '@/hooks';
import type { Product } from '@/types';
import { ProgressiveImage } from '@/components/media/ProgressiveImage';

/**
 * PRODUCT CARD — o card definitivo do ecommerce. Nenhuma página cria o seu.
 *
 * Comportamento premium no hover (desktop):
 *   - a segunda foto entra em crossfade (troca automática de imagem)
 *   - a foto ativa dá zoom de 4%
 *   - "Quick view" e os tamanhos disponíveis sobem por baixo
 * No mobile nada disso dispara: o card fica limpo e o toque vai direto pro
 * produto (hover em touch é armadilha de usabilidade).
 *
 * Preço: valor cheio riscado + preço atual + Pix + parcelamento. O desconto
 * aparece como etiqueta calculada, nunca digitada à mão.
 */

interface ProductCardProps {
  product: Product;
  /** Índice na grade — usado só pro stagger da animação de entrada. */
  index?: number;
  /** Abre o Quick View (a página decide o que fazer). */
  onQuickView?: (product: Product) => void;
  /** Proporção da foto. 3/4 é o padrão editorial da marca. */
  aspect?: '3/4' | '4/5' | '1/1';
  className?: string;
  /** Primeiras fotos da primeira dobra podem priorizar carregamento. */
  priority?: boolean;
  /**
   * `sizes` do next/image. O padrão descreve a GRADE (categoria, busca). Num
   * carrossel o card é bem mais largo — quem monta o carrossel passa o seu,
   * senão o Next escolhe uma variante pequena demais e a foto sai borrada.
   */
  sizes?: string;
  /** Usado só na home: segura o download até a vitrine se aproximar. */
  progressiveImage?: boolean;
  /** Destino customizado, usado quando a origem precisa preservar atribuição. */
  href?: string;
  /** Dispara somente quando a cliente abre a página da peça. */
  onProductClick?: () => void;
  /**
   * SLOT DA HOME — hoje 2 colunas no celular e 6 no desktop. O modo nasceu
   * quando a home ainda usava 3 colunas no celular e preserva a apresentação
   * mais enxuta: evita que etiqueta, sacola e textos secundários disputem
   * atenção com foto, nome e preço.
   *
   * O modo enxuga o que é DECORAÇÃO nessa largura (tecido, faixa de tamanhos,
   * a repetição do "-50%") e aperta etiqueta e botões. O que faz a cliente
   * parar continua inteiro: foto, nome, preço riscado, preço atual e Pix.
   * Resultado medido a 360px — bloco de texto de 145px sob foto de 122px, com
   * variação de altura ZERO entre os 18 cards, contra 189px antes do enxugo.
   */
  compact?: boolean;
}

/** Largura do card na grade padrão de catálogo. */
const GRID_SIZES = '(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw';

/**
 * Largura do card no carrossel `perView={{ base: 1.35, sm: 2, lg: 3, xl: 4 }}`
 * — no mobile ele ocupa ~2/3 da tela, muito mais que os 50vw da grade.
 */
export const CAROUSEL_PRODUCT_SIZES =
  '(max-width: 640px) 68vw, (max-width: 1024px) 46vw, (max-width: 1280px) 31vw, 23vw';

/**
 * Largura do card na GRADE DA HOME — 2 colunas no celular, 3 até 1279px e 6
 * a partir de 1280.
 *
 * Precisa ser diferente do carrossel porque lá o card ocupa 68vw no celular e
 * aqui ocupa 47vw no celular e 30vw no tablet. Herdar o `sizes` do carrossel
 * faria o Next servir uma variante maior que o slot real, multiplicando bytes
 * por foto em todas as vitrines.
 *
 * O `300px` fixo do desktop é exato, não chute: o `max-w-wide` trava o
 * container em 1344px, então (1344 − 80 de gutter − 3 gaps de 24) / 4 = 298px
 * é a largura MÁXIMA que este card alcança em qualquer monitor (grade da home
 * é 4 colunas a partir de `lg:` desde 20/08).
 */
export const HOME_GRID_SIZES = '(max-width: 639px) 47vw, (max-width: 1023px) 30vw, 300px';

export function ProductCard({
  product,
  index = 0,
  onQuickView,
  aspect = '3/4',
  className,
  priority = false,
  sizes = GRID_SIZES,
  progressiveImage = false,
  href: customHref,
  onProductClick,
  compact = false,
}: ProductCardProps) {
  const mounted = useMounted();
  const abrirQuickAdd = useQuickAddStore((s) => s.abrir);
  const toggleWishlist = useWishlistStore((s) => s.toggle);
  const isFavorite = useWishlistStore((s) => s.ids.includes(product.id));

  // Card de UMA COR (dono, 20/08): o link já leva a cor — a PDP abre com
  // ela como principal e as miniaturas de todas as cores presentes.
  const href =
    customHref ??
    `/produto/${product.slug}${
      product.vitrineCor ? `?cor=${encodeURIComponent(product.vitrineCor.nome)}` : ''
    }`;
  const cover = product.images[0];
  const alternate = product.images[1];
  const discount = product.compareAtPrice
    ? discountPercent(product.compareAtPrice, product.price)
    : 0;
  /** A única etiqueta do card — prioridade em `seloDoCard`. */
  const selo = seloDoCard(product.badges, discount > 0);
  const availableSizes = product.sizes.filter((s) => s.available);
  const temEstoque = availableSizes.length > 0;
  /**
   * Esgotado = sem grade disponível E sem estoque online. As duas condições
   * porque a grade pode chegar vazia numa peça que existe (cadastro sem
   * tamanho), e riscar o preço de peça vendável é pior que não riscar.
   */
  const esgotado = !temEstoque && product.availability?.online === false;

  /**
   * "Do 44 ao 60" — a pergunta nº 1 da cliente plus size é se serve nela, e a
   * resposta cabe numa linha. Só sai quando os tamanhos são numéricos: com
   * P/M/G a faixa não significa nada.
   */
  const faixaDeTamanhos = (() => {
    const numeros = availableSizes
      .map((s) => parseInt(String(s.label).replace(/\D/g, ''), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (numeros.length < 2) return null;
    const min = Math.min(...numeros);
    const max = Math.max(...numeros);
    return min === max ? null : `Do ${min} ao ${max}`;
  })();

  const aspectClass =
    aspect === '3/4' ? 'aspect-3/4' : aspect === '4/5' ? 'aspect-4/5' : 'aspect-square';
  const ProductImage = progressiveImage ? ProgressiveImage : Image;

  /**
   * O stagger da entrada é calibrado pelo número de COLUNAS — a onda só lê
   * como onda se reiniciar no começo de cada linha. O 4 é da grade de
   * catálogo; a grade da home usa 3, que fecha certo nas DUAS larguras dela
   * (3 colunas = uma onda por linha; 6 = a mesma onda repetida duas vezes).
   * Com o 4 numa linha de 6 a onda reinicia no quinto card e a entrada fica
   * visivelmente torta.
   */
  const colunasDoStagger = compact ? 3 : 4;

  /**
   * No card estreito o parcelamento sai da linha do Pix — mas só quando existe
   * preço no Pix pra ocupar o lugar dela, senão a linha ficaria vazia.
   *
   * Medido a 360px (card de 91px): "R$ 75,91 no Pix · 12x de R$ 6,66" quebra
   * em TRÊS linhas, 59px de texto sob uma foto de 122px. O Pix é o que a
   * cliente decide na vitrine (é o desconto que ela vê agora); o parcelamento
   * ela confere na página da peça, onde a linha cabe inteira.
   */
  const mostraParcelamento = !compact || !product.pixPrice;

  return (
    <article
      className={cn(
        'group relative flex animate-[widget-enter_560ms_cubic-bezier(0.22,1,0.36,1)_both] flex-col',
        className,
      )}
      style={{ animationDelay: `${(index % colunasDoStagger) * 60}ms` }}
    >
      {/* Mídia */}
      <div className={cn('relative overflow-hidden rounded-md bg-surface-alt', aspectClass)}>
        <Link href={href} onClick={onProductClick} className="absolute inset-0" aria-label={product.name}>
          <ProductImage
            src={cover.src}
            alt={cover.alt}
            fill
            priority={priority}
            sizes={sizes}
            placeholder="blur"
            blurDataURL={BLUR_DATA_URL}
            className={cn(
              'object-cover transition-all duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
              'opacity-100 lg:group-hover:scale-[1.04]',
              // A troca de foto no hover era `useState` — agora é `group-hover`.
              // Ver o comentário no topo do componente.
              alternate && 'lg:group-hover:opacity-0',
            )}
          />
          {alternate && (
            <ProductImage
              src={alternate.src}
              alt=""
              aria-hidden
              fill
              sizes={sizes}
              placeholder="blur"
              blurDataURL={BLUR_DATA_URL}
              className={cn(
                'hidden object-cover transition-all duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] lg:block',
                'opacity-0 lg:group-hover:scale-[1.04] lg:group-hover:opacity-100',
              )}
            />
          )}
        </Link>

        {/* Etiquetas — EMBAIXO da foto (dono, 21/08: "a etiqueta cobre o
            rosto da modelo"). No topo elas caíam exatamente onde o rosto
            fica no enquadramento 3/4; embaixo à esquerda ficam sobre a
            barra/pernas, e o canto de baixo à direita segue da sacolinha. */}
        <div
          className={cn(
            'pointer-events-none absolute flex flex-col items-start gap-1.5',
            // O `right-2` existe pra dar à etiqueta um limite de largura: sem
            // ele o bloco é `auto` e um rótulo longo vaza pra fora da moldura
            // em vez de quebrar. Ver o `compact` do `Badge`.
            compact ? 'bottom-2 right-2 left-2' : 'bottom-3 left-3',
          )}
        >
          {/* UMA etiqueta, nunca duas (ver `seloDoCard`). Antes saíam até três
              empilhadas e a de promoção competia com "Novo", que estava em
              quase toda a home. */}
          {selo && <ProductBadgeTag badge={selo} compact={compact} />}
        </div>

        {/* Favoritar */}
        <button
          type="button"
          onClick={() => toggleWishlist(product.id)}
          aria-label={isFavorite ? `Remover ${product.name} dos favoritos` : `Salvar ${product.name} nos favoritos`}
          aria-pressed={mounted ? isFavorite : undefined}
          className={cn(
            'absolute items-center justify-center rounded-pill bg-surface/85 text-ink backdrop-blur transition-colors hover:bg-surface',
            /**
             * O coração SOME abaixo de 640px na grade da home, e é geometria,
             * não gosto: ali o card tem 93px de largura. O botão (32px, no
             * canto direito) e a etiqueta "Promoção" (76px, no esquerdo) não
             * cabem na mesma linha — um passa por baixo do outro. Some o que
             * é secundário: favoritar continua no card da categoria, na busca
             * e na página da peça; a etiqueta de desconto não tem segunda
             * chance de aparecer. De 640px pra cima o card já tem 186px e os
             * dois voltam a conviver.
             */
            compact ? 'hidden top-2 right-2 size-8 sm:flex' : 'flex top-3 right-3 size-9',
          )}
        >
          <Heart
            className={cn(
              'size-4 transition-colors',
              mounted && isFavorite ? 'fill-secondary text-secondary' : 'text-ink-soft',
            )}
            strokeWidth={1.5}
          />
        </button>

        {/* ADICIONAR RÁPIDO — abre a janelinha de cor/tamanho sem sair da
            página. Fica FORA da camada de hover de propósito: no celular não
            existe hover, e é no celular que a cliente compra. */}
        {temEstoque && (
          <button
            type="button"
            onClick={() => abrirQuickAdd(product)}
            aria-label={`Adicionar ${product.name} à sacola`}
            className={cn(
              'absolute z-[1] flex items-center justify-center rounded-pill bg-ink/90 text-light backdrop-blur transition-transform hover:scale-105',
              // O `size-10` foi desenhado pro card de 2 colunas. Nos 91px da
              // grade da home ele ocuparia 44% da largura, sobre uma foto de
              // 91×122 — vira um botão em cima da peça, não ao lado dela. Com
              // `size-8` cai pra 34%, medido.
              // E some no CELULAR nos dois modos: com o COMPRAR de volta
              // embaixo do card, o redondo sobre a foto virava um segundo
              // botão de sacola no mesmo card. É a regra que o catálogo já
              // seguia — no celular quem adiciona é o COMPRAR, o redondo é o
              // atalho de quem tem mouse.
              compact
                ? 'right-2 bottom-2 hidden size-8 lg:flex lg:size-9'
                : 'right-3 bottom-3 hidden size-10 lg:flex lg:size-9',
            )}
          >
            <ShoppingBag className="size-4" strokeWidth={1.75} />
          </button>
        )}

        {/* Camada de hover: quick view + tamanhos (desktop) */}
        <div
          className={cn(
            'pointer-events-none absolute hidden flex-col gap-2 transition-all duration-[320ms] ease-[cubic-bezier(0.22,1,0.36,1)] lg:flex',
            // Acompanha o recuo do botão da sacola pra não sobrarem duas
            // margens diferentes dentro da mesma moldura.
            compact ? 'inset-x-2 bottom-2' : 'inset-x-3 bottom-3',
            'translate-y-3 opacity-0 lg:group-hover:translate-y-0 lg:group-hover:opacity-100',
          )}
        >
          {availableSizes.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {/* A GRADE INTEIRA (dono 07/08). O corte em 6 escondia o 58 e o
                  60 justamente nas peças que vão até lá — o card mostrava
                  "46 48 50 52 54 56" embaixo da frase "Do 44 ao 60", e a
                  cliente de 60 concluía que a peça não servia pra ela. A grade
                  da casa tem 9 números; cabem em duas linhas de pílula. */}
              {availableSizes.slice(0, 10).map((size) => (
                <span
                  key={size.label}
                  className="tabular rounded-xs bg-surface/90 px-2 py-1 text-[0.625rem] font-medium text-ink backdrop-blur"
                >
                  {size.label}
                </span>
              ))}
            </div>
          )}
          {onQuickView && (
            <button
              type="button"
              onClick={() => onQuickView(product)}
              className="pointer-events-auto inline-flex items-center justify-center gap-2 rounded-pill bg-ink/90 px-4 py-2.5 text-[0.6875rem] font-medium tracking-[0.16em] text-light uppercase backdrop-blur transition-colors hover:bg-ink"
            >
              <Eye className="size-3.5" strokeWidth={1.75} />
              Ver rápido
            </button>
          )}
        </div>
      </div>

      {/* Texto */}
      <div
        className={cn(
          'flex flex-1 flex-col',
          // Centralizado NO CELULAR (dono, 18/08: "está deslocado para a
          // esquerda"). Com o COMPRAR de largura cheia embaixo, texto à
          // esquerda deixa o card com dois eixos — o preço num canto e o botão
          // ocupando tudo. No computador não existe o botão, e a leitura em
          // coluna alinhada à esquerda continua sendo a certa.
          compact ? 'mt-3 text-center lg:text-left' : 'mt-2.5 text-center lg:mt-4 lg:text-left',
        )}
      >
        {/* O tecido usa a `.eyebrow` — a mesma régua que faz a palavra
            "Promoção" medir 117px num card de 91px. Um nome de tecido
            ("VISCOLYCRA PREMIUM") é o dobro disso em caixa alta: vira um
            parágrafo de três linhas pra uma informação que não decide a
            compra na vitrine. Fica na ficha da peça. */}
        {product.fabric && !compact && (
          <p className="eyebrow hidden text-ink-muted lg:block">{product.fabric}</p>
        )}

        <h3 className={cn(compact ? 'mt-1.5' : 'lg:mt-1.5')}>
          <Link
            href={href}
            onClick={onProductClick}
            className={cn(
              'font-normal text-ink transition-colors hover:text-primary-strong',
              // Nome real do catálogo ("Blusa Manga Curta — 700984") tem 26
              // caracteres na mediana e 37 no pior caso. Em `text-body` num
              // card de 93px isso vira quatro linhas; em `text-small` cabe em
              // duas. O clamp é a rede: sem ele um nome longo sozinho estica a
              // linha inteira da grade e abre um rasgo branco sob os vizinhos.
              // No celular o nome fica em UMA linha: a segunda linha do
              // nome empurra preço e botão pra baixo em metade dos cards e
              // desalinha a grade inteira. No computador ele volta inteiro.
              compact ? 'line-clamp-2 text-small xl:text-body' : 'line-clamp-1 text-small lg:line-clamp-none lg:text-body',
            )}
          >
            {product.name}
          </Link>
        </h3>

        {/* ESGOTADO aparece, riscado (item 37 — decisão do dono 04/08).
            A peça esgotada sumia da vitrine sem explicação: quem viu no
            Instagram voltava e achava que o site tinha quebrado. Vendo que
            existe e acabou, a cliente pergunta quando volta — que é
            exatamente a lista de espera que queremos. */}
        {esgotado ? (
          <>
            <div className="mt-1 flex flex-wrap items-baseline justify-center gap-x-2.5 gap-y-1 lg:mt-2 lg:justify-start">
              <span className="tabular text-small text-ink-muted line-through lg:text-body">
                {formatPrice(product.price)}
              </span>
            </div>
            <p className="mt-0.5 text-[0.6875rem] font-medium text-ink-soft lg:mt-1 lg:text-small">
              Esgotado por enquanto
            </p>
          </>
        ) : (
          <>
            <div
              className={cn(
                'flex flex-wrap items-baseline gap-y-1',
                compact
                  ? 'mt-2 gap-x-2'
                  : 'mt-1 justify-center gap-x-2 lg:mt-2 lg:justify-start lg:gap-x-2.5',
              )}
            >
              {product.compareAtPrice && (
                <span
                  className={cn(
                    'tabular text-ink-muted line-through',
                    compact ? 'text-small' : 'text-[0.6875rem] lg:text-small',
                  )}
                >
                  {formatPrice(product.compareAtPrice)}
                </span>
              )}
              <span
                className={cn(
                  'tabular font-medium text-ink',
                  compact ? 'text-body' : 'text-small lg:text-body',
                )}
              >
                {formatPrice(product.price)}
              </span>
              {/* O "-50%" sai do card estreito porque ele é a TERCEIRA ficha
                  de preço numa linha de 91px — os três não cabem e a linha
                  virava três, 72px de texto. É também o único dos três que se
                  repete: a etiqueta "Promoção" já está na foto, logo acima. O
                  par riscado/atual fica, que é o que faz a cliente parar. */}
              {discount > 0 && !compact && (
                <span className="tabular text-small font-medium text-secondary">-{discount}%</span>
              )}
            </div>

            <p
              className={cn(
                'font-light text-ink-soft',
                compact ? 'mt-1 text-small' : 'mt-0.5 text-[0.6875rem] lg:mt-1 lg:text-small',
              )}
            >
              {product.pixPrice && (
                <span className={compact ? undefined : 'hidden lg:inline'}>
                  <span className="tabular font-medium text-success">{formatPrice(product.pixPrice)}</span>{' '}
                  no Pix
                  {mostraParcelamento && ' · '}
                </span>
              )}
              {mostraParcelamento && (
                <span className="tabular">
                  {product.installments
                    ? `${product.installments.times}x de ${formatPrice(product.installments.value)}`
                    : formatInstallments(product.price)}
                </span>
              )}
            </p>
          </>
        )}

        {/* A faixa sai do card estreito: a mesma resposta ("serve em mim?")
            já está nas pílulas de tamanho do hover e na página da peça, e
            aqui ela custa mais uma linha de texto num bloco que já compete
            com a foto. Ver o comentário do `compact`. */}
        {faixaDeTamanhos && !compact && (
          <p className="mt-1.5 hidden text-small text-ink-muted lg:block">{faixaDeTamanhos}</p>
        )}

        {/* AS BOLINHAS DE COR SAÍRAM DO CARD (dono, 21/08: "cada cor é um
            produto"). O card que sobra com várias cores é o da peça cujas
            cores não têm foto própria — a bolinha prometia uma escolha que
            agora acontece em outro card. Fica uma LINHA discreta contando as
            cores; a escolha em si é a grade da PDP. */}
        {!product.vitrineCor && product.colors && product.colors.length > 1 && (
          <p
            className={cn(
              'text-[0.6875rem] text-ink-muted',
              compact ? 'mt-2 text-center lg:text-left' : 'mt-1.5 text-center lg:text-left',
            )}
          >
            +{product.colors.length - 1} {product.colors.length - 1 === 1 ? 'cor' : 'cores'}
          </p>
        )}

        {/* ⚠️ O `!compact` saiu daqui (21/08). Ele foi escrito em 18/08, quando
            a HOME tinha 3 colunas no celular e o card media 91px — botão de
            largura cheia não cabia. Em 20/08 a home virou 2 colunas e o card
            passou a medir 152px, contra 156px do catálogo que SEMPRE teve o
            COMPRAR: a mesma largura, o mesmo botão. Enquanto a condição ficou
            de pé, a home inteira (137 cards) ficou sem botão de comprar e
            /novidades com ele — medido no ar. */}
        {temEstoque && (
          /* O `mt-auto` fica NO WRAPPER e o respiro é o `pt-3`: sozinho no
             botão, o `mt-auto` vira 0 quando não sobra espaço no card e a
             parcela cola no COMPRAR (foi o que ele viu no ar). Assim o botão
             continua alinhado com o dos vizinhos e nunca encosta no texto. */
          <div className="mt-auto pt-3 lg:hidden">
            <button
              type="button"
              onClick={() => abrirQuickAdd(product)}
              aria-label={`Comprar ${product.name}`}
              className="flex w-full items-center justify-center gap-1.5 rounded-xs bg-ink px-3 py-2.5 text-[0.6875rem] font-medium tracking-[0.14em] text-light uppercase transition-colors active:bg-ink-soft"
            >
              <ShoppingBag className="size-3.5" strokeWidth={1.75} />
              Comprar
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
