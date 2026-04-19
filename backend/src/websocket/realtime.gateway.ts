import { Logger } from '@nestjs/common';
import {
  WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({ namespace: '/realtime', cors: { origin: '*' } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    // TODO: validar JWT em client.handshake.auth.token
    this.logger.log(`Socket conectado: ${client.id}`);
  }
  handleDisconnect(client: Socket) {
    this.logger.log(`Socket desconectado: ${client.id}`);
  }

  emitOrderNew(order: any) {
    this.server.emit('order:new', order);
  }
  emitOrderStatusChanged(order: any) {
    this.server.emit('order:status-changed', order);
  }
  emitStockAlert(payload: any) {
    this.server.emit('stock:alert', payload);
  }
}
