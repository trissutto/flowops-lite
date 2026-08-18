# Hero VLM-222 e vitrines mobile

## Objetivo

Transformar a oferta do vestido VLM-222 no banner principal da home, com uma composição sofisticada e comercial, além de padronizar as vitrines do celular em duas colunas.

## Banner principal aprovado

- Direção visual: opção 1, editorial equilibrada.
- Título: “Conforto em sua forma mais elegante”.
- Chancela: “Linha Conforto”.
- Oferta: “De R$ 239,90” com preço anterior riscado e “R$ 139,90” em destaque.
- CTA: “Comprar agora”.
- Destino de todo o banner: `/produto/ref-vlm-222`, preservando parâmetros de campanha.
- Fotografia: imagem oficial original do VLM-222 preto. O rosto, o corpo, a roupa e o caimento não serão recriados por IA.
- Enquadramento: modelo e vestido inteiros, sem cortar cabeça, pés ou barra e sem deformar a imagem vertical.
- Fundo: cenário neutro inspirado no estúdio da foto original, com parede bege texturizada, luz suave, profundidade e piso discreto. Não usar amarelo chapado.
- O texto “Vestido VLM-222” não aparece visualmente no banner; a referência permanece no link e nos dados do produto.

## Integração na home

- A oferta substituirá o hero principal apenas no desktop nesta etapa.
- O hero deve continuar sendo carregado com prioridade para proteger o LCP.
- Categorias e benefícios permanecem imediatamente depois da primeira tela.
- O banner VLM-222 atualmente localizado no meio da home será removido para evitar duplicidade.
- A configuração mobile do hero não será redesenhada nesta etapa; continuará usando a experiência já existente até a arte mobile ser aprovada.

## Vitrines no celular

- Todas as grades principais de produtos na home devem exibir exatamente duas colunas em larguras mobile.
- Desktop e tablet mantêm as quantidades atuais de colunas.
- Fotos, nomes, preços, parcelamento, tamanhos e selos devem continuar legíveis e sem sobreposição.
- A alteração deve atingir os componentes compartilhados da vitrine, evitando regras diferentes entre seções.

## Validação

- Conferir o hero em desktop largo e notebook.
- Verificar que a foto oficial permanece nítida e natural.
- Confirmar que qualquer clique no hero abre `/produto/ref-vlm-222` com UTMs preservadas.
- Confirmar ausência do banner VLM-222 duplicado no meio da home.
- Validar as vitrines em 360, 390 e 430 pixels com duas colunas.
- Executar build de produção e verificar a home publicada.
