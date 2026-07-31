# Navegação

Fonte única: **`src/data/navigation.ts`**. O array `navigation` alimenta o
menu desktop, o mega menu, o drawer mobile, o índice de busca e o sitemap.
Acrescentar um eixo ali propaga para os cinco.

## Princípio: navegar pela intenção

A ordem não é a árvore do ERP — é a forma como a cliente pensa:

```
Novidades · Looks · Ocasiões · Categorias · Tecidos · Coleções · Tamanhos · Nossas Lojas · Outlet
└─ desejo primeiro ────────┘ └─ técnico depois ──────────┘ └─ físico ─┘
```

Ela não busca "vestido tamanho 52". Busca "o que eu visto no casamento de
sábado". Por isso **Ocasiões** vem antes de **Categorias**.

## Estrutura de um eixo

```ts
{
  label: 'Ocasiões',
  href: '/ocasioes',
  icon: 'CalendarHeart',        // nome do ícone Lucide (drawer mobile)
  menu: {
    columns: [ { title, links: [{ label, href, highlight? }] } ],
    features: [ { eyebrow, title, description, image, href, cta } ],
    quickLinks: [ { label, href } ],
  },
}
```

Sem `menu` → link direto (é o caso de Outlet).
`highlight: true` marca o link principal da coluna (peso maior).
Coluna de continuação (ex: tamanhos 54–60) tem `title: ' '` — o espaço é
preservado pro alinhamento e o rótulo não se repete.

## Desktop

`Navigation.tsx` + `MegaMenu.tsx`.

Abre no **hover e no foco**; fecha com Esc, ao clicar em um link ou 120ms
depois do mouse sair. Esse atraso na saída é deliberado: sem ele o painel
fecha quando o cursor atravessa o vão entre o item e o painel.

Layout do painel: colunas de links à esquerda (até 3), card editorial à
direita (340px), rodapé com "Ver tudo em X" + quick links. O card é o que
impede o mega menu de parecer um dropdown comum.

## Mobile

`MobileDrawer.tsx` — tela cheia, deslizando da esquerda.

Cada eixo é um acordeão com alvo de toque de 56px e título em Playfair 22px.
Aberto, mostra as mesmas colunas do desktop. Abaixo: grade 2×2 de atalhos de
conta e, fixos no rodapé, "Encontrar uma loja" e WhatsApp.

## Rodapé

`layout/Footer.tsx` — quatro colunas fixas (Comprar, Ajuda, A Lurds, Minha
conta), sociais e linha institucional. Definidas no próprio componente porque
não espelham a navegação de vitrine (incluem institucional e conta).

## Sitemap

`app/sitemap.ts` percorre `navigation`, achata os links das colunas, deduplica
por URL e acrescenta as rotas fixas. Eixo novo entra sozinho.

## Ícones

O campo `icon` guarda o **nome** do ícone Lucide (string), não o componente —
assim o arquivo de dados continua sendo dados. Quem renderiza faz o mapa
nome→componente localmente (ver `MobileDrawer`).
