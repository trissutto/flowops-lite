/**
 * SCHEMAS ZOD DO TRACKING — validação de dado NÃO confiável.
 *
 * Vivem separados de `types.ts` por um motivo de peso, literalmente: o
 * `types.ts` é alcançado pelo TrackingProvider, que mora no layout raiz, então
 * tudo que ele importa entra no bundle de todas as páginas. O zod sozinho eram
 * 74 KB — 23% do JavaScript da home, numa página que não valida nada.
 *
 * Use ESTE arquivo onde o dado chega de fora: a rota `/api/events`, que recebe
 * lote de evento pela rede e não pode confiar em nada.
 *
 * NÃO importe daqui em client component. No navegador o dado é construído pelo
 * próprio app (e revalidado no servidor logo em seguida); lá bastam as guardas
 * escritas à mão em `consent.ts` e `event-manager.ts`.
 *
 * Os schemas são amarrados aos tipos por checagem de igualdade no fim do
 * arquivo: mudou um lado e esqueceu o outro, o build quebra.
 */

import { z } from 'zod';
import {
  ALL_EVENTS,
  type ConsentState,
  type EventBatch,
  type EventContext,
  type TrackedItem,
  type TrackingEvent,
} from './types';

export const consentStateSchema = z.object({
  necessary: z.literal(true),
  analytics: z.boolean(),
  marketing: z.boolean(),
  personalization: z.boolean(),
  decided_at: z.string().nullable(),
  version: z.number().int(),
});

export const pageContextSchema = z.object({
  path: z.string(),
  url: z.string(),
  title: z.string().optional(),
  referrer: z.string().optional(),
});

export const deviceContextSchema = z.object({
  type: z.enum(['mobile', 'tablet', 'desktop']),
  viewport: z.object({ w: z.number().int(), h: z.number().int() }).optional(),
  language: z.string().optional(),
  timezone: z.string().optional(),
});

export const attributionSchema = z.object({
  source: z.string().optional(),
  medium: z.string().optional(),
  campaign: z.string().optional(),
  term: z.string().optional(),
  content: z.string().optional(),
  /** `utm_id` — ID da campanha no Meta. Vira `Order.utmId` no backend. */
  id: z.string().optional(),
  gclid: z.string().optional(),
  fbclid: z.string().optional(),
  landing_page: z.string().optional(),
});

export const eventContextSchema = z.object({
  session_id: z.string(),
  anonymous_id: z.string(),
  user_id: z.string().nullable(),
  page: pageContextSchema,
  device: deviceContextSchema,
  attribution: attributionSchema,
  loja: z.string().nullable(),
  currency: z.string().default('BRL'),
  language: z.string().default('pt-BR'),
  country: z.string().default('BR'),
});

export const trackedItemSchema = z.object({
  product_id: z.string(),
  sku: z.string().optional(),
  name: z.string(),
  categoria: z.string().optional(),
  colecao: z.string().optional(),
  tecido: z.string().optional(),
  cor: z.string().optional(),
  tamanho: z.string().optional(),
  quantidade: z.number().int().positive().default(1),
  valor: z.number().nonnegative(),
  desconto: z.number().nonnegative().optional(),
  index: z.number().int().nonnegative().optional(),
  list_name: z.string().optional(),
});

export const trackingEventSchema = z.object({
  event: z.enum(ALL_EVENTS),
  event_id: z.string().min(8),
  timestamp: z.string(),
  context: eventContextSchema,
  params: z.record(z.string(), z.unknown()).default({}),
  items: z.array(trackedItemSchema).optional(),
  value: z.number().nonnegative().optional(),
  cupom: z.string().optional(),
  transaction_id: z.string().optional(),
  source: z.enum(['browser', 'server']).default('browser'),
});

/** Lote enviado ao `/api/events`. Limite protege contra payload gigante. */
export const eventBatchSchema = z.object({
  events: z.array(trackingEventSchema).min(1).max(50),
  consent: consentStateSchema,
});

/* ────────────────────────────────────────────────────────────────────────────
 * Amarração com types.ts
 *
 * Igualdade ESTRITA de tipos. Não dá pra usar `A extends B ? ... : never` aqui:
 * `never` satisfaz qualquer constraint, então a checagem passaria sempre e não
 * valeria nada. O truque abaixo compara as duas assinaturas genéricas, que só
 * são idênticas quando A e B são o mesmo tipo — divergiu, vira `false`, e
 * `false` não satisfaz `extends true`: o build quebra.
 * ──────────────────────────────────────────────────────────────────────────── */

type Igual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Confere<T extends true> = T;

export type ChecagemConsentState = Confere<Igual<z.infer<typeof consentStateSchema>, ConsentState>>;
export type ChecagemEventContext = Confere<Igual<z.infer<typeof eventContextSchema>, EventContext>>;
export type ChecagemTrackedItem = Confere<Igual<z.infer<typeof trackedItemSchema>, TrackedItem>>;
export type ChecagemTrackingEvent = Confere<
  Igual<z.infer<typeof trackingEventSchema>, TrackingEvent>
>;
export type ChecagemEventBatch = Confere<Igual<z.infer<typeof eventBatchSchema>, EventBatch>>;
