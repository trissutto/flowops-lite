/**
 * QUAIS CONTAS DE ANÚNCIO SÃO DE E-COMMERCE E QUAIS SÃO DE LOJA FÍSICA.
 *
 * Uma régua só, em `common/`, porque dois lugares parseando a mesma env é
 * exatamente como listas gêmeas divergem — e aqui divergir tem preço: a conta
 * que o ESPELHO coleta e a que a tela de ROAS EXCLUI têm que ser a mesma
 * lista, senão o gasto de loja entra no denominador do site (ou some de novo).
 *
 * ── Por que existem duas listas ──
 *
 * Medido em 26/08/2026: a conta `01 Locais` (157208321008735) gastou
 * **R$ 41.521 em 30 dias** e não aparecia em relatório nenhum, porque o
 * espelho só coletava `META_ADS_CONTAS`. Eram 62% do dinheiro do Meta
 * invisíveis — e o pior tipo de invisível: o gasto sumia, mas a SESSÃO que ele
 * comprava aparecia, então o quadro "tráfego de lojas" mostrava gente
 * chegando de graça.
 *
 * Coletar não basta: `/retaguarda/campanhas` divide gasto por receita do
 * SITE, e anúncio de loja física não existe pra vender no site — a campanha
 * "CLAUDE VITRINE Novidades - WhatsApp - 14 lojas" fez 233 sessões e ZERO
 * pedido no mesmo dia em que gastou R$ 1.075. Somar as duas coisas afunda o
 * ROAS do e-commerce com custo que não é dele. É o mesmo princípio que já
 * tira a sessão da `/lojas` do funil: público de intenção diferente não
 * divide denominador.
 *
 * O retorno das contas de loja aparece onde ele acontece: no quadro de lojas,
 * como custo por contato (WhatsApp / como chegar / telefone / Instagram).
 */

/** Lê uma env com contas separadas por vírgula. Tolera `act_` e espaço. */
function lista(valor: string | undefined): string[] {
  return (valor || '')
    .split(',')
    .map((c) => c.trim().replace(/^act_/, ''))
    .filter(Boolean);
}

/** Contas de E-COMMERCE (`META_ADS_CONTAS`). */
export function contasEcommerce(valor = process.env.META_ADS_CONTAS): string[] {
  return lista(valor);
}

/**
 * Contas de LOJA FÍSICA (`META_ADS_CONTAS_LOJA`).
 *
 * Vazia = comportamento de antes de 26/08/2026: nada é coletado a mais e nada
 * é excluído da tela de ROAS. Ausência desliga o recurso, nunca quebra.
 */
export function contasDeLoja(valor = process.env.META_ADS_CONTAS_LOJA): string[] {
  return lista(valor);
}

// ═══════════════════════════════════════════════════════════════════════════
//  GOOGLE — a mesma régua, a mesma armadilha (02/09/2026)
//
//  A auditoria mediu o gêmeo exato do caso do Meta de 26/08: a conta
//  **Lojas Físicas (9564998046)** gastou **R$ 26.648,65 em 30 dias** em 29
//  campanhas de cidade e não estava em `GOOGLE_ADS_CONTAS` — R$ 324 mil/ano
//  fora de qualquer relatório. E aqui o estrago de ligar sem filtrar é PIOR
//  que no Meta: essa conta reporta **R$ 184.865 de "valor de conversão" que é
//  100% visita de loja estimada e "como chegar"** — nenhum real de receita.
//  Coletar antes de excluir jogaria R$ 180 mil na tela como faturamento.
//
//  Por isso a régua vem ANTES da env: o código aprende a separar, e só então
//  a chave é ligada.
// ═══════════════════════════════════════════════════════════════════════════

/** Contas de E-COMMERCE no Google (`GOOGLE_ADS_CONTAS`). */
export function contasEcommerceGoogle(valor = process.env.GOOGLE_ADS_CONTAS): string[] {
  return lista(valor);
}

/**
 * Contas de LOJA FÍSICA no Google (`GOOGLE_ADS_CONTAS_LOJA`).
 *
 * Vazia = comportamento de antes de 02/09/2026. Ausência desliga, nunca quebra.
 */
export function contasDeLojaGoogle(valor = process.env.GOOGLE_ADS_CONTAS_LOJA): string[] {
  return lista(valor);
}

/**
 * TODAS as contas de loja física, das duas redes — é esta que o SQL usa.
 *
 * As tabelas de espelho (`meta_ads_gasto_dia`, `google_ads_gasto_dia`) têm a
 * MESMA coluna `conta_id`, e a pergunta que a tela de ROAS faz é uma só:
 * "este gasto é de loja física?". Uma lista por rede obrigaria cada consulta a
 * saber de qual rede está falando — e é assim que uma das duas fica de fora
 * numa refatoração. Os ids não colidem entre redes (Meta são numéricos longos
 * de `act_`, Google são `customer_id`), então a lista única é segura.
 */
export function contasDeLojaTodas(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...contasDeLoja(env.META_ADS_CONTAS_LOJA), ...contasDeLojaGoogle(env.GOOGLE_ADS_CONTAS_LOJA)];
}
