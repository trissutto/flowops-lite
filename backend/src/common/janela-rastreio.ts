/**
 * A JANELA DO RASTREIO — desde quando a caixa está na rua, e por quanto tempo
 * ainda vale perguntar aos Correios onde ela está.
 *
 * Mora aqui porque TRÊS lugares precisam da mesma régua e não podem divergir:
 *   1. a lista de `/separacao` (`whereNativoDaAba`);
 *   2. o badge de cada aba (`wcCounts`) — badge que discorda da tela foi o
 *      defeito de 13/08;
 *   3. o `RastreioSyncCron.candidatos()`, que decide quais objetos consultar.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴 POR QUE NÃO É `updatedAt` (25/08/2026)
 *
 * A janela nasceu em 19/08 medindo por `Order.updatedAt`, tratando ele como
 * "quando a loja despachou". Não é: `updatedAt` é `@updatedAt` do Prisma —
 * QUALQUER escrita na linha o carimba com agora.
 *
 * O dono atribuiu a vendedora a um pedido antigo (`PATCH /sellers/assign/:id`,
 * a tag rosa da tela) e o pedido **voltou pra "Em trânsito"**: a linha foi
 * tocada, `updatedAt` virou agora, e um pedido despachado meses atrás passou a
 * caber em `updatedAt >= hoje-30d`. Não era exclusividade da vendedora — o
 * carimbo de conversão do Google Ads, o aviso de entrega no WhatsApp, a
 * correção de endereço e a conferência de venda fazem exatamente o mesmo.
 * Ressuscitar pedido concluído na fila é o alarme falso que faz a operação
 * parar de olhar pra tela.
 *
 * Agora quem manda é `Order.shippedAt`, gravado JUNTO com `status='shipped'`.
 * `updatedAt` fica só como plano B pra linha antiga que o backfill não
 * alcançou — sem ele, pedido sem carimbo sumiria das duas abas, e invisível é
 * pior que na aba errada.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * 30 dias — a MESMA janela do `RastreioSyncCron.candidatos()`.
 *
 * Passou disso, os Correios não têm mais o que dizer e o objeto nunca vai ser
 * confirmado como entregue. Sem a janela, "Em trânsito" viraria o depósito de
 * todo pedido despachado antes de 18/08 — data em que o rastreio começou a
 * funcionar de verdade (faltava o header `Accept-Language`).
 */
export const RASTREIO_JANELA_DIAS = 30;

/** O instante em que a janela abre: agora − 30 dias. */
export function inicioDaJanela(agora: Date = new Date()): Date {
  return new Date(agora.getTime() - RASTREIO_JANELA_DIAS * 86_400_000);
}

/**
 * QUANDO ESTE PEDIDO FOI DESPACHADO — a leitura, em JS, da mesma regra que os
 * `where` abaixo aplicam no Postgres. Usada por quem já tem a linha na mão
 * (`abaDoNativo`) em vez de consultar de novo.
 */
export function despachadoEm(o: {
  shippedAt?: Date | string | null;
  updatedAt?: Date | string | null;
}): Date | null {
  const bruto = o?.shippedAt ?? o?.updatedAt ?? null;
  if (!bruto) return null;
  const d = bruto instanceof Date ? bruto : new Date(bruto);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `where` Prisma: despachado DENTRO da janela.
 *
 * Escrito como OR explícito porque Prisma não tem COALESCE em filtro: ou o
 * carimbo próprio responde, ou (só quando ele é nulo) o `updatedAt` legado.
 * O `shippedAt: null` no segundo ramo não é decorativo — sem ele a linha já
 * carimbada seria avaliada duas vezes e um `updatedAt` recente a traria de
 * volta, que é exatamente o defeito que este arquivo existe pra matar.
 */
export function despachadoDentroDaJanela(desde: Date): Record<string, any> {
  return {
    OR: [
      { shippedAt: { gte: desde } },
      { AND: [{ shippedAt: null }, { updatedAt: { gte: desde } }] },
    ],
  };
}

/** `where` Prisma: despachado FORA da janela — o complemento exato do de cima. */
export function despachadoForaDaJanela(desde: Date): Record<string, any> {
  return {
    OR: [
      { shippedAt: { lt: desde } },
      { AND: [{ shippedAt: null }, { updatedAt: { lt: desde } }] },
    ],
  };
}
