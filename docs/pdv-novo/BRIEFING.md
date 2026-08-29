# Novo PDV — Briefing (doc vivo)

**Projeto:** reforma visual + hierarquia por uso do PDV de loja física (`frontend/src/app/minha-loja/pdv/`).
**Método:** briefing em etapas; cada etapa fecha decisões POR ESCRITO aqui, antes de qualquer código de produção. Decisão fechada não reabre sem fato novo.
**Status:** etapa 0 fechada (29/08/2026) · etapa 1 em andamento · etapas 2–6 pendentes.

---

## Etapa 0 — Enquadramento (FECHADA 29/08/2026)

| Pergunta | Decisão do dono |
|---|---|
| O que é o "novo"? | Mudança de UX/visual da tela atual, em dois pilares: (1) **hierarquia por uso** — medir quais botões/operações são mais usados e dar mais visibilidade a eles; (2) aplicar a **identidade visual SEMÁFORO** |
| Dor nº 1 | **Salto visual** — qualidade percebida de outro nível |
| Plataforma | **PC da loja, como hoje** — mantém Electron, impressoras, heartbeat de IP do ponto |
| Consequência de escopo | Backend, endpoints e regras de venda **não mudam** nesta reforma. Muda apresentação, hierarquia e organização da tela |

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

### Etapa 1 — Inventário + medição de uso (EM ANDAMENTO)
- [ ] Inventário funcional completo do PDV atual (agente rodando desde 29/08) → dono marca cada item: **FICA / MUDA / MORRE / v2**.
- [ ] **Medição de uso em produção** (fundamenta a hierarquia): frequência real por operação — venda, devolução/troca, marcado, crediário, vale-troca, cashback, sangria, reimpressão, cobrança online, consulta — por loja/dia, últimos 30–60 dias, no Postgres. O ranking vira a ordem de visibilidade da tela nova.

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
