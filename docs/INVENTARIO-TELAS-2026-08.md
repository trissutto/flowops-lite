# Inventário de telas do CRM — 11/08/2026

**223 rotas** no frontend. 88 com botão em hub (/loja, /retaguarda, /config, /gestao), 70 alcançáveis só por link interno, 48 sem link nenhum (acesso só por URL digitada — parte é pública de propósito: /cadastro-live, /meus-pedidos, /p/:id).

**Acesso por tela: começou a contar HOJE.** Não existia registro em lugar nenhum (nem Vercel Analytics). A tabela `page_access` agora grava última visita, contagem e papel de quem usou — consulta em `GET /telemetria/paginas`. Em ~1 semana este relatório ganha a coluna que decide os cortes.

Gerado por script (scratchpad/inventario.js + segmentar.js). Regenerar após mudanças de rota.

## Outros — 62 telas (29 com botão em hub · 5 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/` | — | — | SEM LINK — só por URL |
| `/admin/routing-debug/[wcId]` | — | — | detalhe (via lista) |
| `/login` | ✅ | config, franquias/estoque | ok |
| `/loja` | ✅ | config, config/whatsapp-cobranca | ok |
| `/lojas` | ✅ | config, pedidos/wc/[id] | ok |
| `/meu-pedido` | ✅ | page.tsx (push) | ok |
| `/meus-pedidos` | — | — | SEM LINK — só por URL |
| `/minha-loja` | ✅ | gestao, minha-loja/comissao | ok |
| `/minha-loja/consultar` | — | minha-loja, minha-loja | só link interno |
| `/minha-loja/historico` | — | minha-loja | só link interno |
| `/minha-loja/imprimir-resumo` | — | — | SEM LINK — só por URL |
| `/minha-loja/imprimir-todos` | — | — | SEM LINK — só por URL |
| `/minha-loja/imprimir/[id]` | — | — | detalhe (via lista) |
| `/p/[cartId]` | — | — | detalhe (via lista) |
| `/pagar/[cartId]` | — | — | detalhe (via lista) |
| `/pedidos` | — | pedidos/wc/[id], pedidos/[id] | só link interno |
| `/pedidos/[id]` | — | pedidos/wc/[id], pedidos/[id] | detalhe (via lista) |
| `/pedidos/wc/[id]` | — | — | detalhe (via lista) |
| `/retaguarda` | ✅ | config/nfce, config/pagarme | ok |
| `/retaguarda/auditoria-master` | — | retaguarda/super-painel-caixas | só link interno |
| `/retaguarda/correios` | ✅ | retaguarda | ok |
| `/retaguarda/demandas` | ✅ | retaguarda | ok |
| `/retaguarda/descontos-senhas` | ✅ | loja | ok |
| `/retaguarda/diagnostico-erp` | — | components/SideNav.tsx | só link interno |
| `/retaguarda/divergencias` | — | retaguarda/wincred-mirror | só link interno |
| `/retaguarda/dm` | — | retaguarda/instagram-hub, components/SideNav.tsx | só link interno |
| `/retaguarda/enviados-hoje` | ✅ | retaguarda | ok |
| `/retaguarda/fechamento-caixa` | — | retaguarda/super-painel-caixas | só link interno |
| `/retaguarda/fornecedores` | ✅ | retaguarda, retaguarda/produto-estoque/cadastros | ok |
| `/retaguarda/inbox` | — | retaguarda/instagram-hub, components/SupplyRequestAlert.tsx | só link interno |
| `/retaguarda/instagram` | — | retaguarda/instagram-hub, components/SideNav.tsx | só link interno |
| `/retaguarda/instagram-hub` | ✅ | page.tsx, retaguarda/dm | ok |
| `/retaguarda/inteligencia-vendas` | — | retaguarda/dashboard-estrategico, retaguarda/inteligencia-estoque | só link interno |
| `/retaguarda/loja-frete` | ✅ | loja | ok |
| `/retaguarda/lojas` | — | pedidos/wc/[id], retaguarda/financeiro/transferencias | só link interno |
| `/retaguarda/lu-config` | — | retaguarda/instagram-hub, components/SideNav.tsx | só link interno |
| `/retaguarda/mais-envios` | ✅ | retaguarda | ok |
| `/retaguarda/manychat-import` | ✅ | loja, minha-loja/live-pdv | ok |
| `/retaguarda/mapa-urls` | ✅ | loja | ok |
| `/retaguarda/marcados` | ✅ | retaguarda | ok |
| `/retaguarda/materiais` | ✅ | loja, page.tsx | ok |
| `/retaguarda/materiais/imprimir/[id]` | — | — | detalhe (via lista) |
| `/retaguarda/notificacoes` | ✅ | retaguarda | ok |
| `/retaguarda/promocoes-config` | ✅ | loja | ok |
| `/retaguarda/remessas` | ✅ | loja, page.tsx | ok |
| `/retaguarda/revisao-identidade` | ✅ | retaguarda | ok |
| `/retaguarda/super-painel-caixas` | ✅ | franquias, login | ok |
| `/retaguarda/transferencias-rede-franquia` | ✅ | retaguarda, components/SideNav.tsx | ok |
| `/retaguarda/transferencias-report` | — | components/SideNav.tsx | só link interno |
| `/retaguarda/venda-certa` | ✅ | loja, components/SideNav.tsx | ok |
| `/retaguarda/vendedoras` | ✅ | config, retaguarda/dashboard-estrategico | ok |
| `/retaguarda/vendedoras-ativas` | — | retaguarda/rh | só link interno |
| `/retaguarda/vendedoras/[id]` | ✅ | config, retaguarda/dashboard-estrategico | detalhe (via lista) |
| `/retaguarda/vendedoras/nova` | — | retaguarda/rh, retaguarda/vendedoras | só link interno |
| `/retaguarda/whatsapp` | — | components/SideNav.tsx | só link interno |
| `/separacao` | ✅ | page.tsx, site | ok |
| `/separacao/imprimir/[wcId]` | — | — | detalhe (via lista) |
| `/trocas` | — | meus-pedidos | só link interno |
| `/usuarios` | ✅ | config, retaguarda/dashboard | ok |
| `/visao-geral` | — | — | SEM LINK — só por URL |
| `/vitrine` | — | site, vitrine | só link interno |
| `/vitrine/[slug]` | — | site, vitrine | detalhe (via lista) |

## Produtos & Estoque — 43 telas (25 com botão em hub · 7 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/auditoria-sku` | — | retaguarda/produto-estoque/cadastros | só link interno |
| `/cadastros/classificacao-peca` | ✅ | loja, retaguarda/produto-estoque/cadastros | ok |
| `/cadastros/classificacao-produtos` | ✅ | loja | ok |
| `/franquias/estoque` | — | franquias | só link interno |
| `/loja/etiquetas-avulsas` | ✅ | loja, retaguarda/produto-estoque/entradas | ok |
| `/loja/pedidos-compra` | ✅ | loja, loja/pedidos-compra/novo | ok |
| `/loja/pedidos-compra/[id]` | ✅ | loja, loja/pedidos-compra/novo | detalhe (via lista) |
| `/loja/pedidos-compra/[id]/etiquetas` | ✅ | loja, loja/pedidos-compra/novo | detalhe (via lista) |
| `/loja/pedidos-compra/[id]/imprimir` | ✅ | loja, loja/pedidos-compra/novo | detalhe (via lista) |
| `/loja/pedidos-compra/novo` | — | loja/pedidos-compra, loja/pedidos-compra/[id] | só link interno |
| `/loja/reposicao` | ✅ | loja, retaguarda/produto-estoque/entradas | ok |
| `/minha-loja/realinhamento` | — | minha-loja, minha-loja/pdv | só link interno |
| `/pix/[baixaId]` | — | — | detalhe (via lista) |
| `/produtos` | ✅ | gestao, site | ok |
| `/retaguarda/almoxarifado` | ✅ | config, loja | ok |
| `/retaguarda/auditoria-ncm` | — | retaguarda/produto-estoque/cadastros, components/SideNav.tsx | só link interno |
| `/retaguarda/baixa-estoque` | — | retaguarda/baixas-log | só link interno |
| `/retaguarda/baixa-origem` | ✅ | retaguarda | ok |
| `/retaguarda/baixas-log` | ✅ | pedidos/wc/[id], retaguarda | ok |
| `/retaguarda/cadastro-produtos` | ✅ | retaguarda, retaguarda/produto-estoque/cadastros | ok |
| `/retaguarda/classificar-produtos` | ✅ | loja | ok |
| `/retaguarda/conferidor-estoque` | ✅ | retaguarda, retaguarda/produto-estoque/estoque | ok |
| `/retaguarda/distribuicao-estoque` | ✅ | retaguarda, retaguarda/produto-estoque/estoque | ok |
| `/retaguarda/editor-produtos` | ✅ | loja, retaguarda | ok |
| `/retaguarda/estoque` | — | retaguarda/produto-estoque/estoque | só link interno |
| `/retaguarda/inteligencia-estoque` | ✅ | loja, retaguarda/dashboard-estrategico | ok |
| `/retaguarda/produto-estoque` | ✅ | loja, retaguarda | ok |
| `/retaguarda/produto-estoque/cadastros` | — | — | SEM LINK — só por URL |
| `/retaguarda/produto-estoque/entradas` | — | — | SEM LINK — só por URL |
| `/retaguarda/produto-estoque/estoque` | — | — | SEM LINK — só por URL |
| `/retaguarda/produto-estoque/inteligencia` | — | — | SEM LINK — só por URL |
| `/retaguarda/produto-estoque/produtos` | — | retaguarda/produto-estoque/estoque | só link interno |
| `/retaguarda/produto-estoque/produtos/classificacao` | — | retaguarda/produto-estoque/cadastros | só link interno |
| `/retaguarda/produto-estoque/produtos/grade-geral` | — | — | SEM LINK — só por URL |
| `/retaguarda/produto-estoque/produtos/pendencias` | — | — | SEM LINK — só por URL |
| `/retaguarda/produto-master` | ✅ | loja, retaguarda/ficha-fila | ok |
| `/retaguarda/produtos-agrupados` | ✅ | loja | ok |
| `/retaguarda/produtos-vendidos` | — | franquias, retaguarda/super-painel-caixas | só link interno |
| `/retaguarda/realinhamento` | ✅ | loja, retaguarda/dashboard | ok |
| `/retaguarda/realinhamento/imprimir` | — | — | SEM LINK — só por URL |
| `/retaguarda/realinhamento/nao-encontrados` | ✅ | page.tsx, retaguarda | ok |
| `/retaguarda/reconciliar-estoque` | ✅ | retaguarda, retaguarda/produto-estoque/estoque | ok |
| `/retaguarda/reprocessar-estoque` | ✅ | retaguarda, retaguarda/produto-estoque/estoque | ok |

## PDV / Venda de loja — 27 telas (1 com botão em hub · 5 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/minha-loja/materiais` | — | minha-loja | só link interno |
| `/minha-loja/pdv` | ✅ | config, login | ok |
| `/minha-loja/pdv/caixa` | — | minha-loja/pdv | só link interno |
| `/minha-loja/pdv/caixa/sangria/[id]` | — | — | detalhe (via lista) |
| `/minha-loja/pdv/config-impressora` | — | minha-loja/pdv | só link interno |
| `/minha-loja/pdv/devolucao` | — | minha-loja/pdv | só link interno |
| `/minha-loja/pdv/fechamento` | — | minha-loja/pdv | só link interno |
| `/minha-loja/pdv/marcados` | — | minha-loja/pdv | só link interno |
| `/minha-loja/pdv/nfce/[saleId]` | — | — | detalhe (via lista) |
| `/minha-loja/pdv/notas` | — | franquias, minha-loja/pdv | só link interno |
| `/minha-loja/pdv/produtos-vendidos` | — | minha-loja/pdv | só link interno |
| `/minha-loja/pdv/recebimentos` | — | minha-loja/pdv, minha-loja/pdv/recebimentos/historico | só link interno |
| `/minha-loja/pdv/recebimentos-pix-confirmados` | — | — | SEM LINK — só por URL |
| `/minha-loja/pdv/recebimentos/extrato/[codCliente]` | — | — | detalhe (via lista) |
| `/minha-loja/pdv/recebimentos/historico` | — | minha-loja/pdv/recebimentos | só link interno |
| `/minha-loja/pdv/recebimentos/recibo/_id_deprecated` | — | — | SEM LINK — só por URL |
| `/minha-loja/pdv/recebimentos/recibo/[baixaId]` | — | — | detalhe (via lista) |
| `/minha-loja/pdv/recibo-devolucao/[returnId]` | — | — | detalhe (via lista) |
| `/minha-loja/pdv/recibo/[saleId]` | — | — | detalhe (via lista) |
| `/minha-loja/pdv/vale-presente/[code]` | — | — | detalhe (via lista) |
| `/minha-loja/pdv/vale-troca/[code]` | — | — | detalhe (via lista) |
| `/minha-loja/recebimento` | — | minha-loja | só link interno |
| `/minha-loja/transferencia` | — | minha-loja | só link interno |
| `/minha-loja/triagem` | — | minha-loja | só link interno |
| `/retaguarda/carne-config` | — | — | SEM LINK — só por URL |
| `/retaguarda/promissoria-config` | — | — | SEM LINK — só por URL |
| `/retaguarda/vendedoras-pdv` | — | — | SEM LINK — só por URL |

## Config / Sistema — 21 telas (10 com botão em hub · 9 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/config` | ✅ | config, config/whatsapp-cobranca | ok |
| `/config/pagarme` | ✅ | config | ok |
| `/config/pagbank` | ✅ | config/pagbank/por-loja, config | ok |
| `/config/pagbank/por-loja` | — | config/pagbank | só link interno |
| `/config/pix` | — | — | SEM LINK — só por URL |
| `/config/whatsapp` | ✅ | config, site | ok |
| `/config/whatsapp-cobranca` | ✅ | config | ok |
| `/configuracoes` | ✅ | config, sistema | ok |
| `/gestao` | — | — | SEM LINK — só por URL |
| `/impersonate` | — | — | SEM LINK — só por URL |
| `/logs` | ✅ | config, retaguarda | ok |
| `/relatorios/giga` | ✅ | loja, retaguarda/crediario | ok |
| `/relatorios/vendedoras` | ✅ | gestao, retaguarda | ok |
| `/retaguarda/auditoria` | — | — | SEM LINK — só por URL |
| `/retaguarda/dashboard` | ✅ | retaguarda/dashboard, retaguarda | ok |
| `/retaguarda/dashboard-estrategico` | — | — | SEM LINK — só por URL |
| `/retaguarda/giga-sombra` | — | — | SEM LINK — só por URL |
| `/retaguarda/instagram-dashboard` | — | retaguarda/instagram-hub, components/SideNav.tsx | só link interno |
| `/retaguarda/pagarme-config` | — | — | SEM LINK — só por URL |
| `/retaguarda/pagbank-config` | — | — | SEM LINK — só por URL |
| `/sistema` | — | — | SEM LINK — só por URL |

## Financeiro — 16 telas (9 com botão em hub · 3 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/financeiro` | ✅ | gestao, site | ok |
| `/franquias/faturamento` | — | franquias | só link interno |
| `/loja/juros-crediario` | ✅ | loja | ok |
| `/minha-loja/comissao` | — | — | SEM LINK — só por URL |
| `/retaguarda/comissoes` | — | retaguarda/comissoes/cargos, retaguarda/rh | só link interno |
| `/retaguarda/comissoes/cargos` | — | retaguarda/comissoes, retaguarda/rh | só link interno |
| `/retaguarda/conciliacao` | ✅ | retaguarda | ok |
| `/retaguarda/contas-pagar` | ✅ | retaguarda | ok |
| `/retaguarda/crediario` | ✅ | loja, page.tsx | ok |
| `/retaguarda/crediario-juros` | — | — | SEM LINK — só por URL |
| `/retaguarda/crediario/automatico` | ✅ | retaguarda/crediario, retaguarda | ok |
| `/retaguarda/crediario/mensagens` | — | retaguarda/crediario | só link interno |
| `/retaguarda/dre` | ✅ | retaguarda | ok |
| `/retaguarda/faturamento` | ✅ | retaguarda | ok |
| `/retaguarda/financeiro/transferencias` | ✅ | retaguarda/dashboard, retaguarda/lojas | ok |
| `/retaguarda/vales-troca` | — | — | SEM LINK — só por URL |

## Clientes / CRM — 12 telas (1 com botão em hub · 9 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/clientes` | ✅ | gestao, retaguarda | ok |
| `/clientes-crm` | — | clientes, clientes-crm/sincronizacao | só link interno |
| `/clientes-crm/sincronizacao` | — | clientes-crm | só link interno |
| `/crm/lista-personalizada` | — | — | SEM LINK — só por URL |
| `/crm/segmentos` | — | — | SEM LINK — só por URL |
| `/retaguarda/cashback` | — | — | SEM LINK — só por URL |
| `/retaguarda/cashback-config` | — | — | SEM LINK — só por URL |
| `/retaguarda/clientes` | — | — | SEM LINK — só por URL |
| `/retaguarda/clientes-duplicados` | — | — | SEM LINK — só por URL |
| `/retaguarda/convenios` | — | — | SEM LINK — só por URL |
| `/retaguarda/dce` | — | — | SEM LINK — só por URL |
| `/retaguarda/fit-ai` | — | — | SEM LINK — só por URL |

## Site / E-commerce — 12 telas (5 com botão em hub · 3 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/nossaslojas` | — | — | SEM LINK — só por URL |
| `/retaguarda/banners` | ✅ | loja | ok |
| `/retaguarda/categorias` | ✅ | loja, retaguarda/produto-estoque/cadastros | ok |
| `/retaguarda/categorias-mapa` | ✅ | loja | ok |
| `/retaguarda/ficha-fila` | ✅ | loja | ok |
| `/retaguarda/publicar-site` | — | retaguarda/produto-estoque/cadastros, site | só link interno |
| `/retaguarda/saidas-site` | — | — | SEM LINK — só por URL |
| `/retaguarda/trocas-site` | — | — | SEM LINK — só por URL |
| `/retaguarda/wincred-mirror` | — | retaguarda/marcados | só link interno |
| `/site` | ✅ | config, config/whatsapp-cobranca | ok |
| `/site/portal-trocas` | — | site | só link interno |
| `/site/trocas` | — | minha-loja/pdv, site | só link interno |

## RH / Ponto — 11 telas (1 com botão em hub · 0 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/minha-loja/funcionarias` | — | minha-loja | só link interno |
| `/minha-loja/ponto` | — | minha-loja | só link interno |
| `/minha-loja/ponto-celular` | — | minha-loja | só link interno |
| `/minha-loja/rosto` | — | minha-loja | só link interno |
| `/minha-loja/rosto/[sellerId]` | — | minha-loja | detalhe (via lista) |
| `/retaguarda/rh` | ✅ | page.tsx, retaguarda/rh/ponto-geofence | ok |
| `/retaguarda/rh/banco-horas` | — | retaguarda/rh | só link interno |
| `/retaguarda/rh/espelho-ponto` | — | retaguarda/rh | só link interno |
| `/retaguarda/rh/face-enroll/[sellerId]` | — | retaguarda/rh | detalhe (via lista) |
| `/retaguarda/rh/operadores` | — | retaguarda/rh | só link interno |
| `/retaguarda/rh/ponto-geofence` | — | retaguarda/rh | só link interno |

## Live Commerce — 6 telas (0 com botão em hub · 2 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/cadastro-live` | — | — | SEM LINK — só por URL |
| `/minha-loja/live-expedicao` | — | minha-loja | só link interno |
| `/minha-loja/live-pdv` | — | minha-loja | só link interno |
| `/minha-loja/live-romaneio/[cartId]` | — | — | detalhe (via lista) |
| `/retaguarda/live` | — | — | SEM LINK — só por URL |
| `/retaguarda/live-pro` | — | retaguarda/instagram-hub, components/SideNav.tsx | só link interno |

## Marketing — 6 telas (2 com botão em hub · 4 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/carrinhos-abandonados` | — | — | SEM LINK — só por URL |
| `/marketing` | ✅ | gestao, retaguarda | ok |
| `/marketing/recuperacao` | — | — | SEM LINK — só por URL |
| `/minha-loja/carrinhos-abandonados` | — | — | SEM LINK — só por URL |
| `/retaguarda/app-push` | — | — | SEM LINK — só por URL |
| `/retaguarda/campanhas` | ✅ | retaguarda | ok |

## Fiscal / NF — 3 telas (2 com botão em hub · 1 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/config/nfce` | ✅ | config | ok |
| `/retaguarda/nfce-config` | — | — | SEM LINK — só por URL |
| `/retaguarda/relatorio-fiscal` | ✅ | login, page.tsx (push) | ok |

## Imobiliário — 3 telas (2 com botão em hub · 0 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/imobiliario` | ✅ | imobiliario/novo, imobiliario/[id] | ok |
| `/imobiliario/[id]` | ✅ | imobiliario/novo, imobiliario/[id] | detalhe (via lista) |
| `/imobiliario/novo` | — | imobiliario | só link interno |

## Franquias — 1 telas (1 com botão em hub · 0 sem link nenhum)

| rota | botão no hub | linkada de | situação |
|---|---|---|---|
| `/franquias` | ✅ | franquias/estoque, franquias/faturamento | ok |
