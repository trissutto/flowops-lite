# SEO

Helpers: `src/lib/seo.ts`. Toda página pública **precisa** exportar
`metadata` construído por `buildMetadata()` e injetar o JSON-LD pertinente.

## Metadata

```tsx
export const metadata = buildMetadata({
  title: 'Vestidos plus size',
  description: '…',
  path: '/categoria/vestidos',
  image: '…',            // 1200×630
  keywords: [...],
});
```

Gera de uma vez: `<title>` (com sufixo da marca), description, **canonical**,
Open Graph completo, Twitter card `summary_large_image` e robots
(`max-image-preview: large`).

Página dinâmica usa `generateMetadata` com o mesmo helper.

## JSON-LD

Um único `<script type="application/ld+json">` por página, com `@graph`:

```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{ __html: jsonLdGraph(breadcrumbSchema(trail)) }}
/>
```

| Helper | Tipo | Onde |
|---|---|---|
| `organizationSchema()` | `Organization` | layout raiz |
| `websiteSchema()` | `WebSite` + `SearchAction` | layout raiz |
| `breadcrumbSchema(trail)` | `BreadcrumbList` | toda página interna |
| `productSchema(product)` | `Product` + `Offer` | página de produto |
| `itemListSchema(products, name)` | `ItemList` | home, listagens |
| `storeSchema(store)` | `ClothingStore` | home e `/lojas` (14 nós) |

## SEO local

As 14 unidades são ativo de busca. Cada uma gera um nó `ClothingStore` com
endereço, geo, telefone, `openingHoursSpecification` e `sameAs` (Instagram) —
é o que faz a Lurds aparecer em "loja plus size em Campinas".

Fonte: `data/stores.ts`. Loja nova entra no schema automaticamente.

## URLs

Amigáveis, estáveis, em português, sem parâmetro quando evitável:

```
/                          /categoria/vestidos      /produto/<slug>
/ocasioes/casamento        /tecidos/viscolycra-premium
/looks/trabalho            /tamanhos/50             /lojas
```

Filtro entra como query (`?cor=preto`) e não é indexado; a variante
canônica é a categoria limpa.

## Conteúdo indexável

Cada categoria tem um bloco **"Guia Lurds"** — texto real, autoral, que
responde a dúvida de escolha (tecido, caimento, ocasião). Serve a dois
propósitos: ranquear em cauda longa e aumentar permanência.

Esse conteúdo é renderizado no **servidor** (não atrás de tab ou acordeão
fechado por JS), senão o Google não o pontua bem.

## Hierarquia de heading

Um `<h1>` por página (o título do hero). Seções usam `<h2>` com
`aria-labelledby` ligando a região ao título. Cards usam `<h3>`.

## Arquivos gerados

- `app/sitemap.ts` — monta o sitemap a partir da árvore de navegação real,
  com dedup por URL. Eixo novo no mega menu aparece sozinho.
- `app/robots.ts` — libera a vitrine, bloqueia `/conta/`, `/carrinho`,
  `/checkout` e `/api/`.

## Checklist de página nova

- [ ] `buildMetadata()` com `path` correto (canonical)
- [ ] Imagem OG 1200×630
- [ ] JSON-LD com breadcrumb + schema da entidade
- [ ] Um `<h1>`, hierarquia sem pular nível
- [ ] `alt` descritivo em toda imagem
- [ ] Conteúdo principal renderizado no servidor
