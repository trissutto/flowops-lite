# Plano de implementação — lançamentos na página de Limeira

## Resultado esperado

A rota `/lojas/limeira` ganha um hero orientado a novidades, uma grade automática de até seis lançamentos e uma chamada local para consulta pelo WhatsApp. As demais páginas de loja mantêm o conteúdo atual. A página continua server-first e as partes que precisam de rastreamento permanecem em pequenos componentes client.

## 1. Fonte server-side dos lançamentos

**Arquivos:**

- `ecommerce/src/services/products.ts`
- `ecommerce/src/app/(public)/lojas/[cidade]/page.tsx`

**Trabalho:**

- Criar ou reutilizar uma consulta server-safe ao BFF de catálogo para buscar peças ordenadas por `novidades`, limitadas a seis cards elegíveis.
- Reutilizar `mapPecasDaVitrine`, preservando a regra atual em que cada cor com foto e estoque pode virar um card.
- Filtrar cards sem imagem e sem disponibilidade antes de renderizar.
- Tratar falha como lista vazia; a rota da loja nunca deve falhar por causa do catálogo.
- Manter `revalidate = 60`, alinhado ao TTL do catálogo e à página `/novidades`.

## 2. Componente da vitrine local

**Novo arquivo:**

- `ecommerce/src/app/(public)/lojas/[cidade]/StoreLaunches.tsx`

**Dependências reutilizadas:**

- `ProductCard`
- `HOME_GRID_SIZES`
- `trackViewItemList`
- `trackStoresProductClick`

**Trabalho:**

- Renderizar grade responsiva de duas colunas no celular e três no desktop.
- Exibir no máximo seis cards, sem espaços reservados quando houver menos itens.
- Passar `href` preservando a cor da vitrine e os parâmetros UTM da landing quando disponíveis.
- Disparar `view_item_list` quando a vitrine entrar no fluxo medido e `stores_product_click` ao abrir um produto.
- Exibir abaixo da grade o aviso: “Consulte a disponibilidade na loja de Limeira”.
- Se não houver itens, renderizar somente uma chamada segura para `/novidades`.

## 3. Hero específico de Limeira

**Arquivo:**

- `ecommerce/src/app/(public)/lojas/[cidade]/page.tsx`

**Trabalho:**

- Aplicar a nova mensagem somente quando `s.slug === 'limeira'`.
- Usar o primeiro lançamento elegível como imagem editorial do hero, com fallback para o hero tipográfico atual.
- Título: “Novidades Lurd's em Limeira”.
- Texto: “Looks plus size do 44 ao 60, com caimento que valoriza você e atendimento acolhedor para experimentar sem pressa.”
- CTA primário “Ver os lançamentos” apontando para a âncora `#lancamentos`.
- CTA secundário “Como chegar” usando a rota existente e o rastreamento de `store_locator`.
- Não transformar a página inteira em client component.

## 4. Consulta pelo WhatsApp e acolhimento

**Arquivos:**

- `ecommerce/src/app/(public)/lojas/[cidade]/StoreCtas.tsx`
- `ecommerce/src/app/(public)/lojas/[cidade]/page.tsx`

**Trabalho:**

- Adicionar após a vitrine o bloco “Gostou de algum look?” com CTA “Consultar pelo WhatsApp”.
- Usar a função central `whatsappUrl` e manter `trackWhatsAppClick('store_launches', store.unit)`.
- Preservar a mensagem padrão da unidade, sem afirmar disponibilidade.
- Adicionar o bloco “Uma loja feita para você se sentir à vontade” com a mensagem de atendimento e caimento aprovada.
- Manter endereço, horários, Instagram, mapa e outras lojas como estão.

## 5. Atribuição e eventos

**Arquivos:**

- `ecommerce/src/app/(public)/lojas/[cidade]/StoreLaunches.tsx`
- `ecommerce/src/app/(public)/lojas/[cidade]/StoreCtas.tsx`
- testes existentes em `ecommerce/src/lib/tracking/`

**Trabalho:**

- Não criar uma segunda taxonomia: reutilizar `stores_product_click`, `whatsapp_click`, `store_locator` e `view_item_list`.
- Garantir que `store` seja sempre `Limeira` nos eventos locais.
- Preservar a atribuição já capturada pelo `TrackingProvider`; UTMs não serão duplicadas manualmente no payload.
- Preservar `cor` no destino do produto quando o card representar uma cor específica.

## 6. Testes

**Novos testes sugeridos:**

- `ecommerce/src/app/(public)/lojas/[cidade]/store-launches.test.tsx`

**Cenários:**

- Limeira mostra hero e vitrine específicos.
- Outra unidade continua usando o hero e a estrutura atuais.
- A grade limita a seis cards e ignora itens sem imagem ou indisponíveis.
- Lista vazia mostra fallback para `/novidades`.
- Link de produto preserva a cor escolhida.
- Clique em produto informa índice e loja ao helper de tracking.
- Clique no WhatsApp usa origem `store_launches` e unidade `Limeira`.
- Falha do catálogo não remove endereço, horário, mapa ou CTAs locais.

**Verificações:**

- `npm test -- --run` no diretório `ecommerce`.
- `npm run lint` no diretório `ecommerce`.
- `npm run build` no diretório `ecommerce`.
- Conferência visual em 360 px, 768 px e desktop, observando LCP, cortes da imagem, legibilidade dos CTAs e ausência de rolagem horizontal.

## 7. Entrega

- Implementar na branch `codex/loja-limeira-lancamentos`.
- Commitar separando implementação e ajustes de teste quando isso melhorar a revisão.
- Enviar a branch e abrir o PR para `main` pelo link do GitHub.
- O deploy permanece manual pelo responsável do projeto.
