# Programa de melhoria do funil do e-commerce

Data: 14/08/2026

## Objetivo

Reduzir perdas entre visita, produto, sacola, checkout, pagamento e compra confirmada sem introduzir risco no fluxo de vendas. PagBank e Pagar.me não serão alterados sem diagnóstico documentado e aprovação explícita do dono.

## Estratégia de entrega

O trabalho será dividido em três PRs independentes e reversíveis.

### PR 1 — observabilidade e diagnóstico

- Tornar o funil capaz de explicar perdas, não apenas contar etapas.
- Registrar eventos de interação e falha sem dados pessoais ou dados de cartão.
- Deduplicar etapas de conversão por sessão, evento e entidade relevante.
- Exibir motivos de falha e abandono no relatório administrativo.
- Criar testes para o contrato dos eventos e para as agregações.
- Não modificar criação, consulta, confirmação ou conciliação de cobranças.

### PR 2 — produto e sacola

- Tornar seleção de cor e tamanho inequívoca.
- Explicar visualmente por que o botão está indisponível.
- Manter CTA de compra acessível no celular sem cobrir outros controles.
- Aproximar frete, prazo, troca, PIX e parcelamento da decisão de compra.
- Simplificar o mini carrinho e preservar a sacola em navegação e atualização.
- Instrumentar cada interação para comparar antes e depois.

### PR 3 — checkout e mobile

- Melhorar preenchimento automático, teclado e validação de CPF, telefone, CEP e endereço.
- Mostrar erros no campo e um resumo acionável no envio.
- Registrar falha de validação, frete e tentativa de pagamento por categoria segura.
- Reduzir distrações e deixar totais, descontos e frete consistentes.
- Validar fluxos completos em viewport móvel e desktop.

## Contrato de segurança

- Nenhum PAN, CVV, token de cartão, código PIX, CPF, e-mail, telefone ou endereço será incluído em métricas.
- Falhas serão registradas por códigos fechados e campos, nunca pelo valor digitado.
- Métrica nunca poderá impedir navegação, carrinho, checkout ou confirmação de pagamento.
- Eventos de compra continuam exclusivamente server-side.
- Qualquer conclusão que exija alterar PagBank ou Pagar.me será entregue como diagnóstico separado e aguardará autorização.

## Modelo do funil

Etapas principais, contadas por sessões distintas:

1. `page_view`
2. `view_item`
3. `add_to_cart`
4. `begin_checkout`
5. `add_payment_info`
6. `purchase`

Eventos diagnósticos complementares:

- `select_color`
- `select_size`
- `add_to_cart_blocked`
- `checkout_validation_error`
- `shipping_quote_error`
- `shipping_method_selected`
- `payment_method_selected`
- `payment_attempt`
- `payment_error`
- `pix_created`

Os diagnósticos usam códigos controlados em `dados`, com tamanho limitado. A etapa principal continua estável para preservar comparações históricas.

## Deduplicação e atribuição

- `page_view` pode ocorrer por página, mas o funil administrativo conta pessoas por `session_id`.
- Etapas de conversão enviadas pelo navegador ganham chave determinística por sessão e contexto para evitar duplo clique.
- `purchase` permanece idempotente pelo identificador do pedido no servidor.
- O relatório mostra eventos brutos, pessoas e conversão sobre a etapa anterior.

## Relatório administrativo

O endpoint do funil passará a devolver:

- etapas ordenadas, inclusive quando zeradas;
- eventos e pessoas por etapa;
- conversão sobre a etapa anterior;
- diagnósticos agrupados por evento, código e campo;
- separação de tentativa de pagamento por método, sem expor dados sensíveis.

## Tratamento de falhas

- Persistência de métricas continua fail-open.
- Payload desconhecido é sanitizado ou descartado silenciosamente.
- Falha de tracking é registrada em log, sem mudar a resposta comercial ao cliente.
- Relatório não executa consultas sem limite de período ou cardinalidade.

## Verificação

- Testes unitários do sanitizador, deduplicação e agregação.
- Testes das rotas de eventos e webhook existentes.
- Typecheck, lint, suíte completa e build dos projetos afetados.
- Teste manual de produto, sacola e checkout em desktop e mobile.
- Comparação do funil por pelo menos sete dias após cada PR.

## Checklist mestre

### Pagamento e diagnóstico

- [ ] Confirmar integridade das seis etapas do funil.
- [ ] Separar PIX criado, cartão tentado, erro de validação, erro de gateway e compra confirmada.
- [ ] Identificar pedidos presos e pagamentos confirmados sem `purchase` de marketing.
- [ ] Garantir ausência de PII e dados financeiros nas métricas.
- [ ] Apresentar diagnóstico antes de qualquer alteração em PagBank/Pagar.me.

### Produto e sacola

- [ ] Auditar seleção de cor e tamanho.
- [ ] Auditar estados bloqueados do CTA.
- [ ] Exibir frete, prazo, PIX, parcelamento e troca no contexto da decisão.
- [ ] Auditar persistência e recuperação da sacola.
- [ ] Simplificar o caminho do mini carrinho ao checkout.

### Checkout

- [ ] Auditar identificação, endereço, frete e pagamento.
- [ ] Melhorar autocomplete e teclados móveis.
- [ ] Exibir erros acionáveis no local correto.
- [ ] Garantir consistência de subtotal, descontos, frete e total.
- [ ] Garantir retomada segura após falha.

### Mobile e qualidade

- [ ] Testar sem overflow horizontal.
- [ ] Testar CTAs fixos e overlays sem colisão.
- [ ] Testar 390 px e desktop.
- [ ] Rodar testes, typecheck, lint, build e auditoria de links.
- [ ] Entregar cada fase em branch, push e PR separado.

## Fora de escopo sem nova aprovação

- Trocar gateway.
- Alterar credenciais, webhooks ou regras de cobrança.
- Modificar valores, parcelamento, validade do PIX ou política antifraude.
- Executar deploy de backend em horário de loja.
