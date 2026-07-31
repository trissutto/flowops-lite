# Data Layer

Data Layer **próprio**, em `src/lib/tracking/data-layer.ts`. A spec é explícita: nunca depender exclusivamente do GTM.

## Por que não usar só o `window.dataLayer`

Bloqueador de anúncio derruba o `gtm.js` numa fatia grande do tráfego. Quando o histórico mora dentro do GTM, o site fica sem nada pra depurar justamente nas sessões que já estavam com problema. Aqui o histórico é nosso: vive em memória (últimos 200 eventos), alimenta o painel de debug e continua existindo com todo script de terceiro bloqueado.

O espelho pro `window.dataLayer` é de **mão única e opcional**: se o GTM estiver lá, recebe; se não, nada acontece. Nunca lemos de volta.

## Inspecionar no console

```js
window.lurdsDataLayer            // últimos eventos, do mais antigo pro mais novo
window.lurdsDataLayer.at(-1)     // o último
```

## Envelope

Todo evento tem exatamente esta forma:

```jsonc
{
  "event": "add_to_cart",
  "event_id": "3f2a…",            // UUID — casa Pixel e CAPI
  "timestamp": "2026-07-30T18:04:11.238Z",
  "source": "browser",            // ou "server"
  "value": 389.90,
  "cupom": "INVERNO10",
  "transaction_id": "…",          // só em purchase/refund
  "context": { … },
  "params": { … },                // específico do evento
  "items": [ … ]
}
```

### `context`

| Campo | Observação |
|---|---|
| `session_id` | morre em 30 min de inatividade (mesma janela do GA4) |
| `anonymous_id` | o aparelho, ~2 anos no localStorage |
| `user_id` | a pessoa; só existe após login, vem do CRM |
| `page` | `path`, `url`, `title`, `referrer` |
| `device` | `mobile`/`tablet`/`desktop` pela **largura**, não pelo user-agent |
| `attribution` | `source`, `medium`, `campaign`, `term`, `content`, `gclid`, `fbclid` |
| `loja` | loja física atribuída por CEP — liga o online ao acerto entre lojas |
| `currency` / `language` / `country` | `BRL` / `pt-BR` / `BR` |

**Atribuição é capturada uma vez por sessão**, na primeira página. Reescrever a cada navegação apagaria a campanha no primeiro clique interno, e toda venda viraria "direto".

**Aparelho é classificado por largura** porque UA mente — iPad se apresenta como Mac há anos. Os cortes são os mesmos breakpoints do Tailwind do projeto, então "mobile" no relatório é literalmente o layout que a cliente viu.

### `items`

```jsonc
{
  "product_id": "1234",
  "sku": "VST-001",
  "name": "Vestido Midi Linho",
  "categoria": "Vestidos",
  "colecao": "Inverno 26",
  "tecido": "Linho",
  "cor": "Areia",
  "tamanho": "48",
  "quantidade": 1,
  "valor": 299.90,      // preço PAGO, já com desconto
  "desconto": 90.00,
  "index": 3,           // posição na vitrine de onde saiu o clique
  "list_name": "Categoria · Vestidos"
}
```

Duas regras que quebram dinheiro se forem furadas:

1. **`valor` é o preço pago**, não o cheio. Mandar o cheio infla o ROAS e a campanha parece melhor do que é.
2. **`valor` é número.** Preço com vírgula chegando em plataforma de anúncio vira `NaN` em silêncio e a receita some do relatório sem ninguém notar.

`tecido`, `colecao`, `cor` e `tamanho` não existem no padrão de nenhuma plataforma — são os campos que respondem as perguntas que só a Lurd's faz. No GA4 aparecem como dimensões customizadas (precisam ser registradas no painel).
