# Tracking — visão geral

O rastreamento do ecommerce é um **módulo central**, não um punhado de tags espalhadas. Nenhum componente conversa com Meta, Google ou TikTok: todo evento passa pelo Event Manager, que valida, deduplica, respeita o consentimento e despacha.

## O fluxo

```
Interação da cliente
   ↓
Helper semântico            trackAddToCart(produto, { tamanho: '48' })
   ↓
Event Manager               envelope + event_id + validação + dedup
   ↓
Gate de consentimento       LGPD — sem opt-in, para aqui
   ↓
Data Layer                  histórico próprio (sempre)
   ↓                    ↘
Destinos navegador        Fila do servidor
(Pixel, gtag)               ↓
                          POST /api/events
                            ↓
                          Meta CAPI · GA4 MP     ← mesmo event_id
                            ↓
                          Log de despacho → painel de debug
```

## Por que assim

**Um lugar só pra mudar.** Quando a Meta mudar o formato de `contents` — e ela muda — mexe em um arquivo, não em quarenta componentes.

**Dedup de verdade.** Pixel e CAPI mandam o mesmo `event_id`. Sem isso, cada compra conta duas vezes e o ROAS de todas as campanhas fica errado pra cima.

**Consentimento por construção.** O gate não é uma checagem que alguém pode esquecer de escrever: é o único caminho. Componente não tem como furar a fila porque não tem acesso ao `fbq`.

**Purchase não existe no cliente.** O navegador é território hostil. Qualquer pessoa com o console aberto dispararia uma venda de R$ 50 mil. Compra e estorno saem de `trackPurchase()`, no servidor, depois do pagamento confirmar.

## Como um componente usa

```tsx
import { trackAddToCart } from '@/lib/tracking';

async function adicionar() {
  const ok = await carrinho.add(produto, tamanho);
  if (!ok) return;          // API recusou → NÃO rastreia
  trackAddToCart(produto, { tamanho });
}
```

Importe sempre de `@/lib/tracking`. Se você se pegar importando de `destinations/` ou `server/`, pare — é exatamente o acoplamento que esta arquitetura existe pra impedir.

## Variáveis de ambiente

| Variável | Onde | Efeito sem ela |
|---|---|---|
| `NEXT_PUBLIC_META_PIXEL_ID` | navegador | Pixel desligado |
| `META_PIXEL_ID` | servidor | CAPI desligada |
| `META_CAPI_TOKEN` | servidor | CAPI desligada |
| `META_CAPI_TEST_CODE` | servidor | sem modo de teste (é o normal em produção) |
| `NEXT_PUBLIC_GA4_ID` | ambos | GA4 desligado |
| `GA4_API_SECRET` | servidor | GA4 só no navegador |
| `GA4_MP_DEBUG` | servidor | `1` valida o payload no endpoint de debug |
| `NEXT_PUBLIC_GOOGLE_ADS_ID` | navegador | sem Google Ads |
| `NEXT_PUBLIC_TIKTOK_PIXEL_ID` | navegador | TikTok desligado |
| `NEXT_PUBLIC_CLARITY_ID` | navegador | Clarity desligado |
| `TRACKING_DEBUG_TOKEN` | servidor | painel responde 404 em produção |
| `NEXT_PUBLIC_TRACKING_DEBUG` | navegador | `1` loga cada despacho no console |

Destino sem variável some do fluxo em silêncio — não é erro, é o jeito de ligar plataforma sem deploy.

## Documentos

| Arquivo | Assunto |
|---|---|
| [event-manager.md](./event-manager.md) | núcleo: validação, dedup, fila, retry |
| [data-layer.md](./data-layer.md) | o contrato de dados de cada evento |
| [meta.md](./meta.md) | Pixel + Conversions API |
| [ga4.md](./ga4.md) | GA4, Google Ads, Consent Mode v2 |
| [purchase.md](./purchase.md) | a regra da compra, ponta a ponta |
| [analytics.md](./analytics.md) | taxonomia completa dos eventos |
| [debug-panel.md](./debug-panel.md) | como investigar "sumiu conversão" |
| [limitacoes.md](./limitacoes.md) | **o que ainda não é durável — leia antes de confiar** |
