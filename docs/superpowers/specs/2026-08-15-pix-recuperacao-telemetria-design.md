# Recuperação de checkout e telemetria de pagamento

## Objetivo

Recuperar pagamentos interrompidos sem contato indevido e tornar o funil de pagamento diagnosticável. A solução preserva a experiência PIX existente (QR Code, copia-e-cola, contagem regressiva, atualização automática e segunda via em Meus pedidos) e acrescenta consentimento verificável e eventos operacionais.

## Decisões

- O consentimento para lembrete por WhatsApp é opcional, desmarcado por padrão e salvo no rascunho, na captura de recuperação e no pedido.
- O cron de PIX não envia mensagem para pedidos antigos, consentimento ausente, falso ou JSON inválido.
- Contatos sem consentimento podem manter o checkout retomável, mas não aparecem em filas de contato ativo.
- `pix_created` representa PIX emitido, não abandono. A perda só é distinguida por `pix_expired`; pagamento confirmado gera `checkout_recovered`.
- Eventos não carregam nome, telefone, cartão ou endereço. Somente método, tentativa, código técnico e identificador interno do pedido podem ser persistidos.

## Fluxo

1. A cliente informa nome e telefone e decide se aceita o lembrete.
2. O BFF captura o estado para retomada e o backend persiste a decisão explícita.
3. A escolha do pagamento gera `payment_method_selected`.
4. Nova tentativa gera `payment_retry`; recusa de cartão gera `card_declined`.
5. Para PIX, copiar gera `pix_copied`; vencimento gera `pix_expired`; confirmação gera `checkout_recovered`.
6. Após 30 minutos, ainda dentro da validade, o cron envia no máximo um lembrete e somente se `recovery_consent` for verdadeiro.

## Validação

- Testes unitários cobrem persistência do opt-in e bloqueio do lembrete sem consentimento.
- Build e checagem de tipos cobrem o contrato compartilhado de checkout e tracking.
- A retaguarda recebe rótulos legíveis para os novos eventos sem confundir PIX criado com abandono.
