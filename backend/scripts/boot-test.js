/**
 * TESTE DE BOOT — resolve o GRAFO DE MÓDULOS sem tocar em banco nem rede.
 *
 *   npm run build && node scripts/boot-test.js
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * Em 07/08/2026 uma aresta nova entre módulos derrubou o backend em produção.
 * `tsc` passa, `nest build` passa, e o processo morre no boot com "Nest can't
 * resolve dependencies of X" — porque isso não é erro de TIPO, é erro de
 * GRAFO, e só aparece quando o Nest monta o container.
 *
 * ── POR QUE `preview: true` ──
 *
 * É o modo do Nest 10 que monta o grafo inteiro e **não instancia provider
 * nenhum**: nada de `onModuleInit`, nada de cron disparando, nada de conexão
 * com o Postgres de produção a partir da máquina de quem desenvolve. Um teste
 * de boot que ligasse os crons seria mais perigoso que o bug que ele procura.
 *
 * O preço: ele pega erro de MÓDULO (import faltando, ciclo, provider não
 * exportado) — que é a classe de erro do incidente — e não pega erro de
 * runtime dentro de um construtor. Para isso, o deploy é o teste.
 *
 * Rode sempre que mexer em `imports`/`providers`/`exports` de um módulo.
 */
const path = require('path');
const { NestFactory } = require('@nestjs/core');

const DIST = path.join(__dirname, '..', 'dist');

function carregarAppModule() {
  for (const caminho of [path.join(DIST, 'app.module.js'), path.join(DIST, 'src', 'app.module.js')]) {
    try {
      const m = require(caminho);
      if (m?.AppModule) return m.AppModule;
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  throw new Error(`app.module.js não encontrado em ${DIST} — rode "npm run build" antes`);
}

(async () => {
  const app = await NestFactory.createApplicationContext(carregarAppModule(), {
    preview: true,
    logger: ['error'],
    abortOnError: false,
  });
  console.log('BOOT_OK — grafo de módulos resolvido');
  await app.close();
  process.exit(0);
})().catch((e) => {
  console.error('BOOT_FALHOU:', e.message);
  process.exit(1);
});
