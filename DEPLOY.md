# FlowOps Lite — Deploy Cloud (Railway + Vercel)

Guia rápido pra subir o FlowOps na nuvem, do zero.

> **O ambiente de produção já existe** — Railway (projeto `heroic-mercy`) + Vercel, com
> deploy automático a cada push na `main`. Este guia serve pra recriar do zero ou montar
> um ambiente novo. Pro dia a dia, o que interessa é a seção **Rotina depois**.

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

## Etapa 2 — (histórico, pule) DELETAR o projeto errado no Railway

> Passo de 2024, guardado só como registro: na montagem original havia um projeto
> `rare-inspiration` (template do N8N que entrou sem querer) ocupando o crédito do trial.
> Ele já foi apagado — **num ambiente novo esse projeto não existe**, então pule direto
> pra Etapa 3.

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

O mínimo pra subir de pé:

```
NODE_ENV=production
JWT_SECRET=<gera uma string aleatoria de 64+ chars>
JWT_ACCESS_TTL=8h
JWT_REFRESH_TTL=7d

FRONTEND_URL=https://flowops-lite.vercel.app
```

> `FRONTEND_URL` você só sabe **depois** que subir no Vercel (etapa 4). Por ora deixa vazio ou põe `*` e ajusta depois.

O resto (gateways de pagamento, WhatsApp, transportadoras, Meta/Google Ads, IA) é por
integração e só é necessário pra ligar aquela função específica. **Essas chaves não estão
versionadas**: elas vivem no painel do Railway (Variables) do projeto atual — o
`.env.example` cobre só banco, login, IA e Live. O efeito de cada flag de comportamento
está no `CLAUDE.md`.

> ⚰️ **Não configure ERP nem WordPress.** Encerrados em 27/08/2026: o WordPress/WooCommerce
> da KingHost foi apagado, e o MySQL do ERP Giga/Wincred (no host do fornecedor) parou de
> aceitar o IP do Railway. Não há `ERP_HOST`, `ERP_USER`, `ERP_PASSWORD` nem `WP_DB_*` /
> `WC_*` pra preencher — o Postgres do Flow é a fonte da verdade de estoque, venda,
> catálogo, crediário, clientes e financeiro.
>
> ⚠️ Mas **`ERP_WRITE_ENABLED=true` e `PDV_ERP_OUTBOX` não são desse bloco**: o "ERP" no
> nome é herança e elas governam a baixa de estoque NO POSTGRES (bipe da separação,
> `approveDebit`, baixa da live, baixa da venda do PDV). Ambiente novo sobe de pé sem
> elas, mas o bipe fica em modo shadow — leia os AVISOS VITAIS do `CLAUDE.md`.

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
3. Abre uma tela que lê dados (ex: **Carrinhos** ou **Faturamento**) → tem que listar
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

**Mas nem todo push redeploya, e nem toda hora serve:**

- O Railway só rebuilda o que toca `backend/**` ou `railway.json` (`watchPatterns`), e os
  `vercel.json` têm `ignoreCommand` por pasta. Push que não toca essas pastas **não
  redeploya nada** — é de propósito.
- 🕐 **Mexeu em `backend/`?** O sistema fica **fora ~1 minuto** quando sobe (o volume
  anexado impede overlap) e os caches esfriam. Espere a loja fechar: almoço (~13h) ou
  depois das 19h30. Três deploys em horário de loja aberta já viraram reclamação de
  "sistema travando muito" (01/09). Só hotfix que não pode esperar fura a janela.
- Mexeu só no site/retaguarda/docs? Pode subir a qualquer hora — o backend nem reinicia.

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

**Deploy do backend ficou QUEUED por horas**
→ Antes de mexer no código, confere o `uptime` no `/api/health`: se não reiniciou, o
build nem rodou (fila do provedor), e não é bug seu.
