/**
 * O VEREDITO do motor da conciliação — puro, sem banco, com spec.
 *
 * Nasceu da medição de 20/09/2026 em produção, que mostrou o motor errando
 * pros DOIS lados:
 *
 *  - ALARME FALSO. 126 dos 132 "Divergente" eram venda do PDV com pagamento
 *    DIVIDIDO (PIX + dinheiro, PIX + cartão): o motor comparava o PIX com o
 *    total da venda. Nos 126 o valor do gateway batia ao centavo com UM dos
 *    pagamentos da venda — e em todos o `details` daquele pagamento citava o
 *    id da order do gateway. É essa citação que casa aqui, não o valor solto
 *    (venda meio-a-meio tem dois pagamentos do mesmo valor). Pelo mesmo motivo
 *    2 das 4 vendas "Duplicado" eram só dois PIX de uma venda dividida.
 *
 *  - SILÊNCIO FALSO. O motor nunca olhou o status do dono: 16 PIX pagos em
 *    venda CANCELADA e 11 pedidos do site cancelados saíam "Conciliado" porque
 *    o valor batia. A base local não fica sabendo de estorno, então pago +
 *    cancelado não é conciliado: é "confira se o dinheiro voltou".
 */
import { DonoDoPagamento, PagamentoDaVenda, ROTULO_DONO } from '../common/dono-do-pagamento';

export type StatusConciliacao = 'CONCILIADO' | 'DIVERGENTE' | 'NAO_ENCONTRADO' | 'DUPLICADO';

export interface TransacaoPaga {
  id: string;
  pedidoRef: string | null;
  /** Id da order no gateway (`or_…` / `ORDE_…`) — é o que o pagamento da venda cita. */
  gatewayOrderId: string | null;
  cents: number | null;
}

export interface Veredito {
  status: StatusConciliacao;
  motivo: string | null;
  valorSistemaCents: number | null;
}

/** Métodos do PDV cujo dinheiro passa por gateway (medido: só estes dois citam order). */
const METODOS_DE_GATEWAY = new Set(['pix', 'venda_online']);

const TOLERANCIA_CENTS = 1;

/** A coluna `motivo` é VarChar(200) — texto maior derruba o upsert inteiro. */
export const MOTIVO_MAX = 200;

const brl = (cents: number | null) =>
  cents == null
    ? 'R$ ?'
    : `R$ ${(cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

const bate = (a: number | null, b: number | null, folga = TOLERANCIA_CENTS) =>
  a != null && b != null && Math.abs(a - b) <= folga;

/** O pagamento da venda que CITA esta order do gateway no `details`. */
export function pagamentoQueCita(
  pagamentos: PagamentoDaVenda[] | undefined,
  gatewayOrderId: string | null,
): PagamentoDaVenda | null {
  const id = String(gatewayOrderId || '').trim();
  // Id curto demais casaria por acaso dentro de qualquer JSON.
  if (id.length < 8 || !pagamentos?.length) return null;
  return pagamentos.find((p) => !!p.details && p.details.includes(id)) || null;
}

const FEMININO: Record<DonoDoPagamento['tipo'], boolean> = { pdv: true, live: false, crediario: true, site: false };

/** `longa` = o motivo inteiro; curta = sufixo de um motivo que já existe (cabe nos 200). */
function notaDaSituacao(dono: DonoDoPagamento, longa: boolean): string | null {
  const rotulo = ROTULO_DONO[dono.tipo];
  const cancelado = FEMININO[dono.tipo] ? 'CANCELADA' : 'CANCELADO';
  if (dono.situacao === 'cancelado') {
    return longa
      ? `${rotulo} ${cancelado} com pagamento PAGO no gateway — conferir se o dinheiro foi estornado`
      : `${rotulo} ${cancelado}`;
  }
  if (dono.situacao === 'em_aberto') {
    return longa
      ? `pagamento PAGO e ${rotulo} segue "${dono.status}" no sistema — o dinheiro entrou e o sistema não fechou`
      : `${rotulo} segue "${dono.status}"`;
  }
  return null;
}

export function classificarPagamentos(
  transacoes: TransacaoPaga[],
  donos: Map<string, DonoDoPagamento>,
): Map<string, Veredito> {
  const ref = (t: TransacaoPaga) => String(t.pedidoRef || '').trim();
  const irmasPorRef = new Map<string, TransacaoPaga[]>();
  for (const t of transacoes) {
    if (!ref(t)) continue;
    irmasPorRef.set(ref(t), [...(irmasPorRef.get(ref(t)) || []), t]);
  }

  const out = new Map<string, Veredito>();
  for (const t of transacoes) {
    const dono = ref(t) ? donos.get(ref(t)) : undefined;
    if (!dono) {
      out.set(t.id, {
        status: 'NAO_ENCONTRADO',
        motivo: ref(t)
          ? `${ref(t)} não é venda, carrinho da live, baixa de crediário nem pedido do site`
          : 'pagamento sem venda vinculada',
        valorSistemaCents: null,
      });
      continue;
    }

    const irmas = irmasPorRef.get(ref(t)) || [t];
    const veredito =
      dono.tipo === 'pdv' ? vereditoDaVenda(t, dono, irmas) : vereditoDeDonoUnico(t, dono, irmas.length);

    // Dono que não está de pé: o valor bater não faz disso um conciliado.
    if (dono.situacao !== 'ok') {
      if (veredito.status === 'CONCILIADO') {
        veredito.status = 'DIVERGENTE';
        veredito.motivo = notaDaSituacao(dono, true);
      } else {
        veredito.motivo = `${veredito.motivo} · ${notaDaSituacao(dono, false)}`;
      }
    }
    veredito.motivo = veredito.motivo ? veredito.motivo.slice(0, MOTIVO_MAX) : null;
    out.set(t.id, veredito);
  }
  return out;
}

/** Live, crediário e pedido do site: um dono, um pagamento. */
function vereditoDeDonoUnico(t: TransacaoPaga, dono: DonoDoPagamento, pagas: number): Veredito {
  const rotulo = ROTULO_DONO[dono.tipo];
  if (pagas > 1) {
    return {
      status: 'DUPLICADO',
      motivo: `${pagas} transações pagas pro mesmo ${rotulo} — possível pagamento em dobro`,
      valorSistemaCents: dono.cents,
    };
  }
  if (bate(t.cents, dono.cents)) {
    return { status: 'CONCILIADO', motivo: `casou com ${rotulo}`, valorSistemaCents: dono.cents };
  }
  return {
    status: 'DIVERGENTE',
    motivo: `gateway ${brl(t.cents)} ≠ ${rotulo} ${brl(dono.cents)}`,
    valorSistemaCents: dono.cents,
  };
}

/** Venda do PDV: pode ser dividida em vários pagamentos — casa com o pagamento que cita a order. */
function vereditoDaVenda(t: TransacaoPaga, dono: DonoDoPagamento, irmas: TransacaoPaga[]): Veredito {
  const pagamentos = dono.pagamentos || [];
  const citado = pagamentoQueCita(pagamentos, t.gatewayOrderId);

  if (citado && bate(t.cents, citado.cents)) {
    return {
      status: 'CONCILIADO',
      motivo:
        pagamentos.length > 1
          ? `casou com o pagamento ${citado.method} de ${brl(citado.cents)} (venda de ${brl(dono.cents)} dividida em ${pagamentos.length} pagamentos)`
          : 'casou com venda do PDV',
      valorSistemaCents: citado.cents,
    };
  }

  if (irmas.length === 1) {
    // Um pagamento só no gateway: a régua é o pagamento citado, se houver; senão o total da venda.
    const esperado = citado ? citado.cents : dono.cents;
    if (bate(t.cents, esperado)) {
      return { status: 'CONCILIADO', motivo: 'casou com venda do PDV', valorSistemaCents: esperado };
    }
    return {
      status: 'DIVERGENTE',
      motivo: citado
        ? `gateway ${brl(t.cents)} ≠ pagamento ${citado.method} de ${brl(citado.cents)} registrado na venda`
        : `gateway ${brl(t.cents)} ≠ venda do PDV ${brl(dono.cents)}`,
      valorSistemaCents: esperado,
    };
  }

  // Várias transações pagas na venda e esta não casa com pagamento nenhum.
  // Antes de gritar "em dobro": a SOMA do que o gateway recebeu fecha com a
  // soma dos pagamentos de gateway da venda? (link de R$ 250 lançado como
  // R$ 213,10 + PIX de R$ 36,90 — o dinheiro está certo, o lançamento é que
  // foi picado diferente.)
  const somaGateway = irmas.reduce((s, x) => s + (x.cents || 0), 0);
  const somaRegistrada = pagamentos
    .filter((p) => METODOS_DE_GATEWAY.has(p.method.toLowerCase()))
    .reduce((s, p) => s + (p.cents || 0), 0);
  if (bate(somaGateway, somaRegistrada, irmas.length * TOLERANCIA_CENTS)) {
    return {
      status: 'CONCILIADO',
      motivo: `as ${irmas.length} transações do gateway somam ${brl(somaGateway)} = pagamentos PIX/online registrados na venda`,
      valorSistemaCents: t.cents,
    };
  }
  return {
    status: 'DUPLICADO',
    motivo:
      `${irmas.length} transações pagas na mesma venda; esta (${brl(t.cents)}) não casa com nenhum pagamento registrado ` +
      `(gateway ${brl(somaGateway)} × venda ${brl(somaRegistrada)} em PIX/online)`,
    valorSistemaCents: citado ? citado.cents : null,
  };
}
