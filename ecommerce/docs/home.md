# Home

`src/app/(public)/page.tsx` é um Server Component orientado à compra.

## Jornada principal

1. Hero real da retaguarda, com CTA único para `/novidades`.
2. Atalhos editoriais para Vestidos, Blusas, Conjuntos, Calças e Outlet.
3. Novidades reais do CRM, com dois cards visíveis no celular.
4. Benefícios: Pix, parcelamento, troca e entrega.
5. Chamada imediata para `/lojas`.
6. Lojas em destaque, Instagram real e newsletter.

Os parâmetros UTM recebidos pela Home são sanitizados e preservados nos links
da jornada principal.

## Origem dos dados

- hero: `getHeroDaHome()`;
- novidades: `fetchVitrine({ ordenar: 'novidades', soNovidade: true })`;
- Instagram: `getInstagram(6)`;
- lojas: `data/stores.ts`;
- categorias editoriais: `data/home.ts`.

As fotos das categorias são direção de arte e não representam produtos
específicos. Produtos, preços, promoções e disponibilidade vêm somente do CRM.

## Desempenho

- as três consultas reais iniciam em paralelo;
- somente o hero é prioritário e recebe preload;
- imagens de categoria são WebP 640 × 640, carregadas sob demanda;
- produtos usam carregamento progressivo;
- vitrines repetidas deixaram de ser consultadas pela Home.

## Estados vazios

Se o CRM não devolver novidades, a seção não aparece. Se o Instagram estiver
indisponível, a grade social não aparece. Hero e tarja usam os fallbacks
oficiais existentes. Nenhum dado fictício é exibido.
