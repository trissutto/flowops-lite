# Lurd's Plus Size — novo ecommerce

Projeto **novo, do zero**, desenvolvido em paralelo ao site atual
(`lurds.com.br`). Só substitui o site em produção quando estiver 100% pronto.

> ⚠️ **Não interfere no FlowOps.** O app em `../frontend` (PDV, retaguarda,
> Live Commerce e o **cadastro da Live**) continua intocado. Nenhuma rota ou
> build deste projeto afeta os fluxos da Live.

## Rodar

```bash
npm install
npm run dev     # http://localhost:3100 (via .claude/launch.json)
```

```bash
npm run build && npm start    # produção — sempre medir performance aqui
npx tsc --noEmit              # typecheck
```

## Leia nesta ordem

1. **[LURDS_MASTERPLAN.md](LURDS_MASTERPLAN.md)** — a constituição do projeto.
   Toda sprint obedece a ele.
2. [docs/design-system.md](docs/design-system.md) — tokens, tipografia, ritmo.
3. [docs/components.md](docs/components.md) — a biblioteca.
4. [docs/coding-guidelines.md](docs/coding-guidelines.md) — como escrever.

Documentação completa:
[architecture](docs/architecture.md) ·
[folder-structure](docs/folder-structure.md) ·
[editorial-components](docs/editorial-components.md) ·
[animations](docs/animations.md) ·
[header](docs/header.md) ·
[navigation](docs/navigation.md) ·
[mega-menu](docs/mega-menu.md) ·
[search](docs/search.md) ·
[home](docs/home.md) ·
[category-page](docs/category-page.md) ·
[filters](docs/filters.md) ·
[grid-system](docs/grid-system.md) ·
[seo](docs/seo.md) ·
[performance](docs/performance.md) ·
[accessibility](docs/accessibility.md) ·
[roadmap](docs/roadmap.md)

## Stack

Next.js 15 (App Router) · React 19 · TypeScript strict · Tailwind CSS v4 ·
Framer Motion · Lucide · React Hook Form + Zod · Zustand · TanStack Query ·
Embla Carousel.

## O que existe hoje

| Rota | Estado |
|---|---|
| `/` | Home completa, 15 seções, estática |
| `/categoria/[slug]` | Listagem premium, SSG + ISR 1h, 10 categorias |
| `/robots.txt`, `/sitemap.xml` | gerados |

Sprints 001–005 entregues. Ver [roadmap](docs/roadmap.md).

## Conteúdo placeholder

`src/data/content.ts` tem produtos, looks, depoimentos e fotos
**temporários** (Unsplash), só pra dar forma às seções. É **real**: as
taxonomias (ocasiões, tecidos, modelagens), a numeração 46–60 e as 14 lojas
em `src/data/stores.ts`.

Trocar conteúdo = editar o arquivo de dados. Nenhum componente muda.
