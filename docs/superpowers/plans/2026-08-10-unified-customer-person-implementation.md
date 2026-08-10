# Implementação — Cliente Única Multicanal

## Onda 1: fundação segura

- Adicionar `Person`, `PersonIdentifier`, `PersonLinkAudit` e `PersonMergeAudit` ao Prisma.
- Adicionar `personId` opcional aos domínios críticos sem mudar leituras existentes.
- Usar FKs restritivas e índices; nenhum cascade financeiro.
- Criar baseline financeiro read-only e rollback somente dos vínculos novos.
- Testar schema, normalização e idempotência.

## Onda 2: backfill sombra

- Criar pessoas por CPF válido normalizado em lotes.
- Vincular `Customer` e `GigaCliente` sem alterar chaves antigas.
- Vincular crediário e marcados exclusivamente por loja+código.
- Registrar cada decisão e rejeição; diferença financeira aceitável é zero.

## Onda 3: escrita dupla

- Serviço isolado de resolução de identidade.
- Loja, site e live gravam `personId` quando houver identidade forte.
- Falha de identidade nunca bloqueia venda; entra em reconciliação.

## Onda 4: leitura única

- API e ficha CRM por `Person`.
- Histórico consolidado com filtros de loja/canal.
- Comparação sombra com consultas atuais antes de liberar para lojas.

## Validação e implantação

- Unitários: normalização, confiança e recusa de match fraco.
- Integração: idempotência, FKs restritivas e backfill repetido.
- Financeiro: contagens e somas antes/depois por loja.
- Deploy gradual sob flags; snapshot e dry-run obrigatórios.
- Produção não recebe backfill automático no deploy.
