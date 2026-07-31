# Meta — Pixel + Conversions API

Duas pernas para a mesma conversão. O Pixel roda no navegador; a CAPI, no servidor. As duas mandam o **mesmo `event_id`** — é isso, e só isso, que faz a Meta contar uma conversão em vez de duas.

## Configuração

```bash
NEXT_PUBLIC_META_PIXEL_ID=...   # navegador
META_PIXEL_ID=...               # servidor (mesmo número)
META_CAPI_TOKEN=...             # Gerenciador de Eventos → Configurações → Token
META_CAPI_TEST_CODE=TEST12345   # só em homologação
```

Sem `NEXT_PUBLIC_META_PIXEL_ID` o Pixel some. Sem `META_PIXEL_ID` + `META_CAPI_TOKEN` a CAPI some. Nenhum dos dois quebra a loja.

## Deduplicação

```
Pixel:  fbq('track', 'Purchase', {...}, { eventID: 'purchase-PED-1234' })
CAPI:   { event_name: 'Purchase', event_id: 'purchase-PED-1234', ... }
```

A Meta casa pelo par (`event_name`, `event_id`) numa janela de 48h.

Para `purchase`, o id é **derivado do pedido** (`purchase-${transaction_id}`), não aleatório. Webhook do gateway repetido — e ele repete — gera o mesmo id e não duplica a venda.

## Mapa de eventos

| Nosso | Meta |
|---|---|
| `page_view` | PageView |
| `view_item` | ViewContent |
| `view_item_list` | ViewCategory |
| `search` | Search |
| `add_to_cart` | AddToCart |
| `add_to_wishlist` | AddToWishlist |
| `begin_checkout` | InitiateCheckout |
| `add_payment_info` | AddPaymentInfo |
| `purchase` | Purchase |
| `sign_up` | CompleteRegistration |
| `generate_lead`, `contact` | Lead |
| `store_reservation` | Schedule |
| qualquer outro | `trackCustom` com o nome original |

## Advanced Matching

E-mail e telefone vão **sempre em SHA-256**, normalizados antes do hash:

- e-mail: minúscula, sem espaço nas pontas;
- telefone: só dígitos, **com DDI 55**. Número brasileiro sem o 55 não casa com nada na base da Meta.

Hash de string não normalizada não casa. E texto puro nunca sai daqui — seria vazar dado de cliente pra um terceiro.

Também vão, quando existem:

| Sinal | De onde vem | Peso |
|---|---|---|
| `fbp` | cookie `_fbp` gravado pelo Pixel | alto |
| `fbc` | cookie `_fbc`, ou montado do `fbclid` da URL | **o maior** — é o clique no anúncio |
| `client_ip_address` | header da requisição | médio |
| `client_user_agent` | header da requisição | médio |
| `external_id` | `user_id` do CRM ou `anonymous_id`, em hash | médio |

Sem `fbp`/`fbc`, evento server-side casa muito pior. Por isso o navegador manda os dois junto com a fila.

## Conferir se está funcionando

1. **Gerenciador de Eventos → Testar eventos** com `META_CAPI_TEST_CODE` preenchida. Cada evento deve aparecer **uma vez**, com o selo "Navegador e servidor".
2. Se aparecer duas vezes, o `event_id` não está batendo — confira se o Pixel está recebendo o 4º argumento `{ eventID }`.
3. Se aparecer só como "Servidor", o Pixel está bloqueado no seu navegador (é o esperado com adblock — e é justamente pra isso que a CAPI existe).
4. O painel `/debug/tracking` mostra as duas listas lado a lado; a diferença entre elas é o diagnóstico.

## Limites

- Um lote da CAPI aceita até 1.000 eventos; o nosso teto é 50 por requisição.
- `event_time` em **segundos** Unix. Em milissegundos a Meta recusa o lote inteiro.
- Timeout de 8s no fetch — sem teto, a função serverless estoura antes da Meta responder.
