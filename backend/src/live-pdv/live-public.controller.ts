import { BadRequestException, Body, Controller, ForbiddenException, Post, Query, Req } from '@nestjs/common';
import { LivePdvService } from './live-pdv.service';

/**
 * Controller PÚBLICO (SEM JwtAuthGuard) — cadastro da cliente na Live.
 *
 * Fluxo: na live a cliente escreve "CARRINHO" → o ManyChat manda o link
 *   https://<front>/cadastro-live?ig=@fulana&nome=Fulana&t=<token>
 * A página pública posta aqui. Reaproveita quickCustomer (dedup por telefone/@,
 * grava em Customer com originSource='live').
 *
 * Como é público, tem 2 defesas contra abuso:
 *   1. TOKEN opcional (env CADASTRO_LIVE_TOKEN): se setado, exige `t` batendo.
 *      Sem a env, fica aberto (funciona out-of-the-box; recomendado setar em prod).
 *   2. Rate-limit em memória por IP (janela deslizante).
 */

const RL_WINDOW_MS = 60_000; // 1 min
const RL_MAX = 5;            // máx cadastros por IP por janela
const rlHits = new Map<string, number[]>();

@Controller('public/cadastro-live')
export class LivePublicController {
  constructor(private readonly svc: LivePdvService) {}

  @Post()
  async cadastro(
    @Req() req: any,
    @Body() body: { name?: string; phone?: string; instagram?: string; token?: string; sid?: string },
  ) {
    // 1. Token (se configurado no ambiente)
    const expected = (process.env.CADASTRO_LIVE_TOKEN || '').trim();
    if (expected && String(body?.token || '').trim() !== expected) {
      throw new ForbiddenException('Link inválido ou expirado');
    }

    // 2. Rate-limit por IP
    const ip = clientIp(req);
    if (isRateLimited(ip)) {
      throw new BadRequestException('Muitas tentativas. Aguarde um instante e tente de novo.');
    }

    // 3. Validação básica
    const name = String(body?.name || '').trim();
    const phoneDigits = String(body?.phone || '').replace(/\D/g, '');
    if (name.length < 2) throw new BadRequestException('Informe seu nome.');
    if (!isValidBrCell(phoneDigits)) {
      throw new BadRequestException('Celular inválido. Use DDD + número (ex.: 11 91234-5678).');
    }

    const result = await this.svc.quickCustomer({
      name,
      phone: phoneDigits,
      instagram: body?.instagram || undefined,
      markLiveRegistration: true, // veio do link da live → entra na fila "Cadastradas na live"
      // &sid= do ManyChat (User ID do assinante) — base do DM automático (Fase 2)
      manychatSubscriberId: body?.sid || undefined,
    });

    // Devolve só o necessário pra tela de sucesso (sem vazar PII/id interno).
    return { ok: true, name: result.name, instagram: result.instagram };
  }
}

/**
 * Webhook PÚBLICO do ManyChat (External Request) — vínculo @→subscriber_id.
 *
 * Uso no ManyChat: automação (disparo por etiqueta `vincular_flow` ou no fluxo
 * CARRINHO) com ação "Solicitação Externa": POST em
 *   .../api/public/manychat-link?t=<MANYCHAT_HOOK_TOKEN>
 * com corpo "Full Contact Data" (o JSON completo do contato que o ManyChat
 * monta sozinho — traz id, ig_username, name, phone). Também aceita o formato
 * enxuto { token, sid, ig, name, phone } pra chamadas manuais/testes.
 * Aplicar a etiqueta em massa nos contatos = backfill de todos os vínculos.
 *
 * Defesas: token via env MANYCHAT_HOOK_TOKEN (cai pro CADASTRO_LIVE_TOKEN se
 * não setada) + rate-limit LARGO por IP (o backfill em massa é rajada legítima
 * vinda dos servidores do ManyChat).
 */
const HOOK_RL_WINDOW_MS = 60_000;
const HOOK_RL_MAX = 2_000; // rajada do backfill em massa é esperada
const hookHits = new Map<string, number[]>();

@Controller('public/manychat-link')
export class ManychatHookController {
  constructor(private readonly svc: LivePdvService) {}

  @Post()
  async link(
    @Req() req: any,
    @Query('t') t: string | undefined,
    @Body() body: any,
  ) {
    const expected = (
      process.env.MANYCHAT_HOOK_TOKEN || process.env.CADASTRO_LIVE_TOKEN || ''
    ).trim();
    const got = String(t || body?.token || '').trim();
    if (expected && got !== expected) {
      throw new ForbiddenException('Token inválido');
    }
    const ip = clientIp(req);
    const now = Date.now();
    const arr = (hookHits.get(ip) || []).filter((ts) => now - ts < HOOK_RL_WINDOW_MS);
    arr.push(now);
    hookHits.set(ip, arr);
    if (arr.length > HOOK_RL_MAX) {
      throw new BadRequestException('Rate limit');
    }
    // Full Contact Data (id/ig_username) ou formato enxuto (sid/ig)
    return this.svc.upsertManychatLink({
      sid: body?.sid || body?.id,
      ig: body?.ig || body?.ig_username,
      name: body?.name,
      phone: body?.phone || body?.whatsapp_phone,
    });
  }
}

/**
 * WEBHOOK de MENSAGEM da cliente (SACOLA PELA DM, 16/07).
 *
 * O ManyChat, em cada mensagem da cliente durante a live, faz um External
 * Request pra cá com { ig, text, name?, phone? } e devolve o campo `reply`
 * pra mandar de volta no DM. A cliente monta o carrinho sem sair do Instagram.
 *
 * Segurança:
 *  - Token via MANYCHAT_HOOK_TOKEN (mesmo do link).
 *  - Rate-limit POR @ (não por IP — o ManyChat manda tudo do mesmo IP): trava o
 *    troll que floda sozinho sem afetar o resto da live.
 *  - A lógica só liga com LIVE_DM_SELFCART=1 (o service devolve aviso educado
 *    se estiver OFF). FECHAR NÃO cobra: cai na fila de revisão da apresentadora.
 */
const IG_RL_WINDOW_MS = 60_000;
const IG_RL_MAX = 30; // msgs por @ por minuto (cliente real manda bem menos)
const igHits = new Map<string, number[]>();

@Controller('public/manychat-inbound')
export class ManychatInboundController {
  constructor(private readonly svc: LivePdvService) {}

  @Post()
  async inbound(
    @Query('t') t: string | undefined,
    @Body() body: any,
  ): Promise<{ reply: string }> {
    const expected = (
      process.env.MANYCHAT_HOOK_TOKEN || process.env.CADASTRO_LIVE_TOKEN || ''
    ).trim();
    const got = String(t || body?.token || '').trim();
    if (expected && got !== expected) {
      // Não vaza detalhe pro flow do ManyChat — resposta genérica.
      return { reply: '' };
    }

    const ig = String(body?.ig || body?.ig_username || '').trim().replace(/^@/, '');
    const text = String(body?.text ?? body?.last_input_text ?? body?.message ?? '').trim();

    // Rate-limit por @ (troll não derruba a live inteira)
    const rlKey = (ig || 'anon').toLowerCase();
    const now = Date.now();
    const arr = (igHits.get(rlKey) || []).filter((ts) => now - ts < IG_RL_WINDOW_MS);
    arr.push(now);
    igHits.set(rlKey, arr);
    if (igHits.size > 10000) {
      for (const [k, v] of igHits) {
        if (!v.some((ts) => now - ts < IG_RL_WINDOW_MS)) igHits.delete(k);
      }
    }
    if (arr.length > IG_RL_MAX) {
      return { reply: 'Opa, muitas mensagens seguidas! Aguarda um segundinho e tenta de novo. 💛' };
    }

    // Nunca lança pro ManyChat — erro vira reply amigável.
    try {
      const r = await this.svc.manychatInbound({
        ig,
        text,
        name: body?.name,
        phone: body?.phone || body?.whatsapp_phone,
        sid: body?.sid || body?.id, // subscriber id p/ vincular e mandar o link depois
      });
      return { reply: r.reply };
    } catch {
      return { reply: 'Tivemos um probleminha aqui. Tenta de novo em instantes, tá? 💛' };
    }
  }
}

/** Celular BR: 10 dígitos (fixo antigo) ou 11 (com 9). Aceita DDD 11–99. */
function isValidBrCell(digits: string): boolean {
  if (digits.length !== 10 && digits.length !== 11) return false;
  const ddd = parseInt(digits.slice(0, 2), 10);
  if (isNaN(ddd) || ddd < 11 || ddd > 99) return false;
  // 11 dígitos → celular deve começar com 9 após o DDD
  if (digits.length === 11 && digits[2] !== '9') return false;
  return true;
}

function clientIp(req: any): string {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req?.ip || req?.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  arr.push(now);
  rlHits.set(ip, arr);
  // Limpeza defensiva pra não crescer indefinidamente
  if (rlHits.size > 5000) {
    for (const [k, v] of rlHits) {
      if (!v.some((t) => now - t < RL_WINDOW_MS)) rlHits.delete(k);
    }
  }
  return arr.length > RL_MAX;
}
