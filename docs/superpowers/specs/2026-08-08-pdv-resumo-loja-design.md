# PDV — resumo operacional da loja

## Objetivo

Adicionar ao PDV um resumo oculto por padrão, aberto por um botão, com exatamente dois indicadores em quantidade de peças:

1. peças vendidas líquidas hoje;
2. peças disponíveis agora no estoque da loja.

O resumo não exibirá valores financeiros nem o total do mês.

## Interface

- Adicionar o botão **Resumo da Loja** no cabeçalho do PDV desktop, junto aos controles operacionais.
- O botão abre uma janela compacta sobre a tela atual.
- A janela contém dois cartões grandes:
  - **Vendido hoje (líquido)**;
  - **Estoque atual da loja**.
- Exibir a hora da última atualização e um botão para atualizar manualmente.
- Carregar os números ao abrir e atualizar automaticamente a cada 15 segundos somente enquanto a janela estiver aberta.
- Fechar a janela interrompe a atualização automática e volta a ocultar os números.
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
  "updatedAt": "2026-08-08T18:00:00.000Z"
}
```

Segurança:

- usuário de loja só pode consultar a própria loja;
- no modo master, os papéis administrativos autorizados consultam apenas a loja atualmente aberta no PDV;
- o frontend não calcula nem combina totais: apenas exibe a resposta do backend.

## Estados e falhas

- Durante a primeira consulta, mostrar carregamento nos dois cartões.
- Se a consulta falhar, mostrar **Não foi possível atualizar** e o botão **Tentar novamente**.
- Uma falha de atualização automática não fecha a janela nem bloqueia o PDV.
- Nunca substituir uma falha por zero, pois zero seria interpretado como dado real.

## Validação

- Testar vendas finalizadas, abertas, canceladas e de treinamento.
- Testar devoluções do dia e devoluções de vendas antigas.
- Testar virada de dia no fuso de São Paulo.
- Testar estoque positivo, zero e linhas negativas.
- Testar isolamento entre lojas e bloqueio de acesso indevido.
- Validar build, tipos e lint do frontend e do backend.
- Confirmar que abrir, atualizar e fechar o resumo não altera a venda em andamento.

## Fora do escopo

- valores financeiros;
- indicadores mensais;
- detalhamento por produto, vendedora ou forma de pagamento;
- consulta direta ao Giga;
- números permanentemente expostos na tela.
