# FlowOps Lite — Deploy Cloud (Railway + Vercel)

Guia rápido pra subir o FlowOps na nuvem, do zero.

---

## Visão geral

- **Backend (NestJS + Postgres)** → Railway
- **Frontend (Next.js)** → Vercel
- **Repo (código)** → GitHub (privado)

Stack só usa serviço gratuito ou trial. Custo previsto: **R$ 0** durante teste, ~US$ 5/mês depois.

---

## Etapa 1 — GitHub (subir o código)

1. Cria repo vazio em https://github.com/new
   - Nome: `flowops-lite`
   - **Private**
   - **NÃO** marca "Add README" nem ".gitignore" nem "license" (deixa tudo desmarcado)
   - Clica **Create repository**
2. Copia a URL que aparece (ex: `https://github.com/trissutto/flowops-lite.git`)
3. Roda `subir-github.bat` na pasta `flowops-lite`
4. Quando pedir, cola a URL e aperta ENTER
5. Vai abrir popup do navegador pedindo login do GitHub — autoriza
6. Pronto, código no ar

---

## Etapa 2 — DELETAR o projeto errado no Railway

Antes de criar o novo, apaga o `rare-inspiration` (template do N8N que entrou sem querer):

1. Em https://railway.com/dashboard → clica no projeto `rare-inspiration`
2. **Settings** → role até o final → **Danger** → **Delete Project**
3. Digita o nome pra confirmar

Isso libera o crédito do trial pra usar no que importa.

---

## Etapa 3 — Railway (backend + Postgres)

### 3.1 Criar projeto

1. https://railway.com/dashboard → **+ New Project**
2. Escolhe **Deploy from GitHub repo**
3. Se for primeira vez, clica **Configure GitHub App** → autoriza acesso ao repo `flowops-lite`
4. Seleciona `trissutto/flowops-lite`
5. Railway detecta automaticamente que tem `railway.json` → começa a buildar

### 3.2 Adicionar Postgres

1. Dentro do projeto, clica **+ Create** → **Database** → **Add PostgreSQL**
2. Espera o Postgres ficar verde (~30s)
3. Railway injeta `DATABASE_URL` automaticamente no serviço backend

### 3.3 Setar variáveis de ambiente

Vai no serviço do backend → **Variables** → **+ New Variable** pra cada uma:

```
NODE_ENV=production
JWT_SECRET=<gera uma string aleatoria de 64+ chars>
JWT_ACCESS_TTL=8h
JWT_REFRESH_TTL=7d

WC_URL=https://seusite.com.br
WC_CONSUMER_KEY=ck_xxxxx
WC_CONSUMER_SECRET=cs_xxxxx
WC_WEBHOOK_SECRET=<sua chave webhook>

ERP_HOST=mysql.gigasistemas.com.br
ERP_PORT=3306
ERP_USER=<seu user ERP>
ERP_PASSWORD=<senha ERP>
ERP_DATABASE=gigasistemas21

FLOWOPS_WP_BASE=https://seusite.com.br/wp-json
FLOWOPS_WP_KEY=<mesma chave do plugin PHP>

FRONTEND_URL=https://flowops-lite.vercel.app
```

> `FRONTEND_URL` você só sabe **depois** que subir no Vercel (etapa 4). Por ora deixa vazio ou põe `*` e ajusta depois.

### 3.4 Gerar URL pública

1. Serviço backend → **Settings** → **Networking** → **Generate Domain**
2. Copia a URL (ex: `flowops-backend-production.up.railway.app`)
3. Testa: abre `https://essa-url/api/health` no navegador → tem que retornar `{"ok":true,...}`

---

## Etapa 4 — Vercel (frontend)

1. https://vercel.com → **Add New** → **Project**
2. **Import Git Repository** → seleciona `trissutto/flowops-lite`
3. **Root Directory** → clica **Edit** → escolhe `frontend`
4. Framework: detecta Next.js sozinho
5. **Environment Variables**:
   ```
   NEXT_PUBLIC_API_URL=https://flowops-backend-production.up.railway.app
   NEXT_PUBLIC_WS_URL=wss://flowops-backend-production.up.railway.app
   ```
6. Clica **Deploy**
7. Espera ~2 min → copia a URL final (ex: `https://flowops-lite.vercel.app`)

### 4.1 Voltar no Railway e atualizar CORS

1. Railway → backend → **Variables** → edita `FRONTEND_URL`
2. Cola a URL do Vercel
3. Salva → backend reinicia sozinho com CORS travado pro Vercel

---

## Etapa 5 — Testar

1. Abre a URL do Vercel
2. Login com seu usuário do FlowOps
3. Vai em **Carrinhos Abandonados** → tem que listar os mesmos dados do local
4. Pronto.

---

## Rotina depois

Toda vez que mexer no código local:

```
git add .
git commit -m "fix: descricao da mudanca"
git push
```

Railway e Vercel detectam o push e fazem redeploy automático em ~2 min. Sem ter que ir nos painéis.

---

## Custos estimados

| Serviço  | Trial          | Depois          |
|----------|---------------|-----------------|
| GitHub   | Grátis sempre | Grátis sempre   |
| Vercel   | Grátis sempre | Grátis sempre*  |
| Railway  | US$ 5 grátis  | ~US$ 5/mês**    |

\* Vercel Hobby: só uso pessoal/projetos sem ads. Se virar negócio sério, US$ 20/mês (Pro).
\*\* Backend small + Postgres pequeno. Escala conforme uso.

---

## Problemas comuns

**Build do Railway falha com "Prisma client not found"**
→ Confere se o `railway.json` tem `npx prisma generate` no `buildCommand`. Tem.

**Frontend mostra "Network error" no console**
→ `NEXT_PUBLIC_API_URL` no Vercel tá errado ou backend tá fora.
→ Testa `https://<railway-url>/api/health` no navegador — se voltar JSON, backend tá vivo.

**CORS error no console do browser**
→ `FRONTEND_URL` no Railway não bate com a URL real do Vercel.
→ Edita a variável → backend reinicia → testa de novo.

**Postgres "connection refused"**
→ `DATABASE_URL` no Railway tem que ser a interna (do plugin Postgres). Railway preenche sozinho — não edita manualmente.

**Webhook do WooCommerce não chega**
→ Vai no WP Admin → WooCommerce → Ajustes → Avançado → Webhooks → edita o webhook → muda a Delivery URL pra `https://<railway-url>/api/woocommerce/webhook`.
