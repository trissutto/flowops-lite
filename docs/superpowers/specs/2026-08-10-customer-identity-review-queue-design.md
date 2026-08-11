# Fila de revisão de identidade de clientes

## Objetivo

Permitir que a matriz revise possíveis cadastros da mesma pessoa sugeridos por telefone ou Instagram, sem unir automaticamente pessoas diferentes e sem alterar crediários, marcados, vendas, pedidos ou identificadores operacionais.

## Escopo

A primeira versão cobre candidatos entre `Customer` sem `personId`, agrupados por:

- telefone normalizado com pelo menos dez dígitos;
- username do Instagram normalizado.

E-mail não entra inicialmente porque a auditoria pós-migração não encontrou grupos duplicados. Nome não será usado como identificador porque produz falsos positivos demais.

## Modelo de segurança

- Telefone e Instagram apenas geram sugestões; nunca criam vínculo automaticamente.
- Apenas administradores da matriz podem decidir.
- Confirmar mantém todos os registros `Customer` e apenas associa seus `personId`.
- Se nenhum candidato tiver `Person`, a confirmação cria uma pessoa provisória sem CPF.
- Se exatamente um candidato já tiver `Person`, ele será o destino.
- Se candidatos apontarem para duas pessoas diferentes, a confirmação será bloqueada e exigirá um fluxo futuro específico de fusão.
- Crediário, baixa, marcado e Giga nunca serão religados por telefone ou Instagram.
- Toda decisão é transacional, auditada e reversível.

## Persistência

Criar `PersonReviewDecision` com:

- identificador e tipo da sugestão;
- valor normalizado armazenado como hash para evitar exposição desnecessária;
- IDs dos Customers participantes no momento da decisão;
- decisão `confirmed` ou `rejected`;
- pessoa de destino, quando confirmada;
- operador, justificativa e timestamps;
- estado anterior dos vínculos para rollback.

Uma restrição única por tipo, hash e conjunto de participantes impede decisões duplicadas. Rejeições deixam de aparecer enquanto o conjunto de participantes não mudar.

## API

- `GET /customers-crm/identity-review`: lista paginada, filtros por tipo, loja e status.
- `GET /customers-crm/identity-review/:key`: comparação detalhada dos candidatos.
- `POST /customers-crm/identity-review/:key/confirm`: confirma a mesma pessoa em transação.
- `POST /customers-crm/identity-review/:key/reject`: rejeita a sugestão com justificativa.
- `POST /customers-crm/identity-review/decisions/:id/rollback`: restaura os `personId` anteriores.

Todos os endpoints exigem autenticação e perfil administrativo da matriz. A API nunca retorna CPF completo; usa máscara e sinalizadores de validade.

## Interface

A tela da retaguarda apresenta:

- contadores de pendentes por telefone e Instagram;
- lista ordenada por força da evidência e quantidade de cadastros;
- cartões lado a lado com nome, CPF mascarado, telefone mascarado, e-mail, Instagram, origem, loja, primeiro cadastro, quantidade de compras e LTV;
- alertas visíveis quando houver crediário ou marcado, sem permitir que esses dados sejam movidos;
- ações `Confirmar mesma pessoa`, `Não são a mesma pessoa` e `Revisar depois`;
- justificativa obrigatória para confirmar ou rejeitar;
- histórico de decisões e rollback administrativo.

## Fluxo de confirmação

1. A API recalcula o grupo dentro da transação para impedir decisão sobre dados antigos.
2. Valida o operador e bloqueia conflito entre Persons diferentes.
3. Escolhe ou cria a `Person` de destino.
4. Atualiza somente `customers.person_id` dos participantes ainda compatíveis.
5. Registra `PersonLinkAudit` com regra `manual_identity_review`.
6. Registra a decisão e o estado anterior.
7. Retorna a ficha consolidada atualizada.

## Erros e concorrência

- Grupo alterado após abrir a tela: retorna conflito e pede recarregamento.
- Duas decisões simultâneas: a restrição única permite apenas uma.
- Persons diferentes no mesmo grupo: bloqueio sem mutação.
- Falha parcial: rollback automático da transação.
- Rollback posterior: somente vínculos criados pela decisão são restaurados; dados comerciais permanecem intactos.

## Testes e aceitação

- Normalização de telefone e Instagram.
- Sugestões não criam vínculos por conta própria.
- Escopo administrativo obrigatório.
- Confirmação com Person existente e com Person provisória.
- Bloqueio de conflito entre duas Persons.
- Rejeição deixa de reaparecer.
- Mudança no grupo invalida decisão antiga.
- Rollback restaura exatamente os vínculos anteriores.
- Quantidades e valores de parcelas, baixas, marcados, pedidos e vendas permanecem idênticos antes e depois.
- Build e testes de backend e frontend passam.

## Fora do escopo

- União automática por telefone, Instagram, e-mail ou nome.
- Exclusão ou fusão física de Customers.
- Transferência de crediário, marcado, cashback ou compras entre cadastros.
- Correção automática dos 17.634 registros sem identificação segura.
