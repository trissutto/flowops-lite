import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

/**
 * Gateway WebSocket PÚBLICO (namespace /live).
 *
 * Sem autenticação JWT: clientes anônimas entram na sala da live só pra
 * receber broadcast (produto atual, estoque, escassez). Não emitem nada.
 *
 * Convive com o RealtimeGateway existente (/realtime, autenticado, para
 * painéis admin). Ver realtime.gateway.ts no projeto.
 *
 * Eventos emitidos:
 *  - product:changed     → trocou produto ao vivo
 *  - stock:updated       → estoque virtual mudou (alguém reservou/cancelou)
 *  - scarcity:alert      → "últimas X unidades", "voando", etc.
 *  - live:status         → live iniciou/encerrou
 *  - metrics:tick        → viewers count, conv rate (a cada 5s)
 *
 * Eventos recebidos (do cliente):
 *  - join:live { liveId } → entra na sala live:{id}
 */
@WebSocketGateway({
  namespace: '/live',
  cors: { origin: '*' },
})
export class LiveRealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(LiveRealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  // Contadores de viewers por live (presença simples)
  private viewers = new Map<string, Set<string>>();

  handleConnection(client: Socket) {
    client.on('join:live', ({ liveId }: { liveId: string }) => {
      if (!liveId) return;
      const room = `live:${liveId}`;
      client.join(room);

      let set = this.viewers.get(liveId);
      if (!set) {
        set = new Set();
        this.viewers.set(liveId, set);
      }
      set.add(client.id);

      this.logger.debug(
        `[/live ${client.id}] join live=${liveId} (total=${set.size})`,
      );

      // Emite contador atualizado pro painel admin (no /realtime)
      // Aqui só emite no próprio namespace; gateway admin pode escutar separado
      this.server.to(room).emit('viewers:update', { count: set.size });
    });

    client.on('leave:live', ({ liveId }: { liveId: string }) => {
      this.removeViewer(liveId, client.id);
    });
  }

  handleDisconnect(client: Socket) {
    // Remove cliente de todas as lives que estava
    for (const [liveId, set] of this.viewers.entries()) {
      if (set.has(client.id)) {
        this.removeViewer(liveId, client.id);
      }
    }
  }

  private removeViewer(liveId: string, socketId: string) {
    const set = this.viewers.get(liveId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) this.viewers.delete(liveId);
    this.server
      .to(`live:${liveId}`)
      .emit('viewers:update', { count: set.size });
  }

  getViewersCount(liveId: string): number {
    return this.viewers.get(liveId)?.size ?? 0;
  }
}
