# Mega Menu

`components/navigation/MegaMenu.tsx` (+ `CategoryColumn.tsx`, `MenuCard.tsx`).

## Layout

```
┌───────────────────────────────────────────────────────────────┐
│  COLUNA 1        COLUNA 2        COLUNA 3     │  CARD          │
│  título dourado  título dourado  título       │  ┌──────────┐  │
│  · link          · link          · link       │  │  foto    │  │
│  · link          · link          · link       │  ├──────────┤  │
│  · link          · link                       │  │ eyebrow  │  │
│                                               │  │ título   │  │
│                                               │  │ CTA →    │  │
│                                               │  └──────────┘  │
├───────────────────────────────────────────────────────────────┤
│  Ver tudo em Ocasiões →     quick link     quick link         │
└───────────────────────────────────────────────────────────────┘
```

Colunas ocupam o espaço flexível; o card tem largura fixa (340px no desktop).

## Por que o card editorial é obrigatório

Sem ele, o painel é uma lista de links — indistinguível de qualquer
ecommerce. Com uma imagem de campanha e um convite, o menu já vende a
coleção antes do clique. É a diferença entre "menu" e "vitrine".

O card sempre tem: foto (zoom 1.04 no hover), eyebrow dourado, título serif,
uma linha de apoio e CTA com seta que desliza.

## Interação

| Ação | Resultado |
|---|---|
| Hover/foco no item | abre o painel daquele eixo |
| Mouse sai | fecha após **120ms** (atravessar o vão não fecha) |
| Esc | fecha imediatamente |
| Clique em link | fecha e navega |
| Hover no painel | cancela o fechamento agendado |

Entrada: fade + 8px de deslocamento em 180ms. Rápido de propósito — menu
lento irrita.

## Colunas

`CategoryColumn.tsx`. Título em `.eyebrow` dourado; links com o sublinhado
animado da marca (`.link-underline`). `highlight: true` deixa o link em
`font-medium text-ink` (os outros ficam `font-light text-ink-soft`).

Coluna de continuação usa `title: ' '`: o espaço do título é preservado (para
o alinhamento entre colunas) mas o rótulo não se repete — e fica
`aria-hidden`, então o leitor de tela não anuncia um travessão solto.

## Quantas colunas

Até **3**. Mais que isso, o painel vira listão e perde a hierarquia. Eixos
com muitos itens (Ocasiões) agrupam por afinidade — "Dia a dia", "Momentos
especiais", "Descanso" — em vez de despejar tudo em ordem alfabética.

## Adicionar um item

Editar `data/navigation.ts`. O painel, o drawer mobile, o índice de busca e o
sitemap se atualizam sozinhos. Nada de código.
