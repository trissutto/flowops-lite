# Ficha comercial pública de imóveis — especificação de design

**Data:** 08/08/2026

**Status:** desenho funcional aprovado; aguardando revisão da especificação antes do plano de implementação

**Escopo:** módulo Imobiliário do FlowOps + novo portal público isolado

## 1. Objetivo

Transformar o cadastro patrimonial existente em uma fonte rápida e confiável de informações comerciais para corretores. Para cada imóvel, o proprietário do sistema deve conseguir manter uma ficha completa, revisar exatamente o que será compartilhado e publicar um link externo com PDF, fotos e resumo para WhatsApp.

O portal externo não pode acessar o banco, a autenticação, os cookies, os documentos internos nem qualquer outro módulo do FlowOps.

## 2. Situação atual

O módulo existente já oferece:

- cadastro básico do imóvel e endereço;
- proprietário e observações internas;
- água, energia, IPTU, taxas, matrícula e escritura;
- upload de anexos de cada seção;
- modelo de anexos gerais no backend;
- histórico de alterações;
- listagem, filtros, indicadores e arquivamento;
- acesso restrito pela lista `SUPREMO_EMAILS`.

As lacunas para o atendimento aos corretores são:

- ausência de inscrição municipal, áreas, valor de venda e características comerciais;
- ausência de galeria de fotos comerciais ordenável;
- ausência de separação explícita entre conteúdo público e privado;
- ausência de pré-visualização e controle de publicação;
- ausência de ficha em PDF, pacote de fotos e resumo para WhatsApp;
- o backend suporta anexos gerais, mas a tela individual atual não oferece uma aba geral de anexos/fotos;
- nenhuma superfície pública isolada existe hoje.

## 3. Decisão de arquitetura

Será criada uma solução de **publicação por cópia sanitizada**.

### 3.1 Ambiente interno

O FlowOps continua sendo a fonte da verdade. Uma nova aba **Ficha para Corretores** será adicionada ao imóvel. Nela, o usuário cadastra os dados comerciais, organiza as mídias, visualiza a ficha e controla a publicação.

### 3.2 Ambiente público

Será criada uma aplicação web separada, prevista como `imoveis-publico/` no repositório, mas implantada como projeto independente. O endereço planejado é `imoveis.lurds.com.br`.

O portal terá:

- projeto Vercel separado;
- Postgres em um projeto Railway separado do `heroic-mercy`;
- armazenamento privado de mídias em um projeto separado;
- segredos e variáveis próprios;
- nenhuma credencial ou conexão com o Postgres do FlowOps;
- nenhuma dependência da sessão ou do login do FlowOps.

O banco público conterá somente versões já sanitizadas das fichas autorizadas. Se o portal público for comprometido, o impacto fica limitado às informações que já haviam sido publicadas.

### 3.3 Comunicação entre os ambientes

O backend interno enviará comandos assinados para uma API privada do publicador:

- publicar nova ficha;
- atualizar ficha publicada;
- despublicar ficha;
- trocar o identificador público e invalidar o link anterior.

As requisições usarão assinatura com segredo compartilhado, timestamp, nonce, limite de tempo e chave de idempotência. O publicador rejeitará chamadas vencidas, repetidas ou com assinatura inválida.

O payload será construído por uma função com lista explícita de campos permitidos. Nenhum objeto Prisma completo será transmitido.

## 4. Dados da ficha comercial interna

Os dados comerciais ficarão em uma entidade 1:1 separada do cadastro patrimonial, prevista como `PropertyCommercialProfile`. Isso reduz o risco de misturar informações internas com a publicação.

### 4.1 Identificação e disponibilidade

- nome comercial do imóvel;
- inscrição municipal;
- tipo: casa, apartamento, terreno, sala comercial, galpão, loja ou outro;
- situação comercial: disponível, reservado, em negociação ou vendido;
- finalidade inicial: venda;
- referência interna opcional.

### 4.2 Endereço e localização

- CEP, logradouro, número, complemento, bairro, cidade e UF, reaproveitados do imóvel;
- link do Google Maps;
- observação pública de localização, por exemplo “próximo ao metrô”;
- opção de publicar o endereço completo, prevista como ligada por padrão conforme o escopo aprovado.

### 4.3 Áreas

- área do terreno em m²;
- área construída em m²;
- área útil em m²;
- marcação “não se aplica” individual para área de terreno ou construída, quando necessária.

Os valores serão numéricos positivos e exibidos com até duas casas decimais.

### 4.4 Características

- quartos;
- suítes;
- banheiros;
- vagas de garagem;
- andar;
- elevador;
- imóvel mobiliado;
- ano de construção;
- características/diferenciais em lista ordenável.

Todos esses campos são opcionais porque variam conforme o tipo do imóvel.

### 4.5 Informações financeiras

- valor de venda;
- valor mensal do condomínio;
- valor anual do IPTU;
- aceita financiamento;
- aceita permuta;
- valor negociável;
- texto público sobre condições de negociação.

Comissão do corretor e observações de negociação serão campos internos e nunca entrarão no payload público.

### 4.6 Conteúdo de divulgação

- descrição comercial;
- resumo curto para WhatsApp;
- título opcional da campanha;
- data da última conferência dos dados.

Se o resumo para WhatsApp ficar vazio, o sistema o gerará de forma determinística a partir dos campos publicados. Não haverá geração por IA no primeiro escopo.

## 5. Mídias comerciais

As mídias comerciais não serão misturadas com contas, matrícula, escritura ou anexos patrimoniais. Será usada uma coleção própria, prevista como `PropertyCommercialMedia`.

Tipos suportados:

- foto;
- planta;
- vídeo por URL;
- tour virtual por URL;
- arquivo comercial para download.

Para fotos e arquivos, serão guardados nome, tipo MIME, tamanho, origem interna, legenda, posição, indicação de capa e estado ativo.

A tela permitirá:

- upload de múltiplas fotos;
- escolha da foto de capa;
- ordenação por arrastar;
- edição de legenda;
- remoção;
- visualização do conjunto que será publicado.

Na publicação, apenas as mídias comerciais ativas serão copiadas para o armazenamento público separado. O portal não exibirá URLs do armazenamento interno nem URLs diretas do armazenamento público. Fotos e arquivos serão entregues por rotas do portal que verificam se a ficha continua ativa em cada acesso.

## 6. Fluxo de trabalho no FlowOps

### 6.1 Estados

A publicação terá os seguintes estados:

- `draft`: nunca publicada;
- `publishing`: primeira publicação em andamento;
- `published`: versão pública sincronizada;
- `update_pending`: dados internos mudaram depois da última publicação;
- `updating`: atualização em andamento;
- `unpublishing`: retirada em andamento;
- `unpublished`: sem acesso público;
- `error`: última operação falhou e requer nova tentativa.

### 6.2 Checklist de publicação

O botão **Publicar ficha** só será habilitado quando houver:

- nome comercial;
- inscrição municipal;
- tipo e situação comercial;
- endereço completo;
- valor de venda maior que zero;
- pelo menos uma área válida ou explicitamente marcada como “não se aplica”;
- descrição comercial;
- ao menos uma foto ativa definida como capa.

A tela mostrará cada pendência de forma objetiva.

### 6.3 Pré-visualização

Antes da primeira publicação e de cada atualização, o usuário verá uma prévia construída com o mesmo contrato usado pelo portal. A prévia terá uma seção **Dados que não serão enviados**, confirmando a exclusão dos campos privados.

### 6.4 Publicar e atualizar

Ao confirmar:

1. o backend valida a ficha;
2. constrói o payload usando a lista permitida;
3. cria uma versão e um hash do conteúdo;
4. registra uma operação idempotente;
5. envia os dados e copia as mídias para o ambiente público;
6. o publicador ativa a nova versão de forma atômica;
7. somente após a confirmação o FlowOps marca a versão como publicada.

Alterações internas não modificam automaticamente o conteúdo público. Elas mudam o estado para **Atualização pendente**, e o usuário decide quando clicar em **Atualizar publicação**.

### 6.5 Despublicar

O botão **Despublicar** pedirá confirmação e invalidará a ficha no portal. A página passará a responder como inexistente. As rotas de fotos, PDF e ZIP também passarão a negar o acesso imediatamente. As mídias públicas ligadas à versão serão programadas para remoção do armazenamento.

### 6.6 Trocar o link

O botão **Gerar novo link** criará um novo identificador aleatório e revogará o anterior. O identificador terá entropia mínima equivalente a 128 bits e não conterá nome, cidade, inscrição ou ID interno do imóvel.

## 7. Página pública do corretor

A página será responsiva, leve e profissional. Ela terá:

- foto de capa;
- galeria navegável;
- nome, tipo, situação e valor;
- inscrição municipal;
- endereço e acesso ao mapa;
- áreas;
- características;
- descrição e diferenciais;
- condições de negociação;
- vídeos, tour e planta quando disponíveis;
- data da última atualização;
- botão **Baixar ficha em PDF**;
- botão **Baixar todas as fotos**;
- botão **Copiar resumo para WhatsApp**.

Não haverá catálogo geral nem busca pública nesta primeira versão. O corretor acessará somente a ficha cujo link recebeu.

As páginas receberão `noindex` e `nofollow`, não aparecerão no sitemap e não terão navegação para outros imóveis.

## 8. PDF, fotos e WhatsApp

### 8.1 PDF

O PDF será gerado exclusivamente a partir do snapshot público ativo e terá:

- formato A4;
- identidade visual da Lurd's;
- foto de capa e seleção das melhores fotos;
- dados comerciais completos;
- data de atualização;
- QR Code apontando para a ficha pública;
- aviso de que preço e disponibilidade devem ser confirmados.

Assim, o PDF nunca terá mais informações do que a página pública.

### 8.2 Download de fotos

O botão de fotos gerará um ZIP com as fotos comerciais da versão ativa, mantendo a ordem da galeria e nomes de arquivo padronizados. A rota verificará o estado ativo antes de iniciar o download; o armazenamento não ficará diretamente público.

### 8.3 WhatsApp

O resumo copiará um texto curto com nome, tipo, bairro/cidade, áreas principais, valor, diferenciais e link público. O sistema mostrará confirmação após copiar.

## 9. Separação obrigatória de dados

O contrato público permitirá somente os campos definidos nesta especificação. A seguinte lista é proibida em qualquer publicação:

- proprietário;
- comissão e observações internas de negociação;
- observações patrimoniais;
- contas de água e energia e seus códigos;
- matrícula, cartório e arquivo da matrícula;
- escritura e arquivo da escritura;
- anexos de IPTU, contas, taxas ou documentos;
- IDs de usuários;
- logs de auditoria;
- URLs de armazenamento interno;
- IDs internos do imóvel ou das tabelas relacionadas.

A inscrição municipal é uma exceção intencional e aprovada: ela faz parte da ficha pública.

## 10. Persistência interna e pública

### 10.1 Entidades internas previstas

- `PropertyCommercialProfile`: dados comerciais 1:1;
- `PropertyCommercialMedia`: galeria e materiais comerciais 1:N;
- `PropertyPublication`: estado, identificador público, URL, versão, hash, datas e último erro;
- `PropertyPublicationJob`: fila transacional de publicar, atualizar, despublicar ou trocar link.

A fila evita depender da disponibilidade momentânea do portal. As tentativas terão backoff, idempotência e limite de concorrência.

### 10.2 Entidades públicas previstas

- snapshot público versionado;
- estado ativo/inativo;
- registro das mídias copiadas;
- nonces usados na autenticação da API privada;
- registro técnico das operações de publicação.

O snapshot público será validado por esquema antes de ser persistido. A troca de versão será atômica: nunca haverá página parcialmente atualizada.

## 11. APIs previstas

### 11.1 FlowOps autenticado

- obter e salvar perfil comercial;
- enviar, remover e reordenar mídias;
- obter checklist e prévia;
- publicar;
- atualizar publicação;
- despublicar;
- gerar novo link;
- consultar estado e último erro.

Essas rotas continuarão protegidas pelo mesmo escopo `SUPREMO_EMAILS` usado atualmente no módulo Imobiliário.

### 11.2 Portal público

- leitura server-side da ficha pelo identificador público;
- geração do PDF;
- geração do ZIP de fotos;
- API privada assinada para sincronizar, revogar e trocar identificador.

Não será criada uma API pública para listar imóveis.

## 12. Tratamento de falhas

- Uma falha na publicação inicial não tornará uma ficha parcial acessível.
- Uma falha de atualização manterá a versão pública anterior ativa.
- Uma falha de despublicação ficará visível como alerta crítico e será repetida pela fila até confirmar a revogação.
- Upload inválido informará tipo, tamanho ou motivo da rejeição sem apagar as mídias existentes.
- PDF ou ZIP indisponível mostrará mensagem clara e permitirá nova tentativa.
- Operações repetidas com a mesma chave de idempotência não duplicarão versões nem mídias.
- O último erro técnico será guardado para suporte, enquanto a interface exibirá uma mensagem segura e compreensível.

## 13. Segurança

- isolamento físico das credenciais, banco e armazenamento públicos;
- payload por lista permitida, nunca por exclusão posterior de campos;
- assinatura, timestamp, nonce e idempotência na API de publicação;
- identificadores públicos aleatórios e revogáveis;
- armazenamento privado sem URLs diretas no navegador;
- rotas de mídia, PDF e ZIP com verificação de publicação ativa e `Cache-Control: no-store`;
- validação de tipo e tamanho de arquivo;
- política de conteúdo e cabeçalhos de segurança no portal;
- limitação de requisições em PDF, ZIP e API privada;
- ausência de cookies e sessão do FlowOps no domínio público;
- auditoria de publicação, atualização, revogação e troca de link;
- páginas fora de mecanismos de busca.

## 14. Testes obrigatórios

### 14.1 Unidade

- serializer público contém apenas a lista permitida;
- todos os campos proibidos são rejeitados mesmo se aparecerem no objeto de origem;
- checklist por tipo de imóvel;
- geração do resumo de WhatsApp;
- assinatura e validação de timestamp/nonce;
- idempotência das operações.

### 14.2 Integração

- primeira publicação;
- atualização com troca atômica;
- falha durante atualização preserva versão anterior;
- despublicação invalida página, PDF, ZIP e mídia;
- troca de link invalida o anterior;
- repetição da fila não duplica snapshot nem arquivos;
- usuário fora de `SUPREMO_EMAILS` não acessa nem publica.

### 14.3 Interface

- checklist e prévia;
- upload múltiplo, capa e ordenação;
- estados de publicação e mensagens de erro;
- página pública em computador e celular;
- PDF visualmente conferido;
- ZIP com todas as fotos na ordem correta;
- resumo copiado para WhatsApp.

## 15. Implantação

1. Criar as tabelas e APIs internas sem alterar os imóveis existentes.
2. Criar o portal, banco e armazenamento públicos em ambientes separados.
3. Configurar os segredos da publicação nos dois ambientes.
4. Implantar o portal ainda sem fichas públicas.
5. Implantar backend e frontend internos.
6. Cadastrar e publicar um único imóvel piloto.
7. Validar link, PDF, ZIP, WhatsApp, atualização e despublicação.
8. Liberar o uso para os demais imóveis.

Os imóveis existentes começarão como rascunho e nada será publicado automaticamente.

## 16. Fora do primeiro escopo

- catálogo público pesquisável;
- indexação no Google;
- conta ou login para corretores;
- captação de leads e CRM imobiliário;
- integração com portais como Zap, Viva Real ou OLX;
- geração de texto por IA;
- locação e gestão de propostas;
- analytics de visualização por corretor.

Essas funções poderão ser avaliadas depois que o fluxo básico estiver estável.

## 17. Critérios de aceite

O trabalho estará concluído quando:

- cada imóvel puder manter uma ficha comercial sem misturar documentos internos;
- o usuário visualizar exatamente o payload antes de publicar;
- um imóvel puder ser publicado, atualizado, despublicado e ter o link trocado;
- o portal não possuir acesso técnico ao banco ou à autenticação do FlowOps;
- página, PDF, ZIP e WhatsApp mostrarem apenas dados públicos e a mesma versão;
- o link revogado não abrir página, PDF, ZIP ou mídia;
- falhas não expuserem versões parciais nem removerem a versão válida anterior;
- os testes de não vazamento de dados privados estiverem aprovados;
- um imóvel piloto tiver sido validado do início ao fim.
