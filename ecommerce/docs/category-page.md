# Página de categoria

`src/app/(public)/categoria/[slug]/page.tsx` (server) +
`components/commerce/CategoryListing.tsx` (client).

## Estrutura

| # | Bloco | Render |
|---|---|---|
| 01 | Hero editorial (medium) com breadcrumb | server |
| 02 | Introdução da categoria | server |
| 03 | Barra inteligente | client |
| 04 | Filtros premium (sidebar / drawer) | client |
| 05 | Ordenação | client |
| 06 | Grid editorial | client |
| 07 | Interrupções (imagem, look, banner) | client |
| 08 | Infinite scroll + "carregar mais" | client |
| 09 | Conteúdo educativo ("Guia Lurds") | server |
| 10 | Instagram | server |
| 11 | Newsletter | server |

**Só a listagem é client.** Hero, introdução, guia e Instagram são
server-rendered — é isso que mantém a página indexável e rápida.

## Renderização

`generateStaticParams` pré-renderiza as 10 categorias conhecidas;
`revalidate = 3600` (ISR de 1h — catálogo muda por reposição, não por
segundo). Slug desconhecido cai no fallback dinâmico com metadados genéricos.

## Barra inteligente

`SmartBar.tsx`, sticky abaixo do header (`top-[68px]` / `top-[76px]` no lg).

Contagem de peças · busca dentro da categoria · chips de filtro ativo
(removíveis) · "Limpar filtros" · ordenação (7 opções) · alternância
editorial/grade · botão "Filtrar" com contador no mobile.

## Grid editorial

O que separa "coleção curada" de "catálogo": a grade **não** é uniforme.
`interruptions` insere blocos de 2 colunas em posições definidas —
nesta página nas posições 6 (imagem de campanha), 14 (look completo) e
22 (banner comprar-e-retirar). As posições caem depois de uma fileira
completa em qualquer breakpoint.

`view="grid"` desliga as interrupções e adensa as colunas, para quem quer
comparar rápido.

## Paginação

**Infinite scroll é o padrão**, com sentinela de 400px de margem (a próxima
página chega antes de a cliente alcançar o fim) — implementado com
`useIntersection` + `useInfiniteQuery`.

Junto dele há **sempre** o botão "Carregar mais peças": scroll infinito puro
prende quem navega por teclado e nunca alcança o rodapé.

A paginação numerada tradicional existe e funciona (`mode="pages"`), pronta
para quando a decisão de SEO pedir URLs por página.

## Conteúdo educativo

O bloco "Guia Lurds" (`categoryMeta().guide`) traz texto autoral respondendo
a dúvida de escolha — tecido, caimento, ocasião. Dois objetivos: cauda longa
no Google e permanência.

Renderizado no servidor, visível (não atrás de acordeão fechado por JS) —
conteúdo escondido pontua menos.

## SEO

`generateMetadata` por slug (title, description, canonical, OG com a foto do
hero, keywords) + JSON-LD `BreadcrumbList`. Um `<h1>` (nome da categoria) e
`<h2>` por seção.

Filtros vivem em estado de componente, não na URL — a variante canônica é a
categoria limpa. Quando filtros virarem URL (Sprint 016), entram com
`rel="canonical"` apontando pra categoria.

## Estado vazio

Nunca "nenhum resultado". Mostra: ícone, título serif, orientação ("tente
soltar um filtro"), botão de limpar e WhatsApp — porque a rede tem 14 lojas e
a peça pode existir em uma delas.

## Filtros

Ver [filters.md](filters.md). Ver [grid-system.md](grid-system.md) para o
sistema de grade.
