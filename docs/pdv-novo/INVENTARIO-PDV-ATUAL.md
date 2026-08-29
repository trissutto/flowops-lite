# Inventário funcional do PDV atual — insumo da etapa 1 do briefing

**Levantado em 29/08/2026** (varredura de `frontend/src/app/minha-loja/pdv/` + `backend/src/pdv/`) para a reforma visual. Nada aqui pode ser esquecido no redesenho; cada ⚠️ marca regra de negócio não-óbvia, geralmente nascida de prejuízo real e datado.

**Arquivo central:** `frontend/src/app/minha-loja/pdv/page.tsx` — **12.493 linhas**, 32 componentes num arquivo só.
**Backend:** `backend/src/pdv/` — 12 controllers, ~25 services, `pdv.service.ts` com 236 KB.

> ⚠️ **Aviso de estado**: na data da varredura o working tree tinha WIP de outra sessão (feature "Metas"/gamificação, 29/08) — `MetasModal` usado em `page.tsx:3747` sem existir ainda. Linhas podem driftar ~±26 vs. o commit.

---

## 1. FLUXO DE VENDA

### Bipagem e busca
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 1 | ScanBar isolada | Campo de bipe com estado local próprio pra não re-renderizar a árvore de 12k linhas a cada tecla | `page.tsx:453` |
| 2 | Fila serial de bipagem | Campo NUNCA trava (`disabled` removido); leituras entram em `chainRef` e gravam uma a uma, em ordem | `page.tsx:474-617` |
| 3 | Badge "N na fila" | Só aparece com `pending > 1` — sinal de que nenhuma peça se perdeu com internet lenta | `page.tsx:739` |
| 4 | ⚠️ Venda nasce no 1º bipe | `ensureSaleId()` cria a venda só ao bipar — antes nasciam 42 vendas vazias/dia (1.264 em 30d) | `page.tsx:1309`, `:573` |
| 5 | ⚠️ Reciclagem de órfãs DESABILITADA | Sempre cria venda nova: em Sorocaba com 2 PCs o PC2 adotava a venda do PC1 e as peças se misturavam | `page.tsx:1325-1340` |
| 6 | ⚠️ REF+ESPAÇO / Shift+Enter | Único gatilho de busca por grade. A regra "3-6 dígitos = REF" foi removida (código 10115 = Calça, REF 10115 = Meias) | `page.tsx:527-557`, `:683` |
| 7 | Fallback REF automático | Código numérico 3+ dígitos não encontrado → tenta como REF antes de dar erro | `page.tsx:596-605` |
| 8 | Dropdown de busca por texto | Debounce 300ms, só dispara com letra no termo; números são explícitos | `page.tsx:632-657` |
| 9 | Dropdown com estoque duplo | Cada resultado mostra "Sua loja" e "Rede" (`qtyMyStore` / `qtyTotal`) | `page.tsx:794-802` |
| 10 | Navegação por teclado no dropdown | ↑↓ navega, Enter escolhe, Esc fecha | `page.tsx:694-704` |
| 11 | Atalho "0" = item manual | Digitar `0` no campo abre o modal de produto livre | `page.tsx:520-526` |
| 12 | Endpoint de busca | `GET /products/erp-search?q=` (fora do módulo pdv) | `page.tsx:535`, `:644` |
| 13 | Botão consulta de promoção | Ícone 🏷️ na barra — abre PromoCheckModal sem lançar nada na venda | `page.tsx:728-735` |
| 14 | POST de item devolve venda inteira | `POST /pdv/sales/:id/items` retorna `{sale}` — elimina o GET extra por bipe | `pdv.controller.ts:849` |

### Carrinho
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 15 | Ordem invertida | Último bipado no topo, com faixa dourada | `page.tsx:~2952` |
| 16 | Flash verde 600ms | Item recém-adicionado (novo ou qty incrementada) pisca | `page.tsx:1566-1577` |
| 17 | Contador de PEÇAS vs LINHAS | Soma das qtds em destaque + nº de linhas quando diferem | `page.tsx:~2826` |
| 18 | Thumbnail do produto | `ProductThumb` puxa foto do WooCommerce via prefetch em lote | `page.tsx:11269`, `pdv.controller.ts:194` |
| 19 | Stepper de quantidade | − / input editável (1-99) / + | `page.tsx:~3028` |
| 20 | Linhas virtuais de vale-troca | Vale aplicado aparece no topo como "produto devolvido" negativo, com botão de remover | `page.tsx:~2914` |
| 21 | Venda de vitrine (`saleView`) | Objeto fake com zeros pra tela nascer inteira antes do 1º bipe (menu, painel, totais) | `page.tsx:975-1002` |
| 22 | ⚠️ Menu não depende de venda | Condição era `sale?.status==='open'` — sem venda o menu inteiro sumia e não dava pra consultar preço | `page.tsx:~2609` |
| 23 | Densidade de tela | 3 tamanhos fixos (compacto 0.86 / normal 0.95 / grande 1.05), auto pelo monitor, persistido por PC | `page.tsx:252-276`, `:1119-1145` |
| 24 | Layout highlighted vs legacy | Piloto visual com rollback em 1 clique, `localStorage` por PC | `page.tsx:1045-1058` |
| 25 | Modo noturno | Tema claro/escuro só deste computador, não sincroniza | `page.tsx:1062-1076` |
| 26 | Menu lateral recolhível | Persistido em `lurds_pdv_menu_collapsed` | `page.tsx:1032-1041` |

### Descontos
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 27 | DiscountModal | % e R$ sincronizados, editável pra arredondar | `page.tsx:11855` |
| 28 | ⚠️ Faixas de senha (MD-1) | 0–7% livre · >7–10% senha CAIXA · >10% senha GERENTE + justificativa obrigatória | `page.tsx:1582-1607`, `:1678-1697` |
| 29 | Faixas configuráveis | `GET /pdv/discount-policy` traz `freeUpToPct`/`caixaUpToPct`; default 7/10 se falhar | `page.tsx:1020-1029`, `access-policy.controller.ts:31` |
| 30 | ⚠️ Campanha bloqueia desconto avulso | Com promoção ativa, desconto por item e da venda são recusados no front | `page.tsx:1587`, `:1674` |
| 31 | ⚠️ Base do desconto da venda | É o subtotal LÍQUIDO (já com descontos de item) — desconto da venda é EXTRA | `page.tsx:~4130` |
| 32 | Item com desconto vira MANUAL | `promoTag='MANUAL'` foge do recálculo automático | `pdv.service.ts:2455`, `:3060` |
| 33 | Validação real no servidor | `requireDiscountAuth` — o front só decide qual prompt mostrar | `pdv.controller.ts:1010`, `:986` |

### Promoções automáticas
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 34 | ⚠️ Campanha YEAR_BASED (50%) | Produto com `dataCadastro <= 2023-12-31` = 50% off ("Liquida antigos") | `pdv.service.ts:3073-3086` |
| 35 | ⚠️ Regra da coleção | REF terminada em `-INV` ou `-VER` entra nos 50% independente do ano (regra do dono 10/07/2026) | `pdv.service.ts:3077`, `:196` |
| 36 | ⚠️ Filtro BÁSICO | Peça `tipoProduto=1` fica FORA dos 50% — configurável (`excluirBasicoNa50`), fail-open se a tabela sumir | `pdv.service.ts:127-141`, `:3099-3109` |
| 37 | ⚠️ Chave de classificação | REF quando existe; senão `#<codigo>` (meias/acessórios sem REF) | `pdv.service.ts:3092-3097` |
| 38 | ⚠️ REFs "liberadas na mão" | Toggle `promoLiberada` na tela de Classificação entra nos 50% mesmo sendo cadastro novo | `pdv.service.ts:151-167`, `:3113-3116` |
| 39 | ⚠️ Campanha FOUR_FOR_THREE | Carrinho com ≥4 peças: a de MENOR preço unitário sai grátis (1 unidade). Existe no backend mas NÃO tem botão na tela | `pdv.service.ts:3151-3181` |
| 40 | Campanhas não acumulam | Só uma roda por vez; `NONE` zera todos os descontos automáticos | `pdv.service.ts:3027`, `:3062-3072` |
| 41 | Itens travados | `promoTag='MANUAL'` e `'SEM_PROMO'` a promoção automática nunca toca | `pdv.service.ts:3056-3060` |
| 42 | Botão por item: 🚫 tirar da promo | `excludePromo=true` → zera desconto e trava como `SEM_PROMO` | `page.tsx:~3131`, `pdv.service.ts:2833-2900` |
| 43 | ⚠️ Botão azul ⬆️ FORÇAR promo | `forcePromo` ignora SÓ o filtro básico — data e coleção continuam decidindo | `page.tsx:~3122`, `pdv.service.ts:3121-3128` |
| 44 | Toast avisa quando o force não pegou | "Forçado, mas a data/coleção não se enquadra" | `page.tsx:1637-1643` |
| 45 | Badge de promoção por item | AZUL = fora/básico · VERMELHO = participando · CINZA = MANUAL (30% maior, pedido do dono 14/07) | `page.tsx:~2981` |
| 46 | ⚠️ DE/POR riscado na linha | `precoDeCents` > `precoUnit` → "de R$ X" cortado + "economiza R$ Y" (só exibição, cobra `precoUnit`) | `page.tsx:~3013`, `pdv.service.ts:2402` |
| 47 | ⚠️ Aviso "CLIENTE ECONOMIZOU" | Faixa dourada com script pra vendedora ler em voz alta; some em 12s ou no próximo bipe sem promo | `page.tsx:1006-1015`, `:~2797` |
| 48 | `promoDePor` no POST do item | Backend devolve `{de, por, economia}` junto com a venda | `pdv.service.ts:2439-2448` |
| 49 | Recalcular preços | Reconsulta o preço atual de cada item — corrige peças puxadas de MARCADO com preço congelado | `page.tsx:1719-1739`, `pdv.controller.ts:868` |
| 50 | Banner de campanha colapsado | Só abre se tem campanha ativa ou clique explícito | `page.tsx:~2846-2908` |
| 51 | PromoCheckModal | Bipa e responde "entra nos 50%?" com motivo em português, sem tocar na venda | `page.tsx:12371`, `pdv.controller.ts:701` |
| 52 | ⚠️ PromoCheck avisa DATAALT | A única data do Giga é `DATAALT` e muda quando editam o cadastro — peça velha reeditada perde a promo | `pdv.service.ts:245-247` |

### Vendedora
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 53 | ConfirmSaleModal | Popup central de encerramento: resumo da venda + escolha da vendedora num lugar só | `page.tsx:4300` |
| 54 | ⚠️ Whitelist de vendedoras ativas | `GET /pdv/vendedoras-ativas` tem prioridade e filtra LOCAL; fallback pro Wincred `funcionarios-search` | `page.tsx:~4330-4380`, `active-sellers.controller.ts:42` |
| 55 | Apelido manda | O apelido do cadastro é o que aparece e o que grava na venda | `page.tsx:~4312` |
| 56 | Gate no ENCERRAMENTO | Vendedora exigida no finalize, não no 1º bipe (libera a cliente mais rápido); F9 foi removido | `page.tsx:2091-2095`, `:1500` |
| 57 | Retomada automática | `pendingFinalizeRef` + `pendingScanRef` — após escolher a vendedora, o finalize e o bipe pendentes disparam sozinhos | `page.tsx:1938-1969` |
| 58 | ⚠️ Venda online não pergunta 2x | Com `entregaTipo` preenchido + vendedora gravada, o finalize passa direto | `page.tsx:2083-2091` |
| 59 | Chip da vendedora no header | Some se o nome for igual ao da loja (alguns fluxos gravam loja em `vendedorName`) | `page.tsx:2543-2553` |
| 60 | Troca de vendedora pela retaguarda | `PATCH /pdv/caixa/master/sale/:id/seller` e `.../sale-item/:id/seller` | `cash.controller.ts:635`, `:658` |

### Cliente / CRM na venda
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 61 | CustomerModal | CPF, nome, e-mail, telefone + endereço completo | `page.tsx:4591` |
| 62 | Busca ViaCEP | CEP completo (8 dígitos) autopreenche endereço | `page.tsx:~4770` |
| 63 | Busca de cliente | `GET /pdv/customer-search` com escopo de loja | `page.tsx:~4826`, `pdv.controller.ts:1688` |
| 64 | ⚠️ Ficha por PESSOA | `GET /pdv/customer-resume?cpf=` agrega TODOS os cadastros (lojas + site) pelo CPF | `page.tsx:2014-2022`, `customer-resume.controller.ts:19` |
| 65 | Badge de origem | "🌐 Cliente do SITE" / "🏬 Cliente da loja X" quando o cadastro não é da loja atual | `page.tsx:~3224` |
| 66 | Saldo de cashback no card | Mostra `cashbackBalanceCents` quando > 0 | `page.tsx:~3233` |
| 67 | ⚠️ Sugestões de atendimento | "🆕 PRIMEIRA COMPRA", "💰 Pode usar R$ X de cashback (até 30% da compra, mínimo R$ 20)" | `page.tsx:~4955-4980` |
| 68 | Data de expiração do cashback | Exibida na ficha | `page.tsx:~5040` |
| 69 | ⚠️ Régua venda online — 2 níveis | CONTATO (nome+sobrenome, CPF, WhatsApp, e-mail) sempre; ENDEREÇO só quando a peça VIAJA. RETIRADA fecha sem CEP | `page.tsx:2273-2317`, `lib/dados-cliente-online.ts` |
| 70 | Régua espelhada no servidor | `backend/src/common/dados-cliente-online.ts` barra antes de gerar cobrança | `page.tsx:2287` |
| 71 | Upsert de cliente no CRM | Finalize grava/atualiza `Customer` + `CustomerAddress` primário (não empilha endereço repetido) | `pdv.service.ts:3440-3499` |
| 72 | Copiar ficha de outra loja | 1 clique: `POST /pdv/clientes-giga/copiar-para-loja` quando o cliente existe em outra loja | `page.tsx:~8991` |
| 73 | CpfNaNotaInput | Adiciona/corrige CPF depois de finalizada, antes de emitir NFC-e; salva sozinho aos 11 dígitos | `page.tsx:9518` |

### Finalização
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 74 | Guard síncrono anti-duplo-clique | `finalizingRef` muda antes do render — cobre auto-finalize (80ms) + clique manual | `page.tsx:2096-2104` |
| 75 | Anti-race de pagamentos | Refetch da venda antes de acusar "sem forma de pagamento" | `page.tsx:2108-2126` |
| 76 | ⚠️ Exceção TROCA PAR total zero | Total 0 finaliza sem payment; sem isso a vendedora ficava em loop | `page.tsx:2127-2135`, `pdv.service.ts:~3663` |
| 77 | Overlay "Aguarde, estamos finalizando" | Tela cheia z-[90] com "Não feche a tela nem clique de novo" | `page.tsx:~3634` |
| 78 | Banner FIXO de erro do finalize | Toast some rápido; o banner fica até a próxima tentativa | `page.tsx:~3432` |
| 79 | Botão FINALIZAR direto | Aparece só quando já 100% pago (vale-troca cobriu tudo) ou troca par zero | `page.tsx:~3461` |
| 80 | Cancelar com MOTIVO | 4 botões: cliente desistiu / errei a venda / trocou o pagamento / cliente volta depois | `page.tsx:~3653-3690` |
| 81 | ⚠️ Por que existe o motivo | 564 vendas COM PEÇA canceladas em 30d, R$ 543 mil, todas com o mesmo texto genérico | `page.tsx:2025-2033` |
| 82 | Carrinho vazio não pergunta | Cancela direto com motivo "Carrinho vazio" | `page.tsx:2036-2040` |
| 83 | "Pausar" (fechar depois) | Deixa a venda OPEN e limpa a tela; a próxima nasce no próximo bipe | `page.tsx:1742-1750` |
| 84 | Lista de Pausadas | `OpenSalesModal` — retoma ou cancela vendas open da loja | `page.tsx:10520` |
| 85 | ⚠️ Contagem de Pausadas ignora fantasmas | Não conta a venda atual nem vendas com carrinho vazio | `page.tsx:1811-1814` |
| 86 | Retomada da venda ao abrir | Prioridade 1 = venda puxada de /marcados; prioridade 2 = `lurds_pdv_sale_<loja>` | `page.tsx:1231-1293` |
| 87 | ⚠️ GATE de caixa aberto | Finalize exige sessão de caixa; se a venda foi criada antes, vincula agora (fallback pelo storeCode do JWT) | `pdv.service.ts:~3593-3630` |
| 88 | ⚠️ Modo LEGADO removido | `paymentMethod` no body não cria mais pagamento; split via `POST /payments` é a única fonte da verdade | `pdv.service.ts:~3645` |
| 89 | Finalize idempotente | Venda já `finalized` retorna OK sem refazer nada | `pdv.service.ts:~3563` |
| 90 | ⚠️ Loja forçada pra role=store | `storeCode` do JWT ignora `localStorage` — senão vendia pro estoque/caixa da loja errada | `page.tsx:1192-1228` |

---

## 2. PAGAMENTOS

### Formas e modal
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 91 | PaymentModal | ~4.150 linhas: split, PIX, link, crediário, convênio, venda online, frete, entrega | `page.tsx:5365` |
| 92 | 7 formas base | dinheiro, pix, debito, credito, crediario, venda_online (+ vale_troca e convenio via caminhos próprios) | `page.tsx:173-183` |
| 93 | Bandeiras débito | REDESHOP, VISA ELECTRON, ELO | `page.tsx:292` |
| 94 | Bandeiras crédito | MASTERCARD, VISANET, CIELO, HIPERCARD, AMEX | `page.tsx:293` |
| 95 | QuickCardBrandDock | Dock de bandeiras sob o carrinho (layout highlighted) com logo | `page.tsx:10696` |
| 96 | QuickSecondaryPaymentPanel | PIX / Dinheiro / Crediário / Vale-troca / Vale Presente / Marcar / Convênio / Venda Online | `page.tsx:10753` |
| 97 | Split de pagamentos | Múltiplas formas; após o 1º parcial o filtro vira `all` automaticamente | `page.tsx:~6899` |
| 98 | Barra de progresso colorida | Dourado eletrônicos, verde SÓ dinheiro, neutros o resto | `page.tsx:282-290` |
| 99 | Preset de método + bandeira | Atalhos da sidebar abrem o modal já na bandeira certa | `page.tsx:1157-1163`, `:2261-2272` |
| 100 | Auto-finalize forma única | 250ms após ficar 100% pago, exceto crediário (precisa da tela pra imprimir carnê) | `page.tsx:7370-7383` |
| 101 | Troco | ⚠️ Calculado sobre `restante`, não `total` (com vale-troca aplicado o troco era negativo) | `page.tsx:7386-7389` |
| 102 | Sincronização de payments ao abrir | Refetch da venda: sem isso o modal reaberto recobrava o total | `page.tsx:5423-5462` |
| 103 | `totalServidor` (ponte) | Total devolvido pelo POST de frete, usado antes do refetch do parent chegar | `page.tsx:5474-5476` |
| 104 | Auditoria de pagamento | `GET /pdv/sales/:id/payments/audits`, `PATCH .../payments/:id` | `pdv.controller.ts:1173`, `:1143` |
| 105 | Remover pagamento | `DELETE /pdv/sales/:id/payments/:paymentId` com confirmação | `page.tsx:6948` |
| 106 | Editar bandeira depois | `PATCH /pdv/caixa/payments/:paymentId/bandeira` | `cash.controller.ts:712` |

### PIX
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 107 | ⚠️ 3 providers em cascata | PagBank → Pagar.me → PIX local (chave celular); config por loja em `/stores/by-code/:c/pix-provider` | `page.tsx:6964-7116` |
| 108 | ⚠️ Modo `externo` | Franquia sem gateway: PIX vira só "informar pagamento", pula QR e webhook inteiros | `page.tsx:6178-6185`, `:6969` |
| 109 | Auto-gerar QR ao abrir | Modal aberto já em PIX gera o QR sozinho (espera `pixProviderReady`) | `page.tsx:7118-7136` |
| 110 | ⚠️ Regeneração automática do QR | Alterou "quanto cobrar" → 900ms de debounce e regera (substituiu o botão "Regerar", que ninguém clicava) | `page.tsx:7138-7163` |
| 111 | ⚠️ Polling 2-em-1 | Status local a cada 1s + `POST /pix/check` no gateway a cada 3 ticks; guard `inFlight` contra flood | `page.tsx:7165-7249` |
| 112 | PIX falhou/cancelado | Toast e descarte do QR — não deixa finalizar no escuro | `page.tsx:7197-7208` |
| 113 | ⚠️ Trava de finalize PIX | Com provider gateway exige `pixPaid=true`; provider local aceita confirmação manual | `page.tsx:6694-6714` |
| 114 | Auto-fluxo PIX | Webhook confirma → adiciona pagamento (400ms) → finaliza → imprime cupom | `page.tsx:7298-7329` |
| 115 | Expiração 15min balcão | `expiresInMinutes: 15` no PIX presencial | `page.tsx:6998` |
| 116 | ⚠️ Expiração 60min venda online | A cliente não está no balcão pra pagar em 15min | `page.tsx:6350-6351` |
| 117 | ⚠️ `origem: 'venda_online'` na cobrança | Marca a cobrança pro reconciliador abrir separação e não fechar como PIX de balcão | `page.tsx:6352-6357` |
| 118 | shortUrl `/qr/<token>` | Link público pro WhatsApp — o copia-e-cola cru virava link azul e a cliente tocava em vez de copiar (caso Itanhaém 21/08) | `page.tsx:6228-6235` |
| 119 | Poll do PIX online (4s) | Só no status LOCAL; quem pergunta ao PagBank é o reconciliador do servidor | `page.tsx:6242-6277` |
| 120 | Copia-e-cola | Botão de copiar payload com feedback de 2s | `page.tsx:7287-7296` |
| 121 | PixAvulsoModal | Cobrança PIX solta (valor livre), registra como payment e auto-finaliza se cobrir o total | `page.tsx:10982`, `:~4215` |
| 122 | ⚠️ Guard "venda perdida" | PIX pago e a venda não existe mais: "NÃO cobre de novo, avise a matriz, veja em PIX órfãos" | `page.tsx:6931-6940` |
| 123 | PIX órfãos (admin) | `GET /pdv/pix-orfaos?dias=` — janela 1-90d, default 30 | `pdv.controller.ts:251-256` |
| 124 | Reconciliador PagBank | Cron 30s fecha a venda quando o PIX cai, mesmo com o PDV desligado | `pix-pagbank-reconcile.service.ts:64` |
| 125 | PIX service local | Gera BRCode com `PIX_DEFAULT_KEY`/`_NAME`/`_CITY` | `pix.service.ts`, `pdv.controller.ts:1210` |

### Link Pagar.me
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 126 | Geração do link | `POST /pagarme/checkout` com e-mail e telefone reais (antifraude pontua isso) | `page.tsx:6439-6457` |
| 127 | ⚠️ Contador de tentativas | 1ª tentativa aprova 69%, 2ª 35%, da 3ª em diante ZERO (0 de 21) — avisa antes de queimar mais uma | `page.tsx:6458-6469` |
| 128 | Validação de e-mail/telefone | Regex + 10/11 dígitos antes de gerar | `page.tsx:6456-6457` |
| 129 | Polling do link (3s) | Reusa `/pagarme/pix/status/:saleId`; intervalo maior porque o cliente leva minutos | `page.tsx:7251-7285` |
| 130 | Trava de finalize do link | Exige link gerado E pago confirmado por webhook | `page.tsx:6658-6676` |
| 131 | shortUrl `/pg/<token>` | Link curto próprio pro envio | `page.tsx:6442-6443` |
| 132 | Scroll automático | O botão "Gerar Link" ficava atrás do footer — scrollIntoView ao escolher o tipo | `page.tsx:6471-6478` |
| 133 | Reconciliador Pagar.me | Cron 30s + janela 72h (venda paga sábado à noite) — antes ficava aberta pra sempre | `pagarme-link-reconcile.service.ts:34`, `:66` |

### Lista de cobranças online pendentes
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 134 | Widget "Cobranças" no header | Pisca VERDE com pago, ÂMBAR com vencido, branco com aguardando | `page.tsx:~2521` |
| 135 | ⚠️ Junta PIX + Link | Era só Pagar.me; o PIX mora em `pagbank_payments` e não aparecia em tela nenhuma — 12 vendas penduradas, R$ 3.840,21, a mais velha de 18/08 | `page.tsx:1757-1793`, `cobrancas-online.service.ts:28` |
| 136 | ⚠️ Janela de 7 dias | `COBRANCAS_ONLINE_DIAS` — corte curto (48h/96h) escondia venda parada de 7 dias | `cobrancas-online.service.ts:100-101` |
| 137 | Polling 15s + alerta sonoro | WebAudio 880Hz→1320Hz, `notifiedPaidRef` impede tocar 2x | `page.tsx:1824-1870` |
| 138 | 3 situações | `pago` / `aguardando` / `venceu`, em palavra de gente | `page.tsx:1781` |
| 139 | Ação FINALIZAR | Cria payment `venda_online` + finalize; ⚠️ `tipo` segue o meio real (`pix_gerar` vs `pagarme_link`) | `page.tsx:~3896-3925` |
| 140 | Ação Conferir agora | `POST /{pagbank\|pagarme}/pix/check/:orderId` — rota certa por meio | `page.tsx:~3966` |
| 141 | Ação Cobrar de novo | Gera PIX do RESTANTE (não do total) e abre o WhatsApp com o link | `page.tsx:~3995` |
| 142 | Copiar / WhatsApp / Reabrir / Cancelar (✕) | 4 ações complementares; nada sai da lista sozinho | `page.tsx:~4038-4102` |
| 143 | Contador "Nª cobrança" | Mostra quantas cobranças já saíram nessa venda | `page.tsx:~3862` |
| 144 | ⚠️ Erro de cadastro incompleto | Mensagem diferenciada: "Retome em Pausadas e complete antes de finalizar" | `page.tsx:~3939` |

### Crediário na venda
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 145 | Busca do cliente no Giga | `GET /pdv/customer-info` com escopo de loja + fallback por nome/telefone | `page.tsx:6094-6114`, `pdv.controller.ts:1306` |
| 146 | ⚠️ Escopo por loja | Código de cliente do Wincred se repete entre lojas — crediário é separado por loja | `page.tsx:6101-6104` |
| 147 | Banner de inadimplência | Pendências, total devido, total em atraso, qtd atrasadas | `page.tsx:6073-6086` |
| 148 | ⚠️ Giga fora ≠ cliente inexistente | `gigaError` mostra banner âmbar com "Tentar de novo" em vez de acusar cadastro faltando | `page.tsx:~8956` |
| 149 | Cliente de outra loja | Banner com botão de copiar a ficha pra loja da venda | `page.tsx:6084-6085` |
| 150 | Entrada do crediário | ⚠️ Vira 2 payments: entrada como `dinheiro` (caixa físico) + restante como `crediario` | `page.tsx:6791-6838` |
| 151 | Primeiro vencimento | Default D+30, editável | `page.tsx:5534-5538` |
| 152 | Observação livre | Ex: "Vendedora Manu · cliente confiança" | `page.tsx:5539` |
| 153 | Parcelamento com ajuste na última | `calcularParcelas`: iguais = round(total/n), última absorve a diferença | `page.tsx:377-385` |
| 154 | Criação das parcelas | `POST /pdv/sales/:id/crediario` grava N linhas, idempotente por controle | `pdv.controller.ts:2274` |
| 155 | ⚠️ Override de limite de crédito | 403 "limite de crédito" → senha de SUPERVISOR e reenvia com `overridePassword` | `page.tsx:390-411` |
| 156 | Falha no Giga não perde o pagamento | Toast "Pagamento registrado, mas FALHOU criar parcelas" — o payment fica no PDV | `page.tsx:6858-6866` |
| 157 | ⚠️ `primeiroVencimento` nos details | Sem isso o PDF de promissória caía no fallback D+30 | `page.tsx:6727-6737` |
| 158 | Crediários órfãos | `GET /pdv/sales/crediario-orfaos?dias=` (1-60, default 10) | `pdv.controller.ts:2509-2512` |
| 159 | Crediário nativo | Módulo `CrediarioNativoModule` como alternativa ao Wincred | `pdv.module.ts:4` |

### Convênio (sindicato)
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 160 | ⚠️ Forma condicional | Só aparece se a loja tem convênio ativo (`GET /pdv/convenio/ativo?storeCode=`) | `page.tsx:5514-5519`, `:1078-1091` |
| 161 | Busca de associado | `GET /pdv/convenio/:id/membros?q=` com debounce 300ms | `page.tsx:5520-5528` |
| 162 | ⚠️ Limite só trava se cadastrado | `limiteCents > 0` valida `disponivelCents`; sem limite = conferência online no sindicato | `page.tsx:6518-6523` |
| 163 | Associado digitado na hora | "➕ Usar NOME — conferido online no sindicato" cria/acha no backend | `page.tsx:~8931` |

### Vale-troca / vale presente
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 164 | ValeTrocaModal | Bipa TROCA-XXXXX, valida saldo/validade/status, aplica como payment parcial | `ValeTrocaModal.tsx:1` |
| 165 | ⚠️ Vale-troca NÃO faz auto-flow | Diferente do PIX: a cliente está no balcão, precisa ver a tela de finalizada | `page.tsx:~4272` |
| 166 | Gerar vale do saldo residual | Vale > total → ajusta o vale atual pro total e gera novo vale (90 dias) + imprime | `page.tsx:~3487-3538`, `returns.service.ts:1202` |
| 167 | GiftVoucherModal | Vende vale presente de valor livre; código `VP-` sai no cupom | `page.tsx:12022`, `pdv.controller.ts:967` |
| 168 | ⚠️ Vale presente ativa no finalize | Criado como `pending`; só vale depois da venda fechar | `pdv.service.ts:~3832` |
| 169 | Certificado imprimível | `/minha-loja/pdv/vale-presente/<code>` — marca, valor, código, QR, validade | `vale-presente/[code]/page.tsx` |
| 170 | ⚠️ Vale-troca no cupom = DESCONTO | Espelha o XML: total da nota = `sale.total − vale`; sem isso saía "VALOR TOTAL R$ 1.429 / MULTIPLO" | `page.tsx:~9992-10006` |

---

## 3. PÓS-VENDA

### Devoluções e trocas
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 171 | Tela de devolução | Bipa SKU/REF → itens da venda → marca peças/qtd → modo → confirma | `devolucao/page.tsx:1` (1.893 linhas) |
| 172 | ⚠️ Busca por NFC-e REMOVIDA | 04/07 — as lojas não usam e atrapalhava a triagem do bipe | `devolucao/page.tsx:5-7` |
| 173 | 3 modos | Dinheiro / Troca / Vale-troca | `devolucao/page.tsx:~10` |
| 174 | ⚠️ Anexar troca à venda em curso | F4/menu grava `lurds_pdv_attach_to_sale_id` — a troca entra NA venda aberta | `page.tsx:1483-1490` |
| 175 | ⚠️ Janela de lookup 90 dias | `lookupSalesBySku` cobre devolução de venda do mês passado + | `returns.service.ts:186`, `:252` |
| 176 | ⚠️ Validade do crédito | Modo `troca` = 1 dia; modo `credito` = 90 dias (configurável) | `returns.service.ts:698` |
| 177 | Devolução manual | Peça sem venda no Flow: consulta histórico no Giga (loja específica, ⚠️ janela 60 dias) | `returns.service.ts:1622`, `returns.controller.ts:104` |
| 178 | Devolução em lote | `POST /pdv/devolucao/batch` | `returns.controller.ts:225` |
| 179 | Sangria automática | Devolução em dinheiro registra sangria no caixa | `devolucao/page.tsx:~13` |
| 180 | Estorno de estoque | `increaseStock`; status/retry em `/pdv/admin/returns-stock-status` e `.../retry` | `returns.service.ts:1385`, `:1471` |
| 181 | Consulta pública do vale | `GET /public/vale/:code` — cliente confere saldo sem login | `returns-public.controller.ts:24` |
| 182 | Recibo de devolução | ⚠️ Sempre 2 vias: 1ª CAIXA (assinada), 2ª CLIENTE | `recibo-devolucao/[returnId]/page.tsx` |
| 183 | Lista de créditos | `GET /pdv/devolucao/creditos` com filtros | `returns.controller.ts:302` |

### Marcados (provar em casa)
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 184 | Botão Marcar na venda | Exige CPF + carrinho com peças; confirmação com total | `page.tsx:~3363-3428` |
| 185 | ⚠️ Só cliente classe A com limite | Validação no Giga; sem Avaliação A a ficha é recusada | `page.tsx:~3377`, `marcados.service.ts:109` |
| 186 | ⚠️ Override de limite estourado | Casa a FRASE exata "maior que limite disponível" — "em marca" batia com "podem marcar" e escondia o erro real | `page.tsx:~3400-3405` |
| 187 | ⚠️ Marcados 100% Flow desde 07/08 | "Nunca marque ou puxe nada do Giga" — nasce e morre no Postgres | `marcados-mirror.service.ts:5-22` |
| 188 | MarcarComponent no PaymentModal | Aparece com cliente identificado e sem pagamentos; mostra limite e o botão | `page.tsx:9674` |
| 189 | Tela de marcados | Identifica cliente → lista ativos → marca as que voltaram → processa devolução | `marcados/page.tsx:1` |
| 190 | Puxar pra venda | `POST /pdv/marcados/puxar-pra-venda` grava `lurds_pdv_retomar_sale_id` e o PDV retoma | `marcados.controller.ts:271`, `page.tsx:1239-1263` |
| 191 | ⚠️ Preço congelado do marcado | Item puxado vem com preço original — daí o botão "Recalcular preços (promoção)" | `page.tsx:1716-1718` |
| 192 | Dedup / desduplicar | `POST /pdv/marcados/dedup` e `/desduplicar` — marcações antigas nunca baixadas estouram o limite | `marcados.controller.ts:97`, `:125` |
| 193 | Reconciliar puxados órfãos | `POST /pdv/marcados/reconciliar-presos` | `marcados.controller.ts:79` |
| 194 | Restos do Giga | Leitura PURA de `caixa WHERE MARCADO='SIM'` — referência, nunca grava | `marcados-mirror.service.ts:11-14` |
| 195 | Diagnóstico de identidade | Investiga atribuição errada de cliente (caso Daiana 07/08) | `marcados.controller.ts:56`, `:68` |
| 196 | ⚠️ `promoTag='MARCADO'` | Item marcado não entra na baixa de estoque do finalize (já foi tratado) | `pdv.service.ts:4284-4299` |
| 197 | `MARCADOS_NATIVE_READS` | Kill-switch de leitura nativa | `marcados.service.ts:52` |

### Reimpressão
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 198 | Cupom não fiscal | `/minha-loja/pdv/recibo/[saleId]?autoprint=1`, 72mm útil, monospace, auto-print | `recibo/[saleId]/page.tsx` |
| 199 | DANFE NFC-e | `/minha-loja/pdv/nfce/[saleId]` — reimpressão com QR SEFAZ e protocolo | `nfce/[saleId]/page.tsx` |
| 200 | Vale-troca | `/minha-loja/pdv/vale-troca/[code]` — código gigante em mono | `vale-troca/[code]/page.tsx` |
| 201 | Cupom de sangria | ⚠️ Lê tudo de query params pra evitar race com iframe oculto | `caixa/sangria/[id]/page.tsx` |
| 202 | Recibo de baixa de crediário | Com juros por parcela | `recebimentos/recibo/[baixaId]/page.tsx` |
| 203 | Extrato A4 do crediário | ⚠️ Juros calculados na DATA DE EMISSÃO; observação em coluna própria (layout aprovado 05/08) | `recebimentos/extrato/[codCliente]/page.tsx` |
| 204 | Carnê + promissórias | 3 PDFs: `credprint-pdf`, `promissorias-pdf`, `carne-pdf` | `pdv.controller.ts:2555`, `:2578`, `:2604` |
| 205 | Régua de calibração | `GET /pdv/regua-calibracao` — imprime em folha branca e sobrepõe na pré-impressa | `pdv.controller.ts:2628` |
| 206 | Coordenadas do carnê | `GET/PUT/DELETE /pdv/carne/coords` + `/pdv-diag/coords` | `carne-coords.controller.ts:10`, `pdv-diag.controller.ts:280` |
| 207 | PIX confirmados 24h | Reimprimir comprovante que não saiu na hora; auto-refresh 5s | `recebimentos-pix-confirmados/page.tsx` |
| 208 | Histórico de recebimentos + estorno | Estorno reverte `PAGO='N'` no Wincred + canceled no Postgres, razão obrigatória | `recebimentos/historico/page.tsx` |

### NFC-e
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 209 | Emissão | Botão EMITIR NFC-e na tela de finalizada | `page.tsx:~10226`, `pdv.controller.ts:552` |
| 210 | ⚠️ Janela de cancelamento 30min | Evento 110111; contador regressivo na tela | `page.tsx:9905-9909`, `nfce.service.ts:1338` |
| 211 | Cancelamento com motivo | `POST /pdv/sales/:id/nfce/cancel` | `pdv.controller.ts:563` |
| 212 | ⚠️ Dados do emitente vêm do XML | Extrai `<emit>` do XML — hardcoded usava CNPJ da matriz e razão "EIRELI" (extinto 2021) | `page.tsx:9921-9941` |
| 213 | ⚠️ QR SEFAZ do XML | Extrai `<qrCode><![CDATA[...]]>` — a URL montada no front era rejeitada | `page.tsx:9979-9983` |
| 214 | QR gerado 100% local | Lib `qrcode` inline; a CDN falhava na impressão silenciosa do Electron (Moema 21/07) | `page.tsx:50`, `:10008-10021` |
| 215 | Cupom 72mm | Papel 80mm tem área útil ~72mm — 78mm cortava valores | `page.tsx:10036-10039` |
| 216 | Tributos Lei 12.741 | Linha fixa com 9,96% (fonte IBPT) | `page.tsx:~10109` |
| 217 | ⚠️ Venda online pula NFC-e | Quando todas as payments são `venda_online` | `pdv.service.ts:~3711` |
| 218 | ⚠️ Troca par pula NFC-e | Todas `vale_troca`: a NFC-e original já cobriu o ICMS | `pdv.service.ts:~3717` |
| 219 | Config por loja | `GET/POST /pdv/nfce/config`, `/status`, `/test/:storeCode` | `pdv.controller.ts:581-613` |
| 220 | XML da nota | `GET /pdv/sales/:id/nfce/xml` | `pdv.controller.ts:668` |
| 221 | Tela de Notas | Lista, filtros, cancelar em 30min, reimprimir, totais | `notas/page.tsx` |
| 222 | Relatório fiscal + ZIP de XMLs | `GET /pdv/relatorio-fiscal` e `/xmls.zip` | `fiscal-report.controller.ts:30`, `:94` |
| 223 | Retries e timeout SEFAZ | `NFCE_SEFAZ_RETRIES`, `NFCE_SEFAZ_TIMEOUT_MS`, `NFCE_IBSCBS` | `nfce-sefaz.ts` |

---

## 4. CAIXA

| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 224 | Tela de caixa (F3) | Sem sessão → abertura com fundo de troco; com sessão → KPIs + ações | `caixa/page.tsx:1` (1.590 linhas) |
| 225 | Abertura | `POST /pdv/caixa/abrir` com fundo de troco | `cash.controller.ts:79` |
| 226 | Sessão atual | `GET /pdv/caixa/atual` | `cash.controller.ts:65` |
| 227 | Sangria | Imprime cupom com espaço de assinatura | `cash.controller.ts:116` |
| 228 | ⚠️ Adiantamento pra funcionária | Só na sangria: busca a funcionária e gera o adiantamento | `caixa/page.tsx:1202-1213`, `cash.controller.ts:110` |
| 229 | Suprimento | Reforço de troco | `cash.controller.ts:164` |
| 230 | Relatório X | `GET /pdv/caixa/relatorio-x` | `cash.controller.ts:194` |
| 231 | Relatório detalhado | Base da tela de fechamento | `cash.controller.ts:205` |
| 232 | Fechamento | `POST /pdv/caixa/fechar` | `cash.controller.ts:216` |
| 233 | ⚠️ Sangria automática no fechamento | `registrarSangriaFechamento` (contagem da manhã = fechamento da noite anterior) | `cash.service.ts:1437` |
| 234 | Tela de fechamento diário | Cards Dinheiro/PIX/Crediário + cartões por bandeira + total do dia + imprimir | `fechamento/page.tsx:1` |
| 235 | ⚠️ Auto-close de sessões expiradas | `POST /pdv/caixa/admin/auto-close-expired` | `cash.controller.ts:251` |
| 236 | Pendências e forçar fechar | `GET /pdv/caixa/pendencias`, `POST /pdv/caixa/forcar-fechar` | `cash.controller.ts:264`, `:276` |
| 237 | Vendas open na sessão | O que bloqueia o fechamento | `cash.service.ts:2733` |
| 238 | Super-painel de caixas | Visão da rede + histórico | `cash.controller.ts:338`, `:357` |
| 239 | Check/uncheck de sessões | Conferência da matriz | `cash.controller.ts:393`, `:417` |
| 240 | Modo MASTER | Ajustar fundo, movimentos, payment, vendedora da venda/item | `cash.controller.ts:503-712` |
| 241 | Trilha de auditoria | `recordAudit` + `GET /pdv/caixa/master/audit` | `cash.service.ts:1730`, `:1770` |
| 242 | ⚠️ Crediário em dinheiro entra no físico | Baixa recebida em dinheiro na janela da sessão conta no caixa | `cash.service.ts:132` |
| 243 | ⚠️ Venda online não conta no físico | O dinheiro já caiu na conta | `cash.service.ts:263` |
| 244 | Régua oficial de faturamento | `blocoFaturamento` + `ajustesFaturamentoPorLoja` | `cash.service.ts:470`, `:648` |
| 245 | Widget "Resumo da Loja" | Peças vendidas hoje, devolvidas, líquido, estoque, ranking por vendedora | `page.tsx:10789`, `store-summary.controller.ts:42` |
| 246 | ⚠️ Resumo não faz polling | Atualiza só ao abrir ou clicar | `page.tsx:~10967` |
| 247 | Produtos vendidos do turno | Vendas + trocas (negativo) pra conciliação | `produtos-vendidos/page.tsx` |
| 248 | Stats do dia | `GET /pdv/stats/today` | `pdv.controller.ts:626` |
| 249 | ⚠️ Metas (WIP de 29/08) | Meta do mês = mesmo mês do ano anterior ÷ vendedoras ÷ dias; ranking da rede. Em construção por outra sessão | `page.tsx:2503`, `metas.service.ts` |

---

## 5. RECURSOS TRANSVERSAIS

### Modo treinamento
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 250 | Botão de entrada | Senha em `POST /pdv/training/validate`, liga `sessionStorage` e recarrega | `TrainingModeButton.tsx:14` |
| 251 | Banner global | Faixa permanente enquanto ativo | `TrainingModeBanner.tsx` |
| 252 | Header `x-training-mode: 1` | Em TODAS as chamadas da sessão de treino | `lib/api.ts` |
| 253 | ⚠️ 4 env vars aceitas | `TREINAMENTO_PASSWORD`/`SENHA_DE_TREINAMENTO`/`SENHA_TREINAMENTO`/`TRAINING_PASSWORD`; nenhuma = desligado | `training.util.ts:31-45` |
| 254 | ⚠️ Guard de retomada | Venda real + sessão treino (ou vice-versa) = abandona a venda. Era a brecha do treino baixar estoque REAL | `page.tsx:1270-1288` |
| 255 | ⚠️ Trava no finalize | União de sinais (flag OU header) + marcação retroativa | `pdv.controller.ts:1111-1115` |
| 256 | Regra ouro | Em treino: estoque, Giga, NFC-e, cashback e WooCommerce pulados | `training.util.ts:11-13` |

### Socket / realtime / heartbeat
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 257 | StorePickOrderAlert | Modal proeminente + som em loop quando entra pedido do site | `page.tsx:934`, `StorePickOrderAlert.tsx:1` |
| 258 | WebSocket `pick-order:new` | Sala `store:<storeId>`; `pick-order:removed` retira | `StorePickOrderAlert.tsx:355-372` |
| 259 | ⚠️ Polling fallback 20s | Redundância pra não perder pedido se o socket falhar | `StorePickOrderAlert.tsx:378-390` |
| 260 | Persistência de pendentes | `localStorage` sobrevive a reload | `StorePickOrderAlert.tsx:217-226` |
| 261 | Preferência de som | AudioContext desbloqueado no 1º clique | `StorePickOrderAlert.tsx:243-254` |
| 262 | ⚠️ Heartbeat de IP (ponto) | `POST /ponto/pdv-heartbeat` a cada 5min grava o IP da loja; celular no mesmo WiFi bate ponto | `PdvIpHeartbeat.tsx:27-52` |
| 263 | ⚠️ Só no Electron | Impersonação de admin no navegador faria o IP da MATRIZ virar "WiFi da loja" | `PdvIpHeartbeat.tsx:48` |
| 264 | ⚠️ Fetch cru (não `api()`) | 401 em background não pode disparar o redirect de sessão expirada | `PdvIpHeartbeat.tsx:16-18` |
| 265 | Badge de conexão | Evento global `flowops:connection` de toda chamada `api()` | `page.tsx:838-858` |
| 266 | Badges de operação | Polling 30s de `/pick-orders/mine` e `/realignment/mine` | `page.tsx:1876-1892` |
| 267 | HeaderClock | "Caixa aberto · HH:MM", atualiza a cada 30s | `page.tsx:818` |

### Multi-PC
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 268 | ⚠️ Sem adoção de venda órfã | Cada PC sempre cria venda nova (bug Sorocaba jun/26) | `page.tsx:1325-1340` |
| 269 | ⚠️ Venda por PC no localStorage | `lurds_pdv_sale_<storeCode>` amarra a venda ao computador | `page.tsx:1266`, `:1349` |
| 270 | ⚠️ `ensureSaleIdRef` compartilha a promessa | Dois bipes rápidos não abrem duas vendas | `page.tsx:1308-1323` |
| 271 | Fila serial no ScanBar | `saleIdRef` só limpa com a fila vazia | `page.tsx:499-505` |
| 272 | Reconhecimento de venda já fechada | Reconciliador fechou primeiro → pula pro cupom em vez de duplicar | `page.tsx:6820-6836` |
| 273 | ⚠️ Rede de segurança "já fechada" | "Venda já finalized" → confere o estado real; o erro seco fazia bipar tudo de novo (estoque em dobro, Itanhaém 10/08) | `page.tsx:6897-6920` |
| 274 | Limpeza de vendas fantasma | `GET/POST /pdv/admin/cleanup-ghost-sales/*` | `pdv.controller.ts:2811`, `:2832` |
| 275 | Preferências por PC | Densidade, layout, tema, menu, impressoras — tudo `localStorage` | `page.tsx:269` etc. |

### Atalhos de teclado
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 276 | Listener global registrado 1x | Deps vazias + `kbdRef` reatribuído a cada render | `page.tsx:1400-1418` |
| 277 | F1 | Foca e seleciona o campo de bipagem | `page.tsx:1461` |
| 278 | F2 | Desconto na venda inteira | `page.tsx:1467` |
| 279 | F3 | Tela de Caixa | `page.tsx:1475` |
| 280 | F4 | Troca/Devolução (grava o anexo à venda antes de navegar) | `page.tsx:1481` |
| 281 | F6 | Identificar cliente ⚠️ (F5 evitado: reservado a reload) | `page.tsx:1492-1499` |
| 282 | F8 | Abrir pagamento (só com itens) | `page.tsx:1509` |
| 283 | F10 | Consultar produto (estoque/preço) | `page.tsx:1503` |
| 284 | F12 e `?` | Overlay de ajuda; `?` só fora de campo de texto | `page.tsx:1442`, `:1450` |
| 285 | Delete | Remove o ÚLTIMO item bipado; guard pra não roubar o Del de campos com conteúdo | `page.tsx:1521-1532` |
| 286 | Escape | Fecha modais em cascata (ordem definida) | `page.tsx:1432-1440` |
| 287 | Auto-focus universal | Tecla imprimível com nada focado → foco no bipe | `page.tsx:1542-1554` |
| 288 | Enter no PaymentModal | Adiciona pagamento OU finaliza (se 100% pago), passando pelo semáforo de lastro | `page.tsx:7343-7351` |
| 289 | 1-9 / 0 no PaymentModal | Parcelas 1×–9× / 10× (só crédito + bandeira, fora de input) | `page.tsx:7353-7358` |
| 290 | ShortcutsHelpModal | Lista os 7 atalhos principais | `page.tsx:12314` |
| 291 | `useSmartBackdropClose` | Só fecha se mousedown E click foram no backdrop | `page.tsx:72-84` |

### Impressão
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 292 | printer-router | 7 kinds: `cupom`, `nfce`, `vale`, `sangria`, `recibo_pix`, `carne`, `extrato_crediario` | `lib/printer-router.ts:25` |
| 293 | 2 perfis por PC | TÉRMICA 80mm e A4 LASER; config em `localStorage` | `lib/printer-router.ts:46` |
| 294 | Silent print no Electron | `electronAPI.silentPrintUrl` sem diálogo | `page.tsx:9869-9877` |
| 295 | ⚠️ `printViaHiddenIframe` | Iframe 300×600 fora da tela + fallback popup 4s + cleanup 30s | `page.tsx:321-362` |
| 296 | ⚠️ Auto-print PIX e DINHEIRO | Só essas duas formas imprimem cupom automático (removido 23/07 e restaurado no mesmo dia) | `page.tsx:2205-2226` |
| 297 | ⚠️ Tela de finalizada sempre aparece | O auto-flow do PIX pulava a tela e escondia o EMITIR NFC-e | `page.tsx:2194-2199` |
| 298 | Carnê → A4 | Troca a impressora pro perfil A4 antes do silent print | `page.tsx:9866-9877` |
| 299 | Rodapé de status | Conexão + impressora + ambiente + seletor de densidade | `page.tsx:869-924` |

---

## 6. INTEGRAÇÕES QUE A TELA TOCA

| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 300 | ⚠️ WhatsApp via protocolo `whatsapp://` | Abre no APP logado do PC; `web.whatsapp.com` deixava 10 abas por turno | `lib/whatsapp.ts:1-27` |
| 301 | ⚠️ Escopo do protocolo | Botões internos; páginas PÚBLICAS usam `wa.me` | `lib/whatsapp.ts:23-27` |
| 302 | Normalização de telefone | Dígitos com DDI 55; sem telefone abre a lista de contatos | `lib/whatsapp.ts:30-34` |
| 303 | Evolution / WhatsappService | Alertas de conferência | `pdv.module.ts:20` |
| 304 | ⚠️ Alerta de conferência | Cron 12h: pedidos pagos 24h+ sem conferência → WhatsApp | `conferencia-vendas.service.ts:200-204` |
| 305 | ⚠️ Conferência de extrato PagBank | Cron 30min, status 3/4, janela 7 dias | `conferencia-extrato.service.ts:27` |
| 306 | Outbox do ERP | Venda finaliza só no Postgres e enfileira `kind='venda'` | `erp-outbox.service.ts:10-30` |
| 307 | ⚠️ 2 passos idempotentes | `caixaDoneAt` + `stockDoneAt` — retry nunca duplica | `erp-outbox.service.ts:15-22` |
| 308 | ⚠️ Backoff crescente | 30s → 1h (cap), 100 tentativas ~3 dias, lote 10, cron 30s | `erp-outbox.service.ts:36-40` |
| 309 | Kill-switch | `PDV_ERP_OUTBOX=0` volta inline | `erp-outbox.service.ts:29` |
| 310 | Painel do outbox | `GET /pdv/erp-outbox` + `POST /retry` | `pdv.controller.ts:293`, `:303` |
| 311 | Espelho Wincred | `giga_clientes` / `giga_caixa_mov` no Postgres | `pdv.module.ts:10` |
| 312 | ⚠️ Sync horário removido | Cron `40 * * * *` da caixa desligado 07/08 | `marcados-mirror.service.ts:17-22` |
| 313 | Réplica Giga | Guard `replicaGigaLigada` | `erp-outbox.service.ts:2` |
| 314 | Cache do Giga | `PDV_GIGA_CACHE`; clientes de recebimentos 30min | `recebimentos/page.tsx:~8` |
| 315 | ⚠️ Semáforo de LASTRO da rede | `POST /pdv/lastro-rede` — verde/amarelo/vermelho por SKU na rede + trânsito | `page.tsx:5612-5640`, `lastro-rede.service.ts` |
| 316 | ⚠️ Gate por ENTREGA, não por pagamento | O gate era `payments.some(venda_online)` e deixava de fora venda a distância paga de outro jeito (ON-000178) | `page.tsx:5685-5706` |
| 317 | ⚠️ Vermelho pede assinatura | "Vender mesmo assim" registra em `/pdv/lastro-rede/override`; amarelo passa | `page.tsx:5648-5683` |
| 318 | ⚠️ Checagem fora do ar não passa calada | Falha de rede pergunta explicitamente (27/08) | `page.tsx:5651-5667` |
| 319 | 3 gatilhos do semáforo | Escolha da entrega, retomada com entrega gravada, revalidação no fechar | `page.tsx:5750`, `:5439`, `:6685` |
| 320 | LastroRedeAviso | Componente visual do semáforo | `page.tsx:5324` |
| 321 | ⚠️ Trava de baixa dupla | Com Order de pedido online criado, o finalize NÃO baixa estoque aqui | `pdv.service.ts:~3855` |
| 322 | Reconciliação de estoque | `admin/reconcile-stock/*` + `reconcile-manual-stock/*` | `pdv.controller.ts:2726-2790` |
| 323 | ⚠️ Item MANUAL com SKU real baixa estoque | Filtro por `promoTag==='MANUAL'` pulava produto real com desconto (16/07) | `pdv.service.ts:4286-4306` |
| 324 | Índices no ERP | `GET /pdv/admin/erp-indexes` + create | `pdv.controller.ts:2851` |
| 325 | Cashback da rede | `creditarVenda` no finalize; nasce desligado | `pdv.service.ts:~3808` |
| 326 | WooCommerce | Fotos + trilho de pedido online | `pdv.module.ts:7` |
| 327 | Roteamento de pedido online | `PEDIDO_ONLINE_ROTEAMENTO`; `criarDoFinalize` monta o Order | `pdv.service.ts:~3846-3880` |
| 328 | ⚠️ 4 desfechos do pedido online | fechadoNaLoja / autoAtendida / lojaEscolhida / MATRIZ — cada um com toast próprio | `page.tsx:2149-2188` |
| 329 | Finalize assíncrono | `PDV_FINALIZE_ASYNC` (legado) | `pdv.service.ts` |

---

## 7. TUDO O QUE NÃO CABE ACIMA

### Fluxo guiado de Venda Online
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 330 | ⚠️ Máquina de 8 estados | `frete_tipo → frete_loja → frete_mao → frete_valor → confirma_total → pagamento → vendedora → fechando` | `page.tsx:5567-5578` |
| 331 | Por que existe | "Não quero um manual, quero que facilite" — o painel mostrava tudo junto e a vendedora tinha que saber a ordem de cabeça | `page.tsx:5556-5563` |
| 332 | ⚠️ Frete sugerido (medição 120 dias) | SEDEX SP = 9,99 · SEDEX fora = null · PAC = 19,99 · Motoboy = 20,00 · Retirada = 0 | `page.tsx:199-229` |
| 333 | Digitado da vendedora sempre ganha | `freteAutoRef` só sobrescreve o que a própria tela sugeriu | `page.tsx:5736-5741` |
| 334 | ⚠️ Frete digitado vs aplicado | `fretePendente` — digitar sem clicar deixava o QR sair sem frete (2ª cobrança) | `page.tsx:5545-5553` |
| 335 | Aplica sozinho antes do PIX | Se ela digitou, a intenção está clara | `page.tsx:6318-6329` |
| 336 | Frete vira linha `ref='FRETE'` | Excluída da contagem de peças e do lastro | `page.tsx:5445-5457` |
| 337 | ⚠️ "Quem atende" retirada/motoboy | A loja-canal 13/SITE não tem balcão nem moto; sem a pergunta o pedido nascia "retira NA LOJA 13" | `page.tsx:5742-5747` |
| 338 | ⚠️ Não grava antes de perguntar | O POST mandava `entregaStoreCode: null` e o servidor media a loja errada | `page.tsx:5752-5761` |
| 339 | ⚠️ Lista de lojas COM cobertura | `GET /pdv/sales/:id/lojas-entrega` — cobertas/total/faltam, cidade da cliente primeiro | `page.tsx:6003-6045` |
| 340 | ⚠️ "As peças já estão aqui?" | Só motoboy desta loja. SIM = pedido nasce fechado mesmo com estoque dizendo que falta (ON-000164) | `page.tsx:5989-6002` |
| 341 | ⚠️ Loja-canal não responde | Ausência na lista é o sinal; o backend recusa | `page.tsx:5790-5800` |
| 342 | ⚠️ Cobrança curta bloqueada | Valor menor que o restante é campo defasado — corrige e pede confirmação | `page.tsx:6546-6563` |
| 343 | ⚠️ Vendedora ANTES da cobrança | Quem fecha é o servidor com ela em outro atendimento: sem dona agora, sem dona nunca | `page.tsx:6300-6306` |
| 344 | ⚠️ `pix_gerar` exige PAGO | Antes bastava o código existir — fechava sem dinheiro (decisão do dono 12/08) | `page.tsx:6626-6657` |
| 345 | 4 caminhos do dinheiro | `pix_gerar` · `pix` (recebido) · `link` (externo) · `pagarme_link` | `page.tsx:215-220` |
| 346 | `ehJaPago()` | Só `pix` e `link` fecham na hora | `page.tsx:5847-5848` |
| 347 | Fechamento por efeito | `fecharQuandoPuderRef` espera o próximo render | `page.tsx:6421-6432` |
| 348 | Entrega regravada no finalize | O POST do botão é otimista; o finalize regrava e aguarda | `page.tsx:6602-6625` |

### Carrinhos abandonados
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 349 | Modal no PDV | Lista, busca, importa e monta a venda pronta | `page.tsx:11317`, `pdv.controller.ts:400` |
| 350 | ⚠️ Só 3 lojas | `CARRINHOS_STORE_CODES = ['13','15','01']` — as que atendem o WhatsApp do site | `page.tsx:267` |
| 351 | Por que está no PDV | O botão existia só na retaguarda; 7 carrinhos recuperados em 17/08, 2 registrados | `page.tsx:2698-2707` |
| 352 | Importar carrinho | `POST /pdv/sales/importar-carrinho` | `pdv.controller.ts:494` |
| 353 | "Eu já estou falando com ela" | `POST /carrinhos-abandonados/atendimento` no clique do WhatsApp | `pdv.controller.ts:438` |
| 354 | Desfecho com motivo | `/desfecho` + `/reabrir` + `GET /baixas`; "outro" exige texto | `pdv.controller.ts:420-454` |

### Widgets, modais e telas secundárias
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 355 | SimularParcelasModal | Parcela sobre o RESTANTE, não o total bruto | `page.tsx:11772` |
| 356 | Texto pronto pra WhatsApp | Clique copia a simulação formatada | `page.tsx:~11821` |
| 357 | ManualItemModal | Descrição + valor + qty livres | `page.tsx:12151` |
| 358 | PdvMobilePill | Barra em telas <lg com 8 atalhos e badges | `page.tsx:11195` |
| 359 | PdvToast + `humanizeError` | Toasts com tradução de erro técnico pra frase de balcão | `components/PdvToast.tsx` |
| 360 | `appPrompt` | Prompt customizado com `{password: true}` | `lib/app-prompt.ts` |
| 361 | `overlayClose` | Fechamento por backdrop compartilhado | `lib/overlayClose.ts` |
| 362 | Tela de recebimentos | Clientes → filtro local → cascata de parcelas → PIX/dinheiro → cupom | `recebimentos/page.tsx:1` (1.203 linhas) |
| 363 | Tela de consulta (F10) | `/minha-loja/consultar` — estoque, preço, foto, transferência | `page.tsx:1505` |
| 364 | Tela de realinhamento | `/minha-loja/realinhamento` com badge | `page.tsx:2719` |
| 365 | Conferência de vendas | `GET /pdv/conferencia-vendas` + `/conferir` | `pdv.controller.ts:314`, `:325` |
| 366 | Master: cancelar zumbi | `POST /pdv/sales/:id/master/cancel-zumbi` | `pdv.controller.ts:764` |
| 367 | Master: estornar | `POST /pdv/sales/:id/master/estornar` | `pdv.controller.ts:798` |
| 368 | Master: cancelar duplicada | `POST /pdv/sales/:id/master/cancel-duplicada` | `pdv.controller.ts:826` |
| 369 | `/pdv-diag` completo | columns, find, parcela, cliente, sale, coords, calibrar, baixa-retroativa | `pdv-diag.controller.ts:41-357` |
| 370 | Vendedoras ativas (CRUD) | GET/POST/DELETE/PUT bulk + sync-from-wincred | `active-sellers.controller.ts:42-102` |

### Easter eggs operacionais / detritos
| # | Item | O que faz | Arquivo:linha |
|---|---|---|---|
| 371 | 🟡 Bolinha amarela de teste | `title="Teste de deploy"` no header, "Remover depois de validar" — ainda lá | `page.tsx:~2450` |
| 372 | "Versão 1.0.0" hardcoded | Rodapé do menu lateral | `page.tsx:~2777` |
| 373 | Rodapé do cupom | "Obrigado pela preferência! / Volte sempre 💖" | `page.tsx:~10141` |
| 374 | `_id_deprecated` | Rota de recibo antiga ainda no repositório | `recebimentos/recibo/_id_deprecated/` |
| 375 | ⚠️ `nfce.service.ts` duplicado na raiz | Cópia de 29 KB na raiz do repo, fora de `backend/src` | raiz do repo |
| 376 | Fallback de razão social | `T.O. RISSUTTO LTDA` / `LURD'S PLUS SIZE` quando o XML não está disponível | `page.tsx:9937-9939` |
| 377 | ⚠️ `MetasModal` (WIP de outra sessão) | Referenciado em `page.tsx:3747` — feature Metas em construção em 29/08 | `page.tsx:3747` |
| 378 | Comentário de cópia paralela | Cabeçalho diz "Cópia paralela de /minha-loja/pdv" apontando pra si mesmo | `page.tsx:5-11` |

---

## Notas para o redesenho (do levantamento)

1. **`page.tsx` tem 32 componentes num arquivo só** — os 5 maiores (`PaymentModal` ~4.150 linhas, `PdvPageInner` ~3.360, `FinalizedModal` ~700, `CustomerModal` ~730, `CarrinhosAbandonadosModal` ~455) somam ~9.400 das 12.493 linhas.
2. **`pdv.service.ts` tem 236 KB e `pdv.controller.ts` 121 KB** — o controller carrega lógica de negócio pesada (busca de cliente são 670 linhas num handler).
3. **Regras duplicadas front↔back que precisam ficar sincronizadas**: régua de dados do cliente online (`lib/dados-cliente-online.ts` ↔ `common/dados-cliente-online.ts`), regra dos 50% (`applyAutoDiscounts` ↔ `consultarPromocao` — "se mudar lá, muda aqui" em `pdv.service.ts:178`), e `common/promo-julho.ts`.
4. **Muita regra é datada e nominal** (ON-000105, ON-000164, ON-000178, Moema 21/07, Sorocaba jun/26, Itanhaém 10/08) — cada uma corresponde a prejuízo real. Nenhuma sai sem confirmação do dono.
5. **Constantes hardcoded candidatas a config**: `CARRINHOS_STORE_CODES`, corte `2023-12-31`, sufixos `-INV`/`-VER`, valores de frete sugerido, expirações 15/60min, tributo 9,96%, janela 30min da NFC-e, janelas 90/60 dias de devolução.
