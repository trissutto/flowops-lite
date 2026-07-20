import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
} from '@nestjs/common';
import { OrderStatusService } from './order-status.service';

/**
 * Controller PÚBLICO do "Meus Pedidos" (sem login).
 * Identidade = celular + CPF. Rate-limit em memória por IP
 * (mesmo padrão do public/trocas e do cadastro-live).
 */

const RL_WINDOW_MS = 5 * 60_000; // 5 min
const RL_MAX = 12;               // consultas por IP por janela
const rlHits = new Map<string, number[]>();

function clientIp(req: any): string {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '');
  return (fwd.split(',')[0] || req?.ip || req?.socket?.remoteAddress || 'unknown').trim();
}

function guardRate(req: any) {
  const now = Date.now();
  const ip = clientIp(req);
  const hits = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (hits.length >= RL_MAX) {
    rlHits.set(ip, hits);
    throw new BadRequestException('Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  }
  hits.push(now);
  rlHits.set(ip, hits);
  if (rlHits.size > 5_000) {
    for (const [k, v] of rlHits) {
      if (!v.some((t) => now - t < RL_WINDOW_MS)) rlHits.delete(k);
    }
  }
}

@Controller('public/meus-pedidos')
export class OrderStatusController {
  constructor(private readonly svc: OrderStatusService) {}

  /** POST /public/meus-pedidos { celular, cpf } → pedidos da cliente */
  @Post()
  async lookup(@Req() req: any, @Body() body: { celular?: string; cpf?: string }) {
    guardRate(req);
    return this.svc.lookup({
      celular: String(body?.celular || ''),
      cpf: String(body?.cpf || ''),
    });
  }

  /** POST /public/meus-pedidos/rastreio { celular, cpf, orderId } → eventos */
  @Post('rastreio')
  async rastreio(
    @Req() req: any,
    @Body() body: { celular?: string; cpf?: string; orderId?: string },
  ) {
    guardRate(req);
    if (!body?.orderId) throw new BadRequestException('orderId obrigatório');
    return this.svc.rastreio({
      celular: String(body?.celular || ''),
      cpf: String(body?.cpf || ''),
      orderId: String(body.orderId),
    });
  }
}
