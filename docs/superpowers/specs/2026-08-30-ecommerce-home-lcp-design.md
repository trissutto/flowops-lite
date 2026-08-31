# Performance da home do e-commerce

## Objetivo

Elevar a pontuação mobile da home de `lurds.com.br` para pelo menos 90 e reduzir o Largest Contentful Paint de laboratório para no máximo 2,5 segundos, sem alteração visual intencional da página. A medição final deve usar Lighthouse mobile em condições equivalentes às capturas de 30/08/2026 e considerar a variação natural entre execuções.

## Diagnóstico de referência

Na implantação `dpl_7s1oCh5m5oXbbMcLex3TZ6nWCim6`, o PageSpeed marcou desempenho 81, FCP 1,4 s, LCP 4,5 s, TBT 100 ms e CLS 0. A resposta HTML da home medida em produção tem 937.872 bytes, 72 blocos React Flight e 186 links para produtos. A variante otimizada de 420 px da imagem LCP tem apenas 10,5 KiB e o TTFB observado ficou perto de 60 ms.

O volume de JavaScript legado indicado pelo Lighthouse representa economia estimada de apenas 14 KiB. Portanto, o trabalho priorizará reduzir e antecipar o caminho crítico da primeira pintura, especialmente o HTML/RSC serializado e a descoberta da imagem principal, sem uma reescrita geral do bundle.

## Arquitetura escolhida

### Conteúdo crítico

O hero, a navegação de categorias e a primeira prateleira de produtos continuarão renderizados no servidor. Assim, a primeira tela permanece funcional sem JavaScript, o conteúdo comercial prioritário continua indexável e não aparece um esqueleto no topo da home.

O hero manterá artes independentes para celular e desktop, mas o documento deverá anunciar somente a candidata compatível com o viewport. O `picture`, o preload e o `fetchPriority` deverão descrever a mesma seleção responsiva. A implementação não alterará texto, destino, enquadramento nem proporção visual das artes cadastradas.

### Conteúdo abaixo da dobra

As prateleiras posteriores à primeira serão retiradas do payload crítico e carregadas progressivamente no navegador quando a região se aproximar da viewport. Uma Route Handler do próprio e-commerce, `GET /api/home/prateleiras`, fornecerá somente os blocos posteriores em formato compacto. Ela reutilizará o serviço server-side existente, aplicará o mapeador compacto antes de responder e terá cache/revalidação de 60 segundos, acompanhando o catálogo. O navegador não chamará o backend FlowOps diretamente.

O espaço de cada região será estável durante o carregamento. O placeholder preservará a largura, o número de colunas e uma altura mínima compatível com os cards, evitando regressão de CLS. Falha na carga mostrará uma ação discreta para tentar novamente; o restante da home continuará utilizável.

### Contrato compacto de produto

A home receberá somente os campos usados pelo `ProductCard`: identificação e slug, nome, preço e promoção, imagem principal e alternativa, disponibilidade e tamanhos, cor da vitrine, badges, tecido e dados de Pix/parcelamento. Campos de ficha completa, descrições extensas e estruturas não consumidas pelo card não serão serializados para o navegador.

O tipo compacto terá um mapeador explícito no limite do servidor. O tipo completo do catálogo não será enfraquecido e as páginas de categoria e produto permanecerão fora desta mudança.

### SEO e dados estruturados

O HTML inicial continuará contendo o hero, os atalhos, a primeira prateleira e o JSON-LD da home. O JSON-LD poderá mencionar até 24 produtos, como hoje, mesmo quando alguns cards visuais forem carregados depois, desde que os itens correspondam a produtos reais e públicos retornados na mesma geração da página.

Links de “ver todas”, títulos das vitrines e ordem definida na Retaguarda permanecerão iguais. O carregamento progressivo não mudará URLs nem parâmetros de campanha.

## Fluxo de dados

1. A geração estática revalidada busca hero, blocos da home e Instagram em paralelo.
2. O servidor separa a primeira prateleira das prateleiras posteriores.
3. O documento inicial renderiza o conteúdo crítico e inclui somente o contrato compacto necessário à hidratação desse conteúdo.
4. Um componente cliente leve observa o marcador das prateleiras posteriores.
5. Ao se aproximar da viewport, ele solicita os blocos restantes uma única vez e renderiza os mesmos componentes visuais.
6. Em caso de falha, a região mantém altura estável e permite nova tentativa sem recarregar a página.

## Instrumentação e limites

A implementação deverá registrar ou expor de forma testável:

- tamanho do HTML gerado para a home;
- quantidade de cards e links de produto presentes no HTML inicial;
- quantidade de preloads de imagem do hero aplicáveis a cada viewport;
- ausência de requisição das prateleiras adiadas antes do gatilho;
- ausência de mudança visual relevante entre o estado atual e o otimizado.

O alvo de engenharia será reduzir materialmente o HTML inicial, com orçamento preferencial de até 300 KiB descompactados. Esse orçamento é um meio de alcançar o objetivo, não substitui a validação de LCP. Se o limite exigir remover conteúdo crítico ou prejudicar SEO, prevalecem a experiência e a meta de LCP.

## Testes e verificação

- Testes unitários do mapeador de produto compacto, incluindo preço, promoção, disponibilidade, tamanhos e cor selecionada.
- Teste do carregador progressivo: não busca antes do gatilho, busca uma vez, renderiza sucesso e oferece retry após erro.
- Teste do hero responsivo: `picture`, preload e prioridade apontam para a arte correta em mobile e desktop.
- Build de produção e suíte existente do projeto `ecommerce`.
- Inspeção do HTML de produção local para medir bytes, Flight payload, links e preloads.
- Lighthouse mobile executado pelo menos três vezes; usar a mediana e registrar também cada execução.
- Conferência visual em 360 px, 390 px, 768 px, 1024 px e desktop largo.

## Entrega e aceite

A entrega será feita em branch própria, com push e link de abertura de PR para `main`. O deploy continuará manual.

Critérios de aceite:

- mediana do Lighthouse mobile com desempenho igual ou superior a 90;
- mediana do LCP de laboratório igual ou inferior a 2,5 s;
- FCP, TBT e CLS sem regressão material em relação a 1,4 s, 100 ms e 0;
- hero e organização visual da home preservados;
- primeira prateleira disponível no HTML inicial;
- prateleiras posteriores carregadas de forma confiável e sem salto perceptível;
- testes e build aprovados.

## Fora de escopo

- redesenhar a home ou reduzir manualmente o catálogo definido na Retaguarda;
- alterar checkout, páginas de categoria, PDP ou integrações de pagamento;
- trocar as artes da Linha Conforto;
- otimizar todo o JavaScript do e-commerce sem evidência de impacto no LCP;
- fazer o deploy de produção.
