# Sacola mobile e confirmação de pagamento

## Objetivo

Remover dois gargalos críticos da jornada mobile sem alterar regras comerciais: manter o acesso ao checkout sempre visível na sacola e impedir que a simples escolha do PIX crie um pedido.

## Escopo

### Sacola lateral

- O painel ocupa no máximo a altura visível do navegador.
- Cabeçalho e rodapé permanecem visíveis.
- Somente o conteúdo central, que contém progresso, produtos, cupom e totais, rola verticalmente.
- O rodapé mantém, nesta ordem:
  1. `Finalizar compra`, como CTA principal;
  2. `Ver sacola completa`, como ação secundária;
  3. `Continuar comprando`, como ação terciária.
- O comportamento deve funcionar com um ou vários itens, inclusive em telas de 400 x 900 px e menores.

### Pagamento por PIX

- O botão `PIX` seleciona o método e dispara `payment_method_selected`, mas não cria pedido.
- Depois da seleção, a etapa exibe:
  - desconto de 5%;
  - valor final do pedido;
  - validade do código;
  - CTA explícito `Gerar PIX e concluir pedido`.
- Somente o CTA final chama a criação do pedido.
- Durante o envio, o CTA fica desabilitado e comunica `Gerando seu código PIX…`.
- Após sucesso, continuam valendo o painel com QR Code, copia-e-cola, contagem regressiva e segunda via já existentes.

### Pagamento por cartão

- O botão `Cartão` somente abre o formulário.
- O formulário termina com `Pagar R$ {total} com cartão`.
- O envio continua protegido contra clique duplicado.

### Erros e recuperação

- Nome, WhatsApp, endereço, CPF, e-mail, entrega e forma de pagamento permanecem no rascunho após falha.
- A mensagem mantém a classificação acionável existente.
- Quando aplicável, o painel oferece tentar novamente ou trocar para PIX sem apagar os dados.
- Nenhum evento `pix_created` é emitido antes de o backend confirmar que o pedido PIX foi criado.

## Eventos

- `payment_method_selected`: escolha visual de PIX ou cartão.
- `checkout_submission`: clique no CTA que realmente cria o pedido.
- `pix_created`: somente após resposta válida contendo pedido e dados PIX.
- `payment_retry`, `card_declined` e `checkout_recovered`: comportamento existente preservado.

## Arquitetura

- `Drawer` recebe a correção estrutural genérica para filhos flexíveis roláveis, evitando que outros painéis também empurrem o rodapé para fora da viewport.
- `PaymentStep` passa a separar seleção de método de confirmação do PIX.
- `CheckoutPage` permanece responsável pela criação do pedido e pela trava contra duplicidade.
- `CardForm` recebe o total formatado no texto do CTA sem alterar tokenização ou integração com o gateway.

## Testes e critérios de aceite

1. Com dois ou mais itens, os três comandos do rodapé da sacola ficam visíveis no mobile.
2. A lista da sacola rola sem mover o rodapé.
3. Clicar em PIX não chama `/api/checkout`.
4. Clicar em `Gerar PIX e concluir pedido` chama `/api/checkout` uma única vez.
5. `pix_created` não é disparado na escolha; somente depois da criação bem-sucedida.
6. Clicar em Cartão não cria pedido e apenas abre o formulário.
7. O CTA do cartão mostra o total e continua bloqueando envio duplicado.
8. Falhas mantêm todos os dados já preenchidos.
9. Testes automatizados e build do ecommerce passam.
10. A jornada é conferida em viewport mobile sem realizar cobrança real.

## Fora do escopo desta entrega

- Redesenho da Home.
- Mudança do limite de frete grátis.
- Retirada sem endereço completo.
- Otimização do serviço de cotação.
- Alteração de regras do gateway ou do backend de pagamentos.

