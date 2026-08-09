# PDV — resumo operacional da loja

## Objetivo

Adicionar ao PDV um resumo oculto por padrão, aberto por um botão, com dois indicadores em quantidade de peças e um ranking financeiro diário:

1. peças vendidas líquidas hoje;
2. peças disponíveis agora no estoque da loja;
3. vendas líquidas de hoje por vendedora.

O resumo não exibirá o total do mês.

## Interface

- Adicionar o botão **Resumo da Loja** no cabeçalho do PDV desktop, junto aos controles operacionais.
- O botão abre uma janela compacta sobre a tela atual.
- A janela contém dois cartões grandes:
  - **Vendido hoje (líquido)**;
  - **Estoque atual da loja**.
- Abaixo dos cartões, exibir **Ranking de vendas líquidas por vendedora**, do maior para o menor.
- Destacar as três primeiras posições com ouro, prata e bronze.
- Em cada linha do ranking, mostrar:
  - nome da vendedora;
  - valor bruto das vendas atuais;
  - valor de devolução/vale-troca aplicado nessas vendas;
  - valor líquido que efetivamente entra no ranking.
- Exibir a hora da última atualização e um botão para atualizar manualmente.
- Carregar os números uma única vez ao abrir a janela.
- Não usar intervalo, polling, atualização ao focar a janela ou qualquer atualização automática.
- Uma nova consulta só acontece quando o usuário abre o resumo ou clica no botão de atualização manual.
- Fechar a janela volta a ocultar os números.
- O visual respeita o modo claro ou noturno ativo no computador.

## Regras dos indicadores

### Vendido hoje (líquido)

Calcular em peças, nunca em reais:

`quantidade dos itens de vendas finalizadas hoje - quantidade dos itens devolvidos hoje`

Regras:

- usar o fuso `America/Sao_Paulo` para definir o início e o fim do dia;
- considerar somente a loja do PDV aberto;
- incluir somente vendas com status `finalized`;
- excluir vendas e devoluções de treinamento;
- excluir vendas canceladas ou abertas;
- subtrair toda devolução registrada hoje na mesma loja, mesmo quando a venda original ocorreu em outro dia;
- não limitar o resultado a zero: um dia com mais devoluções que vendas pode apresentar número negativo.

### Estoque atual da loja

- Ler exclusivamente do Postgres/Flow, sem consulta ao Giga ao vivo.
- Usar `wincred_estoque`, fonte operacional atual do estoque.
- Normalizar o código da loja para dois dígitos.
- Somar somente quantidades positivas da loja; saldos negativos não reduzem o estoque disponível exibido.
- A resposta representa o estoque no momento da consulta.

### Ranking de vendas líquidas por vendedora

O ranking representa o dinheiro novo gerado pelas vendas finalizadas hoje. A devolução não será atribuída à vendedora da venda antiga. Ela reduz a venda atual feita no PDV, exatamente como ocorre na operação da loja.

Para cada venda atual:

`valor líquido = valor bruto da venda atual - vale-troca/devolução aplicado como pagamento`

Exemplo aprovado:

- peças da venda atual: R$ 1.000,00;
- vale-troca/devolução aplicado: R$ 900,00;
- valor líquido da vendedora no ranking: R$ 100,00.

Regras:

- usar o fuso `America/Sao_Paulo` para definir o início e o fim do dia;
- considerar somente vendas da loja do PDV aberto;
- incluir somente vendas com status `finalized`;
- excluir vendas de treinamento, abertas e canceladas;
- excluir registros de marcado que ainda não viraram venda finalizada;
- atribuir o resultado à vendedora da venda atual (`sellerName`, com fallback para `vendedorName`);
- somar pagamentos `vale_troca` da própria venda atual como valor de devolução aplicado;
- não consultar a venda antiga e não descontar da vendedora antiga;
- não subtrair novamente `PdvReturn.valorTotal`, evitando desconto em duplicidade;
- excluir a linha de frete do valor bruto, pois frete não é venda de mercadoria nem comissão da vendedora;
- nunca produzir valor líquido negativo para uma venda: eventual crédito residual continua sendo crédito e a venda atual contribui com zero;
- agrupar as vendas da mesma vendedora e ordenar pelo valor líquido decrescente;
- vendas sem vendedora identificada aparecem em **Sem vendedora**.

## Backend

Criar um serviço isolado no módulo `pdv` para calcular os dois indicadores e um endpoint autenticado:

`GET /pdv/store-summary?storeCode=01`

Resposta:

```json
{
  "storeCode": "01",
  "soldTodayQty": 37,
  "returnedTodayQty": 2,
  "netSoldTodayQty": 35,
  "stockQty": 1842,
  "sellerRanking": [
    {
      "sellerName": "Maria",
      "grossSalesValue": 1000,
      "returnsAppliedValue": 900,
      "netSalesValue": 100
    }
  ],
  "updatedAt": "2026-08-08T18:00:00.000Z"
}
```

Segurança:

- usuário de loja só pode consultar a própria loja;
- no modo master, os papéis administrativos autorizados consultam apenas a loja atualmente aberta no PDV;
- o frontend não calcula nem combina totais: apenas exibe a resposta do backend.

## Estados e falhas

- Durante a consulta, mostrar carregamento nos cartões e no ranking.
- Se a consulta falhar, mostrar **Não foi possível atualizar** e o botão **Tentar novamente**.
- Uma falha na consulta não fecha a janela nem bloqueia o PDV.
- Nunca substituir uma falha por zero, pois zero seria interpretado como dado real.

## Validação

- Testar vendas finalizadas, abertas, canceladas e de treinamento.
- Testar devoluções do dia e devoluções de vendas antigas.
- Testar virada de dia no fuso de São Paulo.
- Testar estoque positivo, zero e linhas negativas.
- Testar venda de R$ 1.000,00 com R$ 900,00 de vale-troca aplicado, resultando em R$ 100,00 para a vendedora atual.
- Testar venda sem vale-troca, venda com pagamentos mistos e crédito residual.
- Confirmar que a devolução não é descontada da vendedora da venda antiga e não é subtraída duas vezes.
- Testar agrupamento por vendedora, fallback de nome, posição do ranking e **Sem vendedora**.
- Confirmar que frete, treinamento, vendas abertas, canceladas e marcados não entram no ranking.
- Testar isolamento entre lojas e bloqueio de acesso indevido.
- Validar build, tipos e lint do frontend e do backend.
- Confirmar que abrir e manter o resumo aberto não dispara novas consultas automaticamente.
- Confirmar que abrir, atualizar manualmente e fechar o resumo não altera a venda em andamento.

## Fora do escopo

- indicadores mensais;
- detalhamento por produto ou forma de pagamento;
- consulta direta ao Giga;
- números permanentemente expostos na tela.
