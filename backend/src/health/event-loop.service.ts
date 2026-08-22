import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay, PerformanceObserver } from 'perf_hooks';
import * as v8 from 'v8';

/**
 * QUEM ESTÁ CONGELANDO O BACKEND — instrumentação, não chute.
 *
 * ── O SINTOMA (medido em 22/08/2026) ──
 *
 * O `/api/health` — endpoint que não faz I/O nenhum, só devolve um objeto
 * fixo — respondia 202ms ou **morria em 15s com 502**, sem meio-termo. O proxy
 * do Railway não reclamava de resposta lenta; reclamava de
 * `"connection dial timeout"` três vezes seguidas (5s cada = os 15s). Ou seja:
 * ele não conseguia nem ABRIR conexão TCP com o Node.
 *
 * Isso não é query lenta. Query lenta responde devagar. Isso é o processo
 * parado: com o event loop travado, o backlog de accept do kernel enche e o
 * SYN deixa de ser respondido. Como só existe UMA réplica, quando ela congela
 * congela tudo junto — PDV da loja, bipagem da separação, vitrine do site.
 *
 * ── POR QUE PRECISA DISTO ──
 *
 * Um travamento de event loop não deixa rastro no log: o processo não
 * consegue nem logar enquanto está travado, e quando volta a rodar já perdeu
 * a informação de quem segurou a linha. Os candidatos (Baileys no mesmo
 * processo, montagem do catálogo, pausa de GC, pool de MySQL em host morto)
 * são indistinguíveis olhando de fora.
 *
 * Este serviço grava as três coisas que separam esses casos:
 *
 *  1. **Atraso do event loop** (`monitorEventLoopDelay`) — histograma contínuo.
 *     Diz QUANTO e COM QUE FREQUÊNCIA trava.
 *  2. **Pausas de GC** (`PerformanceObserver`) — se o congelamento casa com um
 *     GC longo, a causa é pressão de memória, e o conserto é heap/cache, não
 *     código bloqueante.
 *  3. **Operações em voo** (`marcar()`) — o que estava rodando DURANTE a
 *     janela travada. É o que aponta o dedo.
 *
 * Custo: um histograma nativo (libuv, fora do JS) e um `setInterval` de 500ms
 * que só compara dois números. Fica ligado em produção de propósito — o
 * travamento é intermitente, e instrumentação que só liga "quando precisa"
 * nunca está ligada na hora que precisa.
 */

/** Acima disto a volta do loop é considerada travamento e vira registro. */
const LIMIAR_TRAVA_MS = 1000;
/** De quanto em quanto o vigia acorda pra conferir o próprio atraso. */
const PASSO_VIGIA_MS = 500;
/** Pausa de GC acima disto é anotada individualmente. */
const LIMIAR_GC_MS = 100;
/** Quantos travamentos guardar pra leitura no endpoint. */
const HISTORICO = 50;

export interface Travamento {
  /** Quando o loop voltou a rodar. */
  em: string;
  /** Quanto tempo ficou sem rodar, em ms. */
  duracaoMs: number;
  /** O que estava em voo durante a janela travada. */
  operacoes: string[];
  /** Pausas de GC que caíram dentro da janela — se somam à duração, foi GC. */
  gcNaJanelaMs: number;
  heapUsadoMb: number;
  heapLimiteMb: number;
  rssMb: number;
  /** Handles vivos por tipo (sockets pendurados aparecem aqui). */
  recursos: Record<string, number>;
}

interface OperacaoAberta {
  nome: string;
  inicio: number;
}

@Injectable()
export class EventLoopService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventLoopService.name);

  private histograma: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private observadorGc: PerformanceObserver | null = null;
  private vigia: NodeJS.Timeout | null = null;

  private readonly travamentos: Travamento[] = [];
  /** Pausas de GC recentes (janela curta — só pra cruzar com o travamento). */
  private gcRecente: { fim: number; ms: number }[] = [];
  private gcTotalMs = 0;
  private gcContagem = 0;

  private readonly abertas = new Map<number, OperacaoAberta>();
  private proximoId = 1;
  /** Quantas vezes cada operação apareceu numa janela travada. */
  private readonly culpasPorOperacao = new Map<string, number>();

  private ultimoTique = 0;
  private iniciadoEm = Date.now();

  onModuleInit() {
    this.iniciadoEm = Date.now();

    // Histograma nativo: mede o atraso de CADA volta do loop sem custo em JS.
    try {
      this.histograma = monitorEventLoopDelay({ resolution: 20 });
      this.histograma.enable();
    } catch (err) {
      this.logger.warn(`monitorEventLoopDelay indisponível: ${String(err)}`);
    }

    // GC: a única forma de distinguir "código bloqueante" de "pausa de coleta".
    try {
      this.observadorGc = new PerformanceObserver((lista) => {
        const agora = Date.now();
        for (const e of lista.getEntries()) {
          this.gcTotalMs += e.duration;
          this.gcContagem++;
          if (e.duration >= LIMIAR_GC_MS) {
            this.gcRecente.push({ fim: agora, ms: e.duration });
          }
        }
        // Só interessa o passado recente — o resto é memória à toa.
        const corte = agora - 60_000;
        this.gcRecente = this.gcRecente.filter((g) => g.fim >= corte);
      });
      this.observadorGc.observe({ entryTypes: ['gc'] });
    } catch (err) {
      this.logger.warn(`PerformanceObserver de GC indisponível: ${String(err)}`);
    }

    // O vigia: se ele deveria acordar em 500ms e acordou em 8s, o loop ficou
    // 7,5s sem rodar. É a medida direta do congelamento, e é o mesmo atraso
    // que impede o Node de aceitar conexão nova.
    this.ultimoTique = Date.now();
    this.vigia = setInterval(() => this.tique(), PASSO_VIGIA_MS);
    // Não segura o processo no shutdown.
    this.vigia.unref?.();

    this.logger.log(
      `[event-loop] vigia ligado — trava acima de ${LIMIAR_TRAVA_MS}ms vira registro em GET /api/health/diagnostico`,
    );
  }

  onModuleDestroy() {
    if (this.vigia) clearInterval(this.vigia);
    try {
      this.histograma?.disable();
    } catch {
      /* já desligado */
    }
    try {
      this.observadorGc?.disconnect();
    } catch {
      /* já desconectado */
    }
  }

  /**
   * MARCA UMA OPERAÇÃO EM VOO. Chame no começo do trecho suspeito e execute o
   * retorno no fim (em `finally`, pra não vazar se der erro).
   *
   *   const fim = this.eventLoop.marcar('catalogo:montar');
   *   try { ...trabalho pesado... } finally { fim(); }
   *
   * Se o loop travar enquanto isto está aberto, o nome aparece no registro do
   * travamento — que é exatamente a pergunta "quem segurou?".
   */
  marcar(nome: string): () => void {
    const id = this.proximoId++;
    this.abertas.set(id, { nome, inicio: Date.now() });
    let fechado = false;
    return () => {
      if (fechado) return;
      fechado = true;
      this.abertas.delete(id);
    };
  }

  /** Versão embrulhada, pra quando o trecho já é uma promise. */
  async medir<T>(nome: string, fn: () => Promise<T>): Promise<T> {
    const fim = this.marcar(nome);
    try {
      return await fn();
    } finally {
      fim();
    }
  }

  private tique() {
    const agora = Date.now();
    const atraso = agora - this.ultimoTique - PASSO_VIGIA_MS;
    this.ultimoTique = agora;

    if (atraso < LIMIAR_TRAVA_MS) return;

    // Houve travamento. A janela é [agora - atraso, agora].
    const inicioJanela = agora - atraso;

    // Quem estava aberto ANTES da janela começar é suspeito; quem abriu depois
    // não pode ter causado (o loop já estava parado, ninguém abriu nada).
    const operacoes = [...this.abertas.values()]
      .filter((o) => o.inicio <= inicioJanela)
      .map((o) => `${o.nome} (${((agora - o.inicio) / 1000).toFixed(1)}s aberta)`);

    const gcNaJanelaMs = this.gcRecente
      .filter((g) => g.fim >= inicioJanela)
      .reduce((s, g) => s + g.ms, 0);

    let heapUsadoMb = 0;
    let heapLimiteMb = 0;
    let rssMb = 0;
    try {
      const mem = process.memoryUsage();
      const heap = v8.getHeapStatistics();
      heapUsadoMb = Math.round(mem.heapUsed / 1048576);
      heapLimiteMb = Math.round(heap.heap_size_limit / 1048576);
      rssMb = Math.round(mem.rss / 1048576);
    } catch {
      /* métrica é acessório — o registro do travamento vale por si */
    }

    const registro: Travamento = {
      em: new Date(agora).toISOString(),
      duracaoMs: atraso,
      operacoes,
      gcNaJanelaMs: Math.round(gcNaJanelaMs),
      heapUsadoMb,
      heapLimiteMb,
      rssMb,
      recursos: this.contarRecursos(),
    };

    this.travamentos.unshift(registro);
    if (this.travamentos.length > HISTORICO) this.travamentos.pop();
    for (const o of operacoes) {
      const nome = o.split(' (')[0];
      this.culpasPorOperacao.set(nome, (this.culpasPorOperacao.get(nome) ?? 0) + 1);
    }

    // Uma linha por travamento, com tudo que separa as hipóteses. Não é spam:
    // se estiver saindo muito, é porque está travando muito.
    const pctGc = atraso > 0 ? Math.round((gcNaJanelaMs / atraso) * 100) : 0;
    this.logger.error(
      `[event-loop] TRAVOU ${(atraso / 1000).toFixed(1)}s — ` +
        `GC na janela: ${Math.round(gcNaJanelaMs)}ms (${pctGc}%) · ` +
        `heap ${heapUsadoMb}/${heapLimiteMb}MB · rss ${rssMb}MB · ` +
        `em voo: ${operacoes.length ? operacoes.join(' | ') : '(nada marcado)'}`,
    );
  }

  /**
   * Handles vivos por tipo. Socket pendurado, timer vazando e conexão de banco
   * presa aparecem aqui — e o número crescendo entre um travamento e outro é
   * sinal de vazamento, não de pico.
   */
  private contarRecursos(): Record<string, number> {
    const fora: Record<string, number> = {};
    try {
      // Público desde o Node 17.3.
      const infos = (process as any).getActiveResourcesInfo?.();
      if (Array.isArray(infos)) {
        for (const t of infos) fora[t] = (fora[t] ?? 0) + 1;
      }
    } catch {
      /* sem essa API, o resto do registro continua útil */
    }
    return fora;
  }

  /** O retrato que o endpoint de diagnóstico devolve. */
  snapshot() {
    const h = this.histograma;
    const mem = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const ligadoHaS = Math.round((Date.now() - this.iniciadoEm) / 1000);

    return {
      ligadoHaS,
      limiarTravaMs: LIMIAR_TRAVA_MS,
      atrasoDoLoopMs: h
        ? {
            // O histograma é em nanossegundos.
            media: +(h.mean / 1e6).toFixed(1),
            p50: +(h.percentile(50) / 1e6).toFixed(1),
            p90: +(h.percentile(90) / 1e6).toFixed(1),
            p99: +(h.percentile(99) / 1e6).toFixed(1),
            max: +(h.max / 1e6).toFixed(1),
          }
        : null,
      gc: {
        pausas: this.gcContagem,
        totalMs: Math.round(this.gcTotalMs),
        /** Fatia do tempo de vida gasta coletando lixo. >5% já é pressão real. */
        pctDoTempo: ligadoHaS > 0 ? +((this.gcTotalMs / (ligadoHaS * 1000)) * 100).toFixed(2) : 0,
      },
      memoria: {
        heapUsadoMb: Math.round(mem.heapUsed / 1048576),
        heapTotalMb: Math.round(mem.heapTotal / 1048576),
        heapLimiteMb: Math.round(heap.heap_size_limit / 1048576),
        rssMb: Math.round(mem.rss / 1048576),
        externalMb: Math.round(mem.external / 1048576),
      },
      recursos: this.contarRecursos(),
      operacoesAbertasAgora: [...this.abertas.values()].map((o) => ({
        nome: o.nome,
        abertaHaMs: Date.now() - o.inicio,
      })),
      /** Ranking de quem mais aparece em janela travada — o dedo apontado. */
      maisSuspeitas: [...this.culpasPorOperacao.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([nome, vezes]) => ({ nome, vezes })),
      travamentos: this.travamentos,
      resumo: {
        total: this.travamentos.length,
        piorMs: this.travamentos.reduce((m, t) => Math.max(m, t.duracaoMs), 0),
        somaMs: this.travamentos.reduce((s, t) => s + t.duracaoMs, 0),
      },
    };
  }
}
