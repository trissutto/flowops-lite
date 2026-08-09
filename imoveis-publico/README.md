# Portal público de imóveis

Aplicação isolada que recebe apenas snapshots comerciais autorizados pelo FlowOps. Não compartilha banco, autenticação, cookies nem armazenamento com o sistema interno.

## Ambientes necessários

1. Um novo projeto Vercel apontando para a pasta `imoveis-publico/`.
2. Um novo projeto Railway, separado do `heroic-mercy`, contendo somente um Postgres para este portal.
3. Um bucket S3 privado separado, exclusivo das mídias já publicadas. Em produção usamos um Railway Bucket dentro do projeto público isolado.
4. O domínio `imoveis.lurds.com.br` apontado para o novo projeto Vercel.

## Variáveis do portal público

Copie os nomes de `.env.example` para o projeto Vercel:

- `DATABASE_URL`: conexão do novo Postgres público.
- `PUBLICATION_SYNC_SECRET`: segredo aleatório com no mínimo 32 bytes.
- `PUBLICATION_MEDIA_SOURCE_HOSTS`: hosts, separados por vírgula, de onde o publicador pode copiar as mídias comerciais internas. Não informe protocolo nem caminho.
- `PUBLIC_SITE_URL`: `https://imoveis.lurds.com.br`.
- `PUBLIC_MEDIA_S3_ENDPOINT`: endpoint S3 mostrado na aba Credentials do bucket.
- `PUBLIC_MEDIA_S3_REGION`: `auto` para o Railway Bucket.
- `PUBLIC_MEDIA_S3_FORCE_PATH_STYLE`: `1` para o Railway Bucket.
- `PUBLIC_MEDIA_S3_ACCESS_KEY_ID`.
- `PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY`.
- `PUBLIC_MEDIA_S3_BUCKET_NAME`.

O bucket não deve possuir domínio público. Fotos, PDF e ZIP são entregues somente por rotas que confirmam que a ficha continua ativa. As variáveis antigas `PUBLIC_MEDIA_R2_*` continuam aceitas apenas para compatibilidade.

## Variáveis do backend FlowOps

No serviço do backend no Railway, adicionar:

- `PUBLIC_PROPERTIES_BASE_URL=https://imoveis.lurds.com.br`
- `PUBLIC_PROPERTIES_SYNC_URL=https://imoveis.lurds.com.br/api/internal/publications/sync`
- `PUBLIC_PROPERTIES_SYNC_SECRET`: exatamente o mesmo segredo do portal.

As variáveis `R2_*` atuais continuam sendo usadas apenas como origem interna das mídias comerciais. O hostname de `R2_PUBLIC_URL` deve constar em `PUBLICATION_MEDIA_SOURCE_HOSTS` no portal.

## Primeira implantação

1. Criar o Postgres público e configurar `DATABASE_URL` localmente sem gravá-la em arquivo versionado.
2. Dentro de `imoveis-publico/`, executar `npm run db:push` uma única vez para criar as tabelas públicas.
3. Configurar todas as variáveis na Vercel e implantar o portal.
4. Configurar as três variáveis `PUBLIC_PROPERTIES_*` no backend FlowOps.
5. Implantar backend e frontend do FlowOps.
6. Configurar o domínio e confirmar HTTPS.
7. Cadastrar um imóvel piloto, abrir a prévia e publicar.
8. Validar página, fotos, PDF, ZIP, WhatsApp, atualização, troca de link e despublicação.

Nada é publicado automaticamente. Todos os imóveis começam como rascunho.

## Desenvolvimento

```powershell
npm.cmd install
npm.cmd run db:push
npm.cmd run dev
```

O portal abre em `http://localhost:3002`. O build de produção é validado com `npm.cmd run build`.

## Controles de segurança implementados

- contrato de campos públicos por allowlist;
- rejeição defensiva de chaves privadas no publicador;
- HMAC com timestamp, nonce e chave de idempotência;
- versão monotônica contra publicação fora de ordem;
- armazenamento privado sem URL direta no navegador;
- revogação verificada em cada acesso a página, mídia, PDF e ZIP;
- rate limit sem armazenar o IP em claro;
- `noindex`, `nofollow`, CSP, HSTS e bloqueio de iframe;
- atualização atômica, preservando a versão anterior em caso de falha.
