# Home cacheável para reduzir TTFB

## Objetivo

Reduzir o TTFB da Home permitindo que a Vercel entregue o HTML pelo cache de rota, sem alterar o visual, o catálogo ou a atribuição das campanhas.

## Diagnóstico

A rota `/` lê `searchParams` no Server Component para copiar UTMs aos links internos. No Next.js 15, essa API torna a página dinâmica. A resposta de produção confirma o efeito com `Cache-Control: private, no-cache, no-store`, `X-Vercel-Cache: MISS` e `Age: 0`.

O tracking já captura `utm_source`, `utm_medium`, `utm_campaign`, `utm_id`, `utm_term`, `utm_content`, `gclid` e `fbclid` diretamente de `window.location.search`, guarda a atribuição por 30 dias e envia esse contexto nos eventos e no pedido. Portanto, propagar a query em cada link da Home é redundante para atribuição e prejudica o cache da página inteira.

## Solução aprovada

1. Remover `searchParams`, `sanitizeCampaignParams` e `withCampaignParams` da Home.
2. Gerar os links internos da Home com os caminhos canônicos, sem copiar UTMs.
3. Declarar revalidação de 60 segundos na rota `/`, alinhada ao cache das vitrines.
4. Manter `TrackingProvider` e `captureAttribution` sem alterações; eles continuam capturando a campanha no primeiro carregamento.
5. Não alterar a página `/lojas`, pois ela possui experiência específica para campanhas Meta e está fora do escopo do TTFB da Home.

## Fluxo de dados

- A visitante abre `/` com parâmetros de campanha.
- A Vercel entrega o mesmo HTML cacheado da Home independentemente da query.
- Após a hidratação, `TrackingProvider` lê a URL completa e `captureAttribution` persiste a origem por 30 dias.
- Navegações internas usam URLs limpas; eventos e checkout recuperam a atribuição persistida.
- Alterações nas vitrines continuam aparecendo em até 60 segundos ou por revalidação por tag.

## Segurança e falhas

- Nenhum dado pessoal será movido para cookies ou cabeçalhos.
- Storage indisponível continua usando o comportamento defensivo existente do tracking.
- Falha do backend continua usando as vitrines padrão existentes.
- Não serão adicionados novos scripts ao caminho crítico.

## Validação

- Testes de atribuição continuam aprovados.
- Lint e build do e-commerce devem passar.
- O resumo do build deve marcar `/` como estática ou ISR, não dinâmica.
- Em produção, após o deploy e aquecimento, a Home deve deixar de responder com `private, no-store`; requisições repetidas devem poder apresentar cache da Vercel.
- Conferir que uma URL com UTMs ainda gera contexto de atribuição e que os links visuais da Home funcionam.

## Fora de escopo

- Mudanças visuais na Home.
- Alteração do conteúdo ou da ordem das vitrines.
- Otimização da página `/lojas`.
- Mudanças no checkout ou no backend.
