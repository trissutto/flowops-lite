# Acervo do ERP encerrado — Giga/Wincred

**Nada aqui roda mais.** Em **27/08/2026**, por ordem do dono, a KingHost apagou o
**WordPress/WooCommerce** (`162.215.213.154`) e o caminho até o **MySQL do ERP
Giga/Wincred** foi trancado no código.

⚠️ **Eram duas máquinas diferentes** — a doc antiga dizia que dividiam a
hospedagem, e essa suposição já custou um commit errado. O MySQL do ERP ficava no
host do **fornecedor** (`mysql.gigasistemas.com.br`, Gigasistemas); o
`162.215.213.154` era o servidor da KingHost, onde vivia o WordPress. O ERP não
"sumiu": ficou **inalcançável pelo sistema** — o firewall recusa o IP do Railway
desde 25/08, e as trancas em `backend/src/common/replica-giga.ts` impedem até a
criação do pool. Foi por isso que o dump final (37/37 tabelas, 28/08) teve que
sair pelo IP residencial do dono.

O Flow é a fonte da verdade de estoque, venda, crediário e financeiro desde
julho/2026. Não religar.

Esta pasta guarda a **ferramenta e o runbook do backup final** — o que permitiu
tirar a última foto do banco antes de o servidor apagar. Fica como acervo
histórico: se um dia alguém precisar restaurar aquele dump pra responder uma
pergunta de auditoria, é por aqui que se começa.

## O que tem aqui

| Arquivo | Passo | O que faz |
|---|---|---|
| `01-inventario.ps1` | A1 | Lista tabelas, tamanho, engine e contagem de linhas. Só LÊ. É o número que a verificação pós-restore compara. |
| `02-dump.ps1` | A2 | `mysqldump` comprimido do banco inteiro. |
| `03-restore.ps1` | A3 | Restaura o dump num MySQL local. |
| `04-verificar.ps1` | A4 | Compara contagem de linhas tabela a tabela, dump × origem. |

O runbook que amarra os quatro passos: **`docs/RUNBOOK-SAIDA-KINGHOST.md`**.

⚠️ Os `.ps1` são **ASCII puro de propósito** (sem acento). O Windows PowerShell
5.1 lê `.ps1` como ANSI quando não há BOM, e acento em UTF-8 vira byte inválido
que quebra o parser com um erro que não faz sentido nenhum. Não acrescente
acento neles.

`.gitignore` local mantém `saida/`, `*.sql` e `*.sql.gz` fora do repo — o dump
em si **nunca** foi versionado.

## O dump propriamente dito

O arquivo do dump e o `dump-giga.js` (variante Node da mesma ferramenta) vivem
**fora do Git**, na máquina do dono. Se um dia forem versionados, o lugar deles
é aqui.

## Onde foi parar o resto

A Onda 2 do enterro do Wincred (09/2026) apagou o código que só falava com o
banco morto: a pasta `backend/scripts/giga-etl/` inteira, `inspect-erp`,
`sync-stores`, `reset-stores`, `unificar-refs-compostas`, `tools/diagnostico-erp`
e os `diag-*.js` one-off. O censo que embasou a decisão está em
`docs/auditorias/2026-09-03-enterro-wincred.md`.
