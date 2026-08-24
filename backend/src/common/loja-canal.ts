/**
 * LOJA-CANAL — A QUE NÃO CEDE PEÇA.
 *
 * Ordem do dono (24/08/2026): **"nunca consulte a LOJA 13 para atender cliente
 * — esta loja não deve ceder peça pois não tem estoque real"**.
 *
 * A loja `13` (`SITE`) é o CANAL por onde a venda de site e de live entra no
 * acerto entre lojas: a peça sai da loja física e ENTRA aqui a preço de custo
 * (é o `dreGrupo = CANAL` do model `Store`, e o `CANAL_STORE_CODE` que
 * `pick-orders`/`troca-peca`/`pdv.controller` já usavam como DESTINO). Ela não
 * tem arara, não tem vendedora, não tem peça pendurada.
 *
 * Mas o saldo dela existe no espelho de estoque como o de qualquer loja — e aí
 * ela vira **fornecedora fantasma**. Medido em 24/08: 38 linhas positivas / 42
 * peças na loja 13, **5 SKUs cujo único estoque positivo da rede está lá**
 * (o site vende, ninguém tem), e **3 cards de separação** caíram nela em 90
 * dias (ON-000046/49/50, todos parados em `new` desde 19/08 — não há quem
 * separe). É a mesma família do card fantasma de [venda-online-fecha-na-loja].
 *
 * ── ONDE ESTA REGRA VALE ──
 *
 * Onde o sistema escolhe ou MOSTRA quem entrega a peça pra cliente:
 * roteamento do pedido, Consulta da vendedora (F10), estoque que o site
 * promete na vitrine e a troca de peça. Nesses lugares a loja-canal não existe.
 *
 * ── ONDE NÃO VALE ──
 *
 * Ela continua sendo o **destino** do acerto (pick-orders/troca), a loja da
 * venda online no PDV, e continua visível em relatório, DRE e diagnóstico —
 * esconder o saldo dela de quem CONFERE só faria a divergência sumir de vista.
 * A regra é sobre CEDER peça, não sobre existir.
 *
 * Por env (`LOJA_CANAL_CODES=13,99`) pra não precisar de deploy se nascer outra
 * loja sem estoque real.
 */
export const LOJA_CANAL_CODES: string[] = String(process.env.LOJA_CANAL_CODES || '13')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

/**
 * Normalização igual à do espelho (`WincredCatalogService.normalizeLoja`):
 * `LJ13`, `13`, `3` e `013` são a mesma loja. Sem isso a regra passaria a valer
 * ou não dependendo de qual tabela escreveu a linha.
 */
export function ehLojaCanal(raw: unknown): boolean {
  const c = String(raw ?? '').trim().toUpperCase().replace(/^LJ/, '');
  if (!c) return false;
  const semZeros = c.replace(/^0+/, '') || c;
  return LOJA_CANAL_CODES.some((canal) => {
    const alvo = canal.replace(/^LJ/, '').replace(/^0+/, '') || canal;
    return semZeros === alvo;
  });
}

/** Tira a loja-canal de uma lista de códigos de loja candidatos a atender. */
export function semLojaCanal<T>(itens: T[], code: (item: T) => unknown): T[] {
  return itens.filter((i) => !ehLojaCanal(code(i)));
}

/**
 * Trecho de SQL cru pra somar estoque IGNORANDO a loja-canal.
 * Ex.: `SELECT codigo, SUM(estoque) FROM wincred_estoque ${SQL_SEM_LOJA_CANAL} GROUP BY codigo`.
 */
export const SQL_SEM_LOJA_CANAL = `WHERE TRIM(UPPER(loja)) NOT IN (${LOJA_CANAL_CODES.map(
  (c) => `'${c.replace(/'/g, "''")}'`,
).join(', ')})`;
