'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { AlertCircle, ArrowRight, Check, Heart, Lock, MapPin, MessageCircle, Ruler, ShoppingBag, Star } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Overlay } from '@/components/ui/Overlay';
import { SimuladorFrete } from '@/components/commerce/SimuladorFrete';
import { SizePill } from '@/components/ui/Choice';
import { useToast } from '@/components/feedback/ToastProvider';
import { useCartStore } from '@/store/cart';
import { useLookOfferStore } from '@/store/look-offer';
import { useUiStore } from '@/store/ui';
import { useWishlistStore } from '@/store/wishlist';
import { trackAddToCart, trackAddToCartBlocked, trackSizeSwitch, trackViewItem } from '@/lib/tracking';
import { useMounted } from '@/hooks';
import { cn, discountPercent, formatPrice } from '@/lib/utils';
import { rotuloDaCor, type PecaApi } from '@/services/products';
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
  /**
   * A grade DESTA cor. Com o tamanho vindo primeiro (17/08), é ela que decide
   * qual bolinha aparece riscada: escolhido o 48, a cor que não tem 48 se
   * anuncia antes do clique em vez de dar a notícia ruim depois.
   *
   * Opcional porque nem todo chamador tem a grade por cor — sem ela, nenhuma
   * bolinha é riscada, que é o comportamento de antes.
   */
  tamanhos?: Array<{ label: string; disponivel: boolean }>;
  /**
   * A FOTO da cor — a mesma capa que a fita de miniaturas usa.
   *
   * Existe pra folha de cores (19/08): bolinha de 24px não mostra estampa, e
   * a peça plus size vende pelo caimento. Sem capa, cai no swatch de cor
   * chapada, que é o comportamento de quem ainda não tem foto.
   */
  capa?: string | null;
  /** O que a cliente lê. O ERP guarda "VD MUSGO ESC"; o backend traduz. */
  nomeAmigavel?: string | null;
}

export function BuyBox({
  product, cores, corSelecionada, alertaEstoque, look, tamanho, onTamanho, corPendente, onPedirCor, seletorCores,
}: {
  product: Product;
  /** Cores da peça. Vazio = peça de cor única (ou catálogo sem ficha ainda). */
  cores?: CorEscolhivel[];
  corSelecionada?: string | null;
  /**
   * A COR VOLTOU A SER O PASSO 1 — e AGORA É PEDIDA, NÃO ESCOLHIDA POR NÓS
   * (dono, 20/08 à noite: "a pessoa escolhe a cor, depois o tamanho").
   *
   * `corPendente` = peça multicor SEM cor escolhida ainda. Nesse estado o
   * tamanho não aceita toque e o botão pede a cor: qualquer tentativa cai no
   * `onPedirCor`, que rola até a GRADE DE CORES (embaixo da foto, na outra
   * coluna) e acende o passo. O seletor de cor em si mora lá — aqui só a
   * trava e a confirmação.
   */
  corPendente?: boolean;
  onPedirCor?: () => void;
  /**
   * A GRADE DE CORES DO DESKTOP (dono, 20/08: "no PC colocar as fotos das
   * cores na lateral direita, pois elas estão descendo"). No celular a grade
   * mora embaixo da foto; no PC ela entra AQUI, entre o preço e o tamanho —
   * cor é o passo 1, tamanho o 2. O nó vem montado do pai, que é quem tem o
   * estado da cor.
   */
  seletorCores?: React.ReactNode;
  /** "Restam 2 nesta cor" — só com número REAL do estoque, nunca inventado. */
  alertaEstoque?: string | null;
  /**
   * O TAMANHO ESCOLHIDO, ERGUIDO PRA FORA (17/08).
   *
   * Quem precisa saber o número escolhido não e so este componente: a FITA
   * de miniaturas, que fica na outra coluna, risca a cor que nao tem aquele
   * tamanho. Como ela e irma e nao filha, o estado sobe pro pai.
   *
   * Continua funcionando sem os props (fica com o estado interno) — assim
   * nenhum outro chamador do BuyBox precisa mudar.
   */
  tamanho?: string | null;
  onTamanho?: (t: string | null) => void;
  /** As peças que saem na MESMA foto (curadoria de /retaguarda/looks). */
  look?: PecaApi['look'];
}) {
  const irmasDoLook = (look?.pecas ?? []).filter((p) => !p.atual);
  const [sizeLocal, setSizeLocal] = useState<string | null>(null);
  // Controlado quando o pai manda o prop; senão, estado próprio.
  const size = tamanho !== undefined ? tamanho : sizeLocal;
  const setSize = (v: string | null) => { setSizeLocal(v); onTamanho?.(v); };
  const [sizeError, setSizeError] = useState(false);
  // A tabela abre sobre a PDP para a cliente não perder a seleção da peça.
  const [sizeChartOpen, setSizeChartOpen] = useState(false);
  /** Folha de tamanhos — sobe quando ela tenta comprar sem ter escolhido. */
  const [folhaTamanho, setFolhaTamanho] = useState(false);
  const { toast } = useToast();
  const mounted = useMounted();
  const addToCart = useCartStore((s) => s.add);
  const oferecerLook = useLookOfferStore((s) => s.oferecer);
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
  const corAtual = cores?.find((c) => c.nome === corSelecionada) ?? null;
  /**
   * O nome que a CLIENTE lê. O cru do ERP ("VD MUSGO ESC") continua sendo a
   * chave que vai pro carrinho e pra URL (`?cor=`) — trocar os dois de lugar
   * quebraria a seleção; aqui é só rótulo.
   */
  // `rotuloDaCor` (services/products) tem a guarda contra cadastro poluído:
  // nomeAmigavel com o nome da PEÇA colado estourava o botão e a barra fixa.
  const corLabel = corAtual ? rotuloDaCor(corAtual) : (corSelecionada ?? null);

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
  /**
   * O CLIQUE SEM TAMANHO PRECISA VIRAR ESCOLHA, NÃO ERRO (16/08).
   *
   * Medição de 5 dias: 41 pessoas bateram nesta trava e **36 delas nunca
   * tinham tocado no seletor** — não é que perderam a escolha, é que ela nunca
   * passou pela cabeça delas. Em peça multicor a falha é 16% de quem tenta
   * comprar, contra 5% na peça de cor única: o passo da cor consome a decisão
   * e as pílulas viram enfeite.
   *
   * A tentativa de 15/08 foi gritar mais alto DEPOIS do clique (acender o
   * passo em vermelho + rolar até ele). Medido: taxa igual, 1,7% antes e 1,7%
   * depois — e só 1 pessoa em 41 clicou travado duas vezes. Elas entendem o
   * aviso e vão embora mesmo assim, porque o clique já foi gasto.
   *
   * Agora a escolha vai ATÉ o dedo dela: a folha sobe com os números, um toque
   * escolhe e já põe na sacola. O destaque vermelho continua atrás, pra quem
   * fecha a folha e volta pra página.
   */
  function handleAdd() {
    // A COR VEM ANTES (dono, 20/08): sem ela nem a folha de tamanhos abre —
    // escolher número de uma cor que não existe é comprar no escuro.
    if (corPendente) {
      trackAddToCartBlocked(product, 'color_missing');
      onPedirCor?.();
      return;
    }
    if (!size) {
      trackAddToCartBlocked(product, soldOut ? 'sold_out' : 'size_missing');
      setSizeError(true);
      // Sem tamanho ESGOTADO não há o que escolher — a folha vazia seria uma
      // porta pra parede. Aí vale o caminho antigo: acende o passo e mostra a
      // legenda de esgotado.
      if (product.sizes.some((s) => s.available)) {
        setFolhaTamanho(true);
      } else {
        document.getElementById('seletor-tamanho')?.scrollIntoView({ block: 'center' });
      }
      return;
    }
    adicionar(size);
  }

  /** O caminho único de entrada na sacola — página e folha passam por aqui. */
  function adicionar(tamanho: string) {
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
      size: tamanho,
      color: cor,
      quantity: 1,
      unitPrice: product.price,
    });
    // add_to_cart SÓ depois da peça entrar de fato no carrinho (contrato do
    // tracking).
    trackAddToCart(product, { tamanho, cor });
    toast({
      message: 'Adicionado à sacola',
      description: `${product.name} · ${cor ? `${cor} · ` : ''}tamanho ${tamanho}`,
    });
    // A irmã do look vai junto pro mini-cart (dono, 20/08): a faixa "Sai na
    // mesma foto" só leva pra outra página, e quem adiciona e vai embora não
    // volta. Peça sem look limpa a oferta — nada de irmã de outra família.
    oferecerLook(look);
    // Abre o mini-cart: a cliente VÊ a peça entrar na sacola sem sair da
    // página — e o próximo passo (finalizar) já está na mão dela.
    openOverlay('cart');
  }

  /**
   * Um toque na folha faz as três coisas: escolhe, registra a escolha no funil
   * (é o `size_switch` que prova que a folha resolveu) e põe na sacola. Pedir
   * um segundo toque em "Adicionar" recriaria o passo que a folha veio matar.
   */
  function escolherNaFolha(tamanho: string) {
    setSize(tamanho);
    setSizeError(false);
    setFolhaTamanho(false);
    trackSizeSwitch(product, tamanho);
    adicionar(tamanho);
  }

  /**
   * "Ver peças parecidas" — joga na busca as primeiras palavras do nome, que
   * é onde mora o CORTE da peça ("Blusa Feminina Manga Curta"). Cor e REF
   * ficam de fora de propósito: quem clica aqui é justamente quem NÃO quis
   * aquela cor ou não achou o tamanho.
   */
  const buscaSemelhantes = `/busca?q=${encodeURIComponent(
    product.name.split(/\s+/).slice(0, 4).join(' '),
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
      // O link leva a COR (20/08): a atendente abre a página já na variação
      // da dúvida, e a prévia do WhatsApp monta com a foto certa.
      `${SITE.url}/produto/${product.slug}${corDaDuvida ? `?cor=${encodeURIComponent(corDaDuvida)}` : ''}`,
    ].join('\n'),
  );

  return (
    <div className="flex flex-col">
      {/* NOME e PREÇO só no DESKTOP (dono, 20/08, preview aprovado): no
          celular eles moram na coluna da galeria — nome ACIMA da foto, preço
          logo abaixo dela — renderizados pelo EscolhaDaPeca com estes mesmos
          componentes. Duplicar markup foi descartado de propósito: preço tem
          Pix, parcela e faixa por tamanho, e divergir isso entre telas é bug
          na certa. */}
      <div className="hidden lg:block">
        <TituloDaPeca product={product} />
        <PrecoDaPeca product={product} className="mt-7" />
      </div>

      {/* A GRADE DE CORES DO DESKTOP — passo 1, antes do tamanho. No celular
          esta instância não existe (a de lá fica embaixo da foto). */}
      {seletorCores && <div className="hidden lg:block">{seletorCores}</div>}

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
          {/* Passo 2 quando a peça tem cores (20/08): a COR é o passo 1, na
              grade embaixo da foto. Peça de cor única segue com o tamanho
              como único passo. */}
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

        {/* TODOS OS NÚMEROS NUMA LINHA SÓ, SEM QUEBRA (dono, 20/08): o 60
            sobrando sozinho na segunda linha parecia de outra grade.
            `grid-flow-col auto-cols-fr` divide a largura por igual entre
            quantos números a peça tiver — as pílulas encolhem (`min-w-0`)
            em vez de quebrar. */}
        <div className="mt-4 grid grid-flow-col auto-cols-fr gap-1.5 sm:gap-2">
          {product.sizes.map((option) => (
            <SizePill
              key={option.label}
              size="lg"
              className="w-full min-w-0 px-0"
              label={option.label}
              selected={size === option.label}
              disabled={!option.available}
              onSelect={() => {
                // TAMANHO SEM COR NÃO EXISTE (dono, 20/08): o toque não é
                // perdido nem vira erro mudo — a página rola até a grade de
                // cores e pede a escolha que falta.
                if (corPendente) {
                  onPedirCor?.();
                  return;
                }
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

      {/* A LINHA "Cor: X · Ver as N cores" SAIU (20/08, terceira era deste
          bloco): com a grade de cores na própria coluna (desktop) e embaixo
          da foto (celular), a linha virava a segunda aparição da mesma
          escolha — e duplicar seletor de cor é o erro que já custou 158px
          uma vez. Quem confirma a cor agora é o cabeçalho da grade e o
          botão, que carimba "Adicionar · MARINHO 48". */}

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
        {/* O RÓTULO CONTA O QUE FALTA. Enquanto não há número escolhido o
            botão não promete "adicionar" pra depois recusar: ele diz o passo
            que vem — e o toque cumpre exatamente o que o rótulo prometeu,
            abrindo a folha de tamanhos. Mesma cor, mesmo tamanho, mesmo lugar:
            continua sendo O botão da página. */}
        {/* O BOTÃO CARIMBA O QUE VAI NA SACOLA (dono, 19/08). Ele dizia só
            "Adicionar à sacola": a COR não aparecia em lugar nenhum do ponto
            de decisão — nem aqui, nem na barra fixa — e a linha da cor fica
            acima, fora do olhar de quem já está com o dedo no botão. É a
            conferência que a vendedora faz no balcão: "o manteiga, 48, isso?" */}
        {!soldOut && (
          <Button size="lg" block onClick={handleAdd} className="h-14 text-[1.05rem]">
            <ShoppingBag />
            <span className="min-w-0 truncate">
              {corPendente
                ? 'Escolha a cor'
                : size
                  ? `Adicionar · ${temCor && corLabel ? `${corLabel} ${size}` : `tamanho ${size}`}`
                  : 'Escolha o tamanho'}
            </span>
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

      {/* FOLHA DE TAMANHOS — a escolha vai até o dedo dela.

          É aqui que a barra fixa do mobile deixa de ser uma armadilha: ela
          está na tela desde o primeiro segundo, então dá pra tentar comprar
          SEM NUNCA ter passado pelo seletor lá em cima — foi o que 36 das 41
          pessoas travadas fizeram. Rolar a página até os números (o que a
          gente fazia) tira o dedo de onde ele está; a folha traz os números
          até ele. Um toque escolhe e já põe na sacola. */}
      <Overlay
        open={folhaTamanho}
        onClose={() => setFolhaTamanho(false)}
        side="bottom"
        label="Escolha o tamanho"
        className="rounded-t-lg pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:mx-auto sm:w-[min(480px,92vw)]"
      >
        <div className="px-6 pt-7">
          <h2 className="font-display text-h4 text-ink">Escolha o tamanho</h2>
          {/* `corLabel`, não o nome cru: a folha dizia "· VD MUSGO ESC" (código
              de etiqueta do ERP) enquanto o resto da página escrevia "Verde
              Musgo Escuro". Duas grafias da mesma cor na mesma compra é a
              cliente perguntando no WhatsApp se são peças diferentes. */}
          <p className="mt-1 text-small text-ink-soft">
            {corLabel ? `${product.name} · ${corLabel}` : product.name}
          </p>
          <p className="mt-4 text-body text-ink">Toque no seu número — a peça já vai pra sacola.</p>

          {/* Mesmo desenho da grade da página (uma linha, sem quebra): as
              duas mostram os mesmos números e divergir confunde. */}
          <div className="mt-4 grid grid-flow-col auto-cols-fr gap-1.5 sm:gap-2">
            {product.sizes.map((option) => (
              <SizePill
                key={option.label}
                size="lg"
                className="w-full min-w-0 px-0"
                label={option.label}
                disabled={!option.available}
                onSelect={() => escolherNaFolha(option.label)}
              />
            ))}
          </div>

          {product.sizes.some((s) => !s.available) && (
            <p className="mt-3 text-small text-ink-muted">
              Os números riscados estão esgotados{temCor ? ' nesta cor' : ''}.
            </p>
          )}

          {/* Não saber o número É um motivo de não escolher — e a saída não
              pode ser fechar a folha e procurar a tabela na página. */}
          <button
            type="button"
            onClick={() => {
              setFolhaTamanho(false);
              setSizeChartOpen(true);
            }}
            className="mt-5 inline-flex items-center gap-1.5 text-small text-ink-soft underline decoration-border underline-offset-4 transition-colors hover:text-ink"
          >
            <Ruler className="size-3.5" strokeWidth={1.75} />
            Não sei meu número — ver tabela de medidas
          </button>
        </div>
      </Overlay>

      {!soldOut && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/96 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(0,0,0,0.12)] backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-lg items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-small font-medium text-ink">{product.name}</p>
              {/* Mesma conferência do botão grande: enquanto falta número a
                  barra PEDE a escolha; completa, ela CONFIRMA cor e tamanho.
                  É a única coisa da PDP que está na tela desde o primeiro
                  segundo — 36 das 41 clientes travadas tentaram comprar por
                  aqui sem nunca ter subido até os seletores. */}
              <p className="tabular truncate text-xs text-ink-soft">
                {corPendente
                  ? 'Escolha a cor'
                  : size
                    ? temCor && corLabel
                      ? `${corLabel} · ${size}`
                      : `Tamanho ${size}`
                    : 'Escolha o tamanho'}{' '}
                · {formatPrice(product.price)}
              </p>
            </div>
            <Button onClick={handleAdd} className="shrink-0">
              <ShoppingBag />{' '}
              {corPendente ? 'Escolher cor' : size ? 'Adicionar' : 'Escolher tamanho'}
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
  className,
}: {
  numero: number;
  titulo: string;
  /** O que já foi escolhido (cor ou tamanho). Nulo = ainda falta escolher. */
  escolhido: string | null;
  /** Palavra antes do valor na confirmação ("tamanho 48"). */
  sufixoEscolhido?: string;
  /** `min-w-0` quando o rótulo divide a linha com uma ação (linha da cor). */
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-center gap-2.5 lg:justify-start', className)}>
      <span
        aria-hidden
        className={cn(
          'tabular flex size-6 shrink-0 items-center justify-center rounded-pill border text-xs font-medium transition-colors duration-[320ms]',
          escolhido ? 'border-primary bg-primary text-light' : 'border-ink-soft text-ink',
        )}
      >
        {escolhido ? <Check className="size-3.5" strokeWidth={3} /> : numero}
      </span>
      {/* Um degrau maior (dono, 17/08): estes dois rótulos são A decisão da
          página, e em `text-small` pesavam menos que a legenda de frete. */}
      <p className="text-body font-medium text-ink">
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

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * NOME DA PEÇA — usado em DOIS lugares desde 20/08 (preview aprovado): no
 * desktop abre a coluna de compra; no celular o EscolhaDaPeca põe ACIMA da
 * foto principal ("coloque a descrição no topo"). Um componente só pros dois
 * porque título tem regra (22px de piso no celular, ver histórico de 15/08) e
 * divergir a regra entre telas é bug.
 */
export function TituloDaPeca({ product, className }: { product: Product; className?: string }) {
  return (
    <div className={className}>
      {product.fabric && <p className="eyebrow text-primary-strong">{product.fabric}</p>}
      {/* 22px é o piso no celular (15/08): abaixo disso o título perde pro
          preço. Centralizado no empilhado, à esquerda na coluna do desktop. */}
      <h1 className="mt-1 text-center font-display text-[1.375rem] leading-[1.2] text-ink sm:text-h2 sm:leading-[1.16] lg:text-left">
        {product.name}
      </h1>
      {product.rating && (
        <div className="mt-2 flex items-center justify-center gap-2 lg:justify-start">
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
    </div>
  );
}

/**
 * PREÇO DA PEÇA — no desktop segue na coluna de compra; no celular vem LOGO
 * ABAIXO da foto principal (dono, 20/08: "o preço logo abaixo da foto").
 * Pix + parcela numa linha de 13px no celular (15/08) e a quebra de preço
 * por tamanho (07/08) vêm juntos — são um bloco só.
 */
export function PrecoDaPeca({ product, className }: { product: Product; className?: string }) {
  const discount = product.compareAtPrice
    ? discountPercent(product.compareAtPrice, product.price)
    : 0;
  return (
    <div className={className}>
      <div className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1 lg:justify-start">
        {product.compareAtPrice && (
          <span className="tabular text-body text-ink-muted line-through">
            {formatPrice(product.compareAtPrice)}
          </span>
        )}
        <span className="tabular font-display text-[1.625rem] leading-none font-medium text-ink">
          {formatPrice(product.price)}
        </span>
        {discount > 0 && (
          <span className="tabular rounded-pill bg-secondary-wash px-2.5 py-1 text-small font-medium text-secondary">
            -{discount}%
          </span>
        )}
      </div>
      <p className="mt-2 text-center text-small font-light text-ink-soft sm:text-body lg:text-left">
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
  );
}
