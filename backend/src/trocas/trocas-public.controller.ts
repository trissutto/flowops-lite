import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
} from '@nestjs/common';
import { TrocasService } from './trocas.service';

/**
 * Controller PÚBLICO do Portal de Trocas (sem login).
 *
 * A "autenticação" é a dupla nº do pedido + CPF/e-mail da compra — igual
 * portal de trocas de qualquer e-commerce. Defesas (mesmo padrão do
 * /public/cadastro-live e da sacolinha da live):
 *   - rate-limit em memória por IP (janela deslizante 5min);
 *   - erro GENÉRICO pra pedido inexistente vs dados errados (anti-enumeração);
 *   - nenhum endpoint devolve endereço/PII completa da cliente.
 */

const RL_WINDOW_MS = 5 * 60_000; // 5 min
const RL_MAX = 10;               // máx tentativas por IP por janela
const rlHits = new Map<string, number[]>();

function clientIp(req: any): string {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '');
  return (fwd.split(',')[0] || req?.ip || req?.socket?.remoteAddress || 'unknown').trim();
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (hits.length >= RL_MAX) {
    rlHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  rlHits.set(ip, hits);
  // Faxina esporádica pra não crescer sem limite
  if (rlHits.size > 5_000) {
    for (const [k, v] of rlHits) {
      if (!v.some((t) => now - t < RL_WINDOW_MS)) rlHits.delete(k);
    }
  }
  return false;
}

function guardRate(req: any) {
  if (isRateLimited(clientIp(req))) {
    throw new BadRequestException('Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  }
}

@Controller('public/trocas')
export class TrocasPublicController {
  constructor(private readonly svc: TrocasService) {}

  /**
   * POST /public/trocas/localizar { pedido, doc }
   * doc = CPF ou e-mail usado na compra.
   */
  @Post('localizar')
  async localizar(@Req() req: any, @Body() body: { pedido?: string; doc?: string }) {
    guardRate(req);
    return this.svc.localizar({
      pedido: String(body?.pedido || ''),
      doc: String(body?.doc || ''),
    });
  }

  /**
   * POST /public/trocas/solicitar
   * { pedido, doc, items: [{sku, qty}], motivo, motivoDetalhe?, declaracaoAceita }
   */
  @Post('solicitar')
  async solicitar(
    @Req() req: any,
    @Body()
    body: {
      pedido?: string;
      doc?: string;
      items?: Array<{ sku: string; qty: number }>;
      motivo?: string;
      motivoDetalhe?: string;
      declaracaoAceita?: boolean;
    },
  ) {
    guardRate(req);
    return this.svc.solicitar({
      pedido: String(body?.pedido || ''),
      doc: String(body?.doc || ''),
      items: body?.items || [],
      motivo: String(body?.motivo || ''),
      motivoDetalhe: body?.motivoDetalhe,
      declaracaoAceita: !!body?.declaracaoAceita,
      ip: clientIp(req),
    });
  }

  /**
   * POST /public/trocas/rastreio { pedido, doc, trocaId, trackingCode }
   * Cliente informa o rastreio da devolução (quando o envio é por conta dela).
   */
  @Post('rastreio')
  async rastreio(
    @Req() req: any,
    @Body() body: { pedido?: string; doc?: string; trocaId?: string; trackingCode?: string },
  ) {
    guardRate(req);
    if (!body?.trocaId) throw new BadRequestException('trocaId obrigatório');
    return this.svc.informarRastreio({
      pedido: String(body?.pedido || ''),
      doc: String(body?.doc || ''),
      trocaId: String(body.trocaId),
      trackingCode: String(body?.trackingCode || ''),
    });
  }
}
