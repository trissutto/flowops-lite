import { ehItemSemEstoque } from './item-sem-estoque';

/**
 * PEDIDO INCOMPLETO NÃO POSTA (07/10/2026 — ordem do dono, caso ON-000600).
 *
 * O ON-000600 (3 peças, PAC) nunca foi roteado; a matriz moveu na mão UMA
 * peça pra São José e as outras duas ficaram SEM LOJA. São José bipou,
 * comprou a etiqueta e postou 1 de 3 — o sistema só avisou DEPOIS ("Todas
 * as caixas postadas, mas o pedido NÃO foi concluído"). Medido em 60 dias:
 * 14 pedidos postaram assim; 5 sem reporte nenhum (peça sem loja por
 * "Mover peça" parcial), que a trava do reporte (#1282) não pega.
 *
 * Regra do dono: "nenhuma loja posta caixa de um pedido que ainda tem peça
 * sem loja definida". A loja espera a matriz resolver a peça: mandar de
 * outra loja (ganha loja), crédito ou reembolso (os dois carimbam
 * `cancelledAt`) — e a trava se desfaz sozinha.
 *
 * Fica de fora: frete/linha manual (não é peça) e peça cancelada.
 */
export type LinhaDoPedido = {
  sku?: string | null;
  quantity?: number | null;
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  productName?: string | null;
  assignedStoreId?: string | null;
  cancelledAt?: Date | string | null;
};

export function nomeDaPeca(l: LinhaDoPedido): string {
  const tamanho = [l.cor, l.tamanho].filter(Boolean).join(' ');
  return [l.ref || l.productName || l.sku, tamanho].filter(Boolean).join(' ');
}

/** Peças pagas que ninguém vai separar: sem loja, não canceladas, de estoque. */
export function pecasSemLoja<T extends LinhaDoPedido>(linhas: T[]): T[] {
  return linhas.filter(
    (l) => !l.assignedStoreId && !l.cancelledAt && !ehItemSemEstoque(l as any),
  );
}

export function mensagemPedidoIncompleto(faltam: LinhaDoPedido[]): string {
  const nomes = faltam.map(nomeDaPeca).join(' · ');
  return (
    `🚫 PEDIDO INCOMPLETO — não poste: ${faltam.length} peça(s) deste pedido ainda estão SEM LOJA ` +
    `(${nomes}). A matriz precisa resolver antes (mandar de outra loja, crédito ou reembolso). ` +
    'Guarde a caixa separada e avise a matriz.'
  );
}

/** Kill-switch: `ENVIO_EXIGE_PEDIDO_COMPLETO=0` desliga a trava. */
export function travaPedidoIncompletoLigada(): boolean {
  return String(process.env.ENVIO_EXIGE_PEDIDO_COMPLETO ?? '').trim() !== '0';
}
