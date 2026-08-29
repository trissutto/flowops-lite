/**
 * POLÍTICA DE FRETE (dono, 29/08) — a regra que decide QUANTOS pacotes um
 * pedido pode virar, por destino e modalidade:
 *
 *   - FORA DO ESTADO: juntada OBRIGATÓRIA. SEDEX/PAC interestadual é caro —
 *     medido em 29/08: 18 pedidos/30d saíram divididos pra fora de SP, 21
 *     pacotes pagos a mais. O routing SEMPRE nomeia uma âncora.
 *   - MOTOBOY: 1 loja de despacho SEMPRE — motoboy não faz coleta em duas
 *     lojas.
 *   - DENTRO DE SP: caso a caso. O pedido roteia e as lojas bipam normal, mas
 *     o ENVIO de 2+ pacotes espera o carimbo da matriz (liberar ou juntar).
 *   - RETIRADA: fora da política — a loja da retirada já consolida (REGRA 0).
 *
 * SP pelo CEP: faixa 01000-000..19999-999 → primeiro dígito 0 ou 1.
 */

/** true = dentro de SP; false = fora; null = CEP ilegível (não força nada). */
export function dentroDeSaoPaulo(cep: unknown): boolean | null {
  const d = String(cep ?? '').replace(/\D/g, '');
  if (d.length < 5) return null;
  return d[0] === '0' || d[0] === '1';
}

/** Mesma detecção do guard de etiqueta do motoboy (pick-orders, 17/08). */
export function ehEntregaMotoboy(
  shippingMethod?: string | null,
  checkoutInfo?: string | null,
): boolean {
  let kind = '';
  try {
    kind = String(JSON.parse(checkoutInfo || '{}')?.shipping?.kind || '');
  } catch {
    /* sem checkoutInfo */
  }
  return kind === 'motoboy' || /motoboy|moto boy/i.test(String(shippingMethod || ''));
}

/**
 * O routing DEVE consolidar este pedido numa âncora única?
 * Kill-switches: ROUTING_JUNTADA_FORA_ESTADO=0 e ROUTING_JUNTADA_MOTOBOY=0.
 */
export function consolidacaoObrigatoria(order: {
  isPickup?: boolean | null;
  shippingCep?: string | null;
  shippingMethod?: string | null;
  checkoutInfo?: string | null;
}): boolean {
  if (order.isPickup) return false;
  if (
    ehEntregaMotoboy(order.shippingMethod, order.checkoutInfo) &&
    String(process.env.ROUTING_JUNTADA_MOTOBOY ?? '').trim() !== '0'
  ) {
    return true;
  }
  if (
    dentroDeSaoPaulo(order.shippingCep) === false &&
    String(process.env.ROUTING_JUNTADA_FORA_ESTADO ?? '').trim() !== '0'
  ) {
    return true;
  }
  return false;
}

/**
 * GATE DENTRO DE SP — o pedido está esperando a matriz decidir "liberar N
 * fretes" ou "juntar"? Só vale pra envio dentro de SP com 2+ pacotes indo
 * PRA CLIENTE (card feeder de juntada não conta — vai pra âncora).
 * Kill-switch: PACOTES_GATE_DENTRO_SP=0.
 *
 * `prisma` tipado frouxo de propósito (mesmo padrão de rota-propria.ts):
 * funciona com o client e com tx.
 */
export async function pacotesAguardandoLiberacao(
  prisma: {
    order: { findUnique: (args: any) => Promise<any> };
    pickOrder: { count: (args: any) => Promise<number> };
  },
  orderId: string,
): Promise<{ travado: boolean; pacotes: number; motivo?: string }> {
  if (String(process.env.PACOTES_GATE_DENTRO_SP ?? '').trim() === '0') {
    return { travado: false, pacotes: 0 };
  }
  const order: any = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      isPickup: true,
      shippingCep: true,
      wcOrderNumber: true,
      pacotesLiberadosEm: true,
    } as any,
  });
  if (!order || order.isPickup || order.pacotesLiberadosEm) return { travado: false, pacotes: 0 };
  // Fora de SP a juntada é obrigatória no routing — o gate é só dentro de SP.
  if (dentroDeSaoPaulo(order.shippingCep) !== true) return { travado: false, pacotes: 0 };

  // Pacotes indo pra CLIENTE: cards não-transfer que ainda existem no pedido.
  const pacotes = await prisma.pickOrder.count({
    where: {
      orderId,
      isTransfer: false,
      status: { in: ['new', 'separating', 'separated', 'ready', 'shipped'] },
    },
  });
  if (pacotes <= 1) return { travado: false, pacotes };
  return {
    travado: true,
    pacotes,
    motivo:
      `Pedido ${order.wcOrderNumber || orderId} está em ${pacotes} PACOTES dentro de SP — ` +
      `envio aguarda a matriz decidir: LIBERAR os fretes ou JUNTAR numa loja âncora ` +
      `(tela Remessas → Pacotes a decidir). A separação/bipe segue normal.`,
  };
}
