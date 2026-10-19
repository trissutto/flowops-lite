import { LOJA_CANAL_CODES, ehLojaCanal } from './loja-canal';

/**
 * LOJA QUE NÃO SEPARA PEDIDO — a DEPOSITO (loja 20).
 *
 * Ordem do dono (19/10/2026): **"retire a loja DEPOSITO da separação"**.
 *
 * A 20 (DEPOSITO, Itanhaém) é estoque de verdade — 6.679 peças em 5.070 SKUs
 * no espelho, 2.766 deles sem saldo em nenhuma outra loja — mas não tem quem
 * separe pedido: nunca recebeu um card (zero `pick_orders` na história) e o
 * espelho dela quase não se mexe (1 linha atualizada em 30 dias). Mesmo assim
 * ela entrava como CANDIDATA em todo roteamento: aparecia no `scoreBreakdown`
 * da tela do pedido, no filtro de lojas da /separacao e, no dia em que fosse a
 * única com a peça, viraria a loja escolhida.
 *
 * É a mesma família da loja-canal (`common/loja-canal.ts`), com uma diferença
 * que decide ONDE a regra vale:
 *
 *  - a loja-canal (13/SITE) não tem estoque real — some também da Consulta;
 *  - a DEPOSITO TEM estoque real — o SALDO FICA (Consulta F10, inventário,
 *    realinhamento, DRE, diagnóstico), igual à peça extraviada de 27/08: o que
 *    sai é a separação.
 *
 * ── ONDE ESTA REGRA VALE ──
 *
 * Onde o sistema escolhe quem separa pedido, e no que o site PROMETE (se a
 * vitrine e a trava do carrinho contassem a DEPOSITO, a cliente pagaria por uma
 * peça que o roteamento não manda ninguém separar — ruptura depois do
 * pagamento, o incidente de 12/09):
 * roteamento (candidatas, troca de peça, pedido online), escolha manual
 * ("forçar loja", "mover peça"), lastro da venda à distância, vitrine, trava do
 * carrinho e o filtro de lojas da /separacao.
 *
 * Medido em 19/10 antes de subir: 2.751 SKUs / 3.372 peças deixam de contar no
 * site, mas só 19 SKUs (17 REFs) estão publicados e nenhuma REF publicada fica
 * zerada — o que sai é a cor+tamanho que só a DEPOSITO tinha.
 *
 * Por env (`LOJAS_SEM_SEPARACAO=20,21`) pra não precisar de deploy se outra
 * loja deixar de separar. `LOJAS_SEM_SEPARACAO=` (vazia) devolve a 20 pra
 * separação.
 */
export const LOJAS_SEM_SEPARACAO_CODES: string[] = String(process.env.LOJAS_SEM_SEPARACAO ?? '20')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

/** Loja-canal + lojas sem separação: quem NÃO pode ser escolhida pra separar. */
export const LOJAS_FORA_DA_SEPARACAO: string[] = Array.from(
  new Set([...LOJA_CANAL_CODES, ...LOJAS_SEM_SEPARACAO_CODES]),
);

/** Mesma normalização do `ehLojaCanal`: `LJ20`, `20` e `020` são a mesma loja. */
function norm(raw: unknown): string {
  const c = String(raw ?? '').trim().toUpperCase().replace(/^LJ/, '');
  return c.replace(/^0+/, '') || c;
}

/** A loja está na lista de quem não separa (sem contar a loja-canal). */
export function ehLojaSemSeparacao(raw: unknown): boolean {
  if (!String(raw ?? '').trim()) return false;
  const alvo = norm(raw);
  return LOJAS_SEM_SEPARACAO_CODES.some((c) => norm(c) === alvo);
}

/** A loja não pode ser escolhida pra separar: loja-canal OU sem separação. */
export function naoSepara(raw: unknown): boolean {
  return ehLojaCanal(raw) || ehLojaSemSeparacao(raw);
}

/**
 * A CONDIÇÃO em SQL, sem o `WHERE` — o par do `condSemLojaCanal` pra quem soma
 * o saldo que o site pode prometer.
 *
 * @param col nome (ou `alias.coluna`) da coluna de loja na consulta de quem chama.
 */
export function condSoQuemSepara(col = 'loja'): string {
  const lista = LOJAS_FORA_DA_SEPARACAO.map((c) => `'${c.replace(/'/g, "''")}'`).join(', ');
  return `TRIM(UPPER(${col})) NOT IN (${lista})`;
}

/** `WHERE` pronto: `SELECT codigo, SUM(estoque) FROM wincred_estoque ${SQL_SO_QUEM_SEPARA} GROUP BY codigo`. */
export const SQL_SO_QUEM_SEPARA = `WHERE ${condSoQuemSepara()}`;
