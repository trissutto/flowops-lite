# Clientes Beta consolidados e exclusão segura de duplicidades

## Objetivo

Fazer a lista `/beta/clientes` representar pessoas, e não registros isolados de `Customer`, para que nome, quantidade de compras e total gasto sejam idênticos aos apresentados na ficha consolidada. Permitir que administradores removam cadastros duplicados sem apagar a pessoa principal nem comprometer vendas, cashback ou auditoria.

## Lista consolidada

- Uma linha principal por identidade (`personId`; fallback controlado para `personKey` ou `id`).
- Nome canônico calculado pela mesma regra usada em `betaDetail`.
- Compras, LTV, cashback, canais e lojas agregados entre os registros vinculados.
- Busca por nome, CPF, WhatsApp e e-mail deve encontrar a pessoa quando qualquer registro vinculado corresponder.
- Filtro de loja deve considerar `originStoreId` ou `targetStoreId` em qualquer registro vinculado.
- Paginação e total devem contar pessoas consolidadas, não linhas de origem.
- O identificador usado para abrir a ficha deve ser um registro ativo e autorizado pertencente à pessoa.

## Visualização das origens

- A linha principal poderá ser expandida.
- A expansão mostrará cada cadastro vinculado: nome gravado, CPF, canal, loja de origem/relacionamento, pedidos, valor e última atualização.
- Diferenças de grafia ficarão visíveis para explicar a consolidação.
- A ação destrutiva aparecerá somente nas linhas de origem, nunca na linha principal consolidada.

## Exclusão de duplicidade

- Disponível somente para `admin`.
- O botão se chamará `Excluir duplicidade`.
- A confirmação mostrará nome, loja, canal, pedidos e valor do registro selecionado.
- O backend decidirá o modo seguro:
  - registro sem compras, cashback, endereços relevantes ou dependências: exclusão física;
  - registro com histórico ou dependências: desativação (`active=false`) e retirada da consolidação ativa.
- Nunca excluir todos os registros de uma pessoa pela ação de duplicidade.
- Se restar apenas um registro ativo, a ação ficará indisponível.
- A exclusão/desativação deve registrar auditoria com ator, registro afetado, identidade, modo aplicado e data.
- Após sucesso, a lista e a ficha serão recarregadas e seus totais deverão coincidir.

## API e arquitetura

- Extrair a regra de consolidação hoje embutida em `betaDetail` para um serviço reutilizável.
- Criar endpoint de listagem consolidada específico do Beta, preservando `/customers-crm` atual.
- Criar endpoint administrativo para remover uma duplicidade individual.
- Executar decisão e mutação em transação.
- Retornar erro de conflito quando o registro não for duplicidade, for o último ativo ou mudar desde a confirmação.
- Páginas atuais e endpoints legados permanecem inalterados.

## Estados e erros na interface

- Estado de carregamento na expansão e na exclusão.
- Confirmação exige clique explícito; clicar na linha não dispara exclusão.
- Mensagem de sucesso informa se o registro foi excluído ou apenas desativado para preservar histórico.
- Em falha, nenhuma linha desaparece até o backend confirmar a transação.

## Validação

- Mesma pessoa apresenta nome, compras e LTV idênticos na lista e na ficha.
- Busca por Thiago retorna uma linha consolidada e exibe as origens Itanhaém/Indaiatuba na expansão.
- Usuário não administrador não recebe botão e recebe `403` ao chamar o endpoint.
- Último registro ativo não pode ser removido.
- Registro com vendas é desativado sem apagar vendas.
- Registro vazio pode ser excluído definitivamente.
- Escopo de loja continua usando origem ou relacionamento em lista e ficha.
- TypeScript e build de frontend/backend passam.

