import { BadRequestException, Controller, Get, Param, Req } from '@nestjs/common';
import { TrackingService } from './tracking.service';

/**
 * GET /public/rastreio/:code — o status do objeto pra página /rastreio do site.
 *
 * É o endpoint que faltava pra 2ª página mais buscada do domínio (2.060
 * cliques/90d no Google) parar de despejar a cliente no site dos Correios:
 * o `GET /tracking/:code` é autenticado DE PROPÓSITO (consulta provedor ao
 * vivo — token e cota do contrato não vão pra tráfego aberto), e este aqui
 * pode ser público porque lê SÓ o cache `rastreio_objetos`, que o
 * `RastreioSyncCron` mantém de 30 em 30 minutos. Zero chamadas de provedor
 * por visita — mesma regra do `volumesDoPedido` ("SÓ O CACHE, NUNCA A API
 * AO VIVO").
 *
 * O cache guarda o ÚLTIMO evento, não a timeline — a resposta é o estado
 * atual (onde está, quando foi visto, previsão, entregue), no MESMO formato
 * por volume que a página do pedido já consome. O link dos Correios segue
 * como complemento pra quem quiser cada passo.
 *
 * Rate-limit em memória por IP — mesmo padrão do portal de trocas
 * (`trocas-public.controller.ts`) e do /public/meus-pedidos.
 */

const RL_WINDOW_MS = 5 * 60_000; // 5 min
const RL_MAX = 20; // consultas por IP por janela — cliente ansiosa recarrega
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
  if (rlHits.size > 5_000) {
    for (const [k, v] of rlHits) {
      if (!v.some((t) => now - t < RL_WINDOW_MS)) rlHits.delete(k);
    }
  }
  return false;
}

@Controller('public/rastreio')
export class RastreioPublicController {
  constructor(private readonly svc: TrackingService) {}

  @Get(':code')
  async porCodigo(@Param('code') code: string, @Req() req: any) {
    if (isRateLimited(clientIp(req))) {
      throw new BadRequestException('Muitas consultas. Aguarde alguns minutos e tente de novo.');
    }

    const codigo = TrackingService.normalizarCodigo(String(code || '').trim().toUpperCase());
    if (!TrackingService.ehCodigoValido(codigo)) {
      // Formato errado é resposta imediata — não gasta janela de quem digita.
      throw new BadRequestException('Código inválido. Ele tem 13 caracteres: AA123456789BR.');
    }

    const resumo = (await this.svc.resumoDoCache([codigo])).get(codigo);
    if (!resumo) {
      /**
       * Código bem-formado que o radar não conhece: objeto de outra loja, ou
       * etiqueta TÃO recente que o cron ainda não viu (janela de até 30min).
       * `encontrado: false` — o site explica e oferece o link dos Correios.
       * 200, não 404: pro navegador isso é uma resposta, não um erro.
       */
      return { encontrado: false, codigo };
    }

    return {
      encontrado: true,
      codigo,
      status: resumo.status,
      local: resumo.local,
      eventoEm: resumo.eventoEm,
      previsaoEm: resumo.previsaoEm,
      entregue: resumo.entregue,
      entregueEm: resumo.entregueEm,
      atualizadoEm: resumo.consultadoEm,
    };
  }
}
