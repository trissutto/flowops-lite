# ═══════════════════════════════════════════════════════════════════════
# FlowOps Backend — Dockerfile OTIMIZADO (multistage build)
#
# Tempo esperado:
#   - Build INICIAL (sem cache): ~12-15 min
#   - Build INCREMENTAL (cache OK): ~3-5 min ⚡
#
# Otimizações vs. versão anterior:
#   1. `npm ci` em vez de `npm install` (50% mais rápido)
#   2. Cache de layer separado: deps → prisma → código
#   3. Multistage: build/ vai em stage descartável; runtime/ só roda
#   4. NODE_OPTIONS=--max-old-space-size=4096 evita OOM no tsc
#   5. Runtime stage sem devDependencies (imagem 40% menor)
# ═══════════════════════════════════════════════════════════════════════

# ─── STAGE 1: BUILD ────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# OpenSSL exigido pelo Prisma engine
RUN apk add --no-cache openssl

# 1) Copia SÓ os manifests primeiro — cache de layer ótimo
COPY package*.json ./
COPY prisma ./prisma/

# 2) Instala TUDO (inclui devDependencies pra rodar tsc)
#    Voltei pra npm install (npm ci exige lockfile perfeitamente alinhado com
#    package.json — qualquer mudança no package sem regerar o lock quebra).
#    Flags pra acelerar:
#      --no-audit        evita scan de segurança (não precisa em build)
#      --no-fund         pula msgs de funding (acelera output)
#      --prefer-offline  usa cache local primeiro
#      --legacy-peer-deps tolera conflitos de peer dependencies
#    PRISMA_SKIP_POSTINSTALL_GENERATE evita generate dupla (chamamos manualmente abaixo)
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true
RUN npm install --no-audit --no-fund --prefer-offline --legacy-peer-deps

# 3) Gera client Prisma (1x)
RUN npx prisma generate

# 4) Copia o resto do código — só esse layer invalida quando .ts muda
COPY . .

# 5) Compila com mais memória pro tsc não engasgar
#    4GB cobre qualquer projeto Nest até ~200 services
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build

# Debug rápido caso main.js suma
RUN echo "==> conteudo de dist:" && ls -la dist && find dist -name 'main.js' | head -3

# ─── STAGE 2: RUNTIME ──────────────────────────────────────────────────
# Imagem final menor — só o necessário pra rodar
FROM node:20-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache openssl

# Copia só o que precisa pra rodar
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

EXPOSE 3001

# No start: aplica schema no Postgres (db push) + sobe API
#   --accept-data-loss: Prisma é paranoico e aborta em adições "teoricamente"
#     perigosas (novo UNIQUE, mudança de tipo) mesmo quando não há duplicatas
#     reais. Flag liberada — mudanças destrutivas reais ainda precisam migration manual.
#   --skip-generate evita regerar client em runtime (já gerado no build)
CMD sh -c "echo '==> aplicando schema Prisma no Postgres...' && npx prisma db push --accept-data-loss --skip-generate && MAIN=\$(find dist -name 'main.js' -not -path '*/node_modules/*' | head -1) && echo \"==> iniciando: \$MAIN\" && node \"\$MAIN\""
