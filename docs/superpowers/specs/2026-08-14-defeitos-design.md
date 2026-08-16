# Módulo Defeitos — registro, transporte e destino de peça avariada

Status: aprovado pelo dono em 14/08/2026.

Registra peça com defeito fora do módulo de marcados: baixa o estoque da loja, gera número de controle, agrupa as peças numa caixa que vai pra matriz (centro de distribuição) e fecha o ciclo com uma decisão — devolver ao fornecedor ou descartar.

## Por que não usar marcados

Hoje o defeito vira um `Marcado` com `status='baixado'` (o schema documenta: *"write-off SEM financeiro/estoque — defeito, furto, perda"*). Marcado é dívida de cliente: entra no `LIMITECOMPRAS`, aparece na lista de marcados ativos e é validado contra a avaliação do cliente. Defeito é perda de mercadoria e não tem cliente. Misturar os dois suja o controle de marcados e impede qualquer relatório de perdas confiável.

## Decisões tomadas

| Questão | Decisão |
|---|---|
| Destino final da peça | Devolução ao fornecedor · descarte (lixo) · **conserto na costureira** (poucas peças) |
| Peça consertada volta pra | **Loja de origem** — quem perdeu a venda recupera a peça |
| Origens do defeito | Arara da loja · devolução de cliente por defeito · achado na própria matriz |
| Peça sem etiqueta | O campo de bipe tem a **mesma busca do PDV** (REF, cor, descrição) |
| Controle do caminho | Rastreado: baixa na loja, matriz confirma a chegada bipando |
| Transporte | Caixa exclusiva de defeitos, com romaneio impresso |
| Nota fiscal | **Não** emite NF-e no v1 (decisão do dono) |
| DRE | Fora de escopo — basta o relatório de defeitos |
| Marcados `baixado` antigos | Migrar pra cá (ver seção Migração) |

## Estoque — a regra central

**A peça baixa do estoque uma única vez, no registro, e só reentra por um caminho: o conserto.**

A matriz recebendo a caixa **não movimenta estoque nenhum** — só muda o status. Isso elimina o risco de peça defeituosa voltar a ser vendida e dispensa qualquer "depósito de defeitos" com estoque paralelo.

A **única** exceção é `recuperarDoConserto`: a peça voltou boa da costureira e entra de novo no estoque da **loja de origem** (`increaseStockAsync`, simétrico à baixa). É idempotente por status — peça já `RECUPERADO` não credita duas vezes, senão clicar duas vezes criaria peça do nada.

A baixa usa `decreaseStockAsync` — mesmo caminho dos marcados e da separação: aplica no Flow (fonte da verdade desde 14/07) e enfileira a réplica pro Giga no outbox, sem pendurar a tela no MySQL da KingHost. Idempotência por `stockDecreasedAt`, no padrão do `ErpOutboxService`.

## Modelo de dados

### `DefectItem` — uma linha por peça

- **Identidade**: `code` (`DEF-2026-000123`, único), `sku` (EAN bipado), `ref`, `descricao`, `cor`, `tamanho`
- **Origem**: `storeCodeOrigem`, `storeNameOrigem`, `origem` (`LOJA` | `DEVOLUCAO_CLIENTE` | `MATRIZ` | `MIGRACAO_MARCADO`), `registradoPorUserId`, `registradoPorNome`, `registradoAt`
- **Defeito**: `motivo` (enum abaixo), `observacao`, `fotoUrl`
- **Fornecedor**: `fornecedorCnpj`, `fornecedorNome`, `marca` — snapshot no registro, porque é por eles que a devolução é agrupada
- **Valor**: `custoUnitCents`, `precoUnitCents` — snapshot; base do valor da perda no relatório
- **Ciclo**: `status` (`EM_TRANSITO` → `RECEBIDO` → `DEVOLVIDO_FORNECEDOR` | `DESCARTADO` | `EM_CONSERTO` → `RECUPERADO`), `recebidoAt`/`recebidoPor`, `decididoAt`/`decididoPor`, `decisaoObservacao`
- **Vínculos**: `batchId` (a caixa), `returnId` (quando veio de devolução de cliente), `marcadoId` (quando veio da migração — também serve de chave de idempotência)
- **Controle**: `stockDecreasedAt`, `isTraining`

Índices: `[status, storeCodeOrigem]`, `[fornecedorCnpj, status]`, `batchId`, `marcadoId` único.

### `DefectBatch` — a caixa

`code` (`CX-2026-000045`), `storeCodeOrigem`, `status` (`aberta` | `enviada` | `recebida`), `totalPecas`, `totalCustoCents`, `fechadaAt`, `fechadaPor`, `recebidaAt`, `recebidaPor`.

Cada loja tem no máximo **uma caixa aberta** por vez; o registro de defeito cai automaticamente nela (criando-a se não existir).

### Geração de código

`DEF-AAAA-NNNNNN` e `CX-AAAA-NNNNNN`, sequenciais por ano, calculados pelo **maior código existente do ano** (nunca `count()` — remoção de linha causaria violação de unicidade) e com retry por sufixo em caso de corrida. Mesmo algoritmo de `generateShipmentCode` em `realignment/shipment.service.ts`.

### Motivos (aprovados pelo dono)

`FURO_RASGO` · `MANCHA` · `COSTURA_SOLTA` · `ZIPER_BOTAO` · `DESBOTADO` · `FALTA_PECA` · `MODELAGEM_ERRADA` · `OUTRO` (obriga observação preenchida).

## Fluxos

### 1. Registro na loja (`/minha-loja/defeitos`)

Vendedora bipa o código → o sistema resolve a peça pelo `WincredCatalogService` (espelho primeiro, Giga como fallback — mesmo caminho do bipe do PDV) → escolhe motivo → foto opcional → confirma.

**Peça sem etiqueta:** o campo aceita busca por REF, cor ou descrição usando `/products/erp-search`, o mesmo endpoint do dropdown do PDV — a vendedora escolhe da lista e o código entra sozinho. Termo só de dígitos não abre a lista: é o leitor bipando.

Na confirmação, em sequência: cria `DefectItem` com snapshot de peça/fornecedor/valores → `decreaseStockAsync` da loja → marca `stockDecreasedAt` → anexa à caixa aberta → status `EM_TRANSITO`.

Se a baixa de estoque falhar, o registro **não** é criado — sem meia-baixa.

### 2. Fechar a caixa

Vendedora clica "Fechar caixa" → status `enviada`, totais congelados → abre o romaneio pra impressão: código da caixa, loja, data, lista das peças (código de controle, REF, cor, tamanho, motivo) e o total. O romaneio vai colado por fora.

Sem NF-e e sem etiqueta dos Correios no v1.

### 3. Recebimento na matriz (`/retaguarda/defeitos`)

Matriz vê as caixas com status `enviada`. Ao abrir a caixa física, bipa peça por peça: cada bipe casa pelo `code`/`sku` e vira `RECEBIDO`. O que não foi bipado fica destacado como **não chegou** — é o ganho do rastreio; a peça continua `EM_TRANSITO` e aparece no relatório de divergência por loja.

Nenhum movimento de estoque nesta etapa.

### 4. Decisão

Fila agrupada **por fornecedor**. A matriz seleciona várias peças e aplica em lote: `DEVOLVIDO_FORNECEDOR` (com observação, ex.: número da NF de devolução digitado à mão), `DESCARTADO` ou `EM_CONSERTO`.

Só decide peça que está `RECEBIDO`: decidir sobre peça `EM_TRANSITO` esconderia justamente a que sumiu no caminho.

### 4b. Voltou da costureira

Peça em `EM_CONSERTO` que volta boa recebe **"Voltou do conserto"**: entra de novo no estoque da **loja de origem** e fica `RECUPERADO`. É o único ponto do módulo que credita estoque.

O status `EM_CONSERTO` existe pra peça na costureira sair da fila de decisão sem sumir do controle — sem ele ela ficaria em `RECEBIDO` para sempre, misturada com as que ninguém decidiu.

### 5. Devolução de cliente por defeito

Na devolução do PDV, ganha a opção "voltou com defeito". Quando marcada, a peça **não retorna ao estoque vendável**: o fluxo cria o `DefectItem` direto, com `origem='DEVOLUCAO_CLIENTE'` e `returnId` preenchido. Evita o vai-e-volta contábil (entra e sai no mesmo minuto) e a janela em que a peça fica vendável.

### 6. Achado na matriz

Mesma tela de registro, com a loja da matriz como origem: baixa o estoque da matriz e já nasce `RECEBIDO`, sem caixa nem transporte.

## Telas

**Loja** — `/minha-loja/defeitos`: campo de bipe em destaque, seletor de motivo, foto opcional, lista da caixa aberta com contador e valor, botão "Fechar caixa e imprimir romaneio".

**Matriz** — `/retaguarda/defeitos`: abas *Caixas a receber* (bipe de conferência), *Fila de decisão* (agrupada por fornecedor, seleção múltipla) e *Relatório* (por período, loja, fornecedor e motivo, com peças e valor de custo; filtro De/Até com atalhos Hoje/Ontem/7 dias/Mês, nunca dropdown de períodos fixos).

## Migração dos marcados `baixado`

Todo `Marcado` com `status='baixado'` vira um `DefectItem` histórico. Regras:

1. **NUNCA mexe em estoque.** Nesses marcados a peça já saiu do estoque quando o marcado foi criado; rebaixar duplicaria a perda. O `DefectItem` migrado nasce com `stockDecreasedAt` preenchido com a data original.
2. **Idempotente** por `marcadoId` único — rodar duas vezes não duplica.
3. Nasce com `origem='MIGRACAO_MARCADO'`, `status='DESCARTADO'` (são casos antigos, já resolvidos fisicamente), `motivo='OUTRO'` com o `baixaMotivo` original copiado pra `observacao`, e sem caixa.
4. **Dry-run obrigatório antes**: relatório de quantos registros, quais lojas e que motivos aparecem — a rodada real só depois da conferência do dono. Marcado em massa já causou incidente antes (ressuscitados pelo import), então nada roda direto em produção.
5. O `Marcado` original **não é alterado nem apagado** — segue como histórico do módulo antigo.

## Fora de escopo (YAGNI)

- NF-e e etiqueta dos Correios pra caixa de defeitos — decisão do dono; entra depois se o contador exigir
- Lançamento na DRE — basta o relatório
- Aprovação da matriz antes da baixa
- Crédito financeiro do fornecedor — a devolução registra a decisão, o acerto é por fora
- Controle de quem é a costureira / prazo do conserto — o `EM_CONSERTO` só diz que a peça está fora
- Defeito detectado na conferência do pedido de compra — o dono não incluiu como origem

## Riscos e cuidados

- **Modo treinamento**: `isTraining` na trava de sempre — treino nunca toca estoque, Giga ou relatório.
- **Peça sem cadastro/EAN**: o bipe cai no fallback do Giga; se ainda assim não resolver, o registro é bloqueado com mensagem clara (registrar defeito de peça inexistente estraga o relatório).
- **Estoque negativo**: a baixa usa `allowNegative` — peça com defeito real precisa sair mesmo se o estoque estiver desencontrado; a divergência aparece no relatório em vez de travar a loja.
- **Caixa esquecida aberta**: a tela da matriz destaca caixas abertas há **mais de 15 dias** por loja, pra cobrança — prazo escolhido por ser mais que o intervalo normal entre remessas, sem virar alarme falso.
- **Boot test do Nest** antes de mergear (módulo novo = aresta nova no grafo): `NestFactory.create + init` — `tsc` e `nest build` não pegam ciclo de módulo.
