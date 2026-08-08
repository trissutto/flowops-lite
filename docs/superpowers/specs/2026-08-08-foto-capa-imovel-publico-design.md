# Foto de capa da ficha pública — reparo de consistência

**Data:** 08/08/2026

**Status:** aprovado para implementação

## Problema

O cadastro interno grava corretamente uma única mídia comercial com `isCover=true`, e o PDF já procura essa marcação. Porém, a prévia interna e a página pública usam a primeira foto por `sortOrder`. Assim, marcar outra foto como capa não altera a imagem principal quando ela não ocupa a primeira posição da galeria.

Gerar outro link não resolve o problema e revogaria desnecessariamente o endereço já compartilhado.

## Comportamento aprovado

- A foto ativa marcada com `isCover=true` será a imagem principal na prévia e na página pública.
- A ordem escolhida para as demais fotos será preservada.
- Quando não houver uma capa válida, a primeira foto ativa continuará sendo o fallback.
- O PDF manterá o comportamento atual, usando a capa e depois o fallback.
- O link público não será rotacionado; depois da alteração interna, o usuário somente clicará em **Atualizar publicação**.
- As rotas públicas continuarão sem cache (`force-dynamic`, `revalidate=0` e respostas de mídia controladas pelo portal).

## Implementação

Uma função pura ordenará as mídias colocando a capa primeiro e preservando a ordem relativa das demais. Ela será usada:

1. na montagem da prévia interna;
2. na galeria da página pública.

O contrato enviado pelo backend continuará contendo `isCover`; não haverá alteração no banco, no identificador público ou no fluxo de sincronização.

## Critérios de aceite

1. Com três fotos ordenadas A, B e C, marcar C como capa exibe C como principal e mantém A e B nessa ordem depois dela.
2. Sem nenhuma capa válida, A permanece como principal.
3. Uma mídia inativa não é escolhida como capa pública.
4. Prévia, página pública e PDF usam a mesma foto principal.
5. A atualização ocorre no mesmo link após **Atualizar publicação**.
6. Testes automatizados cobrem capa fora da primeira posição e fallback sem capa.
