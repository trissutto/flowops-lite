# Fundação técnica de SEO — design

**Data:** 26/08/2026  
**Escopo:** e-commerce público em `ecommerce/`  
**Domínio canônico:** `https://lurds.com.br`

## Objetivo

Corrigir os problemas técnicos de SEO que podem ser resolvidos com segurança no
repositório, sem misturar neste PR a recuperação em massa das URLs antigas da
Search Console nem uma refatoração ampla de performance.

O resultado deve preservar a indexação e os redirects existentes, reduzir HTML
estruturado desnecessário, tornar o sitemap confiável e ampliar a qualidade dos
dados que o Google recebe sobre a empresa e os produtos.

## Fora do escopo

- Criar redirects para as 4.156 URLs antigas sem uma exportação completa da
  Search Console e um destino validado para cada URL.
- Alterar URLs canônicas de produtos ou categorias.
- Modificar regras comerciais, preço, estoque, frete ou devolução.
- Inventar GTIN, cor, material, endereço, telefone ou qualquer outro dado que
  não esteja disponível nas fontes atuais.
- Resolver todo o INP do site neste mesmo PR. O pacote apenas remove peso de
  HTML/JSON-LD diretamente relacionado ao SEO.

## Abordagem escolhida

Será feito um pacote focado na camada existente, mantendo `src/lib/seo.ts` como
fonte central. Não haverá uma nova biblioteca de SEO nem duplicação de helpers.

### 1. Sitemap confiável

- Remover o uso de `new Date()` como `lastModified` universal.
- Informar `lastModified` apenas quando houver uma data real e confiável na
  fonte da URL.
- Omitir a propriedade para páginas estáticas sem histórico de alteração
  disponível, em vez de fabricar uma data.
- Manter deduplicação, produtos esgotados e fallback quando o backend estiver
  indisponível.
- Manter `changeFrequency` e `priority` somente se não complicarem o código;
  eles não serão tratados como sinais relevantes do Google.

### 2. JSON-LD da home

- Deduplicar produtos pela URL canônica, porque cores diferentes podem apontar
  para a mesma PDP.
- Limitar o `ItemList` da home aos primeiros 24 produtos únicos. Esse número
  cobre os destaques visíveis sem serializar o catálogo inteiro no HTML.
- Preservar os nós `ClothingStore` e os schemas globais já existentes.
- Criar testes unitários para ordem, deduplicação e limite.

### 3. Schema global da organização

- Acrescentar somente informações verificáveis já presentes no projeto, como
  perfis oficiais e identificador fiscal, quando existir uma fonte única.
- Representar política de devolução ou entrega apenas se os dados puderem ser
  derivados das políticas comerciais atuais sem assumir prazos ou regiões.
- Evitar repetir 14 lojas dentro do nó `Organization`; cada unidade continuará
  como `ClothingStore`.

### 4. Schema de produto e oferta

- Incluir `description`, `material`, `color`, identificadores e outros campos
  recomendados quando estiverem presentes no tipo `Product`.
- Incluir `seller` e `itemCondition` na oferta.
- Reutilizar política global por `@id` quando ela puder ser descrita com dados
  reais.
- Não publicar GTIN genérico no produto pai quando os EANs existirem apenas por
  tamanho/variação.
- Não implementar `ProductGroup` até que a relação entre cores, tamanhos, URLs
  e EANs esteja representada sem ambiguidade no modelo usado pela PDP.

### 5. Semântica e metadata

- Garantir um único `<h1>` na PDP, mesmo quando componentes responsivos
  renderizarem versões diferentes da área de compra.
- Manter o nome visual da peça e a hierarquia atual.
- Dar à busca interna metadata completa e explícita, sem herdar o canonical da
  home. Ela continuará `noindex, follow`.
- Não indexar conta, carrinho, checkout ou páginas por token.

### 6. Testes e validação

- Adicionar testes unitários para os helpers de SEO e o limite do `ItemList`.
- Adicionar ou ajustar testes do sitemap para confirmar ausência de datas
  artificiais e preservação de URLs.
- Atualizar os três testes antigos da home que hoje esperam cinco categorias e
  imagens locais, pois o estado aprovado atual possui oito categorias e fotos
  reais no R2.
- Executar testes, lint, typecheck e build de produção.
- Inspecionar HTML de rotas representativas em build de produção quando o
  ambiente permitir.

## Tratamento de falhas

- Falha do catálogo durante a geração do sitemap continuará produzindo o mapa
  estático, nunca um sitemap vazio.
- Campo opcional ausente será omitido do JSON-LD; não produzirá string vazia,
  valor fictício ou erro de renderização.
- Mudanças não podem alterar preço, disponibilidade nem canonical existentes.

## Critérios de aceite

1. Nenhuma URL recebe `lastModified` igual ao horário de geração sem fonte real.
2. O `ItemList` da home possui no máximo 24 URLs canônicas únicas.
3. A PDP em produção renderiza exatamente um `<h1>`.
4. A busca continua `noindex, follow` e não anuncia a home como canonical.
5. `Product` e `Offer` mantêm os campos obrigatórios atuais e ganham apenas
   propriedades recomendadas sustentadas por dados reais.
6. Robots, canonicals, redirects e status 404 existentes não sofrem regressão.
7. Testes, lint, typecheck e build passam.

## Entrega

A implementação será entregue na branch `codex/seo-technical-foundation`, com
commit, push e link para abertura do PR contra `main`. A recuperação em massa
de 404 e o trabalho de INP ficarão em pacotes posteriores, apoiados nos dados da
Search Console e em medições de campo.
