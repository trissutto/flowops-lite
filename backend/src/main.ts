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

  /**
   * O NAVEGADOR PARA DE PERGUNTAR A MESMA COISA — `maxAge` no preflight.
   *
   * ── O QUE FOI MEDIDO (22/08/2026, 24h de produção) ──
   *
   * De 412.984 requisições no dia, **37,4% eram `OPTIONS`** — o preflight que
   * o navegador manda ANTES da chamada de verdade pra perguntar "posso?".
   * Sem `Access-Control-Max-Age` na resposta, essa pergunta é refeita a cada
   * chamada: eram ~155 mil viagens por dia só pra ouvir a mesma resposta.
   *
   * Custo em dinheiro é quase zero (preflight não devolve corpo — 0 byte de
   * egress). O custo real é OUTRO: são 155 mil conexões e handshakes que o
   * backend aceita e responde à toa, e é UMA IDA E VOLTA A MAIS somada na
   * frente de cada ação da vendedora — com a cliente esperando no balcão, e o
   * servidor em us-west2 (~200ms de ida e volta pro Brasil).
   *
   * Com o cache, o navegador pergunta uma vez e reusa a permissão.
   *
   * ⚠️ O TETO É DO NAVEGADOR, não daqui: o Chrome limita a 2h (7.200s) por
   * mais que se peça, o Firefox aceita 24h. Pedir 24h não quebra o Chrome —
   * ele apenas corta pro teto dele. Por isso o número alto: aproveita o que
   * cada navegador der.
   *
   * Não afeta segurança: `maxAge` só diz por quanto tempo vale a RESPOSTA do
   * preflight. Quem pode chamar continua sendo decidido por `origin`, e mudar
   * `FRONTEND_URL` continua valendo — o pior caso é um navegador que já tinha
   * permissão seguir usando por até 2h após a mudança.
   */
  const app = await NestFactory.create(AppModule, {
    cors: isProd && frontendUrl?.length
      ? {
          origin: frontendUrl,
          credentials: true,
          maxAge: 86400,
        }
      : true, // dev: aceita qualquer origem (inalterado — `true` = `origin: '*'`)
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
  /**
   * ESCUTA EM IPv6 TAMBÉM (`::`), não só IPv4 — 22/08/2026.
   *
   * ── O SINTOMA ──
   *
   * ~6% das requisições morriam com 502 depois de exatos 15s. O log do proxy
   * do Railway dizia `"connection dial timeout", duration: 5000`, três vezes
   * (5s × 3 = os 15s): ele não conseguia ABRIR a conexão. Não era lentidão —
   * enquanto uma requisição estourava, as concorrentes respondiam em 202ms, e
   * o processo seguia servindo normalmente.
   *
   * ── A PISTA ──
   *
   * O `upstreamAddress` do proxy é IPv6:
   *   `http://[fd12:50ed:a59e:1:5000:37:5f90:83a2]:3001`
   *
   * A rede privada do Railway é IPv6. E `0.0.0.0` faz o Node abrir socket
   * **só em IPv4** — o binding não cobre o endereço em que o proxy bate.
   *
   * `::` com `ipv6Only` desligado (o padrão do Node) escuta nos dois: IPv6
   * nativo e IPv4 mapeado. É o binding que a própria Railway recomenda pra
   * serviço atrás da rede privada dela, e é estritamente mais permissivo que o
   * anterior — nada que funcionava para de funcionar.
   *
   * ⚠️ Se algum dia isto voltar pra `0.0.0.0`, o sintoma volta com ele: 502
   * intermitente que não deixa rastro nenhum no log da aplicação, porque a
   * requisição nunca chega até ela.
   */
  await app.listen(port, '::');

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
