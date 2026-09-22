/**
 * ESTORNOS E DEVOLUÇÕES — a régua, num lugar só (22/09/2026).
 *
 * ── O QUE É ──
 *
 * Pedido do dono: devolver dinheiro da cliente PELO SISTEMA, sem ninguém abrir
 * a conta do PagBank. Vale pro site (PagBank desde 16/09 e Pagar.me antes
 * disso), pra venda online do PDV e pra live.
 *
 * ── O QUE A API DOS GATEWAYS PERMITE (conferido na doc oficial, 22/09) ──
 *
 * PagBank (Orders API): `POST /charges/{id}/cancel` com `{amount:{value}}` em
 * CENTAVOS. Parcial e integral (parcial mantém a cobrança `PAID` e soma em
 * `amount.summary.refunded`; integral leva a cobrança pra `CANCELED`). Só
 * cobrança PAGA pode ser estornada. PIX volta pra conta que pagou, em até
 * **90 dias**; cartão cai na fatura em até 2 dias úteis. Aceita
 * `x-idempotency-key` (vale 48h) — a mesma chave não cobra duas vezes.
 *
 * Pagar.me (v5): `DELETE /charges/{id}` com `{amount}` em centavos (sem
 * `amount` = integral). Cartão responde na hora (`canceled`/`refunded`); PIX
 * pode voltar `pending_refund` e terminar depois.
 *
 * ── A REGRA DE OURO DAQUI ──
 *
 * O dono do "estorno aconteceu" é o GATEWAY, nunca a nossa tela: o status só
 * anda com o que a API respondeu, e resposta ambígua (timeout, 5xx) vira
 * EM PROCESSAMENTO — nunca "processado" e nunca "erro" —, porque o dinheiro
 * pode ter saído. É a mesma lição do `success: true` do estoque e do
 * "carimbou feito com o estoque parado".
 */

export type StatusEstorno =
  /** Nasceu no banco, ainda não foi pro gateway (janela de milissegundos). */
  | 'iniciado'
  /** Requisição enviada; esperando a resposta. */
  | 'enviado'
  /** Gateway aceitou mas ainda não concluiu (ou a resposta foi ambígua). */
  | 'processando'
  /** Gateway confirmou o valor devolvido. */
  | 'processado'
  /** Gateway recusou (cobrança não paga, fora do prazo, valor inválido). */
  | 'recusado'
  /** Falha NOSSA ou do gateway (auth, rede) sem cobrança criada. */
  | 'erro';

/** Estornos que ainda podem mudar sozinhos — o cron reconsulta estes. */
export const STATUS_EM_ABERTO: readonly StatusEstorno[] = ['iniciado', 'enviado', 'processando'];

/** O dinheiro saiu (ou está saindo): conta no total estornado do pagamento. */
export const STATUS_QUE_SEGURAM_SALDO: readonly StatusEstorno[] = [
  'iniciado',
  'enviado',
  'processando',
  'processado',
];

export type GatewayEstorno = 'pagbank' | 'pagarme';

/** Motivos do estorno (o dono pediu lista fechada + "Outros" com descrição). */
export const MOTIVOS_ESTORNO = [
  { codigo: 'devolucao_produto', label: 'Devolução de produto' },
  { codigo: 'troca_diferenca', label: 'Troca com diferença' },
  { codigo: 'cancelamento_pedido', label: 'Cancelamento do pedido' },
  { codigo: 'produto_indisponivel', label: 'Produto indisponível' },
  { codigo: 'erro_cobranca', label: 'Erro de cobrança' },
  { codigo: 'cobranca_duplicada', label: 'Cobrança duplicada' },
  { codigo: 'cancelamento_cliente', label: 'Cancelamento solicitado pela cliente' },
  { codigo: 'outros', label: 'Outros' },
] as const;

export type MotivoEstorno = (typeof MOTIVOS_ESTORNO)[number]['codigo'];

export function rotuloDoMotivo(codigo: string | null | undefined): string {
  const m = MOTIVOS_ESTORNO.find((x) => x.codigo === String(codigo || ''));
  return m?.label || String(codigo || '—');
}

/** PIX só volta dentro de 90 dias do pagamento (regra do PagBank/Bacen). */
export const PRAZO_PIX_DIAS = 90;

export interface PagamentoEstornavel {
  /** 'pix' | 'credit_card' (o que o gateway registrou). */
  metodo: string;
  /** Status do pagamento no NOSSO banco ('paid' = dinheiro confirmado). */
  status: string;
  /** Quando a cliente pagou. */
  pagoEm?: Date | string | null;
  /** Id da cobrança no gateway — sem ele não há o que estornar. */
  chargeId?: string | null;
}

/**
 * Este pagamento aceita estorno pela API? Responde o MOTIVO quando não —
 * a tela mostra a frase, em vez de um botão que falha depois.
 */
export function podeEstornar(
  p: PagamentoEstornavel,
  agora: Date = new Date(),
): { pode: boolean; motivo?: string } {
  if (String(p.status || '') !== 'paid') {
    return { pode: false, motivo: 'Só cobrança PAGA pode ser estornada (esta não está paga).' };
  }
  if (!String(p.chargeId || '').trim()) {
    return {
      pode: false,
      motivo: 'O gateway ainda não devolveu o id da cobrança paga — use "Consultar no gateway" e tente de novo.',
    };
  }
  if (ehPix(p.metodo)) {
    const dias = diasDesde(p.pagoEm, agora);
    if (dias !== null && dias > PRAZO_PIX_DIAS) {
      return {
        pode: false,
        motivo: `Devolução de PIX só até ${PRAZO_PIX_DIAS} dias do pagamento (este tem ${dias} dias). Faça por outro meio.`,
      };
    }
  }
  return { pode: true };
}

export function ehPix(metodo: string | null | undefined): boolean {
  return String(metodo || '').toLowerCase().includes('pix');
}

export function diasDesde(quando: Date | string | null | undefined, agora: Date = new Date()): number | null {
  if (!quando) return null;
  const t = new Date(quando).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((agora.getTime() - t) / 86400_000);
}

/** Quanto ainda dá pra estornar deste pagamento, em centavos. */
export function saldoEstornavelCents(input: { pagoCents: number; estornadoCents: number }): number {
  const pago = Math.max(0, Math.round(Number(input.pagoCents) || 0));
  const estornado = Math.max(0, Math.round(Number(input.estornadoCents) || 0));
  return Math.max(0, pago - estornado);
}

export type TipoEstorno = 'integral' | 'parcial';

/**
 * O VALOR PEDIDO CABE? A trava que impede devolver mais do que entrou.
 *
 * Integral = o saldo inteiro (não "o valor original"): pedido que já teve um
 * estorno parcial só tem o resto pra devolver.
 */
export function validarValorEstorno(input: {
  valorCents: number;
  saldoCents: number;
  tipo: TipoEstorno;
}): { ok: true; valorCents: number } | { ok: false; erro: string } {
  const saldo = Math.max(0, Math.round(Number(input.saldoCents) || 0));
  if (saldo <= 0) return { ok: false, erro: 'Este pagamento não tem saldo disponível para estorno.' };
  if (input.tipo === 'integral') return { ok: true, valorCents: saldo };

  const valor = Math.round(Number(input.valorCents) || 0);
  if (!Number.isFinite(valor) || valor <= 0) return { ok: false, erro: 'Informe o valor do estorno.' };
  if (valor > saldo) {
    return {
      ok: false,
      erro: `O valor pedido (${brl(valor)}) é maior que o saldo disponível (${brl(saldo)}).`,
    };
  }
  return { ok: true, valorCents: valor };
}

export function brl(cents: number): string {
  return `R$ ${((Number(cents) || 0) / 100).toFixed(2).replace('.', ',')}`;
}

// ── Leitura da resposta dos gateways ────────────────────────────────────────

export interface LeituraEstorno {
  status: Extract<StatusEstorno, 'processado' | 'processando' | 'recusado'>;
  /** Quanto o gateway diz que JÁ foi devolvido nesta cobrança, em centavos. */
  estornadoTotalCents: number | null;
  /** Status cru da cobrança no gateway — vai pro histórico e pro comprovante. */
  statusGateway: string;
  /** Frase curta do gateway (quando houver) — nunca o JSON cru. */
  mensagem?: string;
}

/**
 * PAGBANK: a resposta do cancel é a própria cobrança. Integral leva a
 * `CANCELED`; parcial mantém `PAID` e soma em `amount.summary.refunded`.
 * Enquanto o refunded não cobrir o que pedimos, fica EM PROCESSAMENTO.
 */
export function lerRespostaPagbank(charge: any, valorPedidoCents: number, jaEstornadoCents = 0): LeituraEstorno {
  const statusGateway = String(charge?.status || '').toUpperCase();
  const refunded = numeroOuNull(charge?.amount?.summary?.refunded);
  const mensagem = frase(charge?.payment_response?.message);
  const esperado = Math.round(jaEstornadoCents + valorPedidoCents);

  if (statusGateway === 'CANCELED') {
    return { status: 'processado', estornadoTotalCents: refunded ?? esperado, statusGateway, mensagem };
  }
  if (refunded !== null && refunded >= esperado) {
    return { status: 'processado', estornadoTotalCents: refunded, statusGateway, mensagem };
  }
  if (statusGateway === 'DECLINED') {
    return { status: 'recusado', estornadoTotalCents: refunded, statusGateway, mensagem };
  }
  // PAID sem o refunded esperado, IN_ANALYSIS, WAITING, resposta estranha:
  // o dinheiro pode estar a caminho — quem decide é a próxima consulta.
  return { status: 'processando', estornadoTotalCents: refunded, statusGateway, mensagem };
}

/**
 * PAGAR.ME: `canceled` + `last_transaction.status='refunded'` é dinheiro
 * devolvido; `pending_refund`/`processing` ainda está andando. O total já
 * devolvido vem em `canceled_amount`.
 */
export function lerRespostaPagarme(charge: any, valorPedidoCents: number, jaEstornadoCents = 0): LeituraEstorno {
  const statusGateway = String(charge?.status || '').toLowerCase();
  const ultimo = String(charge?.last_transaction?.status || '').toLowerCase();
  const cancelado = numeroOuNull(charge?.canceled_amount);
  const mensagem = frase(charge?.last_transaction?.acquirer_message || charge?.message);
  const esperado = Math.round(jaEstornadoCents + valorPedidoCents);

  if (ultimo === 'refunded' || statusGateway === 'canceled') {
    return { status: 'processado', estornadoTotalCents: cancelado ?? esperado, statusGateway: statusGateway || ultimo, mensagem };
  }
  if (cancelado !== null && cancelado >= esperado) {
    return { status: 'processado', estornadoTotalCents: cancelado, statusGateway: statusGateway || ultimo, mensagem };
  }
  // A recusa vem ANTES do "paid": cobrança que segue paga porque o estorno
  // falhou não pode virar "em processamento" e enganar quem está olhando.
  if (ultimo === 'refund_error' || ultimo === 'with_error' || statusGateway === 'failed') {
    return { status: 'recusado', estornadoTotalCents: cancelado, statusGateway: statusGateway || ultimo, mensagem };
  }
  if (ultimo === 'pending_refund' || statusGateway === 'processing' || statusGateway === 'paid') {
    return { status: 'processando', estornadoTotalCents: cancelado, statusGateway: statusGateway || ultimo, mensagem };
  }
  return { status: 'processando', estornadoTotalCents: cancelado, statusGateway: statusGateway || ultimo, mensagem };
}

function numeroOuNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function frase(v: unknown): string | undefined {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 200) : undefined;
}

// ── Senha: bloqueio por tentativa errada ────────────────────────────────────

/** Tentativas erradas que fecham a porta, e por quanto tempo. */
export const SENHA_MAX_TENTATIVAS = 5;
export const SENHA_JANELA_MS = 15 * 60_000;

/**
 * Passou do teto de senha errada na janela? Responde quanto falta pra soltar.
 * Conta as tentativas do MESMO usuário ou do MESMO IP — quem erra 5 vezes
 * fica de fora dos dois jeitos.
 */
export function bloqueioDeSenha(
  errosRecentes: Array<{ em: Date | string }>,
  agora: Date = new Date(),
): { bloqueado: boolean; faltamMs: number; tentativas: number } {
  const limite = agora.getTime() - SENHA_JANELA_MS;
  const recentes = errosRecentes
    .map((e) => new Date(e.em).getTime())
    .filter((t) => Number.isFinite(t) && t >= limite)
    .sort((a, b) => a - b);
  if (recentes.length < SENHA_MAX_TENTATIVAS) {
    return { bloqueado: false, faltamMs: 0, tentativas: recentes.length };
  }
  // A janela solta quando o erro mais ANTIGO do lote sai dela.
  const solta = recentes[recentes.length - SENHA_MAX_TENTATIVAS] + SENHA_JANELA_MS;
  return { bloqueado: true, faltamMs: Math.max(0, solta - agora.getTime()), tentativas: recentes.length };
}

export function minutosArredondados(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

// ── Token da sessão de estorno (a senha da entrada vale 15 min) ─────────────

export const SESSAO_ESTORNO_MIN = 15;

/**
 * A senha da ENTRADA vira um bilhete curto assinado — as telas de leitura
 * mandam ele em vez de guardar senha em memória de navegador. Cada operação
 * de dinheiro pede a senha DE NOVO (ordem do dono); o bilhete só abre a porta.
 */
export function assinarSessaoEstorno(
  payload: { userId: string; nivel: string; expEm: number },
  segredo: string,
  hmac: (segredo: string, texto: string) => string,
): string {
  const corpo = `${payload.userId}.${payload.nivel}.${payload.expEm}`;
  return `${Buffer.from(corpo).toString('base64url')}.${hmac(segredo, corpo)}`;
}

export function lerSessaoEstorno(
  token: string | undefined,
  segredo: string,
  hmac: (segredo: string, texto: string) => string,
  agora: number = Date.now(),
): { userId: string; nivel: string } | null {
  const t = String(token || '').trim();
  if (!t || t.length > 400) return null;
  const [b64, assinatura] = t.split('.');
  if (!b64 || !assinatura) return null;
  let corpo = '';
  try {
    corpo = Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (hmac(segredo, corpo) !== assinatura) return null;
  const [userId, nivel, expTxt] = corpo.split('.');
  const exp = Number(expTxt);
  if (!userId || !nivel || !Number.isFinite(exp) || exp <= agora) return null;
  return { userId, nivel };
}

// ── Máscaras pro comprovante (o PDF vai pra cliente) ────────────────────────

/** 123.456.789-09 → ***.456.789-** (o suficiente pra ela reconhecer). */
export function mascararCpf(cpf: string | null | undefined): string {
  const d = String(cpf || '').replace(/\D/g, '');
  if (d.length !== 11) return '—';
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

/** maria@gmail.com → ma***@gmail.com */
export function mascararEmail(email: string | null | undefined): string {
  const e = String(email || '').trim();
  const at = e.indexOf('@');
  if (at < 1) return '—';
  const nome = e.slice(0, at);
  return `${nome.slice(0, 2)}${'*'.repeat(Math.max(1, Math.min(6, nome.length - 2)))}${e.slice(at)}`;
}

/** O que o comprovante pode dizer — nunca "devolvido" com o gateway pendente. */
export function fraseDoComprovante(status: StatusEstorno): { titulo: string; podeEmitir: boolean } {
  if (status === 'processado') return { titulo: 'ESTORNO PROCESSADO', podeEmitir: true };
  if (status === 'processando' || status === 'enviado') {
    return { titulo: 'ESTORNO EM PROCESSAMENTO', podeEmitir: true };
  }
  return { titulo: 'ESTORNO NÃO CONCLUÍDO', podeEmitir: false };
}
