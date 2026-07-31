import 'server-only';

/**
 * ARMAZENAMENTO DE LOG DE DESPACHO.
 *
 * ⚠️ LIMITE REAL, DECLARADO DE PROPÓSITO: a implementação padrão guarda em
 * MEMÓRIA. Na Vercel cada instância serverless tem a sua, elas somem quando a
 * função hiberna e não há garantia de que duas requisições caiam na mesma. Isso
 * é bom o bastante pra depurar em desenvolvimento e pro painel mostrar a
 * atividade recente — e NÃO é a "tabela completa de logs" da spec.
 *
 * Por isso existem duas coisas aqui:
 *   1. `LogStore`, a interface — trocar por Postgres é implementar 3 métodos e
 *      mudar uma linha em `getLogStore()`. Nada mais no código muda.
 *   2. `console.log` estruturado em produção — o Vercel captura stdout de forma
 *      durável, então mesmo sem banco existe trilha auditável e pesquisável.
 *
 * Quando o volume justificar, o caminho é uma tabela `tracking_dispatch_log`
 * com índice em (created_at, destination, status) e retenção de 30 dias.
 */

import type { DispatchLog } from '../types';

export interface LogQuery {
  destination?: string;
  status?: DispatchLog['status'];
  event?: string;
  /** Busca livre em evento, destino, erro e id. */
  search?: string;
  limit?: number;
}

export interface LogStore {
  append(log: DispatchLog): Promise<void>;
  list(query?: LogQuery): Promise<DispatchLog[]>;
  clear(): Promise<void>;
}

const MAX_IN_MEMORY = 1_000;

class InMemoryLogStore implements LogStore {
  private logs: DispatchLog[] = [];

  async append(log: DispatchLog): Promise<void> {
    this.logs.push(log);
    if (this.logs.length > MAX_IN_MEMORY) this.logs.splice(0, this.logs.length - MAX_IN_MEMORY);

    // Trilha durável: uma linha JSON por despacho. O payload NÃO entra — pode
    // ter dado pessoal, e log de aplicação não é lugar pra isso.
    if (process.env.NODE_ENV === 'production') {
      console.log(
        JSON.stringify({
          tag: 'tracking_dispatch',
          event: log.event,
          event_id: log.event_id,
          destination: log.destination,
          status: log.status,
          duration_ms: log.duration_ms,
          attempt: log.attempt,
          error: log.error,
          reason: log.reason,
          at: log.created_at,
        }),
      );
    }
  }

  async list(query: LogQuery = {}): Promise<DispatchLog[]> {
    const { destination, status, event, search, limit = 200 } = query;
    const termo = search?.toLowerCase();

    return this.logs
      .filter((l) => (!destination || l.destination === destination))
      .filter((l) => (!status || l.status === status))
      .filter((l) => (!event || l.event === event))
      .filter((l) =>
        !termo
          ? true
          : `${l.event} ${l.destination} ${l.error ?? ''} ${l.reason ?? ''} ${l.event_id}`.toLowerCase().includes(termo),
      )
      .slice(-limit)
      .reverse();
  }

  async clear(): Promise<void> {
    this.logs = [];
  }
}

// Módulo é reavaliado a cada hot-reload em dev; guardar no globalThis evita
// perder o histórico a cada salvamento de arquivo.
const globalRef = globalThis as unknown as { __lurdsLogStore?: LogStore };
const store: LogStore = globalRef.__lurdsLogStore ?? new InMemoryLogStore();
globalRef.__lurdsLogStore = store;

export function getLogStore(): LogStore {
  return store;
}
