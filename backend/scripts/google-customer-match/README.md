# Lista de compradoras do site → Customer Match do Google Ads

A gestora do Google pediu (28/09/2026) a lista de compradoras dos últimos 12
meses pra alimentar a inteligência das campanhas. Isso é **Customer Match**: a
lista de clientes vira público-alvo, o Google casa quem tem conta Google e a
campanha passa a ter exemplo de quem realmente compra.

## A régua (ordem do dono, 28/09/2026)

**SÓ e-mail de quem comprou no SITE.** `source='site'` (WooCommerce, o site
antigo) e `source='ecommerce'` (lurds.com.br). Ficam de fora a loja física
inteira (`pdv_sales`), a venda online do PDV (`pdv_online`) e a live — não são
compra no site, e a lista alimenta a conta de **e-commerce**.

Carrinho não é compradora: `pending`, `awaiting_payment`, `payment_failed` e
`cancelled` não entram. O robô do Google aprende com exemplos de sucesso; pôr
quem não pagou é ensinar errado.

**A base do Reportana não está aqui e não dá pra puxar daqui:** ele fazia o
resgate de carrinho no site antigo, está desligado desde 18/06/2026 e nunca
escreveu no Postgres do Flow. Compra do site antigo dentro dos 12 meses entra
assim mesmo, porque o pedido do WooCommerce está em `orders`. O que só existe lá
é lead que nunca comprou — se um dia quiserem, tem que ser export manual.

## O que já está no ar (28/09/2026, conta 892-523-1246)

| lista | id | pessoas |
|---|---|---|
| Compradoras do site - 12 meses | `9479548071` | 5.591 |
| Compradoras do site - historico completo | `9478824058` | 16.664 (desde abr/2021) |
| ~~COMPRADORES SITE~~ | `9183621142` | 6.800 casados, 91% — **já existia**, não foi feita aqui |

As duas novas subiram com **e-mail + telefone + endereço**. A terceira é
anterior e provavelmente foi subida pela gestora — dá pra comparar o match
delas depois de algumas horas e aposentar a que sobrar.

## 1. Gerar (só lê o banco)

```bash
railway link --project heroic-mercy --environment production --service Postgres
railway run node backend/scripts/google-customer-match/gerar-lista.js
MESES=tudo railway run node backend/scripts/google-customer-match/gerar-lista.js
```

`MESES` é a janela (padrão `12`); `MESES=tudo` leva o histórico inteiro. Quanto
cada faixa acrescenta, medido em 28/09/2026:

| janela | e-mails | a mais |
|---|---|---|
| 12m | 5.591 | — |
| 24m | 9.346 | +3.755 |
| 36m | 11.602 | +2.256 |
| 48m | 15.603 | +4.001 |
| tudo | 16.664 | +1.061 |

Gera três CSVs por janela (o `.gitignore` impede que e-mail de cliente vá pro
git). Com `MESES=12` eles se chamam `site-12m-*`; com `MESES=tudo`, `site-tudo-*`:

| arquivo | o que é |
|---|---|
| `…-email.csv` | uma coluna, só o e-mail |
| `…-email-sha256.csv` | o mesmo já hasheado |
| `…-completo.csv` | as MESMAS pessoas com telefone, nome, país e CEP — **é o que sobe** |

O `completo` é o preferido porque mais identificador = mais gente casada:
e-mail morto ainda casa pelo telefone. 99% das compradoras têm os dois.

## 2. Subir

```bash
railway run --service flowops-lite node backend/scripts/google-customer-match/subir-lista.js   # ensaio a seco
TERMOS_ACEITOS=1 railway run --service flowops-lite node backend/scripts/google-customer-match/subir-lista.js --aplicar
```

Sem `--aplicar` nada é criado nem enviado: o Google só confere. Com `--aplicar`
a lista é criada e, **antes de qualquer e-mail subir**, um lote de 10 passa por
uma validação a seco — se faltar aceite de termos ou a conta não for elegível, o
erro aparece com a lista ainda vazia.

O `--service flowops-lite` evita trocar o link do repo (o `railway link` é **por
pasta**, e a raiz aponta pro Postgres).

Variáveis: `LISTA_CONTA` (padrão `8925231246`, Plus Size Ecomm), `LISTA_NOME`,
`LISTA_DESC`, `LISTA_ARQUIVO`, `LISTA_ID` (pra reenviar numa lista que já
existe — é assim que se **atualiza** a lista todo mês, em vez de criar outra).

## 3. Campanha Demand Gen de recompra

```bash
ROTULO=novidades INDICE=2 railway run --service flowops-lite node backend/scripts/google-customer-match/criar-demand-gen.js --aplicar
```

**Nasce PAUSADA** — texto de anúncio é a cara da marca e orçamento é dinheiro.
Ligar é um clique (ou `LIGAR=1`).

No ar desde 30/09/2026: **`[Claude] Demand Gen - novidades - compradoras`**
(campanha `24300304002`, grupo `202209914362`) — R$ 100/dia exclusivo,
MAXIMIZE_CONVERSIONS, produtos `custom_label_2 = novidades` × compradoras dos
12 meses (lista `9479548071`).

### Como o feed é recortado

| | conteúdo | peças |
|---|---|---|
| `custom_label_0` | subcategoria | todas |
| `custom_label_1` | coleção pontual (`colecao-resort`) | 9 |
| `custom_label_2` | **novidades** (últimas 25 cadastradas) | 43 |
| `custom_label_3` | **conforto** (Linha Conforto) | 40 |

🚨 **Não filtre Linha Conforto por `product_type`.** Lá só aparecem as **3**
peças cuja categoria PRIMÁRIA é `linha-conforto`; as outras 37 entram como
`t-shirts-premium`/`blusas`/`vestidos`, porque Linha Conforto é categoria de
CAMPANHA (`categorias_extras`) e o `product_type` leva só a primária. É o
`custom_label_3` que enxerga as 40 — e uma campanha filtrando errado acha 3
peças **sem dar erro nenhum**.

### Quatro recusas da API que custaram tempo

1. **`contains_eu_political_advertising` é obrigatório** na criação da campanha.
   Sem ele: "The required field was not present", apontando pro campo.
2. **Demand Gen não aceita a lista pendurada no grupo** — "Audience segment
   attachment is not allowed when use audience grouped bit is set to true". A
   lista tem que virar um recurso `Audience`, e é ele que vira critério.
3. **`DemandGenProductAd` leva UM título e UMA descrição** (não são campos
   repetidos), e `businessName` é um `AdTextAsset`, não string. Pra vários
   títulos em teste, o formato é `DemandGenMultiAssetAd`.
4. **A árvore de produtos precisa do galho "todo o resto"** excluído. Só o
   galho incluído deixa a partição incompleta e o Google recusa.

Se o Google recusar no meio, passe `GRUPO_ID=<id>` e o script **retoma** em vez
de deixar campanha órfã pra trás.

## 4. Conferir o match

```powershell
$env:LISTA_ID = '9479548071'; railway run --service flowops-lite node backend/scripts/google-customer-match/conferir-lista.js
```

Sem `LISTA_ID` mostra todas as listas de contato da conta. **Tamanho 0 logo
depois de subir é esperado** — o Google casa os hashes em algumas horas.

⚠️ O terminal do dono é **PowerShell 5.1**: `&&` e `VAR=1 comando` não existem
lá. Use `;` e `$env:VAR = '1'`.

## As três pegadinhas que custaram tempo

1. **O caminho clássico da Google Ads API não serve mais.** Desde **01/04/2026**
   o Google recusa `OfflineUserDataJobService`/`UserDataService` de Customer
   Match quando o projeto Google Cloud nunca mandou Customer Match antes — e o
   nosso nunca mandou. É **Data Manager API**, a mesma que o
   `google-ads.service.ts` já usa pras conversões desde 23/08/2026, com a mesma
   credencial. Lá não vão `developer-token` nem `login-customer-id` no header
   (mandar é 400); a conta vai no corpo, em `destinations[]`.
2. **`encoding: 'HEX'` no topo do corpo, e e-mail sempre em SHA-256.** Sem o
   `encoding` é 400 seco mesmo com o hash certo; texto puro é recusado. Só no
   upload pela TELA é que vai texto puro, porque o navegador hasheia.
3. **Não "limpe" gmail.** O guia do Google manda tirar ponto e `+tag`; não tire.
   Se o Google já normaliza, tirar não ganha nada; se não normaliza, você trocou
   o endereço real da cliente por um que não existe e o match some.

Mais duas que não são código:

- `customerMatchTermsOfServiceStatus: ACCEPTED` é uma **afirmação** de que os
  Termos de Dados de Clientes foram aceitos **na conta** — aceite humano, na
  tela do Google Ads. Por isso o script só manda o campo com `TERMOS_ACEITOS=1`.
- O Google recomenda **no mínimo 5.000 membros** pra ter chance de casar gente
  ativa o bastante pra servir anúncio. Em 28/09/2026 a lista deu **5.591**.
