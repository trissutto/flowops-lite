import { Injectable, Logger } from '@nestjs/common';
import { LiveRealtimeGateway } from './live-realtime.gateway';

/**
 * LiveBroadcasterService — fachada única pra emitir eventos WS da live.
 *
 * Serviços de domínio (LiveService, ReservationService, etc.) chamam este
 * broadcaster em vez de injetar o gateway direto. Vantagens:
 *  - Desacopla regra de negócio do transporte
 *  - Fácil mockar nos testes
 *  - Pra emitir nos DOIS namespaces (/live público e /realtime admin), só
 *    centraliza aqui sem espalhar.
 *
 * @TODO: quando o RealtimeGateway admin existente expor método pra emitir
 * em sala arbitrária, adicionar emissão dupla aqui (público + admin).
 */
@Injectable()
export class LiveBroadcasterService {
  private readonly logger = new Logger(LiveBroadcasterService.name);

  constructor(private readonly publicGateway: LiveRealtimeGateway) {}

  emitProductChange(liveId: string, product: any) {
    const room = `live:${liveId}`;
    this.publicGateway.server?.to(room).emit('product:changed', {
      id: product.id,
      refCode: product.refCode,
      displayName: product.displayName,
      priceCents: product.priceCents,
      promoPriceCents: product.promoPriceCents,
      sizes: product.sizes,
    });
  }

  emitStockUpdate(
    liveId: string,
    payload: { liveProductId: string; sizes: any[] },
  ) {
    this.publicGateway.server?.to(`live:${liveId}`).emit('stock:updated', payload);

    // Escassez automática: se algum tamanho ficou <= 5, emite alerta
    for (const s of payload.sizes) {
      if (s.stock > 0 && s.stock <= 5) {
        this.publicGateway.server
          ?.to(`live:${liveId}`)
          .emit('scarcity:alert', {
            liveProductId: payload.liveProductId,
            size: s.size,
            remaining: s.stock,
          });
      }
    }
  }

  emitReservationCreated(liveId: string, reservation: any) {
    // Pra painel master (admin) — usa namespace público pra MVP.
    this.publicGateway.server
      ?.to(`live:${liveId}`)
      .emit('reservation:created', {
        id: reservation.id,
        size: reservation.size,
        customerId: reservation.customerId,
      });
  }

  emitReservationExpired(liveId: string, customerId: string, reservationId: string) {
    this.publicGateway.server
      ?.to(`live:${liveId}`)
      .emit('reservation:expired', { reservationId, customerId });
  }

  emitNewComment(liveId: string, comment: any) {
    this.publicGateway.server
      ?.to(`live:${liveId}`)
      .emit('comment:new', {
        id: comment.id,
        igUsername: comment.igUsername,
        rawText: comment.rawText,
        detectedIntent: comment.detectedIntent,
        detectedCode: comment.detectedCode,
        detectedSize: comment.detectedSize,
        createdAt: comment.createdAt,
      });
  }

  emitLiveStatus(liveId: string, status: string) {
    this.publicGateway.server
      ?.to(`live:${liveId}`)
      .emit('live:status', { status });
  }
}
