# Plano de implementação — página `/lojas` híbrida

**Design aprovado:** `docs/superpowers/specs/2026-08-16-lojas-hibrida-meta-design.md`

## Contexto confirmado

- `NossasLojasPage` já roda no servidor e carrega a capa via `getBanners`.
- `NossasLojasClient` controla loja selecionada, geolocalização e drawer.
- `Hero` hoje oferece localizar loja e usar geolocalização; o segundo CTA será movido para Comprar online.
- `fetchVitrine` já entrega produtos reais, disponíveis e cacheados por 60 segundos.
- `ProductCard` é o card oficial do catálogo e deve ser reutilizado.
- O Event Manager possui taxonomia fechada; eventos novos exigem atualização de tipos, schemas, destinos e testes.
- A atribuição de sessão já guarda UTMs, `fbclid` e landing page. A nova navegação preservará somente parâmetros autorizados.

## Etapa 1 — utilitário seguro de atribuição

Criar `ecommerce/src/lib/campaign-links.ts`:

- permitir `utm_source`, `utm_medium`, `utm_campaign`, `utm_id`, `utm_term`, `utm_content` e `utm_adset`;
- aceitar somente destinos internos iniciados por `/`;
- mesclar parâmetros sem duplicação;
- identificar campanha Meta por `utm_source=meta`, sem diferenciar maiúsculas/minúsculas;
- devolver destino puro quando não houver parâmetros válidos.

Criar `ecommerce/src/lib/campaign-links.test.ts` cobrindo:

- URL completa usada na campanha;
- ausência de UTM;
- parâmetros desconhecidos;
- duplicação;
- tentativa de URL externa;
- capitalização de `meta`.

## Etapa 2 — catálogo no servidor

Alterar `ecommerce/src/app/(public)/lojas/page.tsx`:

- buscar `fetchVitrine({ ordenar: 'novidades', limite: 6 })` em paralelo com o banner;
- filtrar defensivamente produtos sem imagem ou preço válido;
- passar no máximo seis produtos para `NossasLojasClient`;
- manter a página funcional quando a consulta retornar vazia.

Não criar novo endpoint nem nova fonte de catálogo.

## Etapa 3 — dois caminhos no hero

Alterar `ecommerce/src/app/(public)/lojas/components/Hero.tsx`:

- manter **Encontrar minha loja**;
- substituir **Usar minha localização** por **Comprar online**;
- usar link real para `/novidades` com UTMs preservadas;
- rastrear `stores_online_cta_click` com `source_position=hero`;
- manter geolocalização disponível em `SearchLocate`.

O link precisa continuar navegável sem JavaScript.

## Etapa 4 — seção de novidades

Criar `ecommerce/src/app/(public)/lojas/components/OnlineShoppingSection.tsx`:

- título **Prefere receber em casa?**;
- texto aprovado no design;
- grade/carrossel responsivo de quatro a seis `ProductCard`s;
- carregamento tardio das imagens fora da dobra;
- CTA **Ver todas as novidades**;
- fallback textual com o mesmo CTA quando a lista estiver vazia.

Como `ProductCard` monta o próprio `href`, adicionar uma propriedade opcional e compatível para transformar o destino ou receber parâmetros de campanha. O padrão atual deve permanecer inalterado para todos os outros consumidores.

Registrar `stores_product_click` antes da navegação, com posição, REF e índice. Não duplicar `select_item` se o card já o emitir no fluxo usado.

Inserir a seção em `NossasLojasClient` depois de `StoresSection` e `StoreDrawer`, antes dos blocos editoriais de visita.

## Etapa 5 — faixa móvel da Meta

Criar `ecommerce/src/app/(public)/lojas/components/CampaignMobileBar.tsx`:

- renderizar somente quando `utm_source=meta`;
- ocultar em breakpoint desktop;
- estado inicial com **Compre também pelo site** e **Ver novidades**;
- estado selecionado com nome da unidade, **Como chegar** e **Comprar online**;
- respeitar `safe-area-inset-bottom`;
- posicionar acima de elementos flutuantes existentes sem cobrir consentimento ou WhatsApp;
- usar links reais e foco visível.

Passar `selected` e um sinal explícito de seleção do `NossasLojasClient`. O valor inicial `stores[0]` não pode fazer a faixa afirmar falsamente que uma unidade foi escolhida.

## Etapa 6 — tracking

Alterar:

- `ecommerce/src/lib/tracking/types.ts`;
- `ecommerce/src/lib/tracking/schemas.ts`;
- `ecommerce/src/lib/tracking/events.ts`;
- `ecommerce/src/lib/tracking/index.ts`;
- destinos que mantêm listas explícitas de eventos;
- testes da taxonomia e dos destinos.

Adicionar:

- `stores_online_cta_click`;
- `stores_product_click`.

Propriedades:

- `source_position`;
- `store_unit`, quando houver;
- `product_ref` e `item_index`, no clique do produto.

Estender a atribuição para `utm_adset` apenas se o pipeline completo — captura, persistência, API e relatório — aceitar o campo. Caso contrário, preservar esse parâmetro nos links e manter `utm_id` como chave confiável de campanha nesta entrega, sem gravar informação parcialmente suportada.

## Etapa 7 — testes de componentes e integração

Adicionar testes próximos aos componentes de `/lojas`:

- hero contém os dois CTAs e preserva UTMs;
- faixa não aparece sem Meta;
- faixa inicial não inventa loja selecionada;
- seleção troca texto e ações;
- seção renderiza produtos válidos;
- fallback aparece sem produtos;
- eventos recebem posição e dados corretos;
- destino permanece interno.

Executar:

1. testes unitários do utilitário e tracking;
2. testes dos componentes de lojas;
3. typecheck do ecommerce;
4. build de produção do ecommerce.

## Etapa 8 — validação visual e produção

Validar em viewport móvel e desktop:

- `/lojas` sem parâmetros;
- `/lojas?utm_source=meta&utm_medium=paid&utm_campaign=lojas&utm_id=teste&utm_term=instagram_story`;
- seleção manual de uma loja;
- geolocalização negada;
- catálogo indisponível simulado;
- navegação para novidade e produto com UTMs;
- ausência de sobreposição com cookies, WhatsApp e rodapé.

Depois do merge e deploy, conferir os mesmos cenários no domínio público e confirmar eventos no diagnóstico interno disponível, sem gerar compra falsa.

## Ordem de commits

1. `test(ecommerce): cobre links de campanha das lojas`
2. `feat(ecommerce): conecta pagina de lojas ao catalogo online`
3. `feat(ecommerce): adiciona faixa movel para campanhas Meta`
4. `feat(tracking): mede conversao online iniciada em lojas`
5. `test(ecommerce): cobre jornada hibrida da pagina de lojas`

Os commits podem ser consolidados se a separação quebrar o build intermediário, mas cada commit publicado deve ser coerente e testável.

## Gate de conclusão

- intenção de loja física continua funcionando;
- compra online está visível no hero e depois das lojas;
- faixa aparece exclusivamente no celular para tráfego Meta;
- UTMs autorizadas chegam ao catálogo e aos produtos;
- produtos são reais, disponíveis e carregados no servidor;
- eventos distinguem posição e produto;
- não há regressão de desempenho, acessibilidade ou elementos flutuantes;
- testes, typecheck e build passam;
- comportamento é verificado em produção.
