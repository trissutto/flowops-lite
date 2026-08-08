# Plano de implementação — ficha pública de imóveis

## Bloco 1 — contrato e persistência interna

1. Adicionar ao Prisma os modelos de perfil comercial, mídias, publicação e fila.
2. Implementar um contrato público puro, com lista permitida e checklist de publicação.
3. Implementar CRUD do perfil e das mídias, sempre marcando publicação existente como pendente.
4. Implementar geração de identificador público, versão, hash e operações idempotentes.

## Bloco 2 — publicação confiável

1. Criar endpoints autenticados para prévia, publicar, atualizar, despublicar, trocar link e repetir falha.
2. Criar worker periódico com trava de sobreposição, claim condicional e backoff.
3. Assinar cada envio com HMAC, timestamp, nonce e chave de idempotência.
4. Manter a versão anterior quando atualização falhar e registrar toda operação no histórico do imóvel.

## Bloco 3 — interface interna

1. Adicionar a aba Ficha para Corretores no painel individual.
2. Organizar o formulário por identificação, áreas, características, valores, divulgação e dados internos.
3. Criar gerenciador de mídias comerciais com upload múltiplo, capa, legenda, ordem e ativação.
4. Exibir checklist, prévia sanitizada, estados da publicação, link e ações de controle.

## Bloco 4 — portal isolado

1. Criar uma aplicação Next.js independente em `imoveis-publico/`.
2. Adicionar Prisma e schema próprios para snapshots, mídias, nonces e idempotência.
3. Implementar API privada assinada para sincronização e revogação atômicas.
4. Copiar somente mídias comerciais de origens permitidas para o bucket público privado.
5. Implementar ficha responsiva sem catálogo, sem cookies, sem indexação e sem acesso ao FlowOps.
6. Servir fotos por rota que valida publicação ativa a cada acesso.
7. Implementar PDF A4, ZIP de fotos e resumo para WhatsApp a partir do mesmo snapshot.

## Bloco 5 — verificação e entrega

1. Testar allowlist, denylist, checklist, assinatura, idempotência e revogação.
2. Gerar os clientes Prisma e compilar backend, frontend e portal.
3. Revisar o diff para vazamento de credenciais, URLs internas ou dados privados.
4. Documentar variáveis, ordem de implantação e teste do primeiro imóvel piloto.
5. Commitar, enviar a branch e entregar o link da PR.
