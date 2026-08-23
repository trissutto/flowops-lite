# Hero da home com uma única imagem responsiva

## Objetivo

Reduzir o LCP mobile sem alterar a aparência, o texto, o link ou a qualidade percebida do hero VLM-222.

## Diagnóstico

A home renderiza dois elementos de imagem prioritários: um desktop e outro mobile. O HTML de produção emite preload para os dois, portanto eles podem disputar a conexão mesmo quando um dos layouts está oculto por CSS. A imagem mobile já tem apenas 30 KB e é servida rapidamente pelo cache; recomprimi-la não ataca o gargalo.

## Solução

- Renderizar um único elemento `<picture>` para a fotografia do hero.
- Usar a arte mobile abaixo de 1024 px e a arte desktop a partir de 1024 px.
- Emitir preloads mutuamente exclusivos por `media`, ambos com prioridade alta.
- Preservar os dois tratamentos de layout e texto por CSS, sem duplicar a imagem.
- Manter dimensões declaradas para preservar CLS zero.

## Alternativas descartadas

- Apenas retirar `priority` de uma imagem: melhora um viewport e piora o outro.
- Comprimir novamente a arte mobile: economia pequena sobre um arquivo de 30 KB.
- Escolher a imagem em JavaScript: descobre a foto tarde demais e piora o LCP.

## Verificação

- Testes e build de produção do ecommerce.
- HTML deve conter preloads com media queries excludentes.
- Deve existir apenas um `<picture>`/`<img>` do VLM-222 no hero.
- Conferência visual nos breakpoints mobile e desktop.

