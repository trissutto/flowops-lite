# LURDS MASTERPLAN

**A constituição do novo ecommerce da Lurd's Plus Size.**
Toda sprint, tela e decisão futura obedece a este documento. Se algo aqui
estiver errado, o caminho é alterar o MasterPlan — não ignorá-lo.

Versão 1.0 · criado na Sprint 001 · última atualização: Sprint 005

---

## 1. Visão do produto

Construir o melhor ecommerce de moda plus size do Brasil: uma experiência
digital que a cliente atravessa por prazer, não por necessidade.

A régua não é o mercado brasileiro de plus size. É Apple, Aritzia, COS,
Sézane, Totême e o editorial da Zara.

**O que estamos construindo:** um projeto novo, do zero, em paralelo. O site
atual (`lurds.com.br`, WooCommerce) continua no ar e só será substituído
quando este estiver 100% pronto.

## 2. Filosofia da marca

> Elegância não tem tamanho.

A Lurds nasceu de uma inconformidade: por que roupa bonita só existia até
certo número? A resposta da marca nunca foi "tamanho grande de peça pequena"
— é curadoria de peças desenhadas pro corpo real.

Três compromissos que aparecem em cada tela:

1. **Acolhimento** — nada de julgamento, pressa ou linguagem que trate o corpo
   como problema a resolver. "Disfarça a barriga" é opção de filtro porque a
   cliente pede; nunca vira promessa de correção.
2. **Honestidade de caimento** — mostramos altura, peso e numeração de quem
   comprou. É a informação que resolve a dúvida real e que nenhum concorrente dá.
3. **A loja física importa** — 14 unidades. Todo fluxo online tem uma saída pro
   provador e pro WhatsApp de uma consultora.

**Tom de voz:** direto, feminino, quente. "A gente te recebe com um sorriso",
nunca "oferecemos atendimento diferenciado". Sem gerúndio corporativo, sem
juridiquês, sem exclamação em excesso.

## 3. Objetivos

| Objetivo | Como medimos |
|---|---|
| Percepção de marca premium | tempo na página, páginas/sessão, retorno direto |
| Descoberta (não só busca) | % de sessões que passam por Ocasião/Tecido/Modelagem |
| Conversão online | taxa de adição à sacola, conclusão de checkout |
| Ponte pro físico | cliques em "Como chegar" e WhatsApp por loja |
| Performance | Lighthouse ≥ 95 nas 4 categorias, LCP < 2,5s |
| SEO local | posição para "\<categoria\> plus size \<cidade\>" |

## 4. Público-alvo

Mulher brasileira, 28–55 anos, numeração 46–60. Já foi mal atendida em loja
física e já comprou online algo que não vestiu. Decide por **confiança**:
quer saber se veste, se o tecido é bom e se pode trocar.

Ela não busca "vestido tamanho 52". Busca "o que eu visto no casamento de
sábado". A arquitetura de navegação inteira sai daí.

## 5. Arquitetura

**Stack**

| Camada | Escolha | Por quê |
|---|---|---|
| Framework | Next.js 15 (App Router) | RSC + ISR + streaming; SEO estático de graça |
| UI | React 19 + TypeScript strict | tipagem de domínio ponta a ponta |
| Estilo | Tailwind CSS v4 (`@theme`) | tokens em CSS, zero runtime |
| Movimento | Framer Motion | única lib de animação do projeto |
| Ícones | Lucide (+ `ui/icons.tsx` p/ marcas) | um só vocabulário visual |
| Formulários | React Hook Form + Zod | validação tipada, um schema por form |
| Estado global | Zustand | carrinho/favoritos/overlays; `persist` no cliente |
| Dados remotos | TanStack Query | cache, paginação infinita, retry |
| Carrossel | Embla | touch/mouse/teclado em ~5kb |

**Camadas** (dependência sempre para baixo, nunca para cima)

```
app/          rotas, metadata, JSON-LD, composição de seções
components/   ui · layout · sections · cards · commerce · navigation · feedback
hooks/        comportamento reutilizável
services/     acesso a dados (products, search) ← única porta pra API
data/         conteúdo e taxonomia editáveis
lib/          utils, motion, seo (sem estado, sem React)
types/        contrato de domínio
```

**Regra de ouro:** página compõe, componente renderiza, service busca.
Página nunca faz `fetch` direto nem monta grade na mão.

**Preços sempre em REAIS** (`number`), nunca centavos — herdamos essa lição do
FlowOps, onde dividir por 100 no lugar errado derrubou preços 100×.

## 6. Design System

Fonte única: `src/app/globals.css` (bloco `@theme`). Detalhes em
[docs/design-system.md](docs/design-system.md).

- **Cores** — neutros quentes (papel/creme), dourado como acento
  (`--color-primary`), vinho como secundária, verde **só** para
  WhatsApp/dinheiro.
- **Tipografia** — Playfair Display (títulos, com a palavra de ênfase em
  itálico dourado) + Inter 300 (corpo). Escala fluida com `clamp()`.
- **Espaçamento** — `py-section` (112px) é o respiro padrão entre seções.
- **Raio** — pill nos botões, `rounded-md/lg` em cards.
- **Sombra** — quente e difusa; nunca preto puro, nunca dura.
- **Movimento** — easing `cubic-bezier(0.22,1,0.36,1)`, 320–900ms.
- **Z-index** — escala nomeada em `:root`; nunca número solto.

Assinaturas visuais que identificam a marca em qualquer tela:
`eyebrow` (micro-label caixa-alta com tracking largo), `hairline-gold` (fio
divisor), `link-underline` (sublinhado que cresce), hover de card
(sobe 6px + foto em `scale(1.04)`).

## 7. Componentes

Biblioteca completa em [docs/components.md](docs/components.md) e
[docs/editorial-components.md](docs/editorial-components.md).

**Nenhuma página cria componente próprio.** Se falta algo, entra na
biblioteca — com tipos, documentação e responsividade.

## 8. UX Guidelines

- Navegação pela **intenção** da cliente: Novidades, Looks, Ocasiões antes de
  Categorias.
- Todo caminho tem saída pro humano: WhatsApp e "encontrar loja" a um clique.
- Hover é enfeite, nunca requisito — no mobile tudo é alcançável por toque.
- Alvos de toque ≥ 44px; no mobile, CTAs ocupam largura total.
- Estado vazio nunca é frase seca: ícone + título serif + orientação + saída.
- Skeleton com a silhueta do conteúdo final (zero salto de layout).
- Sem pop-up de newsletter. Nunca.

## 9. UI Guidelines

- Muito branco. Quando em dúvida, aumente o respiro.
- Uma ênfase por bloco. Se tudo está em destaque, nada está.
- Foto grande e pouco texto; o texto explica, a foto convence.
- Dourado em fio, borda e micro-label — nunca preenchendo área grande.
- Números sempre tabulares (`.tabular`) para preços alinharem.

## 10. Padrões de código

Detalhe em [docs/coding-guidelines.md](docs/coding-guidelines.md).

- TypeScript strict; nada de `any`. Props em `interface` no topo do arquivo.
- Componentes em PascalCase, um por arquivo, export nomeado.
- `'use client'` só quando há estado/efeito/evento — o resto é Server Component.
- `cn()` obrigatório em componente que aceita `className`.
- Comentário explica **por que**, nunca **o que**.
- Cor/tamanho hardcoded em componente é bug. Use token.

## 11. Estratégia de SEO

[docs/seo.md](docs/seo.md) · helpers em `lib/seo.ts`.

- Toda página pública: `buildMetadata()` (title, description, canonical, OG,
  Twitter) + JSON-LD pertinente.
- Schema.org: `Organization` + `WebSite` global; `ClothingStore` por unidade
  (SEO local das 14 lojas); `Product`, `ItemList`, `BreadcrumbList` por página.
- URLs amigáveis e estáveis: `/categoria/vestidos`, `/produto/<slug>`,
  `/ocasioes/casamento`.
- Conteúdo educativo indexável em cada categoria (o bloco "Guia Lurds").
- `sitemap.ts` gerado da árvore de navegação real; `robots.ts` barra conta,
  carrinho e checkout.

## 12. Estratégia de Performance

[docs/performance.md](docs/performance.md).

- Server Components por padrão; client só nas ilhas interativas.
- `next/image` sempre, com `sizes` correto, AVIF/WebP, blur placeholder,
  `priority` só no hero.
- `next/font` com `display: swap` e apenas os pesos usados.
- ISR de 1h nas categorias; home estática.
- `optimizePackageImports` em lucide/framer.
- **Dívida conhecida:** o First Load JS está em ~314kB por causa do Framer
  Motion no bundle compartilhado. Meta para a sprint de performance: reduzir
  para < 200kB com import dinâmico das seções abaixo da dobra.

## 13. Estratégia Mobile

Mobile não é "responsivo": é o desenho principal.

- Breakpoints: 420 (large mobile) · 768 (tablet) · 1024 (notebook) · 1280+.
- Drawer de navegação em tela cheia com acordeão por eixo.
- Filtros em drawer com rodapé fixo ("Limpar" / "Ver N peças").
- Carrosséis com gesto nativo e recorte de 10–35% do próximo item (afordância
  de que há mais conteúdo).
- Sem hover-dependência; sem tabela horizontal.

## 14. Acessibilidade

[docs/accessibility.md](docs/accessibility.md).

Contraste AA · `:focus-visible` dourado global · navegação completa por
teclado · `role="dialog"` + foco preso + Esc nos overlays · `inert` no que
está fechado · `alt` descritivo · `prefers-reduced-motion` respeitado ·
skip link no topo.

## 15. Roadmap

Estado real em [docs/roadmap.md](docs/roadmap.md).

| Sprint | Escopo | Status |
|---|---|---|
| 001 | Fundação (tokens, biblioteca base, docs) | ✅ |
| 002 | Header premium + navegação + busca | ✅ |
| 003 | Componentes editoriais | ✅ |
| 004 | Home premium (15 seções) | ✅ |
| 005 | Página de categoria | ✅ |
| 006 | Página de produto | ⬜ |
| 007 | Sacola + mini-carrinho | ⬜ |
| 008 | Checkout | ⬜ |
| 009 | Minha conta + pedidos | ⬜ |
| 010 | Favoritos / wishlist | ⬜ |
| 011 | Nossas lojas (mapa + geolocalização) | ⬜ |
| 012 | Blog / editorial | ⬜ |
| 013 | Busca inteligente (API + facetas) | ⬜ |
| 014 | Consultora IA | ⬜ |
| 015 | Integração com o catálogo do FlowOps | ⬜ |
| 016 | SEO final | ⬜ |
| 017 | Performance (< 200kB, Lighthouse ≥ 95) | ⬜ |
| 018 | Polimento geral + go-live | ⬜ |

## 16. Checklist obrigatório para toda sprint

Antes de considerar uma sprint concluída:

- [ ] Usou **só** componentes da biblioteca (ou adicionou os novos a ela + docs)
- [ ] Nenhuma cor, fonte ou espaçamento fora dos tokens
- [ ] `npx tsc --noEmit` limpo
- [ ] `npm run build` limpo (zero warning)
- [ ] Desktop, notebook, tablet e mobile conferidos
- [ ] Teclado: navega e fecha tudo sem mouse
- [ ] Contraste AA nos textos novos
- [ ] Metadata + JSON-LD nas páginas novas
- [ ] `next/image` com `sizes` em toda imagem
- [ ] Documentação atualizada (`components.md`, `design-system.md`, `roadmap.md`)
- [ ] Pergunta final: **"uma marca como Aritzia publicaria esta tela?"**
      Se não, refatorar.

## 17. Fronteira com o sistema atual (crítico)

Este projeto é **isolado**. O FlowOps (`frontend/`) continua operando PDV,
retaguarda, Live Commerce e o **cadastro da Live** — que é fluxo de receita
ao vivo e **não pode ser tocado**. Nenhuma rota, dependência ou build deste
ecommerce interfere naquele app.

Quando chegar a hora do go-live, a troca de domínio é decisão do dono, com
plano de migração escrito e as URLs da Live preservadas ou redirecionadas de
forma explícita e avisada.
