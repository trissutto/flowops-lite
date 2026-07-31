# Contas a Pagar — Fase 0: DESCOBERTA da estrutura real no GIGA

> Gerado em 11/07/2026 por inspeção **read-only** direta no MySQL do Giga
> (`SHOW TABLES` / `DESCRIBE` / contagens / amostras — zero escrita).
> **Este documento é o CONTRATO da migração.** Nada aqui foi assumido; tudo foi
> lido do banco. Decisões do dono (11/07): telas v1 aprovadas · aba
> Funcionárias restrita a autorizadas · **contas a pagar nasce SÓ NO FLOW**
> (GIGA congela pra consulta — "contagem regressiva para sair do Giga").

## 1. Tabelas envolvidas

| Tabela | Linhas | Papel |
|---|---|---|
| `pagar` | **71.974** | A tabela do Contas a Pagar (1 linha = 1 conta/parcela) |
| `esp_contas` | 11 | Catálogo de espécies |
| `fornecedores` | 2.091 | Favorecidos (POLUÍDO — ver §4) |
| `funcionarios` | 135 | Cadastro de funcionárias do Giga (ponte c/ RH do Flow) |
| `cheques`, `chequespagar` | 0 | Vazias — fora do escopo |

## 2. `pagar` — dicionário de campos (verificado)

| Campo GIGA | Tipo | Significado | Campo novo (Flow) |
|---|---|---|---|
| `REGISTRO` | int PK | Número da conta (único índice da tabela!) | `gigaRegistro` (chave da migração) |
| `PNUM` | varchar(30) | Número em texto (espelha REGISTRO) | — (redundante, preservar no raw) |
| `PESP` | varchar(10) | **Espécie em TEXTO LIVRE** (não é FK!) | `especieId` + `especieOriginal` |
| `PSER` | char(5) | Série — **lixo** (51k null, 21k vazio, 2 sujos) | — (preservar no raw) |
| `PFAV` | int | Favorecido → `fornecedores.CODIGO` (FK frouxa, **497 órfãos**) | `fornecedorId` / `sellerId` |
| `PEMI` | date | Emissão | `emissao` |
| `PBAN` | varchar(20) | Banco (texto livre) | `banco` |
| `PVAL` | decimal(10,2) | Valor | `valorCents` |
| `PVEN` | date | Vencimento | `vencimento` |
| `PAGA` | date | Data do pagamento — **null = em aberto** | `pagamento` + `status` derivado |
| `PJUR` | decimal(10,2) | Juros (na baixa) | `jurosCents` |
| `PDES` | decimal(10,2) | Desconto (na baixa) | `descontoCents` |
| `POBS` | varchar(50) | Observação | `observacao` |
| `NNOTA` | varchar(10) | Nota fiscal — **campo livre** ("JARDINEIRO", "ELEKTRO/12") | `notaFiscal` |
| `NCHEQUE` | varchar(12) | Nº cheque | `cheque` |
| `PEND` | char(3) | **"EM MÃOS"** (SIM/NAO) — com lixo (§4) | `emMaos` bool + original |
| `LOJA` | char(2) | Código da loja | `lojaCode` |

## 3. Números de referência (pra validação da migração)

- **Total: 71.974 contas** · pagas 65.522 · em aberto 6.452 (**4.602 vencidas** + 1.850 futuras).
- Por espécie (top): DUPLICATA 26.980 (R$ 64,5M) · **RH 21.613 (R$ 15,4M)** ·
  DUPLI 9.666 · CHEQU 3.349 · OUTROS 2.159 · DEPOSITO 1.559 · IMPOSTO 1.166 ·
  ENERGIA 1.130 · ALUGUEIS 993 · AGUA 867 · INTERNET 702 · VALE 623 · OUTRO 447 ·
  PROMI 315 · BOLETO 267 · DEPOS 93 · vazio 23 · CARNE 14 · null 8.
- Por loja (top): **51 → 24.196** · 01 → 14.595 · 02 → 4.337 · **50 → 4.282** ·
  04 → 3.257 … inclui códigos fora do cadastro atual de lojas: **51, 50, 99, 48, 22, 60, 70** (§5-P1).
- Favorecidos mais usados: MALWEE (1.970), CONTABILIDADE UNIÃO (1.237),
  **"DESPESAS GERAIS" (1.223)**, CATIVA (1.068), HERING (942)… e **"CARTAO DE CREDITO" (735)** —
  favorecidos "conceituais", não empresas.

## 4. Sujeiras confirmadas (a migração TEM que tratar; NUNCA corrigir em silêncio)

1. **Espécie é texto truncado em 10 chars, com variantes**: 19 valores distintos
   pra 11 do catálogo. DE-PARA obrigatório: `DUPLI→DUPLICATA`, `OUTRO→OUTROS`,
   `DEPOS→DEPOSITO`, `CHEQU→CHEQUE(novo)`, `PROMI→PROMISSÓRIA(novo)`,
   `CARNE→CARNÊ(novo)`, vazio/null → `SEM ESPÉCIE(novo)`. Original sempre
   preservado em `especieOriginal`.
2. **`PEND` (Em mãos) com lixo**: além de SIM (22.005) e NAO (45.638), existem
   "S" (37), "N" (63), vazio (4.093), null (135) e números soltos ("239", "7",
   "794"). Normalizar pra bool preservando o original.
3. **497 contas com favorecido órfão** (PFAV sem linha em `fornecedores`) →
   migrar com `fornecedorNome = 'FAVORECIDO #<n> (órfão no GIGA)'` + flag.
4. **Datas absurdas**: emissão desde **1923**, vencimento em **ano 0203** e
   **2037**. Migrar como está + flag `dataSuspeita` (relatório próprio).
5. **`fornecedores` poluído**: pessoas físicas (funcionárias!), "CASA - RUA …",
   "DESPESAS GERAIS", CNPJ "1111…". É assim que pagamentos de funcionárias são
   feitos hoje (espécie RH/VALE + favorecido pessoa). O modelo novo separa
   beneficiário FORNECEDOR × FUNCIONÁRIA.
6. **Parcelas não existem como estrutura**: são linhas irmãs independentes com
   sufixo manual na NNOTA ("ELEKTRO/11", "ELEKTRO/12") e vencimentos mensais.
   Modelo novo tem `parcelaNum/parcelaTotal/grupoParcelaId` reais.
7. **Sem índice além da PK** — toda consulta do WinCred é full scan. No Flow:
   índices em (lojaCode, vencimento, status), fornecedorId, sellerId + trigram
   na busca textual.

## 5. Perguntas em aberto (P) — responder antes da Fase 2

- **P1.** Lojas `51`, `50`, `99`, `48`, `22`, `60`, `70` no `pagar` são o quê?
  (51 tem 24 mil lançamentos — matriz? escritório? histórico de loja fechada?)
  Precisamos do DE-PARA oficial de lojas.
- **P2.** No WinCred, o radio **"Previsão"** filtra o quê exatamente? (hipótese:
  contas futuras em aberto; confirmar com o uso real.)
- **P3.** `PJUR`/`PDES` são preenchidos na baixa (juros/desconto pagos)? A tela
  de pagamento nova deve pedir esses 2 campos?

## 6. `funcionarios` do GIGA (ponte com o RH do Flow)

135 linhas: `CODIGO, NOME, APELIDO, NASCIMENTO, RG, CPF, CTPS, ENDERECO,
BAIRRO, CIDADE, TELEFONE, CELULAR, CARGO, SALARIO, COMISSAO, ADMISSAO, LOJA`.
**CPF presente** → casa com o cadastro por CPF do portal RH (`OperadorPin`/Seller).
A aba Funcionárias do novo Contas a Pagar liga o pagamento ao CPF/Seller — e o
histórico RH do GIGA (21.613 lançamentos) pode ser vinculado retroativamente
por nome/favorecido numa fase posterior (com conferência humana).

## 7. Arquitetura decidida (dono, 11/07)

- **Só FLOW**: lançamento novo NUNCA vai pro GIGA. Migra-se o histórico
  (71.974) uma vez, de forma idempotente (upsert por `gigaRegistro`), e o GIGA
  congela pra consulta.
- **Conferência do congelamento**: job compara contagens/somas GIGA×FLOW; se
  alguém lançar/alterar no GIGA depois do corte, aparece na tela Divergências
  (importar ou ignorar — decisão humana).
- **Validação de aceite** (antes de considerar migrado): counts e somas por
  loja × espécie × status batendo 100% + relatório de discrepâncias zerado.
- **Acesso**: aba Funcionárias visível só pra perfis autorizados (salário é
  dado sensível). Log de auditoria por campo em toda alteração; exclusão =
  soft delete com autor.
- Telas v1 aprovadas (mockup navegável): painel · nova conta (parcelas com
  prévia) · funcionárias · divergências. Busca textual por QUALQUER parte
  (fornecedor, NF, observação, valor) — padrão `ProductSearchService`/pg_trgm.

## 8. Fases de execução

1. ~~Fase 0 — descoberta~~ ✅ (este documento)
2. **Fase 1 — modelo + espelho de migração**: tabelas `ContaPagar`,
   `EspecieConta`, `ContaPagarLog` (auditoria por campo) + espelho raw
   `giga_pagar` (cópia fiel pra reconciliar).
3. **Fase 2 — telas** (as 4 do mockup) + permissões da aba Funcionárias.
4. **Fase 3 — migração idempotente** com DE-PARA (§4) + relatório de
   discrepâncias + validação de aceite (§7).
5. **Fase 4 — corte**: operação lança só no Flow; WinCred Contas a Pagar
   aposentado; conferência do congelamento ativa.
