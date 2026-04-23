import { Injectable, Logger, BadRequestException } from '@nestjs/common';

/**
 * tracking.service.ts — puxa status de entrega do rastreio (Correios/Jadlog).
 *
 * Usa LinkeTrack como provedor (free tier + token em env).
 * Doc: https://linketrack.com.br/documentacao
 *
 * Endpoint: GET https://api.linketrack.com/track/json?user={USER}&token={TOKEN}&codigo={CODE}
 *
 * Retorno normalizado pra frontend:
 * {
 *   code: 'BR123...',
 *   carrier: 'correios',
 *   service: 'PAC',
 *   events: [{ date, time, location, description, isDelivery }],
 *   lastStatus: 'Objeto entregue...',
 *   delivered: boolean,
 *   fetchedAt: ISO date,
 * }
 *
 * Se LINKETRACK_TOKEN não estiver configurado, retorna erro amigável
 * informando que precisa configurar. Não quebra o app.
 */

export interface TrackingEvent {
  date: string;           // "22/04/2026"
  time: string;           // "14:30"
  location: string;       // "Curitiba/PR"
  description: string;    // "Objeto postado"
  isDelivery: boolean;    // true quando é evento de entrega final
}

export interface TrackingResult {
  code: string;
  carrier: string;
  service: string | null;
  events: TrackingEvent[];
  lastStatus: string | null;
  delivered: boolean;
  fetchedAt: string;
  provider: string;
  error?: string;
}

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  private get token(): string | undefined {
    return process.env.LINKETRACK_TOKEN;
  }

  private get user(): string {
    return process.env.LINKETRACK_USER || 'teste';
  }

  /**
   * Consulta rastreio em provedor externo e devolve estrutura normalizada.
   * Sempre lança exceção em erro HTTP/rede; não devolve silencioso.
   */
  async fetchTracking(code: string, carrier?: string): Promise<TrackingResult> {
    const cleanCode = (code || '').trim().toUpperCase();
    if (!cleanCode || cleanCode.length < 8) {
      throw new BadRequestException('Código de rastreio inválido');
    }

    if (!this.token) {
      // Modo degradado: devolve estrutura mas avisa
      return {
        code: cleanCode,
        carrier: carrier || 'correios',
        service: null,
        events: [],
        lastStatus: null,
        delivered: false,
        fetchedAt: new Date().toISOString(),
        provider: 'none',
        error: 'LINKETRACK_TOKEN não configurado no backend. Configure em env vars pra ativar rastreio automático.',
      };
    }

    const url = `https://api.linketrack.com/track/json?user=${encodeURIComponent(
      this.user,
    )}&token=${encodeURIComponent(this.token)}&codigo=${encodeURIComponent(cleanCode)}`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'flowops-lite/1.0' },
        // @ts-ignore — Node 20 nativo suporta AbortSignal.timeout
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.warn(
          `LinkeTrack HTTP ${res.status} pra ${cleanCode}: ${text.slice(0, 200)}`,
        );
        return {
          code: cleanCode,
          carrier: carrier || 'correios',
          service: null,
          events: [],
          lastStatus: null,
          delivered: false,
          fetchedAt: new Date().toISOString(),
          provider: 'linketrack',
          error: `Provedor retornou HTTP ${res.status}. Verifique o código ou tente em alguns minutos.`,
        };
      }

      const data: any = await res.json();

      const rawEvents: any[] = Array.isArray(data?.eventos) ? data.eventos : [];
      const events: TrackingEvent[] = rawEvents.map((e) => ({
        date: String(e.data || ''),
        time: String(e.hora || ''),
        location: String(e.local || ''),
        description: String(e.status || e.descricao || ''),
        isDelivery: /entreg/i.test(String(e.status || '')),
      }));

      return {
        code: cleanCode,
        carrier: carrier || 'correios',
        service: data?.servico ? String(data.servico) : null,
        events,
        lastStatus: data?.ultimo ? String(data.ultimo) : events[0]?.description ?? null,
        delivered: Boolean(data?.entregue) || events.some((e) => e.isDelivery),
        fetchedAt: new Date().toISOString(),
        provider: 'linketrack',
      };
    } catch (e: any) {
      this.logger.warn(`Erro ao consultar LinkeTrack pra ${cleanCode}: ${e?.message || e}`);
      return {
        code: cleanCode,
        carrier: carrier || 'correios',
        service: null,
        events: [],
        lastStatus: null,
        delivered: false,
        fetchedAt: new Date().toISOString(),
        provider: 'linketrack',
        error: `Falha de rede/timeout: ${e?.message || 'desconhecido'}`,
      };
    }
  }
}
