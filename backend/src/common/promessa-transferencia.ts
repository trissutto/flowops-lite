/**
 * ÓRFÃ DE TRANSFERÊNCIA NÃO É PROMESSA (23/11/2026 — Itanhaém → Praia Grande).
 *
 * A ordem `tipo=TRANSFERENCIA` nasce do BIPE e só existe DENTRO de uma caixa:
 * o bipe cria a linha e a amarra na remessa aberta do par origem→destino. Não
 * há fila, tela ou botão que mostre uma transferência `pending` sem caixa —
 * `listPendingForStore` filtra REALINHAMENTO, a Grade por Loja só desenha o
 * número, `cancelarOrdem` recusa o tipo. A loja não vê, a matriz não vê, e só
 * a varredura de 7 dias (4h35) a cancelaria.
 *
 * Em 23/11 o bipe de Itanhaém pra Praia Grande gravou a linha e falhou antes
 * de amarrá-la na REM-2026-003253: 42 linhas em 5 minutos, invisíveis, e cada
 * uma contava como "peça já pedida daqui pra essa loja" na trava do eco do
 * leitor (`garantirNaoDuplicaBipe`). Com 5 em estoque e 5 órfãs, o 6º bipe da
 * HAPPINESS PRETO 50 era recusado — e assim em toda peça que a loja tentou.
 * As mesmas linhas entravam no `prometido` da Grade por Loja e no estoque
 * "comprometido" do plano de realinhamento.
 *
 * A régua é uma só, e mora aqui: transferência pendente SEM caixa é lixo de um
 * bipe que não completou (ou de peça tirada da caixa pelo código antigo), não
 * uma promessa. Quem conta promessa ignora; a varredura cancela.
 */
export type LinhaPromessa = {
  tipo?: string | null;
  realignmentStatus?: string | null;
  shipmentId?: string | null;
};

export function promessaOrfaDeTransferencia(l: LinhaPromessa): boolean {
  return (
    String(l.tipo ?? '').trim().toUpperCase() === 'TRANSFERENCIA' &&
    String(l.realignmentStatus ?? '').trim() === 'pending' &&
    !l.shipmentId
  );
}

/** Nota gravada na linha cancelada pela varredura — pra quem for auditar. */
export const NOTA_ORFA_TRANSFERENCIA =
  'Bipe de transferência que não entrou na caixa — cancelado automaticamente (órfã)';
