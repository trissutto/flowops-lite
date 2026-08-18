/**
 * EM QUE PÉ ESTÁ O PEDIDO QUE ESTA LOJA VENDEU (18/08).
 *
 * A loja que VENDE online nem sempre é a que ATENDE ([[venda-online-canal-loja-
 * que-atende]]): a vendedora fecha no WhatsApp, o card nasce em outra loja e
 * ela ficava sem nenhuma tela pra acompanhar — só o aviso do momento da venda.
 * Depois disso, "cadê o pedido da fulana?" só a matriz respondia.
 *
 * Este helper traduz o par (status do pedido × status das separações) numa
 * frase que a vendedora entende e pode repassar pra cliente. É PURO de
 * propósito: a mesma régua serve pra tela da loja, pra fila e pra qualquer
 * relatório futuro, e dá pra testar sem banco.
 *
 * ⚠️ PEDIDO EM 2+ LOJAS: quem manda é a separação MENOS adiantada — o pacote
 * só sai quando a última peça chega. Mostrar a mais adiantada faria a
 * vendedora prometer envio que não vai acontecer hoje.
 */

export type SituacaoChave =
  | 'cancelado'
  | 'matriz'
  | 'aguardando'
  | 'separando'
  | 'pronto'
  | 'enviado'
  | 'entregue';

export type SituacaoPedidoOnline = {
  chave: SituacaoChave;
  /** Curto, pro badge do card. */
  rotulo: string;
  /** Frase pra vendedora ler (e repassar pra cliente). */
  detalhe: string;
  tom: 'rose' | 'amber' | 'sky' | 'mint' | 'slate';
};

type PickResumo = { status?: string | null; storeName?: string | null; storeCode?: string | null };

/** new < separating < separated/ready < shipped — usado pra achar o gargalo. */
function progresso(status?: string | null): number {
  switch (String(status || '').trim().toLowerCase()) {
    case 'shipped':
      return 3;
    case 'separated':
    case 'ready':
      return 2;
    case 'separating':
      return 1;
    default:
      return 0; // new / issue / desconhecido
  }
}

function nomeLoja(p?: PickResumo | null): string {
  return String(p?.storeName || p?.storeCode || 'outra loja');
}

export function situacaoPedidoOnline(input: {
  orderStatus?: string | null;
  picks?: PickResumo[];
  trackingCode?: string | null;
  isPickup?: boolean;
}): SituacaoPedidoOnline {
  const st = String(input.orderStatus || '').trim().toLowerCase();
  const picks = (input.picks || []).filter(Boolean);

  if (st === 'cancelled' || st === 'canceled' || st === 'refunded') {
    return {
      chave: 'cancelado',
      rotulo: 'Cancelado',
      detalhe: 'Pedido cancelado — confira com a matriz antes de falar com a cliente.',
      tom: 'rose',
    };
  }
  if (st === 'delivered') {
    return {
      chave: 'entregue',
      rotulo: 'Entregue',
      detalhe: input.isPickup
        ? 'A cliente já retirou.'
        : 'Os Correios registraram a entrega.',
      tom: 'mint',
    };
  }

  // Sem separação nenhuma: ninguém pegou o pedido ainda. É o estado que mais
  // trava e o que a vendedora precisa ver primeiro.
  if (!picks.length) {
    if (st === 'shipped' || st === 'completed') {
      return {
        chave: 'enviado',
        rotulo: 'Enviado',
        detalhe: input.trackingCode
          ? `Já saiu — rastreio ${input.trackingCode}.`
          : 'Já saiu.',
        tom: 'sky',
      };
    }
    return {
      chave: 'matriz',
      rotulo: 'Na matriz',
      detalhe: 'A matriz ainda está escolhendo qual loja separa. Não mande peça por conta.',
      tom: 'amber',
    };
  }

  // Gargalo = a separação menos adiantada.
  const gargalo = picks.reduce((pior, p) => (progresso(p.status) < progresso(pior.status) ? p : pior), picks[0]);
  const nivel = progresso(gargalo.status);
  const loja = nomeLoja(gargalo);
  const emVarias = picks.length > 1;
  const sufixo = emVarias ? ` (pedido dividido em ${picks.length} lojas)` : '';

  if (nivel >= 3) {
    return {
      chave: 'enviado',
      rotulo: 'Enviado',
      detalhe: input.trackingCode
        ? `${loja} despachou — rastreio ${input.trackingCode}.`
        : `${loja} despachou.`,
      tom: 'sky',
    };
  }
  if (nivel === 2) {
    return {
      chave: 'pronto',
      rotulo: input.isPickup ? 'Pronto p/ retirada' : 'Pronto p/ postar',
      detalhe: input.isPickup
        ? `Separado — a cliente pode retirar na ${loja}.${sufixo}`
        : `${loja} já separou, falta postar.${sufixo}`,
      tom: 'mint',
    };
  }
  if (nivel === 1) {
    return {
      chave: 'separando',
      rotulo: 'Separando',
      detalhe: `${loja} está separando as peças agora.${sufixo}`,
      tom: 'sky',
    };
  }
  return {
    chave: 'aguardando',
    rotulo: 'Aguardando loja',
    detalhe: `Card na ${loja}, mas a separação ainda não começou.${sufixo}`,
    tom: 'amber',
  };
}

/** Está em andamento? (o que a vendedora precisa acompanhar) */
export function pedidoOnlineEmAndamento(chave: SituacaoChave): boolean {
  return chave !== 'entregue' && chave !== 'cancelado';
}
