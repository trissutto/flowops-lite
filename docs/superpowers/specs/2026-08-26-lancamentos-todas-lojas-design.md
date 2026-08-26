# Lançamentos em todas as páginas de loja — design

**Data:** 26/08/2026  
**Escopo:** 14 páginas públicas em `/lojas/[cidade]`  
**Base:** experiência de lançamentos entregue para Limeira

## Objetivo

Transformar a experiência especial de Limeira em um padrão único para todas as
unidades da Lurd's. Cada página local deve destacar novidades do catálogo,
facilitar a consulta pelo WhatsApp da própria loja e preservar endereço,
horários, mapa, schema local e conteúdo institucional.

## Decisão de produto

As novidades são gerais da rede, não uma promessa de estoque da unidade. Toda
menção comercial deve orientar a cliente a consultar cores, tamanhos e
disponibilidade com a equipe local.

Não será criado filtro de estoque por loja neste pacote porque a fonte usada
pela vitrine não oferece essa garantia no contrato atual.

## Arquitetura

### Página local

`app/(public)/lojas/[cidade]/page.tsx` continuará sendo o Server Component que
resolve a unidade e busca até seis lançamentos. A condição exclusiva
`s.slug === 'limeira'` será eliminada.

Para toda unidade válida, a página deve:

- buscar os lançamentos pelo serviço server-side existente;
- usar a primeira foto elegível como fundo editorial do hero;
- renderizar a vitrine de lançamentos;
- renderizar o bloco de acolhimento;
- preservar todos os blocos locais existentes.

### Conteúdo dinâmico

O hero usará o título `Novidades Lurd's em [unidade]`. Descrição, CTAs,
WhatsApp, eventos e avisos usarão os dados do objeto da loja, nunca uma cidade
ou telefone escritos à mão.

A unidade é usada no título porque diferencia bairros que compartilham a mesma
cidade, como Anália Franco e Moema em São Paulo.

### Vitrine

`StoreLaunches` continuará sendo o componente único para as 14 páginas:

- até seis cards;
- duas colunas no celular e três no desktop;
- link da PDP preservando a cor;
- `view_item_list` na visualização;
- evento de clique com nome da unidade;
- aviso explícito de consulta de disponibilidade;
- CTA para o WhatsApp local.

### Hero e CTAs

O primeiro lançamento com imagem será decorativo no hero. O texto continuará
legível sobre gradiente. Os CTAs serão:

- `Ver os lançamentos`, apontando para `#lancamentos`;
- `Como chegar`, usando o mapa e o rastreamento existentes.

Sem imagem, o hero mantém a composição tipográfica escura, sem espaço vazio ou
imagem quebrada.

## Falhas e degradação

- Falha do catálogo retorna lista vazia e não derruba a página local.
- Lista vazia mostra o fallback para `/novidades`.
- Endereço, horário, mapa, telefone, Instagram e WhatsApp não dependem da
  consulta de lançamentos.
- Nenhuma página afirma que uma peça está disponível fisicamente na unidade.

## SEO local

- Metadata, canonical, schema `ClothingStore` e breadcrumbs permanecem
  específicos por unidade.
- Cada página terá um único H1 com o nome da unidade.
- A mudança visual não cria novas URLs nem parâmetros indexáveis.
- Links para produtos continuam sendo links HTML reais, acessíveis ao Google.

## Testes

Os testes devem comprovar:

1. As 14 lojas recebem o modo de lançamentos.
2. Nenhuma condição exclusiva de Limeira permanece.
3. O título e o WhatsApp usam a unidade recebida.
4. A vitrine limita a seis produtos elegíveis.
5. Cor selecionada é preservada no link da PDP.
6. Catálogo vazio mantém fallback e dados locais.
7. Falha da consulta não impede a renderização da página.
8. Build, lint, typecheck e testes completos passam.

## Fora do escopo

- Estoque real filtrado por loja.
- Curadoria diferente para cada cidade.
- Textos editoriais exclusivos por unidade.
- Alterações no cadastro das lojas, schema de endereço ou Google Business
  Profile.
- Mudanças no checkout, frete ou retirada em loja.

## Entrega

A implementação será feita na branch
`codex/lojas-lancamentos-todas-cidades`, baseada na entrega de Limeira. O PR
será independente e conterá tanto a base já validada quanto a generalização
para as 14 lojas. O deploy continuará manual.
