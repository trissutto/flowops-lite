# Arquitetura

## Camadas

```
app/          rotas, metadata, JSON-LD, composição de seções
components/   ui · layout · sections · cards · commerce · navigation · feedback
hooks/        comportamento reutilizável entre componentes
services/     acesso a dados — a ÚNICA porta pra API
data/         conteúdo e taxonomia editáveis por humano
lib/          utils, motion, seo (puro: sem estado, sem React)
types/        contrato de domínio
store/        estado global (Zustand)
```

Dependência sempre para baixo. `lib/` não importa componente; `components/`
não importa `app/`; `services/` não conhece React.

**Regra de ouro:** página **compõe**, componente **renderiza**, service
**busca**. Página nunca faz `fetch` direto nem monta grade na mão.

## Server vs Client

Server Component é o padrão. `'use client'` só quando há estado, efeito ou
handler de evento. Padrão da casa: a página é server (metadata, JSON-LD,
conteúdo indexável) e delega as ilhas interativas.

Exemplo real — `/categoria/[slug]`:

- **Server:** hero, introdução, guia educativo, Instagram, newsletter, SEO.
- **Client:** só `CategoryListing` (filtros, infinite scroll, ordenação).

## Fluxo de dados do catálogo

```
página  →  services/products.ts  →  (hoje) data/content.ts
                                    (amanhã) API do FlowOps
```

`fetchProducts(query): Promise<Paginated<Product>>` já tem a assinatura que a
API vai expor. Ordenação, filtro e paginação vivem no service — é isso que
permite migrar para query no servidor sem reescrever tela.

O mesmo vale para busca: `services/search.ts` resolve local hoje e troca por
Algolia/Typesense/endpoint sem tocar no `SearchOverlay`.

## Grupos de rota

```
app/(public)     vitrine — header + footer compartilhados
app/(account)    conta, pedidos, favoritos, endereços (chrome próprio)
app/(checkout)   carrinho e checkout (chrome mínimo, sem distração)
```

## Renderização

| Rota | Estratégia | Motivo |
|---|---|---|
| `/` | estática | conteúdo curado, muda por deploy |
| `/categoria/[slug]` | SSG + ISR 1h | catálogo muda por reposição |
| `/produto/[slug]` | ISR curto (planejado) | preço e estoque |
| `/carrinho`, `/checkout` | dinâmico | estado do cliente |

## Convenções de domínio

- **Preço em REAIS** (`number`), nunca centavos. Lição do FlowOps: dividir por
  100 no lugar errado derrubou preços 100×.
- **Numeração** 46–60 é o eixo da marca; aparece em filtro, card e SEO.
- **Loja física é entidade de primeira classe** — `Store` tem geo, horário e
  WhatsApp próprios; todo fluxo online oferece a saída pro provador.

## Fronteira com o FlowOps

Este projeto vive em `ecommerce/` e é **isolado**: build, deps e rotas
próprios. O app em `frontend/` (PDV, retaguarda, Live Commerce e o **cadastro
da Live**) continua intocado. Nada aqui pode alterar as URLs da Live.
