import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CarrinhosAbandonadosService } from './carrinhos-abandonados.service';

/**
 * /carrinhos-abandonados — lê do plugin "Cart Abandonment Recovery for WooCommerce"
 * (CartFlows) direto na tabela wp_cartflows_ca_cart_history.
 *
 * Usado pela tela /minha-loja/carrinhos-abandonados pra puxar TODOS os clientes
 * que largaram o carrinho — não só os pendentes que viraram pedido.
 */
@Controller('carrinhos-abandonados')
@UseGuards(JwtAuthGuard)
export class CarrinhosAbandonadosController {
  constructor(private readonly svc: CarrinhosAbandonadosService) {}

  /**
   * GET /carrinhos-abandonados/list?dias=7&status=abandoned
   * Retorna lista de carrinhos abandonados nos últimos N dias.
   * dias: padrão 7, max 90
   * status: 'abandoned' (default), 'completed' (recuperado), 'all'
   */
  @Get('list')
  async list(@Query('dias') dias?: string, @Query('status') status?: string) {
    const d = Math.min(90, Math.max(1, Number(dias) || 7));
    const s = status === 'completed' || status === 'all' ? status : 'abandoned';
    return this.svc.list({ dias: d, status: s as any });
  }

  /** GET /carrinhos-abandonados/resumo?dias=7 — KPIs */
  @Get('resumo')
  async resumo(@Query('dias') dias?: string) {
    const d = Math.min(90, Math.max(1, Number(dias) || 7));
    return this.svc.resumo({ dias: d });
  }
}
