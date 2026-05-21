import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { StoresService, StoreInput } from './stores.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RealtimeGateway } from '../websocket/realtime.gateway';

@Controller('stores')
@UseGuards(JwtAuthGuard)
export class StoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly gateway: RealtimeGateway,
  ) {}

  @Get()
  list() {
    return this.stores.list();
  }

  /**
   * Presença em tempo real: quais lojas estão ONLINE (app rodando + socket conectado).
   * Merge com a lista de lojas cadastradas pra o admin ver TODAS, com flag online/offline.
   */
  @Get('presence')
  async presence() {
    const [all, snapshot] = await Promise.all([
      this.stores.list(),
      Promise.resolve(this.gateway.getPresence()),
    ]);
    const byId = new Map(snapshot.map((p) => [p.storeId, p]));
    return all.map((s) => {
      const p = byId.get(s.id);
      return {
        id: s.id,
        code: s.code,
        name: s.name,
        city: s.city,
        state: s.state,
        active: s.active,
        online: p?.online ?? false,
        lastSeen: p?.lastSeen ?? null,
      };
    });
  }

  @Get(':id/performance')
  performance(@Param('id') id: string) {
    return this.stores.performance(id);
  }

  @Post()
  create(@Body() body: StoreInput) {
    return this.stores.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: StoreInput) {
    return this.stores.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.stores.remove(id);
  }

  /**
   * GET /stores/realign-config — lista lojas com config de realinhamento.
   * Retorna: [{ code, name, city, canSendRealign, canReceiveRealign }]
   */
  @Get('realign-config/list')
  realignConfigList() {
    return this.stores.listRealignConfig();
  }

  /**
   * POST /stores/realign-config — atualiza config em batch.
   * Body: { items: [{ code, canSendRealign, canReceiveRealign }] }
   */
  @Post('realign-config/update')
  realignConfigUpdate(
    @Body()
    body: {
      items: Array<{
        code: string;
        canSendRealign: boolean;
        canReceiveRealign: boolean;
        consolidationScore?: number;
        isOutlet?: boolean;
      }>;
    },
  ) {
    return this.stores.updateRealignConfig(body.items || []);
  }
}
