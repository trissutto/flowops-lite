/**
 * O PRAZO DA RETIRADA EM LOJA — e a diferença entre "está aqui" e "vem de lá".
 *
 * O site prometia "fica pronto em ~3h" pra TODA retirada. A regra do dono
 * (17/09/2026, pedido LP-001490, retirada em São José com a peça em
 * Itanhaém): **3 horas só quando a peça está NA loja de retirada, e mesmo
 * assim depois que a loja confirma. Se vem de outra loja, pelo menos 4 dias
 * úteis** — a peça viaja pelo carro da rede, e o carro não passa todo dia.
 *
 * Por isso a retirada passou a ter uma COBERTURA, decidida pelo estoque da
 * loja escolhida no momento da cotação e carimbada no pedido quando ele
 * nasce (`checkoutInfo.retirada`):
 *
 *   'loja'          → cada peça da sacola tem saldo entregável na loja de
 *                     retirada. Prazo = horas (`retiradaPrazoHoras`, config).
 *   'transferencia' → pelo menos uma peça vem de outra loja. Prazo = dias
 *                     úteis (env abaixo).
 *   'desconhecida'  → não deu pra conferir (sacola sem código resolvido,
 *                     espelho fora). O site fala as DUAS possibilidades.
 *
 * ⚠️ O carimbo é do NASCIMENTO do pedido, de propósito: depois que o
 * roteamento roda e a peça sai da arara, o saldo da loja muda e uma
 * conferência ao vivo diria "não tem" pra peça que já está separada.
 */
export type CoberturaRetirada = 'loja' | 'transferencia' | 'desconhecida';

/**
 * Dias úteis prometidos quando a peça vem de outra loja. Env em branco =
 * 4; `0` digitado NÃO é aceito (prazo zero é a promessa errada que isto
 * existe pra tirar da tela).
 */
export function diasUteisRetiradaTransferencia(): number {
  const bruto = String(process.env.RETIRADA_TRANSFER_DIAS_UTEIS ?? '').trim();
  if (!bruto) return 4;
  const n = Number(bruto);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 4;
}

/**
 * A loja cobre a sacola inteira? `saldoPorCodigo` é o saldo ENTREGÁVEL da
 * loja de retirada por código; `pedido` é quantas peças de cada código a
 * cliente levou. Código sem saldo na lista conta como zero. Sacola vazia ou
 * com código não resolvido não é "loja" — é desconhecida.
 */
export function coberturaDaLoja(
  pedido: Array<{ codigo: string | null | undefined; qtd: number }>,
  saldoPorCodigo: ReadonlyMap<string, number>,
): CoberturaRetirada {
  if (!pedido.length) return 'desconhecida';
  const precisa = new Map<string, number>();
  for (const p of pedido) {
    const cod = normalizaCodigo(p.codigo);
    if (!cod) return 'desconhecida';
    precisa.set(cod, (precisa.get(cod) ?? 0) + Math.max(1, Math.floor(Number(p.qtd) || 1)));
  }
  for (const [cod, qtd] of precisa) {
    if ((saldoPorCodigo.get(cod) ?? 0) < qtd) return 'transferencia';
  }
  return 'loja';
}

/** A mesma régua do espelho e do roteamento: sem zeros à esquerda. */
export function normalizaCodigo(v: unknown): string {
  return String(v ?? '').trim().replace(/^0+/, '');
}
