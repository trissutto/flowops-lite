import { create } from 'zustand';
import type { Product } from '@/types';

/**
 * QUICK ADD — a peça que está sendo adicionada pela janelinha flutuante.
 *
 * Mora num store (e não em prop) porque o botão nasce dentro do ProductCard,
 * que aparece em carrossel, grade, busca e vitrine. Passar callback por todos
 * esses níveis obrigaria cada tela a montar o próprio modal — e o dia em que
 * uma esquecesse, o botão viraria um clique morto.
 *
 * A folha em si é montada UMA vez no layout público.
 */
interface QuickAddState {
  produto: Product | null;
  abrir: (produto: Product) => void;
  fechar: () => void;
}

export const useQuickAddStore = create<QuickAddState>((set) => ({
  produto: null,
  abrir: (produto) => set({ produto }),
  fechar: () => set({ produto: null }),
}));
