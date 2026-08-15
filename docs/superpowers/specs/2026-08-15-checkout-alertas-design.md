# Checkout acionável e alertas operacionais

## Objetivo

Reduzir abandono após falhas de pagamento e mostrar à retaguarda quais sessões enfrentaram erros repetidos, sem armazenar dados de cartão ou dados pessoais no painel.

## Comportamento do checkout

- Traduzir códigos técnicos em instruções específicas para a cliente.
- Preservar contato, identidade, entrega e método de pagamento no rascunho já existente.
- Contar falhas consecutivas durante a página atual.
- Depois da segunda falha, oferecer tentar Pix, revisar dados ou chamar o atendimento.
- Registrar no evento a etapa, o método, o código e o número da tentativa.

## Painel operacional

- Reutilizar `site_eventos`, sem nova tabela ou migração.
- Identificar sessões com pelo menos duas falhas em qualquer janela móvel de dez minutos.
- Agrupar por sessão e mostrar etapa, pagamento, código técnico, pedido quando disponível, primeira/última falha e total de tentativas.
- Expor o resultado somente na rota administrativa protegida por JWT.

## Privacidade

- Não enviar número, CVV, validade ou token de cartão aos eventos.
- Não mostrar nome, telefone, e-mail ou CPF no painel de métricas.
- Exibir apenas identificador anônimo de sessão e código do pedido quando existir.

## Validação

- Build do backend.
- Typecheck do frontend administrativo.
- Typecheck, lint e testes do e-commerce.
