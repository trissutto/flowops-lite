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
- [ ] Mockup clicável da tela principal em semáforo ANTES de código de produção; dono clica e reage.
- [ ] Validação de balcão (contraste, alvo de clique, legibilidade em pé — agente a11y-balcao).

### Etapa 5 — Migração
- [ ] Loja piloto, critério de rollback, convivência com telas não reformadas.

### Etapa 6 — Plano técnico
- [ ] Só depois das etapas 1–4 fechadas.

---

## Registro de sessões
- **29/08/2026** — Etapa 0 fechada (natureza, dor, plataforma). Inventário funcional disparado. Achados: tokens semáforo prontos (21/08), análise de junho reaproveitável, `.pdv-lab` identificado como experimento anterior.
- **29/08/2026 (noite)** — Inventário entregue (378 itens). Medição de uso 60d rodada em produção. Dono deu direção de UX: botões grandes + sequência de popups com instrução (formato do fluxo guiado existente) — registrada como tese "trilho × pista livre" pra etapa 3. Nota: outra sessão trabalha em paralelo no repo (Metas/gamificação + lote 3 da separação); push do briefing adiado pra não empilhar restart do backend em horário de loja.
