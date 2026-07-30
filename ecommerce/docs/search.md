# Busca

`components/navigation/SearchOverlay.tsx` + `services/search.ts`.

## Comportamento

Desktop: painel full-width descendo do topo. Mobile: mesma estrutura ocupando
a tela. Campo em Playfair grande — a busca é protagonista, não um acessório
no canto.

| Estado | O que mostra |
|---|---|
| Vazio | pesquisas recentes (localStorage) + mais buscados |
| ≥ 2 caracteres | resultados agrupados por tipo |
| Sem resultado | mensagem + sugestão de buscar por ocasião/tecido + WhatsApp |

**Nunca uma caixa vazia.** Sem termo, a busca já sugere caminho.

## Teclado

↓ ↑ navegam · Enter abre o resultado destacado (ou vai pra `/busca?q=`) ·
Esc fecha. O cursor visual acompanha o mouse também, então teclado e mouse
nunca discordam.

## Resolução de intenção

O diferencial está em `INTENT_MAP` (`services/search.ts`): a cliente **não**
digita o nome da categoria do ERP.

| Ela digita | A gente entrega |
|---|---|
| "vestido casamento", "madrinha", "convidada" | `/ocasioes/casamento` |
| "roupa igreja", "culto", "missa" | `/ocasioes/igreja` |
| "roupa elegante", "social" | `/colecoes/alfaiataria` |
| "viscolycra", "visco" | `/tecidos/viscolycra-premium` |
| "meu tamanho", "medidas", "numeração" | `/tamanhos/guia` |
| "retirar na loja" | `/lojas/comprar-e-retirar` |

Sinônimo novo = uma entrada no array.

## Ranking

1. Intenção (sinônimo contido no termo, ou vice-versa)
2. Label que **começa** com o termo
3. Label que **contém** o termo

Depois deduplica por `href` e corta no limite. Tudo com texto normalizado
(sem acento, minúsculo) — "itanhaem" acha "Itanhaém".

## Tipos de resultado

`produto` · `categoria` · `look` · `colecao` · `ocasiao` · `loja` — cada um com
ícone e rótulo de grupo próprios. O agrupamento é o que faz o painel parecer
curadoria em vez de lista.

## Histórico

`localStorage` (`lurds-recent-searches`), máximo 6, com botão de limpar.
Todas as leituras/escritas em `try/catch`: em modo privado o `localStorage`
lança, e histórico é opcional — nunca deve quebrar a busca.

## Índice

Hoje o índice é a própria árvore de navegação (`navigationIndex()`), então
qualquer eixo novo já é buscável sem trabalho extra.

## Migração para busca real (Sprint 013)

`search(query, limit): Promise<SearchResponse>` já é assíncrona. Trocar o
corpo por chamada a Algolia/Typesense/endpoint do FlowOps **não altera o
componente**. O que entra nessa sprint:

- produtos de verdade nos resultados (com foto e preço)
- correção de digitação ("vestidoo")
- sinônimos gerenciáveis fora do código
- página `/busca` com facetas (reusa `CategoryListing`)
- telemetria: o que buscam e o que não encontra resultado
