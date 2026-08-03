import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

/**
 * BIGINT VIRA NÚMERO NO JSON — sem isto, salvar cliente dá 500.
 *
 * JSON não tem BigInt. Qualquer resposta que carregue uma coluna BigInt
 * (`customer.ltv_cents`, saldos de cashback, sequência do EAN) estoura
 * `TypeError: Do not know how to serialize a BigInt` DEPOIS do handler — o
 * Nest já respondeu 200 pro código, e o Express morre montando o corpo. Sai um
 * "500 Internal server error" mudo, sem stack de negócio, sem código do
 * Prisma.
 *
 * Foi exatamente o defeito do "salvar" do CRM (03/08): a gravação SEMPRE
 * funcionou — quem morria era a resposta, porque `customer.update()` devolve a
 * linha inteira, com `ltvCents`. Por isso até PATCH de corpo vazio dava 500, e
 * por isso ler o cliente ia bem: a leitura passa por projeção que converte.
 *
 * Volta número quando cabe em inteiro seguro (o caso de 100% dos nossos
 * campos, que são centavos) e string quando não cabe — melhor um id em texto
 * do que um valor silenciosamente arredondado.
 */
(BigInt.prototype as any).toJSON = function () {
  const n = Number(this);
  return Number.isSafeInteger(n) ? n : this.toString();
};

// Diagnóstico de startup (aparece SEMPRE, mesmo se Nest não conseguir iniciar)
console.log('==> [main.ts] ENTRANDO NO BOOTSTRAP');
console.log('==> NODE_ENV =', process.env.NODE_ENV);
console.log('==> PORT =', process.env.PORT);
console.log('==> DATABASE_URL =', process.env.DATABASE_URL ? '(set)' : '(MISSING)');

async function bootstrap() {
  console.log('==> [bootstrap] iniciando NestFactory.create...');
  // CORS — em prod aceita só FRONTEND_URL (Vercel). Em dev libera tudo.
  const isProd = process.env.NODE_ENV === 'production';
  const frontendUrl = process.env.FRONTEND_URL?.split(',').map((s) => s.trim()).filter(Boolean);

  const app = await NestFactory.create(AppModule, {
    cors: isProd && frontendUrl?.length
      ? {
          origin: frontendUrl,
          credentials: true,
        }
      : true, // dev: aceita qualquer origem
  });

  app.use(helmet());
  // Limite aumentado pro endpoint de restore (backup xlsx em base64 pode passar de 10MB).
  // `verify` salva o rawBody no request — necessário pra validação HMAC do webhook Stone.
  app.use(
    json({
      limit: '50mb',
      verify: (req: any, _res, buf) => {
        if (buf?.length) req.rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '50mb' }));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }));

  // Shutdown gracioso: no redeploy o Railway manda SIGTERM. Sem isto, o Node
  // morre no meio de requests em voo (venda de PDV/Live cortada) e os
  // onModuleDestroy — pool.end() do ERP, $disconnect do Prisma — nunca rodam.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3001;
  await app.listen(port, '0.0.0.0');

  Logger.log(`🚀 FlowOps backend rodando na porta ${port}`, 'Bootstrap');
  if (isProd && frontendUrl?.length) {
    Logger.log(`🔒 CORS travado pra: ${frontendUrl.join(', ')}`, 'Bootstrap');
  } else {
    Logger.log(`🌍 CORS liberado (dev mode)`, 'Bootstrap');
  }
}

bootstrap().catch((err) => {
  console.error('==> [bootstrap] ERRO FATAL:', err);
  process.exit(1);
});
