/**
 * CONCILIAÇÃO DE CARTÕES — vendas no cartão do PDV × transações da maquininha
 * Stone (16/09/2026). Função pura: o service monta as duas listas; aqui só se
 * casa e se classifica. É a régua que o spec tranca.
 *
 * O PDV não grava NSU (a vendedora só escolhe crédito/débito, bandeira e
 * parcelas), então o par sai por VALOR + HORÁRIO + operação + bandeira +
 * parcelas. A Stone manda o horário da captura com segundos, e a vendedora
 * registra o pagamento logo antes ou logo depois de passar o cartão.
 *
 * O que é DIVERGÊNCIA (a matriz precisa olhar):
 *  - venda no cartão no sistema sem transação na Stone;
 *  - transação na Stone sem venda no cartão no sistema (dinheiro entrou e a
 *    venda não foi lançada — ou foi lançada como dinheiro/PIX);
 *  - mesmo horário com valor diferente;
 *  - venda ativa no sistema com a transação ESTORNADA na maquininha;
 *  - venda estornada no sistema com a transação ainda ATIVA na maquininha.
 * O que é ATENÇÃO: crédito × débito trocado, parcelas diferentes, horários
 * muito distantes. Bandeira diferente não pesa: o PDV grava a lista antiga do
 * Wincred (VISANET, REDESHOP…) e a vendedora escolhe no olho.
 */

export type TipoCartao = 'credito' | 'debito';

export interface PagamentoSistema {
  /** id do pagamento (pdv_sale_payments.id) */
  id: string;
  vendaId: string;
  /** os 8 últimos do id da venda, como sai no cupom */
  venda: string;
  valor: number;
  tipo: TipoCartao;
  bandeira: string | null;
  parcelas: number | null;
  /** instante em que o pagamento foi registrado */
  momento: Date;
  vendaCancelada: boolean;
  vendedora: string | null;
  cliente: string | null;
  /** false = pode casar, mas a falta não é divergência (link pago na maquininha) */
  obrigatorio?: boolean;
}

export interface TransacaoMaquininha {
  /** stone_transactions.id */
  id: string;
  nsu: string;
  valorCapturado: number;
  valorCancelado: number;
  tipo: TipoCartao | 'voucher' | 'outro';
  bandeira: string | null;
  parcelas: number | null;
  momento: Date;
  finalCartao: string | null;
  autorizacao: string | null;
  terminal: string | null;
}

export type Situacao =
  | 'confere'
  | 'confere_com_nota'
  | 'sem_transacao'
  | 'sem_venda'
  | 'valor_diferente'
  | 'estornada_na_maquininha'
  | 'estornada_so_no_sistema'
  | 'estornada_nos_dois'
  | 'cancelada_na_maquininha';

export type Peso = 'ok' | 'atencao' | 'divergencia' | 'neutro';

export const PESO: Record<Situacao, Peso> = {
  confere: 'ok',
  confere_com_nota: 'atencao',
  sem_transacao: 'divergencia',
  sem_venda: 'divergencia',
  valor_diferente: 'divergencia',
  estornada_na_maquininha: 'divergencia',
  estornada_so_no_sistema: 'divergencia',
  estornada_nos_dois: 'neutro',
  cancelada_na_maquininha: 'neutro',
};

export interface Linha {
  situacao: Situacao;
  pagamentoId: string | null;
  transacaoId: string | null;
  valorSistema: number | null;
  valorMaquininha: number | null;
  /** o que muda no caixa: sistema − maquininha (positivo = o sistema conta mais do que entrou) */
  diferenca: number;
  notas: string[];
}

export interface Resultado {
  status: 'confere' | 'atencao' | 'divergente' | 'sem_movimento';
  linhas: Linha[];
  totais: {
    sistema: { qtd: number; valor: number };
    maquininha: { qtd: number; valor: number };
    /** soma das diferenças das linhas de divergência (em módulo) */
    valorDivergente: number;
  };
  contagem: { confere: number; atencao: number; divergencia: number; semTransacao: number; semVenda: number };
}

const CENTAVO = 0.005;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function reais(v: number | null | undefined): string {
  if (v == null) return '—';
  return `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** O PDV grava a lista antiga do Wincred; a Stone manda a bandeira de verdade. */
export function familiaBandeira(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!t) return null;
  if (t.includes('VISA') || t === 'ELECTRON') return 'VISA';
  if (t.includes('MASTER') || t.includes('MAESTRO') || t.includes('REDESHOP') || t.includes('CREDICARD')) return 'MASTER';
  if (t.startsWith('ELO')) return 'ELO';
  if (t.includes('AMEX') || t.includes('AMERICAN')) return 'AMEX';
  if (t.includes('HIPER')) return 'HIPER';
  return t;
}

const minutos = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 60_000;

const ativaNaMaquininha = (t: TransacaoMaquininha) => t.valorCapturado - t.valorCancelado > CENTAVO;

function pontuar(p: PagamentoSistema, t: TransacaoMaquininha): number {
  let pts = 100;
  const d = minutos(p.momento, t.momento);
  if (d <= 3) pts += 30;
  else if (d <= 15) pts += 20;
  else if (d <= 60) pts += 10;
  else if (d <= 180) pts += 2;
  else pts -= 20;
  if (t.tipo === 'credito' || t.tipo === 'debito') pts += p.tipo === t.tipo ? 15 : -10;
  const bp = familiaBandeira(p.bandeira);
  const bt = familiaBandeira(t.bandeira);
  if (bp && bt) pts += bp === bt ? 8 : -3;
  if (p.parcelas != null && t.parcelas != null) pts += p.parcelas === t.parcelas ? 5 : -5;
  // venda estornada tende a casar com transação estornada, e ativa com ativa
  pts += p.vendaCancelada === !ativaNaMaquininha(t) ? 10 : -5;
  if (p.obrigatorio !== false) pts += 1;
  return pts;
}

const horaBr = (d: Date) => new Date(d.getTime() - 3 * 60 * 60_000).toISOString().slice(11, 16);

function classificarPar(p: PagamentoSistema, t: TransacaoMaquininha): Linha {
  const liquido = r2(t.valorCapturado - t.valorCancelado);
  const notas: string[] = [];
  let situacao: Situacao;
  let diferenca = 0;

  if (p.vendaCancelada && !ativaNaMaquininha(t)) {
    situacao = 'estornada_nos_dois';
  } else if (p.vendaCancelada) {
    situacao = 'estornada_so_no_sistema';
    diferenca = r2(-liquido);
    notas.push(`a venda foi estornada no sistema, mas a transação de ${reais(liquido)} continua valendo na maquininha — devolveram o dinheiro à cliente?`);
  } else if (!ativaNaMaquininha(t)) {
    situacao = 'estornada_na_maquininha';
    diferenca = r2(p.valor);
    notas.push(`a transação foi cancelada na maquininha, mas a venda de ${reais(p.valor)} continua valendo no sistema`);
  } else if (Math.abs(liquido - p.valor) >= CENTAVO) {
    situacao = 'valor_diferente';
    diferenca = r2(p.valor - liquido);
    notas.push(
      t.valorCancelado > CENTAVO
        ? `cancelamento parcial na maquininha: sistema ${reais(p.valor)} · maquininha ${reais(liquido)} (capturou ${reais(t.valorCapturado)})`
        : `valor diferente: sistema ${reais(p.valor)} · maquininha ${reais(liquido)}`,
    );
  } else {
    situacao = 'confere';
  }

  if (situacao === 'confere' || situacao === 'valor_diferente') {
    if ((t.tipo === 'credito' || t.tipo === 'debito') && t.tipo !== p.tipo) {
      notas.push(`no sistema está ${p.tipo === 'debito' ? 'DÉBITO' : 'CRÉDITO'}, na maquininha foi ${t.tipo === 'debito' ? 'DÉBITO' : 'CRÉDITO'}`);
    }
    if (p.parcelas != null && t.parcelas != null && p.parcelas !== t.parcelas) {
      notas.push(`parcelas: sistema ${p.parcelas}x · maquininha ${t.parcelas}x`);
    }
    const d = minutos(p.momento, t.momento);
    if (d > 180) notas.push(`horários distantes: sistema ${horaBr(p.momento)} · maquininha ${horaBr(t.momento)}`);
    if (situacao === 'confere' && notas.length) situacao = 'confere_com_nota';
  }

  return {
    situacao,
    pagamentoId: p.id,
    transacaoId: t.id,
    valorSistema: p.valor,
    valorMaquininha: liquido,
    diferenca,
    notas,
  };
}

export function conciliarCartoes(pagamentos: PagamentoSistema[], transacoes: TransacaoMaquininha[]): Resultado {
  const linhas: Linha[] = [];
  const pLivre = pagamentos.map(() => true);
  const tLivre = transacoes.map(() => true);

  // 1) mesmo valor capturado — o par mais provável primeiro
  const pares: { pi: number; ti: number; pts: number; d: number }[] = [];
  pagamentos.forEach((p, pi) => {
    transacoes.forEach((t, ti) => {
      if (t.tipo === 'voucher' || t.tipo === 'outro') return;
      if (Math.abs(t.valorCapturado - p.valor) >= CENTAVO) return;
      pares.push({ pi, ti, pts: pontuar(p, t), d: minutos(p.momento, t.momento) });
    });
  });
  pares.sort((a, b) => b.pts - a.pts || a.d - b.d);
  for (const par of pares) {
    if (!pLivre[par.pi] || !tLivre[par.ti]) continue;
    pLivre[par.pi] = false;
    tLivre[par.ti] = false;
    linhas.push(classificarPar(pagamentos[par.pi], transacoes[par.ti]));
  }

  // 2) quase-par: venda e transação ativas no mesmo horário (±5 min), valor diferente
  const quase: { pi: number; ti: number; d: number }[] = [];
  pagamentos.forEach((p, pi) => {
    if (!pLivre[pi] || p.vendaCancelada || p.obrigatorio === false) return;
    transacoes.forEach((t, ti) => {
      if (!tLivre[ti] || !ativaNaMaquininha(t)) return;
      const d = minutos(p.momento, t.momento);
      if (d <= 5) quase.push({ pi, ti, d });
    });
  });
  quase.sort((a, b) => a.d - b.d);
  for (const q of quase) {
    if (!pLivre[q.pi] || !tLivre[q.ti]) continue;
    pLivre[q.pi] = false;
    tLivre[q.ti] = false;
    const p = pagamentos[q.pi];
    const t = transacoes[q.ti];
    const liquido = r2(t.valorCapturado - t.valorCancelado);
    linhas.push({
      situacao: 'valor_diferente',
      pagamentoId: p.id,
      transacaoId: t.id,
      valorSistema: p.valor,
      valorMaquininha: liquido,
      diferenca: r2(p.valor - liquido),
      notas: [`mesmo horário, valores diferentes: sistema ${reais(p.valor)} · maquininha ${reais(liquido)}`],
    });
  }

  // 3) sobras
  pagamentos.forEach((p, pi) => {
    if (!pLivre[pi] || p.vendaCancelada || p.obrigatorio === false) return;
    linhas.push({
      situacao: 'sem_transacao',
      pagamentoId: p.id,
      transacaoId: null,
      valorSistema: p.valor,
      valorMaquininha: null,
      diferenca: r2(p.valor),
      notas: [
        `venda no ${p.tipo === 'debito' ? 'débito' : 'crédito'} de ${reais(p.valor)} sem transação na maquininha Stone desta loja — passou em outra maquininha, ou a forma de pagamento está errada?`,
      ],
    });
  });
  transacoes.forEach((t, ti) => {
    if (!tLivre[ti]) return;
    const liquido = r2(t.valorCapturado - t.valorCancelado);
    if (!ativaNaMaquininha(t)) {
      linhas.push({
        situacao: 'cancelada_na_maquininha',
        pagamentoId: null,
        transacaoId: t.id,
        valorSistema: null,
        valorMaquininha: 0,
        diferenca: 0,
        notas: [`passada e cancelada na maquininha (${reais(t.valorCapturado)}) — não pesa no caixa`],
      });
      return;
    }
    linhas.push({
      situacao: 'sem_venda',
      pagamentoId: null,
      transacaoId: t.id,
      valorSistema: null,
      valorMaquininha: liquido,
      diferenca: r2(-liquido),
      notas: [
        t.tipo === 'voucher' || t.tipo === 'outro'
          ? `transação de ${reais(liquido)} (${t.tipo}) na maquininha sem venda no sistema`
          : `${reais(liquido)} no ${t.tipo === 'debito' ? 'débito' : 'crédito'} entrou na maquininha e não há venda no cartão com esse valor no sistema — venda não lançada, ou lançada como dinheiro/PIX?`,
      ],
    });
  });

  return fechar(linhas, pagamentos, transacoes);
}

function fechar(linhas: Linha[], pagamentos: PagamentoSistema[], transacoes: TransacaoMaquininha[]): Resultado {
  const contagem = { confere: 0, atencao: 0, divergencia: 0, semTransacao: 0, semVenda: 0 };
  let valorDivergente = 0;
  for (const l of linhas) {
    const peso = PESO[l.situacao];
    if (peso === 'ok') contagem.confere++;
    else if (peso === 'atencao') contagem.atencao++;
    else if (peso === 'divergencia') {
      contagem.divergencia++;
      valorDivergente += Math.abs(l.diferenca);
    }
    if (l.situacao === 'sem_transacao') contagem.semTransacao++;
    if (l.situacao === 'sem_venda') contagem.semVenda++;
  }
  const ativosSistema = pagamentos.filter((p) => !p.vendaCancelada && p.obrigatorio !== false);
  const ativasMaquininha = transacoes.filter(ativaNaMaquininha);
  const totais = {
    sistema: { qtd: ativosSistema.length, valor: r2(ativosSistema.reduce((s, p) => s + p.valor, 0)) },
    maquininha: {
      qtd: ativasMaquininha.length,
      valor: r2(ativasMaquininha.reduce((s, t) => s + t.valorCapturado - t.valorCancelado, 0)),
    },
    valorDivergente: r2(valorDivergente),
  };
  let status: Resultado['status'];
  if (!ativosSistema.length && !transacoes.length && !linhas.length) status = 'sem_movimento';
  else if (contagem.divergencia > 0) status = 'divergente';
  else if (contagem.atencao > 0) status = 'atencao';
  else status = 'confere';

  const ordem: Record<Peso, number> = { divergencia: 0, atencao: 1, ok: 2, neutro: 3 };
  linhas.sort((a, b) => ordem[PESO[a.situacao]] - ordem[PESO[b.situacao]]);
  return { status, linhas, totais, contagem };
}

/** Frases curtas pro checklist e pro WhatsApp. */
export function frasesDaConciliacao(r: Resultado | null | undefined, max = 4): string[] {
  if (!r) return [];
  const soma = (sit: Situacao) => {
    const ls = r.linhas.filter((l) => l.situacao === sit);
    return { n: ls.length, valor: r2(ls.reduce((s, l) => s + Math.abs(l.diferenca), 0)) };
  };
  const out: string[] = [];
  const add = (n: number, um: string, varios: string, valor?: number) => {
    if (n && out.length < max) out.push(`${n} ${n === 1 ? um : varios}${valor != null ? ` (${reais(valor)})` : ''}`);
  };
  const st = soma('sem_transacao');
  add(st.n, 'venda no cartão sem transação na Stone', 'vendas no cartão sem transação na Stone', st.valor);
  const sv = soma('sem_venda');
  add(sv.n, 'transação na Stone sem venda no sistema', 'transações na Stone sem venda no sistema', sv.valor);
  const vd = soma('valor_diferente');
  add(vd.n, 'valor diferente', 'valores diferentes', vd.valor);
  const em = soma('estornada_na_maquininha');
  add(em.n, 'venda ativa com estorno na maquininha', 'vendas ativas com estorno na maquininha', em.valor);
  const es = soma('estornada_so_no_sistema');
  add(es.n, 'venda estornada só no sistema', 'vendas estornadas só no sistema', es.valor);
  const cn = soma('confere_com_nota');
  add(cn.n, 'venda com crédito×débito ou parcelas trocados', 'vendas com crédito×débito ou parcelas trocados');
  return out;
}
