import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

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
  // Limite aumentado pro endpoint de restore (backup xlsx em base64 pode passar de 10MB)
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }));

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
