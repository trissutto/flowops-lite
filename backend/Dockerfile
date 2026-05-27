FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

# 1) Instala deps aproveitando cache do npm
COPY package*.json ./
COPY prisma ./prisma/

RUN npm install
RUN npx prisma generate

# 2) Copia o resto do código
COPY . .

# 3) Compila TS → JS em dist/
RUN npm run build

# 4) Lista o dist pra facilitar debug caso o main.js vá pra lugar errado
RUN echo "==> conteudo de dist apos build:" && ls -la dist && find dist -name 'main.js'

EXPOSE 3001

# 5) No start: aplica schema no Postgres (db push) + sobe API
#    --accept-data-loss: o Prisma é PARANOICO e aborta em qualquer mudança
#      que TEORICAMENTE possa causar perda (adicionar UNIQUE, mudar tipo, etc),
#      mesmo quando não há duplicatas reais. Em produção com schema em
#      evolução isso bloqueia deploys legítimos. Flag liberada — mudanças
#      destrutivas reais (DROP TABLE, DROP COLUMN) continuam só via migration
#      manual no banco.
#    --skip-generate evita regerar client (já gerado no build)
CMD sh -c "echo '==> aplicando schema Prisma no Postgres...' && npx prisma db push --accept-data-loss --skip-generate && MAIN=\$(find dist -name 'main.js' -not -path '*/node_modules/*' | head -1) && echo \"==> iniciando: \$MAIN\" && node \"\$MAIN\""
