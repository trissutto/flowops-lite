import { create } from 'zustand';

/**
 * ASSISTENTE — estado da conversa.
 *
 * Mora num store porque o chat é aberto de vários lugares: a bolha fixa, o
 * seletor de tamanho ("não sei meu número"), o frete e o carrinho. Cada um
 * abre já com a pergunta pronta e o contexto da página — a cliente não deveria
 * ter que explicar de novo o que está olhando.
 *
 * O histórico não é persistido de propósito: quem guarda a conversa é o
 * servidor (`chatId`), que é de onde a consultora vai lê-la se a cliente pedir
 * atendimento humano.
 */

export interface FalaChat {
  papel: 'cliente' | 'assistente';
  texto: string;
}

interface ChatState {
  aberto: boolean;
  chatId: string | null;
  sessaoId: string;
  falas: FalaChat[];
  pensando: boolean;
  /** Sugestão que a página injeta ao abrir (ex.: "Me ajuda com o tamanho?"). */
  rascunho: string;
  /** Onde a cliente está — vai junto pro backend e pra fila da consultora. */
  contexto: string | null;

  abrir: (opts?: { rascunho?: string; contexto?: string | null }) => void;
  fechar: () => void;
  setRascunho: (v: string) => void;
  registrar: (fala: FalaChat) => void;
  setPensando: (v: boolean) => void;
  setChatId: (id: string) => void;
}

/** Id de sessão do navegador — some ao fechar a aba, e tudo bem. */
function novaSessao(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `s-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export const useChatStore = create<ChatState>((set) => ({
  aberto: false,
  chatId: null,
  sessaoId: novaSessao(),
  falas: [],
  pensando: false,
  rascunho: '',
  contexto: null,

  abrir: (opts) =>
    set((s) => ({
      aberto: true,
      rascunho: opts?.rascunho ?? s.rascunho,
      contexto: opts?.contexto ?? s.contexto,
    })),
  fechar: () => set({ aberto: false }),
  setRascunho: (rascunho) => set({ rascunho }),
  registrar: (fala) => set((s) => ({ falas: [...s.falas, fala] })),
  setPensando: (pensando) => set({ pensando }),
  setChatId: (chatId) => set({ chatId }),
}));
