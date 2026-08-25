import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { TrackingService } from './tracking.service';

/**
 * GET /tracking/:code?carrier=correios
 *
 * Puxa status em tempo real do código de rastreio. Autenticado (JWT) pra não
 * vazar token de provedor em tráfego público.
 *
 * Uso:
 *   - /pedidos/wc/[id] mostra timeline quando order.trackingCode existe
 *   - /minha-loja lista último status por linha (opcional, sob demanda)
 */
@UseGuards(JwtAuthGuard)
@Controller('tracking')
export class TrackingController {
  constructor(private readonly svc: TrackingService) {}

  /**
   * Quanto o transporte cobra HOJE por este envio — pra tela do pedido
   * conferir o frete cobrado da cliente.
   *
   * ⚠️ TEM QUE VIR ANTES DO `:code`. O Nest casa as rotas na ordem em que
   * elas são declaradas: com `@Get(':code')` em cima, "cotacao" seria lido
   * como código de rastreio e este endpoint nunca responderia.
   *
   * `loja` (code) define o CEP de ORIGEM e `carrier` define QUEM cota —
   * cotar o provedor errado, saindo da cidade errada, inventa prejuízo que
   * não existe (ver `cotarFrete`).
   */
  @Get('cotacao')
  async cotacao(
    @Query('cepDestino') cepDestino: string,
    @Query('pecas') pecas?: string,
    @Query('loja') loja?: string,
    @Query('carrier') carrier?: string,
    @Query('code') code?: string,
  ) {
    return this.svc.cotarFrete({
      cepDestino,
      pecas: pecas ? Number(pecas) : 1,
      lojaCode: loja ?? null,
      carrier: carrier ?? null,
      code: code ?? null,
    });
  }

  @Get(':code')
  async get(@Param('code') code: string, @Query('carrier') carrier?: string) {
    return this.svc.fetchTracking(code, carrier);
  }
}
