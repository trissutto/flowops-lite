import { create } from 'zustand';
import type { PecaApi } from '@/services/products';

/**
 * OFERTA DO LOOK NO MINI-CART — a irmã que sai na MESMA foto, oferecida no
 * momento em que a cliente adiciona uma peça à sacola.
 *
 * O problema que isto resolve (dono, 20/08): a faixa "Sai na mesma foto" da
 * BUY BOX só LEVA pra página da irmã — quem adiciona o kimono e vai embora
 * nunca volta pra buscar a calça. O único momento em que as duas peças podem
 * se encontrar sem navegação é o mini-cart, que já abre sozinho ao adicionar.
 *
 * Mora num store porque quem SABE o look é a BuyBox (o dado chega no payload
 * da PDP) e quem MOSTRA a oferta é o MiniCart, montado uma vez no layout —
 * não existe linha de props entre os dois. Memória volátil de propósito: a
 * oferta vale pra sessão de compra em curso; recarregou, acabou o momento.
 */
type IrmaDoLook = NonNullable<PecaApi['look']>['pecas'][number];

interface LookOfferState {
  nomeLook: string | null;
  irmas: IrmaDoLook[];
  /**
   * A COR que a cliente escolheu na peça que ela acabou de adicionar.
   *
   * O look é a MESMA FOTO: quem levou o kimono ESTAMPA AZUL quer a calça
   * ESTAMPA AZUL. Só quem sabe essa cor é a BuyBox (a escolha é do
   * navegador, não do payload), então ela viaja junto da oferta e o
   * mini-cart usa pra abrir o "Levar junto" já na cor certa.
   */
  corEscolhida: string | null;
  /**
   * Registra as irmãs da peça recém-adicionada. Peça sem look LIMPA a oferta:
   * a irmã de um vestido não pode aparecer depois que a cliente adicionou uma
   * blusa de outra família. Esgotada fica de fora — oferecer o que não tem é
   * pior que não oferecer.
   */
  oferecer: (look: PecaApi['look'] | undefined, cor?: string | null) => void;
}

export const useLookOfferStore = create<LookOfferState>((set) => ({
  nomeLook: null,
  irmas: [],
  corEscolhida: null,
  oferecer: (look, cor) =>
    set({
      nomeLook: look?.nome ?? null,
      irmas: (look?.pecas ?? []).filter((p) => !p.atual && p.disponivel),
      corEscolhida: look ? (cor ?? null) : null,
    }),
}));
