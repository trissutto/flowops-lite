/**
 * ESTOQUE JÁ PROMETIDO A OUTRA CLIENTE — a régua ÚNICA, lida pelos dois lados.
 *
 * ── O BUG QUE ISTO CONSERTA (medido em 31/08/2026) ──
 *
 * A vitrine mostrava o estoque BRUTO da rede e o checkout descontava o que já
 * estava prometido a outro pedido. Duas contas do mesmo número, e a cliente só
 * descobria a segunda no clique de pagar: **151 recusas por "esgotou" em 41
 * sessões numa semana, 30 delas sem comprar nada** — R$ 5,9 mil na semana ao
 * ticket de R$ 196,89. **108 dessas 151 foram na BMM-100**, a peça com mais
 * verba de anúncio do mês, que tinha 582 peças e 10 tamanhos com saldo na rede.
 * Não tinha esgotado nada: o que esgotara era a combinação cor+tamanho dela.
 *
 * É o mesmo erro da promoção de 50%, e tem o mesmo conserto: um serviço só,
 * consultado pela vitrine que MOSTRA e pelo guarda que COBRA. Divergir ali faz
 * o checkout recusar o pedido que a própria página prometeu.
 *
 * Medição do impacto no dia da mudança: 124 SKUs com reserva, 162 peças
 * prometidas, **28 variações que a vitrine mostrava disponíveis e o checkout
 * já recusava**. Essas 28 passam a sair riscadas na grade, antes do clique.
 *
 * ── POR QUE DEDUZIR EM VEZ DE RESERVAR ──
 *
 * A alternativa seria baixar o estoque na hora do pedido, ou manter tabela de
 * reservas. As duas criam estado novo pra sincronizar, e estado que precisa ser
 * liberado (pedido cancelado, PIX expirado, separação concluída) é estado que
 * uma hora vaza: reserva órfã trava peça boa e ninguém descobre até a peça
 * "sumir" da vitrine com estoque na arara.
 *
 * Aqui não há o que liberar. O compromisso é DERIVADO dos pedidos que existem:
 * o pedido sai da lista de status vivos e para de reservar sozinho, no mesmo
 * instante, sem cron e sem compensação.
 *
 * ── QUAIS PEDIDOS CONTAM ──
 *
 * Pago e ainda não separado conta sempre. AGUARDANDO PAGAMENTO NÃO CONTA
 * (dono, 17/08: "não separa nada, se vender eu estorno") — pedido sem dinheiro
 * na conta não tira peça da vitrine de ninguém. Enviado/entregue não conta:
 * ali o estoque JÁ baixou, e contar de novo tiraria a peça duas vezes.
 */

/** Status de pedido que seguram peça: pago e ainda não separado. */
export const STATUS_QUE_RESERVAM = [
  'processing',
  'routing',
  'awaiting_stock',
  'separating',
] as const;

/**
 * ZERO. PEDIDO NÃO PAGO NÃO SEGURA PEÇA (dono, 17/08).
 *
 * Eram 3 horas. A troca, dita por quem paga a conta: peça parada na vitrine por
 * causa de um PIX que talvez nunca seja pago é venda perdida CERTA; venda dupla
 * é um risco que existe, é raro, e tem conserto — estorno.
 */
export const HORAS_PENDENTE = 0;

/** `CARRINHO_RESERVA=0` volta ao comportamento antigo (ninguém desconta nada). */
export function reservaLigada(): boolean {
  return String(process.env.CARRINHO_RESERVA ?? '1') !== '0';
}

/**
 * 🔴 TETO DE IDADE DA RESERVA (22/08) — reserva eterna é reserva errada.
 *
 * O que aconteceu: 103 pedidos parados em `separating`, o mais antigo de 27/04,
 * segurando 225 peças. Como `separating` reservava pra sempre, o disponível de
 * 61 variações ficava <= 0 — e 25 delas tinham peça DE VERDADE na arara.
 *
 * Por que 15 dias: a separação real leva 4,1 dias em média (medição das 639
 * caixas em 30 dias). Quinze dias é o dobro da pior separação legítima.
 *
 * `CARRINHO_RESERVA_DIAS=0` desliga o teto (volta a reservar pra sempre).
 */
export function diasDeReserva(): number {
  const v = Number(process.env.CARRINHO_RESERVA_DIAS);
  return Number.isFinite(v) && v >= 0 ? v : 15;
}

/**
 * A VITRINE DESCONTA? (`VITRINE_ESTOQUE_RESERVADO=0` volta a mostrar o bruto.)
 *
 * Interruptor SEPARADO do `CARRINHO_RESERVA` de propósito: se descontar na
 * vitrine der problema (peça sumindo da grade sem motivo aparente), dá pra
 * voltar SÓ a vitrine sem reabrir a venda dupla no checkout. O contrário —
 * desligar o guarda e deixar a vitrine descontando — não faz sentido, e por
 * isso `CARRINHO_RESERVA=0` também desliga esta.
 */
export function vitrineDescontaReserva(): boolean {
  if (!reservaLigada()) return false;
  return String(process.env.VITRINE_ESTOQUE_RESERVADO ?? '1') !== '0';
}

/**
 * O SQL do reservado por SKU, **sem parâmetro nenhum**.
 *
 * Sem `$1` de propósito: este trecho entra dentro do `SQL_VARIACOES`, que já é
 * interpolado com os parâmetros posicionais de quem chama (`$1` = a REF). Um
 * placeholder a mais aqui renumeraria os de lá e quebraria toda consulta do
 * catálogo. Os valores são constantes do próprio código — não vem nada de fora.
 *
 * Devolve uma linha por SKU (`order_items.sku` = `wincred_produtos.codigo`).
 */
export function sqlReservadoPorSku(): string {
  const status = STATUS_QUE_RESERVAM.map((s) => `'${s}'`).join(', ');
  const dias = diasDeReserva();
  // Zero = sem teto: 'epoch' faz todo pedido, de qualquer idade, entrar na conta.
  const desdeReserva =
    dias > 0 ? `NOW() - INTERVAL '${dias} days'` : `TIMESTAMP 'epoch'`;
  const desdePendente = `NOW() - INTERVAL '${HORAS_PENDENTE} hours'`;
  return `
    SELECT oi.sku AS sku, SUM(oi.quantity)::int AS qtd
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE (
             (o.status IN (${status}) AND o.created_at >= ${desdeReserva})
          OR (o.status = 'pending'    AND o.created_at >= ${desdePendente})
     )
     GROUP BY oi.sku
  `;
}

/**
 * A expressão de estoque DISPONÍVEL pra colar numa consulta que já tem o bruto.
 *
 * `bruto` e `reservado` são nomes de coluna/expressão de quem chama. O piso em
 * zero não é decoração: reserva maior que o estoque significa que já houve
 * venda a mais (ou baixa por outro caminho), e número negativo só produziria
 * "restam -3 peças" na tela.
 */
export function sqlDisponivel(bruto: string, reservado: string): string {
  if (!vitrineDescontaReserva()) return `COALESCE(${bruto}, 0)::int`;
  return `GREATEST(COALESCE(${bruto}, 0) - COALESCE(${reservado}, 0), 0)::int`;
}
