# Performance

Meta: **Lighthouse ≥ 95** nas quatro categorias, LCP < 2,5s.

## Estado atual (Sprint 005)

```
/                    105 kB  |  First Load JS 314 kB   (estática)
/categoria/[slug]    105 kB  |  First Load JS 314 kB   (SSG + ISR 1h)
CSS compartilhado                              12,8 kB
```

**Dívida conhecida:** o First Load JS de ~314kB vem do Framer Motion entrar no
bundle compartilhado (quase todo componente editorial anima). Plano para a
Sprint 017:

1. `next/dynamic` nas seções abaixo da dobra (Instagram, depoimentos, vídeo,
   editorial) — corta ~60–80kB do carregamento inicial.
2. Trocar `motion.div` por `m` + `LazyMotion` com `domAnimation`, que carrega
   só o subconjunto de features usado.
3. Substituir animações puramente decorativas por CSS (`@keyframes`) onde o
   framer não agrega.
4. Medir com Lighthouse em build de produção (não em dev — dev é sempre pior).

## Práticas em vigor

**Imagens**
- `next/image` sempre; nunca `<img>` (exceto decorativa explicitamente
  comentada).
- AVIF → WebP (negociado pelo `Accept`), configurado em `next.config.ts`.
- `sizes` correto em toda imagem — sem isso o browser baixa a maior versão.
- `placeholder="blur"` com `BLUR_DATA_URL` champagne (evita flash branco).
- `priority` **só** na imagem do hero (a LCP). Todo o resto é lazy.
- `deviceSizes`/`imageSizes` alinhados com os `sizes` reais dos cards.

**Fontes**
- `next/font` (self-host, zero requisição a terceiro).
- Só os pesos usados: Playfair 400/500/600/700, Inter 300/400/500/600.
- `display: swap` — texto aparece antes da fonte carregar.

**JavaScript**
- Server Components por padrão; client só nas ilhas interativas.
- `optimizePackageImports` em `lucide-react` e `framer-motion`.
- Sem lib de UI pesada: overlays, tabs e acordeão são próprios.
- Carrossel: Embla (~5kb) em vez de Swiper (~40kb).

**Renderização**
- Home estática.
- Categorias: SSG com `generateStaticParams` + ISR de 1h.
- Skeleton com a silhueta final (CLS ~0).

**Rede**
- `minimumCacheTTL` de 30 dias nas imagens otimizadas.
- Prefetch automático do `next/link` nos links de navegação.

## Como medir

```bash
npm run build
npm start
# Lighthouse no Chrome, aba Incognito, contra localhost:3000
```

Nunca medir em `npm run dev`: o dev server não minifica e infla o resultado.
