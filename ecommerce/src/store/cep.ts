import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * O CEP DA CLIENTE — digitado UMA vez, lembrado no site inteiro.
 *
 * Até 22/08/2026 a caixa de frete abria vazia em toda peça, em toda visita, e
 * de novo na sacola, e de novo no checkout. A cliente respondia quatro vezes a
 * mesma pergunta — e "quanto custa e quando chega?" é a dúvida que mais adia a
 * compra de roupa. Com o CEP guardado, a peça abre já dizendo o prazo em vez
 * de pedir uma tarefa.
 *
 * Guardado no navegador, não na conta: quem compra sem login (a maioria, o
 * checkout é sem cadastro) tem o mesmo benefício. Só os 8 dígitos — nem rua,
 * nem número, nem nome. Endereço completo é dado pessoal e mora no cadastro,
 * atrás de login.
 *
 * O `atualizadoEm` existe pra poder envelhecer: CEP de seis meses atrás pode
 * ser de outro endereço, e um prazo confiante pro lugar errado é pior que
 * pergunta nenhuma. Ver `cepAindaVale`.
 */

interface CepState {
  /** Só dígitos. Vazio = nunca informou. */
  cep: string;
  /** ISO do momento em que ela digitou. */
  atualizadoEm: string | null;
  guardar: (cep: string) => void;
  esquecer: () => void;
}

/** 90 dias. Depois disso a caixa volta a perguntar em vez de assumir. */
const VALIDADE_DIAS = 90;

export const useCepStore = create<CepState>()(
  persist(
    (set) => ({
      cep: '',
      atualizadoEm: null,
      guardar: (cep) => {
        const digitos = String(cep || '').replace(/\D/g, '').slice(0, 8);
        if (digitos.length !== 8) return;
        set({ cep: digitos, atualizadoEm: new Date().toISOString() });
      },
      esquecer: () => set({ cep: '', atualizadoEm: null }),
    }),
    { name: 'lurds-cep' },
  ),
);

/** `true` quando o CEP guardado ainda pode ser usado sem perguntar de novo. */
export function cepAindaVale(cep: string, atualizadoEm: string | null): boolean {
  if (cep.length !== 8 || !atualizadoEm) return false;
  const quando = new Date(atualizadoEm).getTime();
  if (!Number.isFinite(quando)) return false;
  return Date.now() - quando < VALIDADE_DIAS * 24 * 60 * 60 * 1000;
}

/**
 * O CEP utilizável, ou string vazia. Hook próprio porque os três chamadores
 * (peça, sacola, checkout) fazem a mesma pergunta e a regra de validade tem
 * que ser a mesma nos três.
 */
export function useCepGuardado(): string {
  return useCepStore((s) => (cepAindaVale(s.cep, s.atualizadoEm) ? s.cep : ''));
}
