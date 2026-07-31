# Merchandising — visão de negócio

O que decide a ORDEM da vitrine e da busca, em português de dono de loja.
Detalhe técnico: `docs/boost-rules.md` e `docs/search.md`.

## O princípio

A busca responde **o que a cliente pediu** (relevância). O merchandising
decide, entre duas peças igualmente boas pra ela, **qual a loja quer
mostrar primeiro**. O boost nunca engana: uma peça irrelevante não fura a
fila — só reordena entre relevantes. E todo empurrão fica registrado
(`reasons` no resultado): dá pra auditar por que uma peça subiu.

## O que dá boost HOJE

| Empurrão | Quanto | Vem de onde |
|---|---|---|
| Novidade | +25% | flag `lancamento` do cadastro (badge "novo") |
| Mais vendido | +20% | badge `best-seller` (quando o cadastro marcar) |
| Em promoção | +15% | flag `promocao` ou preço riscado |
| Últimas peças | +10% | estoque total ≤ 3 (badge do catálogo) |

Acumulam: peça nova E em promoção leva os dois.

Além das regras, existe a **personalização anônima**: quem só navega
vestidos vê vestidos levemente à frente no desempate (categorias e tecidos
mais vistos, guardados só no navegador dela — sem cadastro, sem PII).
Limite duro de +30%, de propósito: a cliente que buscou uma peça pelo nome
SEMPRE acha essa peça primeiro, favorita ou não.

## O que está PREPARADO mas ainda não pontua — e por quê

Sendo honesto sobre o que depende de dado que o front ainda não recebe:

| Ideia | O que falta |
|---|---|
| Boost por **margem** (subir peça que deixa mais dinheiro) | preço de custo não sai do ERP pro site (e não deve sair pro client — precisaria de score calculado no backend) |
| Boost por **conversão real** (subir o que converte, não o que a gente acha) | exige fechar o ciclo pedido → GA4/Postgres por SKU; o tracking já registra, falta a agregação voltar pro catálogo |
| Boost por **estoque da loja da cliente** (`nearStore`) | o BFF ainda manda `availability.stores` vazio; o sinal já existe no contexto e liga sozinho quando o dado chegar |
| Boost por **cidade/campanha regional** | depende do mesmo dado de loja/CEP acima |
| Boost por **cliente identificada** (histórico de compra) | depende de login/conta — hoje a personalização é 100% anônima e local |
| Regras editáveis em **painel** (sem deploy) | endpoint + tela de retaguarda; o caminho está desenhado em `loadBoostRules()` |

Nada disso exige refazer o motor: são regras novas no mesmo formato ou
dados novos alimentando condições que já existem.

## Como calibrar sem se enganar

1. **Um fator de cada vez.** Mudou dois, não sabe qual causou o quê.
2. **Meça pelo funil, não pelo olho**: `trackSearch` → `select_item` →
   `add_to_cart` já segmentam por termo buscado no GA4.
3. **Fator > 1.3 é decisão de dono**, não ajuste fino — a partir daí o
   merchandising começa a vencer a relevância e a busca "mente".
4. Desligou uma regra? `enabled: false` e deixa no código com o motivo —
   a próxima pessoa não repete o experimento que falhou.
