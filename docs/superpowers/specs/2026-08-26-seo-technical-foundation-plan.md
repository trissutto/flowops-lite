# Plano de implementação — fundação técnica de SEO

## Resultado esperado

O e-commerce passa a fornecer sinais mais confiáveis ao Google: sitemap sem
datas artificiais, JSON-LD da home pequeno e sem URLs repetidas, schemas com
dados comerciais verificáveis, uma única heading principal na PDP e metadata
explícita para a busca interna.

## 1. Cobertura automatizada da camada de SEO

**Arquivos:**

- `ecommerce/src/lib/seo.test.ts` (novo)
- testes de sitemap existentes ou novo teste isolado

**Trabalho:**

- Fixar em testes o contrato atual de metadata, `Organization`, `Product`,
  `Offer` e `ItemList`.
- Cobrir deduplicação estável por URL canônica e limite de 24 itens.
- Cobrir omissão de propriedades opcionais quando a fonte não possui o dado.
- Cobrir sitemap sem `lastModified` gerado no momento da requisição.

## 2. Helpers e schemas estruturados

**Arquivo:**

- `ecommerce/src/lib/seo.ts`

**Trabalho:**

- Normalizar a URL do site sem barra final para impedir URLs com `//`.
- Enriquecer `Organization` com dados oficiais já centralizados no projeto.
- Enriquecer `Product` com descrição, material e cor somente quando presentes.
- Enriquecer `Offer` com vendedor e condição de item.
- Fazer `itemListSchema` deduplicar por slug, preservar a primeira ocorrência e
  aceitar limite explícito sem mudar as listagens que não o solicitarem.

## 3. Home com JSON-LD enxuto

**Arquivo:**

- `ecommerce/src/app/(public)/page.tsx`

**Trabalho:**

- Solicitar limite de 24 itens únicos no schema da home.
- Não alterar as grades visuais nem a quantidade de produtos renderizada.
- Preservar os 14 nós `ClothingStore` e os schemas globais.

## 4. Sitemap honesto

**Arquivo:**

- `ecommerce/src/app/sitemap.ts`

**Trabalho:**

- Remover `lastModified: new Date()` de páginas estáticas, navegação, lojas e
  produtos sem data real no feed.
- Manter URLs, prioridades, frequências, fallback do backend e deduplicação.
- Preparar o shape do feed para uma futura data real sem inferi-la de preço ou
  disponibilidade.

## 5. Heading da PDP e metadata da busca

**Arquivos:**

- `ecommerce/src/components/commerce/BuyBox.tsx`
- `ecommerce/src/components/commerce/EscolhaDaPeca.tsx`
- `ecommerce/src/app/(public)/busca/page.tsx`

**Trabalho:**

- Identificar onde o `BuyBox` é duplicado por breakpoint e permitir que apenas
  a instância principal use `<h1>`; as demais usam texto visual equivalente sem
  criar outra heading principal.
- Garantir que PDPs sem grade de cores continuem com um H1.
- Construir metadata da busca com `buildMetadata`, canonical próprio sem query
  e `noindex, follow` explícito.
- Se o helper atual não permitir `noindex, follow`, adicionar uma opção pequena
  e retrocompatível em vez de montar metadata divergente à mão.

## 6. Reparar testes antigos da home

**Arquivo:**

- `ecommerce/src/data/home.test.ts`

**Trabalho:**

- Atualizar a expectativa para as oito categorias atuais aprovadas.
- Aceitar imagens editoriais HTTPS do R2 e manter validação de alt descritivo.
- Preservar validação de destinos internos.

## 7. Verificação e entrega

**Comandos:**

- `npm test -- --run`
- `npm run lint`
- `npx tsc --noEmit`
- `npm run build`
- `npm run links:check`

**Conferências adicionais:**

- Comparar o tamanho e a quantidade de itens do JSON-LD antes/depois.
- Confirmar uma única ocorrência de `<h1>` em uma PDP com cores e uma PDP sem
  cores em build de produção.
- Confirmar `noindex, follow` e canonical `/busca`.
- Confirmar que sitemap, robots e uma URL inexistente mantêm status correto.
- Rodar revisão CodeRabbit quando disponível; se o ambiente não possuir a CLI
  ou autenticação, registrar a limitação sem instalar dependência nova.

## 8. Git

- Trabalhar somente em `codex/seo-technical-foundation`, baseada em
  `origin/main`.
- Não incluir o commit da branch de Limeira.
- Commitar implementação e testes, enviar a branch e fornecer o link para o PR
  manual contra `main`.
