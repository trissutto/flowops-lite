# Página da loja Limeira — lançamentos e acolhimento

## Objetivo

Transformar `/lojas/limeira` em um destino de mídia local que desperte desejo pelos lançamentos da Lurd's e apresente o atendimento acolhedor da unidade. A página deve aumentar visitas à loja, consultas pelo WhatsApp e navegação no e-commerce sem exigir fotos próprias da unidade.

## Direção aprovada

A identidade dos anúncios permanece na página matriz da Lurd's. Os anúncios segmentados para Limeira direcionam para `/lojas/limeira`, onde a cliente encontra uma vitrine automática dos lançamentos da marca e os caminhos locais de contato, endereço e mapa.

As fotos serão as imagens profissionais já publicadas nos lançamentos do e-commerce. A página não deve afirmar que um produto está disponível na unidade sem confirmação do estoque local.

## Hierarquia da página

### 1. Hero

Título: **Novidades Lurd's em Limeira**

Texto de apoio: **Looks plus size do 44 ao 60, com caimento que valoriza você e atendimento acolhedor para experimentar sem pressa.**

Ações:

- Primária: **Ver os lançamentos**, levando à vitrine da própria página.
- Secundária: **Como chegar**, abrindo a rota da unidade no Google Maps.

O hero usa uma imagem de lançamento atual. A imagem deve ter boa leitura no celular e nunca receber texto embutido que concorra com o conteúdo HTML.

### 2. Vitrine de lançamentos

Exibir automaticamente os seis produtos mais recentes elegíveis do e-commerce. Cada card contém:

- imagem do produto;
- nome;
- preço;
- tamanhos disponíveis no site;
- ação **Ver look**, abrindo o produto;
- aviso discreto: **Consulte a disponibilidade na loja de Limeira.**

A ordem vem da mesma fonte de verdade usada pela vitrine de novidades do site. Produtos inativos, sem imagem ou indisponíveis não entram na seleção. Se houver menos de seis itens elegíveis, a grade apresenta somente os disponíveis, sem espaços vazios.

### 3. Consulta local

Após a vitrine, apresentar:

**Gostou de algum look?**

**Fale com a equipe de Limeira para saber se a peça está disponível na loja.**

Ação: **Consultar pelo WhatsApp**.

Quando a consulta partir de um produto, a mensagem deve incluir nome e referência da peça. Na chamada geral, manter uma mensagem curta que identifique a página de Limeira.

### 4. Acolhimento

Bloco editorial curto:

**Uma loja feita para você se sentir à vontade**

**Atendimento próximo, consultoras que entendem de caimento e numeração plus size do 46 ao 60.**

Esse bloco não depende de fotografia da equipe. Pode usar composição tipográfica da marca e detalhes visuais já existentes no design system.

### 5. Informações locais

Manter em posição clara:

- endereço;
- horários;
- telefone;
- Instagram local;
- botão de WhatsApp;
- mapa e ação **Como chegar**.

No celular, manter uma ação de WhatsApp acessível durante a navegação sem cobrir preço, variações ou outros controles importantes.

## Medição

Os anúncios devem usar UTMs por loja e criativo, por exemplo:

`/lojas/limeira?utm_source=meta&utm_medium=paid_social&utm_campaign=lojas&utm_content=limeira_ad01`

Medir pelo menos:

- visualização da página da loja;
- clique em produto da vitrine;
- clique no WhatsApp;
- clique em **Como chegar**;
- clique em telefone;
- profundidade de rolagem até a vitrine e informações locais.

Os parâmetros de campanha devem ser preservados nos eventos e, quando tecnicamente adequado, no link para o WhatsApp.

## Estados e falhas

- Se a vitrine não carregar, a página continua exibindo hero, acolhimento e informações da loja.
- Se não houver lançamentos elegíveis, mostrar uma chamada para `/novidades` em vez de uma grade vazia.
- Nenhuma falha da vitrine pode bloquear WhatsApp, mapa ou telefone.
- Horários, telefone e endereço continuam vindo da fonte central de dados das lojas.

## Critérios de aceite

- A página exibe até seis lançamentos atuais sem manutenção manual por unidade.
- Nenhum texto afirma disponibilidade física sem confirmação.
- A cliente chega ao produto, WhatsApp e rota da loja com no máximo um toque a partir da seção correspondente.
- O layout funciona prioritariamente em celular e mantém boa leitura em desktop.
- Links externos e eventos de conversão identificam corretamente a unidade de Limeira.
- A ausência ou falha dos lançamentos não compromete as informações locais.

## Fora do escopo

- Reserva de peças ou provador.
- Sincronização em tempo real do estoque físico na página.
- Produção de fotos próprias da unidade.
- Promoções exclusivas de Limeira.
- Alteração das páginas das demais lojas nesta primeira entrega.
