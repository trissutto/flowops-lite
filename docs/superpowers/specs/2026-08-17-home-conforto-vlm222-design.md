# Banner Linha Conforto com VLM-222

## Objetivo

Corrigir o banner da Linha Conforto da home para apresentar o produto real VLM-222, mostrar o vestido completo e levar a cliente diretamente à página do produto.

## Design aprovado

- O banner mantém sua posição e identidade visual atuais.
- A imagem fixa da regata 403048 será removida.
- A imagem será uma foto oficial do vestido VLM-222 obtida do cadastro real do produto.
- A fotografia será tratada como retrato: no celular, área em proporção 4:5; no desktop, coluna vertical à direita com fundo neutro.
- O enquadramento deve preservar a peça inteira, sem ampliar o rosto e sem cortar a barra do vestido. Não haverá distorção para preencher uma área horizontal.
- O texto identificará o produto: “Vestido VLM-222” e destacará conforto e elegância.
- O banner inteiro e a chamada principal apontarão para `/produto/ref-vlm-222`, preservando parâmetros de campanha já incorporados ao link recebido pela home.

## Comportamento responsivo

- Mobile: texto seguido da foto 4:5, com largura total e altura limitada pela proporção.
- Desktop: divisão em duas colunas; texto à esquerda e retrato centralizado à direita, usando `object-contain` quando necessário.
- A cor de fundo ao redor da foto continuará dentro da paleta champanhe da home.

## Dados e falhas

- O href será definido pela página da home e continuará passando pelo componente `AppLink`.
- A foto escolhida deve ser uma URL oficial e estável do catálogo.
- Se a foto não puder ser localizada, a alteração não será publicada com imagem improvisada ou de outro produto.

## Validação

- Confirmar que o clique em qualquer área do banner abre o VLM-222.
- Conferir desktop e celular para garantir vestido inteiro, sem deformação e sem recorte excessivo.
- Executar build de produção e verificar a home publicada.
