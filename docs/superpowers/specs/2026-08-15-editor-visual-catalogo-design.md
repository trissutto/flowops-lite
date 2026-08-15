# Editor visual de catálogo, banners e capas

**Data:** 15 de agosto de 2026  
**Status:** design aprovado  
**Escopo inicial:** e-commerce Lurds Plus Size e CRM FlowOps

## Objetivo

Permitir que um administrador edite produtos, fotos, banners e capas diretamente no site, por uma interface simples e visual. O CRM continua sendo a fonte oficial dos dados; o site oferece uma camada de edição, pré-visualização e publicação sobre o cadastro existente.

O primeiro lançamento estará concluído quando o administrador puder abrir um produto real no site, editar seus dados e fotos, conferir a prévia, publicar e visualizar o resultado sem entrar na ficha técnica do CRM.

## Princípios

- O conteúdo publicado nunca é substituído por uma versão incompleta.
- Toda alteração começa como rascunho e exige publicação explícita.
- O CRM é a fonte oficial de produtos e conteúdo.
- Cloudflare Images armazena e entrega todas as novas imagens de produtos, banners e capas.
- Estoque por cor e tamanho é somente leitura na primeira versão.
- Operações administrativas exigem autenticação e permissão específicas.
- Toda publicação é auditável e reversível.

## Experiência no site

Administradores autenticados verão o comando **Modo edição**. Ao ativá-lo, elementos editáveis recebem um indicador discreto:

- produtos exibem um ícone de lápis;
- banners exibem um comando de edição;
- capas de categorias, coleções e campanhas exibem um comando de edição.

Um clique abre um painel lateral sem retirar o administrador da página atual. O conteúdo em edição aparece no contexto real da loja, com prévias para computador e celular. Clientes comuns nunca recebem os controles administrativos nem os dados dos rascunhos.

### Editor de produto

O painel possui quatro abas:

1. **Informações:** nome, referência visível, descrição, categoria e subcategoria.
2. **Fotos:** upload, ordenação, exclusão, capa, enquadramento, ponto de foco e texto alternativo.
3. **Preços:** preço normal, preço promocional e período da oferta.
4. **Estoque:** consulta por cor e tamanho, sem edição nesta versão.

A referência interna imutável identifica o produto nas operações. Nome e slug podem mudar sem risco de atualizar a peça errada.

### Editor de banner

O administrador poderá editar imagem, título, texto, botão, destino do botão, período de exibição e estado de publicação. Banners terão artes independentes para computador e celular.

Quando não existir arte móvel, o sistema poderá sugerir um recorte da imagem principal. A sugestão nunca será publicada automaticamente: o administrador deve conferir e aprovar o enquadramento.

### Editor de capa

Capas de categorias, coleções e campanhas permitirão editar imagem, título, descrição, texto alternativo e ponto de foco. A prévia mostrará os recortes usados nos principais tamanhos de tela.

## Estados e publicação

Cada versão passa pelos estados:

1. `draft` — alterações privadas e editáveis;
2. `processing_media` — arquivos sendo validados e processados;
3. `ready_for_review` — versão completa disponível para prévia;
4. `published` — versão pública vigente;
5. `failed` — falha registrada, sem afetar o conteúdo publicado.

Comandos principais:

- **Salvar rascunho:** persiste sem alterar a loja pública.
- **Pré-visualizar:** monta a página com a versão privada.
- **Publicar:** valida, cria uma versão, atualiza o CRM e renova os caches afetados.
- **Restaurar:** republica uma versão anterior como uma nova versão auditável.

Uma publicação é atômica do ponto de vista do site. Se CRM, Cloudflare, validação ou renovação falharem, a versão pública anterior permanece vigente e o rascunho é preservado.

## Arquitetura

### Componentes

1. **Controles de edição do e-commerce** — detectam a sessão administrativa e abrem o painel no contexto da página.
2. **Editor visual** — gerencia formulário, prévia, upload, ordenação e estado do rascunho.
3. **API administrativa do CRM** — autoriza, valida, versiona e publica alterações.
4. **Serviço de mídia** — cria uploads diretos seguros, acompanha processamento e controla vínculos.
5. **Cloudflare Images** — preserva o original e entrega variantes otimizadas.
6. **Publicador de catálogo** — atualiza os registros oficiais e invalida apenas as tags afetadas.
7. **Auditoria** — registra autor, instante, campos alterados, versão anterior e resultado.

### Fluxo de dados

1. O site solicita a ficha administrativa pela referência interna.
2. O CRM devolve dados publicados, rascunho existente, permissões e versão atual.
3. O editor salva alterações incrementais no rascunho.
4. Novas imagens são enviadas diretamente à Cloudflare por uma autorização temporária criada pelo backend.
5. O backend confirma processamento e associa os identificadores da mídia ao rascunho.
6. A prévia usa os dados privados e variantes da Cloudflare, sem alterar a versão pública.
7. A publicação valida a versão esperada, cria o histórico, atualiza os registros oficiais e renova as tags necessárias.
8. Uma verificação posterior confirma que o recurso publicado pode ser lido pelo e-commerce.

## Modelo de dados

O desenho deve contemplar as seguintes entidades, adaptadas aos modelos já existentes quando possível:

### `ContentDraft`

- identificador;
- tipo: produto, banner ou capa;
- referência do recurso;
- conteúdo estruturado do rascunho;
- estado;
- versão-base;
- autor;
- datas de criação e atualização;
- mensagem de falha, quando houver.

### `ContentVersion`

- identificador;
- tipo e referência do recurso;
- versão sequencial;
- fotografia completa do conteúdo publicado;
- autor e data;
- origem: publicação ou restauração.

### `MediaAsset`

- identificador interno;
- identificador do Cloudflare Images;
- nome original;
- formato, largura, altura e tamanho originais;
- estado de processamento;
- texto alternativo;
- ponto de foco horizontal e vertical;
- autor e datas.

### `MediaUsage`

- mídia;
- tipo e referência do recurso consumidor;
- função: capa, galeria, banner desktop, banner móvel ou capa de seção;
- posição;
- recorte ou foco específico.

Uma mídia só pode ser removida da Cloudflare quando não houver uso publicado, uso em rascunho nem versão histórica dentro do período de retenção.

## Cloudflare Images

Todas as fotos novas de produtos, banners e capas seguem este fluxo:

1. O backend valida nome, tipo declarado e permissão do usuário.
2. O backend cria uma autorização temporária de upload direto.
3. O navegador envia o arquivo à Cloudflare sem receber credenciais permanentes.
4. A Cloudflare preserva o original.
5. O backend confirma o resultado, lê os metadados e vincula o ativo ao rascunho.
6. O site solicita a variante adequada ao contexto e ao dispositivo.

### Arquivos aceitos

- JPEG;
- PNG;
- WebP;
- HEIC quando a conversão estiver disponível no pipeline adotado.

O backend valida o conteúdo real do arquivo, não apenas extensão ou `Content-Type`. Limites de dimensão e tamanho serão definidos em configuração e informados antes do envio.

### Tratamento

- corrigir orientação da câmera;
- remover metadados desnecessários;
- preservar definição e proporção do original;
- entregar AVIF ou WebP quando suportado;
- usar dimensões responsivas;
- manter original para variantes futuras;
- impedir publicação enquanto houver mídia pendente ou inválida.

### Variantes funcionais

O serviço deve definir variantes por finalidade, sem gravar URLs rígidas no CRM:

- miniatura administrativa;
- card de catálogo;
- foto principal;
- galeria ampliada;
- banner desktop;
- banner móvel;
- capa de categoria ou coleção;
- compartilhamento social e feed.

O CRM armazena o identificador da mídia e seus metadados. A URL de entrega é montada por um adaptador central, permitindo alterar nomes e dimensões de variantes sem regravar todos os produtos.

## Central de mídia

A central permitirá:

- pesquisar e reutilizar imagens;
- visualizar onde cada imagem é utilizada;
- filtrar por tipo, data e estado;
- alterar texto alternativo e ponto de foco;
- substituir um uso sem destruir o arquivo anterior;
- comparar recortes para computador e celular;
- impedir exclusão de mídia em uso;
- consultar histórico de versões.

Na primeira etapa, essas capacidades aparecem dentro do editor de produto. A tela consolidada da central entra na terceira etapa.

## Preços e promoções

- preço normal deve ser positivo;
- preço promocional deve ser menor que o preço normal;
- início deve preceder término;
- promoção expirada não exibe selo promocional;
- alteração de preço exige confirmação adicional antes de publicar;
- o resumo de publicação destaca preços anteriores e novos;
- a publicação registra valores antes e depois na auditoria.

## Segurança e concorrência

- autenticação administrativa obrigatória;
- permissão dedicada de edição de catálogo;
- permissão adicional de publicação;
- cookies seguros e proteção contra requisições forjadas;
- URLs de upload temporárias, de uso limitado;
- segredos da Cloudflare somente no backend;
- validação de arquivo e conteúdo no servidor;
- controle otimista pela `version-base`;
- bloqueio informativo quando outra pessoa estiver editando o mesmo recurso;
- publicação rejeitada se a versão-base estiver desatualizada;
- logs sem credenciais ou URLs temporárias completas.

## Erros e recuperação

O editor deve mostrar causas acionáveis:

- sessão expirada;
- usuário sem permissão;
- conflito com outra edição;
- arquivo inválido ou muito grande;
- processamento de imagem pendente;
- falha temporária da Cloudflare;
- CRM indisponível;
- validação de conteúdo;
- falha na publicação ou renovação do catálogo.

Falhas de upload permitem tentar novamente sem perder o restante do formulário. Falhas de publicação preservam o rascunho. Se a verificação posterior falhar, o sistema sinaliza a publicação para intervenção e mantém disponível a restauração imediata da versão anterior.

## Cache e consistência

A publicação deve invalidar somente o necessário:

- produto: `produto:<slug>`, `catalogo`, categoria atual e categoria anterior;
- banner: tag da área ou campanha correspondente;
- capa: `categorias` e a categoria ou coleção específica;
- alterações de slug: endereço antigo e novo, além do redirecionamento aplicável.

O publicador só informa sucesso depois de persistir a versão e solicitar a renovação. A verificação posterior consulta o endpoint público sem depender do cache administrativo.

## Observabilidade

Eventos mínimos:

- `visual_editor_opened`;
- `content_draft_saved`;
- `media_upload_started`;
- `media_upload_completed`;
- `media_processing_failed`;
- `content_preview_opened`;
- `content_publish_started`;
- `content_published`;
- `content_publish_failed`;
- `content_version_restored`.

Cada operação recebe um identificador de correlação. Logs devem permitir seguir editor, CRM, Cloudflare e renovação de cache sem registrar dados sensíveis.

## Testes e critérios de aceite

### Acesso

- clientes não veem nem acessam os endpoints administrativos;
- editores salvam rascunho;
- somente usuários com permissão de publicação publicam;
- sessão expirada preserva o formulário localmente até a nova autenticação.

### Produto

- editar nome, descrição, categoria e subcategoria;
- validar e publicar preço;
- consultar estoque sem alterá-lo;
- manter vínculo pela referência interna mesmo após mudar nome ou slug.

### Mídia

- enviar cada formato permitido;
- rejeitar arquivo incompatível ou adulterado;
- acompanhar processamento;
- ordenar galeria e escolher capa;
- definir texto alternativo e foco;
- servir dimensões adequadas em computador e celular;
- preservar a foto publicada durante falhas;
- impedir exclusão de mídia em uso.

### Banners e capas

- editar no contexto da página;
- usar artes independentes para desktop e mobile;
- visualizar e aprovar recortes;
- programar início e fim de banner;
- restaurar versão anterior.

### Publicação

- rascunho nunca aparece publicamente;
- conflito de versão impede sobrescrita silenciosa;
- falha do CRM ou Cloudflare não altera o conteúdo publicado;
- caches corretos são renovados;
- histórico identifica autor, data e diferenças;
- restauração cria uma nova versão auditável.

### Qualidade

- interface utilizável por teclado;
- funcionamento nos principais tamanhos de celular e computador;
- fotos sem perda visual perceptível no tamanho exibido;
- nenhuma imagem original pesada é enviada desnecessariamente ao celular;
- editor não degrada o JavaScript inicial entregue aos clientes comuns.

## Etapas de entrega

### Etapa 1 — produtos

- infraestrutura de rascunho, versão, auditoria e permissões;
- Modo edição e painel lateral;
- informações, preços e estoque somente leitura;
- upload de fotos para Cloudflare Images;
- galeria, capa, foco, prévia e publicação;
- renovação seletiva do catálogo.

### Etapa 2 — banners e capas

- edição direta no contexto da página;
- imagens desktop e mobile;
- conteúdo, links e agendamento;
- prévia responsiva e restauração.

### Etapa 3 — central de mídia

- biblioteca pesquisável;
- reutilização e mapa de usos;
- gestão consolidada de foco, texto alternativo e versões;
- retenção e remoção segura de arquivos sem uso.

## Fora do escopo inicial

- edição manual de estoque;
- movimentação de estoque;
- cadastro de fornecedores;
- alteração de pedidos;
- geração automática de imagens por inteligência artificial;
- publicação automática de recortes sugeridos;
- substituição do CRM por um cadastro paralelo.

## Decisões aprovadas

- edição acontece diretamente no site;
- CRM permanece como fonte oficial;
- fluxo obrigatório de rascunho, prévia e publicação;
- estoque é somente leitura na primeira versão;
- novas imagens são armazenadas e entregues pelo Cloudflare Images;
- o pipeline de mídia atende produtos, banners e capas;
- implementação ocorre em três etapas: produtos, banners/capas e central de mídia.
