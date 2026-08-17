# Plano de implementação — Leve 4, Pague 3

## Meta

Preparar a campanha inteira com a chave desligada, validar cálculo, UX e criativos, e permitir ativação administrativa sem novo deploy.

## Princípios de execução

- O backend decide valores e elegibilidade.
- A configuração nasce com `enabled: false`.
- O frontend apenas antecipa a conta para melhorar a experiência.
- A promoção concede no máximo uma peça grátis por pedido.
- Quatro produtos diferentes são contados por `productId`; quantidade, tamanho e cor não criam produtos adicionais.
- Nenhuma ativação ocorre durante a implementação.
- Os 30 criativos finais usam fotos oficiais de lançamentos reais.

## Etapa 1 — Evoluir a configuração promocional

**Arquivos principais**

- `backend/src/progressive-discount/progressive-discount.service.ts`
- `backend/src/progressive-discount/progressive-discount.controller.ts`
- `backend/src/progressive-discount/progressive-discount.service.spec.ts` (novo)

**Trabalho**

1. Acrescentar um modo de campanha `buy_4_pay_3` sem remover o modo progressivo existente.
2. Adicionar `campaignCode`, `headline`, `updatedAt` e `updatedBy` à configuração.
3. Manter `enabled: false` como padrão e datas opcionais.
4. Criar um resultado específico contendo item grátis, valor economizado, quantidade de produtos diferentes e progresso restante.
5. Calcular uma única gratuidade usando o menor preço entre quatro `productId` distintos.
6. Fazer falha de leitura equivaler a campanha desligada.
7. Expor somente campos seguros no endpoint público.

**Testes**

- desligada não aplica desconto;
- um a três produtos retornam progresso correto;
- quatro produtos diferentes concedem uma gratuidade;
- duas variações do mesmo produto contam uma vez;
- produto já promocional usa o preço atual;
- preços iguais produzem desconto determinístico;
- cinco ou mais produtos concedem somente uma gratuidade;
- datas vazias não impedem a ativação manual.

## Etapa 2 — Integrar o cálculo ao pedido real

**Arquivos principais**

- `backend/src/loja-orders/loja-orders.module.ts`
- `backend/src/loja-orders/loja-orders.service.ts`
- `backend/src/loja-orders/carrinho-guard.service.ts`
- `backend/src/loja-orders/loja-orders.service.spec.ts` ou teste focado novo

**Trabalho**

1. Injetar o serviço promocional no módulo de pedidos.
2. Calcular a gratuidade somente depois de o `CarrinhoGuard` confirmar preço, publicação e estoque.
3. Quando a campanha for aplicada, rejeitar cupom enviado pelo cliente com mensagem acionável.
4. Zerar o desconto adicional de Pix no cálculo do pedido promocional.
5. Persistir no `checkoutInfo`/`paymentInfo` o código da campanha, item gratuito, preço-base e desconto.
6. Incluir os novos valores na resposta devolvida ao ecommerce.
7. Preservar os dados promocionais após pagamento, cancelamento e consulta do pedido.

**Testes**

- total cobrado corresponde a subtotal menos item grátis mais frete;
- cupom não acumula;
- Pix não acumula 5%;
- alteração de preço antes do pagamento recalcula a peça grátis;
- desligamento durante o checkout impede novo desconto sem alterar pedido concluído;
- total informado pelo cliente nunca supera a decisão do backend.

## Etapa 3 — Criar cliente público e cálculo de exibição

**Arquivos principais**

- `ecommerce/src/services/promotion.ts` (novo)
- `ecommerce/src/lib/commerce/buy-four-pay-three.ts` (novo)
- `ecommerce/src/lib/commerce/buy-four-pay-three.test.ts` (novo)
- `ecommerce/src/types/promotion.ts` (novo)

**Trabalho**

1. Buscar a configuração pública com cache curto e fallback desligado.
2. Criar cálculo puro de exibição com o mesmo contrato do backend.
3. Retornar progresso, item grátis, desconto e bloqueios de outros benefícios.
4. Nunca persistir valor promocional no Zustand; recalcular a partir das linhas atuais.

## Etapa 4 — Atualizar sacola e minicarrinho

**Arquivos principais**

- `ecommerce/src/components/commerce/MiniCart.tsx`
- `ecommerce/src/components/commerce/CartLineRow.tsx`
- `ecommerce/src/components/commerce/PromotionProgress.tsx` (novo)
- `ecommerce/src/store/cart.ts`

**Trabalho**

1. Mostrar progresso de um a quatro produtos diferentes.
2. Identificar visualmente a peça grátis quando elegível.
3. Exibir valor economizado no resumo.
4. Limpar cupom já armazenado quando a cliente aceitar a promoção.
5. Desabilitar o campo de cupom com explicação curta enquanto a campanha estiver aplicada.
6. Manter a sacola utilizável se o endpoint promocional estiver indisponível.

## Etapa 5 — Atualizar checkout e BFF

**Arquivos principais**

- `ecommerce/src/app/(checkout)/checkout/page.tsx`
- `ecommerce/src/app/api/checkout/route.ts`
- `ecommerce/src/components/checkout/OrderSummary.tsx`
- `ecommerce/src/components/checkout/ReviewCard.tsx`
- `ecommerce/src/components/checkout/PaymentStep.tsx`
- `ecommerce/src/types/checkout.ts`

**Trabalho**

1. Recalcular a prévia promocional no BFF.
2. Não aplicar `applyCoupon` nem `pixDiscount` quando `buy_4_pay_3` estiver elegível.
3. Mostrar a linha “Peça grátis — Leve 4, Pague 3”.
4. Remover promessas de 5% no Pix das mensagens e botões durante a campanha.
5. Enviar fatos do carrinho, nunca um desconto confiado ao cliente.
6. Tratar divergência do backend preservando formulário e etapa atual.

## Etapa 6 — Integrar comunicação na home e catálogo

**Arquivos principais**

- `ecommerce/src/app/(public)/page.tsx`
- `ecommerce/src/components/sections/Hero.tsx`
- `ecommerce/src/services/banners.ts`
- `ecommerce/src/components/cards/ProductCard.tsx`
- `ecommerce/src/components/marketing/PromotionStrip.tsx` (novo)

**Trabalho**

1. Quando desligada, renderizar exatamente a home atual.
2. Quando ligada, usar hero e chamada promocionais sem carregar carrossel adicional.
3. Inserir faixa compacta com a regra e link para a landing page.
4. Adicionar selo discreto aos cards sem ocultar preço ou desconto real existente.
5. Fazer texto e CTA em HTML; usar foto otimizada como fundo.

## Etapa 7 — Criar landing page da campanha

**Arquivos principais**

- `ecommerce/src/app/(public)/leve-4-pague-3/page.tsx` (novo)
- `ecommerce/src/components/sections/PromotionExplainer.tsx` (novo)
- `ecommerce/src/data/home.ts`

**Trabalho**

1. Explicar a regra em três passos.
2. Carregar lançamentos reais e navegação por categoria.
3. Preservar UTMs em links internos.
4. Exibir estado encerrado/desligado sem prometer desconto.
5. Usar metadados e texto indexável sem criar conteúdo enganoso.

## Etapa 8 — Atualizar o painel administrativo

**Arquivos principais**

- `frontend/src/components/ProgressiveDiscountAdmin.tsx`
- `frontend/src/app/retaguarda/app-push/page.tsx` ou nova rota de promoções

**Trabalho**

1. Renomear a área para “Leve 4, Pague 3”.
2. Exibir chave grande com estado LIGADO/DESLIGADO.
3. Ocultar faixas percentuais quando o modo for `buy_4_pay_3`.
4. Fixar as regras aprovadas na tela: quatro produtos diferentes, menor grátis, sem acúmulo.
5. Pedir confirmação explícita antes de ligar.
6. Mostrar autor e horário da última alteração.
7. Manter a chave desligada no commit e no deploy.

## Etapa 9 — Instrumentação

**Arquivos principais**

- `ecommerce/src/lib/tracking/events.ts`
- `ecommerce/src/lib/tracking/types.ts`
- `ecommerce/src/lib/tracking/schemas.ts`
- `ecommerce/src/lib/tracking/destinations/meta-pixel.ts`
- `ecommerce/src/lib/tracking/server/meta-capi.ts`

**Eventos**

- `promotion_view`;
- `promotion_click`;
- `promotion_progress`;
- `free_item_applied`;
- `free_item_removed`;
- `purchase` com `campaign_code`, quantidade de itens e desconto promocional.

Garantir deduplicação Pixel/CAPI e manter consentimento existente.

## Etapa 10 — Produzir os 30 criativos

**Diretório de entrega**

- `ecommerce/public/campaigns/leve-4-pague-3/feed/`
- `docs/campaigns/leve-4-pague-3/manifest.csv`

**Processo**

1. Obter lista e fotos oficiais dos lançamentos publicados.
2. Selecionar 18 produtos editoriais, seis combinações e seis mensagens de recuperação.
3. Criar cada peça individualmente em 1080 × 1350.
4. Aplicar texto controlado e revisar ortografia.
5. Exportar originais de campanha em JPG de alta qualidade; gerar WebP/AVIF apenas para uso no site.
6. Registrar no manifesto: arquivo, produto/ref, objetivo, público, texto, legenda, CTA, URL e UTM.
7. Conferir que nenhuma peça ou condição inexistente foi anunciada.

## Etapa 11 — Verificação integrada

1. Executar testes unitários de backend e ecommerce.
2. Executar builds de backend, frontend e ecommerce.
3. Testar manualmente chave desligada, ligada e desligada novamente.
4. Simular carrinhos com produtos repetidos, diferentes, promocionais e mudança de preço.
5. Confirmar totais de Pix e cartão.
6. Verificar home e checkout em 360, 390 e 430 pixels.
7. Medir LCP da home com a chave desligada e ligada.
8. Revisar os 30 criativos e o manifesto.

## Etapa 12 — Publicação segura

1. Commitar a implementação com `enabled: false`.
2. Abrir PR e aguardar todos os checks.
3. Fazer merge e confirmar deploys.
4. Validar produção com a promoção ainda desligada.
5. Somente depois da aprovação comercial dos 30 criativos, ligar a chave no painel.
6. Monitorar pedidos, margem, itens por pedido, erros e conversão na primeira hora e no primeiro dia.
