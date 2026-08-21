# Correção de qualidade do banner VLM-222

## Problema

O banner atual é uma única imagem rasterizada de 1920 × 800 px. Em telas largas ela é ampliada e as quatro fotos perdem nitidez.

## Alternativas consideradas

1. Gerar um arquivo único maior: preserva o layout, mas aumenta muito o peso e ainda pode degradar em telas maiores.
2. Usar quatro imagens originais no componente: mantém a resolução percebida e permite que o navegador carregue versões adequadas. Esta é a opção escolhida.
3. Voltar ao banner anterior: resolve imediatamente a pixelização, mas remove a campanha VLM-222.

## Solução aprovada

- Manter texto, chamada e link para o VLM-222.
- Montar a área visual com quatro fotos originais do produto, uma por cor, sem ampliar cada arquivo além da resolução útil.
- Usar o componente de imagem otimizada do projeto para entregar tamanhos responsivos e formatos compactos.
- Priorizar apenas a primeira imagem; as demais seguem o carregamento otimizado do navegador.
- Preservar a versão responsiva para celular, evitando baixar quatro imagens grandes quando uma composição menor for suficiente.

## Critérios de aceitação

- As modelos aparecem nítidas em desktop, inclusive em telas de 1920 e 2048 px.
- Nenhuma foto é deformada ou recortada de forma inadequada.
- O banner continua levando para `/produto/ref-vlm-222`.
- O carregamento não apresenta regressão perceptível e os arquivos entregues são responsivos.
- Lint e build do ecommerce passam antes da publicação.
