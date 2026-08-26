# Lançamentos do catálogo geral em todas as lojas

## Objetivo

Aplicar às 14 páginas locais da Lurd's a experiência aprovada em Limeira: hero com lançamento, vitrine automática e contato com a unidade. O catálogo exibido é sempre o catálogo geral do e-commerce, sem filtro de estoque por loja.

## Regra principal

Todas as rotas `/lojas/[cidade]` exibem os mesmos seis lançamentos mais recentes elegíveis do site. A unidade altera somente os dados locais:

- nome da loja e cidade;
- WhatsApp e telefone;
- endereço e mapa;
- Instagram;
- textos que mencionam a unidade.

A página não consulta estoque físico da unidade e não afirma que uma peça está disponível localmente.

## Estrutura compartilhada

### Hero

- Título dinâmico: **Novidades Lurd's em [unidade]**.
- Texto: **Looks plus size do 44 ao 60, com caimento que valoriza você e atendimento acolhedor para experimentar sem pressa.**
- Imagem: primeira foto elegível do lançamento mais recente do catálogo geral.
- CTA primário: **Ver os lançamentos**.
- CTA secundário: **Como chegar**, usando mapa e rastreamento da unidade atual.

Se a imagem não estiver disponível, preservar o hero tipográfico sem quebrar a página.

### Vitrine

- Até seis cards do catálogo geral, ordenados por novidades.
- Mesma seleção em todas as unidades durante o mesmo ciclo de cache.
- Fotos, nomes, preços, cores e tamanhos online vêm do catálogo do e-commerce.
- Cards abrem a página do produto e preservam a cor quando aplicável.
- Aviso dinâmico: **Consulte cores, tamanhos e disponibilidade na loja de [unidade].**

### Contato local

Após a vitrine:

- título **Gostou de algum look?**;
- texto orientando a consultar a equipe da unidade;
- botão **Consultar pelo WhatsApp** apontando para o número correto da loja;
- rastreamento com `store` igual à unidade atual.

### Acolhimento e informações

Todas as páginas recebem o bloco de atendimento acolhedor. Endereço, horários, Instagram, telefone, mapa e lista de outras unidades permanecem como já funcionam hoje.

## Dados e cache

O catálogo é buscado uma vez pela rota server-side usando a fonte geral de novidades. A resposta segue o cache de 60 segundos já adotado pelo e-commerce. Não haverá uma requisição diferente por código de loja.

Se o catálogo falhar ou não devolver itens elegíveis:

- hero cai para a versão tipográfica;
- vitrine apresenta link para `/novidades`;
- WhatsApp, telefone, mapa, endereço e horários continuam disponíveis.

## Rastreamento

Reutilizar a taxonomia existente:

- `view_item_list` para a vitrine;
- `stores_product_click` com a unidade atual;
- `whatsapp_click` com origem `store_launches`;
- `store_locator` com origem `store_hero`.

A atribuição da campanha continua sendo capturada pelo `TrackingProvider`. Nenhum evento novo é necessário.

## Critérios de aceite

- As 14 páginas mostram a mesma seleção do catálogo geral.
- Nenhuma consulta ou filtro usa código de estoque da unidade.
- Nome, WhatsApp, endereço, mapa e Instagram correspondem à rota visitada.
- Nenhuma mensagem promete disponibilidade física.
- Falha do catálogo não remove os dados essenciais da loja.
- Outras páginas do e-commerce permanecem inalteradas.
- A página mantém boa leitura em celular e desktop.

## Fora do escopo

- Estoque físico por loja.
- Vitrine ou curadoria específica por cidade.
- Fotos próprias das unidades.
- Reserva de peças.
- Promoções exclusivas por loja.
