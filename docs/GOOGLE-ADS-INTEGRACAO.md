# Google Ads no relatório — o que falta e como ligar

**Por que isto existe.** Em 22/08/2026 a tela `/retaguarda/cliques-lojas` mostrava
o Meta com `R$ 1,7 mil → R$ 6,6 mil · 3,97x` e o Google com um número solto de
`R$ 210`. Aquele número solto **não era gasto: era receita**. O Google estava
cego por **duas** faltas independentes — e cada uma tem um conserto diferente.

| Falta | Sintoma na tela | Conserto | Quem faz |
|---|---|---|---|
| Não existia integração com o Google Ads | pílula sem `→` e sem ROAS | espelho `google_ads_gasto_dia` (este PR) | ✅ código pronto, falta credencial |
| O link do Google não carrega `utm_id` | receita do Google ≈ zero | `utm_id={campaignid}` no sufixo de URL final | 🔧 painel do Google Ads |

O código dos dois lados já subiu. O que resta são **as credenciais** (parte 1) e
**um campo no painel do Google Ads** (parte 2).

---

## Parte 1 — as credenciais (Railway)

São três coisas diferentes e é fácil confundir uma com a outra.

### 1.1 Token de desenvolvedor (o passo mais demorado)

No **centro de clientes (MCC)**, não na conta do e-commerce:
`Ferramentas e configurações → Configuração → Central de API`.

- Se aparecer um token com nível **"Acesso de teste"**, ele **não lê conta de
  produção** — só contas de teste. É preciso pedir **acesso básico**, que passa
  por análise do Google (formulário sobre o uso da API). É o passo que pode
  levar dias.
- O token é do MCC e vale para todas as contas abaixo dele.

→ `GOOGLE_ADS_DEVELOPER_TOKEN`

### 1.2 OAuth — quem autoriza a leitura

Em [console.cloud.google.com](https://console.cloud.google.com):

1. Criar (ou escolher) um projeto.
2. `APIs e serviços → Biblioteca` → habilitar **Google Ads API**.
3. `Tela de permissão OAuth` → tipo **Externo** → preencher o mínimo.
   ⚠️ **PUBLICAR o app (status "Em produção").** Enquanto ficar em **"Teste"**,
   o refresh token **expira em 7 dias** e a coleta morre em silêncio uma semana
   depois de tudo parecer funcionando.
4. `Credenciais → Criar credenciais → ID do cliente OAuth` → tipo **Aplicativo da
   Web** → em URIs de redirecionamento autorizados, incluir
   `https://developers.google.com/oauthplayground`.

→ `GOOGLE_ADS_CLIENT_ID` e `GOOGLE_ADS_CLIENT_SECRET`

Para o refresh token, em
[developers.google.com/oauthplayground](https://developers.google.com/oauthplayground):

1. Engrenagem (canto superior direito) → marcar **Use your own OAuth
   credentials** → colar o client id e o secret.
2. Passo 1: digitar o escopo `https://www.googleapis.com/auth/adwords` →
   **Authorize APIs** → entrar com a conta Google **que tem acesso ao Google Ads**.
3. Passo 2: **Exchange authorization code for tokens** → copiar o
   **`refresh_token`** (o `access_token` não serve, vale 1 hora).

→ `GOOGLE_ADS_REFRESH_TOKEN`

### 1.3 As contas

⚠️ **Conferir o id antes de colar.** A conexão do Google (`trissutto@gmail.com`)
lista **três** contas, e nenhuma delas é o `1458258153` que aparece em anotações
anteriores — esse número é, muito provavelmente, o **MCC**, não a conta:

| `customer_id` | Nome |
|---|---|
| `8681042744` | Lurds Ecomm - 2024 |
| `8925231246` | Lurds Plus Size - Ecomm |
| `9564998046` | Lurds Plus Size - Lojas físicas |

- `GOOGLE_ADS_CONTAS` — `customer_id` **sem hífen**, separados por vírgula. Pôr a
  conta do e-commerce que está gastando hoje (conferir no painel qual das duas
  primeiras é a viva); dá pra listar as três, e aí o relatório passa a enxergar
  também a conta das lojas físicas.
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` — o id do MCC, sem hífen (provavelmente
  `1458258153`). Só é necessário se a conta acima estiver **dentro** de um centro
  de clientes; mandar um MCC que não é o pai dela dá erro de permissão, não é
  ignorado.
- `GOOGLE_ADS_API_VERSION` — opcional. Padrão `v25`. Cada versão vive ~1 ano e
  depois o endpoint devolve **404 seco**; quando isso acontecer, subir a versão
  aqui resolve sem deploy de código.

### 1.4 Conferir na hora (sem esperar o cron)

O cron roda de hora em hora e **engole o erro de propósito** — métrica não pode
derrubar o backend. Para ver a resposta do Google na cara, logado como admin:

```bash
curl -X POST "https://SEU-BACKEND/site-metrics/google-ads/sync?dias=7" -H "Authorization: Bearer SEU_JWT"
```

- `{"ok":true,"linhas":N}` → gravou N linhas (campanha × dia). A tela já mostra.
- `{"ok":false,"erro":"..."}` → o erro do Google vem inteiro. Os três mais comuns:
  - `DEVELOPER_TOKEN_NOT_APPROVED` → parou no 1.1 (ainda é token de teste).
  - `invalid_grant` no OAuth → refresh token revogado, ou a tela de permissão
    ficou em "Teste" e ele venceu (1.2, passo 3).
  - `USER_PERMISSION_DENIED` → `GOOGLE_ADS_LOGIN_CUSTOMER_ID` errado ou ausente.

---

## Parte 2 — o `utm_id` (painel do Google Ads)

Esta parte é independente da parte 1 e **não precisa de API nenhuma**. Sem ela,
o gasto aparece mas a **nossa** receita continua sem casar com campanha.

**Por quê.** A receita da tela sai de `orders.utm_id`, que casa com o **id da
campanha**. O Meta preenche `utm_id={{campaign.id}}` sozinho no link. O Google,
com auto-tagging, entrega só o **`gclid`** — e `gclid` identifica uma *pessoa*,
então o site guarda o fato (`pago=true`) e a plataforma, nunca o id. Sem
`utm_id`, `Order.utmId` fica `NULL`, e em Postgres `NULL = NULL` nunca casa.

**O conserto.** Na conta do e-commerce (ver 1.3):
`Configurações → Configurações da conta → Sufixo do URL final`, acrescentar:

```
utm_id={campaignid}
```

Se já houver sufixo, juntar com `&` e não apagar o que está lá. Vale também
conferir campanha a campanha — sufixo definido no nível da campanha **substitui**
o da conta, não soma.

⚠️ **Não retroage.** Só passa a valer nos cliques a partir do momento em que
entrar. Pedido antigo continua sem `utm_id` para sempre.

### 2.2 O `utm_source` com o nome da campanha dentro

Na tela de 22/08 apareciam, no degrau **ORIGEM** (que é plataforma),
`Google_Pmax_Feeds_Petter` e `Google_Shopping_Novidades_Petter`. Isso é o **nome
da campanha escrito no `utm_source`** de algum anúncio — `utm_source` responde
"de que plataforma veio", `utm_campaign` responde "de que campanha".

O relatório **já não quebra mais por causa disso** (a normalização dobra qualquer
`utm_source` que contenha "google" para `google`, e o mesmo texto vale no filtro),
mas a etiqueta segue errada na origem e vale consertar:

| Parâmetro | Certo | O que está no ar em alguns anúncios |
|---|---|---|
| `utm_source` | `google` | `Google_Shopping_Novidades_Petter` ❌ |
| `utm_medium` | `cpc` | — |
| `utm_campaign` | o nome da campanha | ok |
| `utm_id` | `{campaignid}` | ausente ❌ (2.1) |

Sufixo completo recomendado para a conta:

```
utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_id={campaignid}
```

⚠️ Sufixo definido na **campanha** substitui o da **conta** — conferir campanha a
campanha se alguma tem sufixo próprio, senão o da conta nunca chega naquele
anúncio.

> **Isto não dá para fazer daqui.** A conexão do Google Ads disponível nesta
> sessão (Supermetrics) está com o trial expirado desde 18/07/2026 — só lê e
> escreve com assinatura ativa. Enquanto isso, os dois consertos da parte 2 são
> no painel, na mão.

---

---

## Parte 3 — a conversão volta pelo servidor (o conserto de 19/08)

**O que quebrou.** Em 19/08/2026 às 09:00 a conta parou de registrar conversão.
As DUAS ações morreram no mesmo minuto: a `Compra [OK]`, disparada pelo Tag
Manager do WordPress (que morreu quando o site novo assumiu `lurds.com.br`), e o
import `[GA4] (web) purchase`, que é a ação **principal**. Três dias de campanha
em ROAS desejado otimizando às cegas — e o robô não corta o gasto quando perde o
sinal, corta a entrega: o Shopping caiu de 487 para 127 cliques/dia.

**Por que tag no navegador não resolve.** `purchase` é `SERVER_ONLY_EVENTS` no
site, de propósito: evento de compra disparado pelo navegador é forjável, e o
PIX é pago horas depois, sem navegador aberto. A conversão tem que sair do
servidor.

**O que passou a existir.** `GoogleAdsConversaoService` — cron de 10 min que sobe
as vendas pagas via `uploadClickConversions`, casando pelo **`gclid`**:

- `Order.gclid` — o id do clique, que **já chegava** no checkout dentro de
  `attribution` e era descartado (o backend lia só o `attr.id`).
- `Order.adsConversaoEnviadaEm` — idempotência nossa. O Google também deduplica
  por `orderId`, mas depender da garantia do outro é o erro que o outbox do PDV
  não comete com o Giga.
- `partialFailure: true` + carimbo **por índice**: a linha recusada volta na
  próxima rodada em vez de sumir.
- Hora da conversão = `paidAt` (não `createdAt`), com fuso explícito.

### 🚨 A ação de conversão tem que ser do tipo `UPLOAD_CLICKS`

A doc é categórica: *"The conversion action must have a `type` of
`UPLOAD_CLICKS`."* A `Compra [OK]` (6807548872) nasceu como conversão de **site**
(gtag/GTM), então é `type=WEBPAGE` e recusa **100%** do lote com
`INVALID_CONVERSION_ACTION_TYPE` — sempre, para sempre. E a recusa é
**silenciosa**: HTTP 200 com `results` cheio de objetos vazios.

**Criar a ação certa:** Ferramentas → Conversões → **Nova ação de conversão** →
**Importar** → Outras fontes de dados ou CRM → **Acompanhar conversões de
cliques**. Nasce `UPLOAD_CLICKS`. É ação NOVA — não dá para converter a antiga.

⚠️ Ação recém-criada só aceita upload **6 horas depois** de existir
(`TOO_RECENT_CONVERSION_ACTION`). Criar hoje, ligar amanhã.

O serviço confere o tipo antes do primeiro envio (1 operação) e **se recusa a
arrancar** se estiver errado — o log diz exatamente o quê.

Envs: `GOOGLE_ADS_CONVERSAO_ACTION_ID` (a ação UPLOAD_CLICKS nova),
`GOOGLE_ADS_CONVERSAO_CONTA` e o kill-switch `GOOGLE_ADS_CONVERSAO_UPLOAD`.

### A ordem de ligar

**1. Validar sem gravar nada** (`validateOnly` da API — o Google confere e não
registra):

```bash
curl -X POST "https://SEU-BACKEND/site-metrics/google-ads/conversoes?validar=1" -H "Authorization: Bearer SEU_JWT"
```

**2. Só depois, valendo:**

```bash
curl -X POST "https://SEU-BACKEND/site-metrics/google-ads/conversoes" -H "Authorization: Bearer SEU_JWT"
```

### O que o nível do token permite

`Acesso às Análises` no painel é o **Explorer** da documentação (a versão pt-BR
chama de "acesso de exploração"). Ele **alcança contas de produção** e **não é
somente-leitura** — `ConversionUploadService` não está entre os serviços
restritos. O gargalo é outro: **2.880 operações/dia**, em janela deslizante de
24h, **compartilhadas entre leitura e escrita**. Por isso o cron de conversão é
de hora em hora, e não de 10 em 10 minutos: cada ciclo a mais é cota a menos
para o espelho de gasto, e `RESOURCE_EXHAUSTED` derrubaria os dois. Basic Access
sobe para 15.000/dia e leva ~5 dias úteis.

⚠️ **Corte de 15/06/2026:** o Google passou a recusar `UploadClickConversions`
de developer token que **nunca** subiu conversão offline antes dessa data,
mandando usar a **Data Manager API**. Como este token nasceu depois, é possível
que caia nesse corte — o passo 1 (validar) responde isso sem sujar a conta.

⚠️ **Só vale daqui pra frente.** Pedido fechado antes deste deploy não tem
`gclid` gravado e não há como recuperá-lo.

⚠️ **Depois que estiver enviando, a ação que recebe o upload vira principal** —
e a do GA4, secundária. Duas principais medindo a mesma compra contam em dobro.

## O que NÃO vai bater — e está certo assim

Depois de tudo ligado, a tela mostra dois números de conversão para o Google, e
eles **vão divergir**:

| | O que o Google conta | O que a nossa tela conta |
|---|---|---|
| Quando | no dia do **clique** (retroativo, até 90 dias) | no dia do **pedido** |
| O quê | inclui view-through e conversões modeladas | só pedido **pago** no caixa |
| Atribuição | modelo do Google (data-driven) | último clique, janela de 30 dias |

Por isso o espelho guarda `conversoes` e `valor_conversoes` **junto** com o
gasto: a divergência é informação (quanto o Google está inflando ou quanto a
gente está perdendo de atribuição), não defeito. Defeito seria uma das duas
sumir — que é exatamente o que acontecia até aqui.

## Onde mora no código

- `backend/src/site-metrics/google-ads.service.ts` — coleta, OAuth, cron `17 * * * *`
- `backend/prisma/schema.prisma` → `model GoogleAdsGastoDia`
- `backend/src/site-metrics/site-metrics.service.ts` → `segmentosDisponiveis()`
  (une os dois espelhos e casa com `orders`)
- `frontend/src/app/retaguarda/cliques-lojas/page.tsx` → as pílulas da cascata
