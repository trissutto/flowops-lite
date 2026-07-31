# GA4, Google Ads e Consent Mode v2

## Configuração

```bash
NEXT_PUBLIC_GA4_ID=G-XXXXXXX
GA4_API_SECRET=...              # Admin → Fluxos de dados → Measurement Protocol
NEXT_PUBLIC_GOOGLE_ADS_ID=AW-...
GA4_MP_DEBUG=1                  # valida o payload; NUNCA em produção
```

## Nossa taxonomia já é GA4

Os nomes de evento nasceram em dialeto GA4 (`view_item`, `add_to_cart`, `begin_checkout`…), então aqui quase não há tradução — o trabalho é montar o bloco `items`.

**`send_page_view: false` é proposital.** O gtag dispara `page_view` sozinho no carregamento, o que num app de rota client-side gera uma pageview a menos (a primeira) e nenhuma nas trocas de rota. Quem manda `page_view` é o `TrackingProvider`, que enxerga toda navegação.

## Dimensões customizadas

Os campos da marca só aparecem nos relatórios depois de registrados em **Admin → Definições personalizadas**:

| Parâmetro | Escopo |
|---|---|
| `tecido` | item |
| `colecao` | item |
| `loja` | evento |
| `body_shape` | evento |

Sem registrar, o dado chega mas não é exibido em lugar nenhum.

## Measurement Protocol (servidor)

Complementa o gtag onde ele não roda: bloqueador ativo e, principalmente, `purchase` — que nasce no servidor.

**Pegadinha:** o MP responde **204 pra quase tudo**, inclusive payload inválido. "Sem erro" não significa "foi aceito". A única forma de conferir é `GA4_MP_DEBUG=1`, que troca a rota pro endpoint de validação e devolve as mensagens de problema. Ligue em homologação, desligue em produção.

**`client_id` precisa ser o mesmo do navegador.** Usamos o `anonymous_id`. Se divergir, a mesma pessoa vira dois usuários e a sessão se parte em duas no relatório.

## Consent Mode v2

Quatro categorias nossas → sete sinais do Google:

| Nosso | Sinais |
|---|---|
| `analytics` | `analytics_storage` |
| `marketing` | `ad_storage`, `ad_user_data` |
| `personalization` | `ad_personalization`, `personalization_storage` |
| (sempre) | `functionality_storage`, `security_storage` = granted |

### A ordem que quebra em silêncio

O estado `default: denied` **precisa** chegar antes do `gtag.js` carregar. Por isso `consentBootstrapSnippet()` vai inline no `<head>` do `app/layout.tsx`, como primeiro script da página.

Se essa ordem inverter — alguém mover o snippet, ou pôr uma tag antes dele — o Google assume consentimento concedido e a conformidade com a LGPD vira ficção. **Não mova aquele script.**

O snippet também reaplica o consentimento já salvo. Sem essa parte, quem já aceitou veria o site voltar ao estado negado a cada carregamento até o React hidratar.

`wait_for_update: 500` dá meio segundo pro nosso código atualizar o estado antes do gtag decidir o que fazer.

## Enhanced Conversions

Liga com `allow_enhanced_conversions: true` no `config` do Google Ads. Os dados da pessoa (e-mail em hash) vão junto do evento de conversão — mesma normalização da Meta, ver [meta.md](./meta.md).
