import 'server-only';
import { api, ApiError } from '@/lib/api';

/**
 * COMO OS TRÊS FEEDS LEEM O BACKEND E O QUE RESPONDEM — uma regra, três rotas
 * (`google.xml`, `google-local.xml`, `meta.xml`).
 *
 * ── O FEED CHEGAVA COM UM DIA DE ATRASO (auditoria de 04/10/2026) ──
 *
 * Havia DUAS cópias guardadas entre a retaguarda e a plataforma, e as duas
 * devolviam o dado VELHO pra quem lê uma vez por dia:
 *
 * 1. **A CDN** (`s-maxage=3600, stale-while-revalidate=86400`). O Merchant
 *    busca 1×/dia: a cópia que ele achava tinha ~24 h, ainda dentro da janela
 *    de 25 h, então ele levava o feed de ontem e só ENTÃO a CDN regenerava.
 * 2. **O Data Cache do `fetch`** (`revalidate: 3600`). Em rota dinâmica o Next
 *    devolve a entrada vencida NA HORA e renova em segundo plano
 *    (`patch-fetch.js`: `entry.isStale` → `pendingRevalidates`). Ou seja: mesmo
 *    com a CDN regenerando, a regeneração montava o XML com o catálogo da
 *    execução anterior.
 *
 * Somadas: peça publicada às 10 h do dia D chegava ao Merchant em D+2 00:00
 * (~38 h típico), mais a revisão dele. Preço e esgotado andavam na mesma fila
 * — o Google anunciando por até dois dias peça que o site já tinha tirado.
 * O dono enxergava isso como "a campanha não atualizou com as novidades".
 *
 * Baixar só o relógio do `fetch` (300 s) NÃO resolve — a entrada continua
 * sendo devolvida vencida pra quem lê 1×/dia. Por isso a leitura do feed saiu
 * do Data Cache de vez (`revalidate: 0`) e sobrou UMA cópia só, a da CDN:
 *
 *   · leitor diário (Merchant)  → cópia de 24 h, fora da janela → feed fresco;
 *   · leitor horário (Meta)     → no máximo ~25 min atrás.
 *
 * O custo é uma chamada ao backend a cada regeneração (até 4/h por região por
 * feed). O backend guarda o catálogo em memória por 60 s e responde o JSON de
 * ~1 MB em 0,3 s (medido em 04/10).
 *
 * ── E O CAMINHO DE FALHA MUDOU JUNTO: 503, NUNCA FEED VAZIO ──
 *
 * Desde 14/09/2026 a falha devolvia um RSS VÁLIDO SEM ITEM, com `no-store`
 * (a vacina contra o vazio guardado por uma hora — o incidente está escrito
 * no `google.xml`). O `no-store` continua. O que muda é o corpo: feed vazio
 * com 200 é a plataforma lendo "esta loja não vende mais nada" — o próprio
 * cabeçalho do `google.xml` diz que uma busca naquela janela desativaria o
 * catálogo inteiro. Com 5xx, Merchant e Meta registram "não consegui buscar"
 * e MANTÊM o último arquivo bom.
 *
 * Enquanto existia o Data Cache, ele escondia backend fora do ar (devolvia a
 * cópia antiga) e o vazio era raro. Sem ele, todo restart do backend (~40-60 s
 * a cada deploy do Railway) que coincidir com uma regeneração cairia no
 * caminho de falha — por isso as duas mudanças andam juntas, e por isso a
 * segunda chance abaixo. É a regra de ouro da casa: falha de leitura é erro
 * honesto que SOBE, nunca "não existe".
 */

/**
 * O que a CDN pode guardar de uma resposta BOA: 15 min fresca e mais 10 min
 * servindo a cópia enquanto regenera. Leitor diário sempre cai fora da janela.
 *
 * ⚠️ A Vercel COME `s-maxage` e `stale-while-revalidate` da resposta que chega
 * no cliente: ver só `max-age=300` no `curl` não diz nada. Quem conta a
 * verdade é `X-Vercel-Cache` + `Age`.
 */
export const CACHE_DO_FEED = 'public, max-age=300, s-maxage=900, stale-while-revalidate=600';

/** O backend frio (logo depois de um deploy) remonta o catálogo em ~17 s. */
const TIMEOUT_MS = 25_000;
/** Respiro antes da segunda tentativa — soluço de rede passa nisso. */
const ESPERA_MS = 1_500;
/**
 * Teto do tempo somado das duas tentativas. Existe pra função não ficar
 * pendurada 50 s quando o backend está PENDURADO (e não recusando): se a
 * primeira já comeu o relógio, a segunda não acontece.
 */
const ORCAMENTO_MS = 40_000;
/** Menos que isto de sobra não dá tempo de o backend responder — nem tenta. */
const MINIMO_PRA_TENTAR_MS = 5_000;

const dormir = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/**
 * Roda a leitura e, se ela falhar, tenta MAIS UMA VEZ.
 *
 * Não retenta resposta 4xx do backend: é ele dizendo que o pedido está errado,
 * e repetir o mesmo pedido só dobra a carga. Retenta o que é passageiro —
 * rede, timeout, 5xx (o 502/503 do Railway durante o restart).
 *
 * `ler` recebe o timeout que pode usar: a segunda tentativa só tem o que
 * sobrou do orçamento.
 */
export async function comSegundaChance<T>(ler: (timeoutMs: number) => Promise<T>): Promise<T> {
  const inicio = Date.now();
  try {
    return await ler(TIMEOUT_MS);
  } catch (primeira) {
    if (primeira instanceof ApiError && primeira.status >= 400 && primeira.status < 500) throw primeira;
    const sobra = ORCAMENTO_MS - (Date.now() - inicio) - ESPERA_MS;
    if (sobra < MINIMO_PRA_TENTAR_MS) throw primeira;
    await dormir(ESPERA_MS);
    return ler(Math.min(TIMEOUT_MS, sobra));
  }
}

/**
 * Lê uma LISTA do backend pro feed: SEM Data Cache (ver o cabeçalho) e com
 * uma segunda chance. Erro SOBE — quem chama responde `feedIndisponivel()`.
 *
 * Resposta que não é lista também é erro: os dois endpoints do feed devolvem
 * array, e um objeto no lugar (página de erro de proxy que veio como JSON,
 * contrato quebrado num deploy) viraria "catálogo com zero peça" mais adiante.
 */
export async function lerListaDoBackend<T>(caminho: string): Promise<T[]> {
  const lido = await comSegundaChance((timeoutMs) => api<unknown>(caminho, { revalidate: 0, timeoutMs }));
  if (!Array.isArray(lido)) {
    throw new Error(`resposta de ${caminho} não é uma lista (${lido === null ? 'null' : typeof lido})`);
  }
  return lido as T[];
}

/** Resposta BOA: o XML, guardado pela CDN conforme `CACHE_DO_FEED`. */
export function respostaDoFeed(xml: string): Response {
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': CACHE_DO_FEED,
    },
  });
}

/**
 * Resposta de FALHA: 503 sem cache. Vale pra exceção na leitura E pra leitura
 * que responde sem nenhum item válido — a rede nunca está com zero peça à
 * venda, então "zero" é anomalia, não notícia.
 *
 * `Retry-After` de 5 min cobre com folga o restart do backend. `no-store` é a
 * vacina de 14/09: o que nasce de falha nunca fica guardado.
 */
export function feedIndisponivel(): Response {
  return new Response('Feed temporariamente indisponivel. Tente de novo em alguns minutos.\n', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '300',
    },
  });
}
