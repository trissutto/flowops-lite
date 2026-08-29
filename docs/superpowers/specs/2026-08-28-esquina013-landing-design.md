# Esquina 013 — Landing page

## Objetivo

Criar um site público independente para `www.esquina013.com.br` que inaugure a presença digital do Esquina 013, consolide uma identidade de **bar descontraído do dia ao encontro** e converta visitantes em reservas, consultas de programação e visualizações do cardápio.

O site não fará parte das telas operacionais do FlowOps. O código ficará isolado em uma aplicação própria dentro do repositório, sem dependências do backend das lojas.

## Marca e direção visual

- Nome principal: **ESQUINA 013**.
- Assinatura oficial: **LOUNGE • BEACH • BAR**.
- Posicionamento: bar descontraído com porções, música e encontros, funcionando do almoço ao último brinde.
- A narrativa visual acompanha o ciclo do dia: luz natural e tons quentes pela manhã e tarde, sunset no meio da experiência e noite acolhedora no encerramento.
- Paleta principal: areia, branco quente, madeira, laranja queimado e preto; azul-petróleo aparece em pequenos acentos ligados ao litoral.
- Materiais visuais: madeira, concreto claro, fibras naturais, vidro, sombra solar, reflexos do entardecer e neon apenas como assinatura noturna.
- Evitar clichês tropicais, estética tiki, excesso de coqueiros, poluição visual, formalidade de restaurante e aparência exclusiva de balada.
- O logotipo aprovado com fundo preto será usado no cabeçalho e no rodapé. A versão transparente poderá aparecer sobre imagens.

## Estrutura da página

### 1. Cabeçalho

Cabeçalho transparente sobre o hero, tornando-se preto sólido durante a rolagem. Inclui logotipo, links para Experiência, Programação, Cardápio, Galeria e Contato, além de um botão laranja **Reservar**. No celular, a navegação será recolhida em menu acessível.

### 2. Hero

Primeira tela acolhedora, com fotografia real do espaço em luz natural ou no fim de tarde, mostrando mesas, encontros, porções e clima descontraído. Conteúdo:

- assinatura `LOUNGE • BEACH • BAR`;
- título **Seu ponto de encontro em Itanhaém**;
- texto **Porções, drinks, música e boas histórias — do almoço ao último brinde**;
- CTAs **Reservar agora**, **Ver programação** e **Conhecer o cardápio**;
- indicação discreta de rolagem.

O botão de reserva abre o WhatsApp com uma mensagem pré-preenchida para o número `+55 13 99621-8277`.

### 3. Experiência

Seção editorial que apresenta os três pilares da experiência: **Comer**, **Brindar** e **Encontrar**. Cada pilar terá uma descrição curta e uma imagem real. A composição deve ser leve, convidativa e humana, usando tipografia forte e o laranja como acento.

### 4. Programação

Agenda recorrente com cartões para sexta, sábado e domingo. Como atrações e horários específicos ainda não foram fornecidos, os cartões não inventarão artistas. Eles comunicarão música e encontros de fim de semana sem linguagem de balada e encaminharão o visitante ao WhatsApp para confirmar a atração do dia.

### 5. Cardápio

Destaques visuais em três categorias: porções para compartilhar, bebidas geladas e drinks. Porções e mesas terão mais destaque que coquetelaria. Nesta primeira versão, não haverá preços nem itens inventados. A chamada **Ver cardápio / pedir informações** abrirá o WhatsApp até que um cardápio oficial em PDF ou página própria seja fornecido.

### 6. Galeria

Grade responsiva organizada na sequência manhã/tarde, sunset e noite. As imagens deverão mostrar espaço, mesas, porções, bebidas, música e pessoas, com tratamento quente e natural. Fotos noturnas serão usadas somente no final da sequência.

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
- Mudança gradual de fundos claros para escuros ao longo da página, acompanhando o ciclo do dia.
- Brilho neon reservado ao fechamento noturno e ao logotipo.
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

Ao abrir o site, o visitante deve reconhecer imediatamente um bar descontraído e acolhedor para comer, beber, ouvir música e encontrar pessoas durante o dia, no sunset e à noite. Também deve entender, sem esforço, como reservar, consultar a programação, conhecer a proposta gastronômica e chegar ao local.
