/**
 * Vigia do event loop de mentirinha, pros testes do catálogo.
 *
 * `EventLoopService` é só instrumentação — não muda o resultado de nada. Mas
 * `montarSeMudou` chama `medir()` de verdade, então passar `{} as any` faria o
 * teste morrer com "medir is not a function" numa falha que não tem relação
 * nenhuma com o que ele está verificando.
 *
 * Este stub executa a função e devolve o resultado, que é exatamente o que o
 * serviço real faz por baixo da medição.
 */
export const eventLoopStub = {
  marcar: () => () => {},
  medir: <T>(_nome: string, fn: () => Promise<T>) => fn(),
} as any;
