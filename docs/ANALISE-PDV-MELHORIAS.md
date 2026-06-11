# Análise do PDV — Diagnóstico e Plano de Melhorias

**Data:** 11/06/2026
**Escopo:** `frontend/src/app/minha-loja/pdv/` + `backend/src/pdv/`

---

## Resumo executivo

O PDV é funcional e completo (venda, split de pagamento, cashback, crediário, vale-troca, NFC-e, modo treino, caixa). Os 3 maiores problemas hoje:

1. **Finalizar venda é lento (2–10s)** porque o backend grava no Wincred/Giga e baixa estoque de forma SÍNCRONA antes de responder — sendo que erro nessas etapas nem bloqueia a venda. É espera desnecessária no caixa.
2. **Busca de cliente/produto lenta e sem cache** — redescobre a estrutura do banco Giga a cada busca, com timeouts de até 8–10s em série.
3. **Frontend monolítico (7.614 linhas, 114 useStates, 6 memoizações)** — qualquer tecla digitada re-renderiza a tela inteira, o que trava a bipagem em máquinas fracas das lojas.

Impacto esperado das correções da Fase 1: **finalize de ~8s → <500ms** e busca de cliente de até 11s → <500ms. Isso é tempo de fila no caixa.

---

## 1. VELOCIDADE (maior impacto em venda)

### 1.1 Finalize síncrono — CRÍTICO
`backend/src/pdv/pdv.service.ts:1679` (`gravarVendaPdv`) e `:1773` (`decreaseStock`)

A resposta do finalize espera a gravação no Wincred e a baixa de estoque no ERP. O próprio código diz que erro ali "NÃO bloqueia a venda — só loga warning". Ou seja: pode rodar em background.

**Fix:** disparar `gravarVendaPdv` + `decreaseStock` sem `await` (fire-and-forget com retry/fila simples) e responder ao caixa imediatamente. Já existe o campo `stockDecreasedAt` para reconciliar pendências.

**Por quê:** a venda no flowops é a fonte da verdade; a réplica no Wincred é contábil. A operadora não precisa esperar isso pra entregar a sacola.

### 1.2 Vale-troca: full table scan — CRÍTICO
`pdv.service.ts:587-610` — para validar uso único, carrega TODOS os `pdvSalePayment` com `method='vale_troca'` e faz parse de JSON um a um. Cresce linearmente com o histórico — daqui a 1 ano isso trava.

**Fix:** gravar o código do vale numa coluna própria indexada (`valeTrocaCode`) e buscar por igualdade. Migração simples + backfill.

### 1.3 Busca de cliente sem cache de descoberta — CRÍTICO
`pdv.controller.ts:650-731` (customer-info) e `:775-925` (customer-search)

- `customer-info` faz 3 queries em série com timeout de 10s cada (pior caso: 30s).
- Ambos redescobrem a tabela/colunas do Giga a cada chamada.

**Fix:** cachear a descoberta de tabela em memória (TTL 1h — o schema do Giga não muda no meio do dia) e paralelizar as queries com `Promise.allSettled`.

### 1.4 Frontend: re-render global a cada tecla
`frontend/.../pdv/page.tsx` — 7.614 linhas num componente, 114 `useState`, 34 `useEffect`, só 6 memoizações. Cada caractere digitado na bipagem re-renderiza carrinho, modais, painel de pagamento, tudo.

**Fix em 2 etapas:**
- Rápido: extrair o input de bipagem + dropdown de busca para componente próprio com estado local (1 dia, resolve 80% da lentidão de digitação).
- Estrutural: quebrar page.tsx em ~8 componentes (Carrinho, PainelPagamento, ModalCliente, ModalVendedora, ModalDesconto, BuscaProduto, Cashback, Finalizada).

### 1.5 Polling acumulado
`page.tsx:823` (15s), `:846` (30s), `:4190` (1s), `:4226` (3s), `:6770` (1s) — 5 intervals simultâneos, dois de 1 em 1 segundo. Os ticks de 1s causam re-render do monólito inteiro a cada segundo, mesmo com o PDV parado.

**Fix:** isolar os timers em componentes pequenos (junto com o item 1.4) e pausar polling quando a aba não está visível (`document.visibilityState`).

---

## 2. ATALHOS DE TECLADO

### O que já existe (bom)
`page.tsx:449-531`: F1 bipagem · F2 desconto · F3 caixa · F4 troca/devolução · F6 cliente · F9 vendedora · F10 consulta · auto-focus de qualquer tecla no input · setas/Enter no dropdown de busca · números 1-9 escolhem parcelas no crédito (`:4300`).

### Lacunas pra operação 100% teclado
| Atalho sugerido | Função | Hoje |
|---|---|---|
| **F8 ou Ctrl+Enter** | Ir direto pro pagamento / finalizar | Só mouse |
| **F7** | Alternar método de pagamento (dinheiro→pix→crédito→débito) | Só mouse |
| **+ / −** no item selecionado | Ajustar quantidade | Só mouse |
| **Del** | Remover item selecionado do carrinho | Só mouse |
| **↑/↓ no carrinho** | Navegar itens (hoje setas só funcionam no dropdown de busca) | Não existe |
| **F11** | Aplicar cashback disponível | Só mouse |
| **Esc em modais** | Fechar qualquer modal aberto | Parcial (Esc global ignorado quando modal aberto — handler desativa em `:451`) |
| **?** ou **F12** | Overlay com a lista de atalhos | Não existe — operadora nova não descobre os atalhos |

Detalhe importante: o handler global desliga quando qualquer modal abre (`page.tsx:451`), então dentro de modais a operadora volta pro mouse. Cada modal precisa do próprio keymap (Enter confirma, Esc fecha, setas navegam).

---

## 3. LAYOUT / UX

- **Hierarquia do total:** o valor total da venda deve ser o elemento mais visível da tela (tamanho 2–3x maior), visível também pro cliente se houver segundo monitor.
- **Feedback de bipagem:** já existe beep sonoro (`:806`) — bom. Falta flash visual no item adicionado (highlight verde 500ms) pra operadora confirmar sem olhar pro carrinho.
- **Estados de loading:** a busca tem `searchLoading`, mas finalize/pagamento precisam de estado bloqueante claro (botão com spinner + desabilitado) — com a latência atual de 8s, duplo clique em Finalizar é risco real de venda duplicada. Verificar se há guard de idempotência no finalize.
- **Barra de atalhos fixa no rodapé:** strip permanente com `F1 Bipar · F2 Desc · F4 Troca · F6 Cliente · F9 Vend.` — padrão de PDV de mercado, reduz treinamento.
- **Densidade:** tela principal acumula muitos blocos (pedidos online com polling, cashback, treino, marcados). Recolher o que não é fluxo de venda em painéis colapsáveis.

---

## 4. FUNCIONALIDADES — lacunas

1. **Modo offline / fila local:** se a internet da loja cair, o PDV para. Mínimo viável: detectar offline e segurar vendas numa fila local (IndexedDB) com sync ao voltar. Pra loja física isso é o gap mais grave.
2. **Idempotência no finalize:** garantir chave única por tentativa pra impedir venda dupla em retry/duplo clique.
3. **Reconciliação de estoque:** com o fix 1.1 (baixa em background), criar tela/relatório de vendas com `stockDecreasedAt` nulo há >10min, com botão "reprocessar".
4. **Atalho de cliente recorrente:** últimas N clientes atendidas no modal F6 (1 clique em vez de digitar CPF de novo).

---

## 5. ROADMAP PRIORIZADO

### Fase 1 — esta semana (maior ganho por hora investida)
| # | Item | Esforço | Ganho |
|---|---|---|---|
| 1 | Finalize assíncrono (1.1) | 3–4h | 8s → <500ms no caixa |
| 2 | Cache descoberta Giga + paralelizar customer-info (1.3) | 2–3h | busca cliente 11s → <500ms |
| 3 | Coluna indexada vale-troca (1.2) | 2h | elimina risco de travamento |
| 4 | Guard de duplo clique + idempotência no finalize | 1–2h | elimina venda dupla |

### Fase 2 — próxima semana
| # | Item | Esforço |
|---|---|---|
| 5 | Extrair input de bipagem (1.4 rápido) | 1 dia |
| 6 | Atalhos novos: F8 pagamento, Del, +/−, navegação carrinho, keymap nos modais | 1 dia |
| 7 | Barra de atalhos no rodapé + flash visual na bipagem | 0,5 dia |
| 8 | Pausar polling com aba oculta | 1h |

### Fase 3 — estrutural
| # | Item | Esforço |
|---|---|---|
| 9 | Quebrar page.tsx em componentes | 3–4 dias |
| 10 | Modo offline com fila local | 1 semana |
| 11 | Tela de reconciliação de estoque | 1 dia |

---

## Referências de código

- Atalhos atuais: `frontend/src/app/minha-loja/pdv/page.tsx:449-531`
- Busca com debounce 300ms (ok): `page.tsx:614-646`
- Pollings: `page.tsx:823, 846, 4190, 4226, 6770`
- Finalize síncrono: `backend/src/pdv/pdv.service.ts:1474-1861`
- Vale-troca scan: `pdv.service.ts:587-610`
- Customer-info serial: `backend/src/pdv/pdv.controller.ts:650-731`
- Customer-search: `pdv.controller.ts:775-925`
