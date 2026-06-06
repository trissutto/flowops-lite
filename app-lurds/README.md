# Lurd's Plus Size — App Cliente Final (PWA)

> Aplicativo instalável (PWA) pras clientes da Lurd's, hospedado em **app.lurds.com.br**.
> Mesmo código serve Android (Chrome) e iOS (Safari).

---

## 🎨 Visual

- **Cores:** Preto `#0A0A0A` + Branco + Dourado `#C9A961`
- **Tipografia:** Playfair Display (títulos serif elegante) + Inter (corpo sans-serif)
- **Cara:** App de luxo plus size

## 📦 Stack

- **Next.js 14** (App Router)
- **Tailwind CSS** (com paleta custom)
- **TypeScript**
- **Lucide React** (ícones)
- **PWA puro** (manifest + service worker manual — sem next-pwa pra ter controle)

---

## 🚀 Rodar localmente (dev)

```bash
cd app-lurds
npm install              # ~1-2 min na primeira vez
cp .env.example .env.local
# edita .env.local apontando pra api local ou Railway

npm run dev              # roda em http://localhost:3002
```

> O backend NestJS do flowops já tem que estar rodando (`backend/` em `npm run start:dev`).

---

## 🌐 Deploy no Vercel

### 1) Cria projeto novo no Vercel

```bash
cd app-lurds
npx vercel
```

Ou via UI: https://vercel.com/new — importa o repo flowops-lite e configura:
- **Root Directory:** `app-lurds`
- **Framework:** Next.js (auto-detect)
- **Build Command:** `npm run build` (padrão)
- **Output Directory:** `.next` (padrão)

### 2) Adiciona variáveis de ambiente

No painel Vercel → Settings → Environment Variables:

| Nome | Valor |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.flowops-lite.com` (URL do backend Railway) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | A mesma do flowops (`VAPID_PUBLIC_KEY` no Railway) |

### 3) Aponta o domínio app.lurds.com.br

No Vercel → Settings → Domains → Add:
- `app.lurds.com.br`

Vercel vai detectar automaticamente o CNAME que já está apontando (`cname.vercel-dns.com`). Em ~30s o SSL é emitido.

---

## 📱 Testar a instalação (PWA)

### Android
1. Abre `https://app.lurds.com.br` no Chrome
2. Chrome detecta o manifest → mostra banner "Adicionar à tela inicial" automaticamente
3. **OU** aparece o banner dourado interno do app após 5s
4. 1 clique → ícone fica na home do celular

### iOS (Safari) — pegadinha!
1. Abre `https://app.lurds.com.br` **no Safari** (não Chrome iOS)
2. Toca em "Como instalar" no banner dourado
3. Segue o tutorial visual (compartilhar → adicionar à tela)
4. iOS 16.4+ habilita push notifications **só depois** da instalação

---

## 🏗 Estrutura de arquivos

```
app-lurds/
├── public/
│   ├── manifest.webmanifest         # PWA manifest
│   ├── sw.js                        # Service Worker (cache + push)
│   ├── favicon.ico
│   ├── icons/                       # Ícones PWA (192, 512, maskable, apple)
│   └── images/
│       ├── logo-branco.png          # Logo sobre fundo escuro
│       ├── logo-preto.png           # Logo sobre fundo claro
│       └── logo.svg                 # Logo vetorial
├── src/
│   ├── app/
│   │   ├── layout.tsx               # Root layout (fontes, manifest, SW register)
│   │   ├── globals.css              # Tailwind + paleta + componentes
│   │   ├── page.tsx                 # HOME
│   │   ├── login/page.tsx           # Login CPF + senha
│   │   ├── cadastro/page.tsx        # Cadastro + bônus R$ 20
│   │   ├── cashback/page.tsx        # Saldo + extrato
│   │   ├── catalogo/page.tsx        # Catálogo (placeholder)
│   │   ├── conta/page.tsx           # Configurações
│   │   ├── install/ios/page.tsx     # Tutorial visual iOS
│   │   ├── privacidade/page.tsx     # Privacidade (Semana 1 final)
│   │   └── termos/page.tsx          # Termos (Semana 1 final)
│   ├── components/
│   │   ├── BottomNav.tsx            # Nav inferior 4 abas
│   │   └── InstallBanner.tsx        # Banner smart Android/iOS
│   ├── hooks/
│   │   └── usePWAInstall.ts         # Hook detecção + install prompt
│   └── lib/
│       ├── api.ts                   # Wrapper fetch com JWT
│       └── cpf.ts                   # Máscara + validação CPF
├── package.json
├── tailwind.config.ts               # Paleta Lurd's
├── next.config.mjs
└── README.md                        # Este arquivo
```

---

## 🎯 Próximas semanas

- **Semana 2** — Push notifications, cashback real, favoritos sync WC, aviso live
- **Semana 3** — Retaguarda gestão (`/retaguarda/app-*` no flowops) + QR Code PDV
- **Bônus** — Política de privacidade + Termos de uso

---

## 🐛 Troubleshooting

**Service Worker não registra**
- Confere se está em HTTPS (PWA exige). Em dev: localhost é OK.
- Confere DevTools → Application → Service Workers

**Banner de instalação não aparece**
- Android: precisa de HTTPS + manifest válido + ao menos 1 ícone 192×192
- iOS: NUNCA aparece banner automático (só via Safari → Compartilhar)

**Push notification não chega**
- Confere VAPID_PUBLIC_KEY no .env
- iOS: cliente PRECISA ter instalado o app (Add to Home Screen)
- Confere permissão no navegador (Settings → Notifications)
