import type { Grupo, Linha, Resultado, Situacao } from './cruzamento';

/**
 * Frases curtas de um cruzamento — a MESMA fala na lista da retaguarda e no
 * resumo diário do WhatsApp ("2 vendas no cartão sem ticket (R$ 189,80)").
 */

const reais = (v: number) =>
  `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

const FRASE: Partial<Record<`${Situacao}:${Grupo}`, [string, string]>> = {
  'sem_ticket:cartao': ['venda no cartão sem ticket', 'vendas no cartão sem ticket'],
  'sem_ticket:cupons': ['venda em dinheiro/PIX sem cupom', 'vendas em dinheiro/PIX sem cupom'],
  'sem_ticket:pix': ['PIX sem comprovante', 'PIX sem comprovante'],
  'sem_ticket:crediario': ['recebimento de crediário sem recibo', 'recebimentos de crediário sem recibo'],
  'sem_registro:cartao': ['ticket da maquininha sem venda', 'tickets da maquininha sem venda'],
  'sem_registro:cupons': ['cupom sem venda', 'cupons sem venda'],
  'sem_registro:pix': ['comprovante de PIX sem venda', 'comprovantes de PIX sem venda'],
  'sem_registro:crediario': ['recibo sem recebimento', 'recibos sem recebimento'],
};

/** Divergências primeiro, depois atenções. Vazio = nada a dizer. */
export function frasesDoResultado(r: Resultado | null | undefined, max = 4): string[] {
  if (!r) return [];
  const blocos = new Map<string, { n: number; valor: number; linhas: Linha[] }>();
  for (const l of r.linhas) {
    const chave = `${l.situacao}:${l.grupo}`;
    const b = blocos.get(chave) || { n: 0, valor: 0, linhas: [] };
    b.n++;
    b.valor += l.valorSistema ?? l.valorTicket ?? 0;
    b.linhas.push(l);
    blocos.set(chave, b);
  }
  const frases: string[] = [];
  const add = (texto: string) => {
    if (frases.length < max) frases.push(texto);
  };

  for (const [chave, par] of Object.entries(FRASE) as [string, [string, string]][]) {
    const b = blocos.get(chave);
    if (b) add(`${plural(b.n, par[0], par[1])} (${reais(b.valor)})`);
  }
  const contar = (sit: Situacao) =>
    [...blocos.entries()].filter(([k]) => k.startsWith(`${sit}:`)).reduce((s, [, b]) => s + b.n, 0);

  const valores = contar('valor_diferente');
  if (valores) add(plural(valores, 'valor diferente entre ticket e sistema', 'valores diferentes entre ticket e sistema'));
  const formas = contar('forma_diferente');
  if (formas) add(plural(formas, 'cupom com forma de pagamento diferente da do sistema', 'cupons com forma de pagamento diferente da do sistema'));
  const ilegiveis = contar('ilegivel');
  if (ilegiveis) add(plural(ilegiveis, 'ticket ilegível', 'tickets ilegíveis'));
  const estornos = contar('estorno');
  if (estornos) add(plural(estornos, 'estorno na maquininha', 'estornos na maquininha'));
  const notas = contar('confere_com_nota');
  if (notas) add(plural(notas, 'ticket com observação (crédito×débito, parcelas ou data)', 'tickets com observação (crédito×débito, parcelas ou data)'));
  const fora = contar('fora_do_dia');
  if (fora) add(plural(fora, 'ticket de outro dia', 'tickets de outro dia'));
  return frases;
}

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** '2026-09-15' → 'ter 15/09' */
export function diaCurto(iso: string): string {
  const [a, m, d] = iso.split('-').map(Number);
  if (!a || !m || !d) return iso;
  const semana = DIAS_SEMANA[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
  return `${semana} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}
