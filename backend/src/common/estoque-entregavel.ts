import { condSemLojaCanal } from './loja-canal';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  O SALDO QUE O SITE PODE PROMETER — a régua de quem MOSTRA e de quem COBRA
 *
 *  ── O BUG QUE ISTO CONSERTA (medido em 12/09/2026) ──
 *
 *  Pedido **LP-001354** (12/09): *VOGUE · MARROM DOURADO · 50* pago e caído em
 *  **"Ruptura: 1 SKU sem estoque em nenhuma loja ativa"** com a peça de pé no
 *  espelho — `wincred_estoque` = 1 na loja 01. O roteamento sabia por quê: essa
 *  peça foi marcada **EXTRAVIADA em 29/08** na própria 01 (a loja disse "não
 *  achei" no pedido ON-000224). Pela regra de 27/08 o SALDO FICA e o
 *  ROTEAMENTO passa longe — mas ninguém tinha contado isso pra vitrine.
 *
 *  Eram duas contas do mesmo número:
 *
 *    vitrine + trava do carrinho → SUM(wincred_estoque) − loja-canal − reserva
 *    roteamento                  → o mesmo, MENOS loja inativa, MENOS a peça
 *                                  extraviada (por loja+SKU), menos o card ativo
 *
 *  O site promete o que o roteamento já sabe que não tem: a cliente paga, o
 *  card nasce sem loja e alguém descobre isso na separação. É a MESMA família
 *  do incidente de 31/08 (vitrine mostrando disponível e checkout recusando no
 *  clique de pagar) — só que dessa vez o lado desinformado é o que COBRA.
 *
 *  ── O ESTRAGO MEDIDO (13/09/2026, Postgres de produção) ──
 *
 *   · 184 SKUs / 332 peças que o site prometia e nenhuma loja podia separar:
 *     172 por saldo na loja 09 (MATRIZ LURDS, `active = false` — 278 linhas,
 *     293 peças) e 12 por peça extraviada. 13 desses SKUs (11 REFs) estavam
 *     publicados na hora da medição; os da 09 só não venderam porque as REFs
 *     delas não estão no ar — é sorte, não trava.
 *   · 7 pedidos pagos em 30 dias bateram nessa parede, TODOS por extraviada;
 *     5 ficaram presos em `separating`.
 *   · O `8000000003614` vendeu DUAS vezes assim: ON-000127 (24/08) e LP-001354
 *     (12/09), com o "não achei" do ON-000224 (29/08) entre uma e outra. A peça
 *     nunca saiu da vitrine.
 *
 *  ⚠️ Os números acima são os que a TELA mostra (`wc_order_number`). No banco
 *  esses mesmos pedidos são 950001354 / 960000224 / 960000127 — o `wc_order_id`
 *  sintético (site 950M, pedido online 960M, live 900M). Falar pela tela.
 *
 *  ── O QUE ESTE ARQUIVO NÃO FAZ ──
 *
 *  Não mexe no SALDO. Consulta da vendedora (F10), balcão, inventário, DRE e
 *  diagnóstico continuam vendo a peça onde ela está — essa é a ordem de 27/08
 *  ("não desapareça — pois aí vira festa"), e ela vale. O que muda é só o que
 *  o SITE PROMETE.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * `SITE_ESTOQUE_ENTREGAVEL=0` volta ao saldo bruto (só sem a loja-canal) —
 * o comportamento de antes de 13/09.
 *
 * Interruptor ÚNICO pros dois lados de propósito: desligar só num deles é
 * exatamente o incidente de 31/08 (a página promete, o checkout recusa). Se
 * precisar desligar, desliga pros dois.
 */
export function estoqueEntregavelLigado(): boolean {
  return String(process.env.SITE_ESTOQUE_ENTREGAVEL ?? '1').trim() !== '0';
}

/**
 * Código de loja normalizado em SQL — a MESMA régua do `ehLojaCanal` no TS
 * (`LJ13`, `13`, `013` e `13` são a mesma loja). `NULLIF` no fim porque loja
 * vazia não pode casar com loja vazia num JOIN: seria a rede inteira virando
 * uma loja só.
 */
export function lojaNorm(col: string): string {
  // um regexp só ('^(LJ)?0*') em vez de dois: são ~295 mil linhas de espelho,
  // e cada passada a mais aparece no relógio do checkout.
  return `NULLIF(regexp_replace(UPPER(TRIM(${col})), '^(LJ)?0*', ''), '')`;
}

/** SKU sem zeros à esquerda — a mesma régua do espelho e do roteamento. */
export function skuNorm(col: string): string {
  return `ltrim(TRIM(${col}), '0')`;
}

/**
 * A SUBQUERY do estoque por código, **sem parâmetro nenhum**.
 *
 * Sem `$1` pelo mesmo motivo do `sqlReservadoPorSku()`: este texto é
 * interpolado dentro de consultas que já usam os seus placeholders, e um a
 * mais renumeraria os de lá. Os valores são constantes do próprio código.
 *
 * Devolve `(codigo, total)` — o mesmo contrato da subquery que ela substitui,
 * pra entrar no lugar sem tocar em quem soma.
 *
 * Duas exclusões, as duas copiadas do roteamento:
 *
 *  1. **Loja INATIVA** (`stores.active = false`). O `DISTINCT` não é enfeite:
 *     sem ele, dois cadastros que normalizassem pro mesmo código duplicariam a
 *     linha do espelho e dobrariam o saldo. Loja que NÃO existe em `stores`
 *     continua contando — sumir com saldo por falta de cadastro seria a "fonte
 *     morta com cara de não existe" que a regra de ouro proíbe.
 *  2. **Peça EXTRAVIADA ABERTA**, por LOJA+SKU (`pecas_extraviadas`,
 *     `achada_em IS NULL`). `marcarAchada` devolve a peça pro jogo sozinha —
 *     aqui não há nada a liberar, igual ao reservado.
 *
 * 🚨 **O DESCONTO NUNCA VIRA CRÉDITO.** O `LEAST(qtd, GREATEST(estoque, 0))`
 * existe porque o espelho TEM saldo negativo: 150 linhas somando −155 peças
 * (13/09). A primeira versão desta régua usava `GREATEST(estoque − qtd, 0)`
 * por linha, e o piso zerava o negativo em vez de subtraí-lo: **143 SKUs
 * GANHARAM saldo** — a régua que existe pra vender menos passaria a vender
 * mais. Assim como está, loja sem peça desconta zero e o negativo continua
 * pesando exatamente como pesava. Sem extraviada, a conta é idêntica à de
 * antes — e é isso que a validação contra o Postgres confere (nenhum SKU pode
 * subir de saldo).
 */
export function sqlEstoqueEntregavelPorCodigo(): string {
  if (!estoqueEntregavelLigado()) {
    return `
      SELECT codigo, SUM(COALESCE(estoque, 0))::int AS total
        FROM wincred_estoque
       WHERE ${condSemLojaCanal('loja')}
       GROUP BY codigo`;
  }
  return `
      SELECT z.codigo AS codigo,
             SUM(z.estoque - LEAST(COALESCE(x.qtd, 0), GREATEST(z.estoque, 0)))::int AS total
        FROM (
               -- a normalização de loja/sku sai daqui uma vez por linha, e não
               -- uma vez por JOIN: são ~200 mil linhas de espelho
               SELECT e.codigo               AS codigo,
                      COALESCE(e.estoque, 0) AS estoque,
                      ${lojaNorm('e.loja')}  AS loja,
                      ${skuNorm('e.codigo')} AS sku
                 FROM wincred_estoque e
                WHERE ${condSemLojaCanal('e.loja')}
                  -- linha zerada não soma nada e é METADE do espelho (294.634
                  -- linhas, 159.541 com saldo): cortar aqui é o que devolve o
                  -- tempo que as duas exclusões custam.
                  AND COALESCE(e.estoque, 0) <> 0
             ) z
        LEFT JOIN (
               SELECT DISTINCT ${lojaNorm('code')} AS loja
                 FROM stores WHERE active = false
             ) inativa ON inativa.loja = z.loja
        LEFT JOIN (
               SELECT ${lojaNorm('store_code')} AS loja,
                      ${skuNorm('sku')}         AS sku,
                      SUM(COALESCE(qty, 1))::int AS qtd
                 FROM pecas_extraviadas
                WHERE achada_em IS NULL
                GROUP BY 1, 2
             ) x ON x.loja = z.loja AND x.sku = z.sku
       WHERE inativa.loja IS NULL
       GROUP BY z.codigo`;
}
