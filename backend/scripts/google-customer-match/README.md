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

## 1. Gerar (só lê o banco)

```bash
railway link --project heroic-mercy --environment production --service Postgres
railway run node backend/scripts/google-customer-match/gerar-lista.js
```

Gera três CSVs nesta pasta (o `.gitignore` impede que e-mail de cliente vá pro
git):

| arquivo | o que é |
|---|---|
| `site-12m-email.csv` | uma coluna, só o e-mail — **é o que sobe** |
| `site-12m-email-sha256.csv` | o mesmo já hasheado (a API exige hash) |
| `site-12m-completo.csv` | as MESMAS pessoas com telefone, nome, país e CEP |

O `completo` existe porque mais identificador = mais gente casada. A ordem de
28/09 foi "só e-mail", então ele fica de reserva — trocar é mudar
`LISTA_ARQUIVO`.

## 2. Subir

```bash
railway link --project heroic-mercy --environment production --service flowops-lite
railway run node backend/scripts/google-customer-match/subir-lista.js            # ensaio a seco
TERMOS_ACEITOS=1 railway run node backend/scripts/google-customer-match/subir-lista.js --aplicar
```

Sem `--aplicar` nada é criado nem enviado: o Google só confere. Com `--aplicar`
a lista é criada e, **antes de qualquer e-mail subir**, um lote de 10 passa por
uma validação a seco — se faltar aceite de termos ou a conta não for elegível, o
erro aparece com a lista ainda vazia.

Variáveis: `LISTA_CONTA` (padrão `8925231246`, Plus Size Ecomm), `LISTA_NOME`,
`LISTA_ARQUIVO`, `LISTA_ID` (pra reenviar numa lista que já existe).

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
