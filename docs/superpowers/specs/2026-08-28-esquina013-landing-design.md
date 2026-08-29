# Esquina 013 — Landing page

## Objetivo

Criar um site público independente para `www.esquina013.com.br` que inaugure a presença digital do Esquina 013, consolide a identidade **Urban Beach Night** e converta visitantes em reservas, consultas de programação e visualizações do cardápio.

O site não fará parte das telas operacionais do FlowOps. O código ficará isolado em uma aplicação própria dentro do repositório, sem dependências do backend das lojas.

## Marca e direção visual

- Nome principal: **ESQUINA 013**.
- Assinatura oficial: **LOUNGE • BEACH • BAR**.
- Posicionamento: beach club urbano, jovem, noturno e sofisticado.
- Paleta principal: preto, grafite, branco quente e laranja-neon; azul-petróleo apenas como acento atmosférico.
- Materiais visuais: concreto escuro, vidro fumê, reflexos molhados, luz âmbar e linhas abstratas inspiradas em ondas.
- Evitar clichês tropicais, estética tiki, excesso de coqueiros, poluição visual e aparência genérica de balada.
- O logotipo aprovado com fundo preto será usado no cabeçalho e no rodapé. A versão transparente poderá aparecer sobre imagens.

## Estrutura da página

### 1. Cabeçalho

Cabeçalho transparente sobre o hero, tornando-se preto sólido durante a rolagem. Inclui logotipo, links para Experiência, Programação, Cardápio, Galeria e Contato, além de um botão laranja **Reservar**. No celular, a navegação será recolhida em menu acessível.

### 2. Hero

Primeira tela imersiva, com fotografia ou composição cinematográfica de lounge noturno e iluminação laranja. Conteúdo:

- assinatura `LOUNGE • BEACH • BAR`;
- título **A noite começa na esquina**;
- texto curto apresentando gastronomia, drinks, música e atmosfera à beira-mar;
- CTAs **Reservar agora**, **Ver programação** e **Conhecer o cardápio**;
- indicação discreta de rolagem.

O botão de reserva abre o WhatsApp com uma mensagem pré-preenchida para o número `+55 13 99621-8277`.

### 3. Experiência

Seção editorial que apresenta os três pilares da marca: **Lounge**, **Beach** e **Bar**. Cada pilar terá uma descrição curta e uma imagem ou recorte visual. A composição deve alternar áreas amplas, tipografia condensada e detalhes em neon.

### 4. Programação

Agenda recorrente com cartões para sexta, sábado e domingo. Como atrações e horários específicos ainda não foram fornecidos, os cartões não inventarão artistas. Eles comunicarão a programação de fim de semana e encaminharão o visitante ao WhatsApp para confirmar a atração do dia.

### 5. Cardápio

Destaques visuais em três categorias: drinks autorais, gastronomia e porções para compartilhar. Nesta primeira versão, não haverá preços nem itens inventados. A chamada **Ver cardápio / pedir informações** abrirá o WhatsApp até que um cardápio oficial em PDF ou página própria seja fornecido.

### 6. Galeria

Grade responsiva com atmosfera noturna, detalhes de drinks, iluminação, público e espaço. As imagens deverão manter tratamento consistente em preto, laranja e azul-petróleo, com carregamento otimizado.

### 7. Localização e contato

- Endereço: Avenida Doutor Edson Baptista de Andrade, 1216 — Cibratel I, Itanhaém/SP.
- Funcionamento: sexta, sábado e domingo, das 9h às 23h.
- WhatsApp: (13) 99621-8277.
- Botão **Como chegar** abrindo a rota no Google Maps.
- Botão **Reservar pelo WhatsApp** com mensagem pré-preenchida.

### 8. Rodapé

Logotipo, assinatura, navegação essencial, endereço, horário e direitos da marca. Links sociais serão adicionados quando os perfis oficiais forem fornecidos; a primeira versão não exibirá ícones sem destino.

## Interações e movimento

- Entrada suave de textos e imagens conforme a rolagem.
- Brilho neon controlado nos CTAs e elementos de destaque.
- Microinterações rápidas em botões e cartões.
- Respeito à preferência `prefers-reduced-motion`.
- Nenhum efeito deverá prejudicar leitura, desempenho ou navegação pelo teclado.

## Arquitetura

A landing page será uma aplicação pública independente e estática, sem banco de dados ou autenticação. Conteúdo, programação recorrente e destaques ficarão organizados em estruturas simples no próprio projeto para facilitar futuras alterações. Reservas e consultas serão encaminhadas ao WhatsApp; localização será aberta externamente no Google Maps.

Imagens serão otimizadas e servidas localmente. O site terá metadados de compartilhamento, favicon, título e descrição próprios. A estrutura ficará preparada para publicação e conexão ao domínio `www.esquina013.com.br`.

## Responsividade e acessibilidade

- Layout adaptado para celular, tablet e desktop.
- Contraste adequado entre textos e fundos.
- Foco visível e navegação por teclado.
- Botões com área de toque confortável.
- Textos alternativos nas imagens relevantes.
- Hierarquia semântica correta de títulos e seções.

## Estados e falhas

- Links externos abrirão com segurança.
- Caso imagens não carreguem, o fundo e a tipografia preservarão a legibilidade.
- O site não dependerá de APIs externas para renderizar o conteúdo principal.
- WhatsApp e Maps usarão URLs diretas, reduzindo pontos de falha.

## Validação

- Conferir o texto exato da marca e da assinatura.
- Testar os três CTAs principais e a mensagem do WhatsApp.
- Testar o link de rota do endereço.
- Validar layout em larguras de celular e desktop.
- Verificar navegação por teclado, contraste e redução de movimento.
- Executar a compilação de produção antes da entrega.

## Critério de sucesso

Ao abrir o site, o visitante deve reconhecer imediatamente uma marca de lounge beach bar premium e entender, sem esforço, como reservar, consultar a programação, conhecer a proposta gastronômica e chegar ao local.
