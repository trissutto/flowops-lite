# Cut-over Wincred → Flowops — 30/06/2026

Plano operacional pra desligar o Wincred/Giga e usar **Flowops como source-of-truth** das 15 lojas Lurd's.

---

## Premissas (precisa estar pronto)

- [x] Mirror Wincred → Postgres (#198, sync cron 10min)
- [x] Tela Divergências (#201)
- [x] PagBank por loja (#213)
- [x] Crediário PIX migrado (#214)
- [x] Comissão engine (F4 — #178)
- [x] Endpoint compare-day (#221)
- [ ] CRUD produto direto no Flowops (#204)
- [ ] Backup MySQL Wincred + script rollback (#205)
- [ ] Lojas piloto operando 1 semana sem Wincred (#203)

---

## Semana 24-29/06 — SHADOW READ

**Objetivo:** rodar Flowops em paralelo com Wincred. Validar que números batem.

### Diariamente às 19h (matriz)

1. Abre `/retaguarda/divergencias` → ver totais Mirror vs Wincred
2. Roda endpoint `GET /admin/cutover/compare-day` → ver vendas do dia
3. Se diferença > 1% em qualquer loja → **investiga** antes de avançar
4. Anota tudo em planilha de validação

### Indicadores de OK pra cut-over

- ✅ Total vendas/dia: Wincred vs Flowops diferença < 1%
- ✅ Total estoque produtos: diferença < 1%
- ✅ Histórico últimos 7 dias: tendência estável (sem divergência crescente)
- ✅ Comissão calculada no Flowops bate com Giga (até R$ 50 diferença por vendedora)

---

## 30/06 (D-Day) — Cut-over por etapa

### 06h00 — BACKUP

```bash
# Matriz (Thiago + 1 técnico)
mysqldump -h ws-server -u root -p \
  --single-transaction --routines --triggers \
  --databases wincred > backup_30_06_06h.sql
gzip backup_30_06_06h.sql
# Sobe pra Cloudflare R2 (3 cópias)
aws s3 cp backup_30_06_06h.sql.gz s3://lurds-backups/cutover/
```

**Validação:** restaurar em VM teste antes de avançar. Tamanho esperado ~500MB.

### 07h00 — SYNC FINAL

```bash
# Via tela /retaguarda/wincred-mirror
# Botão "Sincronizar Tudo" → roda último full sync Wincred → Postgres
# Tempo esperado: 2-3 min
```

**Validação:** Tela Divergências mostra `diff < 100 linhas` em produtos e estoque.

### 08h00 — DESLIGAR ACESSO WINCRED

**No servidor Windows do Wincred:**
1. Sair de todos os usuários do Giga
2. Pausar serviço de Caixa
3. Bloquear porta 3306 (firewall) — exceto IP do flowops (sync incremental)
4. Avisar todas as lojas via WhatsApp grupo "Lurd's Gestores":
   > "🚨 Wincred desligado às 08h00. A partir de agora todas as vendas, baixas, recebimentos vão pelo Flowops. Qualquer problema, manda mensagem aqui."

### 08h00 - 18h00 — OPERAÇÃO MONITORADA

**Matriz fica de plantão:**
- Thiago, Karine, Grazi, Hellen
- Cada um monitorando uma área:
  - **Thiago** — Dashboard geral + PagBank
  - **Karine** — Vendas / PDV
  - **Grazi** — Estoque / Realinhamento
  - **Hellen** — Crediário / Cobrança

**Checklist a cada 2h:**
- [ ] Total vendas batendo com fluxo esperado?
- [ ] PagBank recebendo PIX certinho?
- [ ] Webhook chegando?
- [ ] Alguma loja sem registrar vendas? (sinal de problema)
- [ ] Sorocaba/Indaiatuba/Itanhaém com app PWA funcionando?

### 19h00 — FECHAMENTO

```bash
# Roda relatório fiscal do dia
# Compara com expectativa do mês (média de vendas/dia)
# Se total razoável → CUT-OVER BEM SUCEDIDO
```

**Reunião rápida (30min) das 4 pessoas da matriz:**
- Quantas vendas?
- Problemas reportados pelas lojas?
- Algum dado faltando?
- Tem que ligar PagBank/Pagar.me sobre alguma transação?

---

## ROLLBACK (se der ruim)

**Critério de rollback:**
- Lojas reportam erro grave em > 3 lojas simultâneas
- Vendas perdidas (cliente sai sem nota)
- Estoque travado / sumiu

### Procedimento (15min):

1. **Avisar lojas via WhatsApp:**
   > "Voltando temporariamente pro Giga. Não preocupa, dados estão salvos. Volta a operar normal no Giga em 10min."

2. **Reativar Wincred:**
   - Liberar firewall porta 3306
   - Reabrir Giga em todas as lojas
   - Importar vendas do dia pelo flowops (script SQL) — script preparado em `/scripts/rollback_import_sales.sql`

3. **Análise pós-mortem:**
   - O que deu errado?
   - Trabalhar 1-2 dias pra corrigir
   - Marcar nova data de cut-over

---

## Contatos de emergência

| Pessoa | Função | Telefone |
|---|---|---|
| Thiago | CEO / Decisão final | (xx) xxxxx |
| Gustavo | Backup tecnico | (xx) xxxxx |
| PagBank suporte | Pagamentos | 0800-728-2174 |
| Railway | Infra Postgres/Backend | dashboard.railway.com → Support |
| Vercel | Frontend | vercel.com → Support |

---

## Pós cut-over (01-07/07)

- [ ] Manter Wincred em modo read-only por 30 dias (caso precise consultar histórico)
- [ ] Tela Divergências em modo "alerta" (não bloqueia, mas avisa se voltar a divergir)
- [ ] Desativar tasks de sync incremental (não precisa mais)
- [ ] Comunicar contador: relatórios fiscais agora saem 100% do Flowops
- [ ] Fechamento mês Jun/26 pelo Flowops (#220 + #219)
- [ ] Cancelamento da licença Wincred a partir de 01/08

---

## Tarefas técnicas em aberto pra fechar antes

| # | Tarefa | Estado |
|---|---|---|
| 200 | Marcar 5 lojas como GRUPO A | pending |
| 203 | Migração progressiva 2-3 lojas/dia | pending |
| 204 | CRUD produto no Flowops | pending |
| 205 | Backup MySQL + plano rollback | pending |

**Sem essas 4, NÃO faz cut-over.**
