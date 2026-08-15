'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { AlertCircle, ArrowRight, Check, Heart, Lock, MapPin, MessageCircle, Ruler, ShoppingBag, Star } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { SimuladorFrete } from '@/components/commerce/SimuladorFrete';
import { SizePill } from '@/components/ui/Choice';
import { useToast } from '@/components/feedback/ToastProvider';
import { useCartStore } from '@/store/cart';
import { useUiStore } from '@/store/ui';
import { useWishlistStore } from '@/store/wishlist';
import { trackAddToCart, trackAddToCartBlocked, trackColorSwitch, trackSizeSwitch, trackViewItem } from '@/lib/tracking';
import { useMounted } from '@/hooks';
import { cn, discountPercent, formatPrice } from '@/lib/utils';
import { hexDaCor, type PecaApi } from '@/services/products';
import type { Product } from '@/types';
import { STORE_POLICIES } from '@/data/store-policies';
import { SeloVendas } from '@/components/commerce/SeloVendas';
import { linkWhatsapp } from '@/data/contato';
import { SITE } from '@/lib/seo';

/**
 * BUY BOX — a coluna de decisão de compra.
 *
 * Ordem deliberada: nome → avaliação → preço (com Pix e parcelamento) →
 * tamanho → comprar. O seletor de tamanho vem ANTES do botão porque a dúvida
 * real da cliente plus size é "tem no meu número?", não "quanto custa".
 *
 * Sem tamanho escolhido o botão não some nem fica desabilitado em silêncio:
 * ele avisa. Botão morto sem explicação é o erro clássico de PDP.
 */
export interface CorEscolhivel {
  nome: string;
  swatch: { tipo: 'cor' | 'foto'; hex: string | null; focoX: number | null; focoY: number | null; imagem: string | null };
  estoque: number;
}

export function BuyBox({
  product, cores, corSelecionada, onSelecionarCor, alertaEstoque, look,
}: {
  product: Product;
  /** Cores da peça. Vazio = peça de cor única (ou catálogo sem ficha ainda). */
  cores?: CorEscolhivel[];
  corSelecionada?: string | null;
  onSelecionarCor?: (nome: string) => void;
  /** "Restam 2 nesta cor" — só com número REAL do estoque, nunca inventado. */
  alertaEstoque?: string | null;
  /** As peças que saem na MESMA foto (curadoria de /retaguarda/looks). */
  look?: PecaApi['look'];
}) {
  const irmasDoLook = (look?.pecas ?? []).filter((p) => !p.atual);
  const [size, setSize] = useState<string | null>(null);
  const [sizeError, setSizeError] = useState(false);
  // A tabela abre sobre a PDP para a cliente não perder a seleção da peça.
  const [sizeChartOpen, setSizeChartOpen] = useState(false);
  const { toast } = useToast();
  const mounted = useMounted();
  const addToCart = useCartStore((s) => s.add);
  const openOverlay = useUiStore((s) => s.openOverlay);
  const toggleWishlist = useWishlistStore((s) => s.toggle);
  const isFavorite = useWishlistStore((s) => s.ids.includes(product.id));

  /**
   * VIEW_ITEM — o topo do funil.
   *
   * Dispara aqui, e não na página, porque a PDP é Server Component: quem sabe
   * que a peça foi VISTA por um navegador é o primeiro pedaço client que
   * monta com o produto na mão. A cor selecionada entra junto — é ela que
   * distingue a peça no remarketing.
   *
   * A trava por `product.id` existe porque `view_item` não tem `dedupe_key`:
   * sem ela, o StrictMode do dev e qualquer re-render por troca de cor
   * mandariam a mesma visualização duas vezes, inflando o funil.
   */
  const viewTrackedRef = useRef<string | number | null>(null);
  useEffect(() => {
    if (viewTrackedRef.current === product.id) return;
    viewTrackedRef.current = product.id;
    trackViewItem(product, { cor: corSelecionada ?? undefined });
    // `corSelecionada` de propósito fora das deps: trocar de cor não é uma
    // nova visualização da peça.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product]);

  const available = product.sizes.filter((s) => s.available);
  const soldOut = available.length === 0;
  /** Peça com mais de uma cor: só aí a escolha de cor é um passo de verdade. */
  const temCor = !!cores && cores.length > 1;

  /**
   * O TAMANHO ESCOLHIDO ACABOU ENQUANTO ELA OLHAVA (dono, 13/08).
   *
   * A grade se reconfere sozinha (ver `useEstoqueAoVivo`), então o 48 pode
   * sair da prateleira com a cliente na página. Deixar o botão selecionado e
   * indisponível ao mesmo tempo é o pior dos mundos: ela clica em "Adicionar",
   * o pedido vai, e o guard do carrinho recusa lá no fim — depois de ela ter
   * preenchido o CEP.
   *
   * Então a seleção cai E ela é avisada. Sumir em silêncio faria a próxima
   * tentativa de comprar esbarrar em "Escolha um tamanho pra continuar", sem
   * ninguém explicar por que o dela sumiu.
   *
   * `product.sizes.length` na condição: grade vazia por um instante (troca de
   * cor) não é tamanho esgotado, e limpar a escolha ali seria bug puro.
   */
  const escolhidoEsgotou =
    !!size && product.sizes.length > 0 && !product.sizes.some((s) => s.label === size && s.available);

  useEffect(() => {
    if (!escolhidoEsgotou) return;
    const perdido = size;
    setSize(null);
    setSizeError(false);
    toast({
      message: `O tamanho ${perdido} acabou agora`,
      description: 'Alguém levou a última enquanto você olhava. Escolha outro tamanho.',
    });
    // `size` e `toast` de fora de propósito: o gatilho é o tamanho ter deixado
    // de existir, e reagir à própria limpeza reabriria o aviso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escolhidoEsgotou]);
  const discount = product.compareAtPrice
    ? discountPercent(product.compareAtPrice, product.price)
    : 0;

  function handleAdd() {
    if (!size) {
      trackAddToCartBlocked(product, soldOut ? 'sold_out' : 'size_missing');
      setSizeError(true);
      document.getElementById('seletor-tamanho')?.scrollIntoView({ block: 'center' });
      return;
    }
    /**
     * A cor escolhida vai junto no carrinho, NO CAMPO `color`.
     *
     * Até 06/08 ela só entrava colada no `name` ("Vestido · PRETO"): a
     * separação tinha que adivinhar a cor lendo um "·" no meio de um texto, e
     * o guard do backend não conseguia conferir o estoque da variação certa —
     * somava as cores todas e podia deixar passar peça esgotada naquela cor.
     */
    const cor = corSelecionada ?? (cores?.length === 1 ? cores[0].nome : undefined);
    addToCart({
      productId: product.id,
      slug: product.slug,
      /**
       * ⚠️ O NOME NÃO LEVA A COR (corrigido 06/08). Antes era
       * `${product.name} · ${cor}`, e a cor viajava SÓ ali. Agora que ela tem
       * campo próprio, repetir no nome dá "Vestido · VINHO · VINHO · 48" na
       * linha do pedido — o backend compõe `nome · cor · tamanho`. A sacola e
       * o resumo já mostram a cor em campo separado.
       */
      name: product.name,
      image: product.images[0] ?? { src: '', alt: product.name },
      size,
      color: cor,
      quantity: 1,
      unitPrice: product.price,
    });
    // add_to_cart SÓ depois da peça entrar de fato no carrinho (contrato do
    // tracking).
    trackAddToCart(product, { tamanho: size, cor });
    toast({
      message: 'Adicionado à sacola',
      description: `${product.name} · ${cor ? `${cor} · ` : ''}tamanho ${size}`,
    });
    // Abre o mini-cart: a cliente VÊ a peça entrar na sacola sem sair da
    // página — e o próximo passo (finalizar) já está na mão dela.
    openOverlay('cart');
  }

  /**
   * "Ver peças parecidas" — joga na busca as primeiras palavras do nome, que
   * é onde mora o CORTE da peça ("Blusa Feminina Manga Curta"). Cor e REF
   * ficam de fora de propósito: quem clica aqui é justamente quem NÃO quis
   * aquela cor ou não achou o tamanho.
   */
  const buscaSemelhantes = `/busca?q=${encodeURIComponent(
    product.name.split(/s+/).slice(0, 4).join(' '),
  )}`;

  /**
   * TIRAR DÚVIDA leva REF, cor e o LINK da peça (pedido do dono, 13/08).
   *
   * A mensagem chegava só com o nome — "Tenho interesse na peça Blusa Manga
   * Curta" — e a consultora respondia perguntando "qual delas?": nome limpo
   * não identifica peça nenhuma entre 14 lojas. A REF é o código que o PDV
   * busca, e o link faz o WhatsApp montar a prévia com a FOTO — a atendente
   * vê a peça antes de abrir conversa. Sem emoji (ver `data/contato.ts`).
   */
  const refPeca = product.sku ?? product.id;
  const corDaDuvida = corSelecionada ?? (cores?.length === 1 ? cores[0].nome : null);
  const whatsapp = linkWhatsapp(
    [
      `Olá! Tenho interesse na peça "${product.name}" (Ref ${refPeca}${corDaDuvida ? `, cor ${corDaDuvida}` : ''}).`,
      `Vocês têm no tamanho ${size ?? '__'}?`,
      `${SITE.url}/produto/${product.slug}`,
    ].join('\n'),
  );

  return (
    <div className="flex flex-col">
      {/* AS ETIQUETAS SAÍRAM DAQUI (dono, 15/08). "Novo" abria a coluna de
          compra e custava 43px de rolagem — a pílula mais o respiro — pra
          dizer uma palavra. Agora elas vivem SOBRE a foto, no canto superior
          direito (ver `badges` do ProductGallery), que é onde a cliente já
          está olhando e onde não empurram nada pra baixo. */}
      {product.fabric && <p className="eyebrow text-primary-strong">{product.fabric}</p>}

      {/* TÍTULO MENOR NO CELULAR (dono, 15/08: "reduza esta quebra").
          `text-h2` dá 28px no mobile e nessa largura (327px) quase nenhum
          nome de peça cabe em uma linha — a mediana do catálogo é 39
          caracteres. Medido: a 28px só 4% dos nomes cabem; a 22px o nome
          típico de blusa ("Blusa Manga Curta — BMM-100", 314px) entra
          inteiro, e o nome longo de vestido, que não caberia nem a 16px,
          quebra em duas linhas de 50px em vez de 65px.

          22px é o piso: abaixo disso o título fica menor que o preço e a
          peça perde o nome como manchete. Quem quiser mais nomes em uma
          linha só tem um caminho, e ele é de CONTEÚDO — tirar o código da
          REF do fim do nome. */}
      <h1 className="mt-3 font-display text-[1.375rem] leading-[1.2] text-ink sm:text-h2 sm:leading-[1.16]">
        {product.name}
      </h1>

      {product.rating && (
        <div className="mt-4 flex items-center gap-2">
          <span className="flex items-center gap-0.5" role="img" aria-label={`${product.rating.average} de 5`}>
            {Array.from({ length: 5 }, (_, i) => (
              <Star
                key={i}
                className={cn(
                  'size-3.5',
                  i < Math.round(product.rating!.average)
                    ? 'fill-primary text-primary'
                    : 'text-border-strong',
                )}
                strokeWidth={1.5}
              />
            ))}
          </span>
          <span className="text-small text-ink-soft">
            {product.rating.average.toFixed(1)} · {product.rating.count} avaliações
          </span>
        </div>
      )}

      {/* Preço */}
      <div className="mt-7">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {product.compareAtPrice && (
            <span className="tabular text-body text-ink-muted line-through">
              {formatPrice(product.compareAtPrice)}
            </span>
          )}
          <span className="tabular font-display text-[2rem] leading-none font-medium text-ink">
            {formatPrice(product.price)}
          </span>
          {discount > 0 && (
            <span className="tabular rounded-pill bg-secondary-wash px-2.5 py-1 text-small font-medium text-secondary">
              -{discount}%
            </span>
          )}
        </div>

        {/* PIX + PARCELA EM UMA LINHA SÓ NO CELULAR (dono, 15/08).
            A 15px a frase inteira mede 355px numa coluna de 327 e quebrava
            "sem juros" sozinho na linha de baixo — o argumento mais forte do
            preço saía órfão. A 13px ela mede 308px e cabe, com folga até em
            peça de R$ 379 (318px). Encurtar o texto seria o outro caminho,
            mas custaria "5% off" ou "sem juros", que é o que faz ela decidir.
            Desktop segue nos 15px de sempre. */}
        <p className="mt-3 text-small font-light text-ink-soft sm:text-body">
          {product.pixPrice && (
            <>
              <span className="tabular font-medium text-success">
                {formatPrice(product.pixPrice)}
              </span>{' '}
              no Pix (5% off) ·{' '}
            </>
          )}
          {product.installments && (
            <span className="tabular">
              {product.installments.times}x de {formatPrice(product.installments.value)} sem juros
            </span>
          )}
        </p>

        {/* QUEBRA DE PREÇO POR TAMANHO (dono 07/08). Peça que custa um valor
            do 44 ao 54 e outro do 56 ao 60 mostra OS DOIS aqui. Escondendo a
            faixa maior, a cliente de 58 só descobre no carrinho — e é ali que
            ela desiste. */}
        {product.priceRanges && product.priceRanges.length > 1 && (
          <div className="mt-4 rounded-md border border-border bg-surface-alt/60 px-4 py-3">
            <p className="eyebrow text-ink-soft">Preço por tamanho</p>
            <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
              {product.priceRanges.map((f) => (
                <li key={`${f.from}-${f.to}`} className="text-small text-ink">
                  <span className="tabular font-medium">
                    {f.from === f.to ? f.from : `${f.from} ao ${f.to}`}
                  </span>
                  {' · '}
                  <span className="tabular">{formatPrice(f.price)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* COR — vem ANTES do tamanho: a cliente escolhe a cor e só então vê a
          grade daquela cor (cada cor tem estoque próprio). Escolher o 48 e
          depois descobrir que ele só existe no preto é o pior caminho.

          DIDÁTICO POR DECISÃO DO DONO (14/08): "minha cliente é lenta com
          tecnologia". A bolinha sozinha não ensina nada — ela não se anuncia
          como clicável e ninguém distingue vinho de marrom num círculo de
          43px. Agora cada cor tem NOME ESCRITO embaixo, o passo é numerado
          ("1 Escolha a cor") e a escolhida ganha um ✓. O nome já existia, mas
          só no `title`/`aria-label`: invisível no celular, que é onde a
          cliente compra. Contexto: 443 pessoas abriram uma peça no dia e 28
          puseram na sacola. */}
      {cores && cores.length > 1 && (
        <div className="mt-9">
          <PassoLabel numero={1} titulo="Escolha a cor" escolhido={corSelecionada ?? null} />
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-5">
            {cores.map((c) => {
              const escolhida = corSelecionada === c.nome;
              const esgotada = c.estoque <= 0;
              // MESMO FALLBACK DA VITRINE (bug real, 07/08): sem bolinha pintada
              // na retaguarda, o card da listagem já ADIVINHA a cor pelo nome
              // (hexDaCor) — a PDP caía num cinza genérico #D9D4CC porque usava
              // o hex cru da API sem esse plano B. Cliente via bolinha colorida
              // no card e cinza ao abrir a peça, como se tivesse quebrado.
              const estilo: React.CSSProperties =
                c.swatch.tipo === 'foto' && c.swatch.imagem
                  ? {
                      backgroundImage: `url(${c.swatch.imagem})`,
                      backgroundSize: '400%',
                      backgroundPosition: `${(c.swatch.focoX ?? 0.5) * 100}% ${(c.swatch.focoY ?? 0.5) * 100}%`,
                    }
                  : { backgroundColor: c.swatch.hex || hexDaCor(c.nome) };

              return (
                <button
                  key={c.nome}
                  type="button"
                  onClick={() => {
                    onSelecionarCor?.(c.nome);
                    trackColorSwitch(product, c.nome);
                  }}
                  aria-pressed={escolhida}
                  aria-label={`Cor ${c.nome}${esgotada ? ' (esgotada)' : ''}`}
                  // w-16 + quebra de linha: o nome inteiro aparece ("AZUL
                  // MARINHO" em duas linhas) sem esticar o viewport no celular
                  // — o flex-wrap acomoda, e nada de truncar justo o texto que
                  // a gente acabou de mostrar pra ensinar.
                  className="group flex w-16 flex-col items-center gap-2"
                >
                  <span
                    className={cn(
                      // 2,7rem = 43px: a bolinha 20% maior que os 36px originais
                      // (dono 07/08). É o controle que decide a compra — merece
                      // o alvo de toque maior no celular.
                      'relative flex size-[2.7rem] items-center justify-center rounded-full border transition-all duration-[320ms]',
                      escolhida
                        ? 'border-ink ring-2 ring-ink ring-offset-2 ring-offset-background'
                        : 'border-border group-hover:border-ink-soft',
                      esgotada && 'opacity-40',
                    )}
                  >
                    <span style={estilo} className="absolute inset-[3px] rounded-full" />
                    {/* ✓ por cima da bolinha: a borda escura sozinha some numa
                        peça de cor escura — o check nunca some. */}
                    {escolhida && (
                      <Check
                        className="relative size-4 text-light drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
                        strokeWidth={3}
                      />
                    )}
                  </span>
                  <span
                    className={cn(
                      'text-center text-xs leading-tight break-words',
                      escolhida ? 'font-medium text-ink' : 'text-ink-soft',
                    )}
                  >
                    {c.nome}
                    {esgotada && <span className="block text-ink-muted">esgotada</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* SAI NA MESMA FOTO — a irmã do look colada na decisão (dono, 13/08:
          "era bom aparecer aqui a indicação da peça irmã"). A cliente está
          literalmente vendo a outra peça na foto ao lado; o bloco grande
          "Complete o look" continua no fim da página pra quem rolou. */}
      {irmasDoLook.length > 0 && (
        <div className="mt-9">
          <p className="eyebrow text-ink">Sai na mesma foto</p>
          <div className="mt-3 flex flex-col gap-2">
            {irmasDoLook.map((p) => (
              <Link
                key={p.ref}
                href={`/produto/${p.slug}`}
                className="group flex items-center gap-3 rounded-sm border border-border bg-surface-alt/60 px-3 py-2.5 transition-colors duration-[320ms] hover:border-ink-soft"
              >
                {p.imagem && (
                  <Image
                    src={p.imagem}
                    alt={p.nome}
                    width={40}
                    height={53}
                    className="h-[53px] w-10 shrink-0 rounded-sm object-cover"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-ink">{p.nome}</span>
                  <span className="block text-small font-light text-ink-soft">
                    {formatPrice(p.preco)}
                    {!p.disponivel && ' · esgotada'}
                  </span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-ink-muted transition-transform duration-[320ms] group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Tamanho */}
      {/* IMPOSSÍVEL DE IGNORAR (dono, 15/08): "minha cliente é lenta com
          tecnologia". Quem clicava em "Adicionar" sem escolher o número via só
          uma linha vermelha discreta e não entendia — 20 pessoas/dia batiam
          nessa trava (evento add_to_cart_blocked/size_missing, várias no VLM-222
          e no bmm-100) e parte ia embora. Quando falta o tamanho, o passo
          INTEIRO acende: moldura vermelha + fundo + a instrução em caixa
          dizendo pra tocar num número acima. */}
      <div
        id="seletor-tamanho"
        className={cn(
          'mt-9 scroll-mt-28 rounded-lg transition-all duration-300',
          sizeError &&
            'bg-danger/5 p-4 ring-2 ring-danger ring-offset-2 ring-offset-background',
        )}
      >
        <div className="flex items-end justify-between gap-4">
          <PassoLabel
            numero={temCor ? 2 : 1}
            titulo="Escolha o tamanho"
            escolhido={size}
            sufixoEscolhido="tamanho"
          />
          <button
            type="button"
            onClick={() => setSizeChartOpen(true)}
            className="inline-flex items-center gap-1.5 text-small text-ink-soft underline decoration-border underline-offset-4 transition-colors hover:text-ink"
          >
            <Ruler className="size-3.5" strokeWidth={1.75} />
            Tabela de medidas
          </button>
        </div>

        {/* As opções ficam coladas ao rótulo do passo para a instrução e a
            escolha formarem um único bloco visual. */}
        <div className="mt-4 flex flex-wrap gap-2">
          {product.sizes.map((option) => (
            <SizePill
              key={option.label}
              size="lg"
              label={option.label}
              selected={size === option.label}
              disabled={!option.available}
              onSelect={() => {
                setSize(option.label);
                trackSizeSwitch(product, option.label);
                setSizeError(false);
              }}
            />
          ))}
        </div>

        {/* Legenda do risco — a pílula riscada é convenção de quem compra
            online há anos, não de quem está comprando pela primeira vez. */}
        {!soldOut && product.sizes.some((s) => !s.available) && (
          <p className="mt-3 text-small text-ink-muted">
            Os números riscados estão esgotados{temCor ? ' nesta cor' : ''}.
          </p>
        )}

        {sizeError && (
          <p
            role="alert"
            className="mt-4 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2.5 text-small font-semibold text-danger"
          >
            <AlertCircle className="size-4 shrink-0" strokeWidth={2} />
            Toque no seu número acima 👆 pra colocar na sacola.
          </p>
        )}

        {/* ESCASSEZ HONESTA — o número vem do estoque de verdade daquela cor.
            Nada de "100 pessoas viram hoje": a Shein sustenta isso com volume,
            pra nós seria mentira que a cliente detecta em duas visitas. */}
        {alertaEstoque && !soldOut && (
          <p className="mt-3 text-small font-medium text-secondary">{alertaEstoque}</p>
        )}

        {soldOut && (
          <p className="mt-3 text-small text-ink-soft">
            Esgotado no site — mas pode ter na loja. Chame uma consultora que a gente procura nas
            14 unidades.
          </p>
        )}
      </div>

      {/* PROVA SOCIAL COLADA NO BOTÃO (dono, 13/08; virou linha em 14/08): é
          o último argumento antes do clique e o único da página que vem de
          venda de verdade — mas em caixa ela empurrava o botão pra longe do
          seletor. Uma linha argumenta igual sem afastar o clique. */}
      <SeloVendas vendas={product.sold} variant="linha" className="mt-7" />

      {/* Ações — UM botão grande (dono, 14/08): "Adicionar à sacola" tinha o
          mesmo peso visual de Favoritar e do WhatsApp, e o VERDE do WhatsApp
          era a cor mais quente da coluna — o olho ia pro botão errado. Agora
          a ação de compra é o único botão; as outras duas viram links
          discretos logo abaixo. */}
      <div className="mt-3 flex flex-col gap-4">
        {/* Esgotou: em vez de deixar a cliente sair, oferece o mesmo corte em
            outras peças — é o vendedor de loja física dizendo "se gostou
            desse modelo, olha esses aqui". */}
        {soldOut && (
          <Button href={buscaSemelhantes} variant="secondary" size="lg" block>
            Ver peças parecidas
          </Button>
        )}
        {!soldOut && (
          <Button size="lg" block onClick={handleAdd} className="h-14 text-[1.05rem]">
            <ShoppingBag /> Adicionar à sacola
          </Button>
        )}

        <div className="flex items-center justify-center gap-8">
          <button
            type="button"
            onClick={() => {
              toggleWishlist(product.id);
              toast({
                message:
                  mounted && isFavorite ? 'Removido dos favoritos' : 'Salvo nos favoritos',
              });
            }}
            className="inline-flex items-center gap-1.5 text-small text-ink-soft transition-colors hover:text-ink"
          >
            <Heart
              className={cn('size-4', mounted && isFavorite && 'fill-secondary text-secondary')}
              strokeWidth={1.75}
            />
            {mounted && isFavorite ? 'Salvo' : 'Favoritar'}
          </button>
          <a
            href={whatsapp}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-small text-ink-soft transition-colors hover:text-ink"
          >
            <MessageCircle className="size-4" strokeWidth={1.75} />
            Tirar dúvida no WhatsApp
          </a>
        </div>
      </div>

      {/* Frete de verdade, pro CEP dela (item 28). Substituiu o texto fixo
          "frete grátis acima de R$ 399", que envelheceu junto com a régua — o
          valor agora é config e muda sem deploy. */}
      <SimuladorFrete preco={product.price} />


      {/* Garantias — o que tira o medo de comprar online */}
      <ul className="mt-7 flex flex-col gap-3 border-t border-border pt-7 text-small text-ink-soft">
        {/* O cadeado na PEÇA (dono, 12/08): a cliente que chega pelo Instagram
            decide aqui se a loja é confiável, muito antes do checkout. */}
        <li className="flex items-center gap-3">
          <Lock className="size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
          Pagamento criptografado — PagBank e Pagar.me
        </li>
        <li className="flex items-center gap-3">
          <MapPin className="size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
          Retire e prove em uma das 14 lojas antes de levar
        </li>
        <li className="flex items-center gap-3">
          <Ruler className="size-4 shrink-0 text-primary-strong" strokeWidth={1.75} />
          Troca fácil em até {STORE_POLICIES.exchangeWindowDays} dias, sem burocracia
        </li>
      </ul>

      <Modal
        open={sizeChartOpen}
        onClose={() => setSizeChartOpen(false)}
        label="Tabela de medidas"
        title="Tabela de medidas"
        size="lg"
        className="max-h-[94vh]"
      >
        <Image
          src="/images/guia-tamanhos/tabela-medidas-lurds.png"
          alt="Tabela de medidas Lurd's para os tamanhos 46 a 60"
          width={750}
          height={1075}
          sizes="(max-width: 640px) 88vw, 750px"
          className="mx-auto h-auto w-full max-w-[750px]"
        />
      </Modal>

      {!soldOut && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/96 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(0,0,0,0.12)] backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-lg items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-small font-medium text-ink">{product.name}</p>
              <p className="tabular text-xs text-ink-soft">
                {size ? `Tamanho ${size}` : 'Escolha o tamanho'} · {formatPrice(product.price)}
              </p>
            </div>
            <Button onClick={handleAdd} className="shrink-0">
              <ShoppingBag /> {size ? 'Adicionar' : 'Escolher tamanho'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Rótulo de passo da compra — "1 Escolha a cor", "2 Escolha o tamanho".
 *
 * Existe por um motivo só (dono, 14/08): "minha cliente é lenta com
 * tecnologia". "Cor" e "Tamanho" são TÍTULOS — descrevem o bloco e não pedem
 * nada. Quem não tem intimidade com loja online lê um título, não entende que
 * tem que agir, e desce direto pro botão. O verbo no imperativo é a instrução
 * que faltava; o número diz quantas decisões faltam.
 *
 * Quando já escolheu, o rótulo confirma em voz alta o que ela escolheu — a
 * mesma confirmação que a vendedora dá na loja ("o vinho, 48, isso?").
 */
function PassoLabel({
  numero,
  titulo,
  escolhido,
  sufixoEscolhido,
}: {
  numero: number;
  titulo: string;
  /** O que já foi escolhido (cor ou tamanho). Nulo = ainda falta escolher. */
  escolhido: string | null;
  /** Palavra antes do valor na confirmação ("tamanho 48"). */
  sufixoEscolhido?: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className={cn(
          'tabular flex size-6 shrink-0 items-center justify-center rounded-pill border text-xs font-medium transition-colors duration-[320ms]',
          escolhido ? 'border-primary bg-primary text-light' : 'border-ink-soft text-ink',
        )}
      >
        {escolhido ? <Check className="size-3.5" strokeWidth={3} /> : numero}
      </span>
      <p className="text-small font-medium text-ink">
        {titulo}
        {escolhido && (
          <span className="font-normal text-ink-soft">
            {' · '}
            {sufixoEscolhido ? `${sufixoEscolhido} ` : ''}
            <span className="font-medium text-ink">{escolhido}</span>
          </span>
        )}
      </p>
    </div>
  );
}
