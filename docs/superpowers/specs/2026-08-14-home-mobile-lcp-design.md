# Otimização do LCP mobile da home

## Objetivo

Reduzir o LCP mobile observado em 4,2 s sem mudar o desenho da home, o conteúdo comercial ou o comportamento do checkout.

## Diagnóstico

- TBT de 20 ms mostra que JavaScript não é o gargalo principal.
- CLS zero mostra que a reserva de espaço do banner está correta.
- O hero já usa preload responsivo e prioridade alta.
- O popup de cupom só baixa depois de 15 segundos e meia tela de rolagem; ele não participa do LCP inicial.
- A home aguarda banner, categorias e Instagram sequencialmente antes de iniciar as seis consultas de vitrine. Essa cascata aumenta o tempo até o HTML e a imagem LCP serem descobertos.

## Solução escolhida

1. Iniciar banner, categorias, Instagram e vitrines simultaneamente no servidor.
2. Preservar fallbacks e cache de cada serviço.
3. Garantir que o elemento LCP não dependa de animação de entrada/opacidade.
4. Manter somente uma imagem responsiva do hero, com preload e `fetchPriority="high"` existentes.
5. Não carregar antecipadamente popup, cards inferiores ou imagens fora da dobra.

## Alternativas descartadas

- Streaming de todas as seções: maior complexidade e risco de alterar a ordem visual.
- Apenas recomprimir o banner: depende do arquivo publicado e não elimina a cascata do servidor.
- Cortar chunks JavaScript: o TBT já está excelente e o ganho esperado no LCP seria pequeno.

## Verificação

- Testar que as consultas independentes começam antes de qualquer uma terminar.
- Confirmar HTML com preload mobile e prioridade alta.
- Executar testes, TypeScript, lint e build de produção.
- Após o deploy, repetir PageSpeed mobile; meta inicial: LCP abaixo de 3,5 s sem regressão de CLS/TBT.
