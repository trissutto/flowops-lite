# NFC-e: sequencia atomica e historico de tentativas

## Contexto

Na loja 10 (Jundiai), serie 4, a auditoria de producao encontrou 22 lacunas entre os numeros 113 e 176. O emissor atual incrementa `NfceConfig.numeroAtual` antes de cada tentativa. Uma venda rejeitada recebe outro numero quando e reenviada, sobrescrevendo na propria venda o numero anterior. O teste de NFC-e tambem consome a sequencia configurada. Alem disso, o incremento atual e uma leitura seguida de escrita, sem atomicidade.

Esta mudanca impede novas lacunas causadas pelo Flow. Ela nao altera, reaproveita nem inutiliza retroativamente numeros antigos; a regularizacao das lacunas existentes continua sendo uma decisao fiscal junto ao contador/SEFAZ.

## Objetivos

- Reservar cada numero de NFC-e de forma atomica por loja.
- Manter o numero reservado durante correcoes e reenvios da mesma venda.
- Preservar todas as tentativas e respostas da SEFAZ para auditoria.
- Impedir testes de emissao no ambiente de producao.
- Manter idempotencia para nota ja autorizada e para cliques concorrentes.

## Fora de escopo

- Inutilizar automaticamente as lacunas antigas de Jundiai.
- Alterar a numeracao de documentos ja autorizados, rejeitados ou cancelados.
- Migrar NF-e modelo 55 para o mesmo mecanismo.
- Mudar regras fiscais, calculos de imposto ou montagem dos itens da NFC-e.

## Modelo de dados

Sera criada a tabela `nfce_attempts`, append-only para fins operacionais, com:

- `id` e timestamps;
- `saleId`, `storeCode`, `serie` e `numero`;
- `chave` da tentativa;
- `status`: `building`, `signed`, `authorized`, `rejected` ou `error`;
- `cStat`, `motivo`, protocolo e data de recebimento;
- XML enviado, XML de resposta e XML autorizado quando disponiveis;
- indice por venda/data e por loja/serie/numero;
- chave unica para a tentativa autorizada, preservando a unicidade da chave fiscal.

`PdvSale` continua sendo o resumo do documento atual para compatibilidade com telas e relatorios. `nfce_attempts` passa a ser o historico detalhado e nao deve ser atualizado para esconder tentativas anteriores.

## Reserva atomica

`nextNumero` sera substituido por uma operacao atomica no Postgres, usando `UPDATE ... SET numero_atual = numero_atual + 1 RETURNING numero_atual` dentro da transacao de reserva.

A primeira emissao de uma venda, dentro da mesma transacao:

1. trava a venda;
2. verifica novamente se ela ja esta autorizada;
3. reutiliza `nfceNumber`/`nfceSerie` se ja existirem;
4. caso contrario, incrementa atomicamente a configuracao;
5. grava numero e serie na venda antes de qualquer chamada externa;
6. cria a tentativa em estado `building`.

Assim, uma falha do processo depois da reserva nao libera nem perde a associacao entre venda e numero.

## Reemissao e idempotencia

- Venda autorizada retorna imediatamente o documento salvo.
- Venda rejeitada, pendente ou com erro reutiliza o mesmo `nfceNumber` e `nfceSerie`.
- O XML e a chave podem ser reconstruidos para corrigir dados ou mudar o mes de emissao, mas o `nNF` permanece o mesmo.
- Cada envio cria uma nova linha em `nfce_attempts`.
- Duas requisicoes simultaneas da mesma venda convergem para a mesma reserva; somente uma pode transmitir por vez.
- Se a SEFAZ responder que a nota ja foi processada, o fluxo deve consultar/normalizar a resposta em vez de reservar outro numero.

## Teste de configuracao

- `testEmit` retorna erro explicito quando `ambiente = '1'`.
- Em homologacao, o teste nao altera `NfceConfig.numeroAtual`.
- O documento de teste usa uma numeracao isolada de homologacao, sem interferencia na sequencia produtiva.
- A interface deve explicar que o teste so esta disponivel em homologacao.

## Erros e observabilidade

- Erros de montagem, assinatura, transporte e rejeicao SEFAZ atualizam a tentativa correspondente sem apagar tentativas anteriores.
- A venda mantem o ultimo status/motivo para compatibilidade.
- Logs incluem venda, loja, serie, numero, tentativa e `cStat`, sem registrar certificado ou senha.
- O relatorio fiscal podera, em evolucao posterior, usar `nfce_attempts` para explicar lacunas; esta entrega garante primeiro a captura dos novos eventos.

## Compatibilidade e implantacao

- A nova tabela e campos sao aditivos e aplicados pelo `prisma db push` no deploy do Railway.
- Vendas existentes com `nfceNumber` continuam reutilizando o numero armazenado.
- Vendas existentes sem numero seguem a nova reserva atomica.
- Nenhum backfill inventara historico para as tentativas antigas.
- O backend reinicia no deploy; a publicacao deve ocorrer fora do horario de loja aberta, conforme a regra operacional do projeto.

## Testes de aceitacao

1. Duas vendas concorrentes da mesma loja recebem numeros distintos.
2. Dois cliques concorrentes na mesma venda usam um unico numero.
3. Rejeicao seguida de correcao e autorizacao conserva serie e numero.
4. Falha de assinatura conserva a reserva para o proximo envio.
5. Venda autorizada nunca e retransmitida.
6. Teste em producao e bloqueado antes de reservar numero.
7. Teste em homologacao nao altera `numeroAtual`.
8. Toda tentativa fica consultavel no banco com status e motivo.
9. Build e testes existentes do backend continuam passando.

## Criterio de sucesso

Depois da implantacao, nenhuma nova lacuna deve ser criada por teste, retry ou concorrencia do Flow. Toda tentativa deve ser rastreavel e uma venda deve conservar seu `nNF` desde a primeira reserva ate a autorizacao ou decisao fiscal posterior.
