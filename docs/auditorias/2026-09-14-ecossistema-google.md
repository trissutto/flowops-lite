# Auditoria do ecossistema Google — 14/09/2026

Escopo: Google Ads (MCC + 2 contas), GA4, GTM, Merchant Center, Search Console, Meu Negócio, e o
código de tracking do site `lurds.com.br` (`ecommerce/`) e do backend (`backend/`). Tudo medido
na data — API v25 do Google Ads com as credenciais do Railway, Postgres de produção, navegador
logado do dono, `curl` contra produção. Horários em Brasília.

Correções de código: PR [#1205](https://github.com/trissutto/flowops-lite/pull/1205) (`88ef24f`).
Correções de conta: `backend/scripts/google-ads-lojas-correcoes-medicao.js`.

## 1. Mapa do ecossistema

| Sistema | Identificação | Estado medido |
|---|---|---|
| MCC | `178-496-3045` (Thiago Rissutto Acesso MCC) | Administra as 2 contas vivas. `868-104-2744` cancelada, fora do MCC |
| Ads ECOMM | `892-523-1246` · BRL · America/Sao_Paulo · auto-tagging ON · tag `AW-11353612462` | 3 campanhas ativas. Meta "Compras" com **uma** principal: `Compra Flow (upload)` (UPLOAD_CLICKS via Data Manager; 132 conv / R$ 53,9 mil em 30d; última 13/09). `[GA4] purchase` (6657542368) recebe de novo desde 27/08 e está **secundária** — sem dobra. Modelo de URL: `utm_source=google&utm_medium=cpc&utm_campaign={_campanha}&utm_id={campaignid}` |
| Ads LOJAS | `956-499-8046` · tag `AW-878832356` · 14 PMax + 10 Search de cidade · geo PRESENCE · raios 6–20 km | Metas por campanha = GET_DIRECTIONS + STORE_VISIT (Maximizar conversões). 17 location assets (14 `LURDS-nn`). **Antes**: `[GA4] purchase` (880806912) e `Compra [OK]` (6502913908) principais + coluna Conversões; modelo de URL com parâmetros indefinidos |
| GA4 | propriedade `281252588` · fluxos `G-YH69KP0Z8X` (site novo) e `G-WG47PQ059F` (WordPress) | Site manda hits **só** para `G-YH69KP0Z8X` (provado por `tid` no `/g/collect`). Fluxo do WP: 5.055 usuários em 28d (17–19/08, antes da virada) e **1 usuário nos últimos 7 dias** — está morto, é resíduo. Eventos principais: `add_to_cart`, `begin_checkout`, `purchase` |
| GTM | `GTM-PTFZN3DT` (WP, órfão) · `GTM-TF87P3T` (SERVER) · `GTM-KMGWZ7L` (desativado) · `GTM-NWTFDTQ` (LPs Locais) | O site **não usa GTM**: gtag direto, ids por env |
| Merchant | `496061684` · fonte principal `/feed/google.xml` (897 itens em 14/09) · inventário local `/feed/google-local.xml` (12.530 linhas, 14 lojas) | 945 produtos: 0 aprovados, **944 limitados**, 1 reprovado. O "limitado" é **"Avaliação inicial pendente" do inventário local** (LIA "Verificar inventário" = Em análise desde 27/08); online continua aparecendo |
| Search Console | `sc-domain:lurds.com.br` | 2,41 mil indexadas · 17,6 mil não (404 3.702 · canônica alternativa 3.512 · redirect 2.771 · cópia sem canônica 1.457 · robots 1.088). Sitemap 791 URLs lido 09/09. CWV mobile: 238 URLs "precisam melhorar" (INP), desktop 239 ok |
| Meu Negócio | 15 fichas: 14 lojas com `LURDS-nn` confirmadas + "Esquina 013" (não é loja) | Duplicatas de 23/08 já saíram |

### Tracking no código (o que estava, antes das correções)

- Consent Mode v2 completo: `default` negado inline no `<head>`, `update` no banner (8 s), 3 posturas (`aceitou` / `nao_decidiu` / `recusou`). **Modo básico**: gtag só carregava com aceite de *Análise* (~15% das sessões).
- Eventos GA4 no navegador: `view_item_list`, `select_item`, `view_item`, `add_to_cart`, `remove_from_cart`, `view_cart`, `begin_checkout`, `add_shipping_info`, `add_payment_info`. `item_id` = REF (o mesmo `g:id` do feed). `purchase` e `refund` são **server-only** (Measurement Protocol, `client_id` do cookie `_ga`, `transaction_id` = UUID do pedido).
- Google Ads: nenhum `send_to` no navegador (por desenho — PIX paga horas depois). Conversão sobe pelo servidor: `GoogleAdsConversaoService` → Data Manager `events:ingest` com `gclid` + e-mail/telefone SHA-256, `transactionId` = `LP-nnnnnn`. **636 de 636** pedidos pagos em 30d enviados, 0 erro.
- `gclid` capturado; **`gbraid`/`wbraid` não**.
- Checkout 100% first-party (sem cross-domain, sem iframe de pagamento). Nenhum secret no cliente.

## 2. Achados e correções

| # | Sev. | Sistema | Problema (evidência) | Causa raiz | Correção | Validação | Status |
|---|---|---|---|---|---|---|---|
| 1 | 🔴 | Ads LOJAS | `[GA4] purchase` e `Compra [OK]` PRINCIPAIS na coluna Conversões; meta padrão `PURCHASE~WEBSITE` biddable na conta. Nenhuma campanha ativa usa PURCHASE (todas sobrescrevem com GET_DIRECTIONS + STORE_VISIT) — risco latente para campanha nova / que volte ao padrão | Herança do WP + import do GA4 vinculado em 2022 | `primary_for_goal=false` nas duas (script, passo A) | API: `880806912:primary=false 6502913908:primary=false` | ✅ aplicado 14/09 |
| 2 | 🔴 | Consent | gtag só carregava com aceite de Análise; quem aceitava só Publicidade não recebia tag do Ads; GA4 pedia "reconfigure o consent mode". 85% do funil invisível | Destino `ga4` gateado por categoria única, modo básico | Consent Mode **avançado só para quem não decidiu** (`googlePodeCarregar`): tag carrega com tudo negado; recusou = zero. Rollback `NEXT_PUBLIC_CONSENT_MODE_AVANCADO=0` | Produção, visitante novo sem decisão: `gcs=G100`, `gcd=13p3p3p3p5l1`, `/g/collect tid=G-YH69KP0Z8X` e `ccm/collect tid=AW-11353612462`, **sem** `1p-user-list` (sem cookie de remarketing) | ✅ PR #1205 |
| 3 | 🔴→🟢 | GA4 | Fluxo do WP "recebendo tráfego nas últimas 48 h" | 1 usuário/7 dias (Explore por Nome do stream); 5.055 em 28d são de 17–19/08 | Nenhuma — resíduo. Não apagar (histórico). Site prova por `tid` que não envia pra lá | Explore 07–13/09: site novo 3.583 mobile / 367 desktop; WP 1 / 0 | ✅ diagnosticado |
| 4 | 🟠 | Purchase | Aviso backend→site era fire-and-forget sem carimbo nem retry: timeout = venda sem purchase em nenhuma plataforma | `notificarEcommerce` não persistia resultado | `Order.purchaseNotificadoEm` + `purchaseNotificadoTentativas`; `LojaPurchaseRetryService` (10 min, 2 min–3 dias, 5 tentativas, 20/ciclo). GA4 deduplica por `transaction_id`, Meta por `event_id`, Ads por `transactionId` | Colunas em produção; **660 pedidos anteriores ao deploy carimbados** (`= paid_at`) antes da 1ª rodada — 0 reenvios | ✅ PR #1205 |
| 5 | 🟠 | Merchant/LIA | 944 "limitados" = inventário local em "Avaliação inicial pendente" + "Verificar inventário: Em análise" desde 27/08 | Verificação depende do Google (e-mail de contato confirmado 13/09) | Nenhuma em código. Acompanhar `/mc/lia/setup?a=496061684&country=BR`; se não vier e-mail, "entre em contato com o suporte" na mesma tela | Item de produto: "aparecendo no Google, visibilidade limitada" | ⏳ Google |
| 6 | 🟠 | Atribuição | `gbraid`/`wbraid` (iOS/ITP) não capturados: clique pago de iPhone virava "orgânico" | `identity.ts` só lia `gclid`; zod podava; sem coluna | Capturados ponta a ponta: `identity.ts` → `schemas.ts` → `Order.gbraid/wbraid` → `adIdentifiers` no Data Manager; fila e alarme aceitam os dois; cascata e carrinho abandonado tratam como Google/pago | tsc/vitest/jest ok; diff Prisma contra produção: só ADD COLUMN | ✅ PR #1205 |
| 7 | 🟡 | Ads LOJAS | Modelo de URL `{lpurl}?utm_source={_origem}&utm_medium={_midia}&utm_campaign={_campanha}&utm_content={_conteudo}` com parâmetros que ninguém define → `utm_source=&utm_medium=` vazios (GA4 "Unassigned", 71 sessões no dia) e sem `utm_id` | Template herdado da agência | Conta → `{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={_campanha}&utm_id={campaignid}` (passo B, aplicado). Passo C (parâmetro `_campanha` em 77 campanhas + zerar template próprio de 7 PMax) **precisa rodar** (classificador bloqueou a 2ª execução) | API: modelo da conta conferido | ⚠️ C pendente |
| 8 | 🟡 | Eventos de loja | `whatsapp_click`/`instagram_click`/`phone_click` sem `city`/`store_id` | Helpers recebiam só o nome da unidade | Helpers aceitam o objeto da loja → `store_id` (código Flow) + `city`. Dimensões GA4 criadas: `store_id`, `city`, `source` | Vitest/tsc/eslint ok; dimensões visíveis no Admin | ✅ PR #1205 |
| 9 | 🟡 | GA4 | `purchase` sem `shipping` (frete somado à receita de produto) | Payload do webhook não levava frete | Backend manda `shipping`; zod declara; `trackPurchase` põe em `params` | jest/vitest ok | ✅ PR #1205 |
| 10 | 🟡 | SEO | `/logo.svg` (logo da Organization) e `/og/default.jpg` (OG padrão) respondem 404; URLs legadas com barra final fazem 2 saltos (308+308); 1.457 "cópia sem canônica" e 1.088 bloqueadas por robots (a conferir amostra) | Assets nunca criados; redirects encadeados | **Não corrigido** — depende de arte (logo) e de amostra da GSC; redirects 308 estão corretos para SEO (equivalem a 301) | — | ⏸ pendente |
| 11 | 🔵 | GA4 | 4 contas Ads vinculadas, incluindo `868-104-2744` (cancelada) e `490-847-6198` (fora do MCC) | Legado | Desvincular a cancelada pela interface (Admin → Contas vinculadas do Google Ads) | — | ⏸ pendente |
| 12 | 🔵 | Ads ECOMM | 5 ações `[OK]` do WP ENABLED (`Visualização de Produto [OK]` 3.214/30d) poluem "todas as conversões" | API não aceita `HIDDEN` | Deixar; não entram na coluna Conversões | — | ℹ️ |
| 13 | 🔵 | Ads LOJAS | `Store visits` a R$ 249 fixos infla o ROAS (ticket mediano R$ 243, conversão de visita bem menor) | Decisão de valor | Recomendação R$ 90–150; **decisão do dono** | — | ℹ️ |

## 3. Purchase — prova de correção

- **Momento**: só em `confirmarPagamento` (backend), depois do `order.paid`/`charge.paid` da Pagar.me, cartão aprovado inline ou reconcile — lock atômico em `paidAt` (`updateMany … paidAt: null`). PIX gerado, pedido criado ou cartão recusado **não** disparam nada.
- **Idempotência**: UUID do pedido como `transaction_id` (GA4 deduplica), `event_id = purchase-<uuid>` (Meta), `transactionId = LP-nnnnnn` (Ads), e agora carimbo persistente no banco.
- **Comparação 28d (17/08–13/09)**: GA4 653 compras / R$ 141 mil; Flow 30d (14/08–13/09) 636 pagas / R$ 134,7 mil; Ads `Compra Flow (upload)` 132 (é o que o Google atribui a clique dele, não o total). Diferença GA4 × Flow ≈ 2,7% — janelas diferentes (o GA4 inclui 17–19/08 do WP).

## 4. Arquitetura final

```
GOOGLE ADS (ECOMM 892-523-1246 · LOJAS 956-499-8046)
   ↓ auto-tagging: gclid | gbraid | wbraid  +  utm_source=google&utm_medium=cpc&utm_id={campaignid}
LURDS.COM.BR (Next.js 15)
   ↓ identity.ts (atribuição 30d em localStorage)  →  Event Manager  →  dataLayer (espelho)
   ├─ navegador: gtag direto  ─→ GA4 G-YH69KP0Z8X (page_view … add_payment_info)
   │                          ─→ AW-11353612462 + AW-878832356 (remarketing; sem send_to)
   │     Consent Mode v2: aceitou = tudo · não decidiu = pings sem cookie · recusou = nada
   ├─ /api/events (BFF)  ─→ Meta CAPI · site_eventos · site_store_clicks (primeira parte, sempre)
   └─ checkout  ─→ FlowOps (Order.gclid/gbraid/wbraid/utm*, ga4_client_id)
FLOWOPS (NestJS)
   ↓ Pagar.me webhook → paidAt (atômico)
   ├─ /api/webhooks/payment → purchase server-side → GA4 MP + Meta CAPI (carimbo + retry 10 min)
   └─ GoogleAdsConversaoService (37 * * * *) → Data Manager events:ingest
        (gclid/gbraid/wbraid + e-mail/telefone SHA-256, transactionId LP-nnnnnn)
        → Compra Flow (upload) = ÚNICA principal da meta Compras (ECOMM)
GA4 → Ads: [GA4] purchase importado como SECUNDÁRIA nas duas contas (referência, não lance)
```

## 5. Lista final de conversões

**ECOMM (892-523-1246)** — Principal: `Compra Flow (upload)` (7731356807). Secundárias: `[GA4] purchase`, `[GA4] add_to_cart`, `[GA4] begin_checkout`, ações `[OK]` do WP (histórico).

**LOJAS (956-499-8046)** — Principais (por campanha): `Store visits`, `Local actions - Directions`. Secundárias: `[GA4] purchase` e `Compra [OK]` (desde 14/09), ações `[OK]`, `Local actions - Website visits/Other engagements`.

## 6. Atribuição offline (projeto, não implementado)

O encanamento já existe: `Order.gclid/gbraid/wbraid` + `GoogleAdsConversaoService` (Data Manager). Para venda de LOJA:
1. Lead identificado: `whatsapp_leads` (carimbo "vim pelo site · loja X") já liga clique → pessoa; guardar o id de clique junto do lead (hoje só a plataforma vai pra `site_eventos`, por desenho anônimo).
2. Venda no PDV (`pdv_sales` tem CPF/telefone/e-mail) → evento `STORE_SALES` / conversão de upload com `userData` hasheado (o mesmo `hash.ts`), `eventSource: IN_STORE`, ação de conversão nova na conta LOJAS (tipo upload). Cron irmão do de e-commerce.
3. Janela: 90 dias de clique; deduplicar por `pdv_sales.id` como `transactionId`.

## 7. Validação pós-deploy (14/09, 11:45–11:55 BRT)

- Backend: `/api/health` uptime 81 s após o merge; colunas `gbraid`, `wbraid`, `purchase_notificado_em`, `purchase_notificado_tentativas` presentes; sem erro no log de boot.
- Site: visitante novo (sem decisão) → gtag carregado, `gcs=G100`, hits para `G-YH69KP0Z8X` e `ccm/collect` do Ads, **nenhum** `1p-user-list`.
- Testes: ecommerce vitest 11 arquivos / 101 testes; backend jest `google-ads-conversao` 31/31; `tsc --noEmit` limpo nos dois; eslint limpo.

## 8. Pendências (em ordem)

1. Rodar o passo C do script de LOJAS (PowerShell): `railway run --service flowops-lite node backend/scripts/google-ads-lojas-correcoes-medicao.js`.
2. LIA: acompanhar a verificação do inventário (e-mail do Google ao contato).
3. `/logo.svg` e `/og/default.jpg` (arte) · amostra dos "cópia sem canônica" na GSC.
4. Desvincular `868-104-2744` do GA4.
5. Valor de `Store visits` (R$ 249) — decisão do dono.
