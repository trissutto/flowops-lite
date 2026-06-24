import { Logger } from '@nestjs/common';

/**
 * Circuit-breaker COMPARTILHADO para o servidor dedicado do Giga/WordPress.
 *
 * ERP_HOST e WP_DB_HOST apontam pro MESMO servidor (dedi-11842007.lurds.com.br
 * / 162.215.213.154), que hospeda tanto o MySQL do Giga (gigasistemas21) quanto
 * o do WordPress/WooCommerce.
 *
 * PROBLEMA QUE RESOLVE
 * --------------------
 * Quando esse servidor fica inacessível (firewall bloqueando o IP do Railway,
 * queda, limite de conexão), cada tentativa de conexão MySQL fica PENDURADA até
 * o `connectTimeout` (segundos) antes de falhar. Sob carga, dezenas dessas
 * conexões penduradas entopem o event loop (single-thread) do Node e deixam o
 * APP INTEIRO LENTO — inclusive endpoints que NÃO usam o Giga (ex: /health,
 * login, Pedidos do Site). Foi exatamente o que derrubou o sistema.
 *
 * COMO FUNCIONA
 * -------------
 * Após N falhas de CONEXÃO seguidas, o breaker ABRE por COOLDOWN_MS. Enquanto
 * aberto, as chamadas ao Giga/WP FALHAM NA HORA (sem nem tentar conectar) —
 * o event loop não entope e o resto do app continua respondendo. Passado o
 * cooldown, deixa UMA tentativa passar (half-open); se reconectar, fecha e
 * volta ao normal sozinho. Só funções de ERP (bipe/preço/estoque/imagens)
 * ficam degradadas enquanto o servidor estiver fora.
 *
 * Erros de SQL (sintaxe, coluna inexistente) NÃO contam — só falha de conexão.
 */
const log = new Logger('GigaBreaker');

let consecutiveFailures = 0;
let openUntil = 0;

const THRESHOLD = 3; // falhas de conexão seguidas pra abrir o circuito
const COOLDOWN_MS = 20_000; // 20s sem tentar conectar enquanto aberto

// SÓ erros de HOST INACESSÍVEL (não dá nem pra estabelecer a conexão) abrem o
// breaker. Quedas de uma conexão JÁ ABERTA — ECONNRESET, PROTOCOL_CONNECTION_LOST,
// EPIPE, PROTOCOL_SEQUENCE_TIMEOUT — são NORMAIS num pool com keep-alive: o
// servidor fecha conexões ociosas (wait_timeout) e o mysql2 simplesmente pega
// outra. Se essas contassem, o breaker abriria no USO NORMAL e derrubaria todo o
// Giga por 20s sem o servidor estar fora. (Regressão observada 23/06.)
const HOST_DOWN_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
]);

function isConnError(e: any): boolean {
  const code = String(e?.code || '');
  if (HOST_DOWN_CODES.has(code)) return true;
  // Sem código: só trata como host-down se a MENSAGEM for claramente de
  // estabelecimento de conexão/DNS. Evita casar "Connection lost" (queda de
  // conexão já aberta), que NÃO deve abrir o breaker.
  const msg = String(e?.message || '');
  return /(getaddrinfo|ehostunreach|enetunreach|connect\s+e(timedout|connrefused|hostunreach|netunreach))/i.test(
    msg,
  );
}

export const GigaBreaker = {
  /** true = circuito ABERTO → NÃO tentar conectar agora (falhar rápido). */
  isOpen(): boolean {
    return Date.now() < openUntil;
  },

  /** Conexão/query OK → fecha o circuito. */
  recordSuccess(): void {
    if (consecutiveFailures > 0 || openUntil > 0) {
      log.log('Giga/WP reconectado — circuit-breaker FECHADO');
    }
    consecutiveFailures = 0;
    openUntil = 0;
  },

  /** Conta apenas falha de CONEXÃO (ignora erro de SQL). Abre se passar do limite. */
  recordError(e: any): void {
    if (!isConnError(e)) return;
    consecutiveFailures++;
    if (consecutiveFailures >= THRESHOLD && Date.now() >= openUntil) {
      openUntil = Date.now() + COOLDOWN_MS;
      log.warn(
        `Giga/WP inacessível (${consecutiveFailures} falhas de conexão) — ` +
          `circuit-breaker ABERTO por ${COOLDOWN_MS / 1000}s. ` +
          `Chamadas ao Giga/WP vão falhar rápido pra não travar o app.`,
      );
    }
  },

  /** Erro padrão lançado/retornado quando o circuito está aberto. */
  openError(): Error & { code: string } {
    const e = new Error(
      'GIGA_BREAKER_OPEN: servidor do Giga/WP indisponível (circuit-breaker aberto)',
    ) as Error & { code: string };
    e.code = 'GIGA_BREAKER_OPEN';
    return e;
  },

  /**
   * Envolve os métodos de um pool MySQL (query/execute/getConnection) com o
   * breaker: falha rápido quando aberto, e registra sucesso/falha de conexão.
   * Chamar UMA vez logo após mysql.createPool(). Universal — não precisa
   * tocar em cada método que usa o pool.
   */
  wrapPool(pool: any): void {
    if (!pool || pool.__gigaBreakerWrapped) return;
    const wrap = (fn: Function) => (...args: any[]) => {
      if (GigaBreaker.isOpen()) return Promise.reject(GigaBreaker.openError());
      return Promise.resolve(fn(...args)).then(
        (res: any) => {
          GigaBreaker.recordSuccess();
          return res;
        },
        (err: any) => {
          GigaBreaker.recordError(err);
          throw err;
        },
      );
    };
    if (typeof pool.query === 'function') pool.query = wrap(pool.query.bind(pool));
    if (typeof pool.execute === 'function')
      pool.execute = wrap(pool.execute.bind(pool));
    if (typeof pool.getConnection === 'function')
      pool.getConnection = wrap(pool.getConnection.bind(pool));
    pool.__gigaBreakerWrapped = true;
  },
};
