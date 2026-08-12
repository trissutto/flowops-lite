/**
 * CONTRATO DE DESTINO.
 *
 * Um destino é um plugue: sabe carregar seu script, sabe traduzir o nosso
 * evento canônico pro dialeto da plataforma e sabe qual consentimento exige.
 * Nada além disso. Ligar uma plataforma nova é escrever um arquivo e registrar
 * na lista — sem tocar em componente, em página ou no Event Manager.
 */

import type { ConsentCategory, EventName, TrackingEvent } from '../types';

export interface Destination {
  /** Id curto usado no log e no painel de debug (`meta_pixel`, `ga4`, …). */
  id: string;
  label: string;
  /** Categoria da LGPD sem a qual este destino não recebe NADA. */
  consent: ConsentCategory;
  /** False quando falta a variável de ambiente — some do fluxo sem erro. */
  isEnabled(): boolean;
  /** Carrega o script da plataforma. Chamado no máximo uma vez. */
  init(): void;
  /** Nem todo destino quer todo evento (Clarity não quer `scroll_depth`). */
  accepts(event: EventName): boolean;
  /** Entrega o evento. Pode lançar — quem chama trata e registra o log. */
  send(event: TrackingEvent): void;
}

/** Carrega script externo uma única vez, mesmo com chamadas concorrentes. */
const loading = new Set<string>();

/** Gestos que provam que a página já está de pé — antecipam a carga. */
const ACELERADORES = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;

/** Teto de espera. Chegando aqui, carrega mesmo que a linha principal esteja cheia. */
const ESPERA_MAXIMA_MS = 2_500;

/**
 * Roda quando a linha principal respirar — ou no primeiro gesto, ou no teto.
 *
 * POR QUE ISTO EXISTE (12/08/2026): os scripts de terceiro entravam no DOM
 * dentro do `useEffect` da hidratação, ou seja, o navegador baixava e
 * executava ~170 KB de `fbevents.js` + quatro contêineres do gtag no mesmo
 * momento em que o React montava a home. Medido em produção: duas tarefas
 * longas, 71ms de hidratação e 59ms de terceiros, e 180ms de TBT no PageSpeed
 * desktop.
 *
 * NADA É PERDIDO NA ESPERA — e isso não é otimismo, é como as duas
 * plataformas foram feitas: o `dataLayer` do Google e o stub `fbq` da Meta são
 * FILAS. `init()` continua rodando na hora, cria a fila e empilha `config` e
 * `init`; quando o script real chega, ele consome a fila inteira na ordem.
 * O que muda é só QUANDO o arquivo entra na rede.
 *
 * O teto de 2,5s é o seguro contra o caso ruim: visitante que abre e sai sem
 * tocar em nada, numa página que nunca fica ociosa. Sem ele, esse acesso não
 * apareceria em GA nem no Ads.
 */
function quandoOcioso(fn: () => void): void {
  let feito = false;
  const rodar = () => {
    if (feito) return;
    feito = true;
    for (const ev of ACELERADORES) window.removeEventListener(ev, rodar);
    fn();
  };

  for (const ev of ACELERADORES) window.addEventListener(ev, rodar, { passive: true });

  const ocioso = (window as unknown as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  }).requestIdleCallback;

  if (typeof ocioso === 'function') ocioso(rodar, { timeout: ESPERA_MAXIMA_MS });
  else setTimeout(rodar, 1_500); // Safari antigo não tem requestIdleCallback.
}

export function loadScript(src: string, id: string): void {
  if (typeof document === 'undefined' || loading.has(id) || document.getElementById(id)) return;
  // Marca AGORA, não na inserção: entre o agendamento e a carga ainda podem
  // chegar outras chamadas pro mesmo destino, e duas tags iguais na página
  // duplicariam todo evento.
  loading.add(id);

  quandoOcioso(() => {
    if (document.getElementById(id)) return;
    const el = document.createElement('script');
    el.id = id;
    el.async = true;
    el.src = src;
    document.head.appendChild(el);
  });
}
