# Integração com o FlowOps

Como o ecommerce fala com o backend NestJS — catálogo hoje, CRM a seguir.

## Regra de ouro: só o servidor chama o backend

`lib/api.ts` importa `server-only`. Componente client **nunca** importa esse
módulo; quando precisar do backend, o caminho é uma Route Handler em
`app/api/*` (BFF).

Três motivos:

1. **CORS.** Em produção o backend só aceita as origens de `FRONTEND_URL`
   (`main.ts`: `cors: { origin: frontendUrl }`). O domínio deste ecommerce não
   está nessa lista — chamada do navegador seria bloqueada. Server-to-server
   não passa por CORS, então nada precisa ser reimplantado no backend.
2. **Segurança.** URL da API e tokens ficam fora do bundle.
3. **Cache.** O `fetch` do Next revalida no servidor de graça.

## Variáveis

| Env | Onde | Para quê |
|---|---|---|
| `FLOWOPS_API_URL` | Vercel (server) | URL do Nest **com `/api`** no fim |
| `NEXT_PUBLIC_SITE_URL` | Vercel (Produção) | canonical / Open Graph |

Sem `FLOWOPS_API_URL` o catálogo devolve vazio e a página de produto dá 404 —
por escolha: default chutado falha em silêncio e ninguém descobre o porquê.

## Catálogo (entregue)

`services/catalog.ts` — adaptador entre o backend e o tipo `Product`.

| Função | Endpoint | Cache |
|---|---|---|
| `listProducts()` | `GET /public/vitrine` | 5 min, tag `catalogo` |
| `getProduct(slug)` | `GET /public/vitrine/:slug` | 2 min |
| `getRelated(slug)` | `GET /public/vitrine/:slug/related` | 10 min |

⚠️ **A fonte hoje é o WooCommerce.** `ProductsService` do backend lê
`WC_URL/wp-json/wc/v3/products` — ou seja, o catálogo do site que este projeto
vai substituir. É ponte consciente: os produtos são os mesmos. Quando a tabela
nativa `product` (Postgres) ganhar endpoint público, **só este arquivo muda**.

⚠️ **O detalhe consulta o Giga.** `getById` chama `erp.getStockTotalBySkus`
pra estoque das variações. O Giga pendura sem devolver erro quando o firewall
por IP derruba o Railway (histórico do projeto). Por isso:

- todo `fetch` tem `AbortController` com timeout (12s no detalhe, 8s no resto);
- listagens usam `apiSafe`, que devolve fallback e mantém a página de pé;
- a página de produto trata falha como 404 em vez de estourar.

### Mapeamento

O WooCommerce não entrega os campos no formato da marca, então o adaptador
deriva:

| Campo do site | De onde vem |
|---|---|
| `category` | primeira categoria do WC → slug canônico (`CATEGORY_MAP`) |
| `fabric` | detectado no nome/categorias (viscolycra, jeans, linho…) |
| `sizes` | atributo "tamanho" das variações; estoque do **ERP** tem precedência sobre o do WC |
| `badges` | `promocao` (sale < regular), `best-seller` (≥30 vendas), `novo` (modificado < 30 dias) |
| `pixPrice` | 5% off (convenção da marca) |
| `installments` | 12x sem juros |

Produto simples (sem variações) assume a grade 46–60 com a disponibilidade do
próprio item — o WC não detalha por número nesse caso.

## CRM / conta do cliente (próxima etapa)

**Decisão travada com o dono (30/07): conta única.** A cliente que já tem
conta no app PWA entra no site com o mesmo login, e a ficha é a mesma do CRM.
Nada de base paralela.

O backend **já tem** tudo pronto no módulo `customers-app` (é o que serve o
app `app.lurds.com.br`), com JWT de escopo `customer`:

| Endpoint | Uso no site |
|---|---|
| `GET /customers/app/lookup?cpf=` | pré-preencher cadastro se o CPF já existe |
| `POST /customers/app/register` · `login` | criar conta / entrar |
| `POST /customers/app/forgot-password` · `reset-password` | recuperação |
| `GET/PATCH /customers/app/me` | dados da cliente |
| `GET/POST/PATCH/DELETE /customers/app/addresses` | endereços do checkout |
| `GET /customers/app/orders` | "meus pedidos" |
| `GET /customers/app/cashback` | saldo e extrato |

**Como implementar (sem tocar no backend):** Route Handlers em
`app/api/conta/*` fazem proxy. O JWT do cliente vai num cookie
`httpOnly` + `secure` + `sameSite=lax` — nunca em `localStorage`, que é
legível por qualquer script.

```
navegador → /api/conta/login (Next)  →  POST /customers/app/login (Nest)
          ← Set-Cookie httpOnly       ←  { token, customer }
```

Assim o navegador nunca fala direto com o backend e o CORS segue irrelevante.

## O que ainda não está integrado

| Item | Situação |
|---|---|
| Login / cadastro | endpoints existem; BFF a construir |
| Cashback na vitrine | depende do login |
| Favoritos sincronizados | hoje só `localStorage` |
| Pedidos / rastreio | endpoint existe; tela a construir |
| Checkout | precisa de decisão de meio de pagamento |
| Estoque por loja | `availability.stores` vem vazio — o endpoint não expõe por unidade ainda |
