# Cliente Única Multicanal — identidade e migração segura

## Decisão

O FlowOps terá uma entidade `Person` para representar a pessoa real. Os registros
`Customer` existentes continuarão representando cadastros operacionais por loja ou
canal. Nenhum cadastro, código Giga ou movimento financeiro será apagado ou
renumerado. A ficha única será construída por associação, não por fusão destrutiva.

```text
Person (pessoa única)
  ├─ Customer / GigaCliente da loja 01
  ├─ Customer / GigaCliente da loja 07
  ├─ Customer do site
  └─ Customer da live
```

Todas as transações manterão identificadores e snapshots originais e receberão um
`personId` adicional. Loja e canal permanecerão explícitos em cada movimento.

## Objetivos

- Uma linha por pessoa no CRM e histórico filtrável por loja/canal.
- Preservação integral de crediário, marcados, vendas, baixas e estornos.
- Associação determinística, auditável, idempotente e reversível.
- Novos fluxos resolvem a pessoa antes de criar outro cadastro.

## Fora de escopo

- Apagar ou mesclar fisicamente `Customer`.
- Alterar `loja + codCliente`, `registro`, `controle`, `registroGiga` ou `saleId`.
- Corrigir valores financeiros durante o backfill de identidade.
- Unir pessoas automaticamente apenas por nome, endereço ou telefone não verificado.

## Modelo de dados

### Person

```text
id UUID PK
cpfNormalized VARCHAR(11), unique quando presente
identityStatus confirmed | provisional | review | merged
name, socialName, email, phone, birthDate
primaryCustomerId UUID opcional
firstRegistrationAt, firstRegistrationSource, firstRegistrationStoreId
createdAt, updatedAt
```

CPF confirmado é único. Pessoa sem CPF é permitida como provisória e não pode ser
fundida automaticamente por identificador fraco.

### PersonIdentifier

Armazena `personId`, tipo, valor normalizado, verificação, fonte,
`sourceCustomerId`, datas e auditoria. Tipos: CPF, e-mail, telefone, WhatsApp,
Instagram ID/username e ManyChat ID. CPF válido e IDs oficiais verificados têm
unicidade forte; os demais geram candidatos, não fusões silenciosas.

### Auditoria

`PersonLinkAudit` registra entidade, ID, regra, confiança, execução automática/manual,
ator e data. `PersonMergeAudit` guarda origem, destino, motivo e estado anterior para
desfazer uma eventual fusão lógica.

## Vínculos aditivos

Adicionar `personId` inicialmente opcional e indexado a:

- `customers`, `giga_clientes` e `customer_accounts`;
- `orders`, `pdv_sales`, `live_pdv_carts` e `live_carts`;
- `crediario_parcelas`, `crediario_baixas` e `marcados`;
- devoluções, reservas, cashback, consentimentos e mensagens.

As FKs financeiras usam `onDelete: Restrict`. Nunca haverá cascade de `Person` para
movimentos financeiros ou históricos.

## Resolução de identidade

Ordem automática: CPF matematicamente válido; `igUserId` oficial verificado; e-mail
verificado; telefone verificado acompanhado de outro atributo compatível. Nome,
endereço, username digitado e telefone isolado nunca autorizam união automática.

O cadastro inicial usa a primeira data confiável nesta ordem: data original do Giga,
primeira compra, cadastro do site, cadastro da live e `createdAt` do FlowOps. Ele
define origem histórica, mas dados atuais vêm da fonte verificada mais recente.
Consentimento sempre segue a decisão mais recente, sem combinar opt-ins por soma.

## Crediário

O vínculo primário é `crediario_parcelas.loja + cod_cliente` para
`giga_clientes.loja + codigo`, seguido de `GigaCliente → Customer → Person`. CPF é
apenas validação adicional.

Permanecem imutáveis: `registro`, `controle`, `numero_compra`, `loja`, `cod_cliente`,
`sale_id`, `baixa_id`, valores, vencimentos, pagamentos, gateway e estornos. Parcelas
sem correspondência recebem identidade pendente; não são movidas ou associadas por
aproximação.

## Marcados

O vínculo usa `store_code + cod_cliente`, validado por CPF quando disponível.
`registro_giga`, `sale_id`, status, valores, origem e datas permanecem imutáveis.
Marcados sem correspondência continuam operacionais e entram em revisão.

## Vendas, site e live

- PDV resolve por cadastro da loja e CPF válido, mantendo o snapshot da venda.
- Site resolve por conta autenticada/CPF e depois e-mail verificado.
- Live resolve por CPF, `igUserId`, ManyChat ID ou telefone verificado.
- Transação sem identidade continua permitida com `personId = null`, para nunca
  bloquear uma venda, e entra na reconciliação.

## Migração

1. Gerar snapshot validado e relatório financeiro de referência.
2. Aplicar somente DDL aditivo.
3. Criar `Person` para CPF válido em lotes idempotentes.
4. Vincular Customers/GigaClientes sem alterar suas chaves.
5. Vincular crediário e marcados por loja+código.
6. Vincular vendas e pedidos por identificadores fortes.
7. Executar modo sombra e comparar consultas antigas/novas.
8. Ativar escrita dupla de `personId` por canal.
9. Liberar a ficha única gradualmente.

Cada lote salva cursor, contagens, rejeições e auditoria. Reexecução não duplica
pessoas, identificadores ou vínculos.

## Portões de segurança

Antes e depois de cada etapa, por loja e no total, devem permanecer idênticos:

- quantidade e soma de parcelas;
- total pago, saldo aberto, juros, multas, baixas e estornos;
- marcados por status, quantidade e valor;
- vendas, itens, pagamentos, devoluções e pedidos;
- vínculos `registro+controle`, `registroGiga`, `saleId` e `baixaId`.

Diferença financeira aceitável: zero. Divergência interrompe o lote e reverte apenas
os novos vínculos.

## Rollback

O rollback desativa leitura/escrita por `personId` e reverte exclusivamente entidades
e vínculos adicionados pelo lote. Dados operacionais e financeiros nunca participam
de rollback destrutivo. O snapshot é a última defesa, mas a reversão normal não exige
restauração completa.

## Implantação

1. Schema opcional, sem mudança funcional.
2. Backfill em modo sombra.
3. Leitura dupla para administradores e monitoramento de divergências.
4. Escrita dupla mantendo todas as chaves antigas.
5. Liberação progressiva para gerentes e lojas.
6. `Person` vira a raiz do CRM; cadastros operacionais permanecem disponíveis.

## Critérios de conclusão

- Zero diferença financeira e nenhuma perda de registros.
- Nenhum código Giga ou identificador histórico alterado.
- Loja, site e live gravam `personId` quando há identidade forte.
- Casos ambíguos permanecem separados e revisáveis.
- Ficha única mostra histórico completo e filtro por loja/canal.
- União/separação têm auditoria e teste de reversão.
- Backfills possuem testes de idempotência, integridade e desempenho.
