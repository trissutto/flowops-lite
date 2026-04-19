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

# 5) Script shell que acha o main.js onde estiver e executa
CMD sh -c "MAIN=\$(find dist -name 'main.js' -not -path '*/node_modules/*' | head -1) && echo \"==> iniciando: \$MAIN\" && node \"\$MAIN\""
