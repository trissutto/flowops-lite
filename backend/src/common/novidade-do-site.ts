/**
 * NOVIDADE DO SITE — quem está em "Novidades" e em que ordem (27/11/2026).
 *
 * ── DUAS PORTAS, UMA JANELA ──
 *
 * Desde 13/08 "Novidades" é IDADE, não etiqueta: a peça entra quando é
 * publicada (`publicadoEm` — na prática a 1ª venda da família) e sai sozinha
 * depois de `NOVIDADE_DIAS` (60). Foi a cura da tag "Novidade" herdada do
 * WooCommerce, que nunca expirava e enchia a vitrine de peça velha.
 *
 * Em 27/11 o dono pediu a porta que faltava: *"colocar as peças que forem
 * novas (mesmo que o cadastro seja antigo) ali nas novidades do site"*. A
 * peça que acabou de chegar na arara mas tem cadastro de 2024 — REF
 * reciclada, cor nova numa família velha, `publicadoEm` carimbado pela 1ª
 * venda de uma irmã — nunca entrava, porque pra régua automática ela é velha.
 *
 * A marcação na mão (`SiteProduto.novidadeEm`, gravada pela ficha do produto
 * na retaguarda) é o SEGUNDO jeito de entrar, não um privilégio: ela diz
 * "esta peça chegou HOJE". A partir daí vale a MESMA janela — a peça sai
 * sozinha depois de `NOVIDADE_DIAS`, igual à que entrou por idade. É isso que
 * impede a vitrine de virar a tag eterna de novo: quem quiser a peça de volta
 * marca de novo, e a ficha diz até quando ela fica.
 *
 * ── A ORDEM ──
 *
 * "Novidades" ordena pelo instante em que a peça ENTROU na vitrine — o mais
 * recente entre `publicadoEm` e `novidadeEm`. Marcada hoje = chegou hoje = no
 * topo, na frente da que foi publicada ontem. Sem isso a marcação na mão
 * entraria pelo FIM da lista, e a página de 50 peças a cortaria calada.
 *
 * Régua PURA: vitrine, carrossel da home, feed, badge "novo" e a ficha da
 * retaguarda leem o MESMO resultado. Mudou a regra, muda aqui.
 */

export const NOVIDADE_DIAS_PADRAO = 60;
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * A janela, em dias, a partir do ambiente (`NOVIDADE_DIAS`, dono 16/08: 60).
 * Valor torto (vazio, texto, zero, negativo) cai no padrão — o antigo
 * `Math.max(1, Number(env ?? 60))` fazia `NOVIDADE_DIAS=` (vazio) virar
 * janela de 1 dia e `abc` virar NaN, que esvaziava a vitrine sem erro.
 */
export function janelaNovidadeDias(env: string | undefined = process.env.NOVIDADE_DIAS): number {
  const n = Number(env);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : NOVIDADE_DIAS_PADRAO;
}

export type Instante = Date | string | number | null | undefined;

export interface EntradaNovidade {
  /** Quando entrou no ar (1ª publicação / 1ª venda) — a porta AUTOMÁTICA. */
  publicadoEm?: Instante;
  /** Quando a retaguarda marcou "é novidade" — a porta MANUAL. */
  novidadeEm?: Instante;
}

export type MotivoNovidade = 'manual' | 'idade';

export interface DecisaoNovidade {
  /** Está em Novidades AGORA — é o `lancamento` da vitrine e o badge "novo". */
  lancamento: boolean;
  /** Pela porta manual, pela idade, ou fora (`null`). As duas = a mais recente. */
  motivo: MotivoNovidade | null;
  /** Quando ENTROU (epoch ms) — a chave da ordenação. `null` = nunca entrou. */
  entrouEm: number | null;
  /** Até quando fica (epoch ms). `null` quando está fora. */
  ate: number | null;
}

/** Date, ISO ou epoch → epoch ms; vazio ou inválido → null (nunca NaN). */
export function instante(v: Instante): number | null {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

export function decidirNovidade(
  e: EntradaNovidade,
  agora: number = Date.now(),
  janelaDias: number = janelaNovidadeDias(),
): DecisaoNovidade {
  const janela = Math.max(1, janelaDias) * DIA_MS;
  const portas: Array<{ motivo: MotivoNovidade; em: number }> = [];
  const pub = instante(e.publicadoEm);
  const man = instante(e.novidadeEm);
  if (pub != null) portas.push({ motivo: 'idade', em: pub });
  if (man != null) portas.push({ motivo: 'manual', em: man });
  if (!portas.length) return { lancamento: false, motivo: null, entrouEm: null, ate: null };

  // A porta mais RECENTE é a que conta — pra ordem e pra validade. Se a mais
  // recente já venceu, a outra venceu antes dela.
  portas.sort((a, b) => b.em - a.em);
  const ultima = portas[0];
  const dentro = agora - ultima.em <= janela;
  return {
    lancamento: dentro,
    motivo: dentro ? ultima.motivo : null,
    entrouEm: ultima.em,
    ate: dentro ? ultima.em + janela : null,
  };
}

/**
 * A chave de "Novidades": quando a peça entrou pela última vez. 0 = nunca
 * entrou (vai pro fim, estável). Ordenação é `desc` por esta chave.
 */
export function chaveOrdemNovidade(e: EntradaNovidade): number {
  return Math.max(instante(e.publicadoEm) ?? 0, instante(e.novidadeEm) ?? 0);
}

/** O que a FICHA da retaguarda mostra ao lado do checkbox "Novidades". */
export interface FichaNovidade {
  /** O que a vitrine mostra AGORA. */
  noAr: boolean;
  motivo: MotivoNovidade | null;
  /** Marcação na mão VIVA (dentro da janela) — é o estado do checkbox. */
  manual: boolean;
  manualEm: string | null;
  manualPor: string | null;
  /** Tinha marcação e ela VENCEU neste dia — a tela conta, pra ninguém achar que sumiu sozinha. */
  manualVencidaEm: string | null;
  /** Entra pela idade (publicada há menos de `janelaDias`), com ou sem marcação. */
  porIdade: boolean;
  publicadoEm: string | null;
  /** Até quando fica no ar, pelo que vale hoje. */
  ate: string | null;
  janelaDias: number;
}

export function fichaNovidade(
  e: EntradaNovidade & { novidadePor?: string | null },
  agora: number = Date.now(),
  janelaDias: number = janelaNovidadeDias(),
): FichaNovidade {
  const dias = Math.max(1, janelaDias);
  const janela = dias * DIA_MS;
  const d = decidirNovidade(e, agora, dias);
  const pub = instante(e.publicadoEm);
  const man = instante(e.novidadeEm);
  const manualViva = man != null && agora - man <= janela;
  const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());
  return {
    noAr: d.lancamento,
    motivo: d.motivo,
    manual: manualViva,
    manualEm: iso(man),
    manualPor: man != null ? (e.novidadePor ?? null) : null,
    manualVencidaEm: man != null && !manualViva ? iso(man + janela) : null,
    porIdade: pub != null && agora - pub <= janela,
    publicadoEm: iso(pub),
    ate: iso(d.ate),
    janelaDias: dias,
  };
}
