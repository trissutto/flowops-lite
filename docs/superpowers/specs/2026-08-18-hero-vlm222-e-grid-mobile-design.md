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

## Versão mobile aprovada

- Direção visual: composição editorial dividida, derivada do hero desktop.
- Proporção: vertical e compacta, adequada à primeira dobra em telas de 360, 390 e 430 pixels.
- Texto e oferta ficam em uma área calma no topo esquerdo, sem cobrir rosto, corpo ou vestido.
- A modelo aparece inteira à direita e abaixo, preservando rosto, roupa, caimento, pés e barra da fotografia oficial.
- O cenário mantém a parede bege, luz suave e profundidade do desktop; não usar fundo amarelo chapado.
- Chancela: “Linha Conforto”.
- Título: “Conforto em sua forma mais elegante”.
- Oferta: preço anterior de R$ 239,90 riscado e preço atual de R$ 139,90 em destaque.
- CTA: “Comprar agora”, com área de toque mínima de 44 pixels.
- Todo o hero leva a `/produto/ref-vlm-222`, preservando parâmetros de campanha.
- O navegador deve carregar somente a imagem correspondente ao breakpoint atual, protegendo o LCP e evitando download duplo.

## Integração na home

- A oferta substituirá o hero principal no desktop e no mobile.
- O hero deve continuar sendo carregado com prioridade para proteger o LCP.
- Categorias e benefícios permanecem imediatamente depois da primeira tela.
- O banner VLM-222 atualmente localizado no meio da home será removido para evitar duplicidade.
- A experiência anterior do hero mobile será removida depois que a versão VLM-222 estiver validada nos três tamanhos previstos.

## Vitrines no celular

- Todas as grades principais de produtos na home devem exibir exatamente duas colunas em larguras mobile.
- Desktop e tablet mantêm as quantidades atuais de colunas.
- Fotos, nomes, preços, parcelamento, tamanhos e selos devem continuar legíveis e sem sobreposição.
- A alteração deve atingir os componentes compartilhados da vitrine, evitando regras diferentes entre seções.

## Validação

- Conferir o hero em desktop largo e notebook.
- Conferir o hero mobile em 360, 390 e 430 pixels, verificando leitura, área de toque e enquadramento.
- Verificar que a foto oficial permanece nítida e natural.
- Confirmar que qualquer clique no hero abre `/produto/ref-vlm-222` com UTMs preservadas.
- Confirmar ausência do banner VLM-222 duplicado no meio da home.
- Validar as vitrines em 360, 390 e 430 pixels com duas colunas.
- Executar build de produção e verificar a home publicada.
