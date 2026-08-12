# Revisão conservadora de identidade de clientes

## Objetivo

Classificar os 4.053 cadastros sem CPF válido e apresentar possíveis correspondências para decisão humana, preservando cada cadastro de loja, site ou live e sem alterar compras ou valores financeiros durante a revisão.

## Decisão aprovada

- CPF válido e idêntico continua sendo a única regra de vínculo automático.
- Telefone, e-mail e Instagram geram apenas sugestões.
- Nome, data de nascimento, origem e histórico servem somente como evidências visuais.
- CPF divergente ou mais de uma `Person` no grupo bloqueiam a confirmação.
- Contas internas, incluindo `DEFEITOS`, `RESERVA`, `FURTO` e `PERDA`, não participam da fila.
- Nenhum pedido, venda, parcela, baixa ou marcado é movido ao gerar ou confirmar uma sugestão.

## Escopo

### Incluído

1. Normalização conservadora de telefone, e-mail e Instagram.
2. Agrupamento de cadastros ativos que compartilham exatamente um desses identificadores.
3. Fila administrativa com evidências lado a lado, filtros e prioridades.
4. Confirmação ou rejeição humana com motivo obrigatório.
5. Registro imutável da decisão e do estado anterior.
6. Desfazer uma confirmação sem sobrescrever alterações posteriores.
7. Testes de classificação, bloqueio de conflitos e invariância financeira.
8. Nova auditoria após decisões para medir cobertura e vínculos operacionais possíveis.

### Não incluído

- Correspondência por nome aproximado.
- Vínculo automático por telefone, e-mail ou Instagram.
- Fusão ou exclusão de registros `Customer`.
- Transferência imediata de históricos operacionais.
- Alteração de totais, status ou titularidade de crediário e marcados.

## Regras de normalização

### Telefone

- Remover caracteres não numéricos.
- Remover o prefixo internacional `55` somente quando o resultado tiver 10 ou 11 dígitos.
- Aceitar apenas 10 ou 11 dígitos.
- Valores inválidos não geram sugestões.

### E-mail

- Remover espaços nas extremidades e converter para minúsculas.
- Exigir formato estrutural válido com uma única parte local e domínio.
- Não aplicar regras específicas de provedor, como remover pontos ou `+alias`.
- E-mails operacionais, genéricos ou pertencentes às contas internas ficam fora da fila.

### Instagram

- Remover `@` inicial, espaços e converter para minúsculas.
- Não usar nome de exibição; somente o identificador informado no cadastro.
- Valores vazios ou estruturalmente inválidos não geram sugestões.

## Formação e classificação dos grupos

Um grupo existe quando pelo menos dois `Customer` ativos compartilham o mesmo identificador normalizado e pelo menos um deles ainda não tem `personId`.

Prioridades:

- `conflito`: CPFs válidos distintos ou mais de uma `Person` existente. Confirmação bloqueada.
- `alta confiança`: identificador exato acompanhado por evidências coerentes, como nome igual, e-mail igual, vínculo parcial ou combinação site/live.
- `revisar`: identificador exato, mas evidência adicional insuficiente.

A pontuação apenas ordena a fila. Ela nunca autoriza vínculo automático.

## Fluxo da decisão

1. O administrador abre `/retaguarda/revisao-identidade`.
2. O sistema mostra os cadastros, lojas/canais, datas de cadastro, contatos mascarados e resumo do histórico.
3. O administrador escolhe `Confirmar vínculo` ou `Não é a mesma pessoa` e informa o motivo.
4. Na confirmação, o backend reavalia o grupo dentro de transação serializável.
5. Havendo conflito novo, a transação é cancelada.
6. Sem conflito, somente `Customer.personId` dos participantes ainda não vinculados é atualizado.
7. A decisão, o operador, o motivo, os participantes e o estado anterior são registrados.
8. A etapa posterior de vínculo operacional roda separadamente, com as travas financeiras já existentes.

## Escolha da pessoa de destino

- Se exatamente uma `Person` já aparece no grupo, ela é o destino.
- Se nenhuma existe, cria-se uma `Person` provisória a partir do cadastro mais antigo.
- Se mais de uma existe, a confirmação é bloqueada.
- O cadastro mais antigo é preservado como referência inicial; os demais continuam existindo como cadastros por canal/loja.

## Segurança e auditoria

- Endpoints disponíveis somente para administradores autorizados.
- Identificadores sensíveis aparecem mascarados na listagem.
- A chave da sugestão inclui tipo, valor em hash e conjunto dos participantes, evitando decisão sobre grupo alterado.
- Confirmação e rejeição exigem motivo.
- Desfazer restaura apenas vínculos que ainda apontam para o destino criado pela decisão.
- A geração da fila é somente leitura.
- A confirmação não toca tabelas financeiras ou operacionais.

## Testes e critérios de aceite

1. Telefone, e-mail e Instagram normalizam somente os formatos autorizados.
2. Conta interna nunca aparece como cliente sugerido.
3. CPF divergente ou múltiplas `Person` produzem conflito bloqueante.
4. Nenhuma sugestão é confirmada automaticamente.
5. Confirmação altera apenas `Customer.personId` e tabelas de auditoria.
6. Rejeição não altera nenhum vínculo.
7. Rollback não desfaz mudanças realizadas posteriormente por outro processo.
8. Antes e depois de qualquer lote operacional permanecem idênticos:
   - quantidade e valor de parcelas;
   - quantidade e valor de baixas;
   - quantidade e valor de marcados;
   - quantidade e valor de vendas finalizadas.
9. A auditoria final informa pendências, conflitos, decisões e cobertura por canal.

## Implantação

1. Completar a fila existente com e-mail e exclusão explícita das contas internas.
2. Validar testes unitários e build do backend e frontend.
3. Publicar em branch e PR.
4. Revisar inicialmente uma amostra pequena na interface.
5. Após as decisões humanas, executar o vínculo operacional determinístico com portão financeiro por tabela.

