# Painel de debug

`/debug/tracking` — protegido por token, `noindex`, fora do chrome da loja.

```bash
TRACKING_DEBUG_TOKEN=algo-longo-e-aleatorio
```

Sem a variável, a rota responde **404 em produção**: ela não existe pra quem não deveria saber que existe. Em desenvolvimento abre sem token.

O log contém evento, destino, erro e id de sessão — suficiente pra mapear o comportamento de visitantes reais. Aberto, seria vazamento de dado comportamental.

## As duas listas

A tela mostra **servidor** e **navegador** lado a lado. A diferença entre elas é o diagnóstico:

| Onde aparece | Significa |
|---|---|
| Nas duas | par completo, deduplicado pelo `event_id` — o normal |
| Só no servidor | pixel bloqueado (adblock, iOS). **É exatamente pra isso que a CAPI existe** |
| Só no navegador | a fila não chegou ao `/api/events` — rede, rate limit ou erro 4xx |
| Em nenhuma | o evento não foi disparado, ou morreu na validação (veja o console) |

Essa é a primeira pergunta de toda investigação de "sumiu conversão", e por isso as duas ficam visíveis juntas.

## Dashboard

Eventos, sucesso, erros, retentando, latência p50 e p95. O percentil é calculado só sobre despacho que aconteceu de verdade — `skipped` tem duração zero e puxaria a mediana pro chão.

### Alertas

- taxa de erro acima de 10%;
- destino que falhou em **todas** as tentativas recentes (5+) — sinal de credencial errada ou plataforma fora;
- p95 acima de 3s — o fan-out está segurando a resposta;
- nenhum `purchase` no período (informativo; em homologação é o esperado).

## Filtros e exportação

Status, destino e busca livre (evento, erro, id). **Exportar** baixa um JSON com as duas listas e o Data Layer — é o que anexar num chamado pro suporte da Meta ou do Google.

## Console

```bash
NEXT_PUBLIC_TRACKING_DEBUG=1
```

Loga cada despacho com ✓ / · / ✗. Útil enquanto se implementa um evento novo.

```js
window.lurdsDataLayer          // histórico bruto na aba
```

## Roteiro de investigação

1. O evento aparece no **Data Layer**? Não → não foi disparado, ou a validação recusou (o console diz por quê).
2. Aparece, mas o log diz `skipped`? Leia o motivo: quase sempre é consentimento não concedido ou destino sem credencial.
3. Log de servidor com `error`? A mensagem vem da plataforma — token expirado, payload recusado, timeout.
4. Tudo `success` mas não aparece na Meta? Confira o **Testar eventos** com o `META_CAPI_TEST_CODE`, e veja se o evento não chegou duplicado (id divergente entre Pixel e CAPI).
5. Tudo `success` mas não aparece no GA4? Ligue `GA4_MP_DEBUG=1` — o Measurement Protocol responde 204 mesmo pra payload inválido.
