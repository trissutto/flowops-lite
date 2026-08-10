import 'server-only';
import { api } from '@/lib/api';
import { getClienteLogada } from '@/lib/conta';

/**
 * TROCAS — a ponte entre o site e o portal que já existe no FlowOps.
 *
 * ── O QUE MUDA AQUI, E POR QUÊ ──
 *
 * O portal do FlowOps se autentica pela dupla **nº do pedido + CPF** — é o
 * padrão de portal de troca, e continua valendo pra quem não tem conta.
 *
 * Mas a cliente LOGADA já provou quem é: o cookie httpOnly dela carrega um
 * token do CRM. Fazê-la digitar o CPF de novo, e ainda caçar o número do
 * pedido no e-mail, é pedir que ela prove duas vezes a mesma coisa — e é
 * exatamente onde se desiste de pedir troca e se manda mensagem no WhatsApp,
 * que custa atendimento.
 *
 * Então o `doc` NUNCA vem do navegador quando há sessão: é lido do CRM aqui
 * no servidor. Isso não é só conveniência, é segurança — se o site aceitasse
 * um CPF digitado no corpo da requisição de quem está logado, bastaria trocar
 * o número pra ver o pedido de outra pessoa.
 *
 * A regra de negócio (prazo, benefício de reversa grátis, motivos aceitos)
 * continua INTEIRA no backend. Duas telas de troca com duas políticas seria
 * duas políticas divergindo sozinhas — a razão original de o site só linkar
 * o portal em vez de recriá-lo.
 */

/** CPF da cliente logada, só dígitos. `null` = visitante. */
export async function docDaSessao(): Promise<string | null> {
  try {
    const cliente = await getClienteLogada();
    const cpf = String(cliente?.cpf ?? '').replace(/\D/g, '');
    return cpf.length === 11 ? cpf : null;
  } catch {
    // Backend fora não pode impedir o fluxo de visitante (que digita o CPF).
    return null;
  }
}

/**
 * Resolve qual documento usar. Sessão SEMPRE vence o que veio do corpo —
 * ver o aviso de segurança no cabeçalho.
 */
export async function resolverDoc(doInformado?: string | null): Promise<string> {
  const daSessao = await docDaSessao();
  if (daSessao) return daSessao;
  return String(doInformado ?? '').trim();
}

/** Chamada ao portal do FlowOps. Nunca cacheia: é dado de pedido. */
export async function chamarTrocas<T>(caminho: string, body: unknown): Promise<T> {
  return api<T>(`/public/trocas/${caminho}`, {
    method: 'POST',
    body,
    revalidate: 0,
    timeoutMs: 15000,
  });
}

/* ─────────────────────────── contratos do portal ────────────────────────── */

export interface PedidoResumo {
  numero: string;
  origem: string;
  data: string;
  total: number | null;
  itens: string[];
  itensTotal: number;
}

export interface ItemTrocavel {
  sku: string;
  productName: string;
  qty: number;
  /** Quanto ainda pode ser trocado (desconta o que já foi pedido). */
  disponivel: number;
  jaSolicitado: number;
  unitPaid?: number;
}

export interface TrocaResumo {
  id: string;
  numero: string;
  status: string;
  motivo: string | null;
  createdAt: string;
  reversaGratis: boolean;
  reversaCodigo: string | null;
  clienteTrackingCode: string | null;
  decisao: string | null;
  podeNovaTroca: boolean;
}

export interface PedidoDetalhe {
  wcOrderNumber: string;
  status: string;
  customerName: string | null;
  prazo: {
    prazoDias: number;
    entregue: boolean;
    dentroDoPrazo: boolean;
    diasDesdeEntrega: number | null;
    trackingCode: string | null;
  };
  reversaGratisDisponivel: boolean;
  items: ItemTrocavel[];
  motivos: Array<{ id: string; label: string; pedeFoto?: boolean } | string>;
  trocas: TrocaResumo[];
}
