# Varredura do site — Lurd's Plus Size

**Data:** 15/08/2026  
**Site:** https://www.lurdsplussize.com.br/  
**Escopo:** home, categoria, busca/filtros, página de produto, sacola, início do checkout, telemetria do navegador, PageSpeed mobile, código de vitrine/checkout/tracking e eventos de produção.

## Resumo executivo

O site está tecnicamente saudável e rápido. O gargalo principal não é velocidade: é a passagem da página de produto para a sacola e, depois, a conclusão do pagamento.

No recorte de hoje, até a hora da análise:

| Etapa | Sessões | Conversão da etapa anterior |
|---|---:|---:|
| Sessões medidas | 312 | — |
| Viram uma peça | 195 | 62,5% |
| Adicionaram à sacola | 27 | 13,8% |
| Iniciaram checkout | 13 | 48,1% |
| Informaram pagamento | 9 | 69,2% |
| Compra registrada | 3 | 33,3% |

Há ainda 10 sessões com `add_to_cart_blocked`, 14 eventos de erro no checkout concentrados em 4 sessões e 4 erros de validação em 3 sessões. O primeiro foco deve ser aumentar a segurança para escolher tamanho e adicionar a peça; o segundo, entender e recuperar as poucas pessoas que encontram erros repetidos ao pagar.

## Prioridade 0 — fazer imediatamente

### 1. Reduzir o bloqueio por tamanho na página da peça

**Evidência:** apenas 27 das 195 sessões que viram produto adicionaram à sacola (13,8%); 10 sessões tentaram adicionar sem completar uma escolha obrigatória. O guia de tamanhos também foi a segunda página auxiliar mais vista do dia, com 22 visualizações, sinal de dúvida real.

**Melhorias:**

- Manter o tamanho obrigatório, mas ao tocar em “Adicionar à sacola” sem tamanho, rolar/focar o seletor, destacar todo o bloco e manter a mensagem visível.
- Mostrar a ajuda de tamanho antes do CTA com uma frase concreta, por exemplo: “Compare busto, cintura e quadril em 30 segundos”.
- Medir `size_help_open`, retorno do guia, tamanho recomendado, tamanho escolhido e conversão posterior.
- Testar o guia em modal/drawer, sem tirar a cliente da página da peça. Hoje existem trajetórias com várias idas e voltas entre produto e `/tamanhos/guia`.
- No adicionar rápido dos cards, abrir a escolha de tamanho de forma explícita e registrar origem (`card`, `PDP`, recomendação).

### 2. Tratar os erros repetidos de checkout por sessão, não por contagem bruta

**Evidência:** hoje foram 14 eventos de erro, mas em apenas 4 sessões. Duas sessões repetiram submissões/erros várias vezes. Isso não representa 14 clientes diferentes, porém é grave para as quatro pessoas afetadas.

**Melhorias:**

- Agrupar o painel por sessão, etapa, meio de pagamento, código técnico e pedido.
- Exibir ao cliente uma causa acionável: cartão recusado, dados inválidos, indisponibilidade temporária, estoque alterado ou erro interno.
- Depois de duas falhas, oferecer ação direta: tentar Pix, revisar dados ou chamar atendimento com o código do pedido já preenchido.
- Preservar formulário e etapa após erro; nunca obrigar redigitação.
- Criar alerta operacional para sessão com 2+ falhas em 10 minutos.

Observação: a classificação de erros já preparada no PR #893 é importante porque substitui o rótulo genérico “pedido recusado pelo servidor”. Ela deve ser incorporada e monitorada após o deploy.

### 3. Recuperar checkout e Pix pendentes

**Evidência:** 13 sessões iniciaram checkout, 9 chegaram à informação de pagamento e 3 compras foram registradas no recorte. Há pedidos recentes em `awaiting_payment`, inclusive Pix criado sem compra confirmada.

**Melhorias:**

- Enviar recuperação automática por WhatsApp apenas com consentimento, com link seguro para retomar.
- Para Pix, mostrar contagem regressiva, botão “copiar código”, QR Code, atualização automática e segunda via em “Meus pedidos”.
- Separar abandono real de Pix ainda dentro do prazo; não contar `pix_created` imediatamente como perda.
- Medir `payment_method_selected`, `pix_copied`, `pix_expired`, `card_declined`, `payment_retry` e `checkout_recovered`.

## Prioridade 1 — alto impacto comercial

### 4. Corrigir a promessa de tamanhos 44–60

O site afirma repetidamente “do 44 ao 60”, mas a categoria inspecionada mostrou filtro começando no 46 e a peça BMM-100 oferecia 46–60. Ao mesmo tempo, existem produtos com 44. A promessa institucional pode ser verdadeira para o catálogo, mas na PDP ela parece prometer aquela grade específica.

**Melhoria:** usar “Moda do 44 ao 60” apenas institucionalmente. Em cada produto, mostrar somente “Disponível nesta peça: 46, 48...” e garantir que o filtro 44 apareça sempre que houver qualquer item elegível.

### 5. Tornar promoção verificável

Alguns cards mostram “Promoção” sem preço anterior riscado nem percentual de desconto. O código também adiciona o selo pelo campo `promocao`, enquanto o desconto visual depende de `compareAtPrice`. Isso cria uma oferta difícil de conferir.

**Melhoria:** só exibir “Promoção” quando houver preço anterior válido e economia calculável; caso seja apenas uma seleção comercial, renomear para “Preço especial”.

### 6. Melhorar nomes e cores dos produtos

Há muitos nomes genéricos repetidos, como “Blusa Manga Curta”, o que dificulta comparação, favoritos, busca, anúncios e SEO. Uma cor também apareceu com nome acessível contaminado pelo título completo do produto em vez de apenas “Manteiga”.

**Melhorias:**

- Nome curto distintivo + referência visível, por exemplo “Blusa Marrie Manga Curta — BMM-100”.
- Normalizar `nomeAmigavel`, `alt` de fotos e rótulo acessível dos seletores de cor.
- Validar na retaguarda duplicidade de nome e cor com texto fora do padrão.

### 7. Usar a home para conduzir, não para mostrar tudo

A home tem boa estrutura, mas muitos carrosséis e blocos aumentam o DOM e diluem a escolha. A maior parte das entradas de hoje ocorreu diretamente em três produtos de campanha, não na home.

**Melhoria:** priorizar no topo os produtos/categorias com melhor conversão por origem, manter 2–3 caminhos principais e levar conteúdo editorial/Instagram para depois da primeira decisão de compra.

### 8. Ajustar filtros e avaliações

A categoria de blusas tem 236 itens e bons filtros, mas a quantidade de tamanhos e opções gera ruído. Existe ordenação “Mais avaliados” sem avaliação visível nas peças inspecionadas.

**Melhorias:**

- Mostrar filtros ativos e permitir limpar cada um com um toque.
- Priorizar tamanho disponível, faixa de preço e ocasião; recolher filtros secundários.
- Só manter “Mais avaliados” quando houver base real suficiente; caso contrário, ocultar.
- Exibir contagem de resultados após cada filtro e acompanhar filtro sem resultado.

## Prioridade 2 — qualidade técnica e aquisição

### 9. Corrigir o evento `ViewCategory` da Meta

O console registrou aviso do Meta Pixel: `ViewCategory` está sendo enviado como evento padrão, mas não é reconhecido como padrão e deveria usar `trackCustom`. O mapeamento está em `meta-pixel.ts` e também existe na CAPI.

**Impacto:** ruído no diagnóstico de campanhas e possível perda de consistência entre Pixel e CAPI.

**Melhoria:** enviar `view_item_list` como evento customizado coerente nas duas pontas, preservando o mesmo `event_id` para deduplicação; validar no Test Events da Meta.

### 10. Melhorar LCP sem transformar isso na prioridade principal

PageSpeed mobile: Performance 95, Acessibilidade 97, Boas Práticas 100 e SEO 100. FCP 1,1 s, LCP 2,9 s, TBT 30 ms e CLS 0. O LCP está um pouco acima da faixa “boa” de 2,5 s.

**Oportunidades indicadas:** cerca de 510 ms em recursos bloqueadores, 32 KiB de JavaScript não usado, 14 KiB de JavaScript legado, DOM grande, reflow forçado e três tarefas longas.

**Melhorias:** priorizar a imagem principal/LCP, reduzir CSS crítico bloqueante, adiar scripts não essenciais e limitar a quantidade inicial de carrosséis/cards. Não vale pausar melhorias de conversão para perseguir alguns pontos adicionais de nota.

### 11. Fechar os dois alertas de acessibilidade

O PageSpeed apontou contraste insuficiente e links com o mesmo texto levando a finalidades diferentes. A estrutura semântica geral está boa: idioma, skip link, landmarks, títulos e nomes de controles estavam presentes.

**Melhoria:** identificar os pares exatos no relatório, ajustar tokens de cor e tornar o texto/nome acessível dos links específico ao destino.

## O que já está bom

- Site rápido, estável e sem erro JavaScript da aplicação nas páginas inspecionadas.
- PDP apresenta preço, Pix, parcelamento, cores, tamanhos, estoque, frete, retirada, troca e WhatsApp.
- Prova social de vendas é derivada do ERP e tem piso mínimo; não é avaliação inventada.
- Sacola é clara, mostra progresso de frete grátis, cupom, CEP, subtotal e formas de pagamento.
- Checkout de produção começa de forma leve, com nome e WhatsApp e sem exigir conta/senha.
- SEO técnico e dados estruturados do produto estão em boa condição.
- Taxa de rejeição medida hoje foi 28,2%, aceitável para tráfego majoritariamente direcionado a PDPs.

## Plano recomendado de 14 dias

1. **Dias 1–2:** incorporar a classificação do PR #893; corrigir Meta `ViewCategory`; criar painel por sessão/código de erro.
2. **Dias 3–5:** melhorar o bloqueio de tamanho e transformar o guia em ajuda sem saída da PDP; corrigir 44–60 e rótulos de cor.
3. **Dias 6–8:** normalizar promoção/preço anterior e nomes de produto.
4. **Dias 9–11:** recuperação de Pix/checkout e ação alternativa após falha repetida.
5. **Dias 12–14:** simplificar primeira dobra da home/categoria e testar A/B.

## Metas para validar as mudanças

- Produto → sacola: de **13,8%** para pelo menos **18%**.
- Sacola → checkout: de **48,1%** para pelo menos **58%**.
- Sessões com `add_to_cart_blocked`: reduzir pelo menos **40%**.
- Sessões com 2+ erros de checkout: abaixo de **1%** dos checkouts.
- LCP mobile: abaixo de **2,5 s**, mantendo CLS 0.

As taxas são um retrato parcial de um único dia e devem ser acompanhadas em janela móvel de 7 e 28 dias, separadas por origem de campanha, dispositivo, produto e meio de pagamento.
