# Preload do hero e imagens progressivas — design

## Objetivo

Melhorar o LCP e reduzir downloads prematuros na home sem mudar o visual, a quantidade de produtos, a ordem das seções ou os fluxos comerciais.

## Escopo aprovado

1. Emitir preload responsivo explícito para a imagem do hero da home.
2. Carregar imagens de vitrines abaixo da dobra somente quando estiverem próximas do viewport.

Ficam fora do escopo: reduzir produtos, alterar vitrines, trocar textos, modificar animações, atualizar dependências ou implantar mudanças de segurança.

## Preload responsivo do hero

A home já resolve no servidor o banner ativo e suas artes desktop/mobile. Ela passará essas informações para um mecanismo de preload no documento, preservando o `<picture>` responsivo existente.

O preload deverá:

- usar `as="image"`;
- selecionar a arte correta por media query ou `imageSrcSet`/`imageSizes`;
- iniciar apenas uma imagem adequada ao viewport;
- manter `fetchPriority="high"` no elemento visual;
- não alterar dimensões, recorte, texto ou botões do hero;
- funcionar quando existir somente a imagem desktop.

## Carregamento progressivo abaixo da dobra

Uma unidade reutilizável baseada em `IntersectionObserver` controlará a montagem das imagens elegíveis. Antes da aproximação ao viewport, o card mantém um contêiner com a mesma proporção e placeholder visual. Ao entrar numa margem antecipada de aproximadamente 300 px, a imagem Next.js é montada e passa a carregar.

Regras:

- hero e imagens do primeiro viewport não serão adiados;
- cards abaixo da dobra serão elegíveis ao carregamento progressivo;
- imagens marcadas como prioritárias continuarão imediatas;
- cada imagem carregará uma única vez depois de ativada;
- navegadores sem `IntersectionObserver` carregarão imediatamente como fallback;
- o espaço ficará reservado, preservando CLS igual a zero;
- links, favoritos, quick-add, hover e carrosséis continuarão funcionando;
- não haverá busca adicional de produtos nem alteração no payload comercial.

## Fronteiras técnicas

O observador será isolado em um pequeno hook/componente cliente. Os cards já interativos poderão consumi-lo sem ampliar desnecessariamente novas fronteiras `use client`. A API deve permitir que cada imagem preserve `src`, `alt`, `sizes`, placeholder e comportamento prioritário existentes.

## Verificação

1. Testes unitários do estado antes/depois da interseção e do fallback.
2. Testes existentes do ecommerce.
3. ESLint sem novos erros.
4. Build de produção.
5. Inspeção do HTML para confirmar preload `as="image"` responsivo.
6. Inspeção no navegador para confirmar que imagens distantes não são solicitadas antes da aproximação.
7. Conferência visual mobile e desktop para garantir ausência de mudança e de layout shift.

## Critérios de aceite

- O hero correto começa a carregar a partir do preload, sem download duplicado de mobile e desktop.
- Imagens muito abaixo da dobra não aparecem na rede até ficarem próximas do viewport.
- A margem de antecipação evita placeholder visível durante rolagem normal.
- CLS permanece zero no cenário Lighthouse.
- Nenhuma regressão em links, cards, carrosséis ou acessibilidade.

