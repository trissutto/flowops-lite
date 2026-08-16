# Relatório de jornada de compra

## Objetivo

Transformar o bloco atual de diagnóstico da tela `/retaguarda/cliques-lojas` em um relatório que responda, sem dupla contagem, quantas sessões avançaram, abandonaram ou enfrentaram problemas em cada etapa da compra.

O relatório continuará anônimo e usará `session_id` como unidade de contagem. Cliques repetidos e escolhas de variantes não serão apresentados como pessoas adicionais nem como abandono.

## Escopo

O trabalho altera o endpoint `GET /site-metrics/funil` e o componente `FunilSite` da página existente. Não altera a coleta dos eventos, o checkout, os gateways de pagamento nem o relatório de cliques nas lojas físicas.

## Definição da jornada

As etapas ordenadas são:

1. `page_view` — visita;
2. `view_item` — visualização de produto;
3. `add_to_cart` — adição à sacola;
4. `begin_checkout` — início do checkout;
5. `add_payment_info` — escolha ou envio da forma de pagamento;
6. `purchase` — compra confirmada.

Para cada sessão, o backend identifica a etapa mais avançada alcançada no período. A sessão entra uma única vez na contagem de parada. Eventos repetidos não aumentam o número de pessoas.

Uma sessão que alcançou uma etapa posterior é considerada como tendo atravessado todas as etapas anteriores, mesmo que algum evento intermediário não tenha sido recebido. Essa regra evita funis invertidos por perda pontual de telemetria.

## Métricas por transição

Para cada etapa, o endpoint retornará:

- `chegaram`: sessões cuja etapa máxima é igual ou posterior à etapa atual;
- `avancaram`: sessões cuja etapa máxima é posterior à etapa atual;
- `abandonaram`: `chegaram - avancaram`;
- `taxaAvanco`: `avancaram / chegaram`;
- `taxaPerda`: `abandonaram / chegaram`.

Na etapa final, `avancaram` não se aplica e `abandonaram` será zero. A compra confirmada permanece o desfecho final.

O relatório destacará a maior taxa de perda entre transições com base válida. Quando houver menos de 20 sessões na etapa, o destaque será rotulado como “amostra pequena”, evitando conclusões fortes.

## Problemas confirmados

Uma seção separada mostrará somente ocorrências com potencial real de impedir a compra:

- `add_to_cart_blocked`;
- `checkout_validation_error`;
- `checkout_error`;
- `card_declined`;
- `pix_expired`;
- `payment_retry` quando houver repetição;
- alertas de checkout já calculados pelo backend.

Cada problema mostrará pessoas únicas, ocorrências e quantas sessões se recuperaram. Uma sessão é recuperada quando, depois do problema, alcança uma etapa posterior ou registra `checkout_recovered`/`purchase`. Sessões recuperadas continuam visíveis para diagnóstico, mas não entram como abandono definitivo.

`pix_created` não é erro. Ele será usado para distinguir:

- Pix criado e compra confirmada: fluxo concluído;
- Pix criado sem `purchase` até o fim do período: pendência de pagamento, exibida separadamente de erro técnico.

Como um Pix pode ser pago depois do fim do recorte, a interface chamará o número de “pendente no período”, não de perda definitiva.

## Interações de escolha

Eventos de comparação normal serão removidos da tabela de problemas e agrupados em uma seção secundária, inicialmente recolhida:

- `color_switch`;
- `size_switch`;
- `add_shipping_info`;
- `payment_method_selected`;
- `pix_copied`.

A seção se chamará “O que as clientes compararam” e mostrará pessoas únicas e interações. O texto explicará que uma pessoa pode aparecer em mais de uma opção e, portanto, as linhas não devem ser somadas.

## Contrato da API

O endpoint manterá `etapas`, `faturamento` e `alertasCheckout` para compatibilidade e adicionará:

- `jornada`: resumo das transições e da etapa final de cada sessão;
- `problemas`: falhas agregadas com pessoas, ocorrências e recuperadas;
- `interacoes`: escolhas agregadas, sem linguagem de falha;
- `resumo`: maior perda, total de sessões com problema e total recuperado.

O campo legado `diagnosticos` poderá continuar na resposta durante a transição, mas deixará de ser renderizado pela nova interface.

## Interface

O topo do funil atual será preservado para reconhecimento rápido. Abaixo dele haverá:

1. um card “Maior perda da jornada”, com etapa, quantidade e percentual;
2. uma tabela “Onde a compra parou”, com `Chegaram`, `Avançaram`, `Abandonaram` e `% de perda`;
3. uma seção “Problemas confirmados”, priorizada por pessoas não recuperadas;
4. uma linha específica para “Pix pendente no período”, quando aplicável;
5. a seção recolhível “O que as clientes compararam”.

Verde será reservado para avanço, recuperação e dinheiro. Âmbar indicará atenção ou amostra pequena. Vermelho será usado apenas para falha confirmada ou perda relevante, nunca para escolhas de cor, tamanho ou frete.

## Estados e casos limites

- Sem sessões: mostrar estado vazio, sem percentuais artificiais.
- Etapa com zero pessoas: taxa indisponível, exibida como travessão.
- Eventos sem `session_id`: não entram na jornada, pois não podem ser deduplicados.
- Eventos fora de ordem: vale a maior etapa alcançada.
- Falha seguida de avanço: problema recuperado.
- Múltiplas falhas iguais na mesma sessão: uma pessoa e várias ocorrências.
- Sessão com várias cores ou tamanhos: uma pessoa por opção, acompanhada do aviso de que opções não são somáveis.
- Pix criado no fim do período: pendência, não erro definitivo.

## Testes e validação

O backend terá testes para:

- deduplicação de eventos repetidos da mesma sessão;
- reconstrução da jornada com evento intermediário ausente;
- parada exclusiva na etapa mais avançada;
- falha recuperada e falha não recuperada;
- Pix criado com e sem compra posterior;
- exclusão de eventos sem `session_id` das métricas de pessoas.

O frontend será validado com dados vazios, amostra pequena, funil completo, perda concentrada e múltiplos problemas. Também serão executados os testes e o build dos pacotes afetados.

## Fora de escopo

- identificação pessoal da visitante;
- replay individual de sessão;
- alteração das faixas de mercado da análise de conversão;
- mudança na instrumentação ou nos gateways;
- atribuição de marketing por campanha ou canal.
