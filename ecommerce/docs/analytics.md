# Taxonomia de eventos

Lista fechada. Evento fora dela é recusado na validação — de propósito: taxonomia que aceita qualquer coisa vira sopa de letrinha em seis meses e nenhum relatório presta.

Para criar um evento novo: declare em `types.ts` (`STANDARD_EVENTS`, `ENGAGEMENT_EVENTS` ou `LURDS_EVENTS`), escreva o helper em `events.ts`, exporte em `index.ts`.

## Padrão de mercado

| Evento | Helper | Quando |
|---|---|---|
| `page_view` | automático | troca de rota (`TrackingProvider`) |
| `view_item` | `trackViewItem` | página de produto |
| `view_item_list` | `trackViewItemList` | vitrine, categoria, carrossel |
| `search` | `trackSearch` | busca com resultado |
| `select_item` | `trackSelectItem` | clique num card da vitrine |
| `add_to_wishlist` | `trackAddToWishlist` | **após** entrar na lista |
| `remove_from_wishlist` | `trackRemoveFromWishlist` | após sair |
| `add_to_cart` | `trackAddToCart` | **após** a API confirmar |
| `remove_from_cart` | `trackRemoveFromCart` | após remover de fato |
| `view_cart` | `trackViewCart` | abrir sacola |
| `begin_checkout` | `trackBeginCheckout` | entrar no checkout |
| `add_shipping_info` | `trackAddShippingInfo` | escolher frete |
| `add_payment_info` | `trackAddPaymentInfo` | escolher pagamento |
| `purchase` | `trackPurchase` (**servidor**) | pagamento confirmado |
| `refund` | `trackRefund` (**servidor**) | estorno |
| `login` / `logout` / `sign_up` | `trackLogin` / `trackLogout` / `trackSignUp` | conta |
| `generate_lead` | `trackGenerateLead` | lead qualificado |
| `contact` | `trackContact` | contato iniciado |

## Engajamento e canal

| Evento | Helper | Observação |
|---|---|---|
| `store_locator` | `trackStoreLocator` | busca de loja |
| `whatsapp_click` | `trackWhatsAppClick` | o canal que mais converte da rede |
| `instagram_click` | `trackInstagramClick` | |
| `phone_click` | `trackPhoneClick` | |
| `share_product` | `trackShareProduct` | |
| `video_watched` | `trackVideoWatched` | dispara em marcos de % |
| `time_on_page` | automático | ≥ 3s, na saída da página |
| `scroll_depth` | automático | `percent`: 25 / 50 / 75 / 100 |
| `newsletter_signup` | `trackNewsletter` | |
| `coupon_applied` / `coupon_removed` | `trackCouponApplied` / `trackCouponRemoved` | |
| `filter_used` | `trackFilterUsed` | |
| `sort_changed` | `trackSortChanged` | |
| `buy_look` | `trackBuyLook` | look completo |
| `quick_view` | `trackQuickView` | |
| `store_reservation` | `trackStoreReservation` | reserva na loja |
| `buy_and_pickup` | `trackBuyAndPickup` | comprar e retirar |

> **Nota sobre scroll:** a spec lista 25/50/75/100 como quatro eventos. Implementamos **um** evento com o percentual como parâmetro. No GA4 isso vira um relatório com a profundidade como dimensão — bem mais útil que quatro linhas soltas — e mantém a mesma informação.

## Eventos próprios da Lurd's

Não existem em plataforma nenhuma. Vão pro GA4 como evento customizado e pra Meta como `trackCustom`. São eles que respondem as perguntas que só esta marca faz.

| Evento | Helper | A pergunta que responde |
|---|---|---|
| `view_look` | `trackViewLook` | look vende mais que peça solta? |
| `view_fabric` | `trackViewFabric` | tecido pesa na decisão? |
| `view_collection` | `trackViewCollection` | qual coleção puxa tráfego? |
| `view_occasion` | `trackViewOccasion` | casamento, trabalho, festa |
| `body_shape_filter` | `trackBodyShapeFilter` | filtro por tipo de corpo |
| `ai_consultant` | `trackAiConsultant` | quem usa a consultora compra mais? |
| `virtual_fitting` | `trackVirtualFitting` | provador virtual |
| `size_guide` | `trackSizeGuide` | tabela de medidas antes de comprar reduz troca? |
| `color_switch` | `trackColorSwitch` | troca de cor na página |
| `size_switch` | `trackSizeSwitch` | troca de tamanho |
| `store_availability` | `trackStoreAvailability` | consulta de estoque na loja |

## Automáticos

`page_view`, `scroll_depth` e `time_on_page` vêm do `TrackingProvider` — nenhum componente precisa chamá-los.

- **`time_on_page`** só dispara com ≥ 3s. Abaixo disso foi um quique, não uma visita.
- **`scroll_depth`** mede num `requestAnimationFrame` (o evento de scroll dispara dezenas de vezes por segundo e ler `scrollHeight` força layout) e checa do maior marco pro menor, saindo no primeiro. Rolagem rápida ou âncora pula marcos; disparar só o mais alto evita quatro eventos num quadro só.

## Escotilha de escape

`trackCustom(evento, params, options)` para o que ainda não ganhou helper. Continua passando por validação e consentimento. **Se você usar duas vezes para o mesmo evento, falta um helper** — escreva.
