/**
 * QUANDO UM CARD DE TRANSFERÊNCIA AINDA PODE GANHAR CAIXA/ETIQUETA.
 *
 * Régua única porque DOIS lados perguntam a mesma coisa e não podem divergir:
 * o `JuntadaService`, que cria a caixa, e o `listMine` do `PickOrdersService`,
 * que decide se o botão aparece no card. Se a tela mostrasse o botão e o
 * backend recusasse, a vendedora clicaria num erro — que é exatamente o tipo
 * de porta falsa que fez a loja inventar rastreio na mão.
 */

/**
 * Quantos dias depois do "📦 Enviei pra loja X" a RETIRADA ainda tira
 * etiqueta. Curto de propósito — ver `podeGanharCaixa`.
 */
export function janelaEtiquetaRetiradaDias(): number {
  // ⚠️ `Number('')` é ZERO, não NaN: ler a env vazia com o parse ingênuo
  // desligava a janela inteira em silêncio (o spec pegou). Env em branco =
  // não configurada; `0` DIGITADO continua valendo como kill-switch.
  const bruto = String(process.env.RETIRADA_ETIQUETA_APOS_ENVIO_DIAS ?? '').trim();
  if (!bruto) return 3;
  const n = Number(bruto);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

/**
 * O CARD PODE GANHAR CAIXA AGORA?
 *
 * Normal: só card bipado e ainda não despachado (`separated`/`ready`).
 *
 * RECUPERAÇÃO DA RETIRADA (27/08 — Hellen, LP-000296). O botão de etiqueta
 * nasceu no mesmo dia; o card de São José já estava `shipped`, porque a
 * vendedora fecha a transferência de retirada no "📦 Enviei pra loja X" — e
 * aí não havia mais porta nenhuma: `shipped` é ponto final no `NEXT_ALLOWED`
 * e o `afterShippedSideEffects` JÁ rodou o acerto financeiro das duas pernas,
 * então voltar o card seria desfazer dinheiro pra imprimir um papel.
 *
 * O que faltava não era o card — era a ETIQUETA. Ela continua disponível por
 * alguns dias depois do envio, com a caixa nascendo igual. A janela é curta
 * porque há **33 cards nesse estado desde abril** (medido em 27/08): sem ela,
 * meia rede ganharia botão pra ressuscitar caixa de peça que chegou há meses.
 *
 * Só vale pra RETIRADA: no feeder de juntada, `shipped` significa que a caixa
 * JÁ foi recebida na âncora (quem carimba é o cron `juntada-reconcile`) —
 * abrir caixa ali seria inventar uma segunda viagem.
 */
export function podeGanharCaixa(
  pick: { status: string; updatedAt?: Date | string | null },
  ehRetirada: boolean,
  agora: Date = new Date(),
): boolean {
  if (['separated', 'ready'].includes(pick.status)) return true;
  if (!ehRetirada || pick.status !== 'shipped') return false;
  const desde = pick.updatedAt ? new Date(pick.updatedAt).getTime() : 0;
  if (!desde || Number.isNaN(desde)) return false;
  return agora.getTime() - desde <= janelaEtiquetaRetiradaDias() * 24 * 60 * 60 * 1000;
}
