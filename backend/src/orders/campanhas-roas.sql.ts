/**
 * A QUERY DO ROAS POR CAMPANHA — validada no Postgres de produção antes de
 * virar código (2,4s, 55 linhas, janela 10→24/08).
 *
 * Mora num arquivo só porque o \`orders.service.ts\` já passa de 5.000 linhas e
 * porque SQL montada por string tem que ser conferível de uma olhada.
 *
 * Parâmetros: $1 = início, $2 = fim (timestamptz, fuso de São Paulo),
 *             $3 = contas de LOJA a excluir do gasto (text[], pode ser vazio).
 *
 * As três decisões que essa query embute, e o porquê de cada uma:
 *
 *  1. **Agrupa por \`campaign.id\`, nunca pelo nome.** Nome é renomeado no
 *     Gerenciador, chega com codificação dupla (\`+\` no lugar de espaço) e às
 *     vezes vem como número. As três quebras já aconteceram.
 *  2. **Id que o espelho não conhece NÃO vira gasto casado.** É id de conjunto
 *     (\`{{adset.id}}\` no lugar de \`{{campaign.id}}\`) ou conta que ninguém
 *     coleta. Medido: cortar o sufixo \`_v2_…\` recupera 0 de 33. A linha fica
 *     sem ROAS e a tela diz o motivo — inventar denominador é pior.
 *  3. **Receita é pedido PAGO** (mesma régua de \`common/pedido-pago.ts\`).
 */
export const SQL_CAMPANHAS_ROAS = `
-- ═══════════════════════════════════════════════════════════════════════════
-- /retaguarda/campanhas — GASTO → RECEITA → ROAS, por campanha.
-- $1 = de (timestamptz), $2 = ate (timestamptz), $3 = contas de loja (text[])
-- Contas: só as de ECOMM (META_ADS_CONTAS / GOOGLE_ADS_CONTAS no Railway).
-- ═══════════════════════════════════════════════════════════════════════════
WITH
-- Nome oficial da campanha: o do ESPELHO manda, nunca o utm_campaign cru
-- (renomeado no Gerenciador, chega com codificação dupla, às vezes vem número).
nomes AS (
  SELECT campanha_id, MAX(campanha_nome) AS nome, 'meta' AS rede FROM meta_ads_gasto_dia GROUP BY campanha_id
  UNION ALL
  SELECT campanha_id, MAX(campanha_nome) AS nome, 'google'     FROM google_ads_gasto_dia GROUP BY campanha_id
),
gasto AS (
  -- \`conta_id <> ALL($3)\`: as contas de LOJA FÍSICA ficam de fora desta tela.
  -- O espelho passou a coletá-las em 26/08/2026 (R$ 41,5 mil/30d que não
  -- existiam em lugar nenhum), mas aqui o gasto é dividido por receita do
  -- SITE — e anúncio de loja não existe pra vender no site. Somar os dois
  -- afunda o ROAS do e-commerce com custo que não é dele. Lista vazia = nada
  -- é excluído, que é o comportamento de antes.
  SELECT campanha_id, 'meta' AS rede, SUM(gasto)::numeric AS gasto,
         SUM(impressoes)::bigint AS impressoes, SUM(cliques)::bigint AS cliques
    FROM meta_ads_gasto_dia
   WHERE dia >= $1::date AND dia <= $2::date AND conta_id <> ALL ($3::text[])
   GROUP BY campanha_id
  UNION ALL
  -- ⚠️ O MESMO FILTRO NO GOOGLE (02/09/2026). Ele existia só no ramo do Meta:
  -- quando o espelho do Google passou a coletar, a linha foi copiada sem o
  -- \`conta_id\`, e a auditoria pegou isso ANTES de a conta de loja entrar na
  -- env — R$ 26.648/30d que teriam caído direto no denominador do site.
  -- Filtro em um ramo só é a mesma coisa que filtro nenhum.
  SELECT campanha_id, 'google', SUM(gasto)::numeric, SUM(impressoes)::bigint, SUM(cliques)::bigint
    FROM google_ads_gasto_dia
   WHERE dia >= $1::date AND dia <= $2::date AND conta_id <> ALL ($3::text[])
   GROUP BY campanha_id
),
-- Telefones que FECHARAM uma venda paga, com a hora. Sai numa CTE só porque
-- rodar isso por pedido seria uma subconsulta correlacionada em 23 mil linhas.
pagos_fone AS (
  SELECT RIGHT(regexp_replace(COALESCE(customer_phone,''), '\\D', '', 'g'), 11) AS fone,
         COALESCE(paid_at, created_at) AS quando
    FROM orders
   WHERE status NOT IN ('cancelled','canceled','failed','payment_failed')
     AND CASE WHEN source IN ('ecommerce','loja','pdv_online')
              THEN paid_at IS NOT NULL
              ELSE status NOT IN ('awaiting_payment','pending')
         END
     AND length(regexp_replace(COALESCE(customer_phone,''), '\\D', '', 'g')) >= 10
     AND COALESCE(paid_at, created_at) >= $1
),
ped AS (
  SELECT
    NULLIF(TRIM(o.utm_id), '')       AS utm_id,
    NULLIF(TRIM(o.utm_campaign), '') AS nome_cru,
    COALESCE(NULLIF(TRIM(o.utm_source), ''), '(direto)') AS fonte,
    COALESCE(NULLIF(TRIM(o.utm_medium), ''), '')         AS midia,
    COALESCE(o.total_amount, 0)::numeric AS valor,
    -- A RÉGUA de common/pedido-pago.ts, nos três degraus e na mesma ORDEM.
    -- Inverter 1 e 2 faz PIX confirmado ainda não roteado (status 'pending')
    -- sumir da receita — foi o caso do LP-000161. Ver a memória
    -- pending-e-duas-coisas-no-flow.
    (
      o.status NOT IN ('cancelled','canceled','failed','payment_failed')
      AND CASE WHEN o.source IN ('ecommerce','loja','pdv_online')
               THEN o.paid_at IS NOT NULL
               ELSE o.status NOT IN ('awaiting_payment','pending')
          END
    ) AS pago,
    (o.status IN ('cancelled','canceled','failed')) AS cancelado,
    -- RECUPERADO: a tentativa morreu, mas a MESMA pessoa fechou uma venda paga
    -- depois (até 14 dias) — quase sempre porque o atendimento foi atrás.
    -- Decisão do dono (24/08): isso NÃO é "não pago". Contar como perda faz a
    -- tela cobrar de campanha que na verdade deu certo, só que pelo WhatsApp.
    EXISTS (
      SELECT 1 FROM pagos_fone pf
       WHERE pf.fone = RIGHT(regexp_replace(COALESCE(o.customer_phone,''), '\\D', '', 'g'), 11)
         AND length(regexp_replace(COALESCE(o.customer_phone,''), '\\D', '', 'g')) >= 10
         AND pf.quando >  COALESCE(o.wc_date_created, o.created_at)
         AND pf.quando <  COALESCE(o.wc_date_created, o.created_at) + INTERVAL '14 days'
    ) AS recuperado,
    -- ATENDIMENTO HUMANO: alguém da matriz assumiu essa cliente na aba
    -- Carrinhos. É o que separa "o time foi atrás e salvou" de "a cliente
    -- voltou sozinha" — decisão do dono (24/08): recuperação é MÉRITO, e
    -- retentativa espontânea não é mérito de ninguém.
    -- ⚠️ a tabela carrinho_atendimento nasceu em 24/08 — antes disso é tudo "sozinha"
    -- por falta de registro, NÃO porque ninguém atendeu.
    EXISTS (
      SELECT 1 FROM carrinho_atendimento ca
       WHERE ca.telefone = RIGHT(regexp_replace(COALESCE(o.customer_phone,''), '\\D', '', 'g'), 11)
         AND ca.assumido_em >= COALESCE(o.wc_date_created, o.created_at) - INTERVAL '1 day'
         AND ca.assumido_em <  COALESCE(o.wc_date_created, o.created_at) + INTERVAL '14 days'
    ) AS atendida
  FROM orders o
  WHERE o.source IN ('site','ecommerce')
    AND COALESCE(o.wc_date_created, o.created_at) >= $1
    AND COALESCE(o.wc_date_created, o.created_at) <= $2
),
-- A CHAVE: o id só vale quando o espelho conhece esse id. Id desconhecido é id
-- de CONJUNTO (o anúncio manda \`{{adset.id}}\`: pedido \`120...107640689\` contra
-- campanha \`120...107630689\`) — não existe gasto pra casar, e inventar um é
-- pior que admitir. Medido: cortar sufixo \`_v2_...\` recupera 0 de 33.
ped_k AS (
  SELECT p.*,
         (p.utm_id IS NOT NULL) AS tinha_id,
         CASE WHEN p.utm_id IN (SELECT campanha_id FROM nomes) THEN p.utm_id END AS campanha_id,
         CASE
           WHEN p.utm_id IN (SELECT campanha_id FROM nomes) THEN p.utm_id
           WHEN p.nome_cru IS NOT NULL THEN 'nome:' || lower(p.nome_cru)
           ELSE '~direto'
         END AS chave
    FROM ped p
),
receita AS (
  SELECT chave,
         MAX(campanha_id) AS campanha_id,
         MAX(nome_cru)    AS nome_cru,
         bool_or(tinha_id) AS tinha_id,
         COUNT(*) FILTER (WHERE pago)::int                       AS pedidos,
         COALESCE(SUM(valor) FILTER (WHERE pago), 0)             AS receita,
         COUNT(*) FILTER (WHERE cancelado)::int                  AS cancelados,
         -- "Não pago" agora é só o que MORREU mesmo.
         COUNT(*) FILTER (WHERE NOT pago AND NOT cancelado AND NOT recuperado)::int AS nao_pagos,
         COALESCE(SUM(valor) FILTER (WHERE NOT pago AND NOT cancelado AND NOT recuperado), 0) AS nao_pagos_valor,
         -- RECUPERADO = alguém foi atrás E a venda saiu.
         COUNT(*) FILTER (WHERE NOT pago AND NOT cancelado AND recuperado AND atendida)::int AS recuperados,
         COALESCE(SUM(valor) FILTER (WHERE NOT pago AND NOT cancelado AND recuperado AND atendida), 0) AS recuperados_valor,
         -- VOLTOU SOZINHA = pagou depois sem ninguém chamar. Não é perda, mas
         -- também não é trabalho de ninguém — somar nos dois lugares mentiria.
         COUNT(*) FILTER (WHERE NOT pago AND NOT cancelado AND recuperado AND NOT atendida)::int AS voltou_sozinha,
         COALESCE(SUM(valor) FILTER (WHERE NOT pago AND NOT cancelado AND recuperado AND NOT atendida), 0) AS voltou_sozinha_valor
    FROM ped_k GROUP BY chave
),
-- ORIGEM que REPRESENTA o grupo: a que mais aparece, com a fatia dela. O balde
-- "direto" junta origens diferentes; mostrar a do primeiro pedido rotulava 44
-- pedidos como Yahoo porque UM veio de lá.
origens AS (
  SELECT * FROM (
    SELECT chave, fonte, midia,
           ROW_NUMBER() OVER (PARTITION BY chave ORDER BY COUNT(*) DESC, fonte) AS rn,
           COUNT(*)                              AS n,
           SUM(COUNT(*)) OVER (PARTITION BY chave) AS total,
           COUNT(*)      OVER (PARTITION BY chave) AS distintas
      FROM ped_k WHERE pago GROUP BY chave, fonte, midia
  ) x WHERE rn = 1
),
-- Sessões: denominador da conversão. Só gente, SEM exigir aceite — é o modelo
-- de primeira parte; exigir aceite derruba 17.540 → 3.340 (−81%).
sessoes AS (
  SELECT dados->>'utm_id' AS campanha_id, COUNT(DISTINCT session_id)::int AS sessoes
    FROM site_eventos
   WHERE criado_em >= $1 AND criado_em <= $2
     AND NOT bot AND session_id IS NOT NULL AND dados->>'utm_id' IS NOT NULL
   GROUP BY 1
),
-- CONVERSÃO ASSISTIDA ("offline"): veio do anúncio, largou o carrinho, alguém
-- puxou no WhatsApp e a venda fechou FORA do site — quase sempre no PDV da loja.
--
-- São TRÊS jeitos de a mesma coisa acontecer, e por muito tempo só o primeiro
-- era contado. Os outros dois são a venda de carrinho recuperado fechada no
-- caixa: o \`ped\` lá em cima só olha \`source IN ('site','ecommerce')\`, então
-- pedido \`pdv_online\` nunca entrou na receita — e o ramo (1) exige \`utm_id\`
-- NULO, ou seja, CARREGAR a campanha do carrinho era justamente o que fazia a
-- venda sumir das duas pontas. Medido em 24-25/08: 4 vendas / R$ 1.480,81 em 30
-- dias invisíveis por esse motivo, e são elas que a loja fecha depois de puxar
-- a cliente no WhatsApp pelo modal "Carrinhos abandonados" do PDV.
assistida AS (
  SELECT campanha_id, COUNT(*)::int AS pedidos, SUM(valor) AS receita
    FROM (
      -- (1) A VENDA SEM CAMPANHA PRÓPRIA, casada com o carrinho pelo TELEFONE.
      -- DISTINCT ON (v.id): uma venda conta UMA vez. Sem isto, cliente que
      -- largou o carrinho 3 vezes fazia a MESMA venda entrar 3 vezes — inflou
      -- o offline de R$ 1.510,97 pra R$ 10.524,69 (7×) na primeira medição.
      SELECT * FROM (
        SELECT DISTINCT ON (v.id)
               v.id,
               COALESCE(r.attribution::jsonb->>'utm_id', ori.utm_id) AS campanha_id,
               COALESCE(v.total_amount, 0)::numeric                  AS valor
          FROM checkout_recoveries r
          LEFT JOIN LATERAL (
            SELECT se.dados->>'utm_id' AS utm_id FROM site_eventos se
             WHERE se.session_id = r.session_id AND se.dados->>'utm_id' IS NOT NULL
             ORDER BY se.criado_em LIMIT 1
          ) ori ON TRUE
          JOIN orders v
            ON RIGHT(regexp_replace(COALESCE(v.customer_phone,''), '\\D', '', 'g'), 11)
             = RIGHT(regexp_replace(COALESCE(r.telefone,''),      '\\D', '', 'g'), 11)
           AND COALESCE(v.paid_at, v.created_at) >  r.created_at
           AND COALESCE(v.paid_at, v.created_at) <  r.created_at + INTERVAL '14 days'
         WHERE length(regexp_replace(COALESCE(r.telefone,''), '\\D', '', 'g')) >= 10
           -- Quem trouxe a PRÓPRIA campanha é o ramo (2) logo abaixo — aqui
           -- entraria duas vezes.
           AND v.utm_id IS NULL
           AND v.status NOT IN ('cancelled','canceled','failed','payment_failed')
           AND CASE WHEN v.source IN ('ecommerce','loja','pdv_online')
                    THEN v.paid_at IS NOT NULL
                    ELSE v.status NOT IN ('awaiting_payment','pending')
               END
           AND COALESCE(v.paid_at, v.created_at) >= $1
           AND COALESCE(v.paid_at, v.created_at) <= $2
         -- O contato MAIS RECENTE antes da venda leva o crédito.
         ORDER BY v.id, r.created_at DESC
      ) casada
      UNION ALL
      -- (2) A VENDA QUE TROUXE A CAMPANHA DO CARRINHO e não é pedido do site:
      -- carrinho importado pro PDV e fechado como VENDA ONLINE (\`pdv_online\`).
      -- O \`PedidoOnlineService\` copia utm/fbc do carrinho pro pedido novo — é o
      -- único lugar onde a campanha existe — e é essa cópia que a tela precisa
      -- enxergar. Sem \`utm_id\` a linha cai no ramo (1) pelo telefone.
      SELECT v.id,
             NULLIF(TRIM(v.utm_id), '')            AS campanha_id,
             COALESCE(v.total_amount, 0)::numeric  AS valor
        FROM orders v
       WHERE v.source NOT IN ('site','ecommerce')
         AND NULLIF(TRIM(v.utm_id), '') IS NOT NULL
         AND v.status NOT IN ('cancelled','canceled','failed','payment_failed')
         AND CASE WHEN v.source IN ('ecommerce','loja','pdv_online')
                  THEN v.paid_at IS NOT NULL
                  ELSE v.status NOT IN ('awaiting_payment','pending')
             END
         AND COALESCE(v.paid_at, v.created_at) >= $1
         AND COALESCE(v.paid_at, v.created_at) <= $2
      UNION ALL
      -- (3) A VENDA DE BALCÃO: o mesmo carrinho, fechado no caixa em dinheiro,
      -- PIX ou cartão — a cliente combinou no WhatsApp e passou na loja. Aí NÃO
      -- nasce pedido nenhum (o \`Order\` só é criado quando TODO o pagamento é
      -- \`venda_online\`), então a campanha morreria com a venda.
      --
      -- A campanha vem do carrinho de origem, que a venda já aponta desde a
      -- importação (\`carrinho_order_id\`/\`carrinho_recovery_id\`) — sem cópia
      -- nova, sem coluna nova, e vale retroativo pro que já foi vendido.
      --
      -- O \`EXISTS\` de pagamento que NÃO é \`venda_online\` é o que impede contar
      -- duas vezes: venda 100% online já entrou pelo pedido dela no ramo (2).
      SELECT s.id,
             COALESCE(
               NULLIF(TRIM(co.utm_id), ''),
               NULLIF(TRIM(cr.attribution::jsonb->>'utm_id'), '')
             )                              AS campanha_id,
             COALESCE(s.total, 0)::numeric  AS valor
        FROM pdv_sales s
        LEFT JOIN orders              co ON co.id = s.carrinho_order_id
        LEFT JOIN checkout_recoveries cr ON cr.id = s.carrinho_recovery_id
       WHERE s.status = 'finalized'
         AND COALESCE(s.is_training, false) = false
         AND (s.carrinho_order_id IS NOT NULL OR s.carrinho_recovery_id IS NOT NULL)
         AND COALESCE(s.finalized_at, s.created_at) >= $1
         AND COALESCE(s.finalized_at, s.created_at) <= $2
         AND EXISTS (
           SELECT 1 FROM pdv_sale_payments p
            WHERE p.sale_id = s.id AND lower(p.method) <> 'venda_online'
         )
    ) u
   WHERE campanha_id IS NOT NULL
   GROUP BY campanha_id
)
SELECT
  COALESCE(r.campanha_id, g.campanha_id, a.campanha_id)   AS "campanhaId",
  -- Sem nome no espelho e sem utm_campaign, mas COM id (linha que só existe
  -- pela venda assistida): rotula pelo id. Cair no '(sem campanha)' punha duas
  -- linhas "Sem campanha / Direto" na tela e colidia a chave do React.
  COALESCE(
    n.nome,
    r.nome_cru,
    CASE WHEN COALESCE(r.campanha_id, g.campanha_id, a.campanha_id) IS NOT NULL
         THEN 'id ' || COALESCE(r.campanha_id, g.campanha_id, a.campanha_id) END,
    '(sem campanha)'
  )                                                       AS campanha,
  COALESCE(n.rede, g.rede,
    CASE
      WHEN lower(o.fonte) LIKE '%google%'                     THEN 'google'
      WHEN lower(o.fonte) ~ '(meta|facebook|instagram|^fb$|^ig$)' THEN 'meta'
      WHEN o.fonte = '(direto)'                               THEN 'direto'
      ELSE 'outro'
    END)                                                  AS rede,
  COALESCE(r.pedidos, 0)                                  AS pedidos,
  ROUND(COALESCE(r.receita, 0), 2)::float8                AS receita,
  COALESCE(r.nao_pagos, 0)                                AS "naoPagos",
  ROUND(COALESCE(r.nao_pagos_valor, 0), 2)::float8        AS "naoPagosReceita",
  COALESCE(r.cancelados, 0)                               AS cancelados,
  COALESCE(r.recuperados, 0)                              AS recuperados,
  ROUND(COALESCE(r.recuperados_valor, 0), 2)::float8       AS "recuperadosValor",
  COALESCE(r.voltou_sozinha, 0)                           AS "voltouSozinha",
  ROUND(COALESCE(r.voltou_sozinha_valor, 0), 2)::float8    AS "voltouSozinhaValor",
  ROUND(g.gasto, 2)::float8                               AS gasto,
  g.cliques::int, g.impressoes::int,
  COALESCE(s.sessoes, 0)                                  AS sessoes,
  COALESCE(a.pedidos, 0)                                  AS "pedidosOffline",
  ROUND(COALESCE(a.receita, 0), 2)::float8                AS "receitaOffline",
  COALESCE(r.tinha_id, false)                             AS "comUtmId",
  NULLIF(o.fonte, '(direto)')                             AS source,
  NULLIF(o.midia, '')                                     AS medium,
  COALESCE(o.distintas, 0)::int                           AS "origensDistintas",
  CASE WHEN o.total > 0 THEN ROUND(100.0 * o.n / o.total)::int ELSE 0 END AS "origemPct"
FROM receita r
FULL JOIN gasto     g ON g.campanha_id = r.campanha_id
FULL JOIN assistida a ON a.campanha_id = COALESCE(r.campanha_id, g.campanha_id)
LEFT JOIN origens   o ON o.chave       = r.chave
LEFT JOIN sessoes   s ON s.campanha_id = COALESCE(r.campanha_id, g.campanha_id)
LEFT JOIN nomes     n ON n.campanha_id = COALESCE(r.campanha_id, g.campanha_id, a.campanha_id)
ORDER BY COALESCE(g.gasto, 0) DESC, COALESCE(r.receita, 0) DESC
`;
