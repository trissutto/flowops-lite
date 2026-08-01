# Conferência de comissão — quem está recebendo por quem

Gerado a partir das vendas finalizadas dos últimos 120 dias.
Cobre só as vendas cujo `seller_id` é o **código do Wincred** (as que usam o id da ficha já estão corretas).

## Resumo

| Situação | Vendas | Valor |
|---|---:|---:|
| ✅ Correto | 49 | R$ 1.556.083,27 |
| ❌ **Cai na vendedora de OUTRA loja** | 11 | **R$ 181.031,91** |
| ⚠️ **Código sem dona — some da comissão** | 16 | **R$ 129.554,47** |
| 🔤 Só grafia diferente (mesma loja) | 10 | R$ 52.118,44 |

## ❌ Caindo na vendedora errada

A coluna "cai hoje em" é quem está levando essa venda na comissão.

| Loja | Quem vendeu | Valor | Vendas | Cai hoje em | Deveria ser |
|---|---|---:|---:|---|---|
| 05 PIRACICABA | **LIVIA** | R$ 46.928,67 | 118 | PATRICIA (loja 02) | Livia Maria Funari Dos Santos |
| 14 PRAIA GRANDE | **PAMELA** | R$ 32.772,38 | 70 | ELLEN (loja 10) | PAMELA NOVA |
| 07 CAMPINAS | **DANI** | R$ 30.504,33 | 69 | PATRICIA (loja 02) | Danieli Fernanda Pintao Alves |
| 11 LIMEIRA | **EDNA** | R$ 28.694,41 | 55 | MARIA (loja 01) | EDNA |
| 14 PRAIA GRANDE | **PRISCILA** | R$ 12.634,48 | 28 | SILMARA (loja 06) | PRISCILA |
| 08 SÃO JOSÉ DOS CAMPOS | **RAFA** | R$ 12.260,76 | 51 | AMANDA (loja 03) | Rafaela Aparecida Arantes Silva |
| 18 Anália Franco | **NOH** | R$ 8.154,50 | 16 | MARCIA (loja 17) | ⚠ ficha não encontrada |
| 13 SITE | **KARINE** | R$ 8.032,88 | 35 | PATRÍCIA (loja 09) | Karine Suellen Brito Da Fonseca |
| 13 SITE | **GRAZI** | R$ 459,80 | 2 | YASMIN (loja 05) | Grazielle Alcântara Silva |
| 07 CAMPINAS | **ELAINE** | R$ 449,80 | 1 | PATRICIA (loja 02) | Elaine Verginio |
| 15 Moema | **ALEXANDRA** | R$ 139,90 | 1 | MAYARA (loja 01) | ALEXANDRA |

## ⚠️ Código sem dona — essas vendas somem da comissão

Ninguém recebeu comissão por elas. A coluna "provavelmente é" vem do nome gravado na própria venda.

| Loja | Código | Quem vendeu | Valor | Vendas | Período | Provavelmente é |
|---|---|---|---:|---:|---|---|
| 15 Moema | `14` | **INEZ** | R$ 55.012,32 | 82 | 2026-05-12 a 2026-07-21 | INEZ (ficha inativa) |
| 07 CAMPINAS | `84` | **ELAINE** | R$ 21.726,35 | 47 | 2026-06-29 a 2026-07-22 | Elaine Verginio |
| 15 Moema | `9` | **ELLEN** | R$ 9.735,04 | 48 | 2026-05-12 a 2026-07-21 | Ellen Leonel Nascimento |
| 04 INDAIATUBA | `145` | **MANU** | R$ 9.229,95 | 29 | 2026-07-08 a 2026-07-21 | ⚠ não achei ficha com esse nome |
| 10 JUNDIAÍ | `144` | **VANESSA** | R$ 8.969,18 | 27 | 2026-07-07 a 2026-07-21 | Vanessa Borges De Carvalho |
| 03 VINHEDO | `136` | **RENATA** | R$ 5.190,78 | 18 | 2026-07-08 a 2026-07-22 | Renata Kelle Dias (ficha inativa) |
| 11 LIMEIRA | `146` | **JULIANA** | R$ 3.919,05 | 15 | 2026-07-08 a 2026-07-21 | JULIANA SANTOS SILVA DE LIMA (ficha inativa) |
| 13 SITE | `123` | **MANUELLA** | R$ 3.615,76 | 12 | 2026-07-20 a 2026-07-20 | Manuella Mendonça Do Nascimento |
| 15 Moema | `13` | **HELLEN** | R$ 3.282,25 | 17 | 2026-05-13 a 2026-07-17 | Hellen Fernandes Teixeira |
| 03 VINHEDO | `Fab1328adbc27453399` | **BRENDA** | R$ 2.614,56 | 10 | 2026-07-28 a 2026-07-31 | Brenda Pires De Carvalho Oliveira |
| 17 Suzano | `137` | **JESSICA** | R$ 2.487,15 | 17 | 2026-07-07 a 2026-07-22 | Jessica Aparecida Da Silva Lozano |
| 02 SANTOS | `142` | **TELMA ROSANA MACENA** | R$ 1.658,83 | 5 | 2026-06-21 a 2026-07-03 | ⚠ não achei ficha com esse nome |
| 03 VINHEDO | `44` | **LIOMARA KELLY** | R$ 1.049,25 | 2 | 2026-07-08 a 2026-07-11 | LIOMARA KELLY (ficha inativa) |
| 08 SÃO JOSÉ DOS CAMPOS | `75` | **JESSICA SANTOS GONÇALVES** | R$ 589,45 | 3 | 2026-07-10 a 2026-07-11 | Jessica Santos Gonçalves |
| 02 SANTOS | `147` | **MARINA** | R$ 294,85 | 2 | 2026-07-14 a 2026-07-14 | Marina Da Silva Ferreira |
| 13 SITE | `85` | **TALINE** | R$ 179,70 | 1 | 2026-07-22 a 2026-07-22 | Taline Corrêa Batista |

## 🔤 Grafia diferente — conferir se é a mesma pessoa

Mesma loja, nomes parecidos. Se for a mesma mulher, não há erro de pagamento.

| Loja | Nome na venda | Ficha que recebe | Valor |
|---|---|---|---:|
| 17 Suzano | KAMILLA | KAMILA | R$ 21.179,99 |
| 18 Anália Franco | AMANDINHA | AMANDA | R$ 18.588,25 |
| 01 ITANHAÉM | MARIDALVA | ZORANTE | R$ 3.921,12 |
| 05 PIRACICABA | MARCELA BRUNA VALETIN | MARCELA | R$ 3.182,31 |
| 18 Anália Franco | GEO | GEOVANNA | R$ 2.253,97 |
| 04 INDAIATUBA | MILEANE | MILE | R$ 1.229,00 |
| 10 JUNDIAÍ | VANESSA | ARIADNE | R$ 649,60 |
| 01 ITANHAÉM | ELAINE CRISTINA GOMES DOS SANTOS | MARIANA | R$ 629,65 |
| 01 ITANHAÉM | MAYARA BELLO PEDROSO | MAYARA | R$ 309,70 |
| 10 JUNDIAÍ | ELLEN | ARIADNE | R$ 174,85 |

---

## Por que isso acontece

O `seller_id` da venda guarda o **código da funcionária no Wincred**. Esse código é
numerado **por loja** — cada loja começa do 1. Mas a comissão procura esse número numa
lista **global**, que só tem uma dona por número. Então o código 25 de Campinas
encontra a dona do código 25 de Santos.

O conserto é resolver o código **dentro da loja da venda**. Este relatório existe pra
você conferir os nomes ANTES de eu mexer no cálculo da comissão.
