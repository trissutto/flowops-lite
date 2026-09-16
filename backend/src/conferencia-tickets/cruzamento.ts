/**
 * CRUZAMENTO dos tickets fotografados com o que o Flow gravou (16/09/2026).
 *
 * Função pura: recebe o que o sistema espera encontrar em papel (`Esperado`) e
 * o que a IA leu nas fotos (`TicketEntrada`) e devolve a conferência linha a
 * linha. Sem banco e sem IA aqui dentro — é a régua que o spec tranca.
 *
 * O que cada papel prova, e por isso o que se cobra dele:
 *
 *  - CARTÃO: todo pagamento em crédito/débito tem que ter o ticket da
 *    maquininha com o MESMO valor. O PDV não grava NSU (só bandeira e
 *    parcelas), então o par sai por valor + horário + operação + bandeira.
 *  - CUPOM: venda paga 100% em dinheiro ou 100% em PIX imprime o cupom sozinha
 *    (2 vias), com "Venda #" + os 8 ÚLTIMOS caracteres do id — ele tem que
 *    aparecer. Venda com cartão ou mista não imprime sozinha: o cupom dela é
 *    aceito, mas a falta não é divergência (alarme falso mata a conferência).
 *  - PIX: o PIX confirmado pelo banco (gateway) já está provado. O PIX marcado
 *    como pago sem confirmação (`pixExterno`) precisa do comprovante.
 *  - CREDIÁRIO: todo recebimento pago imprime o recibo com "Baixa #" + os 8
 *    PRIMEIROS caracteres do id — ele tem que aparecer com o mesmo total.
 *
 * Crédito × débito trocado, parcelas diferentes e data impressa diferente não
 * derrubam o par: viram ATENÇÃO. Valor diferente, forma de pagamento diferente
 * do cupom, ticket sem registro e registro sem ticket são DIVERGÊNCIA.
 */

export type Grupo = 'cartao' | 'cupons' | 'pix' | 'crediario' | 'outros';

export type TipoEsperado = 'cartao' | 'cupom' | 'pix' | 'crediario';

export interface Esperado {
  /** 'cartao:<paymentId>' | 'cupom:<saleId>' | 'pix:<paymentId>' | 'crediario:<baixaId>' */
  chave: string;
  tipo: TipoEsperado;
  /** false = aceita um ticket, mas a falta dele não vira divergência */
  obrigatorio: boolean;
  valor: number;
  /** minutos desde 00:00 de Brasília; null quando o horário não é conhecido */
  minuto: number | null;
  operacao?: 'credito' | 'debito' | null;
  bandeira?: string | null;
  parcelas?: number | null;
  /** os 8 caracteres impressos depois do "#" (cupom e recibo) */
  numero?: string | null;
  /** formas de pagamento que o sistema tem HOJE pra esse documento */
  formas?: string[];
  nsu?: string | null;
  cliente?: string | null;
  cancelada?: boolean;
  pixExterno?: boolean;
  /** o que a tela mostra: "Venda #1A2B3C4D · 14:32 · Maria" */
  titulo: string;
  ref?: { saleId?: string; paymentId?: string; baixaId?: string };
}

export type OrigemTicket = 'maquininha' | 'cupom_venda' | 'recibo_crediario' | 'comprovante_pix' | 'outro';

export type OperacaoTicket =
  | 'credito'
  | 'debito'
  | 'pix'
  | 'voucher'
  | 'dinheiro'
  | 'crediario'
  | 'estorno'
  | 'misto'
  | 'desconhecida';

export interface TicketEntrada {
  id: string;
  fotoId: string;
  origem: OrigemTicket;
  operacao: OperacaoTicket;
  valor: number | null;
  /** 'YYYY-MM-DD' */
  data: string | null;
  /** 'HH:MM' */
  hora: string | null;
  nsu: string | null;
  autorizacao?: string | null;
  finalCartao?: string | null;
  bandeira: string | null;
  parcelas: number | null;
  numero: string | null;
  formas: string[];
  cliente: string | null;
  legivel: boolean;
  confianca: 'alta' | 'media' | 'baixa';
}

export type Situacao =
  | 'confere'
  | 'confere_com_nota'
  | 'sem_ticket'
  | 'sem_registro'
  | 'valor_diferente'
  | 'forma_diferente'
  | 'ilegivel'
  | 'fora_do_dia'
  | 'estorno'
  | 'duplicado'
  | 'outro';

export type Peso = 'ok' | 'atencao' | 'divergencia' | 'neutro';

export const PESO: Record<Situacao, Peso> = {
  confere: 'ok',
  confere_com_nota: 'atencao',
  sem_ticket: 'divergencia',
  sem_registro: 'divergencia',
  valor_diferente: 'divergencia',
  forma_diferente: 'divergencia',
  ilegivel: 'atencao',
  fora_do_dia: 'atencao',
  estorno: 'atencao',
  duplicado: 'neutro',
  outro: 'neutro',
};

export interface Linha {
  situacao: Situacao;
  grupo: Grupo;
  /** chave do Esperado casado (ou sem ticket) */
  esperado: string | null;
  titulo: string;
  ticketId: string | null;
  fotoId: string | null;
  valorSistema: number | null;
  valorTicket: number | null;
  notas: string[];
}

export interface TotalGrupo {
  /** soma do que o sistema cobra em papel (obrigatórios + aceitos que casaram) */
  sistema: number;
  /** soma dos tickets legíveis do grupo (sem duplicados nem de outro dia) */
  tickets: number;
  esperados: number;
  comTicket: number;
  ticketsLidos: number;
}

export interface Resultado {
  status: 'confere' | 'atencao' | 'divergente' | 'sem_movimento';
  linhas: Linha[];
  totais: Record<Grupo, TotalGrupo>;
  contagem: {
    confere: number;
    atencao: number;
    divergencia: number;
    semTicket: number;
    semRegistro: number;
    ilegiveis: number;
  };
}

// ───────────────────────── normalizações ─────────────────────────

const CENTAVO = 0.005;

export function mesmoValor(a: number | null | undefined, b: number | null | undefined): boolean {
  return a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < CENTAVO;
}

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Bandeira comparável. O PDV grava os nomes da lista antiga do Wincred
 * (VISANET, VISA ELECTRON, REDESHOP…) e a maquininha imprime VISA, MAESTRO,
 * MASTERCARD… — as duas pontas caem na mesma família.
 */
export function normalizarBandeira(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = semAcento(String(s)).toUpperCase().replace(/[^A-Z]/g, '');
  if (!t) return null;
  if (t.includes('VISA') || t === 'ELECTRON') return 'VISA';
  if (t.includes('MASTER') || t.includes('MAESTRO') || t.includes('REDESHOP')) return 'MASTER';
  if (t.startsWith('ELO')) return 'ELO';
  if (t.includes('AMEX') || t.includes('AMERICAN')) return 'AMEX';
  if (t.includes('HIPER')) return 'HIPER';
  return t;
}

/**
 * Os 8 caracteres do "#" do cupom/recibo. A IA pode devolver o texto inteiro
 * ("Venda #1A2B3C4D") — e "Venda"/"Baixa" têm letras que também são
 * hexadecimais, por isso a leitura procura o código depois do "#" antes de
 * cair no fim da string.
 */
export function normalizarNumero(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = String(s).toLowerCase();
  const aposHash = t.match(/#\s*([0-9a-f]{8})(?![0-9a-f])/);
  if (aposHash) return aposHash[1];
  const solto = t.match(/(?:^|[^0-9a-z])([0-9a-f]{8})(?![0-9a-z])/);
  if (solto) return solto[1];
  const hex = t.replace(/[^0-9a-f]/g, '');
  return hex.length >= 8 ? hex.slice(-8) : null;
}

/** Forma de pagamento comparável (cupom × sistema). */
export function normalizarForma(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = semAcento(String(s)).toLowerCase();
  if (t.includes('dinheiro') || t.includes('especie') || t.includes('cash')) return 'dinheiro';
  if (t.includes('pix')) return 'pix';
  if (t.includes('credito') && !t.includes('crediario')) return 'credito';
  if (t.includes('debito')) return 'debito';
  if (t.includes('crediario') || t.includes('carne')) return 'crediario';
  if (t.includes('vale') || t.includes('troca')) return 'vale';
  if (t.includes('online')) return 'online';
  if (t.includes('misto')) return 'misto';
  if (t.includes('cartao')) return 'cartao';
  return t.trim() || null;
}

function formasIguais(sistema: string[], ticket: string[]): boolean {
  const a = new Set(sistema.map(normalizarForma).filter(Boolean) as string[]);
  const b = new Set(ticket.map(normalizarForma).filter(Boolean) as string[]);
  // "misto" do recibo de crediário = dinheiro + pix
  for (const set of [a, b]) {
    if (set.has('misto')) {
      set.delete('misto');
      set.add('dinheiro');
      set.add('pix');
    }
  }
  // "cartão" sem dizer qual casa com crédito ou débito
  const cartaoGenerico = (x: Set<string>, y: Set<string>) =>
    x.has('cartao') && (y.has('credito') || y.has('debito'));
  if (cartaoGenerico(a, b) || cartaoGenerico(b, a)) {
    for (const set of [a, b]) {
      set.delete('cartao');
      set.delete('credito');
      set.delete('debito');
    }
  }
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function minutoDaHora(hora: string | null | undefined): number | null {
  if (!hora) return null;
  const m = String(hora).match(/^(\d{1,2})[:h](\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function nomesParecidos(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const pa = semAcento(a).toUpperCase().split(/\s+/).filter((p) => p.length > 2);
  const pb = new Set(semAcento(b).toUpperCase().split(/\s+/).filter((p) => p.length > 2));
  return pa.length > 0 && pb.has(pa[0]);
}

const fmtReal = (v: number | null | undefined) =>
  v == null ? '—' : `R$ ${v.toFixed(2).replace('.', ',')}`;

const fmtMinuto = (m: number | null) =>
  m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// ───────────────────────── classificação ─────────────────────────

export function grupoDoTicket(t: Pick<TicketEntrada, 'origem' | 'operacao'>): Grupo {
  if (t.operacao === 'estorno') return 'outros';
  switch (t.origem) {
    case 'maquininha':
      return t.operacao === 'pix' ? 'pix' : 'cartao';
    case 'comprovante_pix':
      return 'pix';
    case 'cupom_venda':
      return 'cupons';
    case 'recibo_crediario':
      return 'crediario';
    default:
      return 'outros';
  }
}

const GRUPO_DO_TIPO: Record<TipoEsperado, Grupo> = {
  cartao: 'cartao',
  cupom: 'cupons',
  pix: 'pix',
  crediario: 'crediario',
};

function compativel(e: Esperado, t: TicketEntrada): boolean {
  switch (e.tipo) {
    case 'cartao':
      return t.origem === 'maquininha' && t.operacao !== 'pix' && t.operacao !== 'dinheiro';
    case 'pix':
      return (t.origem === 'maquininha' && t.operacao === 'pix') || t.origem === 'comprovante_pix';
    case 'cupom':
      return t.origem === 'cupom_venda';
    case 'crediario':
      return t.origem === 'recibo_crediario';
  }
}

/** Mesmo papel lido duas vezes (2ª via, ou a mesma foto tirada de novo). */
function chaveDuplicata(t: TicketEntrada): string | null {
  const v = t.valor == null ? '' : t.valor.toFixed(2);
  const num = normalizarNumero(t.numero);
  if ((t.origem === 'cupom_venda' || t.origem === 'recibo_crediario') && num) return `${t.origem}|${num}`;
  if (t.origem === 'maquininha' || t.origem === 'comprovante_pix') {
    const nsu = t.nsu ? String(t.nsu).replace(/\D/g, '').replace(/^0+/, '') : '';
    if (nsu) return `${t.origem}|nsu|${nsu}|${v}`;
    const aut = t.autorizacao ? String(t.autorizacao).trim().toUpperCase() : '';
    // Sem NSU só dá pra afirmar que é o MESMO papel com autorização + hora:
    // duas vendas de mesmo valor no mesmo minuto existem.
    if (aut && t.hora) return `${t.origem}|aut|${aut}|${t.hora}|${v}`;
  }
  return null;
}

function pontuar(e: Esperado, t: TicketEntrada, dia: string): number {
  let p = 100;
  const tm = minutoDaHora(t.hora);
  if (e.minuto != null && tm != null) {
    const d = Math.abs(e.minuto - tm);
    if (d <= 3) p += 25;
    else if (d <= 15) p += 18;
    else if (d <= 60) p += 10;
    else if (d <= 180) p += 2;
    else p -= 15;
  }
  if (t.data && t.data !== dia) p -= 20;
  if (e.tipo === 'cartao') {
    if (e.nsu && t.nsu) {
      const a = String(e.nsu).replace(/\D/g, '').replace(/^0+/, '');
      const b = String(t.nsu).replace(/\D/g, '').replace(/^0+/, '');
      if (a && a === b) p += 40;
    }
    if (e.operacao && (t.operacao === 'credito' || t.operacao === 'debito')) {
      p += e.operacao === t.operacao ? 15 : -10;
    }
    const be = normalizarBandeira(e.bandeira);
    const bt = normalizarBandeira(t.bandeira);
    if (be && bt) p += be === bt ? 8 : -3;
    if (e.parcelas != null && t.parcelas != null) p += e.parcelas === t.parcelas ? 5 : -5;
  }
  if (e.tipo === 'crediario' && nomesParecidos(e.cliente, t.cliente)) p += 10;
  if (e.tipo === 'cupom' && t.numero) p -= 10; // número impresso que não bateu: par mais fraco
  if (t.confianca === 'baixa') p -= 5;
  if (e.cancelada) p -= 5;
  return p;
}

// ───────────────────────── o cruzamento ─────────────────────────

export function cruzar(esperados: Esperado[], tickets: TicketEntrada[], dia: string): Resultado {
  const linhas: Linha[] = [];
  const esperadoLivre = esperados.map(() => true);
  const validos: TicketEntrada[] = [];
  const vistos = new Set<string>();

  const linhaDoTicket = (situacao: Situacao, t: TicketEntrada, notas: string[], grupo = grupoDoTicket(t)): Linha => ({
    situacao,
    grupo,
    esperado: null,
    titulo: tituloDoTicket(t),
    ticketId: t.id,
    fotoId: t.fotoId,
    valorSistema: null,
    valorTicket: t.valor,
    notas,
  });

  // 1) triagem: o que não entra no cruzamento
  for (const t of tickets) {
    if (t.origem === 'outro') {
      linhas.push(linhaDoTicket('outro', t, ['papel que não é ticket de venda nem de recebimento']));
      continue;
    }
    if (!t.legivel || t.valor == null || !(t.valor > 0)) {
      linhas.push(linhaDoTicket('ilegivel', t, ['valor ilegível — tire outra foto deste ticket']));
      continue;
    }
    if (t.operacao === 'estorno') {
      linhas.push(
        linhaDoTicket('estorno', t, ['estorno na maquininha — confira se a venda foi cancelada no sistema']),
      );
      continue;
    }
    const dup = chaveDuplicata(t);
    if (dup && vistos.has(dup)) {
      linhas.push(linhaDoTicket('duplicado', t, ['o mesmo ticket já apareceu em outra foto (ou é a 2ª via)']));
      continue;
    }
    if (dup) vistos.add(dup);
    validos.push(t);
  }
  const ticketLivre = validos.map(() => true);

  const casar = (ei: number, ti: number) => {
    esperadoLivre[ei] = false;
    ticketLivre[ti] = false;
    linhas.push(compararPar(esperados[ei], validos[ti], dia));
  };

  // 2) pelo número impresso (cupom e recibo) — o par mais forte que existe
  for (let ti = 0; ti < validos.length; ti++) {
    const t = validos[ti];
    const num = normalizarNumero(t.numero);
    if (!num) continue;
    const tipo: TipoEsperado | null =
      t.origem === 'cupom_venda' ? 'cupom' : t.origem === 'recibo_crediario' ? 'crediario' : null;
    if (!tipo) continue;
    const ei = esperados.findIndex(
      (e, i) => esperadoLivre[i] && e.tipo === tipo && normalizarNumero(e.numero) === num,
    );
    if (ei >= 0) casar(ei, ti);
  }

  // 3) mesmo valor, o par mais provável primeiro (guloso por pontuação)
  const pares: { ei: number; ti: number; p: number; dt: number }[] = [];
  for (let ei = 0; ei < esperados.length; ei++) {
    if (!esperadoLivre[ei]) continue;
    const e = esperados[ei];
    for (let ti = 0; ti < validos.length; ti++) {
      if (!ticketLivre[ti]) continue;
      const t = validos[ti];
      if (!compativel(e, t) || !mesmoValor(e.valor, t.valor)) continue;
      const tm = minutoDaHora(t.hora);
      const dt = e.minuto != null && tm != null ? Math.abs(e.minuto - tm) : 9999;
      pares.push({ ei, ti, p: pontuar(e, t, dia) + (e.obrigatorio ? 1 : 0), dt });
    }
  }
  pares.sort((a, b) => b.p - a.p || a.dt - b.dt);
  for (const par of pares) {
    if (esperadoLivre[par.ei] && ticketLivre[par.ti]) casar(par.ei, par.ti);
  }

  // 4) quase-par: mesmo tipo, mesmo horário (±5 min), valor diferente
  const quase: { ei: number; ti: number; dt: number }[] = [];
  for (let ei = 0; ei < esperados.length; ei++) {
    const e = esperados[ei];
    if (!esperadoLivre[ei] || !e.obrigatorio || e.minuto == null) continue;
    for (let ti = 0; ti < validos.length; ti++) {
      if (!ticketLivre[ti]) continue;
      const t = validos[ti];
      const tm = minutoDaHora(t.hora);
      if (tm == null || !compativel(e, t)) continue;
      if (t.data && t.data !== dia) continue;
      const dt = Math.abs(e.minuto - tm);
      if (dt <= 5) quase.push({ ei, ti, dt });
    }
  }
  quase.sort((a, b) => a.dt - b.dt);
  for (const q of quase) {
    if (!esperadoLivre[q.ei] || !ticketLivre[q.ti]) continue;
    esperadoLivre[q.ei] = false;
    ticketLivre[q.ti] = false;
    const e = esperados[q.ei];
    const t = validos[q.ti];
    linhas.push({
      situacao: 'valor_diferente',
      grupo: GRUPO_DO_TIPO[e.tipo],
      esperado: e.chave,
      titulo: e.titulo,
      ticketId: t.id,
      fotoId: t.fotoId,
      valorSistema: e.valor,
      valorTicket: t.valor,
      notas: [`mesmo horário, valores diferentes: sistema ${fmtReal(e.valor)} · ticket ${fmtReal(t.valor)}`],
    });
  }

  // 5) sobras
  esperados.forEach((e, ei) => {
    if (!esperadoLivre[ei] || !e.obrigatorio) return;
    linhas.push({
      situacao: 'sem_ticket',
      grupo: GRUPO_DO_TIPO[e.tipo],
      esperado: e.chave,
      titulo: e.titulo,
      ticketId: null,
      fotoId: null,
      valorSistema: e.valor,
      valorTicket: null,
      notas: [NOTA_SEM_TICKET[e.tipo](e)],
    });
  });
  validos.forEach((t, ti) => {
    if (!ticketLivre[ti]) return;
    if (t.data && t.data !== dia) {
      linhas.push(linhaDoTicket('fora_do_dia', t, [`ticket de ${dataBr(t.data)} — não é do movimento conferido`]));
      return;
    }
    linhas.push(linhaDoTicket('sem_registro', t, [NOTA_SEM_REGISTRO[grupoDoTicket(t)]]));
  });

  return fechar(linhas, esperados);
}

const NOTA_SEM_TICKET: Record<TipoEsperado, (e: Esperado) => string> = {
  cartao: (e) =>
    `venda no ${e.operacao === 'debito' ? 'débito' : e.operacao === 'credito' ? 'crédito' : 'cartão'} sem o ticket da maquininha`,
  cupom: (e) =>
    `venda em ${(e.formas || []).includes('pix') ? 'PIX' : 'dinheiro'} sem o cupom (ele imprime sozinho, 2 vias)`,
  pix: () => 'PIX marcado como pago sem confirmação do banco — falta o comprovante',
  crediario: () => 'recebimento de crediário sem o recibo',
};

const NOTA_SEM_REGISTRO: Record<Grupo, string> = {
  cartao: 'ticket da maquininha sem venda no cartão com esse valor no sistema (venda não lançada, ou lançada em outra forma?)',
  cupons: 'cupom sem venda correspondente nas sessões conferidas',
  pix: 'comprovante de PIX sem PIX com esse valor no sistema',
  crediario: 'recibo sem recebimento de crediário com esse valor no sistema',
  outros: 'papel sem registro correspondente',
};

function dataBr(iso: string): string {
  const [a, m, d] = iso.split('-');
  return d && m && a ? `${d}/${m}/${a}` : iso;
}

function tituloDoTicket(t: TicketEntrada): string {
  const partes: string[] = [];
  switch (t.origem) {
    case 'maquininha':
      partes.push(
        t.operacao === 'pix'
          ? 'Maquininha · PIX'
          : `Maquininha · ${t.operacao === 'debito' ? 'débito' : t.operacao === 'credito' ? 'crédito' : t.operacao}`,
      );
      break;
    case 'cupom_venda':
      partes.push(`Cupom${t.numero ? ` #${(normalizarNumero(t.numero) || t.numero).toUpperCase()}` : ''}`);
      break;
    case 'recibo_crediario':
      partes.push(`Recibo de crediário${t.numero ? ` #${(normalizarNumero(t.numero) || t.numero).toUpperCase()}` : ''}`);
      break;
    case 'comprovante_pix':
      partes.push('Comprovante de PIX');
      break;
    default:
      partes.push('Papel');
  }
  if (t.bandeira) partes.push(String(t.bandeira).toUpperCase());
  if (t.hora) partes.push(t.hora);
  if (t.cliente) partes.push(t.cliente);
  return partes.join(' · ');
}

function compararPar(e: Esperado, t: TicketEntrada, dia: string): Linha {
  const notas: string[] = [];
  let situacao: Situacao = 'confere';
  const grupo = GRUPO_DO_TIPO[e.tipo];

  if (!mesmoValor(e.valor, t.valor)) {
    situacao = 'valor_diferente';
    notas.push(`valor diferente: sistema ${fmtReal(e.valor)} · ticket ${fmtReal(t.valor)}`);
  }
  if ((e.tipo === 'cupom' || e.tipo === 'crediario') && e.formas?.length && t.formas.length) {
    if (!formasIguais(e.formas, t.formas)) {
      if (situacao === 'confere') situacao = 'forma_diferente';
      notas.push(
        `o papel diz ${t.formas.join(' + ').toUpperCase()} e o sistema hoje diz ${e.formas.join(' + ').toUpperCase()} — pagamento alterado depois da impressão?`,
      );
    }
  }
  if (e.tipo === 'cartao' && e.operacao && (t.operacao === 'credito' || t.operacao === 'debito') && e.operacao !== t.operacao) {
    notas.push(`no sistema está ${e.operacao === 'debito' ? 'DÉBITO' : 'CRÉDITO'}, a maquininha diz ${t.operacao === 'debito' ? 'DÉBITO' : 'CRÉDITO'}`);
  }
  if (e.tipo === 'cartao' && e.parcelas != null && t.parcelas != null && e.parcelas !== t.parcelas) {
    notas.push(`parcelas: sistema ${e.parcelas}x · ticket ${t.parcelas}x`);
  }
  if (t.data && t.data !== dia) notas.push(`a data impressa é ${dataBr(t.data)}`);
  if (e.cancelada) notas.push('venda ESTORNADA no sistema — confira o ticket de estorno da maquininha');
  const tm = minutoDaHora(t.hora);
  if (e.minuto != null && tm != null && Math.abs(e.minuto - tm) > 180) {
    notas.push(`horários distantes: sistema ${fmtMinuto(e.minuto)} · ticket ${t.hora}`);
  }
  if (situacao === 'confere' && notas.length) situacao = 'confere_com_nota';
  // Informativa: o comprovante É a prova que faltava, então não rebaixa a linha.
  if (e.pixExterno && e.tipo === 'pix') notas.push('PIX sem confirmação do banco: conferido pelo comprovante');

  return {
    situacao,
    grupo,
    esperado: e.chave,
    titulo: e.titulo,
    ticketId: t.id,
    fotoId: t.fotoId,
    valorSistema: e.valor,
    valorTicket: t.valor,
    notas,
  };
}

function fechar(linhas: Linha[], esperados: Esperado[]): Resultado {
  const vazio = (): TotalGrupo => ({ sistema: 0, tickets: 0, esperados: 0, comTicket: 0, ticketsLidos: 0 });
  const totais: Record<Grupo, TotalGrupo> = {
    cartao: vazio(),
    cupons: vazio(),
    pix: vazio(),
    crediario: vazio(),
    outros: vazio(),
  };
  const contagem = { confere: 0, atencao: 0, divergencia: 0, semTicket: 0, semRegistro: 0, ilegiveis: 0 };
  const porChave = new Map(esperados.map((e) => [e.chave, e]));

  for (const l of linhas) {
    const peso = PESO[l.situacao];
    if (peso === 'ok') contagem.confere++;
    else if (peso === 'atencao') contagem.atencao++;
    else if (peso === 'divergencia') contagem.divergencia++;
    if (l.situacao === 'sem_ticket') contagem.semTicket++;
    if (l.situacao === 'sem_registro') contagem.semRegistro++;
    if (l.situacao === 'ilegivel') contagem.ilegiveis++;

    const tot = totais[l.grupo];
    const contaComoTicket = l.ticketId && !['duplicado', 'ilegivel', 'fora_do_dia', 'outro'].includes(l.situacao);
    if (contaComoTicket && l.valorTicket != null) {
      tot.tickets += l.valorTicket;
      tot.ticketsLidos++;
    }
    const e = l.esperado ? porChave.get(l.esperado) : undefined;
    if (e && l.valorSistema != null && (e.obrigatorio || l.ticketId)) {
      tot.sistema += l.valorSistema;
      tot.esperados++;
      if (l.ticketId) tot.comTicket++;
    }
  }
  for (const g of Object.keys(totais) as Grupo[]) {
    totais[g].sistema = Math.round(totais[g].sistema * 100) / 100;
    totais[g].tickets = Math.round(totais[g].tickets * 100) / 100;
  }

  const temObrigatorio = esperados.some((e) => e.obrigatorio);
  const temTicket = linhas.some((l) => l.ticketId);
  let status: Resultado['status'];
  if (!temObrigatorio && !temTicket) status = 'sem_movimento';
  else if (contagem.divergencia > 0) status = 'divergente';
  else if (contagem.atencao > 0) status = 'atencao';
  else status = 'confere';

  // Ordem da tela: divergência, atenção, conferido, neutro
  const ordem: Record<Peso, number> = { divergencia: 0, atencao: 1, ok: 2, neutro: 3 };
  linhas.sort((a, b) => ordem[PESO[a.situacao]] - ordem[PESO[b.situacao]]);

  return { status, linhas, totais, contagem };
}
