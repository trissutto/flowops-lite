# Plano de implementação — editor visual de catálogo

**Design aprovado:** `docs/superpowers/specs/2026-08-15-editor-visual-catalogo-design.md`  
**Estratégia:** evoluir a ficha e os editores existentes; não criar um catálogo paralelo.

## Contexto encontrado

- `ProdutoFicha` e `ProdutoFichaCor` já guardam os campos editoriais por REF, marca e cor.
- `ProductPhoto` já representa as galerias consumidas pelo site.
- `SiteBanner` e `SiteCategoria` já alimentam banners e capas.
- `ProdutoFichaController`, `SiteBannersController` e `SiteCategoriasController` já usam autenticação administrativa.
- A retaguarda já possui editores de produto, banners, categorias e publicação.
- O editor atual de publicação aceita URLs e ainda está orientado ao WooCommerce; será adaptado progressivamente.
- O e-commerce consome o catálogo pelo backend e já usa tags de revalidação.

## Entrega 1A — fundação de conteúdo versionado

### Banco de dados

Alterar `backend/prisma/schema.prisma` e criar migração para:

- `SiteContentDraft`: tipo, chave do recurso, payload JSON, estado, versão-base, autor e erro;
- `SiteContentVersion`: tipo, chave, versão, payload publicado, autor e origem;
- `SiteMediaAsset`: identificador Cloudflare, metadados, estado, alt e foco;
- `SiteMediaUsage`: vínculo, função, ordem e recorte;
- índices únicos para um rascunho ativo por recurso e para versão sequencial;
- relações opcionais com usuário somente quando não criarem dependência de exclusão.

Adicionar enumerações Prisma para tipo, estado do rascunho, estado da mídia, função de uso e origem da versão.

### Serviço de conteúdo

Criar `backend/src/site-content-editor/` com unidades separadas:

- `site-content-draft.service.ts`: carregar, salvar e descartar rascunhos;
- `site-content-version.service.ts`: criar versão e restaurar;
- `site-content-publish.service.ts`: validação e publicação transacional;
- `site-content-editor.controller.ts`: API administrativa;
- `site-content-editor.module.ts`.

Endpoints iniciais:

- `GET /site-content-editor/product/:ref?marca=&cor=`;
- `PUT /site-content-editor/product/:ref/draft`;
- `POST /site-content-editor/product/:ref/publish`;
- `GET /site-content-editor/product/:ref/versions`;
- `POST /site-content-editor/product/:ref/restore/:version`.

Usar `JwtAuthGuard`, `AdminOnlyGuard` e `@AdminOnly()`. Validar REF-base + marca com as funções existentes. A publicação deve comparar `baseVersion` e responder `409` em conflito.

### Reutilização do domínio existente

- campos editoriais gerais são aplicados por `ProdutoFichaService`;
- campos de cor e publicação são aplicados por `upsertCor`;
- fotos publicadas são atualizadas no mesmo conjunto consumido por `LojaCatalogService`;
- preço e estoque continuam vindos do catálogo oficial;
- preço fica inicialmente somente leitura até ser identificado um único comando de domínio seguro para alterá-lo no sistema oficial.

Essa restrição evita que uma tabela editorial sobrescreva preço sem refletir ERP, checkout e PDV. O editor deve exibir a origem e bloquear a publicação de preço até o adaptador oficial estar implementado.

## Entrega 1B — Cloudflare Images

### Configuração

Adicionar variáveis validadas no backend:

- `CLOUDFLARE_ACCOUNT_ID`;
- `CLOUDFLARE_IMAGES_TOKEN`;
- `CLOUDFLARE_IMAGES_ACCOUNT_HASH`;
- `CLOUDFLARE_IMAGES_DELIVERY_HOST`, opcional;
- limites de bytes e pixels.

Nenhum segredo entra em `NEXT_PUBLIC_*` ou respostas de API.

### Serviço

Criar `backend/src/site-media/`:

- `cloudflare-images.client.ts`: chamadas REST isoladas;
- `site-media-validation.service.ts`: tipo real, limites e metadados;
- `site-media.service.ts`: autorização, confirmação, vínculo e remoção segura;
- `site-media.controller.ts`;
- `site-media.module.ts`.

Endpoints:

- `POST /site-media/direct-upload` cria upload direto temporário;
- `POST /site-media/:id/confirm` consulta a Cloudflare e grava metadados;
- `PATCH /site-media/:id` altera alt e foco;
- `DELETE /site-media/:id` remove somente sem usos ativos;
- `GET /site-media?query=&type=&status=` lista biblioteca.

### URLs de entrega

Criar adaptador central no backend e no e-commerce para montar URLs por identificador + variante. Não gravar URL final rígida no produto.

Variantes funcionais iniciais:

- `admin-thumb`;
- `catalog-card`;
- `product-main`;
- `product-zoom`;
- `banner-desktop`;
- `banner-mobile`;
- `category-cover`;
- `social-feed`.

Enquanto as variantes não existirem na conta, o backend deve falhar na verificação de configuração, sem publicar URLs quebradas.

### Compatibilidade

Fotos antigas continuam funcionando por URL externa. Novos registros usam `mediaAssetId`. O mapeador de catálogo aceita ambos durante a migração. Não migrar imagens antigas automaticamente nesta entrega.

## Entrega 1C — editor dentro do e-commerce

### Sessão administrativa

Não reutilizar diretamente o token da retaguarda em `localStorage` no domínio público. Criar troca segura e curta:

1. administrador abre o site pelo CRM;
2. CRM gera código de uso único com expiração curta;
3. e-commerce troca o código por cookie administrativo `HttpOnly`, `Secure` e `SameSite=Lax`;
4. BFF encaminha operações administrativas ao backend;
5. logout e expiração removem o modo de edição.

Criar rotas BFF sob `ecommerce/src/app/api/editor/`, nunca expor o token operacional ao JavaScript.

### Interface

Criar componentes focados:

- `EditorModeProvider` — estado e sessão;
- `EditorModeToggle` — botão flutuante;
- `EditableProductTrigger` — lápis no produto;
- `ProductEditorDrawer` — contêiner lateral;
- `ProductInfoEditor`;
- `ProductMediaEditor`;
- `ProductPriceViewer`;
- `ProductStockViewer`;
- `PublishReviewDialog`.

Carregar o JavaScript do editor apenas quando a sessão administrativa estiver ativa. Clientes comuns não recebem o bundle do editor.

### Produto

- abrir pelo `ref`, `marca` e `cor` do produto carregado;
- salvar rascunho com debounce e comando explícito;
- mostrar estado salvo, processando ou falhou;
- prévia usa payload do rascunho no drawer e na PDP;
- publicar mostra diferenças;
- conflito `409` oferece recarregar e comparar, nunca sobrescrever silenciosamente.

### Fotos

- selecionar arquivo local;
- obter upload direto pelo BFF;
- enviar à Cloudflare com progresso;
- confirmar processamento;
- adicionar ao rascunho;
- ordenar, escolher capa, editar alt e foco;
- manter foto publicada em caso de falha;
- impedir publicação com mídia pendente.

## Entrega 1D — publicação e cache

Após aplicar a versão:

- invalidar `produto:<slug>`;
- invalidar `catalogo`;
- invalidar categorias anterior e atual;
- verificar o endpoint público do produto;
- registrar identificador de correlação e resultado.

Se a gravação de conteúdo falhar, não criar versão publicada. Se a revalidação falhar depois da transação, marcar a publicação como `published_with_warning`, preservar auditoria e permitir nova revalidação idempotente.

## Entrega 2 — banners e capas

Reutilizar infraestrutura de rascunhos, versões e mídia.

### Banners

- adaptar `SiteBannersService` para payload versionado;
- usos `banner-desktop` e `banner-mobile`;
- título, texto, CTAs, links e agendamento;
- prévia no slot real;
- validação de datas e links.

### Capas

- adaptar `SiteCategoriasService`;
- uso `category-cover`;
- título, descrição, alt e foco;
- prévia nos recortes do menu, grade e página da categoria.

## Entrega 3 — central de mídia

- página consolidada no CRM;
- busca e filtros;
- mapa de usos;
- reutilização;
- edição de alt e foco;
- exclusão segura;
- rotina de detecção de ativos órfãos sem remoção automática inicial.

## Testes

### Backend unitário

- validação de payload e estado;
- conflito de versão;
- preço somente leitura;
- transições do rascunho;
- montagem de variantes;
- confirmação Cloudflare;
- impedimento de exclusão em uso;
- publicação e restauração.

### Backend integração

- autenticação e autorização;
- criação e atualização de rascunho;
- transação de publicação;
- falhas Cloudflare simuladas;
- revalidação idempotente.

### E-commerce

- controles ausentes para cliente comum;
- sessão administrativa via cookie;
- abertura pelo produto correto;
- salvamento e recuperação do rascunho;
- upload com progresso e falha;
- ordenação e capa;
- prévia responsiva;
- conflito e publicação.

### Verificação manual

- produto real com mais de uma cor;
- JPG, PNG, WebP e HEIC suportado pelo ambiente;
- rede lenta e upload interrompido;
- celular e computador;
- expiração de sessão;
- duas janelas editando a mesma peça;
- rollback após publicação.

## Ordem dos commits

1. `docs(ecommerce): planeja editor visual de catalogo`
2. `feat(backend): adiciona conteudo versionado do site`
3. `feat(backend): integra midia ao Cloudflare Images`
4. `feat(ecommerce): adiciona sessao segura do editor visual`
5. `feat(ecommerce): adiciona editor visual de produto`
6. `test(ecommerce): cobre publicacao e midia do editor`

Cada commit deve passar pelos testes do pacote afetado. Migração, cliente Prisma gerado e schema devem permanecer no mesmo commit de backend.

## Gate de conclusão da Etapa 1

- administrador entra no modo edição por sessão segura;
- produto correto abre pelo identificador composto;
- dados editoriais salvam como rascunho;
- imagem nova vai para Cloudflare Images e aparece na prévia;
- rascunho não aparece para clientes;
- publicação cria versão auditável e atualiza catálogo;
- falha preserva conteúdo publicado e rascunho;
- restauração funciona;
- preço e estoque permanecem coerentes com seus sistemas oficiais.
