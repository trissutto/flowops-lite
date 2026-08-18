# Fonte editorial das vitrines da home

## Objetivo

Deixar os títulos que anunciam as vitrines da home mais sofisticados e alinhados ao posicionamento de moda feminina da Lurd's Plus Size.

## Decisão visual aprovada

- Fonte: Cormorant Garamond, opção 2 da comparação visual.
- Peso: 500, suficiente para preservar delicadeza e legibilidade.
- Aplicação: títulos das vitrines configuradas na home, incluindo “Mais Top da semana”, “Novidades” e futuras vitrines criadas pela retaguarda.
- Tamanho, cor, CTA, alinhamento e espaçamentos atuais permanecem iguais; muda somente a família tipográfica e os ajustes mínimos de entrelinha necessários para a nova fonte.
- Mobile e desktop usam a mesma identidade editorial.

## Isolamento

- A fonte será carregada por `next/font`, sem requisição externa em tempo de navegação.
- Será criada uma variável tipográfica editorial própria, separada da fonte de títulos geral.
- O componente compartilhado de título receberá uma opção explícita para a fonte editorial.
- Apenas as vitrines da home ativarão essa opção.
- Logo, hero, nomes de produtos, páginas de categoria, checkout e demais títulos do site não serão alterados.

## Desempenho e acessibilidade

- Carregar somente o subconjunto latino e o peso 500.
- Usar `display: swap` para não bloquear a primeira pintura.
- Preservar hierarquia semântica dos títulos e contraste atual.
- Confirmar ausência de corte, sobreposição e rolagem lateral em 360, 390 e 430 pixels.

## Validação

- Conferir “Mais Top da semana” e pelo menos uma segunda vitrine no mobile e no desktop.
- Confirmar que outros usos de `SectionTitle` continuam com Playfair Display.
- Executar lint e build de produção.
