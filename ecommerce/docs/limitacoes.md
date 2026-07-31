# Limitações conhecidas — leia antes de confiar

A Sprint 007 entregou a arquitetura. Três coisas da spec ficaram **parciais por limite de infraestrutura**, não por esquecimento. Estão listadas aqui em vez de escondidas atrás de um check verde.

## 1. "Nunca perder evento" tem asterisco

**O que existe:** fila no navegador com backoff (1s, 2s, 4s), `sendBeacon` quando a aba fecha, e retry de 2 tentativas dentro da requisição do servidor.

**O que não existe:** fila **durável**. Uma função serverless na Vercel morre quando a resposta termina e leva junto qualquer `setTimeout`. Se a Meta estiver fora do ar por 10 minutos, os eventos daquele período viram log de erro — não são reenviados depois.

**Como fechar:** implementar `EventQueueStore` (interface já escrita em `server/dispatch.ts`) sobre Postgres, Upstash Redis ou QStash, e trocar a chamada em `dispatchBatch`. Nada mais no código muda. Estimativa: meio dia.

## 2. Logs em memória

**O que existe:** anel de 1.000 registros por instância + uma linha JSON estruturada no stdout em produção (o Vercel captura isso de forma durável e pesquisável).

**O que não existe:** a "tabela completa de logs" da spec. Instâncias serverless não compartilham memória, então o painel mostra o que caiu naquela instância — bom pra depurar, insuficiente pra auditoria de 30 dias.

**Como fechar:** implementar `LogStore` (interface em `server/log-store.ts`) sobre uma tabela `tracking_dispatch_log` com índice em `(created_at, destination, status)`. Uma linha muda em `getLogStore()`.

## 3. Idempotência do purchase é de duas camadas, não três

**O que existe:** `event_id` derivado do `transaction_id` (webhook repetido gera o mesmo id, e a Meta deduplica) + um guard em memória por `orderId` em `/api/webhooks/payment` que barra a rajada de retry.

**O que não existe:** trava no banco **deste lado**. O guard vale por instância serverless.

**Na prática:** a deduplicação da própria Meta já resolve o caso real (retry entre instâncias). Desde a sprint 011 o pedido vive no Postgres do backend, então a trava definitiva pode virar uma coluna `purchaseTrackedAt` lá — o backend saberia parar de reenviar o webhook em vez de o ecommerce ter que se defender.

## 4. Plataformas preparadas, não ligadas

TikTok, Microsoft Ads/Clarity e os webhooks de saída estão como a spec pediu — **arquitetura preparada**. O código existe, o destino está registrado, e liga com uma variável de ambiente. Nenhum foi testado contra a plataforma real, porque não há conta configurada.

## 5. Os 5ms

O orçamento vale pro trabalho **síncrono** de `track()`: montar o envelope e validar. Despacho, rede e serialização saem em `queueMicrotask`. Não medi com o site em produção sob carga — a medição real entra quando houver tráfego.

---

Nada aqui impede a Sprint 007 de ir pra produção. São dívidas conhecidas, com o caminho de saída escrito. O que não pode acontecer é alguém assumir que a fila é durável e descobrir o contrário num dia de campanha.
