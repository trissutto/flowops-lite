import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

/**
 * Gateway WebSocket do FlowOps.
 *
 * Papéis:
 *  - admin/operator → entra na sala 'admin' e recebe updates de todas as lojas
 *  - store         → entra na sala 'store:<storeId>' (e só enxerga o que é da loja dele)
 *
 * Autenticação: cliente envia JWT em `handshake.auth.token`. Se inválido, desconecta.
 *
 * Presença: mantemos um Map<storeId, Set<socketId>> pro endpoint /stores/presence
 * poder mostrar quais lojas estão online em tempo real.
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: '*' } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  // Presença: storeId → conjunto de socketIds conectados dessa loja
  private readonly storeSockets = new Map<string, Set<string>>();
  // Último visto por storeId (pra mostrar "offline há X min")
  private readonly lastSeen = new Map<string, Date>();
  // Usuários admin online (pode ser útil pra /pedidos ter lista de operadores)
  private readonly adminSockets = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  // ---------- Conexão / desconexão ----------

  handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn(`[socket ${client.id}] sem token, desconectando`);
        client.disconnect(true);
        return;
      }

      const secret = this.config.get<string>('JWT_SECRET');
      if (!secret) {
        this.logger.error('JWT_SECRET não configurado — desconectando socket');
        client.disconnect(true);
        return;
      }

      const payload = this.jwtService.verify(token, { secret }) as any;
      const role = String(payload.role || '');
      const storeId = payload.storeId ? String(payload.storeId) : null;
      const userId = String(payload.sub || '');

      // Guarda infos no próprio socket pra uso posterior
      (client.data as any).userId = userId;
      (client.data as any).role = role;
      (client.data as any).storeId = storeId;

      if (role === 'store') {
        if (!storeId) {
          this.logger.warn(`[socket ${client.id}] role=store sem storeId, desconectando`);
          client.disconnect(true);
          return;
        }
        const room = `store:${storeId}`;
        client.join(room);
        this.registerStoreSocket(storeId, client.id);
        this.logger.log(`[socket ${client.id}] entrou em ${room} (user=${userId})`);
        // Notifica admins que essa loja ficou online
        this.server.to('admin').emit('presence:update', {
          storeId,
          online: true,
          lastSeen: new Date().toISOString(),
        });
      } else {
        // admin | operator → sala 'admin'
        client.join('admin');
        this.adminSockets.add(client.id);
        this.logger.log(`[socket ${client.id}] entrou em admin (role=${role}, user=${userId})`);
      }
    } catch (err) {
      this.logger.warn(`[socket ${client.id}] handshake falhou: ${(err as Error).message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const storeId = (client.data as any)?.storeId as string | null;
    const role = (client.data as any)?.role as string | undefined;

    if (role === 'store' && storeId) {
      this.unregisterStoreSocket(storeId, client.id);
      const stillOnline = (this.storeSockets.get(storeId)?.size ?? 0) > 0;
      if (!stillOnline) {
        this.lastSeen.set(storeId, new Date());
        this.server.to('admin').emit('presence:update', {
          storeId,
          online: false,
          lastSeen: new Date().toISOString(),
        });
      }
    } else {
      this.adminSockets.delete(client.id);
    }
    this.logger.log(`[socket ${client.id}] desconectado`);
  }

  // ---------- API pra outros módulos chamarem ----------

  /**
   * Emite um evento pra SALA de UMA loja específica.
   * Usar quando admin confirma roteamento → loja recebe pick-order novo em tempo real.
   */
  emitPickOrderToStore(storeId: string, pickOrder: any) {
    this.server.to(`store:${storeId}`).emit('pick-order:new', pickOrder);
  }

  /**
   * Emite mudança de status de um pick-order.
   * Vai pra sala da loja (pra ela ver o eco) + pra sala admin (pra /pedidos refletir).
   */
  emitPickOrderStatus(storeId: string, pickOrder: any) {
    this.server.to(`store:${storeId}`).emit('pick-order:status', pickOrder);
    this.server.to('admin').emit('pick-order:status', pickOrder);
  }

  /**
   * Pick-order foi removido (matriz cancelou pra reatribuir loja).
   * Loja remove o card do app /minha-loja. Admin atualiza /pedidos.
   */
  emitPickOrderRemoved(storeId: string, payload: { orderId: string; pickOrderId?: string }) {
    this.server.to(`store:${storeId}`).emit('pick-order:removed', payload);
    this.server.to('admin').emit('pick-order:removed', payload);
  }

  /**
   * Loja sinalizou problema no pick-order (sem estoque físico, defeito, divergência).
   * Loja remove card da fila. Admin destaca pedido em /pedidos e /separacao.
   */
  emitPickOrderIssue(storeId: string, payload: {
    pickOrderId: string;
    orderId: string;
    wcOrderId?: number | null;
    storeId: string;
    storeCode?: string | null;
    storeName?: string | null;
    reason: string;
    reasonLabel: string;
    note?: string | null;
    reportedAt: string;
  }) {
    this.server.to(`store:${storeId}`).emit('pick-order:issue', payload);
    this.server.to('admin').emit('pick-order:issue', payload);
  }

  /**
   * Realinhamento de estoques — matriz despachou ordens pra loja origem separar.
   * Emite só pra sala da loja origem (store:{storeId}) + admin (pra /pedidos refletir).
   * Payload é um agregado: array de itens pendentes que chegaram no mesmo confirm.
   */
  emitRealignmentNew(storeId: string, payload: {
    storeId: string;
    storeCode: string;
    count: number;
    totalUnits: number;
    items: Array<{
      id: string;
      refCode: string;
      cor: string | null;
      tamanho: string | null;
      qtyOrigem: number;
      lojaDestinoCode: string;
      lojaDestinoName: string;
      mensagem: string;
      createdAt: string;
    }>;
    note?: string | null;
    solicitante: string;
  }) {
    this.server.to(`store:${storeId}`).emit('realignment:new', payload);
    this.server.to('admin').emit('realignment:new', payload);
  }

  /**
   * Loja confirmou que enviou o item de realinhamento.
   * Admin vê em tempo real no /retaguarda/realinhamento/status (se existir).
   */
  emitRealignmentSent(storeId: string, payload: {
    transferId: string;
    storeId: string;
    storeCode: string;
    refCode: string;
    cor: string | null;
    tamanho: string | null;
    lojaDestinoCode: string;
    sentAt: string;
  }) {
    this.server.to(`store:${storeId}`).emit('realignment:sent', payload);
    this.server.to('admin').emit('realignment:sent', payload);
  }

  /**
   * Loja REVERTEU um "enviei" (ordem volta de sent → pending).
   * Usado quando o operador clica errado e precisa voltar pra fila.
   * Admin e a própria loja (outros dispositivos) atualizam a UI.
   */
  emitRealignmentUnsent(storeId: string, payload: {
    transferId: string;
    storeId: string;
    storeCode: string;
    refCode: string;
    cor: string | null;
    tamanho: string | null;
    lojaDestinoCode: string;
  }) {
    this.server.to(`store:${storeId}`).emit('realignment:unsent', payload);
    this.server.to('admin').emit('realignment:unsent', payload);
  }

  /**
   * Dispara comando de impressão remota pro Electron da loja.
   * /minha-loja escuta esse evento e abre a tela imprimir/[id]?autoprint=1 que
   * chama window.electronAPI.silentPrintHTML e fecha sozinha.
   */
  emitPrintRequest(storeId: string, payload: { pickOrderId: string; url: string }) {
    this.server.to(`store:${storeId}`).emit('pick-order:print', payload);
  }

  /**
   * Retorna se a loja tem ao menos 1 socket conectado agora (Electron aberto).
   * Usado pra falhar rápido quando matriz tenta imprimir numa loja offline.
   */
  isStoreOnline(storeId: string): boolean {
    const set = this.storeSockets.get(storeId);
    return !!set && set.size > 0;
  }

  /**
   * Retorna snapshot da presença (usado pelo endpoint /stores/presence).
   */
  getPresence(): Array<{ storeId: string; online: boolean; lastSeen: string | null }> {
    const result: Array<{ storeId: string; online: boolean; lastSeen: string | null }> = [];
    // Lojas atualmente online
    for (const [storeId, set] of this.storeSockets) {
      if (set.size > 0) {
        result.push({ storeId, online: true, lastSeen: new Date().toISOString() });
      }
    }
    // Lojas que já conectaram um dia e estão offline
    for (const [storeId, ts] of this.lastSeen) {
      if (!result.some((r) => r.storeId === storeId)) {
        result.push({ storeId, online: false, lastSeen: ts.toISOString() });
      }
    }
    return result;
  }

  // ---------- Eventos legados (mantêm compat com partes do app antigas) ----------

  emitOrderNew(order: any) {
    this.server.to('admin').emit('order:new', order);
  }
  emitOrderStatusChanged(order: any) {
    this.server.to('admin').emit('order:status-changed', order);
  }
  emitStockAlert(payload: any) {
    this.server.to('admin').emit('stock:alert', payload);
  }

  // ---------- Helpers ----------

  private extractToken(client: Socket): string | null {
    const fromAuth = (client.handshake.auth as any)?.token;
    if (fromAuth && typeof fromAuth === 'string') {
      return fromAuth.startsWith('Bearer ') ? fromAuth.slice(7) : fromAuth;
    }
    const fromHeader = client.handshake.headers?.authorization;
    if (fromHeader && typeof fromHeader === 'string') {
      return fromHeader.startsWith('Bearer ') ? fromHeader.slice(7) : fromHeader;
    }
    const fromQuery = (client.handshake.query as any)?.token;
    if (fromQuery && typeof fromQuery === 'string') return fromQuery;
    return null;
  }

  private registerStoreSocket(storeId: string, socketId: string) {
    let set = this.storeSockets.get(storeId);
    if (!set) {
      set = new Set<string>();
      this.storeSockets.set(storeId, set);
    }
    set.add(socketId);
  }

  private unregisterStoreSocket(storeId: string, socketId: string) {
    const set = this.storeSockets.get(storeId);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) this.storeSockets.delete(storeId);
    }
  }
}
