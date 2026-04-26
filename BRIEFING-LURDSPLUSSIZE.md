# 📋 BRIEFING — Site Novo Lurd's Plus Size

> **Próxima sessão**: Cola este arquivo (ou pede pra Claude ler `BRIEFING-LURDSPLUSSIZE.md`) e a construção continua do ponto certo.

---

## 🎯 Visão executiva

Construir **e-commerce próprio do zero**, sem WordPress, no domínio `lurdsplussize.com.br`. MVP em **90 dias** (deadline ~25 de julho de 2026). Foco: **alta conversão pra plus size feminino**.

**Decisão chave**: abandonar WP/WooCommerce/Flatsome (loja atual `lurds.com.br`) e migrar para stack moderna controlada 100% pela Lurd's. Faturamento atual loja online: ~R$ 100k/mês.

---

## ✅ Decisões já tomadas

| Decisão | Valor |
|---|---|
| Domínio do site novo | `lurdsplussize.com.br` (já registrado, está na Cloudflare da conta) |
| Deadline MVP | 90 dias (~25/07/2026) |
| Quem constrói | Claude (com Thiago como product owner, modelo igual ao FlowOps) |
| Faturamento alvo | R$ 100k/mês inicial, escalar a partir daí |
| Stack | Medusa.js + Next.js 15 + PostgreSQL (Railway) |
| Migração | Importar **clientes** + **histórico de pedidos** do WC. Catálogo é **curado do zero** (só top-sellers, evitar produto morto) |
| Logo | SVG vetor real `LOGOTIPO LURDS.svg` aprovado (cor `#201E1E`). Precisa: recortar viewBox A4, gerar versão branca, mark-only e favicon |

---

## 🏗️ Stack técnica definitiva

```
Frontend:    Next.js 15 (App Router) + TypeScript + Tailwind + Shadcn/ui
E-commerce:  Medusa.js (open source, Node.js, self-hosted)
Banco:       PostgreSQL (Railway, mesma instância pode ser separada do FlowOps)
Pagamento:   Pagar.me (já em uso na loja antiga) + Pix direto
Frete:       Melhor Envio API
Imagens:     Cloudflare Images
Email:       Resend
CDN:         Cloudflare Pro (já contratado, plano da conta atual)
Hosting:     Vercel (frontend) + Railway (backend Medusa + Postgres)
Monitoring:  Plausible ou PostHog (decidir no Sprint 4)
```

### Por que essa stack ganhou
- Stack idêntica ao **FlowOps** (Node + TypeScript + Postgres + Prisma) → reaproveita conhecimento e integra natural
- Medusa.js dá carrinho/checkout/admin/inventário **prontos** → foco no diferencial de UX plus size, não em reinventar e-commerce
- Self-hosted = controle 100%, sem lock-in tipo Shopify
- Custo operacional baixo: **R$ 400-600/mês** (vs R$ 300+ atual com plugins WP)

### Por que NÃO outras opções
- **Shopify Plus**: USD 2k+/mês, lock-in, perde integração com FlowOps/Gigasistemas
- **VTEX**: caro, lento pra customizar
- **Magento**: pesado, mesma dor do WP
- **Bagy/Nuvemshop**: limitado, sem flexibilidade pra features plus size custom
- **Construir 100% from scratch (sem Medusa)**: 6-8 meses só pra ter checkout funcionando

---

## 📅 Roadmap 90 dias (4 sprints × 3 semanas)

### Sprint 1 — Fundação (semanas 1-3)
- Repos GitHub (org `lurds-plus-size` ou similar): `lurdsplussize-storefront`, `lurdsplussize-medusa`
- Medusa.js rodando em Railway
- Next.js storefront na Vercel
- DNS `lurdsplussize.com.br` apontando para Vercel + Cloudflare proxy
- Design system: paleta de cores, tipografia, header/footer/buttons base
- Logo otimizado (preto, branco, mark-only) + favicon + apple-touch + og-image

### Sprint 2 — Catálogo (semanas 4-6)
- Admin Medusa configurado
- Cadastro de **100-200 produtos curados** (Thiago seleciona top-sellers via CSV)
- Variações: tamanho (P, M, G, GG, G1, G2, G3, G4) + cor
- Imagens otimizadas via Cloudflare Images
- Páginas: Home, Categoria, PDP (página de produto), Busca, Contato

### Sprint 3 — Compra (semanas 7-9)
- Carrinho + cupons
- **Checkout 1 página** com auto-fill CEP
- Integração Pagar.me (cartão + Pix)
- Melhor Envio com cotação real (PAC, SEDEX, Mini Envios)
- Email transacional via Resend (pedido confirmado, enviado, entregue)
- Painel "Meus pedidos" do cliente
- **Integração com FlowOps** — pedidos do site novo entram na mesma rota das 4 lojas físicas

### Sprint 4 — Diferenciais + Launch (semanas 10-12)
- **Calculadora de tamanho** (busto/cintura/quadril → tamanho recomendado)
- WhatsApp Business no PDP
- Reviews básico (5 estrelas + comentário + foto opcional)
- Migração de **clientes** do WC → Medusa (CSV)
- Migração de **histórico de pedidos** WC → Medusa (CSV, só pra "Meus Pedidos", não reativa)
- GTM novo configurado (mantém GA4 `G-WG47PQ059F` e Meta Pixel `1175057803035158` da loja atual)
- **Soft launch** com 10% do tráfego de Ads pro novo (A/B real)

---

## 🚫 Fora do MVP — vai para Sprint 5+ (pós-launch)

- Manequim virtual com IA / try-on
- Live shop integrado (Karine/Manu vestindo)
- Pix progressivo cashback (R$2 a cada R$50)
- Quiz de estilo plus size (lead magnet)
- Wishlist + alerta de reposição
- Marketplace integrations (Mercado Livre, Amazon)
- Programa de afiliados / influencer
- Blog/conteúdo SEO

---

## 💎 Features killer plus size (priorizadas)

| Feature | Sprint | Impacto esperado |
|---|---|---|
| Calculadora de tamanho real (busto/cintura/quadril) | 4 | +25% conversão |
| Filtro por **medida real** (não só P/M/G) | 4 | -30% devolução |
| Garantia "veste ou troca em 7 dias" destacada | 3 | -50% abandono carrinho |
| Reviews só com clientes plus size verificadas + foto | 4 | +35% confiança |
| Manequim virtual / IA com altura/peso variável | 5+ | +40% engajamento |
| Quiz "Qual seu estilo plus?" lead magnet | 5+ | captura email + segmenta |
| Pix progressivo cashback | 5+ | +15% AOV |
| Live shop mensal (UGC) | 5+ | +60% engajamento mobile |
| Checkout 1-clique cliente recorrente | 3 | +20% conversão |
| WhatsApp Business no PDP | 4 | +12% conversão geral |

---

## 💰 Custos operacionais (estimativa mensal)

| Serviço | Custo (USD) | Custo (BRL aprox) | Já tem? |
|---|---|---|---|
| Vercel Pro | 20 | 120 | Não |
| Railway Pro | 20-50 | 120-300 | Sim (FlowOps) |
| Cloudflare Pro | 20 | 120 | ✅ Sim |
| Cloudflare Images | 5 | 30 | Não |
| Resend (email) | 0-20 | 0-120 | Não |
| Pagar.me | taxa por transação 2.99% | já paga | ✅ Sim |
| Melhor Envio | grátis | 0 | Não |
| Domínio | já paga | já paga | ✅ Sim |
| **TOTAL extra** | **~70-115** | **~R$ 400-700** | — |

Atual loja WP gasta provavelmente R$ 300+ só com plugins + hospedagem extra (Hostinger/Linode), então **custo operacional do novo site é equivalente ou menor** que o atual.

---

## 🚀 Próxima ação CONCRETA (sessão nova)

**Pra começar Sprint 1, Thiago precisa providenciar:**

1. **GitHub** — criar org `lurds-plus-size` (ou usar conta existente). Convidar Claude.
2. **Conta Vercel** — `vercel.com` → Sign up (use GitHub) → free tier inicial
3. **Conta Railway** — já tem do FlowOps. Criar projeto novo `lurdsplussize-prod`
4. **DNS `lurdsplussize.com.br`** — confirmar que está na Cloudflare (vimos na sessão anterior que sim, junto com `lurds.com.br` e `reservasita.com.br`)
5. **Logo finalizado** — `LOGOTIPO LURDS.svg` enviado (precisa apenas processar: recortar viewBox + gerar variações)

Com isso na mão, Claude monta a estrutura no **dia 1 da nova sessão** e em ~1 semana o `lurdsplussize.com.br` já mostra "Hello World" rodando.

---

## 📁 Estrutura de pastas planejada

```
lurdsplussize/
├── apps/
│   ├── storefront/          # Next.js 15 (frontend cliente)
│   └── medusa/              # Backend Medusa.js (admin + API)
├── packages/
│   ├── ui/                  # Shadcn components compartilhados
│   ├── tipografia/          # Tokens de design
│   └── icons/               # Logos, ícones SVG
├── docs/
│   ├── BRIEFING.md          # este arquivo
│   ├── ROADMAP.md
│   ├── ARCHITECTURE.md
│   └── adr/                 # Architecture Decision Records
└── README.md
```

---

## 🧠 Lições do site atual (NÃO repetir)

Da sessão de tentativa de otimização do `lurds.com.br` (25/04/2026):

1. **Plugin sprawl mata performance** — 30 plugins ativos no WP. Site novo: zero plugins, código próprio.
2. **Lighthouse 48 mobile** com Core Web Vitals aprovado (LCP 2.5s campo). Limite estrutural do WP/Flatsome.
3. **3 trackers Google duplicados** + FB Pixel standalone = 581 KB de tracking bloqueante. Site novo: GTM único, server-side via container `lurds.com.br [SERVER]` já existente.
4. **Delay JS quebra widgets custom** do Flatsome ("Compre por Tamanho" travou). Site novo: tudo é JS próprio, sem delay agressivo.
5. **TTFB 1.5s** porque HTML não cacheia (cf-cache-status DYNAMIC). Site novo: SSG/ISR do Next.js 15 + Vercel CDN = TTFB <200ms nativo.
6. **Lazy load do tema** afetando imagens above-the-fold. Site novo: controle total via `next/image` com `priority` na hero.
7. **APO foi instalado/desinstalado** — o plugin oficial Cloudflare ficou conectado na conta WP atual com token de API. **Avaliar remoção** quando migrar pro site novo.

---

## 🔗 Referências e contexto

- **Loja atual**: https://lurds.com.br (WordPress + WooCommerce + Flatsome)
- **Sistema operacional interno**: FlowOps / LURDS ORDER ONE (Next.js + NestJS, mesma stack do site novo)
- **ERP**: Gigasistemas (MySQL, integração via FlowOps)
- **Cloudflare**: conta `Thiago@lurds.com.br`, plano Pro, 3 domínios (lurds.com.br, lurdsplussize.com.br, reservasita.com.br)
- **GTM**: container `GTM-PTFZN3DT` (web) + `lurds.com.br [SERVER]` (server-side)
- **GA4**: `G-WG47PQ059F`
- **Meta Pixel**: `1175057803035158`
- **Pagar.me**: já integrado na loja atual, reusar credenciais

---

## 📅 Histórico

- **25/04/2026** — Briefing criado, decisões fechadas, logo recebido. Stack definida.
- **Próxima sessão** — Setup Sprint 1: repos, Vercel, Railway, DNS, design system base.
