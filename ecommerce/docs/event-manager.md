# Event Manager

`src/lib/tracking/event-manager.ts` — o único caminho de saída de evento.

## Ordem das operações

1. **Recusa server-only.** `purchase` e `refund` chegando do navegador são descartados com aviso no console. Ver [purchase.md](./purchase.md).
2. **Monta o envelope.** `event_id` (UUID), timestamp ISO e o contexto completo (sessão, aparelho, atribuição, loja).
3. **Valida** contra o schema Zod. Evento fora da taxonomia ou item com preço negativo não passa — de propósito: taxonomia que aceita qualquer coisa vira sopa de letrinha em seis meses.
4. **Deduplica.**
5. **Empurra pro Data Layer** — sempre, mesmo sem consentimento. É dado de primeira parte e é o que sustenta o painel de debug.
6. **`queueMicrotask`** → destinos de navegador + fila do servidor.

Os passos 1–5 são síncronos e baratos. O 6 é onde mora tudo que pode demorar.

## Deduplicação

| Caso | Chave | Janela |
|---|---|---|
| Com `transaction_id` | `evento:transaction_id` | **infinita** — pedido nunca repete |
| Com `dedupe_key` explícita | a chave dada | 1s |
| Padrão | `evento:path:params:itens` | 1s |

A janela de 1s mata clique duplo e o duplo-render do React em modo estrito. Os itens entram na chave por `product_id/tamanho/cor` — adicionar o 48 e depois o 52 são dois eventos, como devem ser.

Memória: 100 chaves, descarte do mais antigo.

## Fila do servidor

- Descarrega a cada **5s**, ou ao juntar **20 eventos**, ou quando a aba some.
- Teto de **200** eventos retidos; estourou, descarta o mais **velho** (evento recente vale mais, e crescer sem limite trava a aba).
- Falha → backoff **1s, 2s, 4s**, até 4 tentativas. Depois desiste e loga erro.
- `visibilitychange: hidden` e `pagehide` → `navigator.sendBeacon`, o único método que o navegador garante entregar com a aba fechando. Em troca, não dá pra saber se chegou nem repetir.

> ⚠️ A fila vive na memória da aba. Fechou o navegador com eventos pendentes que o beacon não pegou, perdeu. Ver [limitacoes.md](./limitacoes.md).

## Orçamento de performance

A spec pede menos de 5ms na navegação. O que roda no mesmo tick da interação: montar o envelope (leitura de storage e DOM) e validar (Zod sobre objeto pequeno). Script de terceiro, rede e serialização de lote saem no microtask.

Consequência prática: `track()` nunca é `await`. Se você viu um `await track(...)`, está errado.

## Destinos de navegador

Cada um declara a categoria de consentimento que exige. O Event Manager:

- pula quem não tem consentimento (log `skipped` com o motivo);
- pula quem não aceita aquele evento;
- inicializa sob demanda quem foi liberado depois (aceitar cookies não exige recarregar a página).

**Não há retry no navegador.** Script bloqueado por adblock continua bloqueado no próximo tick — insistir só gasta bateria. Quem garante a entrega nesse caso é a perna servidor.

## Testes

`src/lib/tracking/tracking.test.ts` — 16 casos cobrindo purchase forjado, dedup, gate de consentimento, preço promocional e atribuição.

```bash
npm test
```
