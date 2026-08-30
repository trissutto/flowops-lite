# Novo PDV — Briefing (doc vivo)

**Projeto:** reforma visual + hierarquia por uso do PDV de loja física (`frontend/src/app/minha-loja/pdv/`).
**Método:** briefing em etapas; cada etapa fecha decisões POR ESCRITO aqui, antes de qualquer código de produção. Decisão fechada não reabre sem fato novo.
**Status:** etapa 0 fechada (29/08/2026) · etapa 1 com inventário (378 itens) e medição de uso PRONTOS — falta a marcação FICA/MUDA/MORRE do dono · etapas 2–6 pendentes.

---

## Etapa 0 — Enquadramento (FECHADA 29/08/2026)

| Pergunta | Decisão do dono |
|---|---|
| O que é o "novo"? | Mudança de UX/visual da tela atual, em dois pilares: (1) **hierarquia por uso** — medir quais botões/operações são mais usados e dar mais visibilidade a eles; (2) aplicar a **identidade visual SEMÁFORO** |
| Dor nº 1 | **Salto visual** — qualidade percebida de outro nível |
| Plataforma | **PC da loja, como hoje** — mantém Electron, impressoras, heartbeat de IP do ponto |
| Consequência de escopo | Backend, endpoints e regras de venda **não mudam** nesta reforma. Muda apresentação, hierarquia e organização da tela |

### Direção de UX dada pelo dono (29/08, via screenshots do fluxo guiado)
"Um formato assim seria legal levar em consideração: **botões maiores, sequência em popups com instruções**." Referência: os passos "Como vai enviar?" / "Como a cliente vai pagar?" do fluxo guiado de Venda Online que JÁ existe no PDV (itens 330–348 do inventário) — nascido da diretriz "não quero um manual, quero que facilite a operação". Status: **direção a discutir na etapa 3, não é ordem de codar**. Tese de trabalho registrada: *trilho guiado (wizard) pro fluxo RARO ou cheio de regra; pista livre (zero passo extra) pro fluxo FREQUENTE — a medição de uso decide qual operação ganha qual tratamento.* Instruções curtas de consequência em cada passo ("a venda fecha sozinha quando o dinheiro cair") são parte do formato.

**Direção 3 (29/08, sobre a v3 — FIRMADA):** o TRILHO vale também pro CARTÃO — o painel inline foi rejeitado ("ficou ruim"). Crédito: **popup da bandeira → popup das parcelas 1×–12× em LINHAS com o valor de cada parcela, TODAS visíveis sem rolagem → popup de confirmação**. Débito: mesmo formato sem o passo de parcelas. **Bandeiras e PIX com logo** (assets oficiais na implementação; SVG evocativo na amostra — CSP do artifact bloqueia imagem externa), **cifrão no DINHEIRO**. Parcelamento sobe de 10× pra **12×** (mudança funcional a levar pra etapa 6). Tese revisada: a "pista livre" é só o BIPE; toda decisão de pagamento é trilho.

**Direção 2 (29/08, sobre a amostra v1):** (a) "todas as funções devem ser devidamente associadas à tela nova" → vira regra do projeto: o inventário ganha coluna **DESTINO** na etapa 3 (nada órfão); (b) "use amarelo, verde, laranja, azul etc. pra dar destaques" → o semáforo de 3 cores evolui pra **PALETA DE PAPÉIS** (cada cor com papel fixo, nunca decoração): vermelho=parado · âmbar=atenção · verde=ok/ganho · **azul (brand #2E75B6)=promoção/informação** · **dourado Lurd's (#B8912B)=campanha/marca** · **roxo (#6B4FA8)=venda online/trilho**. Dinheiro segue grafite. Tokens novos a formalizar no tailwind quando a etapa 4 fechar.

---

## O que JÁ existe e o projeto aproveita (levantado 29/08)

### 1. Identidade SEMÁFORO — escolhida pelo dono em 21/08/2026, já tokenizada
- [frontend/tailwind.config.ts](../../frontend/tailwind.config.ts): sistema **cinza e preto; cor é propriedade EXCLUSIVA do estado** — `crit` (parado), `warn` (a fazer), `ok` (em dia). Superfícies (`ground/surface/surface-2`), tinta (`ink/ink-soft/ink-faint`), fios (`line/line-soft`), ação em grafite (`action`).
- ⚠️ **Mudança de regra já decidida (21/08):** dinheiro DEIXA de ser verde — total/Finalizar viram `ink` (grafite, peso forte); verde passa a significar "em dia". A regra antiga "verde #2E7D46 só pra dinheiro" descreve o PDV ATUAL; na tela reformada vale o semáforo. Validar com as vendedoras no piloto (hábito visual forte).
- Primitivos prontos: `Button`, `Badge`, `Card`, `Table` em `frontend/src/components/ui/`.
- Regra de migração dos tokens é "por adição — a tela migra quando alguém já estiver mexendo nela". Reformar o PDV **é** mexer na tela: o PDV reformado nasce 100% em tokens, zero cor arbitrária inline nova.

### 2. `docs/ANALISE-PDV-MELHORIAS.md` (11/06/2026) — diagnóstico ainda válido na parte de UX
- Monólito: `page.tsx` com 10 mil+ linhas, 114 `useState`, re-render global a cada tecla, 5 pollings simultâneos (dois de 1s).
- Atalhos: F1–F10 existem; lacunas mapeadas (F8 finalizar, Del remove item, +/− quantidade, keymap DENTRO dos modais, overlay "?" com a lista, barra de atalhos fixa no rodapé).
- UX: total deve ser o elemento mais visível da tela; flash visual na bipagem (só há beep); recolher o que não é fluxo de venda.
- A parte de velocidade da Fase 1 já foi resolvida por outros caminhos (outbox da venda, leituras pelo espelho).

### 3. `.pdv-lab` (globals.css) — experimento anterior, direção diferente
Reskin bege/vinho por override de CSS escopado em classe. A direção visual foi superada pelo semáforo, mas a TÉCNICA (classe no root liga/desliga o visual inteiro) é candidata a kill-switch da reforma. Decidir na etapa 2 se aproveita ou remove.

---

## Decisões abertas — próximas etapas

### Etapa 1 — Inventário + medição de uso (MATERIAL PRONTO, aguarda marcação do dono)
- [x] **Inventário funcional**: 378 itens em [INVENTARIO-PDV-ATUAL.md](INVENTARIO-PDV-ATUAL.md) (29/08). `page.tsx` = 12.493 linhas / 32 componentes.
- [x] **Medição de uso em produção** (60 dias, sem treino — script `backend/scripts/q-pdv-uso-operacoes.js`):
  - **5.934 vendas** (98,9/dia, 16 lojas; loja 01 lidera com 19/dia) · 3,1 peças/venda · **2.456 canceladas** (~41/dia — o modal de motivo é fluxo FREQUENTE).
  - **Pagamentos**: crédito 2.667 (o rei) · débito 1.015 · venda_online 709 · PIX 702 · dinheiro **só 433 (7%)** · **vale-troca 413 (quase empata com dinheiro)** · crediário 269 · convênio 4. Split em 8,1% das vendas.
  - **Ciclo de TROCA é gigante**: 482 devoluções/trocas (8/dia) + 416 vales consumidos + 413 payments vale_troca → merece cidadania de 1ª classe no layout.
  - **Marcados muito vivos**: 12,8 puxados pra venda/dia + 8,9 criados/dia + 7,5 devolvidos/dia. (5.777 "baixados" em 60d = provável mutirão de limpeza, conferir antes de tratar como uso diário.)
  - **Crediário: o RECEBIMENTO (9,9 baixas/dia) é 2x mais frequente que a venda a crediário (4,4/dia)** — a tela de recebimentos pesa mais que o crediário do PaymentModal.
  - Caixa: 11,9 sessões/dia + 11,5 sangrias manuais/dia. Adiantamento (6), convênio (4-6) e ajuste master (8) são RAROS.
  - Cliente identificado em só **26,5%** das vendas (com cashback ativo — fricção ou oportunidade?).
  - Promo automática em **50,9% dos itens**; desconto POR ITEM (5.213) é muito mais usado que desconto no cabeçalho (670).
  - **Mortos na prática**: cupom por WhatsApp **0** e por e-mail **0** em 60 dias; FOUR_FOR_THREE sem botão na tela.
  - NFC-e: 96,6% tentada, mas o grosso fica em `preview` (4.039) vs `authorized` (924) e `skipped` (722) — funil a entender fora da reforma.
  - Pagar.me: 690 failed × 552 paid — confirma o aviso de tentativas (item 127).
- [ ] **Dono marca a shortlist FICA / MUDA / MORRE / v2** (lista curta levada no chat de 29/08; o resto do inventário é regra de carga que fica por padrão).

### Etapa 2 — Contrato de arquitetura da reforma
- [ ] Reskin POR CIMA do monólito × QUEBRAR o `page.tsx` em componentes enquanto aplica o semáforo. Recomendação preliminar: quebrar por região (bipagem, carrinho, pagamento, modais) — o monólito é a causa da lentidão de digitação; reformar o visual sem quebrar é pagar o custo duas vezes.
- [ ] Kill-switch da reforma: voltar o visual antigo por flag/loja? (técnica do `.pdv-lab`?)
- [ ] Reconfirmar: zero mudança de endpoint/comportamento; modo treinamento intocado.

### Etapa 3 — Fluxo e hierarquia
- [ ] Layout guiado pelo ranking de uso (dados da etapa 1).
- [ ] Atalhos de teclado (lista da análise de 11/06) — operação 100% teclado.
- [ ] O que sai da primeira dobra / vira painel colapsável.

### Etapa 4 — Telas
- [x] **Amostra visual v2 publicada (29/08):** https://claude.ai/code/artifact/8c2fc0a0-5f76-49e4-a254-8321abf70540 — cópia no repo em [amostra-pdv-semaforo.html](amostra-pdv-semaforo.html). v1 mostrou a base (total grafite, pagamentos por uso, troca na 1ª dobra, pendências em barra, trilho guiado em overlay). v2 incorporou o feedback do dono: **paleta de papéis** (azul promoção · dourado campanha · roxo online, além de crit/warn/ok), **campanha ativa em faixa dourada com "Trocar ▾"**, **desconto por peça na linha (% · ⬆ forçar · 🚫 tirar) e desconto da venda F2 com faixas de senha**, **menu lateral com badges**, **MARCAR no painel de pagamento**, e a seção **"Onde cada função mora"** (endereço de todas as 378 do inventário, em 6 grupos). Badge de promo virou AZUL (resolvido o ponto aberto da v1). 13 marcadores numerados.
- [ ] Reação do dono à v2 → iterar.
- [ ] Mockup completo (demais estados/fluxos) após etapas 2–3 fechadas.
- [ ] Validação de balcão (contraste, alvo de clique, legibilidade em pé — agente a11y-balcao).

### Etapa 5 — Migração
- **Ambiente de teste — pergunta do dono (29/08): "aplicar na loja Itu (encerrada) como sandbox, ou o Treinamento me traz tudo?"** Recomendação registrada: **Treinamento + toggle "Visual novo × atual" por PC**, sem reativar Itu. O treino já isola TUDO por construção (estoque, Giga, NFC-e, cashback, WooCommerce pulados; relatórios filtram `isTraining`) e funciona em qualquer loja/PC. Reativar Itu exigiria isolamento novo em routing/lastro da rede, outbox ERP, NFC-e e todos os relatórios — reimplementar o treinamento em nível de loja, sem ganho. Quando a tela nova existir (etapa 6), o teste é: ligar o toggle num PC + entrar em treino → opera tudo sem tocar nada real. ⏳ Aguarda confirmação do dono.
- [x] **Piloto REVISADO pelo dono (29/08, noite): TODAS as lojas, opt-in POR COMPUTADOR** — "testar visual agora em todas as lojas com possibilidade de reversão… os PDVs seguem iguais, só mudam se a loja escolher". (Substitui o recorte anterior Moema+Itanhaém.)
- [x] **INCREMENTO 1 NO AR (PR #1152, squash-merge 29/08 ~21h10):** botão **"✨ Testar visual novo"** no header do PDV → liga `.pdv-semaforo` (reskin CSS escopado, técnica do `.pdv-lab`): chrome bege/dourado → cinza/grafite; CTAs dourados → grafite; dourado reservado a faixas de campanha. Botão vira **"↩ REVERTER AGORA"** (volta na hora, sem tocar na venda aberta). Persistência por PC (`lurds_pdv_tema_semaforo`); ativar força modo claro e esconde o botão noturno. Zero mudança pra quem não clicar. Build verde (tipos + 226 páginas).
- [ ] Critério de rollback formal e convivência com telas não reformadas.

### Etapa 6 — Plano técnico (ABERTA em 29/08 por ordem do dono)
**Decisão do dono (29/08, noite): implementar "TUDO como está na amostra" nas lojas MOEMA (15) e ITANHAÉM (01), com botão "↩ REVERTER AGORA" na própria tela** (volta ao PDV atual naquele PC, na hora). Reforma completa não sobe de uma vez — vai por **incrementos entregáveis**, cada um atrás da flag por loja (storeCode 15/01) + reverter, testado em treino antes:
1. **Shell da tela nova**: flag por loja + botão REVERTER AGORA + header/menu lateral/rodapé em semáforo, com o miolo atual funcionando dentro (nada de fluxo muda ainda). Só frontend — deploy Vercel, sem restart de backend.
2. ✅ **Trilho do cartão NO AR (PR #1153, 29/08 ~21h37)**: com o piloto ativo, crédito/débito abrem bandeira (logos reais de `/bandeiras/`, 3+2) → parcelas 1–12× em linhas com o valor de cada → confirmação grande → REGISTRAR (Enter) → finalize normal. Cobra o restante; split sai pro PaymentModal levando a bandeira. Revisão do frontend-revisor aplicada (trilho conta como modal no teclado global; teclas de input passam reto; restante zero barrado). Sem o piloto, fluxo byte a byte igual. ⚠️ 12× é mudança funcional (era 10×).
3. ✅ **NO AR (PR #1154, 30/08 ~12h07)** — e foi aqui que o piloto passou a mudar a tela de verdade. **Causa do "não mudou nada" do dono**: o CSS do incremento 1 usava classe escapada e não pegava as variantes com opacidade (`border-[#CDA434]/70`), os `hover:` nem o dourado por `style` inline — medido no DOM, dourados indevidos 4 → 0 depois da correção. Entregue: **total em grafite grande** (46px, escalonando pra 38/30px em valores altos), **painel de pagamento na ordem do uso medido** (CRÉDITO 45% e DÉBITO 17% grandes, PIX, VENDA ONLINE em roxo; dinheiro/vale-troca/vale presente/marcar/crediário na faixa menor), **REF em chip**, bolinha residual "Teste de deploy" oculta, dock de bandeiras sai (as bandeiras vivem no trilho). Revisão adversarial de 16 agentes: 4 achados, 4 corrigidos (estouro do total ≥ R$ 10 mil; contraste 2,55:1 do rótulo; seta órfã do VENDA ONLINE; caminho duplicado do cartão).
4a. ✅ **MODAL DE PAGAMENTO NO AR (PR #1155, 30/08 ~12h36)** — pedido do dono ("melhore esta tela"). Dinheiro a cobrar em grafite (verde só em PAGO, âmbar no que falta), formas na ordem do uso medido com crédito/débito maiores (45px × 33px), seleção grafite, Venda Online em roxo, ações em grafite, "Fechar depois" neutro, e **correção do FINALIZAR que saía com dois checks** (vale nos dois caminhos). Revisão adversarial: 1 achado real corrigido — os dois estados do MESMO botão ficaram cinzas a 1,46:1 e o hover de "Adicionar" era a cor de repouso do "Finalizar" (o ponteiro invertia a hierarquia no clique que fecha a venda); agora 2,70:1 com anel no finalizar.
4b. **Carrinho novo**: REF em chip ✅, faltam ações por item (% ⬆ 🚫), desfazer, faixa de campanha dourada + Trocar ▾.
5. **Descontos**: F2 com faixas visíveis + desconto por peça (validação continua no servidor).
6. **Pendências em barra** (une pausadas com apelido + cobranças + pedidos site + realinhamento) + rodapé de status decomposto.
7. **Trilhos restantes** (dinheiro com troco, PIX, vale-troca, crediário, venda online reformada) + Metas chip + Carrinhos no menu.
Regras de execução: trabalhar em worktree/branch isolada (há WIP de outra sessão no working tree), assets oficiais de bandeiras/PIX no repo, socket push do pagamento entra no incremento 2-3 (contrato da etapa 2), revisor de frontend antes de cada merge, deploy fora de horário de loja quando tocar backend.

---

## Triagem da lista externa de 50 pontos (29/08 — gerada por outro chat, analisada contra código real)

**Veredicto do "alerta crítico" (pontos 1-3, polling de pagamento):** superdimensionado — a lista pattern-matchou com o incidente da live sem conhecer o contexto. O flood da live era N navegadores × N carrinhos × sem guard + Giga pendurado. O balcão hoje: **1 navegador, 1 QR ativo, guard `inFlight` construído citando a lição da live** (`page.tsx:7219-7221`), cleanup no unmount. Poll de 1s bate no status LOCAL (webhook grava); gateway só a cada 3s com QR na tela. Link Pagar.me (3s) e PIX venda online (4s) são 100% locais — quem fala com gateway é o reconciliador server-side. Exceção com substância: **PIX avulso** (1s local, mas o backend consulta a Pagar.me ao vivo enquanto pending — o mais pesado dos três). Mapa completo de intervalos: 30s relógio · 15s cobranças · 30s badges · 60s metas (WIP) · 1s/3s/4s pagamentos.
**Decisão registrada:** NÃO fazer hotfix de arrancar polling antes da reforma. Na etapa 2 entra como contrato: *confirmação de pagamento via socket push (infra de rooms já existe; a live usa `live-pdv:cart-paid`), poll local vira fallback lento, check de gateway só server-side*.

**Já existe no PDV atual** (a lista não conhecia o código): #5 (finalizingRef + overlay + banner fixo), #7 parcial (trava pixPaid + reconciliador + PIX órfãos), #16 (auto-focus universal), #18 parcial (flash verde + beep + thumb), #19 (Delete remove o último — falta botão visível), #28/31 (barra de progresso, restante, troco sobre restante), #33 parcial (expiração 15/60min sem contador visível), #37 (SimularParcelasModal), botão manual de conferência do #1 ("Conferir agora").

**Aceitos → etapa 2:** #4 máquina de estados do checkout (generalizar a da venda online) · #48 quebrar o arquivo (já era a recomendação) · #49 testes de jornada · **#50 métricas operacionais — instrumentar ANTES da reforma pra ter baseline** · socket push (acima).

**Aceitos → etapa 3 (fluxo):** #8 recuperação guiada "pagamento sem venda" (formato wizard do dono) · #10 rodapé de status decomposto · #11 três passos + revelação progressiva (= tese trilho × pista livre) · #14 cabeçalho enxuto · **#15 central de pendências (aplicar o padrão da fila da /minha-loja: barra fechada com contagem)** · #21-23 pausadas com apelido/idade/busca · #24 vendedora como pendência visível · #26 modificado (ordem dos métodos = USO MEDIDO, crédito primeiro) · #27 selecionar ≠ registrar · #32 pagamento manual registra responsável (padrão MasterAudit) · #36 drawer de comprovante · #38 Esc não fecha cobrança ativa.

**Aceitos → etapa 4 (mockup/visual):** #6, #18, #19 (botão desfazer), #20, #25, #29, #30, #31, #33 (contador), #35, #37 (grade de parcelas), e o **pacote a11y inteiro #39-47** — sai de graça na componentização com primitivos semáforo; #46 vira REGRA do design system: *cor nunca sozinha — sempre ícone + palavra* (o próprio semáforo exige).

**Coincidem com a shortlist já aberta:** #12 (um layout oficial — nuance: o toggle vira kill-switch DURANTE o piloto e morre depois) · #13 (= item 3 da shortlist, modo noturno).

**Rejeitados com motivo:** **#9** (expor "sincronização ERP pendente" à vendedora — ela não tem ação a tomar; outbox é infra invisível de propósito com retry de ~3 dias e painel admin próprio; no máximo linha agregada no rodapé admin) · **#34 como proposto** (voltar regeneração manual do QR regride decisão consciente — o botão "Regerar" ninguém clicava e o cliente pagava o valor antigo; manter auto-regen + aviso visual "cobrança atualizada").

## Registro de sessões
- **29/08/2026** — Etapa 0 fechada (natureza, dor, plataforma). Inventário funcional disparado. Achados: tokens semáforo prontos (21/08), análise de junho reaproveitável, `.pdv-lab` identificado como experimento anterior.
- **29/08/2026 (noite)** — Inventário entregue (378 itens). Medição de uso 60d rodada em produção. Dono deu direção de UX: botões grandes + sequência de popups com instrução (formato do fluxo guiado existente) — registrada como tese "trilho × pista livre" pra etapa 3. Nota: outra sessão trabalha em paralelo no repo (Metas/gamificação + lote 3 da separação); push do briefing adiado pra não empilhar restart do backend em horário de loja.
