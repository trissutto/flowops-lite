/**
 * COMPRA DE VITALÍCIOS — a régua, num lugar só (21/09/2026).
 *
 * Pedido do dono: uma aba em PEDIDOS com as peças que a rede SEMPRE repõe
 * (as VITALÍCIAS, marcadas por REF inteira), comparando o que a rede TEM com
 * o MÍNIMO e o IDEAL digitados por eles (a matriz de 24/08, por cor e
 * tamanho, total da rede), e gerando o pedido de compra por marca ATÉ O IDEAL.
 *
 * Decisões dele (21/09, duas rodadas de perguntas):
 *  - TENHO = estoque da REDE INTEIRA (franquias inclusive) + peças EM
 *    TRÂNSITO entre lojas + o que JÁ FOI PEDIDO à marca e não chegou;
 *  - entra no pedido TODO tamanho abaixo do IDEAL (o mínimo só pinta de
 *    vermelho);
 *  - peça AVULSA: o pedido sai com o número exato, sem arredondar grade.
 *
 * As regras da matriz de 24/08 continuam valendo aqui, e é por isso que a
 * conta mora num arquivo só (a tela e o gerador de pedido perguntam a MESMA
 * coisa):
 *  - NULO ≠ ZERO: sem IDEAL, o COMPRAR fica VAZIO (ninguém configurou) — zero
 *    afirmaria "não precisa comprar" sobre peça que ninguém olhou;
 *  - sobra NÃO vira pedido negativo: peça sobrando é realinhamento;
 *  - IDEAL zero com peça na rede não é "ok": é encalhe.
 */

export type SituacaoCompra = 'sem_ideal' | 'abaixo_minimo' | 'abaixo_ideal' | 'ok' | 'encalhe';

export interface CelulaCompra {
  /** Estoque somado da rede inteira (loja negativa conta zero). */
  estoque: number;
  /** Peças em caixa entre lojas (saíram da origem, não entraram no destino). */
  transito: number;
  /** Pedido à marca ainda não recebido. */
  emPedido: number;
  minimo: number | null;
  ideal: number | null;
}

export interface ContaCompra {
  tenho: number;
  /** Null = sem IDEAL (não é zero). */
  comprar: number | null;
  situacao: SituacaoCompra;
}

const inteiro = (v: unknown): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const quantiaOuNulo = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** A conta de UM tamanho de UMA cor. */
export function contaDaCompra(c: CelulaCompra): ContaCompra {
  const tenho = inteiro(c.estoque) + inteiro(c.transito) + inteiro(c.emPedido);
  const minimo = quantiaOuNulo(c.minimo);
  const ideal = quantiaOuNulo(c.ideal);
  if (ideal === null) return { tenho, comprar: null, situacao: 'sem_ideal' };
  const comprar = Math.max(0, ideal - tenho);
  if (ideal === 0) return { tenho, comprar: 0, situacao: tenho > 0 ? 'encalhe' : 'ok' };
  if (minimo !== null && tenho < minimo) return { tenho, comprar, situacao: 'abaixo_minimo' };
  if (tenho < ideal) return { tenho, comprar, situacao: 'abaixo_ideal' };
  return { tenho, comprar: 0, situacao: 'ok' };
}

/** Situações que o dono quer VER primeiro (ordem da lista e do filtro). */
export const PESO_SITUACAO: Record<SituacaoCompra, number> = {
  abaixo_minimo: 0,
  abaixo_ideal: 1,
  encalhe: 2,
  ok: 3,
  sem_ideal: 4,
};

/** A pior situação de um conjunto de tamanhos (o que a linha da cor mostra). */
export function piorSituacao(situacoes: SituacaoCompra[]): SituacaoCompra {
  if (!situacoes.length) return 'sem_ideal';
  return situacoes.reduce((a, b) => (PESO_SITUACAO[b] < PESO_SITUACAO[a] ? b : a));
}

/**
 * O que um item de pedido de compra AINDA deve à rede, por tamanho:
 * pedido − recebido, nunca negativo. `tamanhosQty` e `tamanhosQtyRecebida`
 * chegam como o banco guarda (JSON em texto) ou já como objeto.
 */
export function pendenteDoItem(
  tamanhosQty: unknown,
  tamanhosQtyRecebida: unknown,
): Record<string, number> {
  const ler = (v: unknown): Record<string, number> => {
    if (!v) return {};
    try {
      const o = typeof v === 'string' ? JSON.parse(v) : v;
      return o && typeof o === 'object' ? (o as Record<string, number>) : {};
    } catch {
      return {};
    }
  };
  const pedido = ler(tamanhosQty);
  const recebido = ler(tamanhosQtyRecebida);
  const out: Record<string, number> = {};
  for (const [t, q] of Object.entries(pedido)) {
    const falta = inteiro(q) - inteiro(recebido[t]);
    const tam = String(t).trim().toUpperCase();
    if (falta > 0 && tam) out[tam] = (out[tam] || 0) + falta;
  }
  return out;
}

/**
 * O item do pedido de compra ainda está "a caminho" (conta no TENHO)?
 *
 * - pedido cancelado não conta;
 * - item já recebido/cancelado não conta (o que chegou já está no estoque);
 * - RASCUNHO só conta se foi gerado pela própria aba Vitalícios: é o que
 *   impede gerar duas vezes o mesmo pedido. Rascunho lançado à mão (que pode
 *   estar esquecido há meses) não segura compra nenhuma — "já pedido" é o que
 *   foi mandado à marca (decisão do dono).
 */
export function itemAindaAChegar(
  statusPedido: string | null | undefined,
  origemPedido: string | null | undefined,
  statusItem: string | null | undefined,
): boolean {
  const sp = String(statusPedido || '').trim().toLowerCase();
  const si = String(statusItem || 'pendente').trim().toLowerCase();
  if (sp === 'cancelado') return false;
  if (si !== 'pendente' && si !== 'parcial') return false;
  if (sp === 'rascunho') return String(origemPedido || '') === ORIGEM_PEDIDO_VITALICIOS;
  return true;
}

/** `PurchaseOrder.origem` dos pedidos que a aba gera. */
export const ORIGEM_PEDIDO_VITALICIOS = 'vitalicios';

/** A grade da casa (46–60) primeiro, em ordem; o resto depois (P, M, G…, 44…). */
const GRADE_DA_CASA = ['46', '48', '50', '52', '54', '56', '58', '60'];
const LETRAS = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XXG', 'EXG', 'G1', 'G2', 'G3', 'G4', 'U', 'UNICO', 'ÚNICO'];

export function ordenarTamanhos(tamanhos: string[]): string[] {
  const peso = (t: string) => {
    const up = String(t).trim().toUpperCase();
    const casa = GRADE_DA_CASA.indexOf(up);
    if (casa >= 0) return casa;
    const num = Number(up);
    if (Number.isFinite(num) && up !== '') return 100 + num;
    const letra = LETRAS.indexOf(up);
    return letra >= 0 ? 1000 + letra : 2000;
  };
  return [...new Set(tamanhos.map((t) => String(t).trim().toUpperCase()).filter(Boolean))].sort(
    (a, b) => peso(a) - peso(b) || a.localeCompare(b),
  );
}

/** Mesma normalização que o resto do catálogo usa pra COR/MARCA/TAMANHO. */
export function norm(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

/** Código de produto sem zeros à esquerda (o `normalizeCodigo` da casa). */
export function codigoSemZeros(v: unknown): string {
  return String(v ?? '').trim().replace(/^0+/, '');
}
